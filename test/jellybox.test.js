// Jellybox, the music bot: linking a Jellyfin library, the slash commands and their replies, the
// panel routes, and leaving. Real server process, a stand-in Jellyfin that serves real audio, and a
// file in place of the LiveKit room (a test cannot listen to a room), so what is proven is the whole
// pipe up to the last step: the frames handed to the room. Publishing them to a real LiveKit room is
// not covered here.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'
import { startFakeJellyfin, TOKEN, IDS } from './fake-jellyfin.js'
import { checkAddress } from '../src/music/jellyfin.js'

let srv, jelly, sinkDir
before(async () => {
  jelly = await startFakeJellyfin({ seconds: 1.5 })
  sinkDir = mkdtempSync(join(tmpdir(), 'jellybox-sink-'))
  srv = await startServer({
    env: {
      JELLYBOX_TEST_SINK_DIR: sinkDir,
      JELLYBOX_LEAVE_MS: '1500',
      JELLYBOX_QUEUE_CAP: '3',
      JELLYBOX_RATE_MAX: '100',
      ACCOUNT_LIMIT: '1000',
      MUSIC_LIMIT: '1000',
      MUSIC_LINK_LIMIT: '1000'
    }
  })
})
after(async () => {
  await srv.stop()
  await jelly.stop()
  rmSync(sinkDir, { recursive: true, force: true })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(step)
  }
}

async function world({ link = true } = {}) {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Tunes' }, owner.token)).data
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const join = async () => {
    const a = await newAccount(srv)
    assert.equal((await srv.call('POST', '/api/servers/join', { code: code.code }, a.token)).status, 200)
    return a
  }
  const member = await join()
  const other = await join()
  const admin = await join()
  await srv.call('POST', `/api/servers/${s.id}/members/${admin.id}/admin`, { admin: true }, owner.token)
  const voice = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'jukebox', mode: 'both', persistent: true }, owner.token)).data
  const text = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'chatty', mode: 'text', persistent: true }, owner.token)).data
  const w = { owner, s, member, other, admin, voice, text }
  if (link) {
    const r = await srv.call('PUT', `/api/servers/${s.id}/music`, { address: jelly.url, apiKey: TOKEN }, owner.token)
    assert.equal(r.status, 200, JSON.stringify(r.data))
  }
  return w
}
const checkIn = (w, who, space = w.voice) => srv.call('POST', '/api/presence', { type: 'channel', id: space.id }, who.token)
const say = (w, who, text, space = w.voice) => srv.call('POST', `/api/channels/${space.id}/messages`, { text }, who.token)
const messages = async (w, space = w.voice) => (await srv.call('GET', `/api/channels/${space.id}/messages`, undefined, w.owner.token)).data.messages
const botSays = async (w, count = 1, space = w.voice) => {
  const got = await until(async () => {
    const bots = (await messages(w, space)).filter((m) => m.bot)
    return bots.length >= count ? bots : null
  })
  return got
}
const lastBot = async (w, after, space = w.voice) => {
  const got = await until(async () => {
    // the "Now playing ... (picked by ...)" announcements come separately from the reply to a command
    const bots = (await messages(w, space)).filter((m) => m.bot && m.id > after && !/\(picked by /.test(m.text))
    return bots.length ? bots : null
  })
  return got[got.length - 1].text
}
const lastId = async (w, space = w.voice) => {
  const all = await messages(w, space)
  return all.length ? all[all.length - 1].id : 0
}
async function ask(w, who, text, space = w.voice) {
  const before = await lastId(w, space)
  assert.equal((await say(w, who, text, space)).status, 200)
  return lastBot(w, before, space)
}
const roomName = (w) => `s${w.s.id}-channel-${w.voice.id}`
const pcm = (w) => {
  const f = join(sinkDir, roomName(w) + '.pcm')
  return existsSync(f) ? statSync(f).size : 0
}
const state = async (w, who) => (await srv.call('GET', `/api/music/channel/${w.voice.id}/state`, undefined, who.token)).data

// 1.5 seconds of 48 kHz mono 16-bit audio is 144000 bytes.
const SONG_BYTES = 144000

test('only the owner links, tests and unlinks; a bad link saves nothing and says why', async () => {
  const w = await world({ link: false })
  const url = `/api/servers/${w.s.id}/music`
  for (const who of [w.member, w.admin]) {
    assert.equal((await srv.call('PUT', url, { address: jelly.url, apiKey: TOKEN }, who.token)).status, 403)
    assert.equal((await srv.call('POST', url + '/test', {}, who.token)).status, 403)
    assert.equal((await srv.call('DELETE', url, undefined, who.token)).status, 403)
  }
  assert.deepEqual((await srv.call('GET', url, undefined, w.member.token)).data, { linked: false })

  // wrong key, wrong address, cloud metadata, not Jellyfin, nothing entered: none of them save anything
  const bad = [
    [{ address: jelly.url, apiKey: 'nope' }, 400],
    [{ address: 'not an address', apiKey: TOKEN }, 400],
    [{ address: 'ftp://127.0.0.1', apiKey: TOKEN }, 400],
    [{ address: 'http://169.254.169.254/latest', apiKey: TOKEN }, 400],
    [{ address: 'http://[fe80::1]:8096', apiKey: TOKEN }, 400],
    [{ address: 'http://metadata.google.internal', apiKey: TOKEN }, 400],
    [{ address: 'http://user:pw@127.0.0.1:1', apiKey: TOKEN }, 400],
    [{ address: 'http://127.0.0.1:1', apiKey: TOKEN }, 502],
    [{ address: jelly.url, username: 'owner', password: 'wrong' }, 400],
    [{ address: jelly.url }, 400],
    [{ address: 5, apiKey: TOKEN }, 400],
    [{ address: `${jelly.url}/redir`, apiKey: TOKEN }, 400]
  ]
  for (const [body, status] of bad) {
    const r = await srv.call('PUT', url, body, w.owner.token)
    assert.equal(r.status, status, JSON.stringify(body) + ' -> ' + JSON.stringify(r))
    assert.ok(r.data.error)
    assert.ok(!JSON.stringify(r.data).includes(TOKEN))
  }
  assert.deepEqual((await srv.call('GET', url, undefined, w.owner.token)).data, { linked: false })
})

test('a good link: an API key or a username and password; only the owner sees the address; the token is stored sealed and never sent out', async () => {
  const w = await world({ link: false })
  const url = `/api/servers/${w.s.id}/music`
  const byUser = await srv.call('PUT', url, { address: jelly.url + '/', username: 'owner', password: 'pw' }, w.owner.token)
  assert.equal(byUser.status, 200, JSON.stringify(byUser.data))
  assert.equal(byUser.data.kind, 'user')
  assert.equal(byUser.data.address, jelly.url)
  // the password was exchanged once and is not sent again
  assert.equal(jelly.requests.filter((r) => r.path === '/Users/AuthenticateByName').length >= 1, true)
  const byKey = await srv.call('PUT', url, { address: jelly.url, apiKey: TOKEN }, w.owner.token)
  assert.equal(byKey.status, 200)
  assert.equal(byKey.data.kind, 'apikey')

  const asOwner = (await srv.call('GET', url, undefined, w.owner.token)).data
  assert.deepEqual(asOwner, { linked: true, address: jelly.url, kind: 'apikey' })
  assert.deepEqual((await srv.call('GET', url, undefined, w.member.token)).data, { linked: true })
  // never in any answer a client gets
  for (const who of [w.owner, w.admin, w.member]) {
    for (const path of [url, `/api/servers/${w.s.id}`, `/api/servers/${w.s.id}/members`]) {
      assert.ok(!JSON.stringify((await srv.call('GET', path, undefined, who.token)).data).includes(TOKEN), path)
    }
  }
  assert.ok(!JSON.stringify(byKey.data).includes(TOKEN))
  assert.equal((await srv.call('POST', url + '/test', {}, w.owner.token)).data.ok, true)

  // stored sealed
  const db = new Database(srv.dbPath, { readonly: true })
  const row = db.prepare('SELECT * FROM server_music WHERE server_id = ?').get(w.s.id)
  db.close()
  assert.ok(row.token_enc && !row.token_enc.includes(TOKEN) && !Buffer.from(row.token_enc, 'base64').toString('latin1').includes(TOKEN))
  assert.ok(!srv.log().includes(TOKEN), 'the token must not appear in the server log')

  const gone = await srv.call('DELETE', url, undefined, w.owner.token)
  assert.deepEqual(gone.data, { linked: false })
  assert.deepEqual((await srv.call('GET', url, undefined, w.owner.token)).data, { linked: false })
})

test('every fetch goes only to the address the owner gave, and the token goes in a header, not the URL', async () => {
  jelly.requests.length = 0
  const w = await world()
  await checkIn(w, w.member)
  await ask(w, w.member, '/play sunrise')
  await until(() => jelly.requests.some((r) => r.path.startsWith('/Audio/')))
  for (const r of jelly.requests) {
    assert.ok(/^\/(System|Users|Items|Audio)(\/|$)/.test(r.path), r.path)
    assert.ok(!JSON.stringify(r.query).includes(TOKEN), 'token in a query string: ' + r.path)
  }
  assert.ok(jelly.requests.filter((r) => r.path.startsWith('/Audio/')).every((r) => r.token === TOKEN))
})

test('with nothing linked, /play says music is not set up, and the panel is hidden', async () => {
  const w = await world({ link: false })
  await checkIn(w, w.member)
  const reply = await ask(w, w.member, '/play sunrise')
  assert.match(reply, /linked a Jellyfin library|link a Jellyfin library|empty/i)
  assert.deepEqual(await state(w, w.member), { available: false, canControl: false })
  assert.equal(pcm(w), 0)
})

test('/play brings the bot in: the song streams through ffmpeg to the room, with a friendly reply and a now playing line', async () => {
  const w = await world()
  await checkIn(w, w.member)
  const before = await lastId(w)
  const reply = await ask(w, w.member, '/play sunrise')
  assert.match(reply, /Sunrise Song/)
  assert.match(reply, /Coming right up|Great pick|On it/)
  // the person's own message stays exactly as typed
  const mine = (await messages(w)).find((m) => m.text === '/play sunrise')
  assert.equal(mine.author, w.member.username)
  assert.equal(mine.bot, false)
  // the bot's messages are flagged and have no account
  const bots = (await messages(w)).filter((m) => m.bot)
  assert.ok(bots.every((m) => m.author === 'Jellybox' && m.authorId === null && m.redacted === false))
  assert.ok((await messages(w)).some((m) => m.bot && /^Now playing: Sunrise Song by The Sunbeams \(picked by /.test(m.text)))
  await until(() => pcm(w) >= SONG_BYTES - 4000)
  await until(async () => (await state(w, w.member)).state === 'idle')
  const size = pcm(w)
  assert.ok(Math.abs(size - SONG_BYTES) < 8000, 'expected about 1.5 s of audio, got ' + size + ' bytes')
  assert.ok(await lastId(w) > before)
})

test('not in the room, or a text-only space: a kind answer, and nothing plays', async () => {
  const w = await world()
  const away = await ask(w, w.other, '/play sunrise')
  assert.match(away, /voice room|join the voice chat/i)
  await checkIn(w, w.other, w.text)
  const inText = await ask(w, w.other, '/play sunrise', w.text)
  assert.match(inText, /voice rooms/i)
  assert.equal(pcm(w), 0)
  assert.equal((await state(w, w.member)).active, false)
})

test('search lists numbered results and /play picks from them; unknown names get a kind answer', async () => {
  const w = await world()
  await checkIn(w, w.member)
  const list = await ask(w, w.member, '/search sun')
  assert.match(list, /Here's what I found for "sun"/)
  assert.match(list, /1\. /)
  assert.match(list, /Sunrise Song by The Sunbeams/)
  assert.match(await ask(w, w.member, '/search zzzzqq'), /zzzzqq/)
  assert.match(await ask(w, w.member, '/search'), /Tell me what you'd like/)
  assert.match(await ask(w, w.other, '/play 1'), /search|voice/i) // no recent search, or not in the room
  await ask(w, w.member, '/search moon')
  assert.match(await ask(w, w.member, '/play 9'), /1 to \d/)
  assert.match(await ask(w, w.member, '/play 1'), /Moonlight/)
  assert.match(await ask(w, w.member, '/play qqqqnothing'), /qqqqnothing/)
})

test('queue, now playing and skip: open to everyone in the room', async () => {
  const w = await world()
  await checkIn(w, w.member)
  await checkIn(w, w.other)
  assert.match(await ask(w, w.other, '/queue'), /Nothing is playing|quiet in here/i)
  assert.match(await ask(w, w.other, '/skip'), /nothing playing|nothing for me to skip/i)
  await ask(w, w.member, '/play album band') // artist: four songs, 3 fit under the cap
  const q = await ask(w, w.other, '/queue')
  assert.match(q, /Now playing: Track One by Album Band/)
  assert.match(q, /Coming up \(\d+ songs?\)/)
  assert.match(q, new RegExp(`${w.member.username}`))
  assert.match(await ask(w, w.other, '/nowplaying'), /Now playing: Track/)
  assert.match(await ask(w, w.other, '/np'), /Now playing: Track/)
  assert.match(await ask(w, w.other, '/skip'), /Skipped Track One by Album Band|Track One by Album Band is out/)
  assert.match(await ask(w, w.other, '/nowplaying'), /Track Two|Track Three/)
})

test('one person can only line up so many songs; a full allowance gets a kind refusal', async () => {
  const w = await world()
  await checkIn(w, w.member)
  const first = await ask(w, w.member, '/play four tracks') // an album of 4, cap 3
  assert.match(first, /3 songs/)
  assert.match(first, /I could only fit 3 of those/)
  const more = await ask(w, w.member, '/play moonlight')
  assert.match(more, /already got 3 songs in the lineup/)
  // another person has their own allowance
  await checkIn(w, w.other)
  assert.match(await ask(w, w.other, '/play moonlight'), /Moonlight/)
})

test('the admin controls are for admins and the owner; everyone else is turned down kindly', async () => {
  const w = await world()
  await checkIn(w, w.member)
  await checkIn(w, w.admin)
  await ask(w, w.member, '/play four tracks')
  for (const cmd of ['/pause', '/resume', '/previous', '/volume 50', '/seek 0:01', '/clear', '/remove 1']) {
    const reply = await ask(w, w.member, cmd)
    assert.match(reply, new RegExp(`${cmd.split(' ')[0]} is one of the admin-only controls`), cmd)
    assert.match(reply, /\/play, \/search and \/skip/)
  }
  assert.match(await ask(w, w.admin, '/volume 40'), /Volume set to 40%|40% it is/)
  assert.match(await ask(w, w.admin, '/volume'), /40%/)
  assert.match(await ask(w, w.admin, '/volume 400'), /0 to 100/)
  assert.match(await ask(w, w.admin, '/pause'), /Paused|Holding it/)
  assert.match(await ask(w, w.admin, '/pause'), /already paused/)
  assert.match(await ask(w, w.admin, '/resume'), /back|left off/i)
  assert.match(await ask(w, w.admin, '/resume'), /not paused/)
  assert.match(await ask(w, w.admin, '/seek soon'), /\/seek 1:30/)
  assert.match(await ask(w, w.admin, '/seek 0:01'), /Jumped to 0:01/)
  assert.match(await ask(w, w.admin, '/remove 9'), /1 to \d/)
  assert.match(await ask(w, w.admin, '/remove 1'), /Took number 1 off the queue/)
  assert.match(await ask(w, w.admin, '/clear'), /Cleared \d+ song/)
  assert.match(await ask(w, w.admin, '/clear'), /already empty/)
})

test('/help is friendly and shows the right list; unknown slash text is just a message', async () => {
  const w = await world({ link: false })
  const member = await ask(w, w.member, '/help')
  assert.match(member, /Hi, I'm Jellybox/)
  assert.match(member, /\/play/)
  assert.match(member, /Admins can also/)
  assert.match(await ask(w, w.admin, '/help'), /Admin controls: \/pause/)
  // the owner and an admin are both admins here; a member is not
  const before = await lastId(w)
  await say(w, w.member, '/shrug')
  await say(w, w.member, '/ play sunrise')
  await sleep(600)
  assert.equal((await messages(w)).filter((m) => m.bot && m.id > before).length, 0)
})

test('rapid-fire commands are slowed down with a friendly note', async () => {
  const strict = await startServer({ env: { JELLYBOX_RATE_MAX: '4', JELLYBOX_TEST_SINK_DIR: sinkDir, ACCOUNT_LIMIT: '1000' } })
  try {
    const owner = await newAccount(strict)
    const s = (await strict.call('POST', '/api/servers', { name: 'Fast' }, owner.token)).data
    const ch = (await strict.call('POST', `/api/servers/${s.id}/channels`, { name: 'v', mode: 'both', persistent: true }, owner.token)).data
    await strict.call('PUT', `/api/servers/${s.id}/music`, { address: jelly.url, apiKey: TOKEN }, owner.token)
    await strict.call('POST', '/api/presence', { type: 'channel', id: ch.id }, owner.token)
    for (let i = 0; i < 8; i++) await strict.call('POST', `/api/channels/${ch.id}/messages`, { text: '/queue' }, owner.token)
    await until(async () => (await strict.call('GET', `/api/channels/${ch.id}/messages`, undefined, owner.token)).data.messages.some((m) => m.bot && /one at a time|quicker than my record player/.test(m.text)))
    // /help is never held back
    await strict.call('POST', `/api/channels/${ch.id}/messages`, { text: '/help' }, owner.token)
    await until(async () => (await strict.call('GET', `/api/channels/${ch.id}/messages`, undefined, owner.token)).data.messages.some((m) => m.bot && /I'm Jellybox/.test(m.text)))
  } finally {
    await strict.stop()
  }
})

test('the panel: anyone in the server sees it, only admins press its buttons, and only from inside the room', async () => {
  const w = await world()
  const st = await state(w, w.member)
  assert.equal(st.available, true)
  assert.equal(st.canControl, false)
  assert.equal((await state(w, w.admin)).canControl, true)
  assert.equal((await state(w, w.owner)).canControl, true)
  const url = `/api/music/channel/${w.voice.id}/control`
  assert.equal((await srv.call('POST', url, { action: 'pause' }, w.member.token)).status, 403)
  assert.equal((await srv.call('POST', url, { action: 'play-now', itemId: IDS.sunrise }, w.member.token)).status, 403)
  // an admin who is not in the room
  assert.equal((await srv.call('POST', url, { action: 'play-now', itemId: IDS.sunrise }, w.admin.token)).status, 409)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/music/search?q=sun`, undefined, w.member.token)).status, 403)
  const found = await srv.call('GET', `/api/servers/${w.s.id}/music/search?q=sun`, undefined, w.admin.token)
  assert.equal(found.status, 200)
  assert.ok(found.data.results.some((r) => r.kind === 'song' && r.title === 'Sunrise Song' && r.albumId === IDS.albumA))
  assert.ok((await srv.call('GET', `/api/servers/${w.s.id}/music/search?q=four`, undefined, w.admin.token)).data.results.some((r) => r.kind === 'album'))
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/music/search?q=`, undefined, w.admin.token)).status, 400)
  // a stranger gets nothing
  const stranger = await newAccount(srv)
  assert.equal((await srv.call('GET', `/api/music/channel/${w.voice.id}/state`, undefined, stranger.token)).status, 403)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/music/search?q=sun`, undefined, stranger.token)).status, 403)
})

test('the panel controls work: play now, queue, pause, resume, volume, seek, skip, remove, clear', async () => {
  const w = await world()
  await checkIn(w, w.admin)
  const url = `/api/music/channel/${w.voice.id}/control`
  const act = (body) => srv.call('POST', url, body, w.admin.token)
  assert.equal((await act({ action: 'pause' })).status, 409) // nothing playing yet
  assert.equal((await act({ action: 'play-now', itemId: 'not-an-id!' })).status, 400)
  const r = await act({ action: 'play-now', itemId: IDS.sunrise, kind: 'song' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const st = await until(async () => {
    const s = await state(w, w.member)
    return s.nowPlaying ? s : null
  })
  assert.equal(st.nowPlaying.title, 'Sunrise Song')
  assert.equal(st.nowPlaying.durationMs, 1500)
  assert.equal(st.active, true)
  assert.equal((await act({ action: 'queue', itemId: IDS.moon, kind: 'song' })).status, 200)
  assert.equal((await act({ action: 'queue', itemId: IDS.albumA, kind: 'album' })).status, 200)
  assert.equal((await state(w, w.member)).queue.length, 5)
  assert.equal((await act({ action: 'volume', value: 30 })).data.volume, 30)
  assert.equal((await act({ action: 'volume', value: 'loud' })).status, 400)
  assert.equal((await act({ action: 'seek', value: -5 })).status, 400)
  assert.equal((await act({ action: 'seek', value: 200 })).status, 200)
  assert.equal((await act({ action: 'remove', value: 99 })).status, 400)
  assert.equal((await act({ action: 'remove', value: 1 })).data.queue.length, 4)
  assert.equal((await act({ action: 'dance' })).status, 400)
  assert.equal((await act({ action: 'clear' })).data.queue.length, 0)
  assert.equal((await act({ action: 'skip' })).status, 200)
  // 'play album' puts the album first and moves on
  assert.equal((await act({ action: 'play-album', itemId: IDS.albumA })).status, 200)
  const now = await until(async () => {
    const s = await state(w, w.member)
    return s.nowPlaying && s.nowPlaying.title === 'Track One' ? s : null
  })
  assert.equal(now.queue.length, 3)
})

test('pause holds the audio and resume carries on; the volume changes the samples', async () => {
  const w = await world()
  await checkIn(w, w.admin)
  const url = `/api/music/channel/${w.voice.id}/control`
  const act = (body) => srv.call('POST', url, body, w.admin.token)
  await act({ action: 'volume', value: 100 }) // creates nothing: no bot yet
  assert.equal((await act({ action: 'play-now', itemId: IDS.sunrise })).status, 200)
  await act({ action: 'pause' })
  await sleep(500)
  const a = pcm(w)
  await sleep(500)
  assert.equal(pcm(w), a, 'no audio should flow while paused')
  assert.equal((await state(w, w.member)).state, 'paused')
  await act({ action: 'resume' })
  await until(() => pcm(w) > a)
  await until(async () => (await state(w, w.member)).state === 'idle')
  assert.ok(pcm(w) >= SONG_BYTES - 8000)

  // volume 0 makes silence
  await act({ action: 'volume', value: 0 })
  const before = pcm(w)
  await act({ action: 'play-now', itemId: IDS.moon })
  await until(async () => (await state(w, w.member)).state === 'idle' && pcm(w) > before + 100000)
  const buf = readFileSync(join(sinkDir, roomName(w) + '.pcm')).subarray(before)
  assert.ok(buf.every((b) => b === 0), 'volume 0 should be silent')
})

test('cover art goes through the server, to members only', async () => {
  const w = await world()
  const url = (id) => `${srv.url}/api/servers/${w.s.id}/music/cover/${id}`
  const get = (id, token) => fetch(url(id), { headers: token ? { authorization: 'Bearer ' + token } : {} })
  const ok = await get(IDS.sunrise, w.member.token)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.equal((await ok.arrayBuffer()).byteLength > 20, true)
  assert.equal((await get(IDS.bad, w.member.token)).status, 404)
  assert.equal((await get('zz!', w.member.token)).status, 400)
  assert.equal((await get(IDS.sunrise)).status, 401)
  const stranger = await newAccount(srv)
  assert.equal((await get(IDS.sunrise, stranger.token)).status, 403)
})

test('the bot leaves when the room empties, and when the owner unlinks', async () => {
  const w = await world()
  await checkIn(w, w.member)
  await ask(w, w.member, '/play sunrise')
  await until(async () => (await state(w, w.member)).active)
  await srv.call('POST', '/api/presence/leave', {}, w.member.token)
  await until(async () => !(await state(w, w.owner)).active, 10000)

  await checkIn(w, w.member)
  await ask(w, w.member, '/play sunrise')
  await until(async () => (await state(w, w.member)).active)
  const before = await lastId(w)
  await srv.call('DELETE', `/api/servers/${w.s.id}/music`, undefined, w.owner.token)
  assert.match(await lastBot(w, before), /unlinked/)
  assert.deepEqual(await state(w, w.member), { available: false, canControl: false })
  assert.match(await ask(w, w.member, '/queue'), /linked a Jellyfin|Jellyfin library/)
})

test('deleting the channel or the server sends the bot away, and the link goes with the server', async () => {
  const w = await world()
  await checkIn(w, w.member)
  await ask(w, w.member, '/play sunrise')
  await until(async () => (await state(w, w.member)).active)
  const leftMarker = join(sinkDir, roomName(w) + '.left') // the test sink leaves this behind when the bot disconnects
  assert.equal(existsSync(leftMarker), false)
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/channels/${w.voice.id}`, undefined, w.owner.token)).status, 200)
  await until(() => existsSync(leftMarker))
  const w2 = await world()
  await checkIn(w2, w2.member)
  await ask(w2, w2.member, '/play sunrise')
  const del = await srv.call('DELETE', `/api/servers/${w2.s.id}`, { password: 'password123' }, w2.owner.token)
  assert.equal(del.status, 200, JSON.stringify(del.data))
  const db = new Database(srv.dbPath, { readonly: true })
  const left = db.prepare('SELECT COUNT(*) AS n FROM server_music WHERE server_id IN (?, ?)').get(w2.s.id, -1).n
  db.close()
  assert.equal(left, 0)
})

test('the bot name is reserved, and a deleted account is not mistaken for the bot', async () => {
  const r = await srv.call('POST', '/api/register', { username: 'JELLYBOX', password: 'password123' })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /reserved/)
  const w = await world()
  await say(w, w.other, 'hello')
  const del = await srv.call('DELETE', '/api/me', { password: 'password123' }, w.other.token)
  assert.equal(del.status, 200)
  const msgs = await messages(w)
  const redacted = msgs.find((m) => m.redacted)
  assert.ok(redacted)
  assert.notEqual(redacted.bot, true)
})

test('addresses: cloud-metadata and link-local are refused, LAN and local are allowed', async () => {
  for (const bad of ['http://169.254.169.254/', 'http://169.254.0.5:8096', 'http://[fe80::1]/', 'http://[::ffff:169.254.169.254]/', 'http://metadata.google.internal/', 'ftp://127.0.0.1', 'http://u:p@127.0.0.1/', 'nonsense']) {
    await assert.rejects(checkAddress(bad), (e) => e.kind === 'address', bad)
  }
  for (const good of ['http://127.0.0.1:8096', 'http://10.0.0.5:8096/jelly', 'http://192.168.1.20:8096', 'http://[::1]:8096']) {
    assert.ok(await checkAddress(good), good)
  }
  assert.equal(await checkAddress('http://127.0.0.1:8096/jelly/?x=1#y'), 'http://127.0.0.1:8096/jelly')
})

test('Jellybox shows in the tree like another person in its room, flagged as a bot, and leaves it when it leaves', async () => {
  const w = await world()
  const tree = async (who) => (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, who.token)).data.presence
  const key = `channel:${w.voice.id}`
  await checkIn(w, w.member)
  assert.deepEqual((await tree(w.owner))[key].map((p) => p.name), [w.member.username])
  await ask(w, w.member, '/play sunrise')
  const people = (await tree(w.owner))[key]
  const bot = people.find((p) => p.bot)
  assert.deepEqual(bot, { id: 'jellybox', name: 'Jellybox', avatarColor: null, avatarUpdatedAt: null, bot: true })
  assert.equal(people.filter((p) => !p.bot).length, 1)
  assert.equal(people.find((p) => p.name === w.member.username).bot, undefined)
  // the check-in answer shows it too
  const checkin = (await checkIn(w, w.member)).data.presence
  assert.ok(checkin[key].some((p) => p.bot))
  // other rooms are not affected
  assert.ok(!((await tree(w.owner))[`channel:${w.text.id}`] || []).some((p) => p.bot))
  // it is not a person: it does not keep an ephemeral room "occupied" after everyone has left
  await srv.call('POST', '/api/presence/leave', {}, w.member.token)
  await until(async () => !((await tree(w.owner))[key] || []).some((p) => p.bot), 10000)
})
