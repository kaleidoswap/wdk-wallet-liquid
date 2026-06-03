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

// Browser binding. `lwk_wasm` is the wasm-bindgen `--target bundler` build:
// the bundler (Vite/webpack) instantiates the WASM during module load, so the
// classes are ready by the time consuming code runs — there is no async init
// step. Unlike `lwk_node`, it exposes only NAMED exports (no default), so we
// re-export the namespace as the default to match `import lwk from '#lwk'`.
//
// NB: the consumer's bundler must support WebAssembly ESM imports. For Vite,
// add `vite-plugin-wasm` (+ `vite-plugin-top-level-await`); for webpack 5,
// enable `experiments.asyncWebAssembly`.
import * as lwk from 'lwk_wasm'

export default lwk
