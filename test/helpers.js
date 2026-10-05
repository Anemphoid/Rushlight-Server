// Starts a real server process against a throwaway database, with a LiveKit
// address that nothing listens on (the server treats LiveKit as best-effort
// for everything these tests touch), and gives tests a tiny HTTP client.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

export async function startServer({ env = {}, dbPath } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rushlight-test-'))
  const port = await freePort()
  const db = dbPath || join(dir, 'test.db')
  const child = spawn('node', ['src/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      JWT_SECRET: 'test-secret-test-secret-test-secret-test',
      LIVEKIT_URL: 'ws://127.0.0.1:9',
      LIVEKIT_API_KEY: 'testkey',
      LIVEKIT_API_SECRET: 'test-secret-test-secret-test-secret-12',
      DB_PATH: db,
      PORT: String(port),
      JOIN_LIMIT: '1000',
      LOGIN_LIMIT: '1000',
      REGISTER_LIMIT: '1000',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  let exited = false
  child.on('exit', () => (exited = true))

  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error('server exited while starting:\n' + log)
    try {
      const r = await fetch(url + '/api/health')
      if (r.ok) break
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  async function call(method, path, body, token) {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      // no body
    }
    return { status: res.status, data }
  }

  return {
    url,
    dbPath: db,
    log: () => log,
    isAlive: async () => {
      try {
        return (await fetch(url + '/api/health')).ok
      } catch {
        return false
      }
    },
    call,
    stop: async () => {
      child.kill()
      await new Promise((r) => (exited ? r() : child.on('exit', r)))
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

let counter = 0
export async function newAccount(srv, name) {
  const username = name || `user${++counter}x`
  const r = await srv.call('POST', '/api/register', { username, password: 'password123' })
  if (r.status !== 200) throw new Error('register failed: ' + JSON.stringify(r))
  return r.data
}

export function jwtClaims(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
}
