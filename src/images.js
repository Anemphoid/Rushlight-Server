// Chat images: check that an upload really is the image it claims to be, read its size, and strip
// everything that could carry personal details (camera, location, time, editing history) without
// decoding or re-encoding the picture. Pure byte work, no dependencies. JPEG, PNG and WebP only.
//
// What is kept is what the picture needs to look right: the pixel data, the colour profile and the
// palette/transparency/animation parts. What is dropped is everything else: EXIF, XMP, comments,
// text chunks, timestamps and unknown extras. (A JPEG's rotation flag lives in EXIF; the client
// bakes the rotation in before uploading, so a phone photo is still the right way up.)

export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_PIXELS = 40_000_000 // a decompression-bomb guard, and far more than a chat needs

const fail = (why) => ({ ok: false, error: why })

// ---- JPEG ----
function cleanJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return fail('not a JPEG')
  const out = [buf.subarray(0, 2)]
  let pos = 2
  let width = 0
  let height = 0
  let sawScan = false
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) return fail('damaged JPEG')
    let marker = buf[pos + 1]
    while (marker === 0xff && pos + 2 < buf.length) {
      pos++
      marker = buf[pos + 1]
    }
    if (marker === 0xd9) {
      out.push(buf.subarray(pos, pos + 2)) // end of image
      pos += 2
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(pos, pos + 2)) // markers with no length
      pos += 2
      continue
    }
    if (pos + 4 > buf.length) return fail('damaged JPEG')
    const len = buf.readUInt16BE(pos + 2)
    if (len < 2 || pos + 2 + len > buf.length) return fail('damaged JPEG')
    const segment = buf.subarray(pos, pos + 2 + len)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (len < 8) return fail('damaged JPEG')
      height = buf.readUInt16BE(pos + 5)
      width = buf.readUInt16BE(pos + 7)
    }
    let keep = true
    if (marker === 0xfe) keep = false // comment
    else if (marker >= 0xe1 && marker <= 0xef) {
      // keep only the colour profile (APP2 "ICC_PROFILE") and Adobe's colour-transform note (APP14),
      // which some decoders need; EXIF and XMP (APP1) and the rest go
      const tag = segment.toString('latin1', 4, 16)
      keep = (marker === 0xe2 && tag.startsWith('ICC_PROFILE')) || (marker === 0xee && tag.startsWith('Adobe'))
    }
    if (keep) out.push(segment)
    pos += 2 + len
    if (marker === 0xda) {
      // start of scan: the compressed picture follows up to the end marker; copy it untouched
      // (an unescaped FF D9 only ever means "end", so anything after the first one, such as a
      // second embedded picture or a camera's trailer, is cut off)
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), pos)
      if (eoi < 0) return fail('damaged JPEG')
      sawScan = true
      out.push(buf.subarray(pos, eoi + 2))
      pos = buf.length
      break
    }
  }
  if (!sawScan || !width || !height) return fail('damaged JPEG')
  const clean = Buffer.concat(out)
  if (clean[clean.length - 2] !== 0xff || clean[clean.length - 1] !== 0xd9) return fail('damaged JPEG')
  return { ok: true, width, height, clean }
}

// ---- PNG ----
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT'])
function cleanPng(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return fail('not a PNG')
  const out = [buf.subarray(0, 8)]
  let pos = 8
  let width = 0
  let height = 0
  let first = true
  let sawEnd = false
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const end = pos + 12 + len
    if (len > 0x7fffffff || end > buf.length) return fail('damaged PNG')
    if (first) {
      if (type !== 'IHDR' || len !== 13) return fail('damaged PNG')
      width = buf.readUInt32BE(pos + 8)
      height = buf.readUInt32BE(pos + 12)
      first = false
    }
    if (PNG_KEEP.has(type)) out.push(buf.subarray(pos, end))
    pos = end
    if (type === 'IEND') {
      sawEnd = true
      break // anything after the end marker is dropped
    }
  }
  if (!sawEnd || !width || !height) return fail('damaged PNG')
  return { ok: true, width, height, clean: Buffer.concat(out) }
}

// ---- WebP ----
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP', 'ANIM', 'ANMF'])
function webpSize(type, data) {
  if (type === 'VP8X' && data.length >= 10) {
    return { width: 1 + (data[4] | (data[5] << 8) | (data[6] << 16)), height: 1 + (data[7] | (data[8] << 8) | (data[9] << 16)) }
  }
  if (type === 'VP8 ' && data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
    return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff }
  }
  if (type === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
    const bits = data.readUInt32LE(1)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  return null
}
function cleanWebp(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return fail('not a WebP')
  const riffEnd = 8 + buf.readUInt32LE(4)
  if (riffEnd > buf.length) return fail('damaged WebP') // cut off
  const chunks = []
  let pos = 12
  let size = null
  while (pos + 8 <= riffEnd) {
    const type = buf.toString('latin1', pos, pos + 4)
    const len = buf.readUInt32LE(pos + 4)
    const end = pos + 8 + len
    if (end > riffEnd) return fail('damaged WebP')
    const data = buf.subarray(pos + 8, end)
    if (WEBP_KEEP.has(type)) {
      if (!size) size = webpSize(type, data)
      let body = data
      if (type === 'VP8X') {
        body = Buffer.from(data)
        body[0] &= ~(0x08 | 0x04) // EXIF and XMP are gone, so say so
      }
      const padded = len % 2 ? Buffer.concat([body, Buffer.from([0])]) : body
      const head = Buffer.alloc(8)
      head.write(type, 0, 'latin1')
      head.writeUInt32LE(len, 4)
      chunks.push(head, padded)
    }
    pos = end + (len % 2)
  }
  if (!size || !size.width || !size.height) return fail('damaged WebP')
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return { ok: true, width: size.width, height: size.height, clean: Buffer.concat([head, body]) }
}

// Returns { ok: true, width, height, clean } or { ok: false, error }. `clean` is what gets stored.
export function inspectImage(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return fail("That didn't decode to a real image")
  let result
  try {
    if (mime === 'image/jpeg') result = cleanJpeg(buffer)
    else if (mime === 'image/png') result = cleanPng(buffer)
    else if (mime === 'image/webp') result = cleanWebp(buffer)
    else return fail('Pictures can be JPEG, PNG or WebP')
  } catch {
    return fail("That didn't decode to a real image")
  }
  if (!result.ok) return fail("That didn't decode to a real image matching its type")
  if (result.width * result.height > MAX_PIXELS) return fail('That picture is too many pixels across')
  return result
}
