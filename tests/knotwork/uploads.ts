// Shared by the upload tests: the strip fixtures, a multipart request the way a browser's form sends one, and the
// checks made on what was STORED.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect } from 'vitest';
import { inspect } from '@/lib/knotwork/uploads/inspect';
import { readHeader, sniff } from '@/lib/knotwork/uploads/sniff';
import { ROOT } from './fixtures';

export const STRIP = 'fixtures/photos/strip';
export const fixture = (name: string): Buffer => readFileSync(join(ROOT, STRIP, name));
export type StripCase = { file?: string; synthesize?: { from: string; padToBytes: number }; note: string; expect: { type: string | null; width?: number; height?: number; before: string[]; result: string; stored?: Record<string, { type: string; width: number; height: number }>; after?: string[] } };
export const manifest = (): { note: string; cases: StripCase[] } => JSON.parse(readFileSync(join(ROOT, STRIP, 'manifest.json'), 'utf8'));
export const caseBytes = (c: StripCase): Buffer => {
  if (c.file !== undefined) return fixture(c.file);
  const base = fixture(c.synthesize!.from);
  return Buffer.concat([base, Buffer.alloc(c.synthesize!.padToBytes - base.length, 0x20)]);
};

/** What the fixture generator wrote into the metadata of its images: none of it may be found in anything stored. */
export const LEAKS = ['Example Lane', 'Synthetic Guest', 'Knotwork Fixture Cam', 'KF-1', 'fixture-generator', 'Fixture 35mm', 'Synthetic Byline', 'xpacket', 'Exif', 'ICC_PROFILE', 'Photoshop', '2027:10:09'];
export const leaksIn = (bytes: Uint8Array): string[] => LEAKS.filter((s) => Buffer.from(bytes).includes(Buffer.from(s, 'latin1')));

/**
 * Asserts stored bytes are a clean JPEG three independent ways: our inspector finds nothing; none of the generator's
 * metadata strings is anywhere in the bytes; and the decoder (libvips, which shares no code with the inspector) reads
 * back no EXIF, ICC, XMP or IPTC block and no orientation.
 */
export async function expectClean(bytes: Uint8Array, at = '') {
  expect(sniff(bytes), at).toBe('jpeg');
  expect(inspect(bytes), at).toEqual([]);
  expect(leaksIn(bytes), at).toEqual([]);
  const meta = await sharp(bytes).metadata();
  expect([meta.format, meta.exif, meta.icc, meta.xmp, meta.iptc, meta.orientation, meta.comments], at).toEqual(['jpeg', undefined, undefined, undefined, undefined, undefined, undefined]);
  const header = readHeader(bytes, 'jpeg')!;
  expect([header.width, header.height], at).toEqual([meta.width, meta.height]);
  return { width: meta.width, height: meta.height };
}

/** A small flat-colour JPEG: a different picture for every (r, g, b). Synthetic. */
export const flat = (r: number, g: number, b: number, width = 64, height = 48): Promise<Buffer> => sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).jpeg({ quality: 80 }).toBuffer();

/** A multipart form post, as a browser sends one. `fileName` and `fileType` are what the browser CLAIMS; the pipeline must not care. */
export function multipart(url: string, field: string, bytes: Uint8Array | null, fields: Record<string, string> = {}, headers: Record<string, string> = {}, fileName = 'IMG_0001.jpg', fileType = 'image/jpeg'): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (bytes) form.set(field, new File([new Uint8Array(bytes)], fileName, { type: fileType }));
  return new Request(url, { method: 'POST', body: form, headers });
}

export const answer = async (res: Response) => ({ status: res.status, location: res.headers.get('location'), cookie: res.headers.get('set-cookie'), headers: Object.fromEntries(res.headers), text: await res.text() });
