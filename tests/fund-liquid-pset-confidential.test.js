'use strict'

import { describe, expect, test } from '@jest/globals'
import lwk from '#lwk'
import LiquidWalletManager from '../src/liquid-wallet-manager.js'

const SEED = 'cook voyage document eight skate token alien guide drink uncle term abuse'
const OTHER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
// Past the BIP44 gap (20) and not the wallet's last-unused index.
const HIGH_INDEX = 40
const SWAP_ASSET = '11'.repeat(32)
const FEE_COIN = 100_000n
const SWAP_AMOUNT = 5_000n

function concatBytes (parts) {
  return Buffer.concat(parts.map((part) => Buffer.from(part)))
}

function u32le (value) {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value)
  return out
}

function u64le (value) {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(BigInt(value))
  return out
}

function reverseHex (hex) {
  return Buffer.from(hex, 'hex').reverse()
}

// Same version-2 LWK update `fundLiquidPset` applies: index one script and
// nothing else. Kept inline so this test fails if that byte layout drifts.
function scriptIndexUpdate (scriptBytes) {
  const header = Buffer.concat([
    Buffer.from('00000080', 'hex'),
    Buffer.alloc(32),
    Buffer.alloc(32),
    Buffer.alloc(8),
    Buffer.from([0, 0, 0])
  ])
  return concatBytes([
    Buffer.from('8961b8c8', 'hex'),
    Buffer.from([2]),
    Buffer.alloc(8),
    Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from([1, scriptBytes.length]),
    scriptBytes,
    Buffer.from([0]),
    u32le(0),
    Buffer.alloc(33),
    header
  ])
}

function explicitTx ({ assetDisplay, value, script }) {
  const valueBytes = Buffer.alloc(8)
  valueBytes.writeBigUInt64BE(BigInt(value))
  const output = Buffer.concat([
    Buffer.from([0x01]),
    reverseHex(assetDisplay),
    Buffer.from([0x01]),
    valueBytes,
    Buffer.from([0x00]),
    Buffer.from([script.length]),
    script
  ])
  return Buffer.concat([
    u32le(2),
    Buffer.from([0x00, 0x00, 0x01]),
    output,
    u32le(0)
  ]).toString('hex')
}

function psetPair (type, keyRest, value) {
  return Buffer.concat([
    Buffer.from([1 + keyRest.length, type]),
    Buffer.from(keyRest),
    Buffer.from([value.length]),
    Buffer.from(value)
  ])
}

function templatePset ({ txid, script, amount, assetDisplay }) {
  const body = Buffer.concat([
    Buffer.from('70736574ff', 'hex'),
    psetPair(0x02, Buffer.alloc(0), u32le(2)),
    psetPair(0x04, Buffer.alloc(0), Buffer.from([1])),
    psetPair(0x05, Buffer.alloc(0), Buffer.from([1])),
    psetPair(0xfb, Buffer.alloc(0), u32le(2)),
    Buffer.from([0]),
    psetPair(0x0e, Buffer.alloc(0), reverseHex(txid)),
    psetPair(0x0f, Buffer.alloc(0), u32le(0)),
    Buffer.from([0]),
    psetPair(0x03, Buffer.alloc(0), u64le(amount)),
    psetPair(0x04, Buffer.alloc(0), script),
    psetPair(0xfc, Buffer.from('047073657402', 'hex'), reverseHex(assetDisplay)),
    Buffer.from([0])
  ])
  return body.toString('base64')
}

function receiveAddress (wollet, index) {
  return wollet.address(index).address()
}

async function fundedAccount () {
  const manager = new LiquidWalletManager(SEED, { network: 'regtest' })
  const account = await manager.getAccount(0)
  account._ensureReady()
  // The claim builds against a scan. A stub keeps the coin this test inserts.
  account._esplora.fullScan = async () => undefined
  const network = account._network
  const policy = network.policyAsset().toString()
  const feeAddress = receiveAddress(account._wollet, 0)
  const feeScript = Buffer.from(feeAddress.scriptPubkey().bytes())
  const coinHex = explicitTx({
    assetDisplay: policy,
    value: FEE_COIN + 1_000n,
    script: feeScript
  })
  const external = new lwk.ExternalUtxo(
    0,
    lwk.Transaction.fromString(coinHex),
    lwk.TxOutSecrets.fromExplicit(network.policyAsset(), FEE_COIN + 1_000n),
    400,
    true
  )
  const empty = new lwk.Wollet(network, account._descriptor)
  let builder = network.txBuilder().addExternalUtxos([external])
  builder = builder.addRecipient(feeAddress, FEE_COIN, network.policyAsset())
  const funding = builder.finish(empty).extractTx()
  account._wollet.applyUpdate(new lwk.Update(scriptIndexUpdate(feeScript)))
  account._wollet.applyTransaction(funding)
  empty.free?.()
  return { manager, account, policy }
}

function claimRequest ({ account, outputAddress, script, assetDisplay = SWAP_ASSET, amount = SWAP_AMOUNT }) {
  const lockupHex = explicitTx({ assetDisplay, value: amount, script })
  const lockup = lwk.Transaction.fromString(lockupHex)
  return {
    pset: templatePset({
      txid: lockup.txid().toString(),
      script,
      amount,
      assetDisplay
    }),
    swapInputIndex: 0,
    paymentOutputIndex: 0,
    policyAssetId: account._network.policyAsset().toString(),
    maxFeeSat: 50_000,
    outputAddress,
    swapAssetId: assetDisplay,
    swapAmount: amount,
    lockupTxHex: lockupHex
  }
}

describe('confidential payout unblinding', () => {
  test('a fresh wollet does not see its own confidential output at a high index', async () => {
    const { manager, account } = await fundedAccount()
    const network = account._network
    const payout = receiveAddress(account._wollet, HIGH_INDEX)
    const script = Buffer.from(payout.scriptPubkey().bytes())
    const coinHex = explicitTx({ assetDisplay: SWAP_ASSET, value: SWAP_AMOUNT, script })
    const external = new lwk.ExternalUtxo(
      0,
      lwk.Transaction.fromString(coinHex),
      lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(SWAP_ASSET), SWAP_AMOUNT),
      400,
      true
    )
    let builder = network.txBuilder().addExternalUtxos([external])
    builder = builder.addRecipient(payout, SWAP_AMOUNT, lwk.AssetId.fromString(SWAP_ASSET))
    const tx = builder.finish(account._wollet).extractTx()

    const fresh = new lwk.Wollet(network, account._descriptor)
    fresh.applyTransaction(tx)
    expect(fresh.txos()).toHaveLength(0)

    const indexed = new lwk.Wollet(network, account._descriptor)
    indexed.applyUpdate(new lwk.Update(scriptIndexUpdate(script)))
    indexed.applyTransaction(tx)
    const found = indexed.txos()
    expect(found).toHaveLength(1)
    const unblinded = found[0].unblinded()
    expect(unblinded.asset().toString()).toBe(SWAP_ASSET)
    expect(unblinded.value()).toBe(SWAP_AMOUNT)
    expect(unblinded.isExplicit()).toBe(false)
    fresh.free?.()
    indexed.free?.()
    manager.dispose()
  })

  test('pays a confidential address of this account at a high index', async () => {
    const { manager, account } = await fundedAccount()
    const payout = receiveAddress(account._wollet, HIGH_INDEX)
    const script = Buffer.from(payout.scriptPubkey().bytes())
    const funded = await account.fundLiquidPset(claimRequest({
      account,
      outputAddress: payout.toString(),
      script
    }))

    expect(funded.paymentOutputSecrets.assetId).toBe(SWAP_ASSET)
    expect(funded.paymentOutputSecrets.value).toBe(SWAP_AMOUNT.toString())
    expect(funded.paymentOutputSecrets.assetBlindingFactor).toMatch(/^[0-9a-f]{64}$/)
    expect(funded.paymentOutputSecrets.valueBlindingFactor).toMatch(/^[0-9a-f]{64}$/)
    expect(funded.paymentOutputSecrets.assetBlindingFactor).not.toBe('0'.repeat(64))
    expect(funded.paymentOutputSecrets.valueBlindingFactor).not.toBe('0'.repeat(64))

    // The factors are what a second unblind of the same output reads back.
    const again = new lwk.Wollet(account._network, account._descriptor)
    again.applyUpdate(new lwk.Update(scriptIndexUpdate(script)))
    const tx = new lwk.Pset(funded.pset).extractTx()
    again.applyTransaction(tx)
    const secrets = again.txos()
      .map((utxo) => utxo.unblinded())
      .find((item) => item.asset().toString() === SWAP_ASSET)
    expect(secrets).toBeTruthy()
    expect(secrets.assetBlindingFactor().toString()).toBe(funded.paymentOutputSecrets.assetBlindingFactor)
    expect(secrets.valueBlindingFactor().toString()).toBe(funded.paymentOutputSecrets.valueBlindingFactor)
    expect(secrets.value()).toBe(SWAP_AMOUNT)
    again.free?.()
    manager.dispose()
  })

  test('rejects a confidential address this account cannot unblind', async () => {
    const { manager, account } = await fundedAccount()
    const otherNetwork = lwk.Network.regtestDefault()
    const other = new lwk.Signer(new lwk.Mnemonic(OTHER), otherNetwork)
    const otherWollet = new lwk.Wollet(otherNetwork, other.wpkhSlip77Descriptor())
    const foreign = receiveAddress(otherWollet, 0)
    const script = Buffer.from(foreign.scriptPubkey().bytes())

    await expect(account.fundLiquidPset(claimRequest({
      account,
      outputAddress: foreign.toString(),
      script
    }))).rejects.toThrow(/cannot unblind it.*key this wallet does not hold/s)

    otherWollet.free?.()
    other.free?.()
    otherNetwork.free?.()
    manager.dispose()
  })

  test('pays an unconfidential address with zero blinding factors', async () => {
    const { manager, account, policy } = await fundedAccount()
    const explicit = receiveAddress(account._wollet, 1).toUnconfidential()
    expect(explicit.isBlinded()).toBe(false)
    const script = Buffer.from(explicit.scriptPubkey().bytes())
    const funded = await account.fundLiquidPset(claimRequest({
      account,
      outputAddress: explicit.toString(),
      script,
      assetDisplay: policy,
      amount: 1_000n
    }))

    expect(funded.paymentOutputSecrets).toEqual({
      assetId: policy,
      value: '1000',
      assetBlindingFactor: lwk.AssetBlindingFactor.zero().toString(),
      valueBlindingFactor: lwk.ValueBlindingFactor.zero().toString()
    })
    manager.dispose()
  })
})
