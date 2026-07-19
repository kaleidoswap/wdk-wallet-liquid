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

  test('_run serializes overlapping operations (no re-entrant Wollet access)', async () => {
    // lwk's Wollet panics ("recursive use of an object … unsafe aliasing in
    // rust") if a second op borrows it while the first is still awaiting. `_run`
    // must queue ops so they never overlap, even when fired concurrently.
    const account = new LiquidAccount({ mnemonic: SEED })
    let inFlight = 0
    let maxConcurrent = 0
    const order = []
    const op = (id) => account._run(async () => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await Promise.resolve() // yield — overlapping callers would collide here
      await Promise.resolve()
      inFlight--
      order.push(id)
      return id
    })

    const results = await Promise.all([op('a'), op('b'), op('c')])

    expect(maxConcurrent).toBe(1) // never more than one op touching the wallet
    expect(order).toEqual(['a', 'b', 'c']) // FIFO
    expect(results).toEqual(['a', 'b', 'c'])
  })

  test('_run keeps the queue alive after a failing operation', async () => {
    const account = new LiquidAccount({ mnemonic: SEED })
    await expect(account._run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // A rejection must not wedge the chain — the next op still runs.
    await expect(account._run(async () => 'ok')).resolves.toBe('ok')
  })

  test('_sync coalesces scans within the freshness window (force uses a shorter one)', async () => {
    // A burst of reads (balance + assets + address) must share ONE Esplora scan,
    // not trigger one each — otherwise, with ops serialized, N back-to-back scans
    // blow the caller's timeout. Forced syncs (refresh, send prep) honor a much
    // shorter window so a refresh fan-out doesn't run several scans in a row.
    const account = new LiquidAccount({ mnemonic: SEED })
    account._ensureReady()
    let scans = 0
    account._esplora = { fullScan: async () => { scans++; return null } } // offline stub

    await account._sync() // cold — scans
    await account._sync() // fresh — reused
    await account._sync(true) // forced, but scan just completed — reused
    expect(scans).toBe(1)

    account._lastSyncAt = Date.now() - 5_000 // older than the force window, fresher than the TTL
    await account._sync() // regular read — still fresh, reused
    expect(scans).toBe(1)
    await account._sync(true) // forced — stale for a force, scans again
    expect(scans).toBe(2)

    account.dispose()
  })

  test('getNetworkInfo is a cheap status read — never triggers a scan', async () => {
    const account = new LiquidAccount({ mnemonic: SEED })
    account._ensureReady()
    let scans = 0
    account._esplora = { fullScan: async () => { scans++; return null } }

    const info = await account.getNetworkInfo()
    expect(info.network).toBeTruthy()
    expect(info.policy_asset).toMatch(/^[0-9a-f]{64}$/)
    expect(info.address.startsWith('tlq')).toBe(true)
    expect(info.tip_height).toBe(0) // genesis — never scanned (lwk reports 0, not an error)
    expect(scans).toBe(0)

    account.dispose()
  })

  test('a wedged fullScan times out and the account rebuilds itself', async () => {
    const account = new LiquidAccount({ mnemonic: SEED, scanTimeoutMs: 50 })
    account._ensureReady()
    account._esplora = { fullScan: () => new Promise(() => {}) } // hangs forever

    // The watchdog frees the queue instead of wedging every future read.
    await expect(account.getBalance()).rejects.toThrow(/timed out/)

    // The graph was orphaned; the next op rebuilds fresh LWK objects and works.
    expect(account._ready).toBe(false)
    const info = await account.getNetworkInfo()
    expect(info.address.startsWith('tlq')).toBe(true)
    expect(account._ready).toBe(true)

    account.dispose()
  })

  test("transfer + sendAsset survive lwk's consuming TxBuilder chain", async () => {
    // Every lwk TxBuilder method moves `self` (wasm-bindgen) and returns a
    // fresh builder; touching the consumed one throws "null pointer passed to
    // rust". Model that exactly and stub the sign/broadcast pipeline so the
    // send paths run offline. Regression for the real on-device failure.
    const account = new LiquidAccount({ mnemonic: SEED })
    account._ensureReady()
    const addr = await account.getAddress()
    const state = { recipients: [], feeRates: [], drainWallet: 0, drainTo: 0 }
    function makeBuilder () {
      let dead = false
      const consume = () => {
        if (dead) throw new Error('null pointer passed to rust')
        dead = true
      }
      return {
        addLbtcRecipient (_a, sats) { consume(); state.recipients.push({ sats }); return makeBuilder() },
        addRecipient (_a, sats, asset) { consume(); state.recipients.push({ sats, asset: String(asset) }); return makeBuilder() },
        drainLbtcWallet () { consume(); state.drainWallet++; return makeBuilder() },
        drainLbtcTo (_a) { consume(); state.drainTo++; return makeBuilder() },
        feeRate (r) { consume(); state.feeRates.push(r); return makeBuilder() },
        finish () { consume(); return { fake: 'pset' } }
      }
    }
    account._network.txBuilder = () => makeBuilder()
    // A partial-amount send must use addLbtcRecipient, not drain — give the
    // wallet an L-BTC balance well above the 1000 sat sent below.
    account._network.policyAsset = () => ({ toString: () => 'lbtc' })
    account._wollet.balance = () => new Map([['lbtc', 1_000_000n]])
    account._wollet.psetDetails = () => ({ balance: () => ({ fee: () => 250 }) })
    account._signer.sign = (pset) => pset
    account._wollet.finalize = (pset) => pset
    account._esplora = { fullScan: async () => null, broadcast: async () => 'txid-stub' }

    account._lastSyncAt = Date.now() // fresh — the forced pre-send scan is skipped
    const btc = await account.transfer({ recipient: addr, amount: 1000n })
    expect(btc).toEqual({ hash: 'txid-stub', fee: 250n })
    expect(state.drainWallet).toBe(0) // partial amount → no drain

    account._lastSyncAt = Date.now()
    const asset = await account.sendAsset({
      assetId: 'deadbeef'.repeat(8),
      recipient: addr,
      amount: 5,
      feeRate: 100
    })
    expect(asset).toEqual({ hash: 'txid-stub', fee: 250n })
    expect(state.recipients).toHaveLength(2)
    expect(state.feeRates).toEqual([100]) // only the explicit sendAsset feeRate

    account.dispose()
  })

  test('waterfalls config is stored and defaults to off', () => {
    const off = new LiquidAccount({ mnemonic: SEED })
    expect(off._waterfalls).toBe(false)
    expect(off._allowDefaultEsploraFallback).toBe(false)
    expect(off._waterfallsRecipient).toBeNull()

    const on = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true,
      allowDefaultEsploraFallback: true,
      waterfallsRecipient: 'recipient-key'
    })
    expect(on._waterfalls).toBe(true)
    expect(on._allowDefaultEsploraFallback).toBe(true)
    expect(on._waterfallsRecipient).toBe('recipient-key')
  })

  test('LiquidWalletManager forwards waterfalls options to the account', async () => {
    const onWarning = () => {}
    const wallet = new LiquidWalletManager(SEED, {
      esploraUrl: 'https://waterfalls.example/liquidtestnet/api',
      waterfalls: true,
      allowDefaultEsploraFallback: true,
      waterfallsRecipient: 'rk',
      onWarning
    })
    const account = await wallet.getAccount(0)
    expect(account._waterfalls).toBe(true)
    expect(account._allowDefaultEsploraFallback).toBe(true)
    expect(account._waterfallsRecipient).toBe('rk')
    expect(account._onWarning).toBe(onWarning)
    wallet.dispose()
  })

  test('falls back to the default Esplora scan and emits a recoverable warning when Waterfalls fails', async () => {
    const warnings = []
    const account = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true,
      allowDefaultEsploraFallback: true,
      onWarning: warning => warnings.push(warning)
    })
    account._ensureReady()

    let waterfallsScans = 0
    let fallbackScans = 0
    const waterfallsClient = {
      fullScan: async () => {
        waterfallsScans++
        throw new Error('waterfalls unavailable')
      }
    }
    const fallbackClient = {
      fullScan: async () => {
        fallbackScans++
        return null
      }
    }
    account._esplora = waterfallsClient
    account._network.defaultEsploraClient = () => fallbackClient

    await expect(account._sync(true)).resolves.toBeUndefined()

    expect(waterfallsScans).toBe(1)
    expect(fallbackScans).toBe(1)
    expect(account._waterfalls).toBe(false)
    expect(account._esploraUrl).toBeNull()
    expect(warnings).toEqual([{
      code: 'LIQUID_WATERFALLS_FALLBACK',
      message: 'Liquid Waterfalls failed; using standard Esplora fallback.',
      details: { reason: 'waterfalls_failed' }
    }])
    account.dispose()
  })

  test('falls back when Waterfalls recipient setup fails before scanning', async () => {
    const warnings = []
    const account = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true,
      allowDefaultEsploraFallback: true,
      waterfallsRecipient: 'recipient-key',
      onWarning: warning => warnings.push(warning)
    })
    account._ensureReady()

    let fallbackScans = 0
    account._esplora = {
      setWaterfallsServerRecipient: async () => { throw new Error('recipient setup unavailable') },
      fullScan: async () => { throw new Error('must not scan Waterfalls after setup failure') }
    }
    account._network.defaultEsploraClient = () => ({
      fullScan: async () => { fallbackScans++; return null }
    })

    await expect(account._sync(true)).resolves.toBeUndefined()
    expect(fallbackScans).toBe(1)
    expect(warnings).toEqual([expect.objectContaining({
      code: 'LIQUID_WATERFALLS_FALLBACK',
      details: { reason: 'waterfalls_failed' }
    })])
    account.dispose()
  })

  test('rebuilds after a Waterfalls timeout and falls back exactly once', async () => {
    const warnings = []
    const account = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true,
      allowDefaultEsploraFallback: true,
      scanTimeoutMs: 20,
      onWarning: warning => warnings.push(warning)
    })
    account._ensureReady()

    let waterfallsScans = 0
    let fallbackScans = 0
    const fallbackClient = {
      fullScan: async () => { fallbackScans++; return null }
    }
    account._esplora = {
      fullScan: async () => {
        waterfallsScans++
        return new Promise(() => {})
      }
    }
    const originalEnsureReady = account._ensureReady.bind(account)
    account._ensureReady = function () {
      if (this._ready) return
      this._ready = true
      this._network = { defaultEsploraClient: () => fallbackClient }
      this._esplora = fallbackClient
      this._wollet = { applyUpdate: () => {} }
    }

    await expect(account._sync(true)).resolves.toBeUndefined()
    expect(waterfallsScans).toBe(1)
    expect(fallbackScans).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('LIQUID_WATERFALLS_FALLBACK')
    account._ensureReady = originalEnsureReady
  })

  test('reports both failures and does not emit a recovery warning when the Esplora fallback also fails', async () => {
    const warnings = []
    const account = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true,
      allowDefaultEsploraFallback: true,
      onWarning: warning => warnings.push(warning)
    })
    account._ensureReady()

    const waterfallsError = new Error('waterfalls unavailable')
    const fallbackError = new Error('fallback unavailable')
    account._esplora = {
      fullScan: async () => { throw waterfallsError }
    }
    account._network.defaultEsploraClient = () => ({
      fullScan: async () => { throw fallbackError }
    })

    let thrown
    try {
      await account._sync(true)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown.message).toBe(
      'Liquid Waterfalls failed; standard Esplora fallback failed'
    )
    expect(thrown.errors).toEqual([waterfallsError, fallbackError])
    expect(warnings).toEqual([])
    account.dispose()
  })

  test('preserves the Waterfalls failure when constructing the fallback client also fails', async () => {
    const account = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true,
      allowDefaultEsploraFallback: true
    })
    account._ensureReady()

    const waterfallsError = new Error('waterfalls unavailable')
    const fallbackError = new Error('cannot construct default client')
    account._esplora = {
      fullScan: async () => { throw waterfallsError }
    }
    account._network.defaultEsploraClient = () => { throw fallbackError }

    let thrown
    try {
      await account._sync(true)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown.errors).toEqual([waterfallsError, fallbackError])

    // A failed transition must invalidate the original Waterfalls client. The
    // next attempt rebuilds a standard client instead of scanning it again.
    expect(account._ready).toBe(false)
    let fallbackScans = 0
    account._ensureReady = function () {
      if (this._ready) return
      this._ready = true
      this._esplora = { fullScan: async () => { fallbackScans++; return null } }
      this._wollet = { applyUpdate: () => {} }
    }
    await expect(account._sync(true)).resolves.toBeUndefined()
    expect(fallbackScans).toBe(1)
    account.dispose()
  })

  test('requires an explicit URL when Waterfalls is enabled', () => {
    expect(() => new LiquidAccount({
      mnemonic: SEED,
      waterfalls: true
    })).toThrow('LiquidAccount: waterfalls requires config.esploraUrl')
  })

  test('does not treat truthy non-boolean values as fallback consent', async () => {
    const account = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true,
      allowDefaultEsploraFallback: 'false'
    })
    account._ensureReady()
    const waterfallsError = new Error('waterfalls unavailable')
    account._esplora = { fullScan: async () => { throw waterfallsError } }
    let fallbackClients = 0
    account._network.defaultEsploraClient = () => {
      fallbackClients++
      return { fullScan: async () => null }
    }

    await expect(account._sync(true)).rejects.toBe(waterfallsError)
    expect(fallbackClients).toBe(0)
    expect(account._waterfalls).toBe(true)
    account.dispose()
  })

  test('does not change providers unless default-Esplora fallback is explicitly allowed', async () => {
    const account = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true
    })
    account._ensureReady()
    const waterfallsError = new Error('waterfalls unavailable')
    account._esplora = { fullScan: async () => { throw waterfallsError } }
    let fallbackClients = 0
    account._network.defaultEsploraClient = () => {
      fallbackClients++
      return { fullScan: async () => null }
    }

    await expect(account._sync(true)).rejects.toBe(waterfallsError)
    expect(fallbackClients).toBe(0)
    expect(account._waterfalls).toBe(true)
    account.dispose()
  })

  test.each([
    ['synchronous throw', () => { throw new Error('sync callback failure') }],
    ['rejected promise', async () => { throw new Error('async callback failure') }]
  ])('warning callback %s does not disrupt a recovered sync', async (_label, onWarning) => {
    const account = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true,
      allowDefaultEsploraFallback: true,
      onWarning
    })
    account._ensureReady()
    account._esplora = { fullScan: async () => { throw new Error('waterfalls unavailable') } }
    account._network.defaultEsploraClient = () => ({ fullScan: async () => null })

    await expect(account._sync(true)).resolves.toBeUndefined()
    // Let a rejected callback Promise reach its attached catch handler.
    await Promise.resolve()
    account.dispose()
  })

  test('the descriptor recipient key is applied to the scan client exactly once', async () => {
    // In waterfalls mode with a recipient key, the descriptor must be encrypted
    // before it is sent — setWaterfallsServerRecipient is applied lazily in _sync
    // (it's async, so it can't live in the synchronous _ensureReady) and only once
    // per client, not on every scan.
    const account = new LiquidAccount({
      mnemonic: SEED,
      esploraUrl: 'https://waterfalls.example/liquid/api',
      waterfalls: true,
      waterfallsRecipient: 'recipient-key'
    })
    account._ensureReady()
    let recipientCalls = 0
    let scans = 0
    account._esplora = {
      setWaterfallsServerRecipient: async () => { recipientCalls++ },
      fullScan: async () => { scans++; return null }
    }

    await account._sync(true)
    account._lastSyncAt = 0 // force a second scan past the freshness window
    await account._sync(true)

    expect(scans).toBe(2)
    expect(recipientCalls).toBe(1)
    account.dispose()
  })

  test('no recipient key is set when waterfalls is off or the key is absent', async () => {
    // Standard esplora mode (or waterfalls without a key) must never call the
    // waterfalls-only recipient setter.
    const account = new LiquidAccount({ mnemonic: SEED })
    account._ensureReady()
    let recipientCalls = 0
    account._esplora = {
      setWaterfallsServerRecipient: async () => { recipientCalls++ },
      fullScan: async () => null
    }
    await account._sync(true)
    expect(recipientCalls).toBe(0)
    account.dispose()
  })

  test('transfer of the full L-BTC balance drains (fee deducted, not added on top)', async () => {
    // addLbtcRecipient(fullBalance) would add the fee ON TOP → lwk "Insufficient
    // funds: missing <fee> units for asset <L-BTC>". Sending the entire balance
    // must drain instead (drainLbtcWallet + drainLbtcTo), which nets out the fee.
    const account = new LiquidAccount({ mnemonic: SEED })
    account._ensureReady()
    const addr = await account.getAddress()
    const calls = { addLbtc: 0, drainWallet: 0, drainTo: 0 }
    function makeBuilder () {
      let dead = false
      const consume = () => { if (dead) throw new Error('null pointer passed to rust'); dead = true }
      return {
        addLbtcRecipient () { consume(); calls.addLbtc++; return makeBuilder() },
        drainLbtcWallet () { consume(); calls.drainWallet++; return makeBuilder() },
        drainLbtcTo () { consume(); calls.drainTo++; return makeBuilder() },
        feeRate () { consume(); return makeBuilder() },
        finish () { consume(); return { fake: 'pset' } }
      }
    }
    account._network.txBuilder = () => makeBuilder()
    account._network.policyAsset = () => ({ toString: () => 'lbtc' })
    account._wollet.balance = () => new Map([['lbtc', 5_000n]])
    account._wollet.psetDetails = () => ({ balance: () => ({ fee: () => 42 }) })
    account._signer.sign = (pset) => pset
    account._wollet.finalize = (pset) => pset
    account._esplora = { fullScan: async () => null, broadcast: async () => 'txid-max' }

    account._lastSyncAt = Date.now()
    const res = await account.transfer({ recipient: addr, amount: 5_000n }) // == full balance
    expect(res).toEqual({ hash: 'txid-max', fee: 42n })
    expect(calls.drainWallet).toBe(1)
    expect(calls.drainTo).toBe(1)
    expect(calls.addLbtc).toBe(0) // never the fee-on-top path

    account.dispose()
  })

  test('listAssets materializes a non-array (Map) Balance.entries()', async () => {
    // lwk's `Balance.entries()` is an *iterable* of [asset, value] pairs, not a
    // plain array — it has no `.map`. Regression guard: listAssets must use
    // Array.from (spreading the iterable), not `.entries().map(...)`.
    const account = new LiquidAccount({ mnemonic: SEED })
    account._ready = true // bypass real lwk init
    account._esplora = { fullScan: async () => null }
    account._wollet = { balance: () => new Map([['assetA', 100n], ['assetB', 5n]]) }

    const assets = await account.listAssets()
    expect(assets).toEqual([
      { asset_id: 'assetA', balance: '100' },
      { asset_id: 'assetB', balance: '5' }
    ])
  })
})
