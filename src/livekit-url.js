// The LiveKit address handed to a client. The server itself talks to LiveKit at LIVEKIT_URL, but a client may reach this
// machine at a different address from the one the server uses (a new IP after a network move, the name or Tailscale address
// someone connects with). So, unless LIVEKIT_PUBLIC_URL says what clients should use:
//   - when LIVEKIT_URL is a plain ws:// address on this machine or its network (an IP address or localhost), the client is
//     given the host it used to reach this server, with LiveKit's port: a moved server then needs only the client's address
//     changed, and voice follows;
//   - anything else (a DNS name, wss://, a request that came in over https behind a proxy) is given as written, as before.
import { isIP } from 'node:net'

const SAFE_HOST = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])$/

// `publicUrl`: LIVEKIT_PUBLIC_URL or empty. `livekitUrl`: LIVEKIT_URL. `host`: the host name the request came to, without its
// port. `secure`: whether the request came in over https (through a proxy).
export function livekitUrlForClient({ publicUrl, livekitUrl, host, secure = false }) {
  if (publicUrl) return publicUrl
  let own
  try {
    own = new URL(livekitUrl)
  } catch {
    return livekitUrl
  }
  const hostname = own.hostname.replace(/^\[|\]$/g, '')
  const onThisNetwork = own.protocol === 'ws:' && (hostname === 'localhost' || isIP(hostname) !== 0)
  if (!onThisNetwork || secure || typeof host !== 'string' || !SAFE_HOST.test(host)) return livekitUrl
  return `ws://${host}${own.port ? ':' + own.port : ''}`
}

// LIVEKIT_PUBLIC_URL must be a ws:// or wss:// address, so a typo is found when the server starts, not when someone joins voice.
export function checkPublicLivekitUrl(value) {
  if (!value) return null
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`LIVEKIT_PUBLIC_URL is not an address: ${value}`)
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('LIVEKIT_PUBLIC_URL must start with ws:// or wss://')
  return value
}
