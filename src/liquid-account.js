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
import {
  SIMPLICITY_NUMS_INTERNAL_KEY,
  buildSimplicityArguments,
  getBindingCapabilities,
  requireBindingFeature,
  signatureCount
} from './simplicity.js'

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
 * @property {LiquidSecretsStore} [secretsStore] - Durable sink for the unblinding data of
 *   confidential outputs this wallet receives. Strongly recommended: see
 *   {@link LiquidSecretsStore}. Omitted, the account still works but keeps no record.
 */

/**
 * The unblinding data of a single confidential output, as observed.
 *
 * `value` is a decimal string and the two blinding factors are hex strings, so a
 * record is plain JSON — no BigInt or wasm handles — and survives a structured
 * clone, `JSON.stringify`, or a remote backup unchanged. The hex encoding is
 * whatever `AssetBlindingFactor`/`ValueBlindingFactor#toString()` produce, which
 * their matching `fromString()` accepts verbatim.
 *
 * @typedef {Object} LiquidOutputSecretsRecord
 * @property {string} txid - Funding transaction id, display (big-endian) order.
 * @property {number} vout - Output index within `txid`.
 * @property {string} assetId - Unblinded asset id hex (64 chars).
 * @property {string} value - Unblinded amount in the asset's smallest unit, decimal.
 * @property {string} assetBlindingFactor - ABF hex (64 chars).
 * @property {string} valueBlindingFactor - VBF hex (64 chars).
 */

/**
 * Host-supplied durable store for confidential outputs' unblinding data.
 *
 * Why this exists: a confidential output's asset, amount and blinding factors
 * are not determined by the descriptor. Restoring the mnemonic re-derives every
 * address, but it does NOT by itself reconstruct these four values — they are
 * read back out of the funding transaction, which is not the stable source one
 * might assume. So the usual "the seed is the only backup" assumption does not
 * hold on Liquid for confidential outputs, and a wallet that keeps no record of
 * what it unblinded has no second source if that read ever stops working.
 *
 * The account writes each newly observed output through exactly once, right
 * after the scan that revealed it. The store owns durability, namespacing (per
 * wallet and per network) and retention — a record stays relevant until its
 * outpoint is spent. `put` receives only records not already written during this
 * account's lifetime, so it is called rarely rather than on every sync.
 *
 * Treat the contents as key material, not as display data: the blinding factors
 * are what make an output's amount and asset legible. They are deliberately kept
 * out of `listUnspents()` and every other read API for that reason.
 *
 * @typedef {Object} LiquidSecretsStore
 * @property {(records: LiquidOutputSecretsRecord[]) => (void | Promise<void>)} put
 *   Persist a batch of newly observed records. Must be idempotent per outpoint.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * The leading byte of a base58 string, or null when it is not base58. Enough
 * to read an Elements address version; the checksum is lwk's to verify.
 *
 * @param {string} text
 * @returns {number | null}
 */
function base58LeadingByte (text) {
  let value = 0n
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char)
    if (digit === -1) return null
    value = value * 58n + BigInt(digit)
  }
  let hex = value.toString(16)
  if (hex.length % 2) hex = '0' + hex
  // Leading '1's are leading zero bytes.
  let zeros = 0
  for (const char of text) {
    if (char !== '1') break
    zeros++
  }
  if (zeros > 0) return 0
  return hex.length === 0 ? null : parseInt(hex.slice(0, 2), 16)
}

// Elements address versions, per rust-elements AddressParams: blinded
// prefix / P2PKH / P2SH for Liquid mainnet, Liquid testnet and regtest.
const BASE58_CHAINS = {
  12: 'mainnet',
  57: 'mainnet',
  39: 'mainnet',
  23: 'testnet',
  36: 'testnet',
  19: 'testnet',
  4: 'regtest',
  235: 'regtest',
  75: 'regtest'
}

/**
 * The chain an address string belongs to, read from its bech32/blech32 HRP
 * (`lq`/`ex`, `tlq`/`tex`, `el`/`ert`) or its base58 version byte. Null when
 * neither says.
 *
 * @param {string} address
 * @returns {'mainnet' | 'testnet' | 'regtest' | null}
 */
function addressChain (address) {
  const lower = address.trim().toLowerCase()
  const hrp = /^([a-z]+)1[02-9ac-hj-np-z]+$/.exec(lower)?.[1]
  if (hrp) {
    if (hrp === 'lq' || hrp === 'ex') return 'mainnet'
    if (hrp === 'tlq' || hrp === 'tex') return 'testnet'
    if (hrp === 'el' || hrp === 'ert') return 'regtest'
    return null
  }
  const version = base58LeadingByte(address.trim())
  return version == null ? null : (BASE58_CHAINS[version] ?? null)
}

function buildNetwork (binding, name) {
  switch (name) {
    case 'mainnet': return binding.Network.mainnet()
    case 'regtest': return binding.Network.regtestDefault()
    case 'testnet':
    default: return binding.Network.testnet()
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

// Witness weight lwk budgets for the swap input when pricing the fee. Covers a
// taproot script-path claim (signature, preimage, script, control block) with
// headroom; the cap check in `fundLiquidPset` bounds an over-estimate.
const HTLC_SPEND_MAX_WEIGHT = 400

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
    // Private test/host injection point. Production callers use the binding
    // selected by the package import conditions.
    this._lwk = config.bindings ?? lwk
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
    this._secretsStore = typeof config.secretsStore?.put === 'function' ? config.secretsStore : null
    // Outpoints already written through to `_secretsStore` in this account's
    // lifetime, so a steady-state sync writes nothing. Intentionally in-memory:
    // durability is the store's job, and a fresh process re-writing what it
    // re-observes is harmless because `put` is idempotent per outpoint.
    this._recordedSecretKeys = new Set()
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

    this._network = buildNetwork(this._lwk, this._networkName)
    this._signer = new this._lwk.Signer(new this._lwk.Mnemonic(this._mnemonic), this._network)
    this._descriptor = this._signer.wpkhSlip77Descriptor()
    this._wollet = new this._lwk.Wollet(this._network, this._descriptor)
    // EsploraClient(network, url, waterfalls, concurrency, utxo_only). With
    // waterfalls=false a gap-limit full-scan issues ~40+ requests, so use
    // concurrency 4 to keep it responsive. With waterfalls=true the server
    // returns the whole history in ONE request, so concurrency is moot.
    this._esplora = this._esploraUrl
      ? new this._lwk.EsploraClient(this._network, this._esploraUrl, this._waterfalls, 4, false)
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
      const scan = () => {
        if (timer) clearTimeout(timer)
        const timeout = new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`LiquidAccount: fullScan timed out after ${this._scanTimeoutMs}ms`)),
            this._scanTimeoutMs
          )
        })
        return Promise.race([this._esplora.fullScan(this._wollet), timeout])
      }
      let update = await scan()
      try {
        if (update) this._wollet.applyUpdate(update)
      } catch (err) {
        // The wallet's status moved while this scan ran — a transaction this
        // wallet broadcast was applied locally in between. The update was
        // computed against the old status; compute it again against the new.
        if (!/UpdateOnDifferentStatus/i.test(String(err?.message ?? err))) throw err
        console.warn('[LiquidAccount] wallet changed during the scan; scanning again')
        update = await scan()
        if (update) this._wollet.applyUpdate(update)
      }
      this._lastSyncAt = Date.now()
      console.info(`[LiquidAccount] ${scanKind} done in ${Date.now() - t0}ms`)
      // The scan that revealed an output is the one chance to record what it
      // unblinded to, so this runs on every applied update rather than lazily.
      await this._recordOutputSecrets()
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
   * Writes the unblinding data of every confidential UTXO not yet recorded
   * through to `_secretsStore`. See {@link LiquidSecretsStore} for why this data
   * is worth keeping and why the store, not this class, owns durability.
   *
   * Explicit (unblinded) outputs are skipped: their asset and amount are already
   * on-chain in the clear and their blinding factors are zero, so there is
   * nothing about them that a rescan could fail to recover.
   *
   * Never throws. This runs inside `_sync`, so letting a store failure escape
   * would take down every balance and address read behind it — a wallet that
   * cannot show a balance is a worse outcome than one that missed a write, and
   * the next sync retries anyway since the key is only marked on success.
   *
   * Callers must already hold the `_run` queue: this borrows the Wollet.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _recordOutputSecrets () {
    if (!this._secretsStore) return
    /** @type {LiquidOutputSecretsRecord[]} */
    const pending = []
    /** @type {string[]} */
    const pendingKeys = []
    try {
      for (const utxo of this._wollet.utxos()) {
        const secrets = utxo.unblinded()
        if (!secrets || secrets.isExplicit()) continue
        const outpoint = utxo.outpoint()
        const txid = outpoint.txid().toString()
        const vout = outpoint.vout()
        const key = `${txid}:${vout}`
        if (this._recordedSecretKeys.has(key)) continue
        pending.push({
          txid,
          vout,
          assetId: secrets.asset().toString(),
          value: String(secrets.value()),
          assetBlindingFactor: secrets.assetBlindingFactor().toString(),
          valueBlindingFactor: secrets.valueBlindingFactor().toString()
        })
        pendingKeys.push(key)
      }
      if (pending.length === 0) return
      await this._secretsStore.put(pending)
      // Only after a settled write, so a rejected put is retried next sync.
      for (const key of pendingKeys) this._recordedSecretKeys.add(key)
      console.info(`[LiquidAccount] recorded unblinding data for ${pending.length} output(s)`)
    } catch (err) {
      // Deliberately no record contents in the log — the blinding factors are
      // what make an output legible, so they must not reach a log sink.
      console.error(
        `[LiquidAccount] failed to record unblinding data for ${pending.length} output(s):`,
        err?.message ?? err
      )
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
   * Parses a recipient address, confidential or not.
   *
   * `Address.parse` refuses an unconfidential address outright — "Expected a
   * blinded address but got a non-blinded one" — so it cannot be the only way
   * in. Liquid's explicit addresses are valid and in real use: swap HTLCs are
   * commonly minted unconfidential so that a watcher can read the output's
   * asset and value without holding a blinding key.
   *
   * `new Address(s)` is the lenient constructor and takes both. What it does
   * NOT do is check the network, which is the reason `parse` was used here, so
   * the network is checked explicitly rather than dropped: sending testnet
   * funds to a mainnet address is a worse failure than the one being fixed.
   * That check is coarser than `parse`'s — the binding only exposes
   * `isMainnet()`, so it separates mainnet from the rest but lets testnet and
   * regtest pass for each other. Both are worthless-coin networks; confusing
   * them cannot lose real funds, which is what this guard is for.
   *
   * @param {string} recipient
   * @returns {object} An lwk `Address`.
   */
  _parseRecipient (recipient) {
    try {
      return this._lwk.Address.parse(recipient, this._network)
    } catch (err) {
      // `Address.parse` validated the network as well as the format; the
      // lenient constructor validates neither beyond "is it an address", and
      // `isMainnet()` cannot tell testnet from regtest. Read the chain off the
      // address itself and require this account's: testnet funds to a regtest
      // address are as lost as to a mainnet one.
      const address = new this._lwk.Address(recipient)
      const chain = addressChain(String(recipient))
      if (chain !== this._chainName()) {
        throw err
      }
      return address
    }
  }

  /** The chain this account is on, as `addressChain` names them. */
  _chainName () {
    if (this._network.isMainnet()) return 'mainnet'
    if (this._network.isRegtest()) return 'regtest'
    return 'testnet'
  }

  /**
   * Adds an unconfidential output to `builder`.
   *
   * `addLbtcRecipient` / `addRecipient` blind the output they add and refuse an
   * address that carries no blinding key, so an explicit recipient has to go
   * through `addExplicitRecipient`. That method exists on the wasm-bindgen
   * bindings (lwk_wasm / lwk_node) but not on the React Native UniFFI binding
   * (lwk-rn), so feature-detect it the way `sign` does and fail with a readable
   * message instead of "addExplicitRecipient is not a function".
   *
   * @param {object} builder - lwk `TxBuilder` (consumed; use the return value).
   * @param {object} address - lwk `Address`, unconfidential.
   * @param {bigint} amount
   * @param {object} asset - lwk `AssetId`.
   * @returns {object} The next builder in the chain.
   */
  _addExplicitRecipient (builder, address, amount, asset) {
    if (typeof builder.addExplicitRecipient !== 'function') {
      throw new Error(
        'LiquidAccount: sending to an unconfidential address is not supported by the active LWK binding (react-native)'
      )
    }
    return builder.addExplicitRecipient(address, amount, asset)
  }

  /**
   * Sends L-BTC on the Liquid network.
   *
   * A fixed `amount` is paid in full and the fee is added on top of it, so
   * it has to leave the fee's worth of L-BTC behind: an amount at or above
   * the spendable balance is refused as insufficient funds. To send everything,
   * pass `sendMax: true` and no amount — the wallet is drained to the
   * recipient and the fee comes out of what they receive; the result's
   * `amount` is what actually reached them.
   *
   * NB: `feeRate` is in **sat/kvB** (lwk convention; its default is 100, i.e.
   * 0.1 sat/vB — the Liquid network minimum). Do NOT pass Bitcoin-style sat/vB
   * values: 1 sat/vB must be given as 1000. When omitted, lwk's default is used,
   * which is virtually always right on Liquid (federated 1-min blocks, no fee
   * market).
   *
   * @param {{ recipient: string, amount?: number | bigint, feeRate?: number, sendMax?: boolean }} options
   * @returns {Promise<{ hash: string, fee: bigint, amount: bigint }>}
   *   `amount` is the L-BTC the recipient receives, net of fee for a drain.
   */
  async transfer ({ recipient, amount, feeRate, sendMax = false }) {
    return this._run(async () => {
      await this._sync(true) // sends must build against fresh UTXOs
      const address = this._parseRecipient(recipient)
      // lwk's TxBuilder is a CONSUMING builder (wasm-bindgen moves `self`):
      // every chain method invalidates the receiver and returns a fresh
      // builder. Reusing the old reference throws "null pointer passed to
      // rust" — always reassign.
      let builder = this._network.txBuilder()
      const policyAsset = this._network.policyAsset()
      const policyBalance = this._balanceOf(policyAsset.toString())
      const explicit = !address.isBlinded()
      let requested = null
      if (sendMax) {
        // Send-max to an explicit address has no working form: draining leaves
        // the recipient as the only non-fee output, so nothing in the
        // transaction is blinded and `finish()` dies in lwk's `blind_last`
        // ("Atleast one output secrets should be provided"). Refuse it up front
        // rather than surface that from deep inside the builder.
        if (explicit) {
          throw new Error(
            'LiquidAccount.transfer: cannot send the whole L-BTC balance to an unconfidential address — ' +
            'the drained transaction would have no blinded output for lwk to blind. ' +
            'Send a fixed amount below the balance, or use a confidential recipient.'
          )
        }
        if (policyBalance <= 0n) {
          throw new Error('LiquidAccount.transfer: Insufficient funds: no L-BTC to send')
        }
        // `addLbtcRecipient` adds the fee ON TOP of the amount, so the whole
        // balance can only leave as a drain: every L-BTC input goes to the
        // recipient and the fee is deducted from what they get.
        builder = builder.drainLbtcWallet()
        builder = builder.drainLbtcTo(address)
      } else {
        requested = BigInt(amount ?? 0)
        if (requested <= 0n) {
          throw new Error('LiquidAccount.transfer: amount must be a positive number of satoshis')
        }
        // The fee is paid on top of a fixed amount, so the balance has to
        // exceed it. Anything else is not "send what you can", it is a request
        // the wallet cannot honour as asked — and must not reinterpret.
        if (requested >= policyBalance) {
          throw new Error(
            `LiquidAccount.transfer: Insufficient funds: requested ${requested} sat but only ` +
            `${policyBalance} sat of L-BTC is spendable and the fee is paid on top. ` +
            'To send everything, pass sendMax: true.'
          )
        }
        builder = explicit
          ? this._addExplicitRecipient(builder, address, requested, policyAsset)
          : builder.addLbtcRecipient(address, requested)
      }
      if (feeRate != null) builder = builder.feeRate(feeRate)
      const sent = await this._buildSignBroadcast(builder)
      // What the recipient receives: the fixed amount, or for a drain the
      // wallet's L-BTC outflow less the fee it paid.
      const outflow = sent.outflows.get(policyAsset.toString())
      const received = requested ?? (outflow == null ? null : outflow - sent.fee)
      return { hash: sent.hash, fee: sent.fee, amount: received }
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
   * Reports the exact experimental operations exposed by the active LWK
   * binding. A normal npm build remains usable for ordinary Liquid PSETs but
   * reports Simplicity compilation and external-PSET blinding as unavailable.
   */
  getSimplicityCapabilities () {
    return getBindingCapabilities(this._lwk)
  }

  /** @private */
  _inspectPsetObject (pset) {
    const inputs = pset.inputs()
    const outputs = pset.outputs()
    const details = this._wollet.psetDetails(pset)
    const balance = details.balance()
    const signatures = details.signatures()

    return {
      pset: pset.toString(),
      uniqueId: pset.uniqueId().toString(),
      inputCount: inputs.length,
      outputCount: outputs.length,
      inputs: inputs.map((input, index) => ({
        index,
        txid: input.previousTxid().toString(),
        vout: input.previousVout(),
        sighash: input.sighash(),
        issuanceAsset: input.issuanceAsset()?.toString(),
        issuanceToken: input.issuanceToken()?.toString()
      })),
      outputs: outputs.map((output, index) => {
        const amount = output.amount()
        return {
          index,
          scriptPubKey: output.scriptPubkey().toString(),
          amount: amount == null ? undefined : String(amount),
          assetId: output.asset()?.toString(),
          blinderIndex: output.blinderIndex()
        }
      }),
      fee: String(balance.fee()),
      balances: Array.from(balance.balances().entries(), ([asset, amount]) => ({
        assetId: String(asset),
        amount: String(amount)
      })),
      recipients: balance.recipients().map((recipient) => {
        const amount = recipient.value()
        return {
          vout: recipient.vout(),
          address: recipient.address()?.toString(),
          assetId: recipient.asset()?.toString(),
          amount: amount == null ? undefined : String(amount)
        }
      }),
      issuances: details.inputsIssuances().map((issuance, index) => ({
        inputIndex: index,
        type: issuance.isReissuance() ? 'reissuance' : (issuance.isIssuance() ? 'issuance' : 'none'),
        assetId: issuance.asset()?.toString(),
        tokenId: issuance.token()?.toString(),
        previousTxid: issuance.prevTxid()?.toString(),
        previousVout: issuance.prevVout()
      })),
      signatures: signatures.map((entry, index) => ({
        inputIndex: index,
        present: signatureCount(entry.hasSignature()),
        missing: signatureCount(entry.missingSignature())
      }))
    }
  }

  /** Parse an external PSET and return only structured, review-safe fields. */
  async inspectPset (psetBase64) {
    return this._run(async () => {
      this._ensureReady()
      requireBindingFeature(this.getSimplicityCapabilities(), 'pset.inspect')
      return this._inspectPsetObject(new this._lwk.Pset(psetBase64))
    })
  }

  /** Blind an external PSET with this wallet's confidential descriptor. */
  async blindPset (psetBase64) {
    return this._run(async () => {
      this._ensureReady()
      requireBindingFeature(this.getSimplicityCapabilities(), 'pset.blind')
      const blinded = this._wollet.blind(new this._lwk.Pset(psetBase64))
      return blinded.toString()
    })
  }

  /**
   * Sign wallet-owned PSET inputs. When `inputIndexes` is provided, fail closed
   * if LWK signs any additional input; a rejected result is never returned.
   */
  async signPset ({ pset, inputIndexes }) {
    return this._run(async () => {
      this._ensureReady()
      requireBindingFeature(this.getSimplicityCapabilities(), 'pset.sign')
      const parsed = new this._lwk.Pset(pset)
      const before = this._inspectPsetObject(parsed)
      let allowed = null
      if (inputIndexes != null) {
        if (!Array.isArray(inputIndexes) || inputIndexes.length === 0) {
          throw new TypeError('signPset.inputIndexes must be a non-empty array when provided')
        }
        allowed = new Set(inputIndexes)
        for (const index of allowed) {
          if (!Number.isInteger(index) || index < 0 || index >= before.inputCount) {
            throw new RangeError(`signPset input index out of range: ${index}`)
          }
        }
      }

      const signed = await this._signer.sign(parsed)
      const after = this._inspectPsetObject(signed)
      const signedInputIndexes = after.signatures
        .filter((entry, index) => entry.present > (before.signatures[index]?.present ?? 0))
        .map((entry) => entry.inputIndex)
      const unexpected = allowed == null ? [] : signedInputIndexes.filter((index) => !allowed.has(index))
      if (unexpected.length) {
        throw new Error(`LiquidAccount.signPset refused signatures outside the allowlist: ${unexpected.join(', ')}`)
      }
      return {
        pset: signed.toString(),
        signedInputIndexes,
        unchanged: signedInputIndexes.length === 0
      }
    })
  }

  /** Finalize a fully signed PSET without broadcasting it. */
  async finalizePset (psetBase64) {
    return this._run(async () => {
      this._ensureReady()
      requireBindingFeature(this.getSimplicityCapabilities(), 'pset.finalize')
      const finalized = this._wollet.finalize(new this._lwk.Pset(psetBase64))
      const transaction = finalized.extractTx()
      return {
        pset: finalized.toString(),
        transactionHex: transaction.toString(),
        txid: transaction.txid().toString()
      }
    })
  }

  /** Broadcast a finalized PSET through the configured Esplora provider. */
  async broadcastPset (psetBase64) {
    return this._run(async () => {
      this._ensureReady()
      const txid = await this._esplora.broadcast(new this._lwk.Pset(psetBase64))
      return { txid: txid.toString() }
    })
  }

  /**
   * Funds a caller-built Liquid PSET template (an HTLC input plus a full-value
   * payout) with L-BTC for the network fee, blinds the outputs this wallet adds
   * and signs only its own inputs. The swap input stays unsigned.
   *
   * lwk cannot add inputs to an existing PSET, so the transaction is rebuilt
   * around the swap input as an external UTXO and the template is used only to
   * check that the caller's intent (input, payout script) is what gets built.
   * The returned PSET orders inputs and outputs freely; the caller locates the
   * swap input and the payout by outpoint and script.
   *
   * @param {object} params
   * @param {string} params.pset - Base64 template.
   * @param {number} params.swapInputIndex
   * @param {number} params.paymentOutputIndex
   * @param {string} params.policyAssetId - L-BTC asset id; must be the network's.
   * @param {number} params.maxFeeSat - Fee ceiling; a dearer build is refused.
   * @param {string} params.outputAddress - Payout destination, explicit or confidential.
   * @param {string} params.swapAssetId - Asset of the (unconfidential) swap input.
   * @param {number | bigint | string} params.swapAmount - Amount of the swap input.
   * @param {string} params.lockupTxHex - Transaction that created the swap input.
   * @returns {Promise<{ pset: string, paymentOutputSecrets: { assetId: string, value: string, assetBlindingFactor: string, valueBlindingFactor: string } }>}
   */
  async fundLiquidPset ({
    pset, swapInputIndex, paymentOutputIndex, policyAssetId, maxFeeSat,
    outputAddress, swapAssetId, swapAmount, lockupTxHex
  }) {
    return this._run(async () => {
      this._ensureReady()
      const lwk = this._lwk
      if (policyAssetId !== this._network.policyAsset().toString()) {
        throw new Error('LiquidAccount.fundLiquidPset: policyAssetId is not this network\'s L-BTC')
      }
      const amount = BigInt(swapAmount)
      const maxFee = BigInt(maxFeeSat)
      const template = new lwk.Pset(pset)
      const templateInputs = template.inputs()
      const templateOutputs = template.outputs()
      if (templateInputs.length !== 1 || swapInputIndex !== 0) {
        throw new Error('LiquidAccount.fundLiquidPset: the template must hold only the swap input')
      }
      const payout = templateOutputs[paymentOutputIndex]
      if (!payout) throw new RangeError(`fundLiquidPset paymentOutputIndex out of range: ${paymentOutputIndex}`)
      const emptyScript = lwk.Script.empty().toString()
      templateOutputs.forEach((output, index) => {
        if (index !== paymentOutputIndex && output.scriptPubkey().toString() !== emptyScript) {
          throw new Error('LiquidAccount.fundLiquidPset: the template holds an output besides the payout')
        }
      })
      const address = this._parseRecipient(outputAddress)
      const payoutScript = address.scriptPubkey().toString()
      if (payoutScript !== payout.scriptPubkey().toString()) {
        throw new Error('LiquidAccount.fundLiquidPset: outputAddress does not match the template payout')
      }

      const lockupTx = lwk.Transaction.fromString(lockupTxHex)
      const swapTxid = templateInputs[0].previousTxid().toString()
      const swapVout = templateInputs[0].previousVout()
      if (lockupTx.txid().toString() !== swapTxid) {
        throw new Error('LiquidAccount.fundLiquidPset: lockupTxHex is not the swap input\'s transaction')
      }

      await this._sync(true) // fee inputs must come from fresh UTXOs
      const ownsSwapInput = this._wollet.utxos().some(
        (utxo) => utxo.outpoint().txid().toString() === swapTxid && utxo.outpoint().vout() === swapVout
      )
      if (ownsSwapInput) {
        throw new Error('LiquidAccount.fundLiquidPset: the swap input is one of this wallet\'s own outputs')
      }
      const swapAsset = lwk.AssetId.fromString(swapAssetId)
      const external = new lwk.ExternalUtxo(
        swapVout,
        lockupTx,
        lwk.TxOutSecrets.fromExplicit(swapAsset, amount),
        HTLC_SPEND_MAX_WEIGHT,
        true
      )
      // Consuming builder — see `transfer`: reassign after every chain call.
      let builder = this._network.txBuilder().addExternalUtxos([external])
      builder = address.isBlinded()
        ? builder.addRecipient(address, amount, swapAsset)
        : this._addExplicitRecipient(builder, address, amount, swapAsset)
      // The SDK checks the amount/asset proofs of every non-swap input.
      builder = builder.addInputRangeproofs(true)
      const built = builder.finish(this._wollet)

      const fee = BigInt(this._wollet.psetDetails(built).balance().fee())
      if (fee > maxFee) {
        throw new Error(`LiquidAccount.fundLiquidPset: the network fee ${fee} sat exceeds the ${maxFee} sat cap`)
      }
      const signed = this._signer.sign(built)

      const outputs = signed.outputs()
      const payoutIndexes = outputs
        .map((output, index) => (output.scriptPubkey().toString() === payoutScript ? index : -1))
        .filter((index) => index >= 0)
      if (payoutIndexes.length !== 1) {
        throw new Error('LiquidAccount.fundLiquidPset: the built transaction does not hold exactly one payout')
      }
      const inputs = signed.inputs()
      const swapInputs = inputs.filter(
        (input) => input.previousTxid().toString() === swapTxid && input.previousVout() === swapVout
      )
      if (swapInputs.length !== 1) {
        throw new Error('LiquidAccount.fundLiquidPset: the built transaction does not spend the swap input once')
      }
      // The swap input is the caller's to finalize: fail closed if it got signed.
      const swapIndex = inputs.indexOf(swapInputs[0])
      const signatures = this._wollet.psetDetails(signed).signatures()
      if (signatureCount(signatures[swapIndex]?.hasSignature()) > 0) {
        throw new Error('LiquidAccount.fundLiquidPset: refused a signature on the swap input')
      }

      let secrets
      if (address.isBlinded()) {
        // The factors are not readable from a PSET. Re-read the payout with the
        // wallet's own blinding key through a throwaway Wollet, so the unsent
        // transaction never touches this account's balance.
        const probe = new lwk.Wollet(this._network, this._descriptor)
        try {
          probe.applyTransaction(signed.extractTx())
          const txid = signed.extractTx().txid().toString()
          const found = probe.txos().find(
            (utxo) => utxo.outpoint().txid().toString() === txid && utxo.outpoint().vout() === payoutIndexes[0]
          )
          if (!found) {
            throw new Error(
              'LiquidAccount.fundLiquidPset: the payout is confidential for an address this wallet cannot unblind'
            )
          }
          const unblinded = found.unblinded()
          secrets = {
            assetId: unblinded.asset().toString(),
            value: unblinded.value(),
            assetBlindingFactor: unblinded.assetBlindingFactor().toString(),
            valueBlindingFactor: unblinded.valueBlindingFactor().toString()
          }
        } finally {
          probe.free?.()
        }
      } else {
        secrets = {
          assetId: swapAssetId,
          value: amount,
          assetBlindingFactor: lwk.AssetBlindingFactor.zero().toString(),
          valueBlindingFactor: lwk.ValueBlindingFactor.zero().toString()
        }
      }
      if (secrets.assetId !== swapAssetId || BigInt(secrets.value) !== amount) {
        throw new Error('LiquidAccount.fundLiquidPset: the payout does not carry the whole swap amount')
      }
      return { pset: signed.toString(), paymentOutputSecrets: { ...secrets, value: String(secrets.value) } }
    })
  }

  /** Derive an x-only public key for a Simplicity program argument. */
  async deriveSimplicityPublicKey (derivationPath) {
    return this._run(async () => {
      this._ensureReady()
      requireBindingFeature(this.getSimplicityCapabilities(), 'simplicity.derivePublicKey')
      const path = derivationPath ?? (this._networkName === 'mainnet' ? "m/86'/0'/0'/0/0" : "m/86'/1'/0'/0/0")
      return {
        publicKey: this._lwk.simplicityDeriveXonlyPubkey(this._signer, path).toString(),
        derivationPath: path
      }
    })
  }

  /** Compile a parameterized SimplicityHL program and derive its P2TR address. */
  async compileSimplicityProgram ({ source, arguments: values = [], internalKey, derivationPath }) {
    return this._run(async () => {
      this._ensureReady()
      const capabilities = this.getSimplicityCapabilities()
      requireBindingFeature(capabilities, 'simplicity.compile')
      requireBindingFeature(capabilities, 'simplicity.derivePublicKey')
      if (typeof source !== 'string' || source.trim().length === 0) {
        throw new TypeError('compileSimplicityProgram.source is required')
      }
      const path = derivationPath ?? (this._networkName === 'mainnet' ? "m/86'/0'/0'/0/0" : "m/86'/1'/0'/0/0")
      const walletPublicKey = this._lwk.simplicityDeriveXonlyPubkey(this._signer, path)
      const taprootInternalKey = internalKey ?? SIMPLICITY_NUMS_INTERNAL_KEY
      const program = this._lwk.SimplicityProgram.load(
        source,
        buildSimplicityArguments(this._lwk, values)
      )
      return {
        cmr: program.cmr.toString(),
        address: program.createP2trAddress(
          this._lwk.XOnlyPublicKey.fromString(taprootInternalKey),
          this._network
        ).toString(),
        internalKey: taprootInternalKey,
        walletPublicKey: walletPublicKey.toString(),
        derivationPath: path
      }
    })
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
        const ko = this._signer.keyoriginXpub(this._lwk.Bip.newBip84())
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
      const units = BigInt(amount ?? 0)
      if (units <= 0n) {
        throw new Error('LiquidAccount.sendAsset: amount must be a positive number of units')
      }
      // Consuming builder — see `transfer`: reassign after every chain call.
      let builder = this._network.txBuilder()
      // Same split as `transfer`: an explicit recipient cannot go through
      // `addRecipient`, which blinds the output.
      const address = this._parseRecipient(recipient)
      const asset = this._lwk.AssetId.fromString(assetId)
      builder = address.isBlinded()
        ? builder.addRecipient(address, units, asset)
        : this._addExplicitRecipient(builder, address, units, asset)
      if (feeRate != null) builder = builder.feeRate(feeRate)
      const sent = await this._buildSignBroadcast(builder)
      return { hash: sent.hash, fee: sent.fee, amount: units }
    })
  }

  /**
   * Finishes, signs, finalizes and broadcasts a transaction from a builder.
   *
   * @private
   * @param {import('lwk_wasm').TxBuilder} builder
   * @returns {Promise<{ hash: string, fee: bigint, outflows: Map<string, bigint> }>}
   *   `outflows` is what the transaction takes out of this wallet per asset,
   *   as positive amounts (fee included for L-BTC).
   */
  async _buildSignBroadcast (builder) {
    let pset = builder.finish(this._wollet)
    const balance = this._wollet.psetDetails(pset).balance()
    const fee = BigInt(balance.fee())
    const outflows = new Map()
    const entries = typeof balance.balances === 'function' ? balance.balances()?.entries?.() : null
    if (entries) {
      for (const [asset, delta] of entries) {
        if (BigInt(delta) < 0n) outflows.set(String(asset), -BigInt(delta))
      }
    }
    pset = this._signer.sign(pset)
    pset = this._wollet.finalize(pset)
    const txid = await this._esplora.broadcast(pset)
    this._applyBroadcast(pset)
    return { hash: txid.toString(), fee, outflows }
  }

  /**
   * Makes a transaction this wallet just broadcast part of its own state at
   * once: the inputs it spent are gone and its change is there, so a send
   * that follows cannot pick the same inputs, and a balance read right after
   * does not report the pre-send amount. The next sync is also no longer
   * "fresh": the chain has to be scanned again for what the broadcast did.
   *
   * @private
   * @param {object} pset - The finalized PSET that was broadcast.
   */
  _applyBroadcast (pset) {
    try {
      if (typeof pset?.extractTx === 'function' && typeof this._wollet?.applyTransaction === 'function') {
        this._wollet.applyTransaction(pset.extractTx())
      }
    } catch (err) {
      // The broadcast already happened; the next scan will show the
      // transaction. Only the shortcut is lost.
      console.warn('[LiquidAccount] could not apply the broadcast transaction locally:', err?.message ?? err)
    } finally {
      this._lastSyncAt = 0
    }
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
