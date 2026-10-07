import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { randomBytes } from 'node:crypto'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { db } from './db.js'
import { generateCode } from './wordlist.js'
import {
  hashPassword,
  verifyPassword,
  verifyAgainstNobody,
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
// Avatars arrive as base64 (about a third bigger than the 1.5MB image limit).
app.use(express.json({ limit: '3mb' }))

// --- Small input helpers --------------------------------------------------
// Request bodies are untrusted: a field that isn't the type the route expects
// must produce a 400, never reach the database (which throws on odd types).
const MODES = new Set(['voice', 'text', 'both'])
const MAX_NAME = 64
const MAX_MINUTES = 60 * 24 * 365
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

// Express 4 does not catch a rejected promise from an async route; without
// this, one bad request in an async handler takes the whole process down.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// A trimmed, printable, bounded string, or null if it isn't one.
function cleanLabel(value, max = MAX_NAME) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || CONTROL_CHARS.test(trimmed)) return null
  return trimmed
}

function toId(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

const validMinutes = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_MINUTES

// Optional booleans/strings in a PATCH: undefined (or null) means "leave it".
const isAbsent = (v) => v === undefined || v === null

// Off by default: express's IP detection trusts the LAST hop that talked to
// it, which is correct for a direct connection but wrong behind a reverse
// proxy (everyone would look like they share the proxy's one IP, so one
// person's failed logins could rate-limit everyone else). Behind a real
// proxy (the planned Caddy setup), set TRUST_PROXY=1 so the real client IP
// from X-Forwarded-For is used instead — never set this without one, since
// without a proxy actually stripping/setting that header, a client could
// just claim any IP it wants and dodge the limit entirely.
const trustProxy = process.env.TRUST_PROXY
if (trustProxy && trustProxy !== '0' && trustProxy !== 'false') {
  app.set('trust proxy', Number.isInteger(Number(trustProxy)) ? Number(trustProxy) : 1)
}

// Counts ALL attempts in the window, successful or not — simpler and more
// robust than tracking failures only, and immune to the "lock someone else
// out by deliberately failing their login" version of this same problem
// that a per-account counter would open up. Generous enough that normal
// use (a typo, multiple devices, a family setting up several accounts)
// should never realistically hit it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' }
})
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.REGISTER_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this address. Try again later.' }
})

// Join codes are the only thing standing between a stranger and a server, and
// /api/join needs no account, so guessing them has to be slow. Per IP, counting
// every attempt.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.JOIN_LIMIT) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many join attempts. Try again in a few minutes.' }
})

// The 5 second check-in is the busiest route there is. A household behind one
// address can have several clients checking in, so the limit is generous: it is
// there to stop a flood, not to shape normal use. Per IP, counting every attempt.
const presenceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.PRESENCE_LIMIT) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many check-ins from this address. Slow down a little.' }
})

// --- Guests ---------------------------------------------------------------
// Guests have no account, so they can't be muted or banned by account. What an
// admin can do instead is revoke the join code they came in with. This map
// (in memory, like presence) remembers each live guest's code and the voice
// rooms they were handed tokens for, so revoking can disconnect them too. It
// is only for that and for keeping guest names unique; whether a guest may
// still get a token is decided by their signed token and the code's row.
// identity -> { serverId, codeId, name, expiresAt, rooms: Set<string> }
const guestSessions = new Map()

// A guest's session ends when their token does: at the join code's own expiry,
// or after 12 hours, whichever comes first. Ending it also drops them from the
// voice rooms they were handed tokens for, because LiveKit only checks a token
// when someone connects and would otherwise leave them in the call.
// LiveKit is told first and presence is cleared after, the same order kick uses.
async function endGuestSession(identity, g) {
  guestSessions.delete(identity)
  await Promise.all([...g.rooms].map((room) => bestEffort(roomService.removeParticipant(room, identity))))
  removePresence(identity)
}

// The session for a guest token, made again if the server has forgotten it (a
// restart clears the map). The token carries everything needed to rebuild it.
function ensureGuestSession(claims) {
  let session = liveGuests().get(claims.identity)
  if (!session) {
    session = {
      serverId: claims.serverId,
      codeId: claims.codeId,
      name: claims.screenName,
      joinedAt: claims.iat * 1000,
      expiresAt: claims.exp * 1000,
      rooms: new Set()
    }
    guestSessions.set(claims.identity, session)
  }
  return session
}

function liveGuests() {
  const now = Date.now()
  for (const [identity, g] of guestSessions) {
    if (g.expiresAt <= now) endGuestSession(identity, g).catch(() => {})
  }
  return guestSessions
}

function guestNameTaken(serverId, name) {
  const lower = name.toLowerCase()
  for (const g of liveGuests().values()) {
    if (g.serverId === serverId && g.name.toLowerCase() === lower) return true
  }
  return false
}

// Best-effort: end voice for these LiveKit rooms/participants. LiveKit being
// unreachable must never make an admin action fail.
function bestEffort(promise) {
  return Promise.resolve(promise).catch(() => {})
}

async function disconnectGuests(match) {
  const jobs = []
  for (const [identity, g] of liveGuests()) {
    if (match(g)) jobs.push(endGuestSession(identity, g))
  }
  await Promise.all(jobs)
}

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

// onlyKey limits the answer to one space ('channel:3'), which is all a guest sees.
// Guests are listed by screen name with no avatar image; their ids are strings
// (the guest identity), so the avatar lookup below only asks about account ids.
function presenceForServer(serverId, onlyKey = null) {
  const now = Date.now()
  const out = {}
  const included = []
  const allIds = new Set()
  for (const [key, space] of presence) {
    if (space.serverId !== serverId) continue
    if (onlyKey && key !== onlyKey) continue
    pruneEntries(space, now)
    if (space.entries.size === 0) continue
    included.push([key, space])
    for (const id of space.entries.keys()) if (typeof id === 'number') allIds.add(id)
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
      avatarUpdatedAt: avatarUpdatedAt.get(id) || null,
      ...(e.guest ? { guest: true } : {})
    }))
  }
  return out
}

// who: the account id for an account, or the guest identity string for a guest.
function recordPresence({ type, id, serverId, who, name, avatarColor, guest = false }) {
  const now = Date.now()
  const key = spaceKey(type, id)
  // You can only be in one space per server: checking in here means leaving
  // wherever you were before, which starts that space's wipe clock.
  for (const [otherKey, space] of presence) {
    if (otherKey !== key && space.serverId === serverId && space.entries.delete(who)) {
      if (space.entries.size === 0) space.emptySince = now
    }
  }
  let space = presence.get(key)
  if (!space) {
    space = { serverId, entries: new Map(), emptySince: null }
    presence.set(key, space)
  }
  space.entries.set(who, {
    name,
    avatarColor: cleanColor(avatarColor),
    lastSeen: now,
    guest
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
  if (!membership) return notAMember(res, req.params.id, req.account.sub)
  req.membership = membership
  next()
}

function requireServerAdmin(req, res, next) {
  const membership = getMembership(req.params.id, req.account.sub)
  if (!membership) return notAMember(res, req.params.id, req.account.sub)
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

// Kick, ban and expiry share this; they differ in the ban record and in the
// reason remembered for the person ('removed', 'banned' or 'expired').
async function removeMember(serverId, accountId, reason = 'removed') {
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND account_id = ?').run(serverId, accountId)
  db.prepare(
    `INSERT INTO access_ends (server_id, account_id, reason, ended_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (server_id, account_id) DO UPDATE SET reason = excluded.reason, ended_at = excluded.ended_at`
  ).run(serverId, accountId, reason, Date.now())
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
  // Admins and the owner never expire, whatever is on their row: only ordinary
  // members can be given a timer, and this stops a stray value locking an owner out.
  const expired = db
    .prepare(
      `SELECT server_id, account_id FROM server_members
       WHERE access_expires_at IS NOT NULL AND access_expires_at <= ? AND is_admin = 0
         AND account_id NOT IN (SELECT owner_id FROM servers WHERE servers.id = server_members.server_id)`
    )
    .all(now)
  for (const row of expired) {
    await removeMember(row.server_id, row.account_id, 'expired')
  }
  liveGuests() // ends the sessions of guests whose code has run out, and drops them from voice
}

const ACCESS_ENDED_MESSAGE = {
  expired: 'Your access to this server has expired.',
  removed: 'You were removed from this server.',
  banned: 'You were banned from this server.'
}

// The 403 for someone who is not a member. If they used to be, say why they are not.
function notAMember(res, serverId, accountId) {
  const row = db
    .prepare('SELECT reason FROM access_ends WHERE server_id = ? AND account_id = ?')
    .get(Number(serverId), accountId)
  if (row && ACCESS_ENDED_MESSAGE[row.reason]) {
    return res.status(403).json({ error: ACCESS_ENDED_MESSAGE[row.reason], reason: row.reason })
  }
  return res.status(403).json({ error: "You're not a member of that server" })
}

// Old records are not needed for long.
function purgeOldAccessEnds() {
  db.prepare('DELETE FROM access_ends WHERE ended_at < ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000)
}

// A deleted server leaves nothing behind in memory, and anyone still on its
// voice rooms is dropped (best-effort; the rooms themselves are gone either way).
function forgetServer(serverId, voiceRooms) {
  presence.forEach((space, key) => {
    if (space.serverId === serverId) presence.delete(key)
  })
  proposals.forEach((p, id) => {
    if (p.serverId === serverId) proposals.delete(id)
  })
  liveGuests().forEach((g, identity) => {
    if (g.serverId === serverId) guestSessions.delete(identity)
  })
  for (const room of voiceRooms) bestEffort(roomService.deleteRoom(room))
}

// scope narrows the tree to what a scoped guest code covers: { type, id } for one
// channel (with its rooms) or one room. A room's channel is shown only as the place
// it sits, marked joinable: false, so the guest sees a way to the one room and
// nothing else. Members never pass a scope and get the whole tree, unchanged.
function serializeTree(serverId, scope = null) {
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

  const tree = channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    mode: ch.mode,
    persistent: !!ch.persistent,
    rooms: rooms
      .filter((r) => r.channel_id === ch.id)
      .map((r) => ({ id: r.id, name: r.name, mode: r.mode, persistent: !!r.persistent }))
  }))
  if (!scope) return tree
  if (scope.type === 'channel') return tree.filter((ch) => ch.id === scope.id)
  return tree
    .filter((ch) => ch.rooms.some((r) => r.id === scope.id))
    .map((ch) => ({ ...ch, joinable: false, rooms: ch.rooms.filter((r) => r.id === scope.id) }))
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

// --- Accounts ---

// Display names are matched by the clients (who is speaking, per-person volume),
// so they have to be unambiguous: trimmed, printable, and unique ignoring case.
function cleanUsername(value) {
  const name = cleanLabel(value, 32)
  return name && name.length >= 3 ? name : null
}

app.post('/api/register', registerLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {}
  const username = cleanUsername(body.username)
  const password = body.password
  if (!username) {
    return res.status(400).json({ error: 'Username needs 3 to 32 printable characters' })
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password needs 8+ characters' })
  }
  // bcrypt only reads the first 72 bytes, so a longer password would silently
  // be a shorter one. Say so instead.
  if (Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: 'Password can be at most 72 bytes long' })
  }

  const hash = await hashPassword(password)

  // Check and insert with no await in between, so two registrations for the
  // same name can't both pass the check.
  const existing = db.prepare('SELECT id FROM accounts WHERE username = ? COLLATE NOCASE').get(username)
  if (existing) return res.status(409).json({ error: 'That username is already taken' })

  const { count } = db.prepare('SELECT COUNT(*) as count FROM accounts').get()
  const isFirstAccount = count === 0
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
}))

app.post('/api/login', loginLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {}
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = body.password
  if (!username || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Username and password are required' })
  }
  // An exact match wins; otherwise ignore capitalization, so "alice" gets into
  // "Alice" the way people expect.
  const account =
    db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) ||
    db.prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE').get(username)
  const ok = account
    ? await verifyPassword(password, account.password_hash)
    : (await verifyAgainstNobody(password), false)
  if (!ok) {
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
}))

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
  const name = cleanLabel((req.body || {}).name)
  if (!name) return res.status(400).json({ error: `Server name is required (up to ${MAX_NAME} characters)` })

  const now = Date.now()
  const info = db
    .prepare('INSERT INTO servers (name, owner_id, created_at) VALUES (?, ?, ?)')
    .run(name, req.account.sub, now)
  db.prepare(
    'INSERT INTO server_members (server_id, account_id, is_admin, joined_at) VALUES (?, ?, 1, ?)'
  ).run(info.lastInsertRowid, req.account.sub, now)

  res.json({ id: info.lastInsertRowid, name, isAdmin: true })
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
  const name = cleanLabel((req.body || {}).name)
  if (!name) return res.status(400).json({ error: `Server name is required (up to ${MAX_NAME} characters)` })
  db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(name, req.params.id)
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
  const voiceRooms = [
    ...channelIds.map((cid) => `s${id}-channel-${cid}`),
    ...roomIds.map((rid) => `s${id}-room-${rid}`)
  ]

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
    db.prepare('DELETE FROM server_bans WHERE server_id = ?').run(id)
    db.prepare('DELETE FROM access_ends WHERE server_id = ?').run(id)
    db.prepare('DELETE FROM server_members WHERE server_id = ?').run(id)
    db.prepare('DELETE FROM servers WHERE id = ?').run(id)
  })
  tx()
  forgetServer(Number(id), voiceRooms)
  res.json({ deleted: true })
})

// --- Channels ---

app.post('/api/servers/:id/channels', requireAuth, requireServerAdmin, (req, res) => {
  const { mode = 'both', persistent = false } = req.body || {}
  const name = cleanLabel((req.body || {}).name)
  if (!name) return res.status(400).json({ error: `Channel name is required (up to ${MAX_NAME} characters)` })
  if (!MODES.has(mode)) return res.status(400).json({ error: 'mode must be voice, text, or both' })
  if (typeof persistent !== 'boolean') return res.status(400).json({ error: 'persistent must be true or false' })

  const { maxPos } = db
    .prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM channels WHERE server_id = ?')
    .get(req.params.id)

  const info = db
    .prepare(
      `INSERT INTO channels (server_id, name, mode, persistent, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.params.id, name, mode, persistent ? 1 : 0, maxPos + 1, Date.now())

  res.json({ id: info.lastInsertRowid, name, mode, persistent, rooms: [] })
})

app.patch('/api/servers/:id/channels/:channelId', requireAuth, requireServerAdmin, (req, res) => {
  const channel = db
    .prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?')
    .get(req.params.channelId, req.params.id)
  if (!channel) return res.status(404).json({ error: 'Channel not found' })

  const { name: rawName, mode, persistent, position } = req.body || {}
  const patchError = validateSpacePatch({ name: rawName, mode, persistent, position })
  if (patchError) return res.status(400).json({ error: patchError })
  const name = isAbsent(rawName) ? undefined : rawName.trim()
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
    isAbsent(persistent) ? null : persistent ? 1 : 0,
    position ?? null,
    channel.id
  )
  if (persistent === false && !isOccupied('channel', channel.id)) wipeEphemeral('channel', channel.id)
  res.json({ updated: true })
})

app.delete('/api/servers/:id/channels/:channelId', requireAuth, requireServerAdmin, asyncHandler(async (req, res) => {
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
    return roomIds
  })
  const removedRoomIds = tx()
  const sid = Number(req.params.id)
  bestEffort(roomService.deleteRoom(`s${sid}-channel-${channel.id}`))
  for (const rid of removedRoomIds) bestEffort(roomService.deleteRoom(`s${sid}-room-${rid}`))
  await revokeCodesScopedTo({ serverId: sid, channelId: channel.id, roomIds: removedRoomIds })
  res.json({ deleted: true })
}))

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

    const { mode = 'both', persistent = false } = req.body || {}
    const name = cleanLabel((req.body || {}).name)
    if (!name) return res.status(400).json({ error: `Room name is required (up to ${MAX_NAME} characters)` })
    if (!MODES.has(mode)) return res.status(400).json({ error: 'mode must be voice, text, or both' })
    if (typeof persistent !== 'boolean') return res.status(400).json({ error: 'persistent must be true or false' })

    const { maxPos } = db
      .prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM rooms WHERE channel_id = ?')
      .get(channel.id)

    const info = db
      .prepare(
        `INSERT INTO rooms (channel_id, name, mode, persistent, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(channel.id, name, mode, persistent ? 1 : 0, maxPos + 1, Date.now())

    res.json({ id: info.lastInsertRowid, name, mode, persistent })
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

    const { name: rawName, mode, persistent, position } = req.body || {}
    const patchError = validateSpacePatch({ name: rawName, mode, persistent, position })
    if (patchError) return res.status(400).json({ error: patchError })
    const name = isAbsent(rawName) ? undefined : rawName.trim()
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
      isAbsent(persistent) ? null : persistent ? 1 : 0,
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
  asyncHandler(async (req, res) => {
    const room = db
      .prepare(
        `SELECT rooms.* FROM rooms JOIN channels ON rooms.channel_id = channels.id
         WHERE rooms.id = ? AND rooms.channel_id = ? AND channels.server_id = ?`
      )
      .get(req.params.roomId, req.params.channelId, req.params.id)
    if (!room) return res.status(404).json({ error: 'Room not found' })

    db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id)
    db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id)
    bestEffort(roomService.deleteRoom(`s${Number(req.params.id)}-room-${room.id}`))
    await revokeCodesScopedTo({ serverId: Number(req.params.id), roomIds: [room.id] })
    res.json({ deleted: true })
  })
)

// --- Server-scoped join codes ---

app.post('/api/servers/:id/codes', requireAuth, requireServerAdmin, (req, res) => {
  const { persistent = false, singleUse = true, expiresInMinutes = null } = req.body || {}
  if (typeof persistent !== 'boolean' || typeof singleUse !== 'boolean') {
    return res.status(400).json({ error: 'persistent and singleUse must be true or false' })
  }
  if (expiresInMinutes !== null && !validMinutes(expiresInMinutes)) {
    return res.status(400).json({ error: 'expiresInMinutes must be a positive number of minutes, or null' })
  }

  // Optional scope: { type: 'channel' | 'room', id }. Left out, the code covers the
  // whole server. A scoped code is for guests only, and guests only use voice.
  let scope = null
  const scopeIn = (req.body || {}).scope
  if (scopeIn !== undefined && scopeIn !== null) {
    const type = scopeIn && scopeIn.type
    const sid = scopeIn && Number(scopeIn.id)
    if ((type !== 'channel' && type !== 'room') || !Number.isInteger(sid) || sid <= 0) {
      return res.status(400).json({
        error: 'scope must be { type: "channel" or "room", id: a number }, or left out for the whole server'
      })
    }
    const space = lookupSpace(type, sid)
    if (!space || space.server_id !== Number(req.params.id)) {
      return res.status(400).json({ error: `That ${type} is not in this server` })
    }
    if (space.mode === 'text') {
      return res.status(400).json({ error: 'Guests can only join voice, and that space has no voice' })
    }
    scope = { type, id: sid }
  }

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
    `INSERT INTO join_codes (code, server_id, created_by, persistent, single_use, expires_at, created_at, scope_type, scope_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    code,
    req.params.id,
    req.account.sub,
    persistent ? 1 : 0,
    singleUse ? 1 : 0,
    expiresAt,
    Date.now(),
    scope ? scope.type : null,
    scope ? scope.id : null
  )

  res.json({
    code,
    persistent: !!persistent,
    singleUse: !!singleUse,
    expiresAt,
    scope: scope ? { ...scope, name: scopeName(scope) } : null
  })
})

// Codes still able to bring someone in, newest first, with how many guests
// they have brought in who are still around.
app.get('/api/servers/:id/codes', requireAuth, requireServerAdmin, (req, res) => {
  const now = Date.now()
  const rows = db
    .prepare(
      `SELECT id, code, persistent, single_use, used, revoked, expires_at, created_at, scope_type, scope_id FROM join_codes
       WHERE server_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)
         AND NOT (single_use = 1 AND used = 1)
       ORDER BY id DESC`
    )
    .all(req.params.id, now)
  const guestsByCode = new Map()
  for (const g of liveGuests().values()) {
    if (g.serverId === Number(req.params.id)) guestsByCode.set(g.codeId, (guestsByCode.get(g.codeId) || 0) + 1)
  }
  res.json({
    codes: rows
      .filter((r) => scopeTargetExists(r)) // a code for a deleted channel or room is dead
      .map((r) => ({
        id: r.id,
        code: r.code,
        persistent: !!r.persistent,
        singleUse: !!r.single_use,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        guestsNow: guestsByCode.get(r.id) || 0,
        scope: r.scope_type ? { type: r.scope_type, id: r.scope_id, name: scopeName(scopeOf(r)) } : null
      }))
  })
})

// Revoking a code stops it admitting anyone new AND ends the access of every
// guest who came in with it: their next voice token is refused, and anyone
// already in a voice room is disconnected. This is the way to remove a guest.
// People who made an account through it keep their membership; use kick or ban
// for those.
app.delete('/api/servers/:id/codes/:codeId', requireAuth, requireServerAdmin, asyncHandler(async (req, res) => {
  const codeId = toId(req.params.codeId)
  const record = codeId && db.prepare('SELECT id FROM join_codes WHERE id = ? AND server_id = ?').get(codeId, req.params.id)
  if (!record) return res.status(404).json({ error: 'Code not found' })
  db.prepare('UPDATE join_codes SET revoked = 1 WHERE id = ?').run(codeId)
  await disconnectGuests((g) => g.codeId === codeId)
  res.json({ revoked: true })
}))

// --- Moderation: members, kick, ban, mute, timed access ---

// Shared by the channel and room PATCH routes. Returns an error message, or null.
function validateSpacePatch({ name, mode, persistent, position }) {
  if (!isAbsent(name) && !cleanLabel(name)) return `name must be 1 to ${MAX_NAME} printable characters`
  if (!isAbsent(mode) && !MODES.has(mode)) return 'mode must be voice, text, or both'
  if (!isAbsent(persistent) && typeof persistent !== 'boolean') return 'persistent must be true or false'
  if (!isAbsent(position) && !(Number.isInteger(position) && position >= 0)) {
    return 'position must be a whole number, 0 or more'
  }
  return null
}

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

// Shared checks for moderation routes. Returns the target's id, or sends the
// error response and returns null. The owner and other admins are off limits:
// otherwise any admin could lock the owner out of their own server.
function moderationTarget(req, res, { mustBeMember }) {
  const serverId = Number(req.params.id)
  const targetId = toId(req.params.accountId)
  if (!targetId) {
    res.status(400).json({ error: 'That is not a valid account' })
    return null
  }
  if (targetId === req.account.sub) {
    res.status(400).json({ error: "You can't moderate yourself" })
    return null
  }
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(targetId)) {
    res.status(404).json({ error: 'No such account' })
    return null
  }
  const owner = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId)
  const membership = getMembership(serverId, targetId)
  if ((owner && owner.owner_id === targetId) || (membership && membership.is_admin)) {
    res.status(403).json({ error: "Admins and the server's owner can't be moderated" })
    return null
  }
  if (mustBeMember && !membership) {
    res.status(404).json({ error: 'Not a member of that server' })
    return null
  }
  return targetId
}

app.post('/api/servers/:id/members/:accountId/kick', requireAuth, requireServerAdmin, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id)
  const targetId = moderationTarget(req, res, { mustBeMember: true })
  if (!targetId) return
  await removeMember(serverId, targetId, 'removed')
  res.json({ kicked: true })
}))

app.post('/api/servers/:id/members/:accountId/ban', requireAuth, requireServerAdmin, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id)
  const targetId = moderationTarget(req, res, { mustBeMember: false })
  if (!targetId) return
  const { reason } = req.body || {}
  db.prepare(
    `INSERT INTO server_bans (server_id, account_id, banned_by, reason, banned_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (server_id, account_id) DO UPDATE SET banned_by = excluded.banned_by, reason = excluded.reason, banned_at = excluded.banned_at`
  ).run(serverId, targetId, req.account.sub, typeof reason === 'string' ? reason.slice(0, 300) : null, Date.now())
  if (getMembership(serverId, targetId)) await removeMember(serverId, targetId, 'banned')
  else {
    db.prepare(
      `INSERT INTO access_ends (server_id, account_id, reason, ended_at) VALUES (?, ?, 'banned', ?)
       ON CONFLICT (server_id, account_id) DO UPDATE SET reason = 'banned', ended_at = excluded.ended_at`
    ).run(serverId, targetId, Date.now())
  }
  res.json({ banned: true })
}))

app.delete('/api/servers/:id/bans/:accountId', requireAuth, requireServerAdmin, (req, res) => {
  const targetId = toId(req.params.accountId)
  if (!targetId) return res.status(400).json({ error: 'That is not a valid account' })
  db.prepare('DELETE FROM server_bans WHERE server_id = ? AND account_id = ?').run(req.params.id, targetId)
  res.json({ unbanned: true })
})

// Mute/unmute and/or set or clear a timed access window, independent of
// however they originally joined. accessExpiresInMinutes: a number sets it
// to now+minutes, null clears it (permanent access), omitted leaves it as is.
app.patch('/api/servers/:id/members/:accountId', requireAuth, requireServerAdmin, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id)
  const targetId = moderationTarget(req, res, { mustBeMember: true })
  if (!targetId) return

  const { muted, accessExpiresInMinutes } = req.body || {}
  if (muted !== undefined && typeof muted !== 'boolean') {
    return res.status(400).json({ error: 'muted must be true or false' })
  }
  if (accessExpiresInMinutes !== undefined && accessExpiresInMinutes !== null && !validMinutes(accessExpiresInMinutes)) {
    return res.status(400).json({ error: 'accessExpiresInMinutes must be a positive number of minutes, or null' })
  }
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
      accessExpiresInMinutes === null ? null : Date.now() + accessExpiresInMinutes * 60 * 1000
    db.prepare('UPDATE server_members SET access_expires_at = ? WHERE server_id = ? AND account_id = ?').run(
      expiresAt,
      serverId,
      targetId
    )
  }
  const updated = getMembership(serverId, targetId)
  const account = db.prepare('SELECT username FROM accounts WHERE id = ?').get(targetId)
  res.json({ member: serializeMember({ ...updated, username: account.username }) })
}))

// Looks a code up and checks it can still be used. Returns the row, or sends
// the error response and returns null.
function usableCode(res, code) {
  if (typeof code !== 'string' || !code.trim() || code.length > 64) {
    res.status(400).json({ error: 'Code is required' })
    return null
  }
  const record = db.prepare('SELECT * FROM join_codes WHERE code = ?').get(code.trim())
  if (!record || record.revoked) {
    res.status(404).json({ error: 'That code was not recognized' })
    return null
  }
  if (record.expires_at && Date.now() > record.expires_at) {
    res.status(410).json({ error: 'That code has expired' })
    return null
  }
  if (record.single_use && record.used) {
    res.status(410).json({ error: 'That code has already been used' })
    return null
  }
  return record
}

app.post('/api/servers/join', joinLimiter, requireAuth, (req, res) => {
  const record = usableCode(res, (req.body || {}).code)
  if (!record) return

  // A code for one channel or room only lets guests in. Refused before anything is
  // used up, so the code still works for the guest it was made for.
  if (record.scope_type) {
    return res.status(403).json({
      error:
        `That code is a guest invite for one ${record.scope_type}, so it can't make you a member. ` +
        'Ask for a server invite to join the whole server.'
    })
  }

  if (isBanned(record.server_id, req.account.sub)) {
    return res.status(403).json({ error: 'You were banned from that server' })
  }

  const already = getMembership(record.server_id, req.account.sub)
  if (!already) {
    db.prepare(
      'INSERT INTO server_members (server_id, account_id, is_admin, joined_at, access_expires_at) VALUES (?, ?, 0, ?, ?)'
    ).run(record.server_id, req.account.sub, Date.now(), record.expires_at || null)
    db.prepare('DELETE FROM access_ends WHERE server_id = ? AND account_id = ?').run(record.server_id, req.account.sub)
  }
  // Someone who is already in doesn't use the code up.
  if (record.single_use && !already) {
    db.prepare('UPDATE join_codes SET used = 1 WHERE id = ?').run(record.id)
  }

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(record.server_id)
  res.json({ id: server.id, name: server.name, isAdmin: !!(already && already.is_admin) })
})

// --- Joining (anonymous, via code — no account, no persistent membership) ---

app.post('/api/join', joinLimiter, (req, res) => {
  const body = req.body || {}
  const screenName = cleanLabel(body.screenName, 32)
  if (typeof body.code !== 'string' || !body.code.trim() || !screenName) {
    return res.status(400).json({ error: 'Code and screen name are required' })
  }

  const record = usableCode(res, body.code)
  if (!record) return

  // A guest can't borrow the name of an account (that includes accounts that
  // were muted or banned, who could otherwise come straight back unrecognized),
  // or of another guest who is currently in this server.
  if (db.prepare('SELECT 1 FROM accounts WHERE username = ? COLLATE NOCASE').get(screenName)) {
    return res.status(409).json({ error: 'That name belongs to an account. Pick a different screen name.' })
  }
  if (guestNameTaken(record.server_id, screenName)) {
    return res.status(409).json({ error: 'Someone here is already using that name. Pick a different one.' })
  }

  if (record.single_use) {
    db.prepare('UPDATE join_codes SET used = 1 WHERE id = ?').run(record.id)
  }

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(record.server_id)
  const identity = `guest-${randomBytes(9).toString('base64url')}`
  // A guest's access never outlasts the code it came from.
  const lifetimeMs = Math.min(12 * 60 * 60 * 1000, record.expires_at ? record.expires_at - Date.now() : Infinity)
  guestSessions.set(identity, {
    serverId: server.id,
    codeId: record.id,
    name: screenName,
    joinedAt: Date.now(),
    expiresAt: Date.now() + lifetimeMs,
    rooms: new Set()
  })
  res.json({
    guestToken: signGuest({
      serverId: server.id,
      screenName,
      identity,
      codeId: record.id,
      expiresInSeconds: lifetimeMs / 1000
    }),
    screenName,
    server: {
      id: server.id,
      name: server.name,
      isAdmin: false,
      channels: serializeTree(server.id, scopeOf(record)),
      presence: {} // a guest sees who is in their own space once they are in one
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
    ? db.prepare('SELECT server_id, mode, id AS channel_id FROM channels WHERE id = ?').get(id)
    : db
        .prepare(
          `SELECT channels.server_id AS server_id, rooms.mode AS mode, rooms.channel_id AS channel_id FROM rooms
           JOIN channels ON rooms.channel_id = channels.id WHERE rooms.id = ?`
        )
        .get(id)
}

// --- Scoped join codes -----------------------------------------------------
// A code can be limited to one channel (that channel and the rooms in it) or one
// room. No scope means the whole server, as every code was before. The server
// enforces this on the guest's voice token and presence check-in; hiding things
// in the tree is only a courtesy.

function scopeTargetExists(code) {
  if (!code.scope_type) return true
  const table = code.scope_type === 'channel' ? 'channels' : 'rooms'
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(code.scope_id)
}

function scopeAllows(code, type, spaceId) {
  if (!code.scope_type) return true
  if (code.scope_type === 'room') return type === 'room' && spaceId === code.scope_id
  if (type === 'channel') return spaceId === code.scope_id
  const row = db.prepare('SELECT channel_id FROM rooms WHERE id = ?').get(spaceId)
  return !!row && row.channel_id === code.scope_id
}

// What an admin reads: "General" for a channel, "General / Lobby" for a room.
function scopeName(scope) {
  if (!scope) return null
  if (scope.type === 'channel') {
    const ch = db.prepare('SELECT name FROM channels WHERE id = ?').get(scope.id)
    return ch ? ch.name : null
  }
  const room = db
    .prepare('SELECT rooms.name AS room, channels.name AS channel FROM rooms JOIN channels ON rooms.channel_id = channels.id WHERE rooms.id = ?')
    .get(scope.id)
  return room ? `${room.channel} / ${room.room}` : null
}

const scopeOf = (code) => (code.scope_type ? { type: code.scope_type, id: code.scope_id } : null)

// The code row behind a guest, or an error answer (and null) if it can no longer
// be used: revoked, or the channel or room it was for is gone.
function guestCodeOrRefuse(res, guest) {
  const code = db.prepare('SELECT * FROM join_codes WHERE id = ?').get(guest.codeId)
  if (!code || code.revoked) {
    res.status(403).json({ error: 'Your invite was revoked' })
    return null
  }
  if (!scopeTargetExists(code)) {
    res.status(403).json({ error: 'The room your invite was for no longer exists' })
    return null
  }
  return code
}

// A channel or room was deleted: codes limited to it stop working and the guests
// who came in with them are dropped (LiveKit first, then presence).
async function revokeCodesScopedTo({ serverId, channelId = null, roomIds = [] }) {
  const clauses = []
  const params = [serverId]
  if (channelId !== null) {
    clauses.push("(scope_type = 'channel' AND scope_id = ?)")
    params.push(channelId)
  }
  for (const rid of roomIds) {
    clauses.push("(scope_type = 'room' AND scope_id = ?)")
    params.push(rid)
  }
  if (clauses.length === 0) return
  const ids = db
    .prepare(`SELECT id FROM join_codes WHERE server_id = ? AND revoked = 0 AND (${clauses.join(' OR ')})`)
    .all(...params)
    .map((r) => r.id)
  if (ids.length === 0) return
  db.prepare(`UPDATE join_codes SET revoked = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
  await disconnectGuests((g) => ids.includes(g.codeId))
}

app.post('/api/voice/token', requireAuthOrGuest, asyncHandler(async (req, res) => {
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
    // The code they came in with must still be good: revoking it ends their access.
    // And it may be for one channel or room only.
    const code = guestCodeOrRefuse(res, req.guest)
    if (!code) return
    if (!scopeAllows(code, type, spaceId)) {
      return res.status(403).json({ error: "Your invite doesn't cover that space" })
    }
    identity = req.guest.identity
    name = req.guest.screenName
  } else {
    const membership = getMembership(space.server_id, req.account.sub)
    if (!membership) return notAMember(res, space.server_id, req.account.sub)
    identity = `acct-${req.account.sub}`
    name = req.account.username
    mutedOnJoin = !!membership.muted
  }

  const room = `s${space.server_id}-${type}-${spaceId}`
  const token = await mintLiveKitToken(identity, name, room, !mutedOnJoin)
  if (req.guest) {
    // Remember the room, so revoking the invite can pull them out of it. After a
    // restart this is rebuilt as guests ask for tokens again.
    ensureGuestSession(req.guest).rooms.add(room)
  }
  res.json({ token, livekitUrl: LIVEKIT_URL, room })
}))

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
    if (!getMembership(serverId, req.account.sub)) return notAMember(res, serverId, req.account.sub)
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
//
// Guests check in too, so members can see them and match them to the voice they
// hear. A guest can only check in to a space in the server their code belongs to,
// and what they get back is limited to the one space they are in.
app.post('/api/presence', presenceLimiter, requireAuthOrGuest, (req, res) => {
  const { type, id, avatarColor } = req.body || {}
  const spaceId = Number(id)
  if ((type !== 'channel' && type !== 'room') || !Number.isInteger(spaceId)) {
    return res.status(400).json({ error: 'type must be channel or room, and id a number' })
  }
  const serverId = serverIdForSpace(type, spaceId)
  if (!serverId) return res.status(404).json({ error: 'Not found' })

  if (req.guest) {
    if (req.guest.serverId !== serverId) {
      return res.status(403).json({ error: "You weren't invited to that server" })
    }
    const code = guestCodeOrRefuse(res, req.guest)
    if (!code) return
    if (!scopeAllows(code, type, spaceId)) {
      return res.status(403).json({ error: "Your invite doesn't cover that space" })
    }
    // Being checked in to a space is being in its voice room, so remember it: ending
    // this session (revoked, expired) then knows which room to drop them from.
    ensureGuestSession(req.guest).rooms.add(`s${serverId}-${type}-${spaceId}`)
    recordPresence({
      type,
      id: spaceId,
      serverId,
      who: req.guest.identity,
      name: req.guest.screenName,
      avatarColor,
      guest: true
    })
    return res.json({ presence: presenceForServer(serverId, spaceKey(type, spaceId)) })
  }

  if (!getMembership(serverId, req.account.sub)) return notAMember(res, serverId, req.account.sub)
  recordPresence({ type, id: spaceId, serverId, who: req.account.sub, name: req.account.username, avatarColor })
  res.json({ presence: presenceForServer(serverId) })
})

app.post('/api/presence/leave', requireAuthOrGuest, (req, res) => {
  removePresence(req.guest ? req.guest.identity : req.account.sub)
  res.json({ left: true })
})

// Who is here as a guest right now, for Admin Tools. Guests have no account, so
// they are not in the members list; this is the other half. Revoking the code a
// guest came in with is how they are removed.
app.get('/api/servers/:id/guests', requireAuth, requireServerAdmin, (req, res) => {
  const serverId = Number(req.params.id)
  const here = new Map() // identity -> 'channel:3' for guests currently checked in
  for (const [key, space] of presence) {
    if (space.serverId !== serverId) continue
    for (const [who, entry] of space.entries) if (entry.guest) here.set(who, key)
  }
  const guests = []
  for (const [identity, g] of liveGuests()) {
    if (g.serverId !== serverId) continue
    const code = db.prepare('SELECT code FROM join_codes WHERE id = ?').get(g.codeId)
    guests.push({
      identity,
      name: g.name,
      code: code ? code.code : null,
      codeId: g.codeId,
      joinedAt: g.joinedAt,
      expiresAt: g.expiresAt,
      space: here.get(identity) || null
    })
  }
  guests.sort((a, b) => a.joinedAt - b.joinedAt)
  res.json({ guests })
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

// Anything that slipped through becomes a plain error response. Unknown API
// paths and bad JSON bodies get proper JSON answers instead of Express's HTML.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body was not valid JSON' })
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request was too large' })
  console.error(`${req.method} ${req.originalUrl}:`, err)
  res.status(500).json({ error: 'Something went wrong on the server' })
})

// A bug in a background task shouldn't take everyone's voice and chat down with
// it. An exception outside any request leaves the process in an unknown state,
// though, so that one still exits and lets systemd start it fresh.
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err))
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err)
  process.exit(1)
})

const PORT = process.env.PORT || 4000
const wiped = wipeAllEphemeralOnStartup()
purgeOldAccessEnds()
setInterval(purgeOldAccessEnds, 60 * 60 * 1000).unref()
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
