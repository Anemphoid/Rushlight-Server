// Jellybox: the music bot. The owner links one Jellyfin library per server; people in a voice room
// ask for songs with slash commands typed in that room's chat, and the bot joins the room as its
// own participant. This file wires the pieces: the stored link, the per-room players and the commands.
import { Jellyfin, JellyfinError, checkAddress } from './jellyfin.js'
import { openToken, sealToken } from './secret.js'
import { makeSink } from './sinks.js'
import { Player } from './player.js'
import { bestMatch } from './match.js'
import { BOT_NAME, describe, fmtTime, say } from './voice.js'

export { BOT_NAME }
export { JellyfinError }

const COMMANDS = new Set(['play', 'search', 'queue', 'skip', 'nowplaying', 'np', 'pause', 'resume', 'previous', 'volume', 'seek', 'clear', 'remove', 'stop', 'shuffle', 'help'])
const ADMIN_COMMANDS = new Set(['shuffle', 'stop', 'pause', 'resume', 'previous', 'volume', 'seek', 'clear', 'remove'])
const QUEUE_CAP = () => Number(process.env.JELLYBOX_QUEUE_CAP) || 10
const QUEUE_MAX = 100
const RATE_WINDOW_MS = Number(process.env.JELLYBOX_RATE_WINDOW_MS) || 10000
const RATE_MAX = Number(process.env.JELLYBOX_RATE_MAX) || 6
const EMPTY_GRACE_MS = Number(process.env.JELLYBOX_LEAVE_MS) || 5000
const SEARCH_KEEP_MS = 5 * 60 * 1000
const ITEM_ID = /^[0-9a-fA-F-]{8,40}$/

export const isItemId = (v) => typeof v === 'string' && ITEM_ID.test(v)

export function parseCommand(text) {
  const m = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(typeof text === 'string' ? text.trim() : '')
  if (!m) return null
  const name = m[1].toLowerCase()
  if (!COMMANDS.has(name)) return null
  return { name: name === 'np' ? 'nowplaying' : name, arg: (m[2] || '').trim() }
}

export function parseSeek(arg) {
  const t = arg.trim()
  let m = /^(\d+):([0-5]?\d)$/.exec(t)
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000
  m = /^(\d+)$/.exec(t)
  if (m) return Number(m[1]) * 1000
  return null
}

export function createMusic({ db, livekit, postBotMessage, isOccupied, hasPresence }) {
  const players = new Map() // livekit room name -> { player, serverId, type, spaceId, emptySince }
  const searches = new Map() // `${accountId}|${room}` -> { at, results, q }
  const recent = new Map() // accountId -> [timestamps]

  // --- the stored link ---
  function getLink(serverId) {
    return db.prepare('SELECT server_id, address, token_enc, kind, linked_at FROM server_music WHERE server_id = ?').get(serverId) || null
  }
  function jfFor(serverId) {
    const link = getLink(serverId)
    if (!link) return { error: 'notLinked' }
    const token = openToken(link.token_enc)
    if (!token) return { error: 'brokenLink' }
    return { jf: new Jellyfin(link.address, token) }
  }

  // Throws JellyfinError and saves nothing unless the details work.
  async function link(serverId, { address, apiKey, username, password }) {
    const base = await checkAddress(address)
    let token
    let kind
    if (typeof apiKey === 'string' && apiKey.trim()) {
      token = apiKey.trim()
      kind = 'apikey'
    } else if (typeof username === 'string' && username && typeof password === 'string') {
      token = (await new Jellyfin(base).signIn(username, password)).token
      kind = 'user'
    } else {
      throw new JellyfinError('Enter an API key, or a username and password', 'address')
    }
    const jf = new Jellyfin(base, token)
    const info = await jf.ping()
    db.prepare(
      `INSERT INTO server_music (server_id, address, token_enc, kind, linked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET address = excluded.address, token_enc = excluded.token_enc, kind = excluded.kind, linked_at = excluded.linked_at`
    ).run(serverId, base, sealToken(token), kind, Date.now())
    return { address: base, kind, name: info.name }
  }

  async function test(serverId) {
    const found = jfFor(serverId)
    if (!found.jf) throw new JellyfinError('Nothing is linked, or the saved link can no longer be read', 'failed')
    await checkAddress(found.jf.base)
    return found.jf.ping()
  }

  async function unlink(serverId) {
    db.prepare('DELETE FROM server_music WHERE server_id = ?').run(serverId)
    await stopWhere((e) => e.serverId === serverId, say.unlinked())
  }

  // --- players ---
  async function stopWhere(pred, farewell) {
    for (const [room, e] of [...players]) {
      if (!pred(e)) continue
      players.delete(room)
      if (farewell) postBotMessage(e.type, e.spaceId, farewell)
      await e.player.stop().catch(() => {})
    }
  }

  function playerFor(serverId, type, spaceId) {
    const room = `s${serverId}-${type}-${spaceId}`
    let e = players.get(room)
    if (!e) {
      const player = new Player({
        roomName: room,
        sink: makeSink(room, livekit),
        jf: () => jfFor(serverId).jf || null,
        say: (text) => postBotMessage(type, spaceId, text)
      })
      e = { player, serverId, type, spaceId, emptySince: null }
      player.onConnected = () => postBotMessage(type, spaceId, say.joined())
      player.onFailed = () => {
        if (players.get(room) === e) players.delete(room)
      }
      players.set(room, e)
    }
    return e.player
  }

  // Called by the server's own sweep. The bot leaves once nobody is left in its room.
  function sweep() {
    const now = Date.now()
    for (const [room, e] of [...players]) {
      if (isOccupied(e.type, e.spaceId)) {
        e.emptySince = null
        continue
      }
      if (e.emptySince == null) e.emptySince = now
      else if (now - e.emptySince >= EMPTY_GRACE_MS) {
        players.delete(room)
        e.player.stop().catch(() => {})
      }
    }
  }

  const activeSpaces = (serverId) => [...players.values()].filter((e) => e.serverId === serverId).map((e) => ({ type: e.type, spaceId: e.spaceId }))
  const stopForServer = (serverId) => stopWhere((e) => e.serverId === serverId)
  const stopForSpace = (type, spaceId) => stopWhere((e) => e.type === type && e.spaceId === spaceId)

  // --- what the panel reads ---
  function state(serverId, type, spaceId) {
    const link = getLink(serverId)
    if (!link) return { available: false }
    const e = players.get(`s${serverId}-${type}-${spaceId}`)
    if (!e) return { available: true, active: false, state: 'idle', volume: 100, shuffleAll: false, nowPlaying: null, queue: [] }
    return { available: true, active: true, ...e.player.snapshot() }
  }

  // --- adding things ---
  function tooRapid(accountId) {
    const now = Date.now()
    const list = (recent.get(accountId) || []).filter((t) => now - t < RATE_WINDOW_MS)
    list.push(now)
    recent.set(accountId, list)
    return list.length > RATE_MAX
  }

  // Looks a result up and queues its songs. Returns { text } for the chat.
  async function addResult({ jf, player, by, isAdmin, result, front = false }) {
    const tracks = await jf.tracksFor(result.kind, result.id)
    if (tracks.length === 0) return { ok: false, text: say.nothingFound(result.title) }
    const wasIdle = !player.current && player.queue.length === 0
    let room = QUEUE_MAX - player.queue.length
    if (room <= 0) return { ok: false, text: say.queueFull() }
    let trimmedTo = null
    if (!isAdmin) {
      const mine = QUEUE_CAP() - player.queuedBy(by.id)
      if (mine <= 0) return { ok: false, text: say.capReached(QUEUE_CAP()) }
      if (tracks.length > mine) trimmedTo = mine
      room = Math.min(room, mine)
    }
    const chosen = tracks.slice(0, room)
    if (front) {
      for (const t of chosen.slice().reverse()) player.queue.unshift({ ...t, addedById: by.id, addedBy: by.name })
      if (player.current) player.skip()
      else player.ensureRunning()
    } else {
      player.add(chosen, by)
    }
    const position = player.queue.length - chosen.length + 1 + (player.current ? 1 : 0)
    let text
    if (result.kind === 'song') text = wasIdle || front ? say.queuedNow(describe(chosen[0])) : say.queuedLater(describe(chosen[0]), position)
    else {
      const label = result.kind === 'album' ? `the album ${result.title}${result.artist ? ` by ${result.artist}` : ''}` : `songs by ${result.title}`
      text = say.queuedMany(chosen.length, label, wasIdle || front)
    }
    if (trimmedTo !== null) text += ' ' + say.capTrimmed(chosen.length, QUEUE_CAP())
    return { ok: true, text }
  }

  // --- commands typed in chat ---
  // ctx: { serverId, type, spaceId, spaceMode, account: { id, name }, isAdmin }
  // Returns the reply text, or null when the message isn't a Jellybox command at all.
  async function handleCommand(ctx, text) {
    const cmd = parseCommand(text)
    if (!cmd) return null
    const { name, arg } = cmd
    if (name === 'help') return say.help(ctx.isAdmin)
    if (tooRapid(ctx.account.id)) return say.slowDown()
    const found = jfFor(ctx.serverId)
    if (!found.jf) return say[found.error]()
    if (ctx.spaceMode === 'text') return say.textOnly()
    if (ADMIN_COMMANDS.has(name) && !ctx.isAdmin) return say.adminOnly('/' + name)
    if (!hasPresence(ctx.type, ctx.spaceId, ctx.account.id)) return say.notInRoom()
    const room = `s${ctx.serverId}-${ctx.type}-${ctx.spaceId}`
    const existing = players.get(room)
    const player = existing ? existing.player : null
    const by = { id: ctx.account.id, name: ctx.account.name }
    const idleReply = () => say.nothingPlaying()

    try {
      switch (name) {
        case 'search': {
          if (!arg) return say.needQuery('/search')
          const results = await found.jf.search(arg, 8)
          if (results.length === 0) return say.nothingFound(arg)
          searches.set(`${ctx.account.id}|${room}`, { at: Date.now(), results, q: arg })
          const lines = results.map((r, i) => `${i + 1}. ${r.title}${r.kind === 'song' ? (r.artist ? ` by ${r.artist}` : '') : ` (${r.kind}${r.artist ? ` by ${r.artist}` : ''})`}`)
          return [say.searchHeader(arg, results.length), ...lines].join('\n')
        }
        case 'play': {
          if (!arg) return say.needQuery('/play')
          let result
          if (/^\d+$/.test(arg)) {
            const s = searches.get(`${ctx.account.id}|${room}`)
            if (!s || Date.now() - s.at > SEARCH_KEEP_MS) return say.noRecentSearch()
            result = s.results[Number(arg) - 1]
            if (!result) return say.badNumber(s.results.length)
          } else {
            // a wider net than /search shows: Jellyfin can rank the title that was typed below titles that only
            // contain a word of it
            const results = await found.jf.search(arg, 30)
            if (results.length === 0) return say.nothingFound(arg)
            result = bestMatch(results, arg)
          }
          const p = playerFor(ctx.serverId, ctx.type, ctx.spaceId)
          return (await addResult({ jf: found.jf, player: p, by, isAdmin: ctx.isAdmin, result })).text
        }
        case 'queue': {
          if (!player || (!player.current && player.queue.length === 0)) return idleReply()
          const lines = []
          if (player.current) lines.push(say.nowPlaying(describe(player.current), fmtTime(player.positionMs), fmtTime(player.current.durationMs)))
          if (player.queue.length === 0) lines.push(say.queueEmpty())
          else {
            lines.push(say.queueHeader(player.queue.length))
            player.queue.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${describe(t)}${t.addedBy ? ` (${t.addedBy})` : ''}`))
            if (player.queue.length > 10) lines.push(`...and ${player.queue.length - 10} more.`)
          }
          return lines.join('\n')
        }
        case 'nowplaying':
          if (!player || !player.current) return idleReply()
          return say.nowPlaying(describe(player.current), fmtTime(player.positionMs), fmtTime(player.current.durationMs))
        case 'skip': {
          if (!player || !player.current) return say.nothingToSkip()
          return say.skipped(describe(player.skip()))
        }
        case 'shuffle': {
          const off = /^(off|stop)$/i.test(arg)
          const p = off ? player : playerFor(ctx.serverId, ctx.type, ctx.spaceId)
          if (off) {
            if (!p || !p.shuffleAll) return say.shuffleOff()
            p.setShuffleAll(false)
            return say.shuffleOff()
          }
          if (p.shuffleAll) return say.shuffleAlready()
          p.setShuffleAll(true)
          return say.shuffleOn()
        }
        case 'stop': {
          if (!player || (!player.current && player.queue.length === 0)) return say.stopped(null)
          const was = player.stopPlayback()
          return say.stopped(was ? describe(was) : 'the queue')
        }
        case 'pause':
          if (!player || !player.current) return idleReply()
          return player.pause() ? say.paused() : say.alreadyPaused()
        case 'resume':
          if (!player || !player.current) return idleReply()
          return player.resume() ? say.resumed() : say.notPaused()
        case 'previous': {
          if (!player) return idleReply()
          const out = player.previous()
          if (!out) return say.nothingBefore()
          return out.back ? say.previousBack(describe(out.track)) : say.previousRestart(describe(out.track))
        }
        case 'volume': {
          if (!arg) return say.volumeNow(player ? player.volume : 100)
          if (!/^\d{1,3}$/.test(arg) || Number(arg) > 100) return say.badVolume()
          playerFor(ctx.serverId, ctx.type, ctx.spaceId).setVolume(Number(arg))
          return say.volumeSet(Number(arg))
        }
        case 'seek': {
          const ms = parseSeek(arg)
          if (ms === null) return say.badSeek()
          if (!player || !player.current) return idleReply()
          player.seek(ms)
          return say.seeked(fmtTime(player.startAt))
        }
        case 'clear':
          return say.cleared(player ? player.clear() : 0)
        case 'remove': {
          const n = Number(arg)
          const len = player ? player.queue.length : 0
          if (!/^\d+$/.test(arg) || !player || !player.removeAt(n)) return say.badRemove(len)
          return say.removed('number ' + n)
        }
      }
    } catch (err) {
      if (err instanceof JellyfinError) return say.libraryDown()
      console.error('jellybox command failed:', err.message)
      return say.libraryDown()
    }
    return null
  }

  // --- what the panel does (admins only; the caller checks) ---
  async function control({ serverId, type, spaceId, account, action, itemId, kind, value }) {
    const found = jfFor(serverId)
    if (!found.jf) return { ok: false, status: 409, error: 'Music is not set up' }
    const room = `s${serverId}-${type}-${spaceId}`
    const e = players.get(room)
    const by = { id: account.id, name: account.name }
    if (action === 'play-now' || action === 'queue' || action === 'play-album') {
      if (!isItemId(itemId)) return { ok: false, status: 400, error: 'Pick something from the search results' }
      const k = action === 'play-album' ? 'album' : kind === 'album' || kind === 'artist' ? kind : 'song'
      const p = playerFor(serverId, type, spaceId)
      try {
        const out = await addResult({ jf: found.jf, player: p, by, isAdmin: true, result: { kind: k, id: itemId, title: 'that', artist: '' }, front: action !== 'queue' })
        return out.ok ? { ok: true } : { ok: false, status: 404, error: 'Nothing playable there' }
      } catch {
        return { ok: false, status: 502, error: 'Could not reach the music library' }
      }
    }
    if (action === 'shuffle' && !e) {
      playerFor(serverId, type, spaceId).setShuffleAll(value !== false)
      return { ok: true }
    }
    if (!e) return { ok: false, status: 409, error: 'Nothing is playing' }
    const p = e.player
    switch (action) {
      case 'pause': p.pause(); break
      case 'resume': p.resume(); break
      case 'skip': p.skip(); break
      case 'previous': p.previous(); break
      case 'stop': p.stopPlayback(); break
      case 'shuffle':
        p.setShuffleAll(value !== false)
        break
      case 'clear': p.clear(); break
      case 'volume':
        if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, status: 400, error: 'volume must be a number' }
        p.setVolume(value)
        break
      case 'seek':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ok: false, status: 400, error: 'seek must be a number of milliseconds' }
        p.seek(value)
        break
      case 'remove':
        if (!p.removeAt(Number(value))) return { ok: false, status: 400, error: 'No such place in the queue' }
        break
      default:
        return { ok: false, status: 400, error: 'Unknown action' }
    }
    return { ok: true }
  }

  async function search(serverId, q) {
    const found = jfFor(serverId)
    if (!found.jf) return null
    return found.jf.search(q, 12)
  }
  async function browse(serverId, kind, opts) {
    const found = jfFor(serverId)
    return found.jf ? found.jf.browse(kind, opts) : null
  }
  async function children(serverId, kind, id) {
    const found = jfFor(serverId)
    return found.jf ? found.jf.children(kind, id) : null
  }
  async function cover(serverId, itemId) {
    const found = jfFor(serverId)
    return found.jf ? found.jf.cover(itemId) : null
  }

  return { getLink, link, test, unlink, state, handleCommand, control, search, browse, children, cover, sweep, activeSpaces, stopForServer, stopForSpace, activeRooms: () => players.size }
}
