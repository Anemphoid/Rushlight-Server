// Account recovery keys. An account's only way back in after forgetting its password
// is this key, shown once. 12 words from a 2048 word list is 132 bits drawn from the
// system's secure random source, so only a SHA-256 of it is stored: a key this strong
// gains nothing from a slow hash, and bcrypt would cut a long key off at 72 bytes.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { RECOVERY_WORDS } from './recoverywords.js'

export const KEY_WORDS = 12
const WORD_SET = new Set(RECOVERY_WORDS)

export function generateRecoveryKey() {
  const words = []
  for (let i = 0; i < KEY_WORDS; i++) words.push(RECOVERY_WORDS[randomInt(RECOVERY_WORDS.length)])
  return words.join(' ')
}

// What a person types back may use any case, any spacing and dashes or commas between
// the words. Anything that isn't exactly 12 known words is not a key.
export function normalizeRecoveryKey(input) {
  if (typeof input !== 'string' || input.length > 400) return null
  const words = input.toLowerCase().split(/[\s,.\-_]+/).filter(Boolean)
  if (words.length !== KEY_WORDS || !words.every((w) => WORD_SET.has(w))) return null
  return words.join(' ')
}

export function hashRecoveryKey(normalizedKey) {
  return createHash('sha256').update(normalizedKey).digest('hex')
}

// True when `input` is the key whose hash is stored. A missing hash, a malformed key
// and a wrong key all give the same answer, after the same work.
export function recoveryKeyMatches(input, storedHash) {
  const normalized = normalizeRecoveryKey(input)
  const given = Buffer.from(hashRecoveryKey(normalized || 'not a key'), 'hex')
  const want = Buffer.from(storedHash || '0'.repeat(64), 'hex')
  return !!normalized && !!storedHash && given.length === want.length && timingSafeEqual(given, want)
}

// --- Keys made by the app (v0.22.0) ---
// The person's app makes the 12 words and the server never sees them. What the server keeps is `p1:` and a SHA-256 of a
// proof the app derives from the words (the same proof that lets a lost computer approve itself). A key made by an older
// server is a plain SHA-256 of the words and keeps working; its accounts move to the new kind when they make a new key.
export const PROOF_PREFIX = 'p1:'
export const isProofKey = (stored) => typeof stored === 'string' && stored.startsWith(PROOF_PREFIX)
export const storedProofKey = (proofHashHex) => PROOF_PREFIX + proofHashHex
const PROOF_SHAPE = /^[A-Za-z0-9_-]{43}$/

// True when `proof` (43 base64url characters) is the one whose SHA-256 is stored. Wrong, missing and malformed all take the
// same work and give the same answer.
export function proofMatches(proof, stored) {
  const ok = typeof proof === 'string' && PROOF_SHAPE.test(proof)
  const given = createHash('sha256').update(ok ? Buffer.from(proof, 'base64url') : Buffer.alloc(32)).digest()
  const want = Buffer.from(isProofKey(stored) ? stored.slice(PROOF_PREFIX.length) : '0'.repeat(64), 'hex')
  return ok && isProofKey(stored) && given.length === want.length && timingSafeEqual(given, want)
}

// One check for both kinds. A proof only ever matches an app-made key and words only an older one.
export function recoveryMatches(stored, { key, proof } = {}) {
  if (!stored) return false
  return isProofKey(stored) ? proofMatches(proof, stored) : recoveryKeyMatches(key, stored)
}
