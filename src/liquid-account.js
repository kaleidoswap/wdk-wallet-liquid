// Copyright 2024 KaleidoSwap
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict'

// Resolved to the Node binding (`lwk_node`) or the browser binding (`lwk_wasm`)
// at build time via the package's `imports` map — see package.json `#lwk`.
import lwk from '#lwk'

/**
 * @typedef {'mainnet' | 'testnet' | 'regtest'} LiquidNetworkName
 */

/**
 * @typedef {Object} LiquidAccountConfig
 * @property {string} mnemonic - BIP-39 mnemonic phrase used to derive the signer.
 * @property {LiquidNetworkName} [network] - Liquid network (default: 'testnet').
 * @property {string} [esploraUrl] - Esplora API base URL (default: the network's built-in client).
 * @property {boolean} [waterfalls] - Use the server-side "waterfalls" scan instead of a
 *   client-side gap-limit scan. Collapses the ~40 per-scan Esplora requests into a single
 *   request (descriptor → full history), turning a ~10s cold sync into sub-second — but it
 *   requires `esploraUrl` to point at a waterfalls-capable server (e.g.
 *   https://waterfalls.liquidwebwallet.org/liquid/api). Public Blockstream Esplora does NOT
 *   expose the waterfalls endpoint. Default: false.
 * @property {boolean} [allowDefaultEsploraFallback] - Explicitly allow Waterfalls failures to
 *   retry once through the network's built-in standard Esplora provider. This changes providers
 *   and may disclose wallet addresses/scripts to that provider. Default: false.
 * @property {string} [waterfallsRecipient] - Optional waterfalls server recipient key. When
 *   set, encrypts the descriptor before sending it to the server (without encryption,
 *   the server sees every address the descriptor derives). Ignored unless `waterfalls`.
 * @property {(warning: {code: string, message: string, details?: object}) => (void | Promise<void>)} [onWarning]
 *   Called when Waterfalls fails and the account recovers with standard Esplora.
 * @property {number} [scanTimeoutMs] - Watchdog for a wedged Esplora full-scan (default: 30000).
 */

function buildNetwork (name) {
  switch (name) {
    case 'mainnet': return lwk.Network.mainnet()
    case 'regtest': return lwk.Network.regtestDefault()
    case 'testnet':
    default: return lwk.Network.testnet()
  }
}

// How long a completed Esplora full-scan stays "fresh". A burst of reads
// (balance + assets + address, fired together by a UI) shares one scan instead
// of each triggering its own — critical because ops are serialized (see `_run`),
// so N scans would run back-to-back and blow the caller's timeout. Sized to the
// typical 30s UI refresh so navigating between screens (e.g. dashboard → send)
// and composing a payment reuse the last scan instead of blocking on a new one;
// a manual refresh or a send forces a fresh scan (`resync()` / `_sync(true)`).
const SYNC_TTL_MS = 30_000

// Even a FORCED scan reuses one that completed this recently. A "refresh
// everything" UI action fans out to several forced syncs (refresh-balances,
// snapshot rebuild, send prep); without this window each of them would run its
// own back-to-back full scan.
const FORCE_SYNC_TTL_MS = 2_500

// Watchdog for a wedged scan. The fetch stack under lwk's `fullScan` has no
// timeout of its own; a stalled request would otherwise hold the serialized op
// queue (and with it every balance/status read) hostage forever. On timeout the
// whole LWK object graph is orphaned and lazily rebuilt by the next op — safe
// because the zombie scan only ever touches the orphaned Wollet.
const DEFAULT_SCAN_TIMEOUT_MS = 30_000

/**
 * WDK-compatible account that wraps an in-process LWK (Liquid Wallet Kit)
 * watch-only `Wollet` plus a software `Signer` derived from a BIP-39 mnemonic.
 *
 * Implements the core `IWalletAccount` interface (getAddress, getBalance,
 * getTokenBalance, transfer, sign) and exposes Liquid-specific operations
 * (asset transfers, UTXO listing, transaction history) used by the MCP server.
 *
 * Keys live in this process — there is no external daemon. The SLIP-77 CT
 * descriptor covers every address, so the parent manager exposes a single
 * logical account.
 */
export class LiquidAccount {
  /**
   * @param {LiquidAccountConfig} config
   */
  constructor (config = {}) {
    if (!config.mnemonic) {
      throw new Error('LiquidAccount: config.mnemonic is required')
    }
    this._mnemonic = config.mnemonic
    this._networkName = config.network ?? 'testnet'
    this._esploraUrl = config.esploraUrl ?? null
    this._waterfalls = config.waterfalls === true
    this._allowDefaultEsploraFallback = config.allowDefaultEsploraFallback === true
    if (this._waterfalls && !this._esploraUrl) {
      throw new Error('LiquidAccount: waterfalls requires config.esploraUrl')
    }
    this._waterfallsRecipient = config.waterfallsRecipient ?? null
    this._onWarning = typeof config.onWarning === 'function' ? config.onWarning : null
    // Whether setWaterfallsServerRecipient() has been applied to the CURRENT
    // EsploraClient. Reset whenever the client is rebuilt (see _ensureReady).
    this._waterfallsRecipientApplied = false
    this._scanTimeoutMs = config.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
    this._ready = false
    // FIFO queue serializing every op that borrows the LWK Wollet (see `_run`).
    this._opChain = Promise.resolve()
    // Epoch ms of the last completed Esplora scan (0 = never); see `_sync`.
    this._lastSyncAt = 0
  }

  /**
   * Lazily builds the LWK objects (Network, Signer, descriptor, Wollet,
   * EsploraClient). Called by every operation; cheap after the first run.
   *
   * @private
   */
  _ensureReady () {
    if (this._ready) return

    this._network = buildNetwork(this._networkName)
    this._signer = new lwk.Signer(new lwk.Mnemonic(this._mnemonic), this._network)
    this._descriptor = this._signer.wpkhSlip77Descriptor()
    this._wollet = new lwk.Wollet(this._network, this._descriptor)
    // EsploraClient(network, url, waterfalls, concurrency, utxo_only). With
    // waterfalls=false a gap-limit full-scan issues ~40+ requests, so use
    // concurrency 4 to keep it responsive. With waterfalls=true the server
    // returns the whole history in ONE request, so concurrency is moot.
    this._esplora = this._esploraUrl
      ? new lwk.EsploraClient(this._network, this._esploraUrl, this._waterfalls, 4, false)
      : this._network.defaultEsploraClient()
    // Fresh client → the recipient key (if any) must be (re)applied before use.
    this._waterfallsRecipientApplied = false

    this._ready = true
  }

  /**
   * Scans the chain via Esplora and applies the resulting update so that
   * balance/transaction queries reflect the latest state.
   *
   * @private
   */
  /**
   * Scans the chain via Esplora and applies the update. Coalesces rapid calls:
   * a scan that completed within `SYNC_TTL_MS` is reused (returns immediately)
   * unless `force` is set. lwk's `fullScan` is a full gap-limit scan (seconds
   * over a remote Esplora), and reads are serialized (`_run`), so without this a
   * burst of reads would run N scans back-to-back and exceed the caller's
   * timeout. Sends pass `force` so they always build against fresh UTXOs.
   *
   * @private
   * @param {boolean} [force=false]
   */
  async _sync (force = false) {
    this._ensureReady()
    const freshness = force ? FORCE_SYNC_TTL_MS : SYNC_TTL_MS
    if (this._lastSyncAt && (Date.now() - this._lastSyncAt) < freshness) return
    const t0 = Date.now()
    const scanKind = this._waterfalls ? 'waterfalls scan' : 'fullScan'
    console.info(`[LiquidAccount] ${scanKind} start (${this._networkName}, ${this._esploraUrl ?? 'default esplora'})`)
    let timer
    try {
      // Encrypt the descriptor sent to the waterfalls server, once per client.
      // Keep setup in the guarded attempt: recipient setup is part of Waterfalls,
      // so a setup failure must take the same standard-Esplora fallback path.
      if (this._waterfalls && this._waterfallsRecipient && !this._waterfallsRecipientApplied) {
        await this._esplora.setWaterfallsServerRecipient(this._waterfallsRecipient)
        this._waterfallsRecipientApplied = true
      }
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`LiquidAccount: fullScan timed out after ${this._scanTimeoutMs}ms`)),
          this._scanTimeoutMs
        )
      })
      const update = await Promise.race([this._esplora.fullScan(this._wollet), timeout])
      if (update) this._wollet.applyUpdate(update)
      this._lastSyncAt = Date.now()
      console.info(`[LiquidAccount] ${scanKind} done in ${Date.now() - t0}ms`)
    } catch (err) {
      console.error(`[LiquidAccount] ${scanKind} FAILED after ${Date.now() - t0}ms`)
      const timedOut = /timed out/.test(String(err?.message ?? ''))
      if (timedOut) {
        // The wedged scan may still hold the &mut Wollet borrow inside wasm, so
        // none of the current objects are safe to touch again. Orphan the whole
        // graph — the fallback below (or the next op) rebuilds fresh objects, and
        // the zombie scan finishes (or dies) against the orphan without conflict.
        // Deliberately no free()/dispose() here: freeing a borrowed wasm object
        // would abort; leaking it is harmless.
        this._ready = false
      }
      if (this._waterfalls && this._allowDefaultEsploraFallback) {
        const warning = {
          code: 'LIQUID_WATERFALLS_FALLBACK',
          message: 'Liquid Waterfalls failed; using standard Esplora fallback.',
          details: { reason: 'waterfalls_failed' }
        }
        this._waterfalls = false
        this._waterfallsRecipient = null
        this._waterfallsRecipientApplied = false
        this._esploraUrl = null
        this._lastSyncAt = 0
        try {
          if (this._ready) this._esplora = this._network.defaultEsploraClient()
          await this._sync(force)
        } catch (fallbackErr) {
          // Never leave the old Waterfalls client reachable after a failed
          // provider transition. The next operation must rebuild a fresh
          // standard-Esplora graph.
          this._ready = false
          throw new AggregateError(
            [err, fallbackErr],
            'Liquid Waterfalls failed; standard Esplora fallback failed'
          )
        }
        try {
          const callbackResult = this._onWarning?.(warning)
          if (callbackResult && typeof callbackResult.then === 'function') {
            callbackResult.catch(() => {
              console.warn('[LiquidAccount] onWarning callback failed')
            })
          }
        } catch {
          console.warn('[LiquidAccount] onWarning callback failed')
        }
        return
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Forces a fresh Esplora scan on the next read, bypassing the freshness
   * window — used by a manual "refresh" so a just-arrived deposit shows without
   * waiting for the TTL to lapse.
   *
   * @returns {Promise<void>}
   */
  async resync () {
    return this._run(() => this._sync(true))
  }

  /**
   * Serializes access to the underlying LWK `Wollet`. lwk's `Wollet` is NOT
   * re-entrant: if a second operation borrows it (e.g. `fullScan`, `balance`,
   * `utxos`) while the first is still awaiting, the wasm panics with
   * "recursive use of an object detected which would lead to unsafe aliasing
   * in rust". Consumers routinely fire balance + assets + address concurrently,
   * so every public op that touches the Wollet runs through this FIFO queue.
   *
   * @private
   * @template T
   * @param {() => Promise<T>} op
   * @returns {Promise<T>}
   */
  _run (op) {
    const run = this._opChain.then(op, op)
    // Keep the chain alive regardless of success/failure, and never leak the
    // resolved value into the next op's argument.
    this._opChain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Returns the satoshi balance of a single asset from the current wallet
   * state (does not sync — call `_sync()` first).
   *
   * @private
   * @param {string} assetId - Liquid asset id hex (64 chars).
   * @returns {bigint}
   */
  _balanceOf (assetId) {
    for (const [asset, value] of this._wollet.balance().entries()) {
      if (asset === assetId) return BigInt(value)
    }
    return 0n
  }

  // ---------------------------------------------------------------------------
  // IWalletAccount compatibility
  // ---------------------------------------------------------------------------

  /**
   * Returns the next unused confidential (CT) receive address.
   *
   * @returns {Promise<string>}
   */
  async getAddress () {
    return this._run(async () => {
      this._ensureReady()
      return this._wollet.address().address().toString()
    })
  }

  /**
   * Returns the spendable L-BTC balance in satoshis.
   *
   * @returns {Promise<bigint>}
   */
  async getBalance () {
    return this._run(async () => {
      await this._sync()
      return this._balanceOf(this._network.policyAsset().toString())
    })
  }

  /**
   * Returns the balance of a Liquid asset in its smallest unit.
   *
   * @param {string} assetId - Liquid asset id hex (64 chars).
   * @returns {Promise<bigint>}
   */
  async getTokenBalance (assetId) {
    return this._run(async () => {
      await this._sync()
      return this._balanceOf(assetId)
    })
  }

  /**
   * Sends L-BTC on the Liquid network.
   *
   * NB: `feeRate` is in **sat/kvB** (lwk convention; its default is 100, i.e.
   * 0.1 sat/vB — the Liquid network minimum). Do NOT pass Bitcoin-style sat/vB
   * values: 1 sat/vB must be given as 1000. When omitted, lwk's default is used,
   * which is virtually always right on Liquid (federated 1-min blocks, no fee
   * market).
   *
   * @param {{ recipient: string, amount: number | bigint, feeRate?: number }} options
   * @returns {Promise<{ hash: string, fee: bigint }>}
   */
  async transfer ({ recipient, amount, feeRate }) {
    return this._run(async () => {
      await this._sync(true) // sends must build against fresh UTXOs
      const address = lwk.Address.parse(recipient, this._network)
      const requested = BigInt(amount)
      // lwk's TxBuilder is a CONSUMING builder (wasm-bindgen moves `self`):
      // every chain method invalidates the receiver and returns a fresh
      // builder. Reusing the old reference throws "null pointer passed to
      // rust" — always reassign.
      let builder = this._network.txBuilder()
      // Send-max: `addLbtcRecipient` adds the fee ON TOP of the amount, so
      // requesting the entire L-BTC balance leaves nothing to cover the fee and
      // lwk fails with "Insufficient funds: missing <fee> units for asset
      // <L-BTC>". When the requested amount is the whole spendable balance,
      // drain instead — it sends every L-BTC input to the recipient with the
      // fee deducted from the amount. (You can never send more than the balance,
      // so `>=` uniquely means "send all, net of fee".)
      const policyBalance = this._balanceOf(this._network.policyAsset().toString())
      if (requested >= policyBalance) {
        builder = builder.drainLbtcWallet()
        builder = builder.drainLbtcTo(address)
      } else {
        builder = builder.addLbtcRecipient(address, requested)
      }
      if (feeRate != null) builder = builder.feeRate(feeRate)
      return this._buildSignBroadcast(builder)
    })
  }

  /**
   * Signs an arbitrary message with the signer's master key.
   *
   * @param {string} message
   * @returns {Promise<string>} Base64 signature.
   */
  async sign (message) {
    this._ensureReady()
    // `signMessage` exists on the wasm-bindgen bindings (lwk_wasm / lwk_node) but
    // not on the React Native UniFFI binding (lwk-rn). Feature-detect so the core
    // wallet stays usable on every platform.
    if (typeof this._signer.signMessage !== 'function') {
      throw new Error(
        'LiquidAccount.sign: message signing is not supported by the active LWK binding (react-native)'
      )
    }
    return this._signer.signMessage(message)
  }

  /**
   * Frees the underlying WASM handles.
   */
  dispose () {
    if (!this._ready) return
    for (const obj of [this._signer, this._descriptor, this._wollet, this._esplora, this._network]) {
      try { obj?.free?.() } catch { /* already freed */ }
    }
    this._ready = false
  }

  /**
   * The signer's master public key identifier (20 bytes). `privateKey` is
   * always null — the private key never leaves the signer.
   *
   * @returns {{ publicKey: Uint8Array, privateKey: null }}
   */
  get keyPair () {
    this._ensureReady()
    let hex = ''
    if (typeof this._signer.getMasterXpub === 'function') {
      // wasm-bindgen bindings: 20-byte hash160 identifier of the master xpub.
      hex = this._signer.getMasterXpub().identifier()
    } else if (typeof this._signer.keyoriginXpub === 'function') {
      // React Native (UniFFI / lwk-rn) binding: no getMasterXpub. Derive a stable
      // identifier from the 4-byte key-origin fingerprint in keyoriginXpub, e.g.
      // "[7f3c2a1b/84'/1'/0']xpub...". Best-effort; empty if unavailable.
      try {
        const ko = this._signer.keyoriginXpub(lwk.Bip.newBip84())
        hex = (String(ko).match(/\[([0-9a-fA-F]{8})/) || [])[1] || ''
      } catch { hex = '' }
    }
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return { publicKey: bytes, privateKey: null }
  }

  // ---------------------------------------------------------------------------
  // Liquid-specific operations
  // ---------------------------------------------------------------------------

  /**
   * Sends a non-L-BTC Liquid asset (e.g. USDt-Liquid).
   *
   * NB: `feeRate` is in **sat/kvB** — see `transfer`.
   *
   * @param {{ assetId: string, recipient: string, amount: number | bigint, feeRate?: number }} options
   * @returns {Promise<{ hash: string, fee: bigint }>}
   */
  async sendAsset ({ assetId, recipient, amount, feeRate }) {
    return this._run(async () => {
      await this._sync(true) // sends must build against fresh UTXOs
      // Consuming builder — see `transfer`: reassign after every chain call.
      let builder = this._network.txBuilder()
      builder = builder.addRecipient(
        lwk.Address.parse(recipient, this._network),
        BigInt(amount),
        lwk.AssetId.fromString(assetId)
      )
      if (feeRate != null) builder = builder.feeRate(feeRate)
      return this._buildSignBroadcast(builder)
    })
  }

  /**
   * Finishes, signs, finalizes and broadcasts a transaction from a builder.
   *
   * @private
   * @param {import('lwk_wasm').TxBuilder} builder
   * @returns {Promise<{ hash: string, fee: bigint }>}
   */
  async _buildSignBroadcast (builder) {
    let pset = builder.finish(this._wollet)
    const fee = this._wollet.psetDetails(pset).balance().fee()
    pset = this._signer.sign(pset)
    pset = this._wollet.finalize(pset)
    const txid = await this._esplora.broadcast(pset)
    return { hash: txid.toString(), fee: BigInt(fee) }
  }

  /**
   * Lists every Liquid asset held by the wallet with its satoshi balance.
   *
   * @returns {Promise<Array<{ asset_id: string, balance: string }>>}
   */
  async listAssets () {
    return this._run(async () => {
      await this._sync()
      // `Balance.entries()` is an iterable of [assetId, value] pairs, NOT a plain
      // array (it has no `.map`), so materialize it with Array.from — works across
      // the lwk_node / lwk_wasm / lwk-rn bindings.
      return Array.from(this._wollet.balance().entries(), ([asset, value]) => ({
        asset_id: String(asset),
        balance: String(value)
      }))
    })
  }

  /**
   * Returns the wallet's unspent transaction outputs.
   *
   * @returns {Promise<Array<{ txid: string, vout: number, asset_id: string, value: string, height: number | null }>>}
   */
  async listUnspents () {
    return this._run(async () => {
      await this._sync()
      return this._wollet.utxos().map((u) => {
        const outpoint = u.outpoint()
        const secrets = u.unblinded()
        return {
          txid: outpoint.txid().toString(),
          vout: outpoint.vout(),
          asset_id: secrets.asset().toString(),
          value: String(secrets.value()),
          height: u.height() ?? null
        }
      })
    })
  }

  /**
   * Returns the wallet transaction history (newest first).
   *
   * `balance` carries the wallet's net delta per asset for the tx (positive =
   * received, negative = sent), in each asset's smallest unit as a string, so
   * consumers can render per-asset amounts without re-scanning the UTXO set.
   *
   * @returns {Promise<Array<{ txid: string, type: string, fee: string, height: number | null, timestamp: number | null, balance: Array<{ asset_id: string, value: string }> }>>}
   */
  async listTransactions () {
    return this._run(async () => {
      await this._sync()
      return this._wollet.transactions().map((tx) => ({
        txid: tx.txid().toString(),
        type: tx.txType(),
        fee: String(tx.fee()),
        height: tx.height() ?? null,
        timestamp: tx.timestamp() ?? null,
        // See listAssets: entries() is an iterable, not an array — use Array.from.
        balance: Array.from(tx.balance().entries(), ([asset, value]) => ({
          asset_id: String(asset),
          value: String(value)
        }))
      }))
    })
  }

  /**
   * Returns a summary of the wallet network and sync tip.
   *
   * @returns {Promise<{ network: string, policy_asset: string, address: string, tip_height: number | null }>}
   */
  async getNetworkInfo () {
    // Status read — must be CHEAP. network/policy_asset/address need no chain
    // data, and tip_height reports the last-applied scan tip (null before the
    // first scan). Consumers poll this for connection status; making it scan
    // would put an Esplora full-scan on every status check and wedge the op
    // queue behind slow networks.
    return this._run(async () => {
      this._ensureReady()
      let tipHeight = null
      try { tipHeight = this._wollet.tip().height() } catch { /* never scanned */ }
      return {
        network: this._network.toString(),
        policy_asset: this._network.policyAsset().toString(),
        address: this._wollet.address().address().toString(),
        tip_height: tipHeight ?? null
      }
    })
  }
}
