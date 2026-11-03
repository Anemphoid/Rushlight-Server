// Which search result /play should play. Jellyfin ranks by its own idea of relevance and a search for "the chain" also
// returns every title with "chain" in it, so taking the first result can play "Chain Breaker" instead of "The Chain".
// This prefers what the person actually typed: the same title, the same title without a "(2004 Remaster)" style tail,
// a title that starts with it, one that has every word of it, then one that merely contains it. Jellyfin's own order
// decides between equals (and a song beats an album or artist of the same standing, since /play is for songs).

export function normalize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// "The Chain (2004 Remaster)" and "The Chain - 2004 Remaster" and "The Chain [Live]" -> "The Chain"
function withoutTail(title) {
  return String(title || '').replace(/\s*[([][^)\]]*[)\]]\s*$/u, '').replace(/\s+-\s+[^-]*$/u, '')
}

const KIND_ORDER = { song: 0, album: 1, artist: 2 }

function score(result, query) {
  const q = normalize(query)
  if (!q) return 0
  const title = normalize(result.title)
  if (title === q) return 100
  if (normalize(withoutTail(result.title)) === q) return 90
  const padded = ` ${title} `
  if (title.startsWith(q + ' ')) return 80
  const words = q.split(' ')
  if (words.every((w) => padded.includes(` ${w} `))) return 70
  if (padded.includes(` ${q} `)) return 70
  if (title.includes(q)) return 60
  return 0
}

// results: Jellyfin's order. Returns the one to play, or undefined for an empty list.
export function bestMatch(results, query) {
  let best
  let bestScore = -1
  results.forEach((r) => {
    const s = score(r, query)
    const better =
      s > bestScore ||
      (s === bestScore && s > 0 && (KIND_ORDER[r.kind] ?? 3) < (KIND_ORDER[best.kind] ?? 3))
    if (better) {
      best = r
      bestScore = s
    }
  })
  return best
}
