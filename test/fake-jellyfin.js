// A stand-in for a Jellyfin server: just enough of its API for the Jellybox tests. It records every
// request, so tests can check what the Rushlight server asked for, and with which token.
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'

export const TOKEN = 'good-token-123'
const hex = (n) => String(n).padStart(32, '0')
export const IDS = { sunrise: hex(1), moon: hex(2), albumA: hex(10), a1: hex(11), a2: hex(12), a3: hex(13), a4: hex(14), artist: hex(20), bad: hex(99) }

const SONGS = {
  [IDS.sunrise]: { Id: IDS.sunrise, Name: 'Sunrise Song', Type: 'Audio', Artists: ['The Sunbeams'], Album: 'Sunny Album', AlbumId: hex(10), RunTimeTicks: 1e7 * 1.5 },
  [IDS.moon]: { Id: IDS.moon, Name: 'Moonlight', Type: 'Audio', Artists: ['Nightingale'], Album: 'Dark Album', RunTimeTicks: 1e7 * 1.5 },
  [IDS.a1]: { Id: IDS.a1, Name: 'Track One', Type: 'Audio', Artists: ['Album Band'], Album: 'Four Tracks', RunTimeTicks: 1.5e7 },
  [IDS.a2]: { Id: IDS.a2, Name: 'Track Two', Type: 'Audio', Artists: ['Album Band'], Album: 'Four Tracks', RunTimeTicks: 1.5e7 },
  [IDS.a3]: { Id: IDS.a3, Name: 'Track Three', Type: 'Audio', Artists: ['Album Band'], Album: 'Four Tracks', RunTimeTicks: 1.5e7 },
  [IDS.a4]: { Id: IDS.a4, Name: 'Track Four', Type: 'Audio', Artists: ['Album Band'], Album: 'Four Tracks', RunTimeTicks: 1.5e7 }
}
const ALBUM = { Id: IDS.albumA, Name: 'Four Tracks', Type: 'MusicAlbum', AlbumArtist: 'Album Band' }
const ARTIST = { Id: IDS.artist, Name: 'Album Band', Type: 'MusicArtist' }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

// dropFirstAfterBytes: the first request for each song is cut off after that many bytes, like a network blip.
export async function startFakeJellyfin({ seconds = 1.5, dropFirstAfterBytes = 0, dropAlways = false, ticks = 0 } = {}) {
  const dropped = new Set()
  // a short real audio file, made once with ffmpeg
  const audio = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ar', '44100', '-ac', '2', '-f', 'wav', 'pipe:1'], { maxBuffer: 1e8 })
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const auth = req.headers['x-emby-authorization'] || ''
    const token = (/Token="([^"]*)"/.exec(auth) || [])[1] || null
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token })
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const p = url.pathname
      if (p.startsWith('/redir/')) {
        res.writeHead(302, { location: `http://localhost:${server.address().port}/elsewhere` })
        return res.end()
      }
      if (p === '/System/Info/Public') return json(200, { ServerName: 'Fake Jelly', Version: '10.9.0' })
      if (p === '/Users/AuthenticateByName') {
        const b = JSON.parse(raw || '{}')
        return b.Username === 'owner' && b.Pw === 'pw' ? json(200, { AccessToken: TOKEN, User: { Id: 'u1' } }) : json(401, {})
      }
      if (token !== TOKEN) return json(401, {})
      if (p === '/System/Info') return json(200, { ServerName: 'Fake Jelly' })
      if (p === '/Items') {
        const q = url.searchParams
        const all = [...Object.values(SONGS), ALBUM, ARTIST].map((i) => (ticks && i.Type === 'Audio' ? { ...i, RunTimeTicks: ticks } : i)).map((i) => (ticks && i.Type === 'Audio' ? { ...i, RunTimeTicks: ticks } : i))
        if (q.get('searchTerm')) {
          const t = q.get('searchTerm').toLowerCase()
          return json(200, { Items: all.filter((i) => i.Name.toLowerCase().includes(t) || (i.Album || '').toLowerCase().includes(t)) })
        }
        if (q.get('Ids')) return json(200, { Items: q.get('Ids').split(',').map((i) => SONGS[i]).filter(Boolean).map((i) => (ticks ? { ...i, RunTimeTicks: ticks } : i)) })
        if (q.get('ParentId') === IDS.albumA || q.get('ArtistIds') === IDS.artist) return json(200, { Items: [SONGS[IDS.a1], SONGS[IDS.a2], SONGS[IDS.a3], SONGS[IDS.a4]] })
        return json(200, { Items: [] })
      }
      let m = /^\/Audio\/([0-9a-f]+)\/stream$/.exec(p)
      if (m) {
        if (!SONGS[m[1]]) return json(404, {})
        res.writeHead(200, { 'content-type': 'audio/wav' })
        if (dropFirstAfterBytes && (dropAlways || !dropped.has(m[1]))) {
          dropped.add(m[1])
          res.write(audio.subarray(0, dropFirstAfterBytes))
          return setTimeout(() => res.destroy(), 50)
        }
        return res.end(audio)
      }
      m = /^\/Items\/([0-9a-f]+)\/Images\/Primary$/.exec(p)
      if (m) {
        if (m[1] === IDS.bad) return json(404, {})
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(PNG)
      }
      json(404, {})
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    audioRequests: () => requests.filter((r) => r.path.startsWith('/Audio/')).length,
    stop: () => new Promise((r) => server.close(r))
  }
}
