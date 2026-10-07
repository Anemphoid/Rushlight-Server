// Kick, ban and mute, proven end to end: what the member can still do afterwards,
// and exactly what the server tells LiveKit (via a stand-in that records the calls).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, newAccount, jwtClaims } from './helpers.js'
import { startFakeLiveKit } from './fake-livekit.js'

let fake
let srv

before(async () => {
  fake = await startFakeLiveKit()
  srv = await startServer({ env: { LIVEKIT_URL: fake.url } })
})
after(async () => {
  await srv.stop()
  await fake.stop()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check, ms = 5000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// An owner, a voice channel and a text channel, and a reusable code.
async function world() {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Mod' }, owner.token)).data
  const voice = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'voice', mode: 'voice' }, owner.token)).data
  const text = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'chat', mode: 'text' }, owner.token)).data
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  return { owner, s, voice, text, code, room: `s${s.id}-channel-${voice.id}` }
}

const freshCode = async (w) =>
  (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: false, expiresInMinutes: null }, w.owner.token)).data

// A member who has joined and is in the voice channel (token fetched, presence checked in).
async function memberInVoice(w) {
  const m = await newAccount(srv)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: w.code.code }, m.token)).status, 200)
  assert.equal((await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, m.token)).status, 200)
  assert.equal((await srv.call('POST', '/api/presence', { type: 'channel', id: w.voice.id }, m.token)).status, 200)
  return m
}

const base = (w) => `/api/servers/${w.s.id}/members`
const view = (w, token) => srv.call('GET', `/api/servers/${w.s.id}`, undefined, token)
const inPresence = async (w, memberId) =>
  ((await view(w, w.owner.token)).data.presence[`channel:${w.voice.id}`] || []).some((p) => p.id === memberId)

// The server reaches LiveKit's admin API, and answers only after it has.
const removalsFor = (m) => fake.removals().filter((r) => r.identity === `acct-${m.id}`)
const updatesFor = (m) => fake.callsTo('UpdateParticipant').filter((c) => c.body.identity === `acct-${m.id}`)
// LiveKit's JSON drops false values, so "can publish" is present only when true.
const canPublish = (call) => call.body.permission && call.body.permission.canPublish === true

test('kick: removes membership, disconnects from voice first, clears presence, and the member can rejoin with a fresh invite', async () => {
  const w = await world()
  const m = await memberInVoice(w)
  fake.reset()
  fake.onCall(async (call) => {
    if (call.method !== 'RemoveParticipant' || call.body.identity !== `acct-${m.id}`) return null
    return { stillPresentWhenDisconnected: await inPresence(w, m.id) }
  })
  try {
    assert.equal((await srv.call('POST', `${base(w)}/${m.id}/kick`, {}, w.owner.token)).status, 200)
  } finally {
    fake.onCall(null)
  }

  const removal = removalsFor(m)
  assert.equal(removal.length, 1)
  assert.equal(removal[0].room, w.room)
  assert.equal(removal[0].seen.stillPresentWhenDisconnected, true, 'presence was cleared before LiveKit was told')
  assert.equal(await inPresence(w, m.id), false)

  // access is gone everywhere
  assert.equal((await view(w, m.token)).status, 403)
  assert.equal((await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, m.token)).status, 403)
  assert.equal((await srv.call('GET', `/api/channels/${w.text.id}/messages`, undefined, m.token)).status, 403)
  assert.equal((await srv.call('POST', '/api/presence', { type: 'channel', id: w.voice.id }, m.token)).status, 403)
  assert.ok(!(await srv.call('GET', '/api/servers', undefined, m.token)).data.servers.some((x) => x.id === w.s.id))

  // a kick is not a ban: a fresh invite works, and the old reason is gone
  const fresh = await freshCode(w)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: fresh.code }, m.token)).status, 200)
  assert.equal((await view(w, m.token)).status, 200)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/bans`, undefined, w.owner.token)).data.bans.length, 0)
})

test('kick: someone idle (not in voice) is removed without needing LiveKit', async () => {
  const w = await world()
  const m = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: w.code.code }, m.token)
  fake.reset()
  assert.equal((await srv.call('POST', `${base(w)}/${m.id}/kick`, {}, w.owner.token)).status, 200)
  assert.equal((await view(w, m.token)).status, 403)
  assert.equal(removalsFor(m).length, 0)
})

test('kick: only drops them from this server, not from another they are in', async () => {
  const a = await world()
  const b = await world()
  const m = await newAccount(srv)
  for (const w of [a, b]) {
    await srv.call('POST', '/api/servers/join', { code: w.code.code }, m.token)
    await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, m.token)
    await srv.call('POST', '/api/presence', { type: 'channel', id: w.voice.id }, m.token)
  }
  fake.reset()
  await srv.call('POST', `${base(a)}/${m.id}/kick`, {}, a.owner.token)

  assert.deepEqual(removalsFor(m).map((r) => r.room), [a.room])
  assert.equal(await inPresence(a, m.id), false)
  assert.equal((await view(b, m.token)).status, 200)
  assert.equal(await inPresence(b, m.id), true)
})

test('ban: disconnects from voice, and refuses to rejoin with a fresh code, with a clear message', async () => {
  const w = await world()
  const m = await memberInVoice(w)
  fake.reset()
  assert.equal((await srv.call('POST', `${base(w)}/${m.id}/ban`, { reason: 'testing' }, w.owner.token)).status, 200)

  assert.equal(removalsFor(m).length, 1)
  assert.equal(removalsFor(m)[0].room, w.room)
  assert.equal(await inPresence(w, m.id), false)
  assert.equal((await view(w, m.token)).status, 403)
  const gone = await view(w, m.token)
  assert.equal(gone.data.reason, 'banned')

  // not the old code, a brand new one
  const fresh = await freshCode(w)
  const retry = await srv.call('POST', '/api/servers/join', { code: fresh.code }, m.token)
  assert.equal(retry.status, 403)
  assert.match(retry.data.error, /banned/i)
  assert.equal((await view(w, m.token)).status, 403)

  // and they can't slip back in as a guest under their own name
  const name = (await srv.call('GET', '/api/me', undefined, m.token)).data.username
  assert.equal((await srv.call('POST', '/api/join', { code: fresh.code, screenName: name })).status, 409)

  // unban lets them back in
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/bans/${m.id}`, undefined, w.owner.token)).status, 200)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: fresh.code }, m.token)).status, 200)
  assert.equal((await view(w, m.token)).status, 200)
})

test('ban: works on someone who already left, and is remembered', async () => {
  const w = await world()
  const m = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: w.code.code }, m.token)
  await srv.call('POST', `${base(w)}/${m.id}/kick`, {}, w.owner.token)
  assert.equal((await srv.call('POST', `${base(w)}/${m.id}/ban`, {}, w.owner.token)).status, 200)
  const fresh = await freshCode(w)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: fresh.code }, m.token)).status, 403)
})

test('mute: cuts publishing live while connected, and restores it on unmute', async () => {
  const w = await world()
  const m = await memberInVoice(w)
  fake.reset()

  const muted = await srv.call('PATCH', `${base(w)}/${m.id}`, { muted: true }, w.owner.token)
  assert.equal(muted.status, 200)
  assert.equal(muted.data.member.muted, true)
  let updates = updatesFor(m)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].body.room, w.room)
  assert.equal(canPublish(updates[0]), false, 'the live permission update still lets them publish')
  // listening is untouched, so they can still hear the room
  assert.equal(updates[0].body.permission.canSubscribe, true)
  // membership is untouched, and a fresh voice token cannot publish
  assert.equal((await view(w, m.token)).status, 200)
  const token = await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, m.token)
  assert.equal(jwtClaims(token.data.token).video.canPublish, false)
  assert.equal(removalsFor(m).length, 0)

  const unmuted = await srv.call('PATCH', `${base(w)}/${m.id}`, { muted: false }, w.owner.token)
  assert.equal(unmuted.data.member.muted, false)
  updates = updatesFor(m)
  assert.equal(updates.length, 2)
  assert.equal(canPublish(updates[1]), true)
  const token2 = await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, m.token)
  assert.equal(jwtClaims(token2.data.token).video.canPublish, true)
})

test('mute: someone not connected is muted for their next token, and a mute survives a rejoin', async () => {
  const w = await world()
  const m = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: w.code.code }, m.token)
  fake.reset()
  await srv.call('PATCH', `${base(w)}/${m.id}`, { muted: true }, w.owner.token)
  assert.equal(updatesFor(m).length, 0) // nobody to update live
  for (let i = 0; i < 2; i++) {
    const token = await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, m.token)
    assert.equal(jwtClaims(token.data.token).video.canPublish, false)
  }
})

test('mute: the right person is muted when several are in the room', async () => {
  const w = await world()
  const a = await memberInVoice(w)
  const b = await memberInVoice(w)
  fake.reset()
  await srv.call('PATCH', `${base(w)}/${a.id}`, { muted: true }, w.owner.token)
  assert.equal(updatesFor(a).length, 1)
  assert.equal(updatesFor(b).length, 0)
  const tokenB = await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, b.token)
  assert.equal(jwtClaims(tokenB.data.token).video.canPublish, true)
})

test('only admins can kick, ban or mute', async () => {
  const w = await world()
  const attacker = await memberInVoice(w)
  const victim = await memberInVoice(w)
  fake.reset()
  for (const [method, path, body] of [
    ['POST', `${base(w)}/${victim.id}/kick`, {}],
    ['POST', `${base(w)}/${victim.id}/ban`, {}],
    ['PATCH', `${base(w)}/${victim.id}`, { muted: true }]
  ]) {
    assert.equal((await srv.call(method, path, body, attacker.token)).status, 403, `${method} ${path}`)
  }
  assert.equal(fake.calls.length, 0, 'LiveKit was contacted for a refused action')
  assert.equal((await view(w, victim.token)).status, 200)
})
