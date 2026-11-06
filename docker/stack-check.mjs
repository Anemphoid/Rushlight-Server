// Checks a running Rushlight stack (made by deploy/rushlight) the way a person would use it: make two accounts, put them in
// one voice channel, have one play a tone and see that the other HEARS it, through the real LiveKit over the network address
// the stack was set up for. Run it with the server's own dependencies:  node docker/stack-check.mjs http://ADDRESS:PORT
import { Room, AudioSource, AudioFrame, AudioStream, LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind, RoomEvent } from '@livekit/rtc-node'

const base = process.argv[2]
// Optional: connect to LiveKit here instead of the address the server hands out (Public mode's address is https with a certificate
// made for the test; the voice itself still travels over the network address the stack was set up for).
const connectUrl = process.argv[3]
if (!base) throw new Error('usage: node docker/stack-check.mjs http://ADDRESS:PORT')
let failed = false
const pass = (m) => console.log('  ok   ' + m)
const fail = (m) => {
  console.error('  FAIL ' + m)
  failed = true
}

async function call(method, path, body, token) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`)
  return data
}

const suffix = Math.random().toString(36).slice(2, 8)
const mia = await call('POST', '/api/register', { username: 'mia' + suffix, password: 'password123' })
const noah = await call('POST', '/api/register', { username: 'noah' + suffix, password: 'password123' })
const server = await call('POST', '/api/servers', { name: 'Stack check' }, mia.token)
const code = await call('POST', `/api/servers/${server.id}/codes`, { singleUse: false, expiresInMinutes: null }, mia.token)
await call('POST', '/api/servers/join', { code: code.code }, noah.token)
const channel = await call('POST', `/api/servers/${server.id}/channels`, { name: 'Lounge', mode: 'both', persistent: true }, mia.token)
pass('two accounts, a server and a voice channel made')

const tokenFor = (who) => call('POST', '/api/voice/token', { type: 'channel', id: channel.id }, who.token)
const [miaTok, noahTok] = [await tokenFor(mia), await tokenFor(noah)]
const expectedHost = new URL(base).hostname
if (new URL(miaTok.livekitUrl).hostname === expectedHost) pass(`clients are told to reach voice at ${miaTok.livekitUrl}`)
else fail(`voice address ${miaTok.livekitUrl} is not the address used to reach the server (${expectedHost})`)

const rooms = []
async function join(tok) {
  const room = new Room()
  rooms.push(room)
  await room.connect(connectUrl || tok.livekitUrl, tok.token, { autoSubscribe: true, dynacast: false })
  return room
}

const SAMPLE_RATE = 48000
const FRAME = 480
try {
  const miaRoom = await join(miaTok)
  const noahRoom = await join(noahTok)
  pass('both joined the voice room')

  const heard = new Promise((resolve) => {
    noahRoom.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return
      resolve(
        (async () => {
          let energy = 0
          let frames = 0
          for await (const frame of new AudioStream(track, SAMPLE_RATE, 1)) {
            let sum = 0
            for (let i = 0; i < frame.data.length; i++) sum += frame.data[i] * frame.data[i]
            energy = Math.max(energy, Math.sqrt(sum / frame.data.length))
            if (++frames > 300) break
          }
          return energy
        })()
      )
    })
  })

  const source = new AudioSource(SAMPLE_RATE, 1)
  const track = LocalAudioTrack.createAudioTrack('tone', source)
  await miaRoom.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }))
  let t = 0
  const pump = setInterval(() => {
    const samples = new Int16Array(FRAME)
    for (let i = 0; i < FRAME; i++) samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * t++) / SAMPLE_RATE) * 12000)
    source.captureFrame(new AudioFrame(samples, SAMPLE_RATE, 1, FRAME)).catch(() => {})
  }, 10)

  const energy = await Promise.race([heard, new Promise((r) => setTimeout(() => r(-1), 25000))])
  clearInterval(pump)
  if (energy > 500) pass(`one person hears the other (tone level ${Math.round(energy)})`)
  else fail(energy < 0 ? 'nobody heard anything within 25 seconds (voice does not reach the other person)' : `the audio was silent (level ${Math.round(energy)})`)
} catch (e) {
  fail('voice: ' + (e && e.message ? e.message : e))
} finally {
  for (const r of rooms) await r.disconnect().catch(() => {})
}
if (failed) process.exit(1)
console.log('All stack checks passed.')
process.exit(0)
