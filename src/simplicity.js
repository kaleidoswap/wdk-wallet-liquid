// Copyright 2024 KaleidoSwap
// Licensed under the Apache License, Version 2.0

'use strict'

export const SIMPLICITY_API_VERSION = 'experimental-0.1'
export const SIMPLICITY_NUMS_INTERNAL_KEY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

export class SimplicityUnavailableError extends Error {
  constructor (feature) {
    super(`Simplicity feature is unavailable in the active LWK binding: ${feature}`)
    this.name = 'SimplicityUnavailableError'
    this.code = 'SIMPLICITY_UNAVAILABLE'
    this.feature = feature
  }
}

export function getBindingCapabilities (binding) {
  const prototype = binding.Wollet?.prototype
  const compile = typeof binding.SimplicityProgram?.load === 'function' &&
    typeof binding.SimplicityArguments === 'function'
  const derivePublicKey = typeof binding.simplicityDeriveXonlyPubkey === 'function'
  return {
    version: SIMPLICITY_API_VERSION,
    available: compile && derivePublicKey,
    pset: {
      inspect: typeof binding.Pset === 'function',
      blind: typeof prototype?.blind === 'function',
      sign: typeof binding.Signer?.prototype?.sign === 'function',
      finalize: typeof prototype?.finalize === 'function'
    },
    simplicity: {
      compile,
      derivePublicKey,
      finalizeTransaction: typeof binding.SimplicityProgram?.prototype?.finalizeTransaction === 'function'
    }
  }
}

export function requireBindingFeature (capabilities, path) {
  const available = path.split('.').reduce((value, key) => value?.[key], capabilities)
  if (available !== true) throw new SimplicityUnavailableError(path)
}

export function toSimplicityValue (binding, argument) {
  const value = argument.value
  switch (argument.type) {
    case 'u8': return binding.SimplicityTypedValue.fromU8(assertNumber(value, 0xff, 'u8'))
    case 'u16': return binding.SimplicityTypedValue.fromU16(assertNumber(value, 0xffff, 'u16'))
    case 'u32': return binding.SimplicityTypedValue.fromU32(assertNumber(value, 0xffffffff, 'u32'))
    case 'u64': return binding.SimplicityTypedValue.fromU64(assertU64(value))
    case 'u128': return binding.SimplicityTypedValue.fromU128Hex(assertHex(value, 'u128', 32))
    case 'u256': return binding.SimplicityTypedValue.fromU256Hex(assertHex(value, 'u256', 64))
    case 'bool':
      if (typeof value !== 'boolean') throw new TypeError('Simplicity bool must be a boolean')
      return binding.SimplicityTypedValue.fromBoolean(value)
    case 'bytes': return binding.SimplicityTypedValue.fromByteArrayHex(assertHex(value, 'bytes'))
    default: throw new TypeError(`Unsupported Simplicity argument type: ${argument.type}`)
  }
}

function assertNumber (value, maximum, type) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`Simplicity ${type} must be an unsigned integer no greater than ${maximum}`)
  }
  return value
}

function assertU64 (value) {
  let integer
  try { integer = BigInt(value) } catch { throw new TypeError('Simplicity u64 must be an integer') }
  if (integer < 0n || integer > 0xffffffffffffffffn) {
    throw new RangeError('Simplicity u64 is outside its unsigned 64-bit range')
  }
  return integer
}

function assertHex (value, type, length) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0 || (length && value.length !== length)) {
    throw new TypeError(`Simplicity ${type} must be ${length ? `${length} characters of ` : 'even-length '}hex`)
  }
  return value
}

export function buildSimplicityArguments (binding, values = []) {
  let args = new binding.SimplicityArguments()
  for (const value of values) {
    if (!value || typeof value.name !== 'string' || value.name.length === 0) {
      throw new TypeError('Every Simplicity argument requires a name')
    }
    args = args.addValue(value.name, toSimplicityValue(binding, value))
  }
  return args
}

export function signatureCount (value) {
  if (value == null) return 0
  if (Array.isArray(value)) return value.length
  if (typeof value[Symbol.iterator] === 'function') return Array.from(value).length
  if (typeof value === 'object') return Object.keys(value).length
  return 0
}
