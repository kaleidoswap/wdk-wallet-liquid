import { LiquidAccount } from '../src/liquid-account.js'
import { jest } from '@jest/globals'
import {
  SimplicityUnavailableError,
  buildSimplicityArguments,
  getBindingCapabilities,
} from '../src/simplicity.js'

class FakePset {
  constructor (value) {
    this.value = value
    this.signed = []
  }

  toString () { return `${this.value}:${this.signed.join(',')}` }
  uniqueId () { return { toString: () => 'unique-id' } }
  extractTx () {
    return {
      toString: () => '02000000',
      txid: () => ({ toString: () => 'final-txid' })
    }
  }
  outputs () {
    return [{
      scriptPubkey: () => ({ toString: () => '5120abcd' }),
      amount: () => 1250n,
      asset: () => ({ toString: () => 'asset-id' }),
      blinderIndex: () => 0
    }]
  }
  inputs () {
    return [0, 1].map((index) => ({
      previousTxid: () => ({ toString: () => `txid-${index}` }),
      previousVout: () => index,
      sighash: () => 1,
      issuanceAsset: () => undefined,
      issuanceToken: () => undefined,
    }))
  }
}

class FakeSigner {
  sign (pset) {
    pset.signed = [0, 1]
    return pset
  }
}

class FakeWollet {
  blind (pset) { return pset }
  finalize (pset) { return pset }
  psetDetails (pset) {
    return {
      balance: () => ({
        fee: () => 10n,
        balances: () => ({ entries: () => [['asset-id', -1260n]] }),
        recipients: () => [{
          vout: () => 0,
          address: () => ({ toString: () => 'tex1recipient' }),
          asset: () => ({ toString: () => 'asset-id' }),
          value: () => 1250n
        }]
      }),
      signatures: () => [0, 1].map((index) => ({
        hasSignature: () => pset.signed.includes(index) ? ['sig'] : [],
        missingSignature: () => pset.signed.includes(index) ? [] : ['key'],
      })),
      inputsIssuances: () => [0, 1].map(() => ({
        isIssuance: () => false,
        isReissuance: () => false,
        asset: () => undefined,
        token: () => undefined,
        prevTxid: () => undefined,
        prevVout: () => undefined
      }))
    }
  }
}

const fakeBinding = { Pset: FakePset, Signer: FakeSigner, Wollet: FakeWollet }

function fakeAccount (binding = fakeBinding) {
  const account = new LiquidAccount({ mnemonic: 'test', bindings: binding })
  account._ready = true
  account._signer = new FakeSigner()
  account._wollet = new FakeWollet()
  account._network = {}
  return account
}

describe('experimental Simplicity and PSET APIs', () => {
  it('reports individual binding capabilities without claiming Simplicity support', () => {
    expect(getBindingCapabilities(fakeBinding)).toEqual(expect.objectContaining({
      available: false,
      pset: { inspect: true, blind: true, sign: true, finalize: true },
    }))
  })

  it('constructs typed arguments with consuming builders', () => {
    const values = []
    class Arguments {
      addValue (name, value) {
        const next = new Arguments()
        next.values = [...(this.values ?? []), [name, value]]
        return next
      }
    }
    const binding = {
      SimplicityArguments: Arguments,
      SimplicityTypedValue: { fromU32: (value) => ({ value }) },
    }
    const args = buildSimplicityArguments(binding, [{ name: 'LOCKTIME', type: 'u32', value: 42 }])
    values.push(...args.values)
    expect(values).toEqual([['LOCKTIME', { value: 42 }]])
  })

  it('normalizes a PSET into review-safe primitives', async () => {
    await expect(fakeAccount().inspectPset('external')).resolves.toMatchObject({
      pset: 'external:',
      uniqueId: 'unique-id',
      inputCount: 2,
      outputCount: 1,
      fee: '10',
      outputs: [{ amount: '1250', assetId: 'asset-id', blinderIndex: 0 }],
      balances: [{ assetId: 'asset-id', amount: '-1260' }],
      recipients: [{ address: 'tex1recipient', amount: '1250' }],
      signatures: [
        { inputIndex: 0, present: 0, missing: 1 },
        { inputIndex: 1, present: 0, missing: 1 }
      ]
    })
  })

  it('rejects typed values that wasm-bindgen would otherwise coerce', () => {
    const binding = {
      SimplicityArguments: class {},
      SimplicityTypedValue: { fromU32: (value) => value, fromBoolean: (value) => value }
    }
    expect(() => buildSimplicityArguments(binding, [{ name: 'N', type: 'u32', value: -1 }]))
      .toThrow(/unsigned integer/)
    expect(() => buildSimplicityArguments(binding, [{ name: 'FLAG', type: 'bool', value: 'false' }]))
      .toThrow(/must be a boolean/)
  })

  it('fails closed when the signer touches an input outside the allowlist', async () => {
    await expect(fakeAccount().signPset({ pset: 'external', inputIndexes: [0] }))
      .rejects.toThrow(/outside the allowlist: 1/)
  })

  it('returns the exact input indexes newly signed', async () => {
    await expect(fakeAccount().signPset({ pset: 'external', inputIndexes: [0, 1] }))
      .resolves.toEqual({ pset: 'external:0,1', signedInputIndexes: [0, 1], unchanged: false })
  })

  it('returns unchanged when the wallet owns no signable inputs', async () => {
    const account = fakeAccount()
    account._signer = { sign: (pset) => pset }
    await expect(account.signPset({ pset: 'external', inputIndexes: [0] }))
      .resolves.toEqual({ pset: 'external:', signedInputIndexes: [], unchanged: true })
  })

  it('rejects empty and out-of-range signing allowlists before invoking the signer', async () => {
    const account = fakeAccount()
    account._signer = { sign: jest.fn() }
    await expect(account.signPset({ pset: 'external', inputIndexes: [] }))
      .rejects.toThrow(/non-empty array/)
    await expect(account.signPset({ pset: 'external', inputIndexes: [2] }))
      .rejects.toThrow(/out of range: 2/)
    expect(account._signer.sign).not.toHaveBeenCalled()
  })

  it('blinds, finalizes, and broadcasts PSETs without exposing wallet secrets', async () => {
    const account = fakeAccount()
    account._esplora = { broadcast: async () => ({ toString: () => 'broadcast-txid' }) }
    await expect(account.blindPset('external')).resolves.toBe('external:')
    await expect(account.finalizePset('external')).resolves.toEqual({
      pset: 'external:',
      transactionHex: '02000000',
      txid: 'final-txid'
    })
    await expect(account.broadcastPset('external')).resolves.toEqual({ txid: 'broadcast-txid' })
  })

  it('compiles with deterministic arguments, NUMS internal key, and network derivation path', async () => {
    class Arguments {
      addValue (name, value) {
        const next = new Arguments()
        next.values = [...(this.values ?? []), [name, value]]
        return next
      }
    }
    class Program {
      static load (source, args) {
        expect(source).toBe('main := unit')
        expect(args.values).toEqual([['PUBLIC_KEY', { hex: '00'.repeat(32) }]])
        return new Program()
      }

      get cmr () { return { toString: () => 'contract-cmr' } }
      createP2trAddress (key) { return { toString: () => `address:${key}` } }
      finalizeTransaction () {}
    }
    const binding = {
      ...fakeBinding,
      SimplicityArguments: Arguments,
      SimplicityTypedValue: { fromU256Hex: (hex) => ({ hex }) },
      SimplicityProgram: Program,
      simplicityDeriveXonlyPubkey: (_signer, path) => ({ toString: () => `wallet-key:${path}` }),
      XOnlyPublicKey: { fromString: (value) => value }
    }
    const result = await fakeAccount(binding).compileSimplicityProgram({
      source: 'main := unit',
      arguments: [{ name: 'PUBLIC_KEY', type: 'u256', value: '00'.repeat(32) }]
    })
    expect(result).toEqual({
      cmr: 'contract-cmr',
      address: 'address:50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
      internalKey: '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
      walletPublicKey: "wallet-key:m/86'/1'/0'/0/0",
      derivationPath: "m/86'/1'/0'/0/0"
    })
  })

  it('throws a typed error when compilation is absent', async () => {
    await expect(fakeAccount().compileSimplicityProgram({ source: 'main := unit' }))
      .rejects.toBeInstanceOf(SimplicityUnavailableError)
  })
})
