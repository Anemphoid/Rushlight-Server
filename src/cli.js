#!/usr/bin/env node
// The command line tool for the person who runs the server machine. It exists for one case: a server whose only admin is
// its owner, and the owner has vanished, so nobody can start a claim in the app and the server would be lost for good.
// It names a new owner. It refuses when the server has any other admin (they vote instead), it applies the same dormancy
// test as the app (OWNER_DORMANT_MS, 90 days by default), it needs the server's name typed to confirm, it writes a loud
// line to the log and it shows every member a notice naming the new owner. It reads no message and touches no account's
// password, recovery key or device keys: it only changes who the owner is.
//
//   node src/cli.js servers
//   node src/cli.js set-owner <server id> <username> [--yes]
//
// Run it on the machine, in the server's folder, as the user that runs the server (it uses the same .env and database).
import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { db } from './db.js'
import { DAY, OWNER_DORMANT_MS, ownerOf, ownerSeenAt, isDormant, otherAdmins, addNotice, moveOwnership } from './ownership.js'

const out = (s = '') => process.stdout.write(s + '\n')
const days = (ms) => Math.floor(ms / DAY)

function usage() {
  out('Usage:')
  out('  node src/cli.js servers                              list servers, their owners and when the owner was last seen')
  out('  node src/cli.js set-owner <server id> <username>     name a new owner (only when the owner is its only admin and has been gone a long time)')
  out('Add --yes to skip the question that asks you to type the server name.')
}

export function listServers() {
  const rows = db.prepare('SELECT id FROM servers ORDER BY id').all()
  for (const { id } of rows) {
    const o = ownerOf(db, id)
    const admins = otherAdmins(db, id)
    const members = db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?').get(id).n
    const gone = Date.now() - ownerSeenAt(o)
    out(`#${id}  ${o.server_name}  owner: ${o.owner_name}, last seen ${days(gone)} day(s) ago${isDormant(o) ? ' (dormant)' : ''}; ${admins.length} other admin(s); ${members} member(s)`)
  }
  if (!rows.length) out('No servers.')
}

// Checks everything and, if all is well, makes the change. Returns { ok, message }. `confirm` is asked the server's name.
export async function setOwner({ serverId, username, confirm }) {
  const o = ownerOf(db, serverId)
  if (!o) return { ok: false, message: `There is no server #${serverId}.` }
  const target = db
    .prepare('SELECT a.id, a.username FROM server_members sm JOIN accounts a ON a.id = sm.account_id WHERE sm.server_id = ? AND a.username = ? COLLATE NOCASE')
    .get(serverId, username)
  if (!target) return { ok: false, message: `${username} is not a member of "${o.server_name}".` }
  if (target.id === o.owner_id) return { ok: false, message: `${target.username} already owns "${o.server_name}".` }
  const admins = otherAdmins(db, serverId)
  if (admins.length > 0) {
    return {
      ok: false,
      message: `"${o.server_name}" has other admins (${admins.map((a) => a.username).join(', ')}). They can start a claim in the app, and a majority of them decides. This tool is only for a server whose owner is its only admin.`
    }
  }
  if (!isDormant(o)) {
    return {
      ok: false,
      message: `${o.owner_name} was last seen ${days(Date.now() - ownerSeenAt(o))} day(s) ago. This tool needs the owner to have been gone for at least ${days(OWNER_DORMANT_MS)} days.`
    }
  }
  if (confirm && !(await confirm(o.server_name))) return { ok: false, message: 'Not confirmed. Nothing was changed.' }
  const gone = days(Date.now() - ownerSeenAt(o))
  moveOwnership(db, { serverId, toId: target.id, via: 'operator', note: `by the person who runs the server, owner unseen for ${gone} days` })
  addNotice(
    db,
    serverId,
    'owner_changed',
    `${target.username} is now the owner of this server. The previous owner, ${o.owner_name}, had not been seen for ${gone} days, and the person who runs this server named a new owner because nobody else could. ${o.owner_name} is still an admin.`
  )
  const line = `OWNER OF SERVER #${serverId} "${o.server_name}" CHANGED BY THE OPERATOR: ${o.owner_name} -> ${target.username} (owner unseen for ${gone} days)`
  console.warn('*** ' + line + ' ***')
  return { ok: true, message: line }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const yes = rest.includes('--yes')
  const args = rest.filter((a) => a !== '--yes')
  if (cmd === 'servers') return listServers()
  if (cmd === 'set-owner' && args.length === 2 && /^\d+$/.test(args[0])) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const confirm = yes
      ? null
      : async (name) => {
          const answer = await rl.question(`This makes ${args[1]} the owner of "${name}" and tells every member. Type the server's name to go on: `)
          return answer.trim() === name
        }
    const result = await setOwner({ serverId: Number(args[0]), username: args[1], confirm })
    rl.close()
    out(result.message)
    if (!result.ok) process.exitCode = 1
    return
  }
  usage()
  process.exitCode = cmd ? 2 : 0
}

// run only when started directly, so tests can import setOwner
import { fileURLToPath } from 'node:url'
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
}
