// Jellybox speaks in a friendly way. Every reply goes through here so the personality lives in one
// place. Each line is a list of variants; a few of them are picked at random, but every variant
// carries the same facts (titles, numbers, names) so nobody has to guess what happened.
const pick = (list) => list[Math.floor(Math.random() * list.length)]

export const BOT_NAME = 'Jellybox'

export const say = {
  notLinked: () =>
    pick([
      "I'd love to play something, but nobody has linked a Jellyfin library to this server yet. The server owner can do it in Admin Tools, under Music.",
      "My record shelf is empty! The server owner needs to link a Jellyfin library in Admin Tools, under Music, before I can spin anything."
    ]),
  brokenLink: () => "I can't open my music library right now. The owner may need to link it again in Admin Tools, under Music.",
  libraryDown: () => pick(["I can't reach the music library at the moment. Is Jellyfin awake? Try me again in a bit.", "Hmm, the music library isn't answering me. Give it a minute and ask again?"]),
  textOnly: () => "I only hang out in voice rooms, since that's where the music goes. Try me in one of those!",
  notInRoom: () => pick(["Hop into this voice room first and I'll gladly play something for you.", "I only play for people who are in the room, so join the voice chat first and then ask me again."]),
  adminOnly: (cmd) => `${cmd} is one of the admin-only controls, so I can't do that for you. I'm still happy to take requests with /play, /search and /skip, though.`,
  slowDown: () => pick(["Whoa, one at a time please! Give me a few seconds and try again.", "You're quicker than my record player. Slow down a little and ask again in a moment."]),
  needQuery: (cmd) => `Tell me what you'd like after ${cmd}. For example: ${cmd} the name of a song, album or artist.`,
  nothingFound: (q) => pick([`I looked everywhere for "${q}" and came up empty. Maybe try fewer words, or check the spelling?`, `No luck finding "${q}" in the library. Try another spelling or a shorter search?`]),
  searchHeader: (q, n) => `Here's what I found for "${q}" (${n} result${n === 1 ? '' : 's'}). Type /play and a number to pick one:`,
  noRecentSearch: () => "I don't have a recent search to pick from. Use /search followed by a name first, and then /play with a number.",
  badNumber: (max) => `That number isn't on my list. Pick one from 1 to ${max}.`,
  queuedNow: (t) => pick([`Coming right up: ${t}.`, `Great pick! Starting ${t}.`, `On it. ${t} is up first.`]),
  queuedLater: (t, pos) => pick([`Added ${t} to the queue. It's number ${pos} in line.`, `Nice one. ${t} is queued up at position ${pos}.`]),
  queuedMany: (n, label, firstNow) => `${firstNow ? 'Starting with ' : 'Added '}${label}. ${n} song${n === 1 ? '' : 's'} on the queue from that.`,
  capReached: (cap) => `You've already got ${cap} songs in the lineup, counting the one playing, which is as many as one person can have at a time. Let a few play first and then I'll take more!`,
  capTrimmed: (added, cap) => `I could only fit ${added} of those, since one person can have ${cap} songs in the lineup at a time.`,
  queueFull: () => "The queue is completely full right now. Let some songs play and then ask again.",
  nothingPlaying: () => pick(["Nothing is playing right now. Want me to put something on? Try /play.", "It's quiet in here! Nothing is playing at the moment. Try /play to change that."]),
  nowPlaying: (t, pos, dur) => `Now playing: ${t} (${pos} of ${dur}).`,
  queueEmpty: () => "The queue is empty, so nothing is coming up after this. Add something with /play!",
  queueHeader: (n) => `Coming up (${n} song${n === 1 ? '' : 's'}):`,
  skipped: (t) => pick([`Skipped ${t}. On to the next one!`, `Okay, ${t} is out. Moving along.`]),
  nothingToSkip: () => "There's nothing playing, so there's nothing for me to skip!",
  paused: () => pick(["Paused. I'll hold my place until you say /resume.", "Holding it right there. Say /resume when you're ready."]),
  alreadyPaused: () => "I'm already paused. Say /resume and I'll pick it back up.",
  notPaused: () => "I'm not paused, the music is already going!",
  resumed: () => pick(["And we're back!", "Picking up right where we left off."]),
  previousRestart: (t) => `Back to the start of ${t}.`,
  previousBack: (t) => `Going back one to ${t}.`,
  nothingBefore: () => "There's nothing before this one to go back to.",
  volumeNow: (v) => `The volume is at ${v}%.`,
  volumeSet: (v) => pick([`Volume set to ${v}%.`, `Okay, ${v}% it is.`]),
  badVolume: () => "Give me a volume from 0 to 100, like /volume 60.",
  seeked: (pos) => `Jumped to ${pos}.`,
  badSeek: () => "Tell me where to jump to, like /seek 1:30 or /seek 90 for seconds.",
  cleared: (n) => (n === 0 ? "The queue was already empty, so I tidied nothing. Easy!" : `Cleared ${n} song${n === 1 ? '' : 's'} off the queue. The current song keeps playing.`),
  removed: (t) => `Took ${t} off the queue.`,
  badRemove: (n) => (n === 0 ? "The queue is empty, so there's nothing to remove." : `Tell me which one to remove, from 1 to ${n}, like /remove 2.`),
  failedToJoin: () => "I couldn't get into the voice room just now. Try again in a moment?",
  unlinked: () => "The music library was unlinked, so I'm heading out. Thanks for the tunes!",
  leaving: () => "Looks like the room's empty, so I'm heading out. Call me back with /play any time!",
  help: (isAdmin) =>
    [
      "Hi, I'm Jellybox, your friendly neighbourhood jukebox! Here's what I can do:",
      '/play name (or a number from /search) - play a song, album or artist',
      '/search name - look something up and get a numbered list',
      '/queue - see what is coming up',
      '/nowplaying - see what is playing',
      '/skip - skip the current song',
      isAdmin ? 'Admin controls: /pause, /resume, /previous, /volume 0-100, /seek 1:30, /clear, /remove 2' : 'Admins can also /pause, /resume, /previous, /volume, /seek, /clear and /remove.'
    ].join('\n')
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function describe(t) {
  return `${t.title}${t.artist ? ` by ${t.artist}` : ''}`
}
