// The photo fixtures (Phase 3; docs/knotwork/PHASE-3-PLAN.md section 4), called by gen-fixtures.ts.
//
// fixtures/photos/strip/: small SYNTHETIC images (gradients drawn here; no photograph of anything or anyone) that
// carry what a phone or an editor leaves in a file: EXIF with a GPS position, XMP, an ICC profile, a comment, IPTC,
// PNG text and time chunks. Plus hostile files: the wrong bytes behind a .jpg name, a GIF, an SVG, a PDF, a truncated
// JPEG, a PNG whose header claims 900 megapixels, an animated PNG and an animated WebP, a JPEG with bytes after its end, an oversize file.
// The image files are committed and are written only when missing (or with --images): their bytes depend on the
// encoder's version, so `fixtures:check` does not compare them. What it does recompute, from the committed files, is
// manifest.json's expect blocks: the type by magic bytes, the header's size, what the inspector finds BEFORE, what the
// pipeline answers, and what the inspector finds in the stored renditions AFTER (which must be nothing).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { expand, PHOTO_LIMITS, runs, simulate, type Attempt, type Burst, type UploadLimits } from '../../src/lib/knotwork/photos/limits';
import { table } from '../../src/lib/knotwork/photos/moderation';
import { crc32 } from '../../src/lib/knotwork/photos/zip';
import { precheck, RENDITION_KINDS } from '../../src/lib/knotwork/uploads/caps';
import { inspect, kindsOf } from '../../src/lib/knotwork/uploads/inspect';
import { processUpload } from '../../src/lib/knotwork/uploads/process';
import { sniff } from '../../src/lib/knotwork/uploads/sniff';

export const STRIP_DIR = 'fixtures/photos/strip';
export const LIMITS_DIR = 'fixtures/photos/limits';
export const MODERATION_FILE = 'fixtures/photos/moderation.json';

// ---- drawing and byte surgery

/** A deterministic gradient: no file, no camera. */
const gradient = (width: number, height: number, tint: [number, number, number], alpha = false) => {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      raw[at] = (tint[0] + Math.floor((x * 120) / width)) & 0xff;
      raw[at + 1] = (tint[1] + Math.floor((y * 120) / height)) & 0xff;
      raw[at + 2] = (tint[2] + ((x + y) % 32)) & 0xff;
      if (alpha) raw[at + 3] = x < width / 2 ? 255 : 96;
    }
  }
  return sharp(raw, { raw: { width, height, channels } });
};
const be16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const be32 = (n: number) => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
/** Inserts a JPEG segment right after the start-of-image marker. */
const withJpegSegment = (jpeg: Buffer, marker: number, body: Buffer) => Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, marker]), be16(body.length + 2), body, jpeg.subarray(2)]);
const pngChunk = (type: string, body: Buffer) => Buffer.concat([be32(body.length), Buffer.from(type, 'latin1'), body, be32(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])))]);
/** Inserts PNG chunks right after IHDR (which is always the first chunk, 25 bytes long, after the 8-byte signature). */
const withPngChunks = (png: Buffer, ...chunks: Buffer[]) => Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);

// An invented position (a field outside Tulsa) and an invented camera. Nothing here describes a real person or place of theirs.
const EXIF = {
  IFD0: { Make: 'Knotwork Fixture Cam', Model: 'KF-1', Software: 'fixture-generator', Artist: 'A. Synthetic Guest', Copyright: 'synthetic fixture' },
  IFD2: { DateTimeOriginal: '2027:10:09 18:30:00', LensModel: 'Fixture 35mm' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '36/1 9/1 1404/100', GPSLongitudeRef: 'W', GPSLongitude: '95/1 59/1 3354/100', GPSAltitude: '213/1' },
};
const XMP = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="A. Synthetic Guest" dc:description="synthetic fixture: home address would be here"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
const IPTC = Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), Buffer.from('8BIM', 'latin1'), be16(0x0404), Buffer.from([0, 0]), be32(21), Buffer.from([0x1c, 0x02, 0x50]), be16(16), Buffer.from('Synthetic Byline', 'latin1'), Buffer.from([0])]);
const TEXT = (key: string, value: string) => pngChunk('tEXt', Buffer.from(`${key}\0${value}`, 'latin1'));

const IMAGES: Record<string, () => Promise<Buffer>> = {
  'phone-gps.jpg': async () => withJpegSegment(await gradient(640, 480, [40, 80, 120]).withExif(EXIF).withXmp(XMP).withIccProfile('p3').jpeg({ quality: 82 }).toBuffer(), 0xfe, Buffer.from('synthetic fixture comment: shot at 12 Example Lane', 'latin1')),
  'rotated.jpg': async () => gradient(300, 200, [150, 60, 60]).withExif({ IFD0: { Make: 'Knotwork Fixture Cam' } }).withMetadata({ orientation: 6 }).jpeg({ quality: 82 }).toBuffer(),
  'iptc.jpg': async () => withJpegSegment(await gradient(320, 240, [60, 140, 60]).jpeg({ quality: 82 }).toBuffer(), 0xed, IPTC),
  'plain.jpg': async () => gradient(200, 150, [90, 90, 160]).jpeg({ quality: 82 }).toBuffer(),
  'big.jpg': async () => sharp({ create: { width: 5000, height: 3000, channels: 3, background: { r: 200, g: 170, b: 120 } } }).jpeg({ quality: 70 }).toBuffer(),
  'trailing.jpg': async () => Buffer.concat([await gradient(160, 120, [20, 20, 90]).jpeg({ quality: 82 }).toBuffer(), Buffer.from('<script>alert("after the end of the image")</script>', 'latin1')]),
  'text-chunks.png': async () => withPngChunks(await gradient(320, 200, [100, 40, 140]).withExif(EXIF).withIccProfile('p3').png().toBuffer(), TEXT('Author', 'A. Synthetic Guest'), TEXT('Comment', 'synthetic fixture: taken at 12 Example Lane'), pngChunk('tIME', Buffer.from([0x07, 0xeb, 10, 9, 18, 30, 0]))),
  'alpha.png': async () => gradient(240, 160, [200, 120, 40], true).png().toBuffer(),
  'renamed-png.jpg': async () => gradient(120, 90, [30, 150, 150]).png().toBuffer(),
  'exif.webp': async () => gradient(400, 300, [120, 120, 40]).withExif(EXIF).withXmp(XMP).withIccProfile('p3').webp({ quality: 80 }).toBuffer(),
  // ---- hostile
  'not-a-jpeg.jpg': async () => Buffer.from('This file is named .jpg and is plain text. Its name says image; its bytes do not.\n', 'latin1'),
  'animation.gif': async () => Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex'),
  'drawing.svg': async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert("svg")</script><rect width="10" height="10"/></svg>\n', 'latin1'),
  'contract.pdf': async () => Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'),
  'truncated.jpg': async () => {
    const whole = await gradient(640, 480, [40, 80, 120]).jpeg({ quality: 82 }).toBuffer();
    return whole.subarray(0, Math.floor(whole.length * 0.6));
  },
  // A header that claims 30,000 × 30,000 pixels (900 megapixels) over a few bytes of data: refused from the header.
  'pixel-bomb.png': async () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', Buffer.concat([be32(30_000), be32(30_000), Buffer.from([8, 2, 0, 0, 0])])), pngChunk('IDAT', Buffer.from('789c636000000002000148afa471', 'hex')), pngChunk('IEND', Buffer.alloc(0))]),
  'animated.png': async () => withPngChunks(await gradient(64, 64, [10, 200, 90]).png().toBuffer(), pngChunk('acTL', Buffer.concat([be32(2), be32(0)]))),
  'animated.webp': async () => {
    const frames = await Promise.all([200, 90].map((v) => sharp({ create: { width: 8, height: 8, channels: 4, background: { r: v, g: v, b: v, alpha: 1 } } }).png().toBuffer()));
    return sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  },
  'empty.jpg': async () => Buffer.alloc(0),
};

type StripCase = { file?: string; synthesize?: { from: string; padToBytes: number }; note: string; expect?: unknown };
type StripManifest = { note: string; cases: StripCase[] };

/** The bytes of one case: the committed file, or (oversize) a committed file padded out at run time. */
export function stripBytes(c: StripCase, dir = STRIP_DIR): Buffer {
  if (c.file !== undefined) return readFileSync(join(dir, c.file));
  const base = readFileSync(join(dir, c.synthesize!.from));
  return Buffer.concat([base, Buffer.alloc(c.synthesize!.padToBytes - base.length, 0x20)]);
}

async function expectOf(bytes: Buffer) {
  const pre = precheck(bytes);
  const result = await processUpload(bytes);
  const before = kindsOf(inspect(bytes));
  const head = { type: sniff(bytes), ...(pre.ok && { width: pre.width, height: pre.height }), before };
  if (!result.ok) return { ...head, result: result.code };
  const r = result.image.renditions;
  return {
    ...head,
    result: 'ok',
    stored: Object.fromEntries(RENDITION_KINDS.map((k) => [k, { type: sniff(r[k].bytes), width: r[k].width, height: r[k].height }])),
    after: kindsOf(RENDITION_KINDS.flatMap((k) => inspect(r[k].bytes))),
  };
}

export async function regenerateStrip(text: string): Promise<string> {
  const m = JSON.parse(text) as StripManifest;
  const cases = [];
  for (const c of m.cases) cases.push({ ...(c.file !== undefined ? { file: c.file } : { synthesize: c.synthesize }), note: c.note, expect: await expectOf(stripBytes(c)) });
  return `${JSON.stringify({ note: m.note, cases }, null, 2)}\n`;
}

export async function writeStripImages(force: boolean): Promise<string[]> {
  const wrote: string[] = [];
  for (const [name, make] of Object.entries(IMAGES)) {
    const path = join(STRIP_DIR, name);
    if (!force && existsSync(path)) continue;
    writeFileSync(path, await make());
    wrote.push(name);
  }
  return wrote;
}

// ---- limits

export type LimitFx = { name: string; note: string; limits?: UploadLimits; blocked?: string[]; steps: (Attempt | Burst)[]; expect?: unknown };
export function regenerateLimits(fx: LimitFx): string {
  const outcomes = simulate(fx.limits ?? PHOTO_LIMITS.upload, expand(fx.steps), fx.blocked ?? []);
  const totals: Record<string, number> = {};
  for (const o of outcomes) totals[o] = (totals[o] ?? 0) + 1;
  const rest = { name: fx.name, note: fx.note, ...(fx.limits && { limits: fx.limits }), ...(fx.blocked && { blocked: fx.blocked }), steps: fx.steps };
  return `${JSON.stringify({ ...rest, expect: { attempts: outcomes.length, totals: Object.fromEntries(Object.entries(totals).sort()), runs: runs(outcomes) } }, null, 2)}\n`;
}

// ---- moderation

export const regenerateModeration = (): string =>
  `${JSON.stringify({ note: 'Every state × action × mode of the photo moderation machine (src/lib/knotwork/photos/moderation.ts), each also for a purged photo, and what is visible where. Written by the machine; tools/photo_limits.py holds an independent copy of the table.', ...table() }, null, 2)}\n`;
