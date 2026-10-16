// End-to-end encryption helpers. The server never holds a key it could read a message with: it checks
// that what it is handed has the right shape, stores it, and hands it back. Nothing here decrypts.
import { createECDH } from 'node:crypto'

// The oldest client that may use a server with encryption on. Older ones would show ciphertext as
// text. The client sends its version in X-Rushlight-Client. Overridable for tests.
export const MIN_E2EE_CLIENT = process.env.E2EE_MIN_CLIENT || '0.22.0'

export const MAX_ACTIVE_DEVICES = 10
export const MAX_ENCRYPTED_TEXT = 12000 // 4000 characters of text, as UTF-8, sealed and written in base64url
const B64URL = /^[A-Za-z0-9_-]+$/

// "1.2.3" or "v1.2.3" -> [1, 2, 3], or null.
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(value.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function clientIsRecentEnough(header, min = MIN_E2EE_CLIENT) {
  const have = parseVersion(header)
  const need = parseVersion(min)
  if (!have || !need) return false
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i]
  }
  return true
}

// A device's public key: an uncompressed P-256 point (65 bytes), base64url. It must really be a point
// on the curve, so a made-up string can never be wrapped to. Returns the cleaned string or null.
export function cleanPublicKey(value) {
  if (typeof value !== 'string' || value.length !== 87 || !B64URL.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 65 || bytes[0] !== 0x04) return null
  try {
    // computeSecret throws for a point that is not on the curve
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    ecdh.computeSecret(bytes)
  } catch {
    return null
  }
  return Buffer.from(bytes).toString('base64url')
}

// A wrapped key, as the client made it: opaque to the server, only its size and alphabet are checked.
export function cleanEnvelopeData(value) {
  if (typeof value !== 'string' || value.length < 40 || value.length > 1024 || !B64URL.test(value)) return null
  return value
}

// An encrypted message body: rl1.<epoch>.<nonce>.<ciphertext>, the last two base64url (12 byte nonce,
// then the sealed text with its 16 byte tag). Returns { epoch } or null.
const MESSAGE_ENVELOPE = /^rl1\.(\d{1,9})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/
export function parseEncryptedText(text) {
  if (typeof text !== 'string' || text.length > MAX_ENCRYPTED_TEXT) return null
  const m = MESSAGE_ENVELOPE.exec(text)
  if (!m) return null
  const epoch = Number(m[1])
  return epoch >= 1 ? { epoch } : null
}
