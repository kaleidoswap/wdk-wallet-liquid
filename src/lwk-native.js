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

// React Native binding. `lwk-rn` (Blockstream) wraps LWK's UniFFI bindings as a
// JSI native module (via uniffi-bindgen-react-native), so it runs directly on
// Hermes — NO WebAssembly and NO bundler WASM support required (unlike `lwk_wasm`
// / `lwk_node`, which are wasm-bindgen builds Hermes cannot execute).
//
// Importing `lwk-rn` registers the Rust crate with Hermes and initializes the
// generated bindings (side effects in its index). It re-exports the same named
// LWK classes as the wasm builds (Network, Signer, Mnemonic, Wollet,
// WolletDescriptor, EsploraClient, Address, AssetId, TxBuilder, …), so we
// re-export the namespace as the default to match `import lwk from '#lwk'`.
//
// API note: the UniFFI binding's `Signer` exposes `sign(pset)`,
// `wpkhSlip77Descriptor()`, `keyoriginXpub(bip)` and `mnemonic()`, but NOT
// `signMessage()` / `getMasterXpub()`. LiquidAccount feature-detects those two
// (message signing + keyPair identifier) so the core wallet works regardless.
import * as lwk from 'lwk-rn'

export default lwk
