#!/usr/bin/env node
// Encrypted backups, for the person who runs the server. See src/backup.js for how they work.
//
//   npm run backups -- setup                  make the backup phrase (shown once) and turn nightly backups on
//   npm run backups -- now                    write a backup now
//   npm run backups -- list                   the backups there are, and when the last one worked
//   npm run backups -- check <file>           open a backup with the phrase and confirm it is sound (writes nothing)
//   npm run backups -- restore <file> <folder>   restore into a NEW, EMPTY folder (never overwrites anything)
//   npm run backups -- new-phrase             make a new phrase for FUTURE backups (older ones still need their own)
//
// Run it on the machine, in the server's folder, as the user that runs the server.
import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { BackupError, backupSettings, checkBackup, keysFromPhrase, listBackups, makePhrase, readPublicKeyFile, readStatus, restoreBackup, runBackup, writePublicKeyFile } from './backup.js'

const out = (s = '') => process.stdout.write(s + '\n')
const settings = backupSettings()
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'

function usage() {
  out('Usage: npm run backups -- <command>')
  out('  setup                       make the backup phrase and turn on nightly backups')
  out('  now                         write a backup now')
  out('  list                        show the backups and when the last one worked')
  out('  check <file>                confirm a backup opens with your phrase (writes nothing)')
  out('  restore <file> <folder>     restore into a new, empty folder')
  out('  new-phrase                  make a new phrase for future backups')
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// A phrase is typed, not echoed back; it is never put on a command line or in the environment.
const askPhrase = () => ask('Your 12 word backup phrase: ')

async function setup({ replace }) {
  if (existsSync(settings.publicKeyPath) && !replace) {
    out('Backups are already set up. To make a new phrase for future backups, run: npm run backups -- new-phrase')
    return
  }
  const phrase = makePhrase()
  const words = phrase.split(' ')
  out('')
  out('Your backup phrase. Write it down now and keep it somewhere safe, away from this computer.')
  out('')
  words.forEach((w, i) => out(`  ${String(i + 1).padStart(2)}  ${w}`))
  out('')
  out('Nobody can recover this phrase for you, not the Rushlight developers and not anyone else. This computer does not keep it.')
  out('Without it, your backups cannot be opened. With it, anyone who has a backup file can open it, so keep it private.')
  out('')
  const positions = new Set()
  while (positions.size < 3) positions.add(randomInt(12))
  for (const p of [...positions].sort((a, b) => a - b)) {
    for (;;) {
      const answer = (await ask(`To check you saved it, type word number ${p + 1}: `)).toLowerCase()
      if (answer === words[p]) break
      out('That is not the word. Look at what you wrote down and try again.')
    }
  }
  writePublicKeyFile(settings.publicKeyPath, keysFromPhrase(phrase).publicRaw)
  out('')
  out('Backups are on. A backup is written every night at ' + settings.time + ' while the server is running, into:')
  out('  ' + settings.dir)
  out('The last 7 nights are kept, and the last one of each of the 4 weeks before that.')
  out('Also copy that folder somewhere else (another drive, a USB stick, a synced folder). The files are encrypted, so that is safe.')
}

async function now() {
  const done = await runBackup(settings)
  out(`Backup written: ${done.file} (${mb(done.size)})`)
  if (done.copied) out(`A copy was also written to ${done.copied}`)
}

function list() {
  const backups = listBackups(settings.dir)
  const status = readStatus(settings)
  if (!existsSync(settings.publicKeyPath)) out('Backups are not set up. Run: npm run backups -- setup')
  else out(`Backups are on (key ${readPublicKeyFile(settings.publicKeyPath).keyId.toString('hex')}). Nightly at ${settings.time}.`)
  if (status.lastSuccess) out(`Last backup that worked: ${new Date(status.lastSuccess).toLocaleString()} (${status.lastFile})`)
  if (status.lastError) out(`Last problem: ${status.lastError}`)
  if (!backups.length) out('No backups yet.')
  for (const b of backups) out(`  ${b.name}  ${mb(b.size)}`)
}

async function check(file) {
  if (!file) return usage()
  const manifest = await checkBackup({ file, phrase: await askPhrase() })
  out(`Good. This backup opens with your phrase and nothing in it has changed. Made ${new Date(manifest.createdAt).toLocaleString()}, ${manifest.files.map((f) => f.name).join(' and ')}.`)
}

async function restore(file, folder) {
  if (!file || !folder) return usage()
  const manifest = await restoreBackup({ file, phrase: await askPhrase(), to: folder })
  out(`Restored into ${folder}:`)
  for (const f of manifest.files) out(`  ${f.name === 'server.env' ? 'restored.env' : 'rushlight.db'}`)
  out('Stop the server, then put rushlight.db where the server keeps its database (it is the file named by DB_PATH, or rushlight.db in the server folder).')
  out('restored.env holds the secrets the old server used. Copy it over .env to keep people signed in and keep the Jellyfin link.')
  out('Start the server again and check that it comes up.')
}

try {
  const [command, a, b] = process.argv.slice(2)
  if (command === 'setup') await setup({ replace: false })
  else if (command === 'new-phrase') await setup({ replace: true })
  else if (command === 'now') await now()
  else if (command === 'list') list()
  else if (command === 'check') await check(a)
  else if (command === 'restore') await restore(a, b)
  else usage()
} catch (err) {
  out(err instanceof BackupError ? err.message : `Something went wrong: ${err.message}`)
  process.exitCode = 1
}
