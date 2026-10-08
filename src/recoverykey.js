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
