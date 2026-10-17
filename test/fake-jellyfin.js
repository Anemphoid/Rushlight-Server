// A stand-in for a Jellyfin server: just enough of its API for the Jellybox tests. It records every
// request, so tests can check what the Rushlight server asked for, and with which token.
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'

export const TOKEN = 'good-token-123'
const hex = (n) => String(n).padStart(32, '0')
export const IDS = { sunrise: hex(1), moon: hex(2), digits: hex(3), albumA: hex(10), a1: hex(11), a2: hex(12), a3: hex(13), a4: hex(14), albumSunny: hex(15), albumDark: hex(16), artist: hex(20), artistNight: hex(21), artistSun: hex(22), bad: hex(99) }

const SONGS = {
  [IDS.sunrise]: { Id: IDS.sunrise, Name: 'Sunrise Song', Type: 'Audio', Artists: ['The Sunbeams'], Album: 'Sunny Album', AlbumId: hex(10), RunTimeTicks: 1e7 * 1.5 },
  [IDS.moon]: { Id: IDS.moon, Name: 'Moonlight', Type: 'Audio', Artists: ['Nightingale'], Album: 'Dark Album', RunTimeTicks: 1e7 * 1.5 },
  [IDS.digits]: { Id: IDS.digits, Name: '1999', Type: 'Audio', Artists: ['Nightingale'], Album: 'Dark Album', AlbumId: hex(16), RunTimeTicks: 1.5e7 },
  [IDS.a1]: { Id: IDS.a1, Name: 'Track One', Type: 'Audio', Artists: ['Album Band'], Album: 'Four Tracks', RunTimeTicks: 1.5e7 },
  [IDS.a2]: { Id: IDS.a2, Name: 'Track Two', Type: 'Audio', Artists: ['Album Band'], Album: 'Four Tracks', RunTimeTicks: 1.5e7 },
  [IDS.a3]: { Id: IDS.a3, Name: 'Track Three', Type: 'Audio', Artists: ['Album Band'], Album: 'Four Tracks', RunTimeTicks: 1.5e7 },
  [IDS.a4]: { Id: IDS.a4, Name: 'Track Four', Type: 'Audio', Artists: ['Album Band'], Album: 'Four Tracks', RunTimeTicks: 1.5e7 }
}
const ALBUM = { Id: IDS.albumA, Name: 'Four Tracks', Type: 'MusicAlbum', AlbumArtist: 'Album Band' }
const ARTIST = { Id: IDS.artist, Name: 'Album Band', Type: 'MusicArtist' }
const ARTISTS = [ARTIST, { Id: IDS.artistNight, Name: 'Nightingale', Type: 'MusicArtist' }, { Id: IDS.artistSun, Name: 'The Sunbeams', Type: 'MusicArtist' }]
const ALBUMS = [
  ALBUM,
  { Id: IDS.albumSunny, Name: 'Sunny Album', Type: 'MusicAlbum', AlbumArtist: 'The Sunbeams' },
  { Id: IDS.albumDark, Name: 'Dark Album', Type: 'MusicAlbum', AlbumArtist: 'Nightingale' }
]
const ALBUMS_OF = { [IDS.artist]: [IDS.albumA], [IDS.artistNight]: [IDS.albumDark], [IDS.artistSun]: [IDS.albumSunny] }
// alphabetical browsing: sorted by name, filtered by first letter, paged
function page(list, q) {
  let items = [...list].sort((a, b) => a.Name.localeCompare(b.Name))
  const starts = q.get('NameStartsWith')
  if (starts) items = items.filter((i) => i.Name.toLowerCase().startsWith(starts.toLowerCase()))
  if (q.get('NameLessThan')) items = items.filter((i) => i.Name.toLowerCase() < q.get('NameLessThan').toLowerCase())
  const start = Number(q.get('StartIndex') || 0)
  const limit = Number(q.get('Limit') || 50)
  return { Items: items.slice(start, start + limit), TotalRecordCount: items.length, StartIndex: start }
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

// dropFirstAfterBytes: the first request for each song is cut off after that many bytes, like a network blip.
export async function startFakeJellyfin({ seconds = 1.5, dropFirstAfterBytes = 0, dropAlways = false, failAudio = false, ticks = 0 } = {}) {
  const dropped = new Set()
  // a short real audio file, made once with ffmpeg
  const audio = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ar', '44100', '-ac', '2', '-f', 'wav', 'pipe:1'], { maxBuffer: 1e8 })
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    // like Jellyfin 12: only the standard Authorization header counts; the legacy ones are ignored
    const auth = req.headers['authorization'] || ''
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
      if (p === '/Artists/AlbumArtists') return json(200, page(ARTISTS, url.searchParams))
      if (p === '/Items') {
        const q = url.searchParams
        const all = [...Object.values(SONGS), ...ALBUMS, ...ARTISTS].map((i) => (ticks && i.Type === 'Audio' ? { ...i, RunTimeTicks: ticks } : i))
        if (q.get('AlbumArtistIds')) return json(200, { Items: (ALBUMS_OF[q.get('AlbumArtistIds')] || []).map((id) => ALBUMS.find((a) => a.Id === id)) })
        if (q.get('SortBy') === 'SortName' && q.get('IncludeItemTypes') === 'MusicAlbum') return json(200, page(ALBUMS, q))
        if (q.get('SortBy') === 'SortName' && q.get('IncludeItemTypes') === 'Audio') return json(200, page(Object.values(SONGS), q))
        if (q.get('searchTerm')) {
          const t = q.get('searchTerm').toLowerCase()
          return json(200, { Items: all.filter((i) => i.Name.toLowerCase().includes(t) || (i.Album || '').toLowerCase().includes(t)) })
        }
        if (q.get('Ids')) return json(200, { Items: q.get('Ids').split(',').map((i) => SONGS[i]).filter(Boolean).map((i) => (ticks ? { ...i, RunTimeTicks: ticks } : i)) })
        const albumSongs = { [IDS.albumA]: [IDS.a1, IDS.a2, IDS.a3, IDS.a4], [IDS.albumSunny]: [IDS.sunrise], [IDS.albumDark]: [IDS.moon, IDS.digits] }
        if (albumSongs[q.get('ParentId')]) return json(200, { Items: albumSongs[q.get('ParentId')].map((id) => SONGS[id]) })
        if (q.get('ArtistIds') === IDS.artist) return json(200, { Items: [SONGS[IDS.a1], SONGS[IDS.a2], SONGS[IDS.a3], SONGS[IDS.a4]] })
        // a random mix, for shuffle: every song, in a different order each time
        if (q.get('SortBy') === 'Random') {
          const mix = Object.values(SONGS).sort(() => Math.random() - 0.5).slice(0, Number(q.get('Limit') || 10))
          return json(200, { Items: mix, TotalRecordCount: Object.keys(SONGS).length })
        }
        return json(200, { Items: [] })
      }
      let m = /^\/Audio\/([0-9a-f]+)\/stream$/.exec(p)
      if (m) {
        if (!SONGS[m[1]]) return json(404, {})
        if (failAudio) return json(500, {})
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
