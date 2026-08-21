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

export type LiquidNetworkName = 'mainnet' | 'testnet' | 'regtest'

export interface LiquidSyncWarning {
  code: 'LIQUID_WATERFALLS_FALLBACK'
  message: string
  details?: { reason?: 'waterfalls_failed' }
}

export interface LiquidWalletConfig {
  /** Liquid network (default: 'testnet'). */
  network?: LiquidNetworkName
  /** Esplora API base URL (default: the network's built-in client). */
  esploraUrl?: string
  /**
   * Use the server-side "waterfalls" scan (one request: descriptor → full history) instead of a
   * client-side gap-limit scan (~40 requests). Turns a ~10s cold sync into sub-second, but requires
   * `esploraUrl` to point at a waterfalls-capable server (public Blockstream Esplora is not one).
   * Default: false.
   */
  waterfalls?: boolean
  /**
   * Explicitly allow Waterfalls failures to retry once through the network's built-in standard
   * Esplora provider. This changes providers and may disclose wallet addresses/scripts to it.
   * Default: false.
   */
  allowDefaultEsploraFallback?: boolean
  /**
   * Optional waterfalls server recipient key; when set, the wallet descriptor is encrypted before it
   * is sent to the server. Ignored unless `waterfalls` is true.
   */
  waterfallsRecipient?: string
  /** BIP-39 mnemonic; required only when the seed is passed as bytes. */
  mnemonic?: string
  /** Receives a recoverable warning after Waterfalls fails and standard Esplora succeeds. */
  onWarning?: (warning: LiquidSyncWarning) => void | Promise<void>
  /** Watchdog for a wedged Esplora full-scan, in ms (default: 30000). */
  scanTimeoutMs?: number
  /**
   * Durable sink for the unblinding data of confidential outputs this wallet receives.
   * Strongly recommended — a seed-only restore does not reconstruct it. See
   * {@link LiquidSecretsStore}.
   */
  secretsStore?: LiquidSecretsStore
}

/** The unblinding data of a single confidential output, as observed. */
export interface LiquidOutputSecretsRecord {
  /** Funding transaction id, display (big-endian) order. */
  txid: string
  /** Output index within `txid`. */
  vout: number
  /** Unblinded asset id hex (64 chars). */
  assetId: string
  /** Unblinded amount in the asset's smallest unit, as a decimal string. */
  value: string
  /** Asset blinding factor hex (64 chars). */
  assetBlindingFactor: string
  /** Value blinding factor hex (64 chars). */
  valueBlindingFactor: string
}

/**
 * Host-supplied durable store for confidential outputs' unblinding data.
 *
 * A confidential output's asset, amount and blinding factors are not determined by the
 * descriptor, so restoring the mnemonic re-derives every address without reconstructing
 * these four values — they are read back out of the funding transaction, which is not the
 * stable source one might assume. A wallet that keeps no record of what it unblinded has
 * no second source if that read ever stops working.
 *
 * The account writes each newly observed output through exactly once, right after the scan
 * that revealed it. The store owns durability, namespacing (per wallet and per network) and
 * retention — a record stays relevant until its outpoint is spent.
 *
 * Treat the contents as key material, not display data: the blinding factors are what make
 * an output's amount and asset legible. They are deliberately absent from `listUnspents()`
 * and every other read API.
 */
export interface LiquidSecretsStore {
  /** Persist a batch of newly observed records. Must be idempotent per outpoint. */
  put (records: LiquidOutputSecretsRecord[]): void | Promise<void>
}

export interface TransferResult {
  /** The broadcast transaction id. */
  hash: string
  /** The transaction fee in satoshis. */
  fee: bigint
}

export interface KeyPair {
  publicKey: Uint8Array
  privateKey: null
}

export interface LiquidUnspent {
  txid: string
  vout: number
  asset_id: string
  value: string
  height: number | null
}

export interface LiquidTxBalance {
  asset_id: string
  /** Net wallet delta for this asset (signed), in the asset's smallest unit. */
  value: string
}

export interface LiquidTransaction {
  txid: string
  type: string
  fee: string
  height: number | null
  timestamp: number | null
  /** Per-asset net balance change for this tx (positive = received). */
  balance: LiquidTxBalance[]
}

export interface LiquidAssetBalance {
  asset_id: string
  balance: string
}

export interface LiquidNetworkInfo {
  network: string
  policy_asset: string
  address: string
  tip_height: number | null
}

export type SimplicityArgument =
  | { name: string; type: 'u8' | 'u16' | 'u32'; value: number }
  | { name: string; type: 'u64'; value: string | number | bigint }
  | { name: string; type: 'u128' | 'u256' | 'bytes'; value: string }
  | { name: string; type: 'bool'; value: boolean }

export interface SimplicityCapabilities {
  version: 'experimental-0.1'
  available: boolean
  pset: { inspect: boolean; blind: boolean; sign: boolean; finalize: boolean }
  simplicity: { compile: boolean; derivePublicKey: boolean; finalizeTransaction: boolean }
}

export interface LiquidPsetReview {
  pset: string
  uniqueId: string
  inputCount: number
  outputCount: number
  inputs: Array<{ index: number; txid: string; vout: number; sighash: number; issuanceAsset?: string; issuanceToken?: string }>
  outputs: Array<{ index: number; scriptPubKey: string; amount?: string; assetId?: string; blinderIndex?: number }>
  fee: string
  balances: Array<{ assetId: string; amount: string }>
  recipients: Array<{ vout: number; address?: string; assetId?: string; amount?: string }>
  issuances: Array<{
    inputIndex: number
    type: 'issuance' | 'reissuance' | 'none'
    assetId?: string
    tokenId?: string
    previousTxid?: string
    previousVout?: number
  }>
  signatures: Array<{ inputIndex: number; present: number; missing: number }>
}

export interface LiquidPsetSignResult {
  pset: string
  signedInputIndexes: number[]
  unchanged: boolean
}

export interface SimplicityCompileResult {
  cmr: string
  address: string
  internalKey: string
  walletPublicKey: string
  derivationPath: string
}

export class SimplicityUnavailableError extends Error {
  readonly code: 'SIMPLICITY_UNAVAILABLE'
  readonly feature: string
}

export class LiquidAccount {
  constructor (config: LiquidWalletConfig & { mnemonic: string })

  getAddress (): Promise<string>
  getBalance (): Promise<bigint>
  getTokenBalance (assetId: string): Promise<bigint>
  transfer (options: { recipient: string, amount: number | bigint, feeRate?: number }): Promise<TransferResult>
  sign (message: string): Promise<string>
  getSimplicityCapabilities (): SimplicityCapabilities
  inspectPset (psetBase64: string): Promise<LiquidPsetReview>
  blindPset (psetBase64: string): Promise<string>
  signPset (request: { pset: string; inputIndexes?: number[] }): Promise<LiquidPsetSignResult>
  finalizePset (psetBase64: string): Promise<{ pset: string; transactionHex: string; txid: string }>
  broadcastPset (psetBase64: string): Promise<{ txid: string }>
  deriveSimplicityPublicKey (derivationPath?: string): Promise<{ publicKey: string; derivationPath: string }>
  compileSimplicityProgram (request: {
    source: string
    arguments?: SimplicityArgument[]
    internalKey?: string
    derivationPath?: string
  }): Promise<SimplicityCompileResult>
  dispose (): void
  get keyPair (): KeyPair

  sendAsset (options: { assetId: string, recipient: string, amount: number | bigint, feeRate?: number }): Promise<TransferResult>
  listAssets (): Promise<LiquidAssetBalance[]>
  listUnspents (): Promise<LiquidUnspent[]>
  listTransactions (): Promise<LiquidTransaction[]>
  getNetworkInfo (): Promise<LiquidNetworkInfo>
  resync (): Promise<void>
}

export default class LiquidWalletManager {
  constructor (seed: string | Uint8Array, config?: LiquidWalletConfig)

  getAccount (index?: number): Promise<LiquidAccount>
  getAccountByPath (path?: string): Promise<LiquidAccount>
  getFeeRates (): Promise<{ normal: bigint, fast: bigint }>
  dispose (): void
}
