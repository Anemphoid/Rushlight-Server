import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { db } from './db.js'
import { generateCode } from './wordlist.js'
import {
  hashPassword,
  verifyPassword,
  signSession,
  signGuest,
  requireAuth,
  requireAuthOrGuest
} from './auth.js'

const LIVEKIT_URL = process.env.LIVEKIT_URL
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must all be set in .env')
}
// RoomServiceClient needs an http(s) URL, not the ws(s) one clients connect
// with — same host and port, LiveKit serves both off the same listener.
const roomService = new RoomServiceClient(
  LIVEKIT_URL.replace(/^ws/, 'http'),
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
)

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

// Off by default: express's IP detection trusts the LAST hop that talked to
// it, which is correct for a direct connection but wrong behind a reverse
// proxy (everyone would look like they share the proxy's one IP, so one
// person's failed logins could rate-limit everyone else). Behind a real
// proxy (the planned Caddy setup), set TRUST_PROXY=1 so the real client IP
// from X-Forwarded-For is used instead — never set this without one, since
// without a proxy actually stripping/setting that header, a client could
// just claim any IP it wants and dodge the limit entirely.
if (process.env.TRUST_PROXY) app.set('trust proxy', 1)

// Counts ALL attempts in the window, successful or not — simpler and more
// robust than tracking failures only, and immune to the "lock someone else
// out by deliberately failing their login" version of this same problem
// that a per-account counter would open up. Generous enough that normal
// use (a typo, multiple devices, a family setting up several accounts)
// should never realistically hit it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' }
})
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this address. Try again later.' }
})

// --- Presence -----------------------------------------------------------
// Who is currently "in" each channel/room. Kept in memory on purpose: a
// server restart means everyone is disconnected, which is also the moment
// ephemeral history should be gone. Clients check in every few seconds; an
// entry that stops checking in expires (closed app, crash, lost network).
// This is what makes ephemeral rooms work before LiveKit presence exists —
// LiveKit's participant list can replace it later.
// 4x the client's own heartbeat interval (5s), not 3x — gives real slack for
// one bad beat on an imperfect connection without meaningfully delaying how
// fast someone who's actually gone is noticed as gone.
const PRESENCE_TTL_MS = Number(process.env.PRESENCE_TTL_MS) || 20000
const WIPE_GRACE_MS = Number(process.env.WIPE_GRACE_MS) || 10000
const SWEEP_MS = Number(process.env.PRESENCE_SWEEP_MS) || 1000

// key ('channel:3' / 'room:7') -> { serverId, entries: Map(accountId -> entry), emptySince }
const presence = new Map()

function spaceKey(type, id) {
  return `${type}:${id}`
}

function pruneEntries(space, now) {
  for (const [accountId, entry] of space.entries) {
    if (now - entry.lastSeen > PRESENCE_TTL_MS) space.entries.delete(accountId)
  }
  if (space.entries.size === 0 && space.emptySince == null) space.emptySince = now
}

function isOccupied(type, id) {
  const space = presence.get(spaceKey(type, id))
  if (!space) return false
  pruneEntries(space, Date.now())
  return space.entries.size > 0
}

// --- Persistence votes ---------------------------------------------------
// An ephemeral chat can only start keeping history if the people whose words
// would be kept agree. The voters are everyone who has a message in the chat
// right now (before the automatic wipe would have erased it). The person
// proposing is one of them if they've written there, and counts as a yes.
//
// Like presence, open votes live in memory: a vote is a short-lived thing
// (minutes), and a restart also wipes the ephemeral messages it was about.
const PROPOSAL_TTL_MS = Number(process.env.PROPOSAL_TTL_MS) || 5 * 60 * 1000
const PROPOSAL_KEEP_MS = Number(process.env.PROPOSAL_KEEP_MS) || 60 * 1000
const proposals = new Map() // id -> proposal
let nextProposalId = 1

function spaceRow(type, id) {
  return type === 'channel'
    ? db.prepare('SELECT id, name, persistent FROM channels WHERE id = ?').get(id)
    : db.prepare('SELECT id, name, persistent FROM rooms WHERE id = ?').get(id)
}

// Everyone with at least one message in the space, as { id, name }.
function authorsOf(type, spaceId) {
  const column = type === 'channel' ? 'channel_id' : 'room_id'
  return db
    .prepare(
      `SELECT DISTINCT accounts.id AS id, accounts.username AS name
       FROM messages JOIN accounts ON accounts.id = messages.author_account_id
       WHERE messages.${column} = ?`
    )
    .all(spaceId)
}

function tally(p) {
  let agree = 0
  let decline = 0
  for (const v of p.electorate.values()) {
    if (v.vote === 'agree') agree++
    else if (v.vote === 'decline') decline++
  }
  const total = p.electorate.size
  return { total, agree, decline, pending: total - agree - decline }
}

function closeProposal(p, status) {
  p.status = status
  p.resolvedAt = Date.now()
}

// Decide a vote as soon as the outcome can no longer change: more than half
// agreeing passes it; if even every remaining voter agreeing couldn't get past
// half, it fails. It never waits for people whose answer wouldn't matter.
function settle(p) {
  if (p.status !== 'open') return
  const { total, agree, pending } = tally(p)
  if (agree * 2 > total) {
    const table = p.type === 'channel' ? 'channels' : 'rooms'
    db.prepare(`UPDATE ${table} SET persistent = 1 WHERE id = ?`).run(p.spaceId)
    closeProposal(p, 'passed')
  } else if ((agree + pending) * 2 <= total) {
    closeProposal(p, 'failed')
  }
}

function openProposalFor(type, spaceId) {
  for (const p of proposals.values()) {
    if (p.status === 'open' && p.type === type && p.spaceId === spaceId) return p
  }
  return null
}

// The chat emptied and its messages were wiped (or it was removed): there is
// nothing left to keep, so any vote about it is moot.
function cancelProposalsFor(type, spaceId) {
  for (const p of proposals.values()) {
    if (p.status === 'open' && p.type === type && p.spaceId === spaceId) closeProposal(p, 'cancelled')
  }
}

function proposalView(p, accountId) {
  const mine = p.electorate.get(accountId)
  return {
    id: p.id,
    type: p.type,
    spaceId: p.spaceId,
    channelId: p.channelId,
    name: p.spaceName,
    proposer: p.proposerName,
    isProposer: p.proposerId === accountId,
    status: p.status,
    ...tally(p),
    canVote: p.status === 'open' && !!mine,
    yourVote: mine ? mine.vote : null,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt
  }
}

// A person only sees votes they proposed or are being asked to take part in.
function proposalsForServer(serverId, accountId) {
  const out = []
  for (const p of proposals.values()) {
    if (p.serverId !== serverId) continue
    if (p.proposerId !== accountId && !p.electorate.has(accountId)) continue
    out.push(proposalView(p, accountId))
  }
  return out
}

function sweepProposals() {
  const now = Date.now()
  for (const [id, p] of proposals) {
    if (p.status === 'open') {
      if (now >= p.expiresAt) closeProposal(p, 'expired')
      else if (!spaceRow(p.type, p.spaceId)) closeProposal(p, 'cancelled')
    } else if (now - p.resolvedAt > PROPOSAL_KEEP_MS) {
      proposals.delete(id)
    }
  }
}

// A space that starts keeping history records what people say in it, so it
// can't simply be switched on if anyone else has written there. That has to go
// through a vote (below); this guards the plain update route against skipping it.
function refuseIfOthersHaveWritten(res, type, id, what) {
  const others = authorsOf(type, id).filter((a) => a.id !== res.req.account.sub)
  if (others.length === 0) return false
  res.status(409).json({
    error: `Other people have written in this ${what}, so keeping its history needs a vote. Start one from the menu.`,
    people: others.map((a) => a.name)
  })
  return true
}

function presenceForServer(serverId) {
  const now = Date.now()
  const out = {}
  const included = []
  const allIds = new Set()
  for (const [key, space] of presence) {
    if (space.serverId !== serverId) continue
    pruneEntries(space, now)
    if (space.entries.size === 0) continue
    included.push([key, space])
    for (const id of space.entries.keys()) allIds.add(id)
  }
  // One batched lookup rather than one query per person present, so a
  // presence poll on a busy server stays a single extra query, not N.
  const avatarUpdatedAt = new Map()
  if (allIds.size > 0) {
    const placeholders = [...allIds].map(() => '?').join(',')
    const rows = db.prepare(`SELECT id, avatar_updated_at FROM accounts WHERE id IN (${placeholders})`).all(...allIds)
    for (const r of rows) avatarUpdatedAt.set(r.id, r.avatar_updated_at)
  }
  for (const [key, space] of included) {
    out[key] = [...space.entries].map(([id, e]) => ({
      id,
      name: e.name,
      avatarColor: e.avatarColor,
      avatarUpdatedAt: avatarUpdatedAt.get(id) || null
    }))
  }
  return out
}

function recordPresence({ type, id, serverId, account, avatarColor }) {
  const now = Date.now()
  const key = spaceKey(type, id)
  // You can only be in one space per server: checking in here means leaving
  // wherever you were before, which starts that space's wipe clock.
  for (const [otherKey, space] of presence) {
    if (otherKey !== key && space.serverId === serverId && space.entries.delete(account.sub)) {
      if (space.entries.size === 0) space.emptySince = now
    }
  }
  let space = presence.get(key)
  if (!space) {
    space = { serverId, entries: new Map(), emptySince: null }
    presence.set(key, space)
  }
  space.entries.set(account.sub, {
    name: account.username,
    avatarColor: cleanColor(avatarColor),
    lastSeen: now
  })
  space.emptySince = null
}

function removePresence(accountId) {
  const now = Date.now()
  for (const space of presence.values()) {
    if (space.entries.delete(accountId) && space.entries.size === 0) space.emptySince = now
  }
}

function cleanColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : null
}

// Deletes a space's messages only if it is ephemeral. Persistent spaces keep
// their history no matter who comes and goes.
function wipeEphemeral(type, id) {
  const table = type === 'channel' ? 'channels' : 'rooms'
  const column = type === 'channel' ? 'channel_id' : 'room_id'
  const row = db.prepare(`SELECT persistent FROM ${table} WHERE id = ?`).get(id)
  if (!row || row.persistent) return 0
  cancelProposalsFor(type, id)
  return db.prepare(`DELETE FROM messages WHERE ${column} = ?`).run(id).changes
}

function sweepPresence() {
  const now = Date.now()
  for (const [key, space] of presence) {
    pruneEntries(space, now)
    if (space.entries.size === 0 && space.emptySince != null && now - space.emptySince >= WIPE_GRACE_MS) {
      const [type, id] = key.split(':')
      wipeEphemeral(type, Number(id))
      presence.delete(key)
    }
  }
}

// Nobody can be present when the process starts, so any ephemeral history
// left over from before the restart is stale by definition.
function wipeAllEphemeralOnStartup() {
  const result = db
    .prepare(
      `DELETE FROM messages WHERE
         channel_id IN (SELECT id FROM channels WHERE persistent = 0)
         OR room_id IN (SELECT id FROM rooms WHERE persistent = 0)`
    )
    .run()
  return result.changes
}

async function mintLiveKitToken(identity, name, room, canPublish = true) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name })
  at.addGrant({ roomJoin: true, room, canPublish, canSubscribe: true })
  return at.toJwt()
}

function getMembership(serverId, accountId) {
  return db
    .prepare('SELECT * FROM server_members WHERE server_id = ? AND account_id = ?')
    .get(serverId, accountId)
}

function requireServerMember(req, res, next) {
  const membership = getMembership(req.params.id, req.account.sub)
  if (!membership) return res.status(403).json({ error: "You're not a member of that server" })
  req.membership = membership
  next()
}

function requireServerAdmin(req, res, next) {
  const membership = getMembership(req.params.id, req.account.sub)
  if (!membership) return res.status(403).json({ error: "You're not a member of that server" })
  if (!membership.is_admin) return res.status(403).json({ error: 'Admin only' })
  req.membership = membership
  next()
}

function isBanned(serverId, accountId) {
  return !!db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND account_id = ?').get(serverId, accountId)
}

// Removes someone from just this one server's live presence, leaving their
// presence in any other server they're a member of untouched — unlike
// removePresence(), which is for "this person went offline entirely."
function removePresenceFromServer(serverId, accountId) {
  const now = Date.now()
  for (const space of presence.values()) {
    if (space.serverId !== serverId) continue
    if (space.entries.delete(accountId) && space.entries.size === 0) space.emptySince = now
  }
}

// Best-effort: if they're actively in a voice room for this server right
// now, force them off it. Determined from presence rather than asking
// LiveKit to enumerate rooms, since presence already tracks exactly which
// space (if any) each account currently has open. If their heartbeat had
// already lapsed, there's nothing here to disconnect — their membership is
// still gone, so nothing they do next will work either way.
async function disconnectFromServerVoice(serverId, accountId) {
  for (const [key, space] of presence) {
    if (space.serverId !== serverId || !space.entries.has(accountId)) continue
    const [type, id] = key.split(':')
    const roomName = `s${serverId}-${type}-${id}`
    try {
      await roomService.removeParticipant(roomName, `acct-${accountId}`)
    } catch {
      // not actually connected to that room's voice — fine, nothing to do
    }
  }
}

// Kick and ban share everything except the ban record itself.
async function removeMember(serverId, accountId) {
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND account_id = ?').run(serverId, accountId)
  // Order matters: this reads presence to know which room to disconnect
  // them from, so it has to run before that data gets wiped below.
  await disconnectFromServerVoice(serverId, accountId)
  removePresenceFromServer(serverId, accountId)
}

// Applies a live mute/unmute to whichever of this server's voice rooms the
// account is currently connected to, same presence-based lookup as above.
// The permission object is sent whole on purpose — LiveKit updates all
// three flags atomically, so omitting canSubscribe/canPublishData here
// would silently reset them too, not just leave them alone.
async function applyLiveMute(serverId, accountId, muted) {
  for (const [key, space] of presence) {
    if (space.serverId !== serverId || !space.entries.has(accountId)) continue
    const [type, id] = key.split(':')
    const roomName = `s${serverId}-${type}-${id}`
    try {
      await roomService.updateParticipant(roomName, `acct-${accountId}`, undefined, {
        canPublish: !muted,
        canSubscribe: true,
        canPublishData: true
      })
    } catch {
      // not connected to that room right now — the next token they request
      // will carry the right permission regardless
    }
  }
}

// A membership gained through a timed code actually expires now, rather
// than just blocking new joins on an already-expired code. Runs on the same
// sweep interval as presence and votes.
async function sweepMemberships() {
  const now = Date.now()
  const expired = db
    .prepare('SELECT server_id, account_id FROM server_members WHERE access_expires_at IS NOT NULL AND access_expires_at <= ?')
    .all(now)
  for (const row of expired) {
    await removeMember(row.server_id, row.account_id)
  }
}

function serializeTree(serverId) {
  const channels = db
    .prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position, id')
    .all(serverId)
  const rooms = db
    .prepare(
      `SELECT rooms.* FROM rooms
       JOIN channels ON rooms.channel_id = channels.id
       WHERE channels.server_id = ? ORDER BY rooms.position, rooms.id`
    )
    .all(serverId)

  return channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    mode: ch.mode,
    persistent: !!ch.persistent,
    rooms: rooms
      .filter((r) => r.channel_id === ch.id)
      .map((r) => ({ id: r.id, name: r.name, mode: r.mode, persistent: !!r.persistent }))
  }))
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

// --- Accounts ---

app.post('/api/register', registerLimiter, (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password || username.length < 3 || password.length < 8) {
    return res
      .status(400)
      .json({ error: 'Username needs 3+ characters and password needs 8+ characters' })
  }
  const existing = db.prepare('SELECT id FROM accounts WHERE username = ?').get(username)
  if (existing) return res.status(409).json({ error: 'That username is already taken' })

  const { count } = db.prepare('SELECT COUNT(*) as count FROM accounts').get()
  const isFirstAccount = count === 0

  const hash = hashPassword(password)
  const info = db
    .prepare(
      'INSERT INTO accounts (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(username, hash, isFirstAccount ? 1 : 0, Date.now())

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(info.lastInsertRowid)
  const token = signSession(account)
  res.json({
    token,
    id: account.id,
    username: account.username,
    isAdmin: !!account.is_admin,
    avatarUpdatedAt: account.avatar_updated_at || null
  })
})

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' })
  }
  const account = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username)
  if (!account || !verifyPassword(password, account.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password' })
  }
  const token = signSession(account)
  res.json({
    token,
    id: account.id,
    username: account.username,
    isAdmin: !!account.is_admin,
    avatarUpdatedAt: account.avatar_updated_at || null
  })
})

app.get('/api/me', requireAuth, (req, res) => {
  const account = db.prepare('SELECT avatar_updated_at FROM accounts WHERE id = ?').get(req.account.sub)
  res.json({
    id: req.account.sub,
    username: req.account.username,
    isAdmin: req.account.isAdmin,
    avatarUpdatedAt: (account && account.avatar_updated_at) || null
  })
})

// --- Avatars ---
// A custom image lives on the account, not on every message or presence
// heartbeat — sending image bytes that often would be a real bandwidth
// problem, unlike the tiny color-swatch hex it sits alongside. Other people
// see it by fetching /api/avatars/:accountId, keyed off the timestamp below
// so their client knows when to re-fetch instead of trusting a stale cache.
const MAX_AVATAR_BYTES = 1.5 * 1024 * 1024 // after decoding, before base64 overhead
const ALLOWED_AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

// Node's base64 decoder never throws on bad input — it silently skips any
// character outside the base64 alphabet and decodes whatever's left, so
// garbage text quietly becomes a small garbage buffer instead of an error.
// Checking each format's real file signature is what actually catches that,
// the claimed mime type alone proves nothing.
function looksLikeRealImage(buffer, mime) {
  if (buffer.length < 12) return false
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (mime === 'image/png') {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    return sig.every((b, i) => buffer[i] === b)
  }
  if (mime === 'image/webp') {
    return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
  }
  return false
}

app.post('/api/me/avatar', requireAuth, (req, res) => {
  const { image, mime } = req.body || {}
  if (typeof image !== 'string' || !image) {
    return res.status(400).json({ error: 'image (base64) is required' })
  }
  if (!ALLOWED_AVATAR_MIME.has(mime)) {
    return res.status(400).json({ error: 'mime must be image/jpeg, image/png, or image/webp' })
  }
  let buffer
  try {
    buffer = Buffer.from(image, 'base64')
  } catch {
    return res.status(400).json({ error: 'image was not valid base64' })
  }
  if (buffer.length === 0) return res.status(400).json({ error: 'image was empty' })
  if (buffer.length > MAX_AVATAR_BYTES) {
    return res.status(413).json({ error: `Image too large — ${Math.round(MAX_AVATAR_BYTES / 1024)}KB max after cropping` })
  }
  if (!looksLikeRealImage(buffer, mime)) {
    return res.status(400).json({ error: "That didn't decode to a real image matching the type given" })
  }
  const updatedAt = Date.now()
  db.prepare('UPDATE accounts SET avatar_image = ?, avatar_mime = ?, avatar_updated_at = ? WHERE id = ?').run(
    buffer,
    mime,
    updatedAt,
    req.account.sub
  )
  res.json({ avatarUpdatedAt: updatedAt })
})

app.delete('/api/me/avatar', requireAuth, (req, res) => {
  db.prepare('UPDATE accounts SET avatar_image = NULL, avatar_mime = NULL, avatar_updated_at = NULL WHERE id = ?').run(
    req.account.sub
  )
  res.json({ removed: true })
})

// Unauthenticated on purpose, same as the color swatch today: this is a
// picture someone chose to show people they're in a server with, not a
// secret, and an <img> tag can't attach an auth header anyway.
app.get('/api/avatars/:accountId', (req, res) => {
  const row = db
    .prepare('SELECT avatar_image, avatar_mime, avatar_updated_at FROM accounts WHERE id = ?')
    .get(Number(req.params.accountId))
  if (!row || !row.avatar_image) return res.status(404).end()
  res.set('Content-Type', row.avatar_mime)
  res.set('Cache-Control', 'public, max-age=31536000, immutable') // safe: the URL's ?v= changes when the image does
  res.set('ETag', String(row.avatar_updated_at))
  res.send(row.avatar_image)
})

// --- Servers ---

app.post('/api/servers', requireAuth, (req, res) => {
  const { name } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'Server name is required' })

  const now = Date.now()
  const info = db
    .prepare('INSERT INTO servers (name, owner_id, created_at) VALUES (?, ?, ?)')
    .run(name.trim(), req.account.sub, now)
  db.prepare(
    'INSERT INTO server_members (server_id, account_id, is_admin, joined_at) VALUES (?, ?, 1, ?)'
  ).run(info.lastInsertRowid, req.account.sub, now)

  res.json({ id: info.lastInsertRowid, name: name.trim(), isAdmin: true })
})

app.get('/api/servers', requireAuth, (req, res) => {
  const servers = db
    .prepare(
      `SELECT servers.id, servers.name, server_members.is_admin as isAdmin
       FROM servers
       JOIN server_members ON server_members.server_id = servers.id
       WHERE server_members.account_id = ?
       ORDER BY server_members.joined_at`
    )
    .all(req.account.sub)
  res.json({ servers: servers.map((s) => ({ ...s, isAdmin: !!s.isAdmin })) })
})

app.get('/api/servers/:id', requireAuth, requireServerMember, (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  res.json({
    id: server.id,
    name: server.name,
    isAdmin: !!req.membership.is_admin,
    channels: serializeTree(server.id),
    presence: presenceForServer(server.id),
    proposals: proposalsForServer(server.id, req.account.sub)
  })
})

app.patch('/api/servers/:id', requireAuth, requireServerAdmin, (req, res) => {
  const { name } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'Server name is required' })
  db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(name.trim(), req.params.id)
  res.json({ updated: true })
})

app.delete('/api/servers/:id', requireAuth, requireServerAdmin, (req, res) => {
  const id = req.params.id
  const roomIds = db
    .prepare(
      `SELECT rooms.id FROM rooms JOIN channels ON rooms.channel_id = channels.id
       WHERE channels.server_id = ?`
    )
    .all(id)
    .map((r) => r.id)
  const channelIds = db.prepare('SELECT id FROM channels WHERE server_id = ?').all(id).map((c) => c.id)

  const tx = db.transaction(() => {
    for (const roomId of roomIds) {
      db.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId)
    }
    for (const channelId of channelIds) {
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId)
      db.prepare('DELETE FROM rooms WHERE channel_id = ?').run(channelId)
    }
    db.prepare('DELETE FROM channels WHERE server_id = ?').run(id)
    db.prepare('DELETE FROM join_codes WHERE server_id = ?').run(id)
    db.prepare('DELETE FROM server_members WHERE server_id = ?').run(id)
    db.prepare('DELETE FROM servers WHERE id = ?').run(id)
  })
  tx()
  res.json({ deleted: true })
})

// --- Channels ---

app.post('/api/servers/:id/channels', requireAuth, requireServerAdmin, (req, res) => {
  const { name, mode = 'both', persistent = false } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'Channel name is required' })

  const { maxPos } = db
    .prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM channels WHERE server_id = ?')
    .get(req.params.id)

  const info = db
    .prepare(
      `INSERT INTO channels (server_id, name, mode, persistent, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.params.id, name.trim(), mode, persistent ? 1 : 0, maxPos + 1, Date.now())

  res.json({ id: info.lastInsertRowid, name: name.trim(), mode, persistent: !!persistent, rooms: [] })
})

app.patch('/api/servers/:id/channels/:channelId', requireAuth, requireServerAdmin, (req, res) => {
  const channel = db
    .prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?')
    .get(req.params.channelId, req.params.id)
  if (!channel) return res.status(404).json({ error: 'Channel not found' })

  const { name, mode, persistent, position } = req.body || {}
  if (persistent === true && !channel.persistent && refuseIfOthersHaveWritten(res, 'channel', channel.id, 'channel')) return
  db.prepare(
    `UPDATE channels SET
       name = COALESCE(?, name),
       mode = COALESCE(?, mode),
       persistent = COALESCE(?, persistent),
       position = COALESCE(?, position)
     WHERE id = ?`
  ).run(
    name ?? null,
    mode ?? null,
    persistent === undefined ? null : persistent ? 1 : 0,
    position ?? null,
    channel.id
  )
  if (persistent === false && !isOccupied('channel', channel.id)) wipeEphemeral('channel', channel.id)
  res.json({ updated: true })
})

app.delete('/api/servers/:id/channels/:channelId', requireAuth, requireServerAdmin, (req, res) => {
  const channel = db
    .prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?')
    .get(req.params.channelId, req.params.id)
  if (!channel) return res.status(404).json({ error: 'Channel not found' })

  const tx = db.transaction(() => {
    const roomIds = db
      .prepare('SELECT id FROM rooms WHERE channel_id = ?')
      .all(channel.id)
      .map((r) => r.id)
    for (const roomId of roomIds) {
      db.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId)
    }
    db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channel.id)
    db.prepare('DELETE FROM rooms WHERE channel_id = ?').run(channel.id)
    db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id)
  })
  tx()
  res.json({ deleted: true })
})

// --- Rooms ---

app.post(
  '/api/servers/:id/channels/:channelId/rooms',
  requireAuth,
  requireServerAdmin,
  (req, res) => {
    const channel = db
      .prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?')
      .get(req.params.channelId, req.params.id)
    if (!channel) return res.status(404).json({ error: 'Channel not found' })

    const { name, mode = 'both', persistent = false } = req.body || {}
    if (!name || !name.trim()) return res.status(400).json({ error: 'Room name is required' })

    const { maxPos } = db
      .prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM rooms WHERE channel_id = ?')
      .get(channel.id)

    const info = db
      .prepare(
        `INSERT INTO rooms (channel_id, name, mode, persistent, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(channel.id, name.trim(), mode, persistent ? 1 : 0, maxPos + 1, Date.now())

    res.json({ id: info.lastInsertRowid, name: name.trim(), mode, persistent: !!persistent })
  }
)

app.patch(
  '/api/servers/:id/channels/:channelId/rooms/:roomId',
  requireAuth,
  requireServerAdmin,
  (req, res) => {
    const room = db
      .prepare(
        `SELECT rooms.* FROM rooms JOIN channels ON rooms.channel_id = channels.id
         WHERE rooms.id = ? AND rooms.channel_id = ? AND channels.server_id = ?`
      )
      .get(req.params.roomId, req.params.channelId, req.params.id)
    if (!room) return res.status(404).json({ error: 'Room not found' })

    const { name, mode, persistent, position } = req.body || {}
    if (persistent === true && !room.persistent && refuseIfOthersHaveWritten(res, 'room', room.id, 'room')) return
    db.prepare(
      `UPDATE rooms SET
         name = COALESCE(?, name),
         mode = COALESCE(?, mode),
         persistent = COALESCE(?, persistent),
         position = COALESCE(?, position)
       WHERE id = ?`
    ).run(
      name ?? null,
      mode ?? null,
      persistent === undefined ? null : persistent ? 1 : 0,
      position ?? null,
      room.id
    )
    if (persistent === false && !isOccupied('room', room.id)) wipeEphemeral('room', room.id)
    res.json({ updated: true })
  }
)

app.delete(
  '/api/servers/:id/channels/:channelId/rooms/:roomId',
  requireAuth,
  requireServerAdmin,
  (req, res) => {
    const room = db
      .prepare(
        `SELECT rooms.* FROM rooms JOIN channels ON rooms.channel_id = channels.id
         WHERE rooms.id = ? AND rooms.channel_id = ? AND channels.server_id = ?`
      )
      .get(req.params.roomId, req.params.channelId, req.params.id)
    if (!room) return res.status(404).json({ error: 'Room not found' })

    db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id)
    db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id)
    res.json({ deleted: true })
  }
)

// --- Server-scoped join codes ---

app.post('/api/servers/:id/codes', requireAuth, requireServerAdmin, (req, res) => {
  const { persistent = false, singleUse = true, expiresInMinutes = null } = req.body || {}

  let code
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateCode()
    const clash = db.prepare('SELECT id FROM join_codes WHERE code = ?').get(candidate)
    if (!clash) {
      code = candidate
      break
    }
  }
  if (!code) return res.status(500).json({ error: 'Could not generate a unique code, try again' })

  const expiresAt = expiresInMinutes ? Date.now() + expiresInMinutes * 60 * 1000 : null
  db.prepare(
    `INSERT INTO join_codes (code, server_id, created_by, persistent, single_use, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    code,
    req.params.id,
    req.account.sub,
    persistent ? 1 : 0,
    singleUse ? 1 : 0,
    expiresAt,
    Date.now()
  )

  res.json({ code, persistent: !!persistent, singleUse: !!singleUse, expiresAt })
})

// --- Moderation: members, kick, ban, mute, timed access ---

function serializeMember(row) {
  return {
    accountId: row.account_id,
    username: row.username,
    isAdmin: !!row.is_admin,
    muted: !!row.muted,
    accessExpiresAt: row.access_expires_at,
    joinedAt: row.joined_at,
    avatarUpdatedAt: row.avatar_updated_at || null
  }
}

app.get('/api/servers/:id/members', requireAuth, requireServerMember, (req, res) => {
  const rows = db
    .prepare(
      `SELECT server_members.*, accounts.username, accounts.avatar_updated_at FROM server_members
       JOIN accounts ON accounts.id = server_members.account_id
       WHERE server_members.server_id = ? ORDER BY server_members.joined_at`
    )
    .all(req.params.id)
  res.json({ members: rows.map(serializeMember) })
})

app.get('/api/servers/:id/bans', requireAuth, requireServerAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT server_bans.*, accounts.username FROM server_bans
       JOIN accounts ON accounts.id = server_bans.account_id
       WHERE server_bans.server_id = ? ORDER BY server_bans.banned_at DESC`
    )
    .all(req.params.id)
  res.json({
    bans: rows.map((r) => ({
      accountId: r.account_id,
      username: r.username,
      reason: r.reason,
      bannedAt: r.banned_at
    }))
  })
})

app.post('/api/servers/:id/members/:accountId/kick', requireAuth, requireServerAdmin, async (req, res) => {
  const serverId = Number(req.params.id)
  const targetId = Number(req.params.accountId)
  if (targetId === req.account.sub) return res.status(400).json({ error: "You can't kick yourself" })
  if (!getMembership(serverId, targetId)) return res.status(404).json({ error: 'Not a member of that server' })
  await removeMember(serverId, targetId)
  res.json({ kicked: true })
})

app.post('/api/servers/:id/members/:accountId/ban', requireAuth, requireServerAdmin, async (req, res) => {
  const serverId = Number(req.params.id)
  const targetId = Number(req.params.accountId)
  if (targetId === req.account.sub) return res.status(400).json({ error: "You can't ban yourself" })
  const { reason } = req.body || {}
  db.prepare(
    `INSERT INTO server_bans (server_id, account_id, banned_by, reason, banned_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (server_id, account_id) DO UPDATE SET banned_by = excluded.banned_by, reason = excluded.reason, banned_at = excluded.banned_at`
  ).run(serverId, targetId, req.account.sub, typeof reason === 'string' ? reason.slice(0, 300) : null, Date.now())
  if (getMembership(serverId, targetId)) await removeMember(serverId, targetId)
  res.json({ banned: true })
})

app.delete('/api/servers/:id/bans/:accountId', requireAuth, requireServerAdmin, (req, res) => {
  db.prepare('DELETE FROM server_bans WHERE server_id = ? AND account_id = ?').run(req.params.id, req.params.accountId)
  res.json({ unbanned: true })
})

// Mute/unmute and/or set or clear a timed access window, independent of
// however they originally joined. accessExpiresInMinutes: a number sets it
// to now+minutes, null clears it (permanent access), omitted leaves it as is.
app.patch('/api/servers/:id/members/:accountId', requireAuth, requireServerAdmin, async (req, res) => {
  const serverId = Number(req.params.id)
  const targetId = Number(req.params.accountId)
  if (targetId === req.account.sub) return res.status(400).json({ error: "You can't moderate yourself" })
  const membership = getMembership(serverId, targetId)
  if (!membership) return res.status(404).json({ error: 'Not a member of that server' })

  const { muted, accessExpiresInMinutes } = req.body || {}
  if (typeof muted === 'boolean') {
    db.prepare('UPDATE server_members SET muted = ? WHERE server_id = ? AND account_id = ?').run(
      muted ? 1 : 0,
      serverId,
      targetId
    )
    await applyLiveMute(serverId, targetId, muted)
  }
  if (accessExpiresInMinutes !== undefined) {
    const expiresAt =
      accessExpiresInMinutes === null ? null : Date.now() + Number(accessExpiresInMinutes) * 60 * 1000
    db.prepare('UPDATE server_members SET access_expires_at = ? WHERE server_id = ? AND account_id = ?').run(
      expiresAt,
      serverId,
      targetId
    )
  }
  const updated = getMembership(serverId, targetId)
  const account = db.prepare('SELECT username FROM accounts WHERE id = ?').get(targetId)
  res.json({ member: serializeMember({ ...updated, username: account.username }) })
})

app.post('/api/servers/join', requireAuth, (req, res) => {
  const { code } = req.body || {}
  if (!code) return res.status(400).json({ error: 'Code is required' })

  const record = db.prepare('SELECT * FROM join_codes WHERE code = ?').get(code)
  if (!record) return res.status(404).json({ error: 'That code was not recognized' })
  if (record.expires_at && Date.now() > record.expires_at) {
    return res.status(410).json({ error: 'That code has expired' })
  }
  if (record.single_use && record.used) {
    return res.status(410).json({ error: 'That code has already been used' })
  }

  if (isBanned(record.server_id, req.account.sub)) {
    return res.status(403).json({ error: 'You were banned from that server' })
  }

  const already = getMembership(record.server_id, req.account.sub)
  if (!already) {
    db.prepare(
      'INSERT INTO server_members (server_id, account_id, is_admin, joined_at, access_expires_at) VALUES (?, ?, 0, ?, ?)'
    ).run(record.server_id, req.account.sub, Date.now(), record.expires_at || null)
  }
  if (record.single_use) {
    db.prepare('UPDATE join_codes SET used = 1 WHERE id = ?').run(record.id)
  }

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(record.server_id)
  res.json({ id: server.id, name: server.name, isAdmin: !!(already && already.is_admin) })
})

// --- Joining (anonymous, via code — no account, no persistent membership) ---

app.post('/api/join', async (req, res) => {
  const { code } = req.body || {}
  const screenName = typeof req.body?.screenName === 'string' ? req.body.screenName.trim().slice(0, 32) : ''
  if (!code || !screenName) {
    return res.status(400).json({ error: 'Code and screen name are required' })
  }

  const record = db.prepare('SELECT * FROM join_codes WHERE code = ?').get(code)
  if (!record) return res.status(404).json({ error: 'That code was not recognized' })
  if (record.expires_at && Date.now() > record.expires_at) {
    return res.status(410).json({ error: 'That code has expired' })
  }
  if (record.single_use && record.used) {
    return res.status(410).json({ error: 'That code has already been used' })
  }

  if (record.single_use) {
    db.prepare('UPDATE join_codes SET used = 1 WHERE id = ?').run(record.id)
  }

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(record.server_id)
  const identity = `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  res.json({
    guestToken: signGuest({ serverId: server.id, screenName, identity }),
    screenName,
    server: {
      id: server.id,
      name: server.name,
      isAdmin: false,
      channels: serializeTree(server.id),
      presence: presenceForServer(server.id)
    }
  })
})

// --- Voice ---
// One LiveKit room per Rushlight channel/room, so being "in" a space and being
// in its voice room are the same thing. Accounts must be members of the
// space's server; guests may only enter spaces of the server they were
// invited to.

function lookupSpace(type, id) {
  return type === 'channel'
    ? db.prepare('SELECT server_id, mode FROM channels WHERE id = ?').get(id)
    : db
        .prepare(
          `SELECT channels.server_id AS server_id, rooms.mode AS mode FROM rooms
           JOIN channels ON rooms.channel_id = channels.id WHERE rooms.id = ?`
        )
        .get(id)
}

app.post('/api/voice/token', requireAuthOrGuest, async (req, res) => {
  const { type, id } = req.body || {}
  const spaceId = Number(id)
  if ((type !== 'channel' && type !== 'room') || !Number.isInteger(spaceId)) {
    return res.status(400).json({ error: 'type must be channel or room, and id a number' })
  }
  const space = lookupSpace(type, spaceId)
  if (!space) return res.status(404).json({ error: 'Not found' })
  if (space.mode === 'text') return res.status(400).json({ error: 'That space has no voice' })

  let identity
  let name
  let mutedOnJoin = false
  if (req.guest) {
    if (req.guest.serverId !== space.server_id) {
      return res.status(403).json({ error: "You weren't invited to that server" })
    }
    identity = req.guest.identity
    name = req.guest.screenName
  } else {
    const membership = getMembership(space.server_id, req.account.sub)
    if (!membership) {
      return res.status(403).json({ error: "You're not a member of that server" })
    }
    identity = `acct-${req.account.sub}`
    name = req.account.username
    mutedOnJoin = !!membership.muted
  }

  const room = `s${space.server_id}-${type}-${spaceId}`
  const token = await mintLiveKitToken(identity, name, room, !mutedOnJoin)
  res.json({ token, livekitUrl: LIVEKIT_URL, room })
})

// --- Messages (persisted; no real-time push yet — that needs presence) ---

function serializeMessage(m) {
  return {
    id: m.id,
    authorId: m.author_account_id,
    author: m.author_name,
    avatarColor: m.author_avatar_color, // frozen per-message, as it already was
    avatarUpdatedAt: m.current_avatar_updated_at || null, // live — reflects the author's avatar *now*
    text: m.text,
    createdAt: m.created_at
  }
}

function serverIdForSpace(kind, spaceId) {
  const row =
    kind === 'channel'
      ? db.prepare('SELECT server_id FROM channels WHERE id = ?').get(spaceId)
      : db
          .prepare(
            `SELECT channels.server_id FROM rooms
             JOIN channels ON rooms.channel_id = channels.id WHERE rooms.id = ?`
          )
          .get(spaceId)
  return row ? row.server_id : null
}

// Messages belong to a channel or room; only members of that space's server
// may read or post them.
function requireSpaceMember(kind, param) {
  return (req, res, next) => {
    const serverId = serverIdForSpace(kind, req.params[param])
    if (!serverId) return res.status(404).json({ error: 'Not found' })
    if (!getMembership(serverId, req.account.sub)) {
      return res.status(403).json({ error: "You're not a member of that server" })
    }
    next()
  }
}

function listMessages(kind, req, res) {
  const column = kind === 'channel' ? 'channel_id' : 'room_id'
  const spaceId = kind === 'channel' ? req.params.channelId : req.params.roomId
  const messages = db
    .prepare(
      `SELECT m.*, accounts.avatar_updated_at AS current_avatar_updated_at
       FROM (SELECT * FROM messages WHERE ${column} = ? ORDER BY id DESC LIMIT 200) m
       LEFT JOIN accounts ON accounts.id = m.author_account_id
       ORDER BY m.id`
    )
    .all(spaceId)
  res.json({ messages: messages.map(serializeMessage) })
}

function postMessage(kind, req, res) {
  const { text, avatarColor } = req.body || {}
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Message text is required' })
  }
  if (text.length > 4000) return res.status(400).json({ error: 'Message is too long' })

  const spaceId = kind === 'channel' ? req.params.channelId : req.params.roomId
  const info = db
    .prepare(
      `INSERT INTO messages (channel_id, room_id, author_account_id, author_name, author_avatar_color, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kind === 'channel' ? spaceId : null,
      kind === 'room' ? spaceId : null,
      req.account.sub,
      req.account.username,
      cleanColor(avatarColor),
      text.trim(),
      Date.now()
    )
  const message = db
    .prepare(
      `SELECT m.*, accounts.avatar_updated_at AS current_avatar_updated_at
       FROM messages m LEFT JOIN accounts ON accounts.id = m.author_account_id WHERE m.id = ?`
    )
    .get(info.lastInsertRowid)
  res.json(serializeMessage(message))
}

app.get('/api/channels/:channelId/messages', requireAuth, requireSpaceMember('channel', 'channelId'), (req, res) =>
  listMessages('channel', req, res)
)
app.post('/api/channels/:channelId/messages', requireAuth, requireSpaceMember('channel', 'channelId'), (req, res) =>
  postMessage('channel', req, res)
)
app.get('/api/rooms/:roomId/messages', requireAuth, requireSpaceMember('room', 'roomId'), (req, res) =>
  listMessages('room', req, res)
)
app.post('/api/rooms/:roomId/messages', requireAuth, requireSpaceMember('room', 'roomId'), (req, res) =>
  postMessage('room', req, res)
)

// --- Presence routes ---

// Check in to a channel or room. Returns everyone currently in this server's
// spaces, so the caller sees who's around without a second request.
app.post('/api/presence', requireAuth, (req, res) => {
  const { type, id, avatarColor } = req.body || {}
  const spaceId = Number(id)
  if ((type !== 'channel' && type !== 'room') || !Number.isInteger(spaceId)) {
    return res.status(400).json({ error: 'type must be channel or room, and id a number' })
  }
  const serverId = serverIdForSpace(type, spaceId)
  if (!serverId) return res.status(404).json({ error: 'Not found' })
  if (!getMembership(serverId, req.account.sub)) {
    return res.status(403).json({ error: "You're not a member of that server" })
  }
  recordPresence({ type, id: spaceId, serverId, account: req.account, avatarColor })
  res.json({ presence: presenceForServer(serverId) })
})

app.post('/api/presence/leave', requireAuth, (req, res) => {
  removePresence(req.account.sub)
  res.json({ left: true })
})

// --- Persistence vote routes ---

// Start a vote to make a chat persistent. If nobody but the person asking has
// written in it there is no one to ask, and it switches on immediately.
function startPersistVote(req, res, type) {
  const spaceId = Number(type === 'channel' ? req.params.channelId : req.params.roomId)
  const serverId = Number(req.params.id)
  const owned = type === 'channel' ? lookupSpace('channel', spaceId) : lookupSpace('room', spaceId)
  if (!owned || owned.server_id !== serverId) return res.status(404).json({ error: 'Not found' })
  if (type === 'room') {
    const inChannel = db.prepare('SELECT channel_id FROM rooms WHERE id = ?').get(spaceId)
    if (inChannel.channel_id !== Number(req.params.channelId)) return res.status(404).json({ error: 'Not found' })
  }
  const space = spaceRow(type, spaceId)
  if (space.persistent) return res.status(400).json({ error: 'This chat already keeps its history' })
  if (openProposalFor(type, spaceId)) {
    return res.status(409).json({ error: 'A vote on this chat is already open' })
  }

  const authors = authorsOf(type, spaceId)
  const others = authors.filter((a) => a.id !== req.account.sub)
  if (others.length === 0) {
    const table = type === 'channel' ? 'channels' : 'rooms'
    db.prepare(`UPDATE ${table} SET persistent = 1 WHERE id = ?`).run(spaceId)
    return res.json({ outcome: 'passed', immediate: true })
  }

  const now = Date.now()
  const p = {
    id: nextProposalId++,
    serverId,
    type,
    spaceId,
    channelId: type === 'channel' ? spaceId : Number(req.params.channelId),
    spaceName: space.name,
    proposerId: req.account.sub,
    proposerName: req.account.username,
    electorate: new Map(authors.map((a) => [a.id, { name: a.name, vote: a.id === req.account.sub ? 'agree' : null }])),
    status: 'open',
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    resolvedAt: null
  }
  proposals.set(p.id, p)
  settle(p)
  res.json({ outcome: p.status, proposal: proposalView(p, req.account.sub) })
}

app.post('/api/servers/:id/channels/:channelId/persist-vote', requireAuth, requireServerAdmin, (req, res) =>
  startPersistVote(req, res, 'channel')
)
app.post(
  '/api/servers/:id/channels/:channelId/rooms/:roomId/persist-vote',
  requireAuth,
  requireServerAdmin,
  (req, res) => startPersistVote(req, res, 'room')
)

app.post('/api/proposals/:proposalId/vote', requireAuth, (req, res) => {
  const p = proposals.get(Number(req.params.proposalId))
  const voter = p && p.electorate.get(req.account.sub)
  if (!p || !voter) return res.status(404).json({ error: 'No such vote' })
  if (p.status !== 'open') return res.status(409).json({ error: 'That vote has already closed' })
  const { vote } = req.body || {}
  if (vote !== 'agree' && vote !== 'decline') {
    return res.status(400).json({ error: 'vote must be agree or decline' })
  }
  voter.vote = vote
  settle(p)
  res.json({ proposal: proposalView(p, req.account.sub) })
})

// The person who started a vote can withdraw it while it's open.
app.delete('/api/proposals/:proposalId', requireAuth, (req, res) => {
  const p = proposals.get(Number(req.params.proposalId))
  if (!p || p.proposerId !== req.account.sub) return res.status(404).json({ error: 'No such vote' })
  if (p.status === 'open') closeProposal(p, 'cancelled')
  res.json({ proposal: proposalView(p, req.account.sub) })
})

const PORT = process.env.PORT || 4000
const wiped = wipeAllEphemeralOnStartup()
setInterval(() => {
  sweepPresence()
  sweepProposals()
  // async (it may call out to LiveKit) — fire and forget, but never let a
  // rejection take the whole process down
  sweepMemberships().catch((err) => console.error('sweepMemberships:', err))
}, SWEEP_MS).unref()
app.listen(PORT, () => {
  console.log(`Rushlight server listening on port ${PORT}`)
  if (wiped) console.log(`Cleared ${wiped} ephemeral message(s) left over from before the restart`)
})
