import { randomInt } from 'node:crypto'

// Simple word list for Vaultwarden-style join codes (word-word-number).
// Easy to say and type. 86 words twice plus a four digit number is about 66
// million combinations, drawn from a cryptographic random source, and the join
// endpoints are rate limited on top of that.
export const WORDS = [
  'amber', 'ash', 'aspen', 'birch', 'blaze', 'bramble', 'briar', 'brook',
  'cedar', 'clover', 'coal', 'copper', 'coral', 'crane', 'crow', 'dawn',
  'dune', 'ember', 'falcon', 'fern', 'flint', 'fox', 'frost', 'glade',
  'gold', 'gorse', 'grove', 'hawk', 'hazel', 'heron', 'holly', 'ivy',
  'jade', 'juniper', 'kestrel', 'lark', 'lichen', 'linden', 'lynx', 'maple',
  'marsh', 'meadow', 'mist', 'moss', 'oak', 'oat', 'onyx', 'opal',
  'osprey', 'otter', 'owl', 'pearl', 'pine', 'plum', 'quail', 'quartz',
  'raven', 'reed', 'ridge', 'river', 'robin', 'rowan', 'rush', 'rust',
  'sage', 'shale', 'slate', 'sorrel', 'sparrow', 'spruce', 'stone', 'storm',
  'swift', 'sylvan', 'thistle', 'thorn', 'tide', 'timber', 'vale', 'vine',
  'violet', 'wax', 'wick', 'willow', 'wolf', 'wren'
]

export function generateCode() {
  const a = WORDS[randomInt(WORDS.length)]
  const b = WORDS[randomInt(WORDS.length)]
  const n = randomInt(1000, 10000) // 1000-9999
  return `${a}-${b}-${n}`
}
