// A stand-in for the LiveKit server's admin API (RoomService), so tests can see
// exactly which calls the Rushlight server makes: who it disconnects, who it
// mutes, which rooms it ends. LiveKit speaks JSON over HTTP at
// /twirp/livekit.RoomService/<Method>.
import { createServer } from 'node:http'

export async function startFakeLiveKit() {
  const calls = []
  let onCall = null // optional hook run when a call arrives, before it is answered

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', async () => {
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        // leave empty
      }
      const method = req.url.split('/').pop()
      const call = { method, body, at: Date.now() }
      if (onCall) {
        try {
          call.seen = await onCall(call)
        } catch (err) {
          call.seen = { error: String(err) }
        }
      }
      calls.push(call)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `ws://127.0.0.1:${port}`,
    calls,
    callsTo: (method) => calls.filter((c) => c.method === method),
    removals: () =>
      calls
        .filter((c) => c.method === 'RemoveParticipant')
        .map((c) => ({ room: c.body.room, identity: c.body.identity, seen: c.seen })),
    onCall: (fn) => (onCall = fn),
    reset: () => (calls.length = 0),
    stop: () => new Promise((resolve) => server.close(resolve))
  }
}
