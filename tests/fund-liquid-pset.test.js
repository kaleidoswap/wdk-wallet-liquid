'use strict'

import { describe, expect, test } from '@jest/globals'
import LiquidWalletManager from '../src/liquid-wallet-manager.js'

const SEED = 'cook voyage document eight skate token alien guide drink uncle term abuse'
const POLICY = 'POLICY'
const USDT = 'USDT'
const SWAP_TXID = 'aa'.repeat(32)
const PAYOUT_SCRIPT = 'payout-script'
const wrap = (value) => ({ toString: () => value })

function fakeLwk () {
  return {
    Pset: class {
      constructor (b64) { this.b64 = b64 }
      toString () { return this.b64 }
    },
    Script: { empty: () => wrap('') },
    Transaction: { fromString: (hex) => ({ txid: () => wrap(hex) }) },
    AssetId: { fromString: (id) => id },
    ExternalUtxo: class { constructor (...args) { this.args = args } },
    TxOutSecrets: { fromExplicit: (a, v) => ({ a, v }) },
    AssetBlindingFactor: { zero: () => wrap('00'.repeat(32)) },
    ValueBlindingFactor: { zero: () => wrap('11'.repeat(32)) }
  }
}

async function setup ({ fee = 120n, builtOutputs } = {}) {
  const manager = new LiquidWalletManager(SEED)
  const account = await manager.getAccount(0)
  const swapInput = { previousTxid: () => wrap(SWAP_TXID), previousVout: () => 1 }
  const out = (script) => ({ scriptPubkey: () => wrap(script) })
  const template = { inputs: [swapInput], outputs: [out(PAYOUT_SCRIPT), out('')] }
  const built = {
    inputs: [swapInput, { previousTxid: () => wrap('bb'.repeat(32)), previousVout: () => 0 }],
    outputs: builtOutputs ?? [out('change'), out(PAYOUT_SCRIPT), out('')]
  }
  const fake = fakeLwk()
  const captured = {}
  Object.assign(account, {
    _lwk: fake,
    _ready: true,
    _ensureReady () {},
    async _sync () {},
    _parseRecipient: () => ({ isBlinded: () => false, scriptPubkey: () => wrap(PAYOUT_SCRIPT) }),
    _addExplicitRecipient (builder, address, amount, asset) {
      captured.recipient = { amount, asset }
      return builder
    },
    _network: {
      policyAsset: () => wrap(POLICY),
      txBuilder: () => ({
        addExternalUtxos (utxos) { captured.utxos = utxos; return this },
        addInputRangeproofs (flag) { captured.rangeproofs = flag; return this },
        finish: () => ({ toString: () => 'built', ...built, inputs: () => built.inputs, outputs: () => built.outputs })
      })
    },
    _wollet: { psetDetails: () => ({ balance: () => ({ fee: () => fee }) }) },
    _signer: { sign: () => new fake.Pset('signed') }
  })
  fake.Pset.prototype.inputs = function () { return this.b64 === 'template' ? template.inputs : built.inputs }
  fake.Pset.prototype.outputs = function () { return this.b64 === 'template' ? template.outputs : built.outputs }
  const request = {
    pset: 'template',
    swapInputIndex: 0,
    paymentOutputIndex: 0,
    policyAssetId: POLICY,
    maxFeeSat: 500,
    outputAddress: 'addr',
    swapAssetId: USDT,
    swapAmount: 1000,
    lockupTxHex: SWAP_TXID
  }
  return { account, request, captured, manager }
}

describe('LiquidAccount.fundLiquidPset', () => {
  test('rebuilds around the swap input and returns explicit payout secrets', async () => {
    const { account, request, captured, manager } = await setup()
    const funded = await account.fundLiquidPset(request)
    expect(funded.pset).toBe('signed')
    expect(funded.paymentOutputSecrets).toEqual({
      assetId: USDT,
      value: '1000',
      assetBlindingFactor: '00'.repeat(32),
      valueBlindingFactor: '11'.repeat(32)
    })
    expect(captured.utxos).toHaveLength(1)
    expect(captured.recipient).toEqual({ amount: 1000n, asset: USDT })
    expect(captured.rangeproofs).toBe(true)
    manager.dispose()
  })

  test('refuses a fee above the cap', async () => {
    const { account, request, manager } = await setup({ fee: 501n })
    await expect(account.fundLiquidPset(request)).rejects.toThrow(/exceeds the 500 sat cap/)
    manager.dispose()
  })

  test('refuses a policy asset that is not the network\'s', async () => {
    const { account, request, manager } = await setup()
    await expect(account.fundLiquidPset({ ...request, policyAssetId: 'other' })).rejects.toThrow(/policyAssetId/)
    manager.dispose()
  })

  test('refuses a lockup transaction that is not the swap input\'s', async () => {
    const { account, request, manager } = await setup()
    await expect(account.fundLiquidPset({ ...request, lockupTxHex: 'cc'.repeat(32) })).rejects.toThrow(/lockupTxHex/)
    manager.dispose()
  })

  test('refuses an output address that is not the template payout', async () => {
    const { account, request, manager } = await setup()
    account._parseRecipient = () => ({ isBlinded: () => false, scriptPubkey: () => wrap('elsewhere') })
    await expect(account.fundLiquidPset(request)).rejects.toThrow(/does not match the template payout/)
    manager.dispose()
  })

  test('refuses a build with no single payout', async () => {
    const out = (script) => ({ scriptPubkey: () => wrap(script) })
    const { account, request, manager } = await setup({ builtOutputs: [out('change'), out('')] })
    await expect(account.fundLiquidPset(request)).rejects.toThrow(/exactly one payout/)
    manager.dispose()
  })
})
