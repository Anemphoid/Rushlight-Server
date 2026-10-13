// Where the bot's audio goes. Frames are 20 ms of 48 kHz mono 16-bit samples (960 samples).
//   LiveKitSink  joins the voice room as its own participant and publishes them.
//   FileSink     appends them to a file; only used by the tests (JELLYBOX_TEST_SINK_DIR), since a test
//                cannot listen to a LiveKit room.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AccessToken } from 'livekit-server-sdk'

export const SAMPLE_RATE = 48000
export const FRAME_SAMPLES = 960
export const FRAME_MS = 20

export class LiveKitSink {
  constructor({ url, apiKey, apiSecret, roomName }) {
    Object.assign(this, { url, apiKey, apiSecret, roomName })
    this.room = null
    this.source = null
    this.AudioFrame = null
  }

  async connect() {
    // Loaded here so a machine where the native module cannot load still runs everything else.
    const lk = await import('@livekit/rtc-node')
    const at = new AccessToken(this.apiKey, this.apiSecret, { identity: `jellybox-${this.roomName}`, name: 'Jellybox' })
    at.addGrant({ roomJoin: true, room: this.roomName, canPublish: true, canSubscribe: false })
    const token = await at.toJwt()
    const room = new lk.Room()
    await room.connect(this.url, token, { autoSubscribe: false, dynacast: false })
    this.room = room
    this.AudioFrame = lk.AudioFrame
    this.source = new lk.AudioSource(SAMPLE_RATE, 1)
    const track = lk.LocalAudioTrack.createAudioTrack('jellybox', this.source)
    await room.localParticipant.publishTrack(track, new lk.TrackPublishOptions({ source: lk.TrackSource.SOURCE_MUSIC || lk.TrackSource.SOURCE_MICROPHONE }))
  }

  async write(samples) {
    await this.source.captureFrame(new this.AudioFrame(samples, SAMPLE_RATE, 1, FRAME_SAMPLES))
  }

  async disconnect() {
    try {
      this.source && this.source.clearQueue()
      await this.room?.disconnect()
    } catch {
      // already gone
    }
    this.room = this.source = null
  }
}

export class FileSink {
  constructor({ dir, roomName }) {
    this.file = join(dir, `${roomName}.pcm`)
    this.dir = dir
  }
  async connect() {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file, Buffer.alloc(0))
  }
  async write(samples) {
    appendFileSync(this.file, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
  }
  async disconnect() {
    appendFileSync(this.file.replace(/\.pcm$/, '.left'), '')
  }
}

export function makeSink(roomName, livekit) {
  if (process.env.JELLYBOX_TEST_SINK_DIR) return new FileSink({ dir: process.env.JELLYBOX_TEST_SINK_DIR, roomName })
  return new LiveKitSink({ ...livekit, roomName })
}
