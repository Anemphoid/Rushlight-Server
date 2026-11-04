// What the server writes to its log. A private chat server must never put message text, picture bytes, passwords, tokens,
// recovery words or invite secrets in a log, whatever the request and however it fails. Every kind of request is made with
// a recognisable marker in it, then the whole log is searched for the markers.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, newAccount } from './helpers.js'

let srv
before(async () => {
  srv = await startServer({ env: { RECOVER_LIMIT: '1000', ACCOUNT_LIMIT: '1000', LOGIN_LIMIT: '1000', REGISTER_LIMIT: '1000', JOIN_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('no kind of request leaves a secret in the log', async () => {
  const M = { text: 'MARKERTEXT-the-secret-chat-line', pass: 'MarkerPass-9f3k2', q: 'MARKERQUERY', pic: 'MARKERPICTUREBYTES', cipher: 'rl1.0.MARKERNONCE.MARKERCIPHER' }
  const owner = await srv.call('POST', '/api/register', { username: 'logowner', password: M.pass })
  assert.equal(owner.status, 200)
  const token = owner.data.token
  const words = owner.data.recoveryKey
  await srv.call('POST', '/api/me/recovery-key/ack', {}, token)
  await srv.call('POST', '/api/login', { username: 'logowner', password: M.pass })
  await srv.call('POST', '/api/login', { username: 'logowner', password: M.pass + 'wrong' })
  const s = (await srv.call('POST', '/api/servers', { name: 'LogHall' }, token)).data
  const ch = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'General', mode: 'text', persistent: true }, token)).data
  await srv.call('POST', `/api/channels/${ch.id}/messages`, { content: M.text }, token)
  await srv.call('POST', `/api/channels/${ch.id}/messages`, { content: M.cipher }, token)
  await srv.call('POST', `/api/channels/${ch.id}/commands`, { content: '/play ' + M.text }, token)
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, token)).data
  const guest = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: code.code }, guest.token)
  await srv.call('POST', '/api/join', { code: code.code, name: 'Visitor' })
  await srv.call('POST', '/api/recover', { username: 'logowner', key: words, newPassword: M.pass + '2' })
  await srv.call('POST', '/api/recover', { username: 'logowner', key: 'abandon '.repeat(11) + 'ability', newPassword: M.pass })
  // a picture, valid or not, and a body that is not JSON, one in an encoding the server refuses, and a path that does not exist
  await fetch(`${srv.url}/api/channels/${ch.id}/images`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'image/png' }, body: Buffer.from(M.pic) })
  await fetch(`${srv.url}/api/channels/${ch.id}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: `{"content": "${M.text}` })
  await fetch(`${srv.url}/api/channels/${ch.id}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json; charset=utf-7' }, body: `{"content":"${M.text}"}` })
  await fetch(`${srv.url}/api/channels/${ch.id}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-encoding': 'br' }, body: M.text })
  // a request that fails inside the server (a path that cannot be decoded) reaches the error handler, with a token in its query
  await fetch(`${srv.url}/api/channels/%E0%A4%A/messages?token=${token}&x=${M.q}`, { headers: { authorization: 'Bearer ' + token } })
  await fetch(`${srv.url}/api/nothing-here?token=${token}&x=${M.q}`, { headers: { authorization: 'Bearer ' + token } })
  await srv.call('GET', `/api/channels/${ch.id}/messages?after=${M.q}`, undefined, token)
  await sleep(300)
  const log = srv.log()
  for (const [what, secret] of Object.entries({ ...M, token, words, code: code.code, 'a recovery word run': words.split(' ').slice(0, 3).join(' ') })) {
    assert.equal(log.includes(secret), false, `the log holds ${what}`)
  }
  assert.ok(log.includes('listening'), 'the log is being captured')
})
