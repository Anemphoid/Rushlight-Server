import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is not set. Put a long random string in .env (see .env.example) before starting the server.'
  )
}

// The async forms yield between rounds, so one login doesn't freeze the whole
// server (and everyone's presence check-ins) for the length of a hash.
export function hashPassword(password) {
  return bcrypt.hash(password, 12)
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash)
}

// A login for a username that doesn't exist still does a full hash compare, so
// the response time doesn't reveal which usernames are real.
const DUMMY_HASH = bcrypt.hashSync('rushlight-timing-equalizer', 12)
export function verifyAgainstNobody(password) {
  return bcrypt.compare(password, DUMMY_HASH)
}

export function signSession(account) {
  return jwt.sign(
    {
      sub: account.id,
      username: account.username,
      isAdmin: !!account.is_admin,
      ep: account.session_epoch || 0 // see session_epoch in migration 9
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  )
}

// Guests (joined with a code, no account) get a narrow token: it only says
// "this person was let into this one server". It can ask for voice access to
// that server's rooms and nothing else.
// codeId ties the guest to the join code they used, so revoking that code cuts
// them off. The token also never outlives the code's own expiry.
export function signGuest({ serverId, screenName, identity, codeId, expiresInSeconds }) {
  return jwt.sign({ guest: true, serverId, screenName, identity, codeId }, JWT_SECRET, {
    expiresIn: Math.max(1, Math.floor(expiresInSeconds))
  })
}

const sessionEpoch = db.prepare('SELECT session_epoch FROM accounts WHERE id = ?')

function readPayload(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return { error: 'Missing session token' }
  let payload
  try {
    payload = jwt.verify(token, JWT_SECRET)
  } catch {
    return { error: 'Invalid or expired session' }
  }
  if (!payload.guest) {
    // A token is only good while its account exists and its password has not been changed
    // or reset since it was issued. Tokens from before sessions could end carry no epoch,
    // which counts as 0, the value every account started with.
    const row = sessionEpoch.get(payload.sub)
    if (!row) return { error: 'Invalid or expired session' }
    if ((payload.ep || 0) !== row.session_epoch) {
      return { error: 'Your password was changed, so this session ended. Please log in again.' }
    }
  }
  return { payload }
}

// Accounts only — a guest token is rejected here, so nothing that needs a
// real account can be reached with one.
export function requireAuth(req, res, next) {
  const { payload, error } = readPayload(req)
  if (error) return res.status(401).json({ error })
  if (payload.guest) return res.status(401).json({ error: 'This needs an account' })
  req.account = payload
  next()
}

// Accounts or guests: sets req.account or req.guest, whichever it is.
export function requireAuthOrGuest(req, res, next) {
  const { payload, error } = readPayload(req)
  if (error) return res.status(401).json({ error })
  if (payload.guest) req.guest = payload
  else req.account = payload
  next()
}
