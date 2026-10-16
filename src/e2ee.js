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

// --- Encrypted pictures ---
// The client seals the picture with a key of its own and puts that key, the type and the size inside the
// sealed message text, so the server learns nothing about the picture but its length. The upload is one body:
//   4 bytes  length of the message text (big endian)
//   N bytes  the sealed message text (rl1.<epoch>.<nonce>.<ciphertext>, ASCII)
//   rest     the sealed picture: a 12 byte nonce, then the ciphertext with its 16 byte tag
export const SEALED_IMAGE_MIME = 'application/x-rushlight-sealed'
export const SEALED_IMAGE_OVERHEAD = 4 + MAX_ENCRYPTED_TEXT + 12 + 16

// Returns { text, epoch, sealed } or null if the body is not shaped like that.
export function parseSealedImage(buffer, maxPictureBytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 + 1 + 12 + 16 + 1) return null
  const n = buffer.readUInt32BE(0)
  if (n < 1 || n > MAX_ENCRYPTED_TEXT || 4 + n + 12 + 16 + 1 > buffer.length) return null
  const text = buffer.subarray(4, 4 + n).toString('latin1')
  const parsed = parseEncryptedText(text)
  if (!parsed) return null
  const sealed = buffer.subarray(4 + n)
  if (sealed.length > maxPictureBytes + 12 + 16) return null
  return { text, epoch: parsed.epoch, sealed }
}

// --- Keys carried by join codes ---
// An invite to an encrypted server is the visible code plus a secret half the server never sees. The creating app
// seals the keys the joiner needs (the server keys for a whole-server invite, the voice keys of one room for a guest
// invite) under that secret; the server keeps the sealed package and gives it to whoever presents the code. A second
// blob, the secret sealed to the server key, lets any admin's app show the full code and add new epochs' keys to the
// package. The server cannot open either.
export const MAX_CODE_PACKAGE = 8192
const CODE_PACKAGE = /^rlp1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/
const CODE_SECRET = /^rlc1\.(\d{1,9})\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/

export function cleanCodePackage(value) {
  return typeof value === 'string' && value.length <= MAX_CODE_PACKAGE && CODE_PACKAGE.test(value) ? value : null
}

// Returns { value, epoch } (the server key epoch it is sealed to) or null.
export function cleanCodeSecret(value) {
  if (typeof value !== 'string' || value.length > 1024) return null
  const m = CODE_SECRET.exec(value)
  return m && Number(m[1]) >= 1 ? { value, epoch: Number(m[1]) } : null
}
