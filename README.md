# @kaleidorg/wdk-wallet-liquid

WDK wallet adapter for the **Liquid** network. Wraps an in-process
[LWK (Liquid Wallet Kit)](https://github.com/Blockstream/lwk) wallet in the
[WDK](https://github.com/tetherto/wdk) account model — no external daemon
required.

It is the wallet foundation for KaleidoSwap's native Liquid DEX
(L-BTC ↔ USDt-Liquid swaps).

## Install

```sh
npm install @kaleidorg/wdk-wallet-liquid @tetherto/wdk-wallet
```

`@tetherto/wdk-wallet` is a peer dependency.

### LWK binding (Node / browser / React Native)

The package transparently selects the right LWK build via the package
[`imports`](https://nodejs.org/api/packages.html#imports) map (`#lwk`):

| Environment             | Binding                                                       | Notes                                                                          |
|-------------------------|--------------------------------------------------------------|--------------------------------------------------------------------------------|
| Node / Bare (default)   | [`lwk_node`](https://www.npmjs.com/package/lwk_node)         | wasm-bindgen `--target nodejs`; self-instantiates, no flags needed.            |
| Browser (`browser`)     | [`lwk_wasm`](https://www.npmjs.com/package/lwk_wasm)         | wasm-bindgen `--target bundler`; optional peer dependency.                     |
| React Native (`react-native`) | [`lwk-rn`](https://www.npmjs.com/package/lwk-rn)       | Blockstream's UniFFI→JSI native module — runs on Hermes, **no WASM**. Optional peer. |

`lwk_node` ships as a regular dependency, so Node usage is zero-config.

For **browser/bundler** usage (e.g. a Chrome MV3 extension service worker),
install `lwk_wasm` explicitly and ensure your bundler can import WebAssembly
as an ES module:

```sh
npm install lwk_wasm
```

- **Vite:** add [`vite-plugin-wasm`](https://www.npmjs.com/package/vite-plugin-wasm)
  and [`vite-plugin-top-level-await`](https://www.npmjs.com/package/vite-plugin-top-level-await).
- **webpack 5:** enable `experiments.asyncWebAssembly`.

For **React Native** (Hermes has no WebAssembly engine), install the native
binding and let Metro pick the `react-native` condition:

```sh
npm install lwk-rn   # requires a config-plugin / pod + gradle native build
```

Ensure your Metro config resolves the `react-native` export condition
(`resolver.unstable_conditionNames = ['react-native', 'require', 'import']`).
The `lwk-rn` `Signer` lacks `signMessage()` / `getMasterXpub()`; `LiquidAccount`
feature-detects those (message signing throws on RN; `keyPair` falls back to the
key-origin fingerprint), so the core wallet works unchanged.

There is **no async init step** — the bundler instantiates the WASM during
module load, so the API is identical to the Node path. (The `lwk_wasm` bundle
is ~10 MB; mind cold-start in constrained contexts.)

### Experimental Simplicity binding

The published `lwk_wasm` package does not include LWK's optional Simplicity
feature. This repository therefore pins the exact LWK fork and commit used by
Humid in [`simplicity-bindings.json`](./simplicity-bindings.json). Build the
browser artifact with:

```sh
npm run build:lwk-simplicity
npm install ./artifacts/lwk_wasm_simplicity
```

CI runs the same build on Linux and uploads the generated package plus a
SHA-256 build manifest. The build is intentionally not performed during
`npm install`; hosts must opt into the experimental binding. Runtime APIs use
feature detection and return an unavailable capability result when a normal
LWK package or the React Native binding is active.

## Architecture

Liquid keys live in-process. LWK provides a watch-only Confidential
Transaction (CT) descriptor wallet (`Wollet`) plus a software `Signer`
derived from a BIP-39 mnemonic. Esplora is the chain backend used for
scanning and broadcasting.

The SLIP-77 CT descriptor covers every address, so there is a single logical
account — `getAccount(index)` always returns the same `LiquidAccount`.

## Usage

```js
import LiquidWalletManager from '@kaleidorg/wdk-wallet-liquid'

const wallet = new LiquidWalletManager(mnemonic, { network: 'testnet' })
const account = await wallet.getAccount()

await account.getAddress()                 // next CT receive address
await account.getBalance()                 // L-BTC balance (satoshis, bigint)
await account.getTokenBalance(assetId)      // any Liquid asset balance

await account.transfer({ recipient, amount, feeRate })
await account.sendAsset({ assetId, recipient, amount, feeRate })

await account.listAssets()
await account.listUnspents()
await account.listTransactions()

const capabilities = account.getSimplicityCapabilities()
if (capabilities.simplicity.compile) {
  const contract = await account.compileSimplicityProgram({
    source: simplicityHlSource,
    arguments: [{ name: 'PUBLIC_KEY', type: 'u256', value: xOnlyPublicKey }],
  })
  console.log(contract.cmr, contract.address)
}

// External PSET signing can be constrained to reviewed inputs. The call fails
// closed if the underlying signer adds a signature outside this allowlist.
const review = await account.inspectPset(psetBase64)
const signed = await account.signPset({ pset: review.pset, inputIndexes: [0] })

wallet.dispose()
```

### Config

| Option       | Default     | Description                                       |
|--------------|-------------|---------------------------------------------------|
| `network`    | `'testnet'` | `'mainnet'`, `'testnet'` or `'regtest'`.          |
| `esploraUrl` | network default | Esplora API base URL.                         |
| `mnemonic`   | —           | Required only when the seed is passed as bytes.   |

## Test

```sh
npm test
```

Offline operations (key derivation, address generation, message signing) are
exercised against the real `lwk_node` WASM; balance and transfer paths require
a funded testnet wallet and are verified manually.

## License

Apache-2.0
