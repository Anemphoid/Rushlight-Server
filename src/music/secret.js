// The Jellyfin token is the only secret the music link stores. It is encrypted with a key derived
// from the server's own secret (MUSIC_SECRET if set, else JWT_SECRET), so a copied database file
// alone does not reveal it. It is never logged and never sent to a client.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

function key() {
  const base = process.env.MUSIC_SECRET || process.env.JWT_SECRET
  if (!base) throw new Error('JWT_SECRET (or MUSIC_SECRET) must be set')
  return Buffer.from(hkdfSync('sha256', base, 'rushlight-music', 'jellyfin-token-v1', 32))
}

export function sealToken(token) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

// null when the value cannot be opened (the secret changed, or the row was edited).
export function openToken(sealed) {
  try {
    const raw = Buffer.from(sealed, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
