'use strict'

import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { LiquidAccount } from '../src/liquid-account.js'

// These tests cover the React Native (`react-native` #lwk condition) wiring and
// the binding-tolerance in LiquidAccount. They run under Node (jest) — the actual
// `lwk-rn` native module is NOT imported here (it requires a device build); instead
// we assert the package contract statically and simulate an RN-shaped signer.

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const SEED = 'cook voyage document eight skate token alien guide drink uncle term abuse'

describe('react-native (#lwk) binding wiring', () => {
  test('package #lwk map routes the react-native condition to src/lwk-native.js', () => {
    expect(pkg.imports['#lwk']['react-native']).toBe('./src/lwk-native.js')
  })

  test('react-native condition precedes the wasm fallbacks (matched first on RN)', () => {
    const keys = Object.keys(pkg.imports['#lwk'])
    expect(keys[0]).toBe('react-native')
  })

  test('lwk-rn is declared as an OPTIONAL peer dependency (not a hard dep)', () => {
    expect(pkg.peerDependencies['lwk-rn']).toBeTruthy()
    expect(pkg.peerDependenciesMeta['lwk-rn']).toEqual({ optional: true })
    expect(pkg.dependencies['lwk-rn']).toBeUndefined()
  })

  test('src/lwk-native.js loads lwk-rn and re-exports its namespace as default', () => {
    const src = readFileSync(join(root, 'src/lwk-native.js'), 'utf8')
    expect(src).toMatch(/import \* as lwk from ['"]lwk-rn['"]/)
    expect(src).toMatch(/export default lwk/)
  })
})

describe('LiquidAccount binding-tolerance (RN signer lacks signMessage/getMasterXpub)', () => {
  // The lwk-rn (UniFFI) Signer exposes sign(pset)/wpkhSlip77Descriptor/keyoriginXpub
  // but NOT signMessage()/getMasterXpub(). LiquidAccount must degrade gracefully.

  function rnAccount () {
    const acct = new LiquidAccount({ mnemonic: SEED, network: 'testnet' })
    acct._ensureReady()
    // Replace the real (wasm) signer with an RN-shaped one (no signMessage/getMasterXpub).
    acct._signer = { keyoriginXpub: () => "[7f3c2a1b/84'/1'/0']xpubFAKE" }
    return acct
  }

  test('sign() rejects with a clear error when signMessage is unavailable', async () => {
    const acct = rnAccount()
    await expect(acct.sign('hello')).rejects.toThrow(/message signing is not supported/i)
  })

  test('keyPair degrades gracefully (privateKey null, publicKey is a Uint8Array)', () => {
    const acct = rnAccount()
    const kp = acct.keyPair
    expect(kp.privateKey).toBeNull()
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
  })

  test('the wasm path still uses signMessage when present (no regression)', () => {
    const acct = new LiquidAccount({ mnemonic: SEED, network: 'testnet' })
    acct._ensureReady()
    // The real lwk_node signer exposes signMessage; sign() must take that path.
    expect(typeof acct._signer.signMessage).toBe('function')
    acct.dispose()
  })
})
