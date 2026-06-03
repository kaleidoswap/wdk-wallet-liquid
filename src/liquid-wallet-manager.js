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

import WalletManager from '@tetherto/wdk-wallet'

import { LiquidAccount } from './liquid-account.js'

/**
 * @typedef {Object} LiquidWalletConfig
 * @property {'mainnet' | 'testnet' | 'regtest'} [network] - Liquid network (default: 'testnet').
 * @property {string} [esploraUrl] - Esplora API base URL (default: the network's built-in client).
 * @property {string} [mnemonic] - BIP-39 mnemonic; required only when the seed is passed as bytes.
 */

/**
 * WDK WalletManager implementation for the Liquid network, backed by an
 * in-process LWK (Liquid Wallet Kit) wallet.
 *
 * The SLIP-77 CT descriptor covers every address, so there is a single
 * logical account — `getAccount()` always returns the same `LiquidAccount`
 * regardless of index.
 */
export default class LiquidWalletManager extends WalletManager {
  /**
   * @param {string | Uint8Array} seed - BIP-39 mnemonic phrase, or seed bytes
   *   (in which case `config.mnemonic` must be provided for LWK key derivation).
   * @param {LiquidWalletConfig} [config]
   */
  constructor (seed, config = {}) {
    // The mnemonic words are needed by LWK; the base constructor converts a
    // string seed into bytes, so capture the phrase before calling super().
    const mnemonic = typeof seed === 'string' ? seed : config.mnemonic

    super(seed, config)

    if (!mnemonic) {
      throw new Error('LiquidWalletManager: a BIP-39 mnemonic is required (pass it as the seed or as config.mnemonic)')
    }

    this._account = new LiquidAccount({
      mnemonic,
      network: config.network ?? 'testnet',
      esploraUrl: config.esploraUrl
    })
  }

  /**
   * Returns the single Liquid account. The `index` parameter is ignored.
   *
   * @param {number} [index]
   * @returns {Promise<LiquidAccount>}
   */
  async getAccount (index = 0) {
    return this._account
  }

  /**
   * Returns the single Liquid account. The `path` parameter is ignored.
   *
   * @param {string} [path]
   * @returns {Promise<LiquidAccount>}
   */
  async getAccountByPath (path) {
    return this._account
  }

  /**
   * Returns Liquid fee rates in satoshi per virtual byte.
   *
   * Liquid blocks are produced on a fixed cadence by a federation, so fees do
   * not spike the way they do on Bitcoin; the network minimum (0.1 sat/vB) is
   * almost always sufficient.
   *
   * @returns {Promise<{ normal: bigint, fast: bigint }>}
   */
  async getFeeRates () {
    return { normal: 1n, fast: 1n }
  }

  /**
   * Frees the account's underlying WASM handles.
   */
  dispose () {
    this._account?.dispose()
  }
}
