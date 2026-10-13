// Songs longer than the Jellyfin request timeout, and streams that break part way: the song must still
// play through, not stop after a few seconds and jump to the next one. Real-time pacing is on here (the
// bug only shows when the stream sits idle while playback catches up).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, newAccount } from './helpers.js'
import { startFakeJellyfin, TOKEN } from './fake-jellyfin.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(100)
  }
}

async function setup({ seconds, drop = 0, always = false, failAudio = false, tagged = seconds, timeoutMs = '1500' }) {
  const jelly = await startFakeJellyfin({ seconds, dropFirstAfterBytes: drop, dropAlways: always, failAudio, ticks: tagged * 1e7 })
  const sinkDir = mkdtempSync(join(tmpdir(), 'jellybox-stream-'))
  const srv = await startServer({
    env: { JELLYBOX_TEST_SINK_DIR: sinkDir, JELLYBOX_REQUEST_TIMEOUT_MS: timeoutMs, JELLYBOX_RATE_MAX: '100', ACCOUNT_LIMIT: '1000', MUSIC_LINK_LIMIT: '1000' }
  })
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Long' }, owner.token)).data
  const ch = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'v', mode: 'both', persistent: true }, owner.token)).data
  assert.equal((await srv.call('PUT', `/api/servers/${s.id}/music`, { address: jelly.url, apiKey: TOKEN }, owner.token)).status, 200)
  await srv.call('POST', '/api/presence', { type: 'channel', id: ch.id }, owner.token)
  const file = join(sinkDir, `s${s.id}-channel-${ch.id}.pcm`)
  return {
    srv,
    jelly,
    owner,
    ch,
    pcm: () => (existsSync(file) ? statSync(file).size : 0),
    say: (text) => srv.call('POST', `/api/channels/${ch.id}/messages`, { text }, owner.token),
    bot: async () => (await srv.call('GET', `/api/channels/${ch.id}/messages`, undefined, owner.token)).data.messages.filter((m) => m.bot).map((m) => m.text),
    state: async () => (await srv.call('GET', `/api/music/channel/${ch.id}/state`, undefined, owner.token)).data,
    cleanup: async () => {
      await srv.stop()
      await jelly.stop()
      rmSync(sinkDir, { recursive: true, force: true })
    }
  }
}

// 8 seconds of 48 kHz mono 16-bit audio
const EIGHT_SECONDS = 768000

test('a song longer than the request timeout still plays all the way through', async () => {
  const w = await setup({ seconds: 8 }) // the timeout is 1.5 s
  try {
    await w.say('/play sunrise')
    await until(async () => (await w.state()).state === 'playing')
    await until(async () => (await w.state()).state === 'idle', 30000)
    assert.ok(w.pcm() >= EIGHT_SECONDS - 20000, 'only ' + w.pcm() + ' bytes of audio reached the room')
    // in one go: the timeout must not have cut the stream (the retry would paper over it, but it is a symptom)
    assert.equal(w.jelly.audioRequests(), 1, 'the stream was cut and had to be picked up again')
    const said = await w.bot()
    assert.ok(!said.some((t) => /tripped|couldn't|lost/i.test(t)), said.join(' | '))
  } finally {
    await w.cleanup()
  }
})

test('a stream that breaks part way is picked up again where it stopped', async () => {
  const w = await setup({ seconds: 8, drop: 300000, timeoutMs: '10000' })
  try {
    await w.say('/play sunrise')
    await until(async () => (await w.state()).state === 'playing')
    await until(async () => (await w.state()).state === 'idle', 30000)
    assert.ok(Math.abs(w.pcm() - EIGHT_SECONDS) < 40000, 'expected about 8 s of audio, got ' + w.pcm() + ' bytes')
    assert.equal(w.jelly.audioRequests(), 2, 'one request, then one to carry on')
    const said = await w.bot()
    assert.equal(said.filter((t) => /^Now playing/.test(t)).length, 1, said.join(' | '))
    assert.ok(!said.some((t) => /tripped|lost/i.test(t)), said.join(' | '))
  } finally {
    await w.cleanup()
  }
})

test('a stream that keeps breaking is given up on kindly, after a few tries, and the next song plays', async () => {
  const w = await setup({ seconds: 8, drop: 200000, always: true, timeoutMs: '10000' })
  try {
    await w.say('/play sunrise')
    await w.say('/play moonlight')
    await until(async () => (await w.bot()).some((t) => /lost the stream to "Sunrise Song"/.test(t)), 30000)
    // and moved on to the queued song instead of stopping
    await until(async () => (await w.bot()).some((t) => /lost the stream to "Moonlight"/.test(t)), 60000)
    await until(async () => (await w.state()).state === 'idle', 60000)
    // it tried each song again a few times (the first request plus five more), not once and not for ever
    const requests = w.jelly.audioRequests()
    assert.equal(requests, 12, 'requests for the two songs: ' + requests)
    await sleep(1500)
    assert.equal(w.jelly.audioRequests(), requests, 'it must stop asking once it has given up')
  } finally {
    await w.cleanup()
  }
})

test('a song shorter than its tagged length ends quietly, with no scare', async () => {
  const w = await setup({ seconds: 2, tagged: 8, timeoutMs: '10000' }) // tagged 8 s, really 2 s
  try {
    await w.say('/play sunrise')
    await until(async () => (await w.state()).state === 'playing')
    await until(async () => (await w.state()).state === 'idle', 30000)
    assert.ok(Math.abs(w.pcm() - 192000) < 20000, 'expected about 2 s of audio, got ' + w.pcm() + ' bytes')
    const said = await w.bot()
    assert.ok(!said.some((t) => /tripped|lost/i.test(t)), said.join(' | '))
  } finally {
    await w.cleanup()
  }
})

test('shuffle gives up kindly when song after song will not play, instead of trying for ever', async () => {
  const w = await setup({ seconds: 2, failAudio: true, timeoutMs: '10000' })
  try {
    await w.say('/shuffle')
    await until(async () => (await w.bot()).some((t) => /turned shuffle off/.test(t)), 30000)
    const st = await w.state()
    assert.equal(st.shuffleAll, false)
    const requests = w.jelly.audioRequests()
    assert.ok(requests >= 3 && requests <= 5, 'asked for the audio ' + requests + ' times')
    const said = await w.bot()
    assert.ok(said.filter((t) => /tripped/.test(t)).length <= 3, said.join(' | '))
    await sleep(2000)
    assert.equal(w.jelly.audioRequests(), requests, 'it must stop asking')
    assert.equal(w.pcm(), 0)
  } finally {
    await w.cleanup()
  }
})
