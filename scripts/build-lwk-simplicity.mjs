#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await readFile(join(root, 'simplicity-bindings.json'), 'utf8'))
const outDir = resolve(process.env.LWK_SIMPLICITY_OUT_DIR ?? join(root, 'artifacts/lwk_wasm_simplicity'))
const suppliedSource = process.env.LWK_SIMPLICITY_SOURCE_DIR
const temporary = suppliedSource ? null : await mkdtemp(join(tmpdir(), 'lwk-simplicity-'))
const source = resolve(suppliedSource ?? join(temporary, 'lwk'))

function run (command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

function capture (command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with status ${result.status}`)
  return result.stdout.trim()
}

try {
  if (platform() === 'darwin') {
    const compiler = process.env.CC_wasm32_unknown_unknown ?? process.env.CC ?? 'clang'
    const targets = spawnSync(compiler, ['--print-targets'], { encoding: 'utf8' })
    if (targets.status !== 0 || !/\bwasm32\b/.test(targets.stdout)) {
      throw new Error(
        'The selected clang has no wasm32 backend. Install LLVM (for example with Homebrew) ' +
        'and set CC_wasm32_unknown_unknown to its clang binary, or run the Linux CI workflow.'
      )
    }
  }
  if (!suppliedSource) {
    run('git', ['clone', '--filter=blob:none', '--no-checkout', config.repository, source])
    run('git', ['checkout', '--detach', config.commit], { cwd: source })
  }

  const actualCommit = capture('git', ['rev-parse', 'HEAD'], { cwd: source })
  if (actualCommit !== config.commit) throw new Error(`Expected LWK ${config.commit}, got ${actualCommit}`)

  run('rustup', ['toolchain', 'install', config.rustToolchain, '--profile', 'minimal'])
  run('rustup', ['target', 'add', 'wasm32-unknown-unknown', '--toolchain', config.rustToolchain])
  await rm(outDir, { recursive: true, force: true })
  run(
    'rustup',
    [
      'run', config.rustToolchain, 'wasm-pack', 'build', '--release',
      '--target', config.target,
      '--out-dir', outDir,
      '--locked',
      '--features', config.features.join(',')
    ],
    { cwd: join(source, config.crateDirectory) }
  )

  const declarationsPath = join(outDir, 'lwk_wasm.d.ts')
  const declarations = await readFile(declarationsPath, 'utf8')
  const requiredSymbols = [
    'SimplicityProgram',
    'SimplicityArguments',
    'SimplicityTypedValue',
    'simplicityDeriveXonlyPubkey',
    'blind(pset'
  ]
  const missing = requiredSymbols.filter((symbol) => !declarations.includes(symbol))
  if (missing.length) throw new Error(`Generated binding is missing: ${missing.join(', ')}`)

  const wasmPath = join(outDir, 'lwk_wasm_bg.wasm')
  const sha256 = createHash('sha256').update(await readFile(wasmPath)).digest('hex')
  await writeFile(
    join(outDir, 'simplicity-build.json'),
    `${JSON.stringify({ ...config, sha256 }, null, 2)}\n`
  )
  console.log(`Simplicity-enabled lwk_wasm built at ${outDir}`)
  console.log(`lwk_wasm_bg.wasm sha256 ${sha256}`)
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true })
}
