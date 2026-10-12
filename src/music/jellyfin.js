// A small Jellyfin client. It only ever talks to the one address the owner entered, only to
// Jellyfin's own search, cover and audio endpoints, and it follows redirects only within that
// origin. Cloud-metadata and link-local addresses are refused; LAN and local addresses are fine,
// since the owner runs the machine.
import dns from 'node:dns/promises'
import net from 'node:net'

const MAX_REDIRECTS = 3
const TIMEOUT_MS = 10000
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data'])

export class JellyfinError extends Error {
  constructor(message, kind = 'failed') {
    super(message)
    this.kind = kind // 'address' | 'auth' | 'unreachable' | 'failed'
  }
}

function blockedAddress(ip) {
  let v = ip.toLowerCase()
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) v = mapped[1]
  if (net.isIPv4(v)) return v.startsWith('169.254.') || v === '0.0.0.0'
  if (net.isIPv6(v)) return /^fe[89ab]/.test(v) || v === '::' || v.startsWith('fd00:ec2:')
  return true
}

// Returns a normalised base address ("http://host:8096" plus any path) or throws.
export async function checkAddress(raw) {
  let u
  try {
    u = new URL(typeof raw === 'string' ? raw.trim() : '')
  } catch {
    throw new JellyfinError('That does not look like an address. Try something like http://192.168.1.20:8096', 'address')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new JellyfinError('The address must start with http:// or https://', 'address')
  if (u.username || u.password) throw new JellyfinError('Leave the username and password out of the address; they go in their own boxes', 'address')
  u.search = ''
  u.hash = ''
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTS.has(host.toLowerCase())) throw new JellyfinError('That address is not allowed', 'address')
  let addrs
  if (net.isIP(host)) addrs = [host]
  else {
    try {
      addrs = (await dns.lookup(host, { all: true })).map((a) => a.address)
    } catch {
      throw new JellyfinError('Could not find that address. Check the spelling and that the machine is on', 'unreachable')
    }
  }
  if (addrs.length === 0 || addrs.some(blockedAddress)) throw new JellyfinError('That address is not allowed', 'address')
  return u.toString().replace(/\/$/, '')
}

export class Jellyfin {
  // token may be empty while signing in.
  constructor(base, token = '') {
    this.base = base
    this.token = token
  }

  headers(extra = {}) {
    const auth = `MediaBrowser Client="Rushlight", Device="Rushlight server", DeviceId="rushlight-jellybox", Version="1"${this.token ? `, Token="${this.token}"` : ''}`
    return { 'X-Emby-Authorization': auth, Accept: 'application/json', ...extra }
  }

  async request(path, { method = 'GET', body, headers } = {}) {
    const origin = new URL(this.base).origin
    let url = this.base + path
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res
      try {
        res = await fetch(url, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: this.headers({ ...(body ? { 'content-type': 'application/json' } : {}), ...headers }),
          body: body ? JSON.stringify(body) : undefined
        })
      } catch {
        throw new JellyfinError('Could not reach Jellyfin at that address', 'unreachable')
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), url)
        if (next.origin !== origin) throw new JellyfinError('Jellyfin tried to send us somewhere else, so we stopped', 'address')
        url = next.toString()
        continue
      }
      if (res.status === 401 || res.status === 403) throw new JellyfinError('Jellyfin did not accept those details', 'auth')
      return res
    }
    throw new JellyfinError('Jellyfin redirected too many times', 'address')
  }

  async json(path, opts) {
    const res = await this.request(path, opts)
    if (!res.ok) throw new JellyfinError(`Jellyfin answered ${res.status}`, 'failed')
    return res.json()
  }

  // Throws unless this really is Jellyfin and the credentials work. Returns { name, userId }.
  async ping() {
    let info
    try {
      info = await this.json('/System/Info/Public')
    } catch (err) {
      if (err instanceof JellyfinError && err.kind === 'failed') throw new JellyfinError('That address answered, but it does not look like Jellyfin', 'failed')
      throw err
    }
    if (!info || typeof info !== 'object' || !info.ServerName) throw new JellyfinError('That address answered, but it does not look like Jellyfin', 'failed')
    if (this.token) {
      // Needs a real token: this endpoint is refused without one.
      const res = await this.request('/System/Info')
      if (!res.ok) throw new JellyfinError('Jellyfin did not accept that API key or login', 'auth')
    }
    return { name: String(info.ServerName) }
  }

  // Exchanges a username and password for an access token. The password is not kept.
  async signIn(username, password) {
    const data = await this.json('/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password } })
    if (!data || !data.AccessToken) throw new JellyfinError('Jellyfin did not accept that username and password', 'auth')
    this.token = data.AccessToken
    return { token: data.AccessToken, userId: data.User && data.User.Id ? String(data.User.Id) : null }
  }

  static track(item) {
    return {
      id: String(item.Id),
      title: String(item.Name || 'Untitled'),
      artist: (item.Artists && item.Artists[0]) || item.AlbumArtist || '',
      album: item.Album || '',
      durationMs: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000) : 0
    }
  }

  // Songs, albums and artists matching a search, in the order Jellyfin ranks them.
  async search(term, limit = 8) {
    const q = new URLSearchParams({
      searchTerm: term,
      IncludeItemTypes: 'Audio,MusicAlbum,MusicArtist',
      Recursive: 'true',
      Limit: String(limit),
      Fields: 'AlbumArtist'
    })
    const data = await this.json(`/Items?${q}`)
    return (data.Items || []).map((it) => ({
      kind: it.Type === 'MusicAlbum' ? 'album' : it.Type === 'MusicArtist' ? 'artist' : 'song',
      id: String(it.Id),
      title: String(it.Name || 'Untitled'),
      artist: it.Type === 'MusicArtist' ? '' : (it.Artists && it.Artists[0]) || it.AlbumArtist || '',
      album: it.Type === 'Audio' ? it.Album || '' : ''
    }))
  }

  // The songs behind a result: the song itself, an album in track order, or an artist's songs.
  async tracksFor(kind, id, limit = 50) {
    if (kind === 'song') {
      const data = await this.json(`/Items?${new URLSearchParams({ Ids: id, IncludeItemTypes: 'Audio', Fields: 'AlbumArtist' })}`)
      return (data.Items || []).map(Jellyfin.track)
    }
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      Limit: String(limit),
      SortBy: 'Album,ParentIndexNumber,IndexNumber,SortName',
      Fields: 'AlbumArtist'
    })
    q.set(kind === 'album' ? 'ParentId' : 'ArtistIds', id)
    const data = await this.json(`/Items?${q}`)
    return (data.Items || []).map(Jellyfin.track)
  }

  // The audio of one song, as a web stream, or throws.
  async audio(id) {
    const res = await this.request(`/Audio/${encodeURIComponent(id)}/stream?static=true`, { headers: { Accept: '*/*' } })
    if (!res.ok || !res.body) throw new JellyfinError(`Jellyfin could not play that one (${res.status})`, 'failed')
    return res.body
  }

  // Cover art, or null.
  async cover(id) {
    const res = await this.request(`/Items/${encodeURIComponent(id)}/Images/Primary?maxWidth=300`, { headers: { Accept: 'image/*' } })
    if (!res.ok) return null
    const type = res.headers.get('content-type') || ''
    if (!/^image\/(jpeg|png|webp|gif)/.test(type)) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > 2 * 1024 * 1024 ? null : { type: type.split(';')[0], data: buf }
  }
}
