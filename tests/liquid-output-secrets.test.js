'use strict'

import { describe, expect, jest, test } from '@jest/globals'
import lwk from 'lwk_node'
import LiquidWalletManager from '../src/liquid-wallet-manager.js'
import { LiquidAccount } from '../src/liquid-account.js'

const SEED = 'cook voyage document eight skate token alien guide drink uncle term abuse'

// ---------------------------------------------------------------------------
// Fakes shaped like the slice of the LWK API the recorder touches. The Wollet
// itself cannot be hand-built (its constructor needs a real descriptor + a
// network scan), so these stand in for the objects `utxos()` hands back.
// ---------------------------------------------------------------------------

function fakeUtxo ({ txid, vout, assetId, value, abf, vbf, explicit = false }) {
  return {
    outpoint: () => ({ txid: () => ({ toString: () => txid }), vout: () => vout }),
    unblinded: () => ({
      isExplicit: () => explicit,
      asset: () => ({ toString: () => assetId }),
      value: () => value,
      assetBlindingFactor: () => ({ toString: () => abf }),
      valueBlindingFactor: () => ({ toString: () => vbf })
    })
  }
}

const ASSET = 'a'.repeat(64)
const ABF = 'b'.repeat(64)
const VBF = 'c'.repeat(64)

function accountWithUtxos (utxos, secretsStore) {
  const account = new LiquidAccount({ mnemonic: SEED, secretsStore })
  // Bypass _ensureReady: the recorder only ever borrows the Wollet.
  account._ready = true
  account._wollet = { utxos: () => utxos }
  return account
}

describe('confidential output secrets recording', () => {
  test('records the four unblinding values per confidential outpoint', async () => {
    const put = jest.fn()
    const account = accountWithUtxos(
      [fakeUtxo({ txid: 'ab'.repeat(32), vout: 1, assetId: ASSET, value: 12345n, abf: ABF, vbf: VBF })],
      { put }
    )

    await account._recordOutputSecrets()

    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0]).toEqual([
      {
        txid: 'ab'.repeat(32),
        vout: 1,
        assetId: ASSET,
        value: '12345',
        assetBlindingFactor: ABF,
        valueBlindingFactor: VBF
      }
    ])
  })

  test('skips explicit outputs, which have nothing to recover', async () => {
    const put = jest.fn()
    const account = accountWithUtxos(
      [
        fakeUtxo({ txid: 'ab'.repeat(32), vout: 0, assetId: ASSET, value: 1n, abf: ABF, vbf: VBF, explicit: true }),
        fakeUtxo({ txid: 'cd'.repeat(32), vout: 0, assetId: ASSET, value: 2n, abf: ABF, vbf: VBF })
      ],
      { put }
    )

    await account._recordOutputSecrets()

    expect(put).toHaveBeenCalledTimes(1)
    const records = put.mock.calls[0][0]
    expect(records).toHaveLength(1)
    expect(records[0].txid).toBe('cd'.repeat(32))
  })

  test('writes each outpoint through once, not on every sync', async () => {
    const put = jest.fn()
    const account = accountWithUtxos(
      [fakeUtxo({ txid: 'ab'.repeat(32), vout: 0, assetId: ASSET, value: 7n, abf: ABF, vbf: VBF })],
      { put }
    )

    await account._recordOutputSecrets()
    await account._recordOutputSecrets()
    await account._recordOutputSecrets()

    expect(put).toHaveBeenCalledTimes(1)
  })

  test('records a newly arrived output without rewriting known ones', async () => {
    const put = jest.fn()
    const first = fakeUtxo({ txid: 'ab'.repeat(32), vout: 0, assetId: ASSET, value: 1n, abf: ABF, vbf: VBF })
    const utxos = [first]
    const account = accountWithUtxos(utxos, { put })

    await account._recordOutputSecrets()
    utxos.push(fakeUtxo({ txid: 'ef'.repeat(32), vout: 3, assetId: ASSET, value: 2n, abf: ABF, vbf: VBF }))
    await account._recordOutputSecrets()

    expect(put).toHaveBeenCalledTimes(2)
    const second = put.mock.calls[1][0]
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ txid: 'ef'.repeat(32), vout: 3 })
  })

  test('a failing store neither throws nor loses the record', async () => {
    const put = jest
      .fn()
      .mockRejectedValueOnce(new Error('quota exceeded'))
      .mockResolvedValueOnce(undefined)
    const account = accountWithUtxos(
      [fakeUtxo({ txid: 'ab'.repeat(32), vout: 0, assetId: ASSET, value: 9n, abf: ABF, vbf: VBF })],
      { put }
    )

    await expect(account._recordOutputSecrets()).resolves.toBeUndefined()
    // The key must not have been marked, so the next sync retries it.
    await account._recordOutputSecrets()

    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls[1][0]).toHaveLength(1)
  })

  test('is inert when no store is configured', async () => {
    const account = accountWithUtxos([
      fakeUtxo({ txid: 'ab'.repeat(32), vout: 0, assetId: ASSET, value: 1n, abf: ABF, vbf: VBF })
    ])
    await expect(account._recordOutputSecrets()).resolves.toBeUndefined()
  })

  test('ignores a store that does not implement put', async () => {
    const account = accountWithUtxos(
      [fakeUtxo({ txid: 'ab'.repeat(32), vout: 0, assetId: ASSET, value: 1n, abf: ABF, vbf: VBF })],
      { put: 'not a function' }
    )
    expect(account._secretsStore).toBeNull()
    await expect(account._recordOutputSecrets()).resolves.toBeUndefined()
  })

  test('a record is plain JSON — no BigInt, no wasm handles', async () => {
    const put = jest.fn()
    const account = accountWithUtxos(
      [fakeUtxo({ txid: 'ab'.repeat(32), vout: 2, assetId: ASSET, value: 2n ** 53n + 1n, abf: ABF, vbf: VBF })],
      { put }
    )

    await account._recordOutputSecrets()

    const record = put.mock.calls[0][0][0]
    // JSON.stringify throws on BigInt, so this also pins the u64 encoding.
    expect(() => JSON.stringify(record)).not.toThrow()
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
    expect(record.value).toBe('9007199254740993')
  })

  test('the persisted blinding factors are accepted back by real LWK types', async () => {
    const put = jest.fn()
    // Real wasm factor objects rather than stubs, so the encoding this writes is
    // pinned against the types that have to read it back.
    const realAbf = lwk.AssetBlindingFactor.fromString(ABF)
    const realVbf = lwk.ValueBlindingFactor.fromString(VBF)
    const account = accountWithUtxos(
      [
        {
          outpoint: () => ({ txid: () => ({ toString: () => 'ab'.repeat(32) }), vout: () => 0 }),
          unblinded: () => ({
            isExplicit: () => false,
            asset: () => ({ toString: () => ASSET }),
            value: () => 500n,
            assetBlindingFactor: () => realAbf,
            valueBlindingFactor: () => realVbf
          })
        }
      ],
      { put }
    )

    await account._recordOutputSecrets()

    const record = put.mock.calls[0][0][0]
    expect(lwk.AssetBlindingFactor.fromString(record.assetBlindingFactor).toString()).toBe(ABF)
    expect(lwk.ValueBlindingFactor.fromString(record.valueBlindingFactor).toString()).toBe(VBF)
  })

  test('a sync that applies an update records what it revealed', async () => {
    const put = jest.fn()
    const account = new LiquidAccount({ mnemonic: SEED, secretsStore: { put } })
    account._ready = true
    const applyUpdate = jest.fn()
    account._wollet = {
      applyUpdate,
      utxos: () => [
        fakeUtxo({ txid: 'ab'.repeat(32), vout: 0, assetId: ASSET, value: 42n, abf: ABF, vbf: VBF })
      ]
    }
    account._esplora = { fullScan: jest.fn().mockResolvedValue('update-handle') }

    await account._sync(true)

    expect(applyUpdate).toHaveBeenCalledWith('update-handle')
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0][0]).toMatchObject({ value: '42' })
  })
})

describe('LiquidWalletManager secretsStore wiring', () => {
  test('forwards a configured store to the account', async () => {
    const put = jest.fn()
    const wallet = new LiquidWalletManager(SEED, { secretsStore: { put } })
    const account = await wallet.getAccount(0)
    expect(account._secretsStore).toEqual({ put })
    wallet.dispose()
  })

  test('leaves the account without a store when none is configured', async () => {
    const wallet = new LiquidWalletManager(SEED)
    const account = await wallet.getAccount(0)
    expect(account._secretsStore).toBeNull()
    wallet.dispose()
  })
})
