'use strict'

import { describe, expect, test } from '@jest/globals'
import LiquidWalletManager from '../src/liquid-wallet-manager.js'
import { LiquidAccount } from '../src/liquid-account.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED = 'cook voyage document eight skate token alien guide drink uncle term abuse'

// LWK works fully offline for key derivation, address generation and message
// signing — only balance/transfer queries hit the network. These tests
// therefore exercise the real lwk_node WASM for offline operations and never
// need a mock.

// ---------------------------------------------------------------------------
// LiquidWalletManager
// ---------------------------------------------------------------------------

describe('LiquidWalletManager', () => {
  test('constructs from a mnemonic seed', () => {
    const wallet = new LiquidWalletManager(SEED)
    expect(wallet).toBeInstanceOf(LiquidWalletManager)
    wallet.dispose()
  })

  test('getAccount returns a LiquidAccount regardless of index', async () => {
    const wallet = new LiquidWalletManager(SEED)
    const a0 = await wallet.getAccount(0)
    const a5 = await wallet.getAccount(5)
    expect(a0).toBeInstanceOf(LiquidAccount)
    expect(a0).toBe(a5)
    wallet.dispose()
  })

  test('getAccountByPath returns the same account', async () => {
    const wallet = new LiquidWalletManager(SEED)
    const byIndex = await wallet.getAccount(0)
    const byPath = await wallet.getAccountByPath("m/84'/1'/0'")
    expect(byPath).toBe(byIndex)
    wallet.dispose()
  })

  test('getFeeRates returns bigint normal and fast rates', async () => {
    const wallet = new LiquidWalletManager(SEED)
    const rates = await wallet.getFeeRates()
    expect(typeof rates.normal).toBe('bigint')
    expect(typeof rates.fast).toBe('bigint')
    wallet.dispose()
  })

  test('throws when a byte seed is passed without config.mnemonic', () => {
    expect(() => new LiquidWalletManager(new Uint8Array(64))).toThrow(/mnemonic/)
  })

  test('accepts a byte seed when config.mnemonic is provided', () => {
    const wallet = new LiquidWalletManager(new Uint8Array(64), { mnemonic: SEED })
    expect(wallet).toBeInstanceOf(LiquidWalletManager)
    wallet.dispose()
  })
})

// ---------------------------------------------------------------------------
// LiquidAccount
// ---------------------------------------------------------------------------

describe('LiquidAccount', () => {
  test('throws when constructed without a mnemonic', () => {
    expect(() => new LiquidAccount({})).toThrow(/mnemonic/)
  })

  test('getAddress returns a testnet confidential address', async () => {
    const wallet = new LiquidWalletManager(SEED)
    const account = await wallet.getAccount(0)
    const address = await account.getAddress()
    expect(typeof address).toBe('string')
    // Liquid testnet confidential addresses are bech32 with the "tlq" prefix.
    expect(address.startsWith('tlq')).toBe(true)
    wallet.dispose()
  })

  test('getAddress is deterministic for the same seed', async () => {
    const w1 = new LiquidWalletManager(SEED)
    const w2 = new LiquidWalletManager(SEED)
    const addr1 = await (await w1.getAccount(0)).getAddress()
    const addr2 = await (await w2.getAccount(0)).getAddress()
    expect(addr1).toBe(addr2)
    w1.dispose()
    w2.dispose()
  })

  test('keyPair exposes a public key and a null private key', async () => {
    const wallet = new LiquidWalletManager(SEED)
    const account = await wallet.getAccount(0)
    const { publicKey, privateKey } = account.keyPair
    expect(publicKey).toBeInstanceOf(Uint8Array)
    expect(publicKey.length).toBeGreaterThan(0)
    expect(privateKey).toBeNull()
    wallet.dispose()
  })

  test('sign produces a base64 signature for a message', async () => {
    const wallet = new LiquidWalletManager(SEED)
    const account = await wallet.getAccount(0)
    const signature = await account.sign('hello liquid')
    expect(typeof signature).toBe('string')
    expect(signature.length).toBeGreaterThan(0)
    wallet.dispose()
  })

  test('defaults to the testnet network', async () => {
    const wallet = new LiquidWalletManager(SEED)
    const account = await wallet.getAccount(0)
    expect(account._networkName).toBe('testnet')
    wallet.dispose()
  })

  test('regtest network produces a regtest address', async () => {
    const wallet = new LiquidWalletManager(SEED, { network: 'regtest' })
    const account = await wallet.getAccount(0)
    const address = await account.getAddress()
    // Liquid regtest confidential addresses use the "el1" prefix.
    expect(address.startsWith('el1')).toBe(true)
    wallet.dispose()
  })
})
