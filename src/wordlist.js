// Simple word list for Vaultwarden-style join codes (word-word-number).
// Not cryptographically exhaustive — just needs to be easy to say and type,
// with the trailing number adding enough entropy for a short-lived code.
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
  const a = WORDS[Math.floor(Math.random() * WORDS.length)]
  const b = WORDS[Math.floor(Math.random() * WORDS.length)]
  const n = Math.floor(Math.random() * 90) + 10 // 10-99
  return `${a}-${b}-${n}`
}
