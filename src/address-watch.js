// Notices when this machine's network address is no longer the one the server was set up with.
//
// Voice breaks quietly when that happens (chat keeps working, LiveKit still advertises the old address), so the server compares
// the address in its settings with the addresses the machine really has, says so in its log once, and tells the owner and the
// admins in the app: the new address, and a ready-to-send message for friends. It cannot repair LiveKit's own settings from
// inside its container (that is the host-side program's job: `./rushlight address`, or its automatic mode), so the point here is
// that nobody is left guessing.
//
// The settings address: HOST_IP (the Compose stack writes it), else the address in LIVEKIT_PUBLIC_URL or LIVEKIT_URL when that
// is a real network address (an older install). A public server keeps a public address that is not on any interface, and a name
// cannot be compared, so those are never judged.
import os from 'node:os'
import { isIP } from 'node:net'

const PRIVATE = [
  (a) => a[0] === 10,
  (a) => a[0] === 172 && a[1] >= 16 && a[1] <= 31,
  (a) => a[0] === 192 && a[1] === 168
]
const octets = (ip) => ip.split('.').map(Number)
const isTailscale = (ip) => {
  const a = octets(ip)
  return a[0] === 100 && a[1] >= 64 && a[1] <= 127
}
const isLinkLocal = (ip) => ip.startsWith('169.254.')
// Bridges that Docker and virtual machines make are never an address people connect to.
const isBridge = (name) => /^(docker|br-|veth|virbr|lxcbr|cni|flannel)/.test(name || '')

// The machine's own IPv4 addresses worth offering: [{ ip, name }], without loopback, link-local and bridges.
export function localAddresses(interfaces = os.networkInterfaces()) {
  const out = []
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' && i.family !== 4) continue
      if (i.internal || isLinkLocal(i.address) || isBridge(name)) continue
      out.push({ ip: i.address, name })
    }
  }
  return out
}

export function configuredAddress(env = process.env) {
  if (env.RUSHLIGHT_MODE === 'public') return null
  const candidates = [env.HOST_IP, env.LIVEKIT_PUBLIC_URL, env.LIVEKIT_URL]
  for (const c of candidates) {
    if (!c) continue
    let host = c
    try {
      host = new URL(c.includes('://') ? c : `http://${c}`).hostname
    } catch {
      continue
    }
    if (isIP(host) === 4 && host !== '127.0.0.1' && !host.startsWith('0.')) return host
  }
  return null
}

// state: 'ok' | 'changed' | 'unknown'. `suggested` is the address the machine has now that is most likely the new one: in Tailscale
// mode the Tailscale address (it does not move with the router), else a private address, preferring one in the old one's network.
export function judgeAddress({ configured, local, mode }) {
  if (!configured) return { state: 'unknown' }
  const ips = local.map((l) => l.ip)
  if (ips.includes(configured)) return { state: 'ok', configured }
  let pool = local
  if (mode === 'tailscale' || isTailscale(configured)) pool = local.filter((l) => isTailscale(l.ip))
  else pool = local.filter((l) => !isTailscale(l.ip) && PRIVATE.some((p) => p(octets(l.ip))))
  if (!pool.length) pool = local
  const near = pool.find((l) => l.ip.split('.').slice(0, 3).join('.') === configured.split('.').slice(0, 3).join('.'))
  const suggested = (near || pool[0] || {}).ip || null
  return { state: 'changed', configured, suggested, others: pool.map((l) => l.ip).filter((ip) => ip !== suggested) }
}

export function createAddressWatch({ env = process.env, interfaces = () => os.networkInterfaces(), log = console.log, port } = {}) {
  let current = { state: 'unknown' }
  let lastLogged = ''
  const mode = env.RUSHLIGHT_MODE || ''
  function refresh() {
    current = judgeAddress({ configured: configuredAddress(env), local: localAddresses(interfaces()), mode })
    const key = `${current.state}:${current.suggested || ''}`
    if (key !== lastLogged) {
      lastLogged = key
      if (current.state === 'changed') {
        log(`This computer's address changed: the settings say ${current.configured}, it is now ${current.suggested || 'unknown'}. Voice will not connect until LiveKit is told (Compose: ./rushlight address).`)
      }
    }
    return current
  }
  const view = () => {
    if (current.state !== 'changed') return null
    const next = current.suggested
    return {
      configured: current.configured,
      suggested: next,
      others: current.others,
      message: next
        ? `The server's address changed. New address: http://${next}:${port || env.PORT || 4000}. In Rushlight, open Settings, then Connection, and type it in.`
        : null
    }
  }
  return { refresh, view, state: () => current }
}
