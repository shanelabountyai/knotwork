// RULE 4, the strip check (docs/knotwork/PHASE-3-PLAN.md section 0). PURE: a segment walker, no decoder.
//
// `inspect` lists everything in a JPEG, PNG or WebP that is not the picture: EXIF (and whether it carries a GPS
// block), XMP, IPTC/Photoshop, ICC profiles, comments, PNG text and time chunks, anything it does not recognise, and
// bytes after the image ends. The ingest re-reads its own OUTPUT with this and fails unless the list is empty; the
// strip fixtures (fixtures/photos/strip) assert with the same function that it finds each kind before and none after.
import { jpegSegments, pngChunks, riffChunks, sniff, text, u16, u16le, u32, u32le } from './sniff';

export type FindingKind = 'exif' | 'gps' | 'xmp' | 'iptc' | 'icc' | 'comment' | 'text' | 'time' | 'other' | 'trailing' | 'unreadable';
export type Finding = { kind: FindingKind; where: string; at: number; bytes: number };

/** Does a TIFF block (the body of an EXIF segment) point at a GPS directory? Tag 0x8825 in the first directory. */
function hasGps(t: Uint8Array): boolean {
  if (t.length < 8) return false;
  const le = text(t, 0, 2) === 'II';
  if (!le && text(t, 0, 2) !== 'MM') return false;
  const r16 = (at: number) => (le ? u16le(t, at) : u16(t, at));
  const r32 = (at: number) => (le ? u32le(t, at) : u32(t, at));
  const ifd = r32(4);
  if (ifd + 2 > t.length) return false;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > t.length) return false;
    if (r16(at) === 0x8825) return true;
  }
  return false;
}
const exifBody = (d: Uint8Array) => (text(d, 0, 6) === 'Exif\u0000\u0000' ? d.subarray(6) : d);

// What a clean PNG may hold: the picture and how to show it. Everything else is reported.
const PNG_PICTURE = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs']);
const WEBP_PICTURE = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH']);
// JPEG: tables, frames, scans and restart intervals are the picture; APP0 "JFIF" is the format's own header.
const JPEG_PICTURE = (m: number) => (m >= 0xc0 && m <= 0xcf) || m === 0xda || m === 0xdb || m === 0xdd;

/** Everything in the file that is not the picture. Empty means clean. Bytes that are not an allowed image are one `unreadable`. */
export function inspect(b: Uint8Array): Finding[] {
  const type = sniff(b);
  const out: Finding[] = [];
  const add = (kind: FindingKind, where: string, at: number, bytes: number) => void out.push({ kind, where, at, bytes });
  if (!type) return [{ kind: 'unreadable', where: 'not a JPEG, PNG or WebP', at: 0, bytes: b.length }];

  if (type === 'jpeg') {
    const w = jpegSegments(b);
    for (const s of w.parts) {
      const m = parseInt(s.id, 16);
      const d = s.data;
      if (JPEG_PICTURE(m)) continue;
      if (m === 0xe0 && text(d, 0, 5) === 'JFIF\u0000') continue;
      if (m === 0xe1 && text(d, 0, 6) === 'Exif\u0000\u0000') {
        add('exif', 'APP1 Exif', s.at, d.length);
        if (hasGps(d.subarray(6))) add('gps', 'APP1 Exif GPS directory', s.at, d.length);
      } else if (m === 0xe1 && (text(d, 0, 29) === 'http://ns.adobe.com/xap/1.0/\u0000' || text(d, 0, 34) === 'http://ns.adobe.com/xmp/extension/')) add('xmp', 'APP1 XMP', s.at, d.length);
      else if (m === 0xe2 && text(d, 0, 12) === 'ICC_PROFILE\u0000') add('icc', 'APP2 ICC profile', s.at, d.length);
      else if (m === 0xed) add('iptc', 'APP13 Photoshop/IPTC', s.at, d.length);
      else if (m === 0xfe) add('comment', 'COM', s.at, d.length);
      else add('other', m >= 0xe0 && m <= 0xef ? `APP${m - 0xe0}` : `marker ${s.id}`, s.at, d.length);
    }
    if (!w.complete) add('unreadable', 'the JPEG ends before its end-of-image marker', w.end, b.length - w.end);
    else if (w.end < b.length) add('trailing', 'bytes after the end of the image', w.end, b.length - w.end);
    return out;
  }

  if (type === 'png') {
    const w = pngChunks(b);
    for (const c of w.parts) {
      if (PNG_PICTURE.has(c.id)) continue;
      if (c.id === 'eXIf') {
        add('exif', 'eXIf', c.at, c.data.length);
        if (hasGps(exifBody(c.data))) add('gps', 'eXIf GPS directory', c.at, c.data.length);
      } else if (c.id === 'iTXt' && text(c.data, 0, 17) === 'XML:com.adobe.xmp') add('xmp', 'iTXt XMP', c.at, c.data.length);
      else if (c.id === 'tEXt' || c.id === 'zTXt' || c.id === 'iTXt') add('text', c.id, c.at, c.data.length);
      else if (c.id === 'tIME') add('time', 'tIME', c.at, c.data.length);
      else if (c.id === 'iCCP') add('icc', 'iCCP', c.at, c.data.length);
      else add('other', c.id, c.at, c.data.length);
    }
    if (!w.complete) add('unreadable', 'the PNG ends before IEND', w.end, b.length - w.end);
    else if (w.end < b.length) add('trailing', 'bytes after the end of the image', w.end, b.length - w.end);
    return out;
  }

  const w = riffChunks(b);
  for (const c of w.parts) {
    if (WEBP_PICTURE.has(c.id)) continue;
    if (c.id === 'EXIF') {
      add('exif', 'EXIF', c.at, c.data.length);
      if (hasGps(exifBody(c.data))) add('gps', 'EXIF GPS directory', c.at, c.data.length);
    } else if (c.id === 'XMP ') add('xmp', 'XMP', c.at, c.data.length);
    else if (c.id === 'ICCP') add('icc', 'ICCP', c.at, c.data.length);
    else add('other', c.id.trim(), c.at, c.data.length);
  }
  const declared = 8 + u32le(b, 4);
  if (!w.complete) add('unreadable', 'the WebP is shorter than it says', w.end, b.length - w.end);
  else if (declared < b.length) add('trailing', 'bytes after the end of the image', declared, b.length - declared);
  return out;
}

/** The kinds found, once each, sorted: what the fixtures list. */
export const kindsOf = (findings: Finding[]): FindingKind[] => [...new Set(findings.map((f) => f.kind))].sort();
