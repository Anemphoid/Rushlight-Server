// Tiny real pictures (16 x 12), made in a browser canvas, for the picture tests. The tests add the metadata.
export const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAMABADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAQAF/8QAFRABAQAAAAAAAAAAAAAAAAAAAAH/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/EABgRAAMBAQAAAAAAAAAAAAAAAAACBSEE/9oADAMBAAIRAxEAPwDCCoqkj8K4NW6Daf/Z', 'base64')
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAYAAABr5z2BAAABSklEQVR4AVxSPUtEMRDMi7x9f0gQP0BERRQFRStbS1sLQbASLMROrK7USkttLO0s7Szt7jdcttjb2U1yuSsey87MzmxeEsfLa/K/si1/qwfyu34qPxvn8r15IV9bl/KxcyVvuzfysncno/0HeT58ksejkdwfv8rtybtcn31K5EghdX3gOGilwEu5Kj6peMPP4RRi6nQIwwEichP0wDuYKZ5Nkw5XvZqjjzUxixiiqEMwKRVmwK3ClAKD1z6mNrmYlGQTwYyazdoeRzARqSOpqJCo80me2OLQmwHZ8ETXYUvW3jaBmNSUlIcZ+lKp4pHr2QD2IeWNSnV+hnPm2eZ6v4UqzsnJSLJk28yGeu0peE+LG4AcMjlkkrQW3KtfIXD9zBT/AGfPyb4WaZKbJBPNhlOzWdJ3AL3+AxeziTFMNdlFhQdOZl5eKI4zBQAA///ZBd5lAAAABklEQVQDAKhm2B1YAM7YAAAAAElFTkSuQmCC', 'base64')
export const WEBP = Buffer.from('UklGRiACAABXRUJQVlA4WAoAAAAgAAAADwAACwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMgAAAJABAJ0BKhAADAABQCYlsAJ0ugADmAD+7DGx62PZv5MPAF9TKtf/UZzlQK3+p9+Ha4AA', 'base64')

// Builders that add personal details to a plain picture, for checking they are stripped.
export const SECRET = 'GPS-51.5072N-0.1276W-Canon-EOS'

export function jpegWithMetadata(base = JPEG) {
  const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload])
  const exif = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(SECRET)]))
  const xmp = seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from('<x:xmpmeta>' + SECRET + '</x:xmpmeta>')]))
  const comment = seg(0xfe, Buffer.from('taken at ' + SECRET))
  const icc = seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0'), Buffer.from([1, 1]), Buffer.from('profile-bytes')]))
  // after SOI: exif, xmp, comment, icc, then the rest; a second "picture" and a trailer after the end
  const trailer = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(SECRET + '-thumbnail'), Buffer.from([0xff, 0xd9]), Buffer.from('TRAILER-' + SECRET)])
  return Buffer.concat([base.subarray(0, 2), exif, xmp, comment, icc, base.subarray(2), trailer])
}
const crc32 = (buf) => {
  let c
  let crc = 0xffffffff
  for (const b of buf) {
    c = (crc ^ b) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
const pngChunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}
export function pngWithMetadata(base = PNG) {
  const ihdrEnd = 8 + 25
  return Buffer.concat([
    base.subarray(0, ihdrEnd),
    pngChunk('tEXt', Buffer.from('Comment\0' + SECRET)),
    pngChunk('eXIf', Buffer.from(SECRET)),
    pngChunk('tIME', Buffer.alloc(7)),
    pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0' + SECRET)),
    base.subarray(ihdrEnd),
    Buffer.from('TRAILER-' + SECRET)
  ])
}
const riffChunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}
// The plain WebP from the browser is already the extended kind (VP8X, a colour profile, then the
// picture), so this adds EXIF and XMP chunks to the end and sets the flags that announce them.
export function webpWithMetadata(base = WEBP) {
  const body = Buffer.concat([base.subarray(8), riffChunk('EXIF', Buffer.from(SECRET)), riffChunk('XMP ', Buffer.from(SECRET))])
  const marked = Buffer.from(body)
  marked[body.indexOf('VP8X') + 8] |= 0x08 | 0x04
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(marked.length, 4)
  return Buffer.concat([head, marked])
}
// The plainest kind of WebP: just the picture chunk, no extended header.
export function webpSimple(base = WEBP) {
  const at = base.indexOf('VP8 ')
  const len = base.readUInt32LE(at + 4)
  const chunk = base.subarray(at, at + 8 + len + (len % 2))
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + chunk.length, 4)
  return Buffer.concat([head, Buffer.from('WEBP'), chunk])
}
export const has = (buf, text) => buf.includes(Buffer.from(text))

