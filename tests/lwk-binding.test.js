'use strict'

import { describe, expect, test } from '@jest/globals'
import lwk from '#lwk'
import { getBindingCapabilities } from '../src/simplicity.js'

// The `#lwk` subpath import (package.json `imports` map) selects the LWK WASM
// binding per environment: `lwk_node` under Node/Bare, `lwk_wasm` in the
// browser. Under Jest (Node) it must resolve to the node binding and expose the
// usual LWK namespace synchronously — no async init.
describe('#lwk binding', () => {
  test('resolves to a namespace exposing the core LWK classes', () => {
    expect(lwk).toBeTruthy()
    for (const cls of ['Network', 'Signer', 'Mnemonic', 'Wollet', 'EsploraClient', 'TxBuilder', 'AssetId', 'Address']) {
      expect(typeof lwk[cls]).toBe('function')
    }
  })

  test('the node binding is ready on import (builds a Network synchronously)', () => {
    const network = lwk.Network.testnet()
    expect(network.toString().toLowerCase()).toContain('testnet')
    network.free?.()
  })

  test('the published node binding degrades explicitly when optional Simplicity exports are absent', () => {
    expect(getBindingCapabilities(lwk)).toEqual({
      version: 'experimental-0.1',
      available: false,
      pset: { inspect: true, blind: false, sign: true, finalize: true },
      simplicity: { compile: false, derivePublicKey: false, finalizeTransaction: false }
    })
  })
})
