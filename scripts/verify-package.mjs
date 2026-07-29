#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('npm_execpath is unavailable; run this check through npm')

const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8'
})
if (result.status !== 0) throw new Error(result.stderr || `npm pack exited with ${result.status}`)

const manifest = JSON.parse(result.stdout)[0]
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (manifest.version !== pkg.version) {
  throw new Error(`Tarball version ${manifest.version} does not match package version ${pkg.version}`)
}

const files = new Set(manifest.files.map((entry) => entry.path))
const required = [
  'index.js',
  'types/index.d.ts',
  'src/liquid-account.js',
  'src/simplicity.js',
  'simplicity-bindings.json',
  'scripts/build-lwk-simplicity.mjs',
  'scripts/verify-package.mjs'
]
const missing = required.filter((file) => !files.has(file))
if (missing.length) throw new Error(`Release tarball is missing: ${missing.join(', ')}`)

console.log(`Verified ${manifest.filename} (${manifest.files.length} files)`)
