import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { fit, MAX_BYTES, MAX_PIXELS, precheck, RENDITION_KINDS, RENDITIONS, UPLOAD_PROBLEM } from '@/lib/knotwork/uploads/caps';
import { inspect, kindsOf } from '@/lib/knotwork/uploads/inspect';
import { processUpload } from '@/lib/knotwork/uploads/process';
import { readCapped, receiveImage } from '@/lib/knotwork/uploads/read';
import { jpegSegments, pngChunks, readHeader, riffChunks, sniff } from '@/lib/knotwork/uploads/sniff';
import { regenerateStrip } from '../../scripts/knotwork/gen-photo-fixtures';
import { ROOT } from './fixtures';
import { caseBytes, expectClean, fixture, flat, leaksIn, manifest, multipart, STRIP } from './uploads';

// CLAUDE.md rule 4, "uploads are hostile input: strip, validate, cap", one guard at a time, each against its fixture
// (fixtures/photos/strip; docs/knotwork/PHASE-3-PLAN.md section 0). No database here: this is the pipeline alone.
const cases = manifest().cases;
const named = (file: string) => cases.find((c) => c.file === file)!;
const ok = cases.filter((c) => c.expect.result === 'ok');

describe('the strip fixtures', () => {
  it('the committed manifest is what the pipeline computes from the committed files (npm run fixtures:check)', async () => {
    const text = readFileSync(join(ROOT, STRIP, 'manifest.json'), 'utf8');
    expect(await regenerateStrip(text)).toBe(text);
  });
  it('cover every kind of metadata, every refusal, and all three formats', () => {
    expect(new Set(cases.flatMap((c) => c.expect.before))).toEqual(new Set(['exif', 'gps', 'xmp', 'icc', 'iptc', 'comment', 'text', 'time', 'trailing', 'other', 'unreadable']));
    expect(new Set(cases.map((c) => c.expect.result))).toEqual(new Set(['ok', 'type', 'pdf', 'unreadable', 'pixels', 'animated', 'empty', 'too-big']));
    expect(new Set(ok.map((c) => c.expect.type))).toEqual(new Set(['jpeg', 'png', 'webp']));
    for (const code of new Set(cases.map((c) => c.expect.result))) if (code !== 'ok') expect(UPLOAD_PROBLEM[code as keyof typeof UPLOAD_PROBLEM], code).toBeTruthy();
  });
  it('the inputs really carry what they claim to: the strings are in the files before', async () => {
    expect(leaksIn(fixture('phone-gps.jpg'))).toEqual(expect.arrayContaining(['Example Lane', 'Synthetic Guest', 'Knotwork Fixture Cam', 'xpacket', 'Exif', 'ICC_PROFILE', '2027:10:09']));
    expect(leaksIn(fixture('iptc.jpg'))).toEqual(expect.arrayContaining(['Photoshop', 'Synthetic Byline']));
    expect(leaksIn(fixture('text-chunks.png'))).toEqual(expect.arrayContaining(['Example Lane', 'Synthetic Guest', 'Knotwork Fixture Cam']));
    expect(leaksIn(fixture('exif.webp'))).toEqual(expect.arrayContaining(['Synthetic Guest', 'Knotwork Fixture Cam', 'xpacket']));
    // And the decoder agrees with the inspector about the input: a GPS position is in there.
    const m = await sharp(fixture('phone-gps.jpg')).metadata();
    expect(m.exif && m.icc && m.xmp).toBeTruthy();
    expect(kindsOf(inspect(fixture('phone-gps.jpg')))).toEqual(['comment', 'exif', 'gps', 'icc', 'xmp']);
  });
});

describe('STRIP: decode, re-encode, then the output is inspected (PRD P0-6 "EXIF/GPS stripped on ingest")', () => {
  it.each(ok.map((c) => [c.file!, c] as const))('%s: found before, none after, in all three renditions', async (_, c) => {
    const bytes = caseBytes(c);
    expect(kindsOf(inspect(bytes))).toEqual(c.expect.before);
    const result = await processUpload(bytes);
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    expect(result.image.mime).toBe('image/jpeg');
    for (const kind of RENDITION_KINDS) {
      const r = result.image.renditions[kind];
      const size = await expectClean(r.bytes, `${c.file} ${kind}`);
      expect(size).toEqual({ width: c.expect.stored![kind]!.width, height: c.expect.stored![kind]!.height });
      expect([r.width, r.height]).toEqual([size.width, size.height]);
      expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(RENDITIONS[kind]);
      expect(r.bytes.equals(bytes), 'the raw upload is never what is kept').toBe(false);
    }
    expect(c.expect.after).toEqual([]);
  });
  it('a photo held upright (EXIF orientation 6) is stored upright, and the tag is gone', async () => {
    const before = await sharp(fixture('rotated.jpg')).metadata();
    expect([before.width, before.height, before.orientation]).toEqual([300, 200, 6]);
    const r = await processUpload(fixture('rotated.jpg'));
    if (!r.ok) throw new Error(r.code);
    const after = await sharp(r.image.renditions.full.bytes).metadata();
    expect([after.width, after.height, after.orientation]).toEqual([200, 300, undefined]);
    expect([r.image.width, r.image.height]).toEqual([200, 300]);
  });
  it('transparency is flattened onto white, and bytes after the end of an image do not survive', async () => {
    const alpha = await processUpload(fixture('alpha.png'));
    if (!alpha.ok) throw new Error(alpha.code);
    const px = await sharp(alpha.image.renditions.full.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(px.info.channels).toBe(3);
    const trailing = await processUpload(fixture('trailing.jpg'));
    if (!trailing.ok) throw new Error(trailing.code);
    for (const kind of RENDITION_KINDS) expect(Buffer.from(trailing.image.renditions[kind].bytes).includes('script')).toBe(false);
    expect(fixture('trailing.jpg').includes('<script>')).toBe(true);
  });
  it('the inspector is not blind: put one segment back into a clean output and it is found', async () => {
    const r = await processUpload(fixture('plain.jpg'));
    if (!r.ok) throw new Error(r.code);
    const clean = r.image.renditions.thumb.bytes;
    const seg = (marker: number, body: Buffer) => Buffer.concat([clean.subarray(0, 2), Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body, clean.subarray(2)]);
    const tiff = (gps: boolean) => Buffer.concat([Buffer.from('Exif\0\0II*\0\x08\0\0\0\x01\0', 'latin1'), Buffer.from(gps ? [0x25, 0x88] : [0x0f, 0x01]), Buffer.from([4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0])]);
    expect(kindsOf(inspect(seg(0xfe, Buffer.from('hello'))))).toEqual(['comment']);
    expect(kindsOf(inspect(seg(0xe1, tiff(false))))).toEqual(['exif']);
    expect(kindsOf(inspect(seg(0xe1, tiff(true))))).toEqual(['exif', 'gps']);
    expect(kindsOf(inspect(seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x/>', 'latin1'))))).toEqual(['xmp']);
    expect(kindsOf(inspect(seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'))))).toEqual(['icc']);
    expect(kindsOf(inspect(seg(0xed, Buffer.from('Photoshop 3.0\0', 'latin1'))))).toEqual(['iptc']);
    expect(kindsOf(inspect(seg(0xe5, Buffer.from('anything'))))).toEqual(['other']);
    expect(kindsOf(inspect(Buffer.concat([clean, Buffer.from('x')])))).toEqual(['trailing']);
    expect(kindsOf(inspect(clean.subarray(0, clean.length - 2)))).toEqual(['unreadable']);
    expect(inspect(clean)).toEqual([]);
  });
});

describe('VALIDATE: the allowlist is the magic bytes, never the name or the declared type', () => {
  it('JPEG, PNG and WebP are let in; everything else is refused', () => {
    expect(['plain.jpg', 'alpha.png', 'exif.webp', 'renamed-png.jpg'].map((f) => sniff(fixture(f)))).toEqual(['jpeg', 'png', 'webp', 'png']);
    for (const f of ['not-a-jpeg.jpg', 'animation.gif', 'drawing.svg', 'contract.pdf', 'empty.jpg']) expect(sniff(fixture(f)), f).toBeNull();
    for (const bytes of [Buffer.from('GIF89a'), Buffer.from('BM'), Buffer.from('II*\0'), Buffer.from('\0\0\0\x1cftypheic', 'latin1'), Buffer.from('<?xml'), Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), Buffer.from([0xff, 0xd8]), Buffer.from('MZ')]) {
      expect(sniff(bytes), bytes.toString('latin1')).toBeNull();
      expect(precheck(bytes)).toEqual({ ok: false, code: 'type' });
    }
  });
  it.each(cases.filter((c) => c.expect.result !== 'ok').map((c) => [c.file ?? 'oversize (synthesized)', c] as const))('%s is refused, and nothing comes back to store', async (_, c) => {
    const result = await processUpload(caseBytes(c));
    expect(result).toEqual({ ok: false, code: c.expect.result });
  });
  it('a PDF is refused with a sentence that says so (D-65)', async () => {
    expect(await processUpload(fixture('contract.pdf'))).toEqual({ ok: false, code: 'pdf' });
    expect(UPLOAD_PROBLEM.pdf).toMatch(/PDF.*not accepted yet/);
  });
  it('through a form post: the claimed file name and the claimed type change nothing', async () => {
    const url = 'http://localhost:8400/x';
    const text = await receiveImage(multipart(url, 'photo', fixture('not-a-jpeg.jpg'), {}, {}, 'holiday.jpg', 'image/jpeg'), { field: 'photo', text: [] });
    expect(text).toMatchObject({ ok: false, code: 'type' });
    const svg = await receiveImage(multipart(url, 'photo', fixture('drawing.svg'), {}, {}, 'photo.png', 'image/png'), { field: 'photo', text: [] });
    expect(svg).toMatchObject({ ok: false, code: 'type' });
    const png = await receiveImage(multipart(url, 'photo', fixture('alpha.png'), {}, {}, '../../etc/passwd.pdf', 'application/pdf'), { field: 'photo', text: [] });
    expect(png.ok).toBe(true);
    if (png.ok) await expectClean(png.image.renditions.full.bytes);
  });
  it('a post with no file, an empty file, the wrong field, or a body that is not a form gives "choose a photo"', async () => {
    const url = 'http://localhost:8400/x';
    const opts = { field: 'photo', text: ['name'] as const };
    expect(await receiveImage(multipart(url, 'photo', null, { name: 'Ada' }), opts)).toEqual({ ok: false, code: 'empty', text: { name: 'Ada' } });
    expect(await receiveImage(multipart(url, 'photo', Buffer.alloc(0)), opts)).toMatchObject({ ok: false, code: 'empty' });
    expect(await receiveImage(multipart(url, 'other', fixture('plain.jpg')), opts)).toMatchObject({ ok: false, code: 'empty' });
    expect(await receiveImage(new Request(url, { method: 'POST', body: new Uint8Array(fixture('plain.jpg')), headers: { 'content-type': 'image/jpeg' } }), opts)).toMatchObject({ ok: false, code: 'empty' });
    expect(await receiveImage(new Request(url, { method: 'POST', body: new URLSearchParams({ photo: 'a string, not a file' }) }), opts)).toMatchObject({ ok: false, code: 'empty' });
    expect(await receiveImage(new Request(url, { method: 'POST', body: 'garbage', headers: { 'content-type': 'multipart/form-data; boundary=x' } }), opts)).toMatchObject({ ok: false });
    // Text fields come back cut to 500 characters; the caller validates them.
    const long = await receiveImage(multipart(url, 'photo', fixture('plain.jpg'), { name: 'n'.repeat(900) }), opts);
    expect(long.text.name).toHaveLength(500);
  });
});

describe('CAP: 10 MB of bytes while reading, 50 megapixels from the header before decoding', () => {
  it('the header is read without decoding, for all three formats', async () => {
    for (const c of ok) {
      const bytes = caseBytes(c);
      const meta = await sharp(bytes).metadata();
      expect(readHeader(bytes, c.expect.type as 'jpeg'), c.file).toEqual({ width: meta.width, height: meta.height, animated: false });
    }
    // Lossless and lossy WebP, with and without the extended header.
    for (const make of [(s: sharp.Sharp) => s.webp({ lossless: true }), (s: sharp.Sharp) => s.webp({ quality: 60 }), (s: sharp.Sharp) => s.ensureAlpha(0.5).webp({ quality: 60 })]) {
      const webp = await make(sharp({ create: { width: 321, height: 123, channels: 3, background: '#336699' } })).toBuffer();
      expect(readHeader(webp, 'webp')).toEqual({ width: 321, height: 123, animated: false });
    }
    const progressive = await sharp(fixture('plain.jpg')).jpeg({ progressive: true }).toBuffer();
    expect(readHeader(progressive, 'jpeg')).toEqual({ width: 200, height: 150, animated: false });
    expect(inspect(progressive)).toEqual([]); // several scans, still walked to the end
  });
  it('a 71-byte file whose header claims 900 megapixels is refused from the header', () => {
    const bomb = fixture('pixel-bomb.png');
    expect(bomb.length).toBeLessThan(100);
    expect(readHeader(bomb, 'png')).toEqual({ width: 30_000, height: 30_000, animated: false });
    expect(precheck(bomb)).toEqual({ ok: false, code: 'pixels' }); // precheck is pure: no decoder has run
  });
  it('the pixel cap is exact, and a lying JPEG header is held to what it says', async () => {
    expect(MAX_PIXELS).toBe(50_000_000);
    const header = (w: number, h: number) => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 2, 0, 0, 0, 0, 0, 0, 0])]);
    expect(precheck(header(10_000, 5_000))).toMatchObject({ ok: true, width: 10_000, height: 5_000 }); // exactly 50 MP
    expect(precheck(header(10_000, 5_001))).toEqual({ ok: false, code: 'pixels' });
    expect(precheck(header(0, 10))).toEqual({ ok: false, code: 'unreadable' });
    const jpeg = Buffer.from(fixture('plain.jpg'));
    const sof = jpegSegments(jpeg).parts.find((s) => s.id === 'c0')!;
    jpeg.writeUInt16BE(60_000, sof.at + 5); // height
    jpeg.writeUInt16BE(60_000, sof.at + 7); // width
    expect(await processUpload(jpeg)).toEqual({ ok: false, code: 'pixels' });
  });
  it('a real image over the cap is refused by the header check; the decoder holds the same limit', async () => {
    const big = await sharp({ create: { width: 8_000, height: 6_300, channels: 3, background: '#808080' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(big.length).toBeLessThan(MAX_BYTES);
    expect(await processUpload(big)).toEqual({ ok: false, code: 'pixels' });
    await expect(sharp(big, { limitInputPixels: MAX_PIXELS }).jpeg().toBuffer()).rejects.toThrow(/pixel limit/i);
  }, 60_000);
  it('animated input is refused: an APNG, an animated WebP, and a still WebP whose header claims to be animated', async () => {
    expect(precheck(fixture('animated.png'))).toEqual({ ok: false, code: 'animated' });
    expect((await sharp(fixture('animated.webp')).metadata()).pages).toBe(2); // it really is two frames
    expect(precheck(fixture('animated.webp'))).toEqual({ ok: false, code: 'animated' });
    const webp = Buffer.from(fixture('exif.webp'));
    const vp8x = riffChunks(webp).parts.find((c) => c.id === 'VP8X')!;
    webp[vp8x.at + 8] = webp[vp8x.at + 8]! | 0x02; // the animation flag
    expect(precheck(webp)).toEqual({ ok: false, code: 'animated' });
  });
  it('the byte cap: one byte over is refused, exactly at the cap is read', async () => {
    expect(MAX_BYTES).toBe(10 * 1024 * 1024);
    const padded = (n: number) => Buffer.concat([fixture('plain.jpg'), Buffer.alloc(n - fixture('plain.jpg').length, 0x20)]);
    expect(precheck(padded(MAX_BYTES + 1))).toEqual({ ok: false, code: 'too-big' });
    expect(precheck(padded(MAX_BYTES))).toMatchObject({ ok: true });
    const at = await receiveImage(multipart('http://localhost:8400/x', 'photo', padded(MAX_BYTES)), { field: 'photo', text: [] });
    expect(at.ok).toBe(true);
    const over = await receiveImage(multipart('http://localhost:8400/x', 'photo', padded(MAX_BYTES + 1)), { field: 'photo', text: [] });
    expect(over).toMatchObject({ ok: false, code: 'too-big' });
  });
  it('an oversized body is never fully buffered: reading stops at the cap, however much more is coming', async () => {
    let pulled = 0;
    const endless = () => new ReadableStream<Uint8Array>({ pull(c) { pulled += 65_536; c.enqueue(new Uint8Array(65_536)); } }, { highWaterMark: 0 });
    const req = new Request('http://localhost:8400/x', { method: 'POST', body: endless(), duplex: 'half' } as RequestInit);
    expect(await readCapped(req, 1_000_000)).toBe('too-big');
    expect(pulled).toBeGreaterThan(1_000_000);
    expect(pulled).toBeLessThanOrEqual(1_000_000 + 4 * 65_536); // it stopped: an endless body did not keep being read
    // A Content-Length that already says too big is refused without reading a byte.
    pulled = 0;
    const declared = new Request('http://localhost:8400/x', { method: 'POST', body: endless(), headers: { 'content-length': '99999999' }, duplex: 'half' } as RequestInit);
    expect(await readCapped(declared, 1_000_000)).toBe('too-big');
    expect(pulled).toBeLessThanOrEqual(65_536);
    // Under the cap, the bytes come back whole.
    const small = new Request('http://localhost:8400/x', { method: 'POST', body: 'hello' });
    expect(Buffer.from((await readCapped(small, 10)) as Uint8Array).toString()).toBe('hello');
    // A multipart upload with an endless file part is cut off the same way.
    const head = new TextEncoder().encode('--b\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
    let sent = false;
    let streamed = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (!sent) { sent = true; return c.enqueue(head); } streamed += 1_048_576; c.enqueue(new Uint8Array(1_048_576)); } }, { highWaterMark: 0 });
    const got = await receiveImage(new Request('http://localhost:8400/x', { method: 'POST', body, headers: { 'content-type': 'multipart/form-data; boundary=b' }, duplex: 'half' } as RequestInit), { field: 'photo', text: [] });
    expect(got).toMatchObject({ ok: false, code: 'too-big' });
    expect(streamed).toBeLessThanOrEqual(MAX_BYTES + 4 * 1_048_576);
  });
  it('renditions: full at most 4096, display at most 1600, thumb at most 400, never enlarged', async () => {
    expect(RENDITIONS).toEqual({ full: 4096, display: 1600, thumb: 400 });
    expect(fit(5000, 3000, 4096)).toEqual({ width: 4096, height: 2458 });
    expect(fit(3000, 5000, 1600)).toEqual({ width: 960, height: 1600 });
    expect(fit(200, 150, 400)).toEqual({ width: 200, height: 150 });
    expect(fit(10_000, 1, 400)).toEqual({ width: 400, height: 1 });
    expect(named('big.jpg').expect.stored).toEqual({ full: { type: 'jpeg', width: 4096, height: 2458 }, display: { type: 'jpeg', width: 1600, height: 960 }, thumb: { type: 'jpeg', width: 400, height: 240 } });
    const tall = await processUpload(await flat(10, 20, 30, 300, 2400));
    if (!tall.ok) throw new Error(tall.code);
    expect(RENDITION_KINDS.map((k) => [tall.image.renditions[k].width, tall.image.renditions[k].height])).toEqual([[300, 2400], [200, 1600], [50, 400]]);
  });
});

describe('the walkers hold up against hostile lengths', () => {
  it('a segment or chunk that claims to run past the end stops the walk; nothing is read out of bounds', () => {
    const jpeg = Buffer.from(fixture('plain.jpg'));
    jpeg.writeUInt16BE(0xffff, 4); // the first segment's length
    expect(jpegSegments(jpeg).complete).toBe(false);
    expect(kindsOf(inspect(jpeg))).toContain('unreadable');
    const png = Buffer.from(fixture('alpha.png'));
    png.writeUInt32BE(0x7ffffff0, 33); // the chunk after IHDR
    expect(pngChunks(png).complete).toBe(false);
    const webp = Buffer.from(fixture('exif.webp'));
    webp.writeUInt32LE(0xfffffff0, 16);
    expect(riffChunks(webp).complete).toBe(false);
    for (const bytes of [jpeg, png, webp, Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('RIFF\x04\0\0\0WEBP', 'latin1')]) {
      expect(() => inspect(bytes)).not.toThrow();
      expect(() => precheck(bytes)).not.toThrow();
    }
  });
  it('random bytes behind each magic number never throw and never pass as clean', async () => {
    let seed = 20261124;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (const magic of ['ffd8ff', '89504e470d0a1a0a', '524946461000000057454250']) {
      for (let i = 0; i < 60; i++) {
        const bytes = Buffer.concat([Buffer.from(magic, 'hex'), Buffer.from(Array.from({ length: 40 + i * 7 }, rnd))]);
        expect(() => inspect(bytes)).not.toThrow();
        const result = await processUpload(bytes);
        expect(result.ok, `${magic} #${i}`).toBe(false);
      }
    }
  });
});
