// One player per voice room. It turns the current song into 20 ms frames (the server streams it
// from Jellyfin into ffmpeg; nothing is saved to disk) and hands them to a sink at real-time speed.
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { FRAME_MS, FRAME_SAMPLES } from './sinks.js'

const FRAME_BYTES = FRAME_SAMPLES * 2
const LEAD_MS = 400 // how far ahead of real time frames may run
const REALTIME = process.env.JELLYBOX_REALTIME !== '0'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Player {
  // jf: () => Jellyfin client or null.  say: (text) => posts a Jellybox message in the room.
  constructor({ roomName, sink, jf, say }) {
    this.roomName = roomName
    this.sink = sink
    this.jf = jf
    this.say = say
    this.queue = []
    this.history = []
    this.current = null
    this.state = 'idle' // idle | playing | paused
    this.volume = 100
    this.startAt = 0 // where the current song begins (ms), after a seek
    this.framesSent = 0
    this.lastPreviousAt = 0
    this.gen = 0
    this.proc = null
    this.running = false
    this.stopped = false
    this.connected = false
    this.resumeWaiters = []
  }

  get positionMs() {
    return this.current ? this.startAt + this.framesSent * FRAME_MS : 0
  }

  snapshot() {
    return {
      state: this.state,
      volume: this.volume,
      nowPlaying: this.current
        ? { ...pub(this.current), positionMs: Math.min(this.positionMs, this.current.durationMs || this.positionMs) }
        : null,
      queue: this.queue.map(pub)
    }
  }

  // --- queue ---
  add(tracks, by) {
    for (const t of tracks) this.queue.push({ ...t, addedById: by.id, addedBy: by.name })
    this.ensureRunning()
  }
  // Songs of theirs in the lineup, counting the one playing now.
  queuedBy(accountId) {
    return this.queue.filter((t) => t.addedById === accountId).length + (this.current && this.current.addedById === accountId ? 1 : 0)
  }
  removeAt(n) {
    if (!Number.isInteger(n) || n < 1 || n > this.queue.length) return null
    return this.queue.splice(n - 1, 1)[0]
  }
  clear() {
    const n = this.queue.length
    this.queue = []
    return n
  }

  // --- transport ---
  pause() {
    if (this.state !== 'playing') return false
    this.state = 'paused'
    return true
  }
  resume() {
    if (this.state !== 'paused') return false
    this.state = 'playing'
    this.framesSent = this.framesSent // clock restarts in emit
    this.t0 = null
    for (const w of this.resumeWaiters.splice(0)) w()
    return true
  }
  skip() {
    if (!this.current) return null
    const gone = this.current
    this.history.push(gone)
    // The next song is chosen now, so the state never shows a gap while the old stream winds down.
    this.current = this.queue.shift() || null
    this.startAt = 0
    this.interrupt()
    return gone
  }
  // Restarts the song; pressed again within 3 seconds it goes back one song.
  previous() {
    const now = Date.now()
    const again = now - this.lastPreviousAt < 3000
    this.lastPreviousAt = now
    let back = false
    if (again && this.history.length) {
      if (this.current) this.queue.unshift(this.current)
      this.current = this.history.pop()
      back = true
    } else if (!this.current && this.history.length) {
      this.current = this.history.pop()
    } else if (!this.current) {
      return null
    }
    this.startAt = 0
    this.interrupt()
    this.ensureRunning()
    return { track: this.current, back }
  }
  seek(ms) {
    if (!this.current) return false
    const limit = this.current.durationMs || Infinity
    this.startAt = Math.max(0, Math.min(ms, limit - 1000 > 0 ? limit - 1000 : 0))
    this.interrupt()
    return true
  }
  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Math.round(v)))
  }

  interrupt() {
    this.gen++
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    for (const w of this.resumeWaiters.splice(0)) w()
  }

  async stop() {
    this.stopped = true
    this.queue = []
    this.current = null
    this.interrupt()
    await this.sink.disconnect()
  }

  ensureRunning() {
    if (this.running || this.stopped) return
    this.pump().catch((err) => console.error('jellybox player:', err.message))
  }

  async pump() {
    this.running = true
    try {
      if (!this.connected) {
        await this.sink.connect()
        this.connected = true
      }
    } catch (err) {
      this.running = false
      this.queue = []
      this.current = null
      this.say("I couldn't get into the voice room just now, so I'm giving up on that request. Try again in a moment?")
      console.error('jellybox could not join:', err.message)
      this.onFailed && this.onFailed()
      return
    }
    try {
      while (!this.stopped) {
        if (!this.current) {
          this.current = this.queue.shift() || null
          if (!this.current) break
          this.startAt = 0
        }
        const track = this.current
        const gen = ++this.gen
        this.framesSent = 0
        this.t0 = null
        this.state = 'playing'
        if (this.startAt === 0) this.say(`Now playing: ${track.title}${track.artist ? ` by ${track.artist}` : ''}${track.addedBy ? ` (picked by ${track.addedBy})` : ''}.`)
        let outcome
        try {
          outcome = await this.playTrack(track, gen)
        } catch (err) {
          this.say(`Oh dear, I tripped over "${track.title}" and had to skip it.`)
          console.error('jellybox track failed:', err.message)
          outcome = 'failed'
        }
        if (this.stopped) break
        if (outcome === 'ended' || outcome === 'failed') {
          if (this.current === track) {
            if (outcome === 'ended') this.history.push(track)
            this.current = null
          }
        }
      }
    } finally {
      this.state = 'idle'
      this.running = false
      this.current = null
    }
  }

  // 'ended', or 'interrupted' when a control changed things mid-song.
  async playTrack(track, gen) {
    const jf = this.jf()
    if (!jf) throw new Error('music is no longer linked')
    const web = await jf.audio(track.id)
    const input = Readable.fromWeb(web)
    const args = ['-v', 'error', '-nostdin', ...(this.startAt ? ['-ss', String(this.startAt / 1000)] : []), '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', '48000', '-ac', '1', 'pipe:1']
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'ignore'] })
    this.proc = proc
    proc.on('error', () => {})
    proc.stdin.on('error', () => {})
    input.on('error', () => proc.kill('SIGKILL'))
    input.pipe(proc.stdin)
    let buf = Buffer.alloc(0)
    let sentAny = false
    try {
      for await (const chunk of proc.stdout) {
        if (gen !== this.gen) return 'interrupted'
        buf = Buffer.concat([buf, chunk])
        while (buf.length >= FRAME_BYTES) {
          while (this.state === 'paused' && gen === this.gen) await new Promise((r) => this.resumeWaiters.push(r))
          if (gen !== this.gen) return 'interrupted'
          const frame = buf.subarray(0, FRAME_BYTES)
          buf = buf.subarray(FRAME_BYTES)
          await this.emit(frame)
          sentAny = true
        }
      }
      if (gen !== this.gen) return 'interrupted'
      if (!sentAny) throw new Error('ffmpeg produced no audio')
      return 'ended'
    } finally {
      input.destroy()
      try {
        proc.kill('SIGKILL')
      } catch {
        // done
      }
      if (this.proc === proc) this.proc = null
    }
  }

  async emit(frame) {
    const samples = new Int16Array(FRAME_SAMPLES)
    const src = new Int16Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES)
    const gain = (this.volume / 100) ** 2 // a gentler curve than linear: quiet settings are usable
    for (let i = 0; i < FRAME_SAMPLES; i++) samples[i] = Math.max(-32768, Math.min(32767, Math.round(src[i] * gain)))
    await this.sink.write(samples)
    this.framesSent++
    if (!REALTIME) return
    const now = Date.now()
    if (this.t0 == null) this.t0 = now - this.framesSent * FRAME_MS
    const wait = this.t0 + this.framesSent * FRAME_MS - LEAD_MS - now
    if (wait > 0) await sleep(wait)
  }
}

function pub(t) {
  return { id: t.id, title: t.title, artist: t.artist, album: t.album, durationMs: t.durationMs, addedBy: t.addedBy || null }
}
