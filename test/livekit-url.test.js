// The LiveKit address a client is handed follows the address it used to reach the server (so a moved server needs only the
// client's address changed), unless LIVEKIT_PUBLIC_URL says otherwise. Anything not on this network keeps the old behaviour.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startServer, newAccount } from './helpers.js'
import { livekitUrlForClient, checkPublicLivekitUrl } from '../src/livekit-url.js'

test('a plain ws:// address on this machine or network follows the host the client used, with LiveKit\'s port', () => {
  const url = (o) => livekitUrlForClient({ publicUrl: '', ...o })
  assert.equal(url({ livekitUrl: 'ws://192.168.68.70:7880', host: '192.168.70.15' }), 'ws://192.168.70.15:7880')
  assert.equal(url({ livekitUrl: 'ws://127.0.0.1:7880', host: '192.168.70.15' }), 'ws://192.168.70.15:7880')
  assert.equal(url({ livekitUrl: 'ws://localhost:7880', host: 'unison.local' }), 'ws://unison.local:7880')
  assert.equal(url({ livekitUrl: 'ws://[::1]:7880', host: '[fd7a::1]' }), 'ws://[fd7a::1]:7880')
  assert.equal(url({ livekitUrl: 'ws://10.0.0.5', host: '10.0.0.6' }), 'ws://10.0.0.6', 'no port stays no port')
})

test('LIVEKIT_PUBLIC_URL wins over everything', () => {
  assert.equal(livekitUrlForClient({ publicUrl: 'wss://livekit.example.com', livekitUrl: 'ws://127.0.0.1:7880', host: '192.168.70.15' }), 'wss://livekit.example.com')
})

test('a name, wss://, an https request or an odd host keeps LIVEKIT_URL as written', () => {
  const same = (o) => assert.equal(livekitUrlForClient({ publicUrl: '', ...o }), o.livekitUrl, JSON.stringify(o))
  same({ livekitUrl: 'ws://livekit.example.com:7880', host: '192.168.70.15' })
  same({ livekitUrl: 'wss://192.168.68.70:7881', host: '192.168.70.15' })
  same({ livekitUrl: 'ws://127.0.0.1:7880', host: '192.168.70.15', secure: true })
  same({ livekitUrl: 'ws://127.0.0.1:7880', host: 'evil.example/..' })
  same({ livekitUrl: 'ws://127.0.0.1:7880', host: undefined })
  same({ livekitUrl: 'not a url', host: '192.168.70.15' })
})

test('LIVEKIT_PUBLIC_URL is checked when the server starts', () => {
  assert.equal(checkPublicLivekitUrl(''), null)
  assert.equal(checkPublicLivekitUrl('wss://livekit.example.com'), 'wss://livekit.example.com')
  assert.throws(() => checkPublicLivekitUrl('https://livekit.example.com'), /ws:\/\//)
  assert.throws(() => checkPublicLivekitUrl('livekit'), /not an address/)
})

// ---- through a real server ----
const servers = []
after(async () => {
  for (const s of servers) await s.stop()
})
async function voiceRoom(env) {
  const srv = await startServer({ env })
  servers.push(srv)
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Hall' }, owner.token)).data
  const ch = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'Lounge', mode: 'voice' }, owner.token)).data
  // fetch will not let a script choose the Host header, and the whole point is what the client reached the server as
  const ask = (host) =>
    new Promise((resolve, reject) => {
      const u = new URL(srv.url)
      const body = JSON.stringify({ type: 'channel', id: ch.id })
      const req = http.request(
        { host: u.hostname, port: u.port, path: '/api/voice/token', method: 'POST', headers: { host, 'content-type': 'application/json', authorization: 'Bearer ' + owner.token, 'content-length': Buffer.byteLength(body) } },
        (res) => {
          let data = ''
          res.on('data', (d) => (data += d))
          res.on('end', () => resolve(JSON.parse(data)))
        }
      )
      req.on('error', reject)
      req.end(body)
    })
  return ask
}

test('the voice token carries the address the client reached the server at, with LiveKit\'s port', async () => {
  const ask = await voiceRoom({ LIVEKIT_URL: 'ws://192.168.68.70:7880' })
  assert.equal((await ask('192.168.70.15:4000')).livekitUrl, 'ws://192.168.70.15:7880')
  assert.equal((await ask('unison.local:4000')).livekitUrl, 'ws://unison.local:7880')
  assert.equal((await ask('[fd7a:115c::1]:4000')).livekitUrl, 'ws://[fd7a:115c::1]:7880')
})

test('LIVEKIT_PUBLIC_URL is what clients get when it is set', async () => {
  const ask = await voiceRoom({ LIVEKIT_URL: 'ws://192.168.68.70:7880', LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com' })
  assert.equal((await ask('192.168.70.15:4000')).livekitUrl, 'wss://livekit.example.com')
})

test('a LiveKit on a name of its own is handed out as written', async () => {
  const ask = await voiceRoom({ LIVEKIT_URL: 'ws://livekit.example.com:7880' })
  assert.equal((await ask('192.168.70.15:4000')).livekitUrl, 'ws://livekit.example.com:7880')
})

test('a bad LIVEKIT_PUBLIC_URL stops the server from starting, with the reason', async () => {
  await assert.rejects(startServer({ env: { LIVEKIT_PUBLIC_URL: 'https://nope' } }), /LIVEKIT_PUBLIC_URL must start with ws/)
})
