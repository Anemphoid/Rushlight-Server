// Who owns a server, and how that can change. The owner hands it over (index.js), or, when the owner has vanished, the
// admins vote (a claim), or, for a server whose only admin is the owner, the person who runs the server machine names a new
// owner with the command line tool (cli.js). All three end in moveOwnership, which records what happened. The periods are
// settings so a test can run the whole flow in a few seconds; the defaults are the ones that ship.
export const DAY = 24 * 60 * 60 * 1000
export const OWNER_DORMANT_MS = Number(process.env.OWNER_DORMANT_MS) || 90 * DAY // no request from the owner's sessions for this long
export const SUCCESSION_NOTICE_MS = Number(process.env.SUCCESSION_NOTICE_MS) || 14 * DAY // a claim waits this long, whatever the votes
export const NOTICE_KEEP_MS = Number(process.env.NOTICE_KEEP_MS) || 14 * DAY // how long members are shown an ownership notice

export function ownerOf(db, serverId) {
  return db
    .prepare(
      `SELECT s.id AS server_id, s.name AS server_name, s.owner_id, a.username AS owner_name, a.last_seen_at, a.created_at
       FROM servers s JOIN accounts a ON a.id = s.owner_id WHERE s.id = ?`
    )
    .get(serverId)
}

// When the owner's sessions last made a request, as a time. An account that was never seen counts from when it was made.
export const ownerSeenAt = (owner) => owner.last_seen_at || owner.created_at || 0
export const isDormant = (owner, now = Date.now()) => now - ownerSeenAt(owner) >= OWNER_DORMANT_MS

// The admins of a server other than its owner: the people who vote on a claim.
export function otherAdmins(db, serverId) {
  return db
    .prepare(
      `SELECT sm.account_id AS id, a.username FROM server_members sm
       JOIN accounts a ON a.id = sm.account_id JOIN servers s ON s.id = sm.server_id
       WHERE sm.server_id = ? AND sm.is_admin = 1 AND sm.account_id != s.owner_id ORDER BY sm.joined_at`
    )
    .all(serverId)
}

export const majorityOf = (n) => Math.floor(n / 2) + 1

export function addNotice(db, serverId, kind, text, now = Date.now(), keepMs = NOTICE_KEEP_MS) {
  db.prepare('INSERT INTO server_notices (server_id, kind, text, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(serverId, kind, text, now, now + keepMs)
}

// Makes `toId` the owner. The new owner is an admin, unmuted and without an access end; the old owner stays an admin. Any open
// claim is closed. Returns the previous owner's id. The caller has already checked who is allowed to do this.
export function moveOwnership(db, { serverId, toId, via, note = null, now = Date.now() }) {
  return db.transaction(() => {
    const from = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId).owner_id
    db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(toId, serverId)
    db.prepare('UPDATE server_members SET is_admin = 1, muted = 0, access_expires_at = NULL WHERE server_id = ? AND account_id = ?').run(serverId, toId)
    db.prepare('UPDATE server_members SET is_admin = 1 WHERE server_id = ? AND account_id = ?').run(serverId, from)
    db.prepare("UPDATE succession_claims SET status = 'cancelled', ended_at = ?, ended_reason = 'ownership_changed' WHERE server_id = ? AND status = 'open'").run(now, serverId)
    db.prepare('INSERT INTO ownership_log (server_id, from_owner_id, to_owner_id, via, at, note) VALUES (?, ?, ?, ?, ?, ?)').run(serverId, from, toId, via, now, note)
    return from
  })()
}
