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

export interface LiquidWalletConfig {
  /** Liquid network (default: 'testnet'). */
  network?: LiquidNetworkName
  /** Esplora API base URL (default: the network's built-in client). */
  esploraUrl?: string
  /** BIP-39 mnemonic; required only when the seed is passed as bytes. */
  mnemonic?: string
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

export interface LiquidTransaction {
  txid: string
  type: string
  fee: string
  height: number | null
  timestamp: number | null
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

export class LiquidAccount {
  constructor (config: { mnemonic: string, network?: LiquidNetworkName, esploraUrl?: string })

  getAddress (): Promise<string>
  getBalance (): Promise<bigint>
  getTokenBalance (assetId: string): Promise<bigint>
  transfer (options: { recipient: string, amount: number | bigint, feeRate?: number }): Promise<TransferResult>
  sign (message: string): Promise<string>
  dispose (): void
  get keyPair (): KeyPair

  sendAsset (options: { assetId: string, recipient: string, amount: number | bigint, feeRate?: number }): Promise<TransferResult>
  listAssets (): Promise<LiquidAssetBalance[]>
  listUnspents (): Promise<LiquidUnspent[]>
  listTransactions (): Promise<LiquidTransaction[]>
  getNetworkInfo (): Promise<LiquidNetworkInfo>
}

export default class LiquidWalletManager {
  constructor (seed: string | Uint8Array, config?: LiquidWalletConfig)

  getAccount (index?: number): Promise<LiquidAccount>
  getAccountByPath (path?: string): Promise<LiquidAccount>
  getFeeRates (): Promise<{ normal: bigint, fast: bigint }>
  dispose (): void
}
