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
 */

function buildNetwork (name) {
  switch (name) {
    case 'mainnet': return lwk.Network.mainnet()
    case 'regtest': return lwk.Network.regtestDefault()
    case 'testnet':
    default: return lwk.Network.testnet()
  }
}

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
    this._ready = false
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
    this._esplora = this._esploraUrl
      ? new lwk.EsploraClient(this._network, this._esploraUrl, false, 1, false)
      : this._network.defaultEsploraClient()

    this._ready = true
  }

  /**
   * Scans the chain via Esplora and applies the resulting update so that
   * balance/transaction queries reflect the latest state.
   *
   * @private
   */
  async _sync () {
    this._ensureReady()
    const update = await this._esplora.fullScan(this._wollet)
    if (update) this._wollet.applyUpdate(update)
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
    this._ensureReady()
    return this._wollet.address().address().toString()
  }

  /**
   * Returns the spendable L-BTC balance in satoshis.
   *
   * @returns {Promise<bigint>}
   */
  async getBalance () {
    await this._sync()
    return this._balanceOf(this._network.policyAsset().toString())
  }

  /**
   * Returns the balance of a Liquid asset in its smallest unit.
   *
   * @param {string} assetId - Liquid asset id hex (64 chars).
   * @returns {Promise<bigint>}
   */
  async getTokenBalance (assetId) {
    await this._sync()
    return this._balanceOf(assetId)
  }

  /**
   * Sends L-BTC on the Liquid network.
   *
   * @param {{ recipient: string, amount: number | bigint, feeRate?: number }} options
   * @returns {Promise<{ hash: string, fee: bigint }>}
   */
  async transfer ({ recipient, amount, feeRate }) {
    await this._sync()
    const builder = this._network.txBuilder()
    builder.addLbtcRecipient(lwk.Address.parse(recipient, this._network), BigInt(amount))
    if (feeRate != null) builder.feeRate(feeRate)
    return this._buildSignBroadcast(builder)
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
   * @param {{ assetId: string, recipient: string, amount: number | bigint, feeRate?: number }} options
   * @returns {Promise<{ hash: string, fee: bigint }>}
   */
  async sendAsset ({ assetId, recipient, amount, feeRate }) {
    await this._sync()
    const builder = this._network.txBuilder()
    builder.addRecipient(
      lwk.Address.parse(recipient, this._network),
      BigInt(amount),
      lwk.AssetId.fromString(assetId)
    )
    if (feeRate != null) builder.feeRate(feeRate)
    return this._buildSignBroadcast(builder)
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
    await this._sync()
    return this._wollet.balance().entries().map(([asset, value]) => ({
      asset_id: asset,
      balance: String(value)
    }))
  }

  /**
   * Returns the wallet's unspent transaction outputs.
   *
   * @returns {Promise<Array<{ txid: string, vout: number, asset_id: string, value: string, height: number | null }>>}
   */
  async listUnspents () {
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
  }

  /**
   * Returns the wallet transaction history (newest first).
   *
   * @returns {Promise<Array<{ txid: string, type: string, fee: string, height: number | null, timestamp: number | null }>>}
   */
  async listTransactions () {
    await this._sync()
    return this._wollet.transactions().map((tx) => ({
      txid: tx.txid().toString(),
      type: tx.txType(),
      fee: String(tx.fee()),
      height: tx.height() ?? null,
      timestamp: tx.timestamp() ?? null
    }))
  }

  /**
   * Returns a summary of the wallet network and sync tip.
   *
   * @returns {Promise<{ network: string, policy_asset: string, address: string, tip_height: number | null }>}
   */
  async getNetworkInfo () {
    await this._sync()
    let tipHeight = null
    try { tipHeight = this._wollet.tip().height() } catch { /* never scanned */ }
    return {
      network: this._network.toString(),
      policy_asset: this._network.policyAsset().toString(),
      address: this._wollet.address().address().toString(),
      tip_height: tipHeight ?? null
    }
  }
}
