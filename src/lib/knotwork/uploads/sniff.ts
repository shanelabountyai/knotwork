// RULE 4, the allowlist (docs/knotwork/PHASE-3-PLAN.md section 0). PURE: bytes in, facts out.
//
// What a file IS comes from its first bytes, never from its name or the Content-Type a browser sent with it: JPEG,
// PNG and WebP are let in and everything else is refused. This file also holds the three container walkers (JPEG
// segments, PNG chunks, RIFF chunks) that the pixel cap (the size is read from the header, before any decoding) and
// the metadata inspector (inspect.ts) are built on. Every read is bounds-checked: a hostile length never reads past
// the end, it ends the walk with `complete: false`.

export type ImageType = 'jpeg' | 'png' | 'webp';
export const MIME: Record<ImageType, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const ascii = (b: Uint8Array, at: number, n: number) => (at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : '');
export const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
export const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
export const u32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
export const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
export const text = ascii;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image type the bytes begin as, or null. The name and the declared type are not arguments on purpose. */
export function sniff(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return null;
}

/** For the sentence a refusal gives: a PDF is named as one (contract attachments, D-65). Still refused. */
export const looksLikePdf = (b: Uint8Array) => ascii(b, 0, 5) === '%PDF-';

export type Part = { id: string; at: number; data: Uint8Array };
export type Walk = { parts: Part[]; complete: boolean; end: number };

/**
 * A JPEG's marker segments, in order, through the end-of-image marker. `id` is the marker byte in hex ('e1', 'fe',
 * 'c0', ...); `data` is the segment's payload (empty for the scan data itself, which is skipped over).
 */
export function jpegSegments(b: Uint8Array): Walk {
  const parts: Part[] = [];
  let p = 2;
  const fail = (): Walk => ({ parts, complete: false, end: p });
  while (p < b.length) {
    if (b[p] !== 0xff) return fail();
    while (p < b.length && b[p] === 0xff) p++; // fill bytes
    if (p >= b.length) return fail();
    const marker = b[p]!;
    const at = p - 1;
    p++;
    if (marker === 0xd9) return { parts, complete: true, end: p };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // stand-alone markers
    if (p + 2 > b.length) return fail();
    const len = u16(b, p);
    if (len < 2 || p + len > b.length) return fail();
    parts.push({ id: marker.toString(16).padStart(2, '0'), at, data: b.subarray(p + 2, p + len) });
    p += len;
    if (marker === 0xda) {
      // Entropy-coded data: runs to the next marker that is not a stuffed zero or a restart.
      while (p < b.length) {
        if (b[p] === 0xff && p + 1 < b.length && b[p + 1] !== 0x00 && !(b[p + 1]! >= 0xd0 && b[p + 1]! <= 0xd7) && b[p + 1] !== 0xff) break;
        p++;
      }
    }
  }
  return fail();
}

/** A PNG's chunks through IEND. `id` is the four-letter type. */
export function pngChunks(b: Uint8Array): Walk {
  const parts: Part[] = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const len = u32(b, p);
    const id = ascii(b, p + 4, 4);
    if (len > 0x7fffffff || p + 12 + len > b.length) return { parts, complete: false, end: p };
    parts.push({ id, at: p, data: b.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (id === 'IEND') return { parts, complete: true, end: p };
  }
  return { parts, complete: false, end: p };
}

/** A WebP's RIFF chunks. `id` is the four-character code ('VP8 ', 'VP8L', 'VP8X', 'EXIF', 'XMP ', 'ICCP', ...). */
export function riffChunks(b: Uint8Array): Walk {
  const parts: Part[] = [];
  const total = Math.min(b.length, 8 + u32le(b, 4));
  let p = 12;
  while (p + 8 <= total) {
    const len = u32le(b, p + 4);
    if (p + 8 + len > total) return { parts, complete: false, end: p };
    parts.push({ id: ascii(b, p, 4), at: p, data: b.subarray(p + 8, p + 8 + len) });
    p += 8 + len + (len & 1);
  }
  return { parts, complete: p >= total && 8 + u32le(b, 4) <= b.length && parts.length > 0, end: Math.min(p, total) };
}

export type Header = { width: number; height: number; animated: boolean };

/**
 * Width and height as the file's own header states them, and whether it holds more than one frame: read without
 * decoding a pixel, so the pixel cap is applied before a small file can expand into a huge bitmap. Null when the
 * header is not there to read.
 */
export function readHeader(b: Uint8Array, type: ImageType): Header | null {
  if (type === 'png') {
    if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR' || u32(b, 8) !== 13) return null;
    let animated = false;
    for (const c of pngChunks(b).parts) {
      if (c.id === 'IDAT') break;
      if (c.id === 'acTL') animated = true;
    }
    return { width: u32(b, 16), height: u32(b, 20), animated };
  }
  if (type === 'jpeg') {
    for (const s of jpegSegments(b).parts) {
      const m = parseInt(s.id, 16);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return s.data.length >= 5 ? { height: u16(s.data, 1), width: u16(s.data, 3), animated: false } : null;
      if (m === 0xda) return null;
    }
    return null;
  }
  const chunks = riffChunks(b).parts;
  const first = chunks[0];
  if (!first) return null;
  const animated = chunks.some((c) => c.id === 'ANIM' || c.id === 'ANMF');
  const d = first.data;
  if (first.id === 'VP8X') return d.length >= 10 ? { width: 1 + (d[4]! | (d[5]! << 8) | (d[6]! << 16)), height: 1 + (d[7]! | (d[8]! << 8) | (d[9]! << 16)), animated: animated || (d[0]! & 0x02) !== 0 } : null;
  if (first.id === 'VP8 ') return d.length >= 10 && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a ? { width: u16le(d, 6) & 0x3fff, height: u16le(d, 8) & 0x3fff, animated } : null;
  if (first.id === 'VP8L') {
    if (d.length < 5 || d[0] !== 0x2f) return null;
    const bits = u32le(d, 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated };
  }
  return null;
}
