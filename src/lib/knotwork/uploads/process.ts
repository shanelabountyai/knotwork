// RULE 4, the strip (docs/knotwork/PHASE-3-PLAN.md section 0): the ONE function that turns uploaded bytes into bytes
// that may be stored. Sniff, cap, decode, turn upright, re-encode, inspect. The raw upload is never kept: what comes
// back is three freshly encoded JPEGs, each of which the inspector has re-read and found to hold nothing but a picture.
//
// It runs inside the upload request (D-66) and is one function, so a queue can call it later.
import sharp from 'sharp';
import { fit, MAX_PIXELS, precheck, RENDITIONS, type RenditionKind, type UploadProblem } from './caps';
import { inspect } from './inspect';
import { readHeader, sniff } from './sniff';

/** Not exported: a value of type Processed can only be made here, by processUpload. */
const PROCESSED: unique symbol = Symbol('processed by the upload pipeline');

export type Rendition = { bytes: Buffer; width: number; height: number };
/** A processed image. The type is the only thing a store accepts, and only this file can make one. */
export type Processed = { mime: 'image/jpeg'; width: number; height: number; renditions: Record<RenditionKind, Rendition>; readonly [PROCESSED]: true };
export type ProcessResult = { ok: true; image: Processed } | { ok: false; code: UploadProblem };

const JPEG = { quality: 86, chromaSubsampling: '4:2:0', mozjpeg: false } as const;

/** A re-encoded JPEG of `input` at exactly `size`, with no metadata written (sharp writes none unless asked to). */
async function encode(input: sharp.Sharp, size: { width: number; height: number }): Promise<Rendition> {
  const { data, info } = await input.resize(size.width, size.height, { fit: 'fill' }).jpeg(JPEG).toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

/** True when the bytes are a JPEG that holds nothing but the picture, at the stated size. */
function clean(r: Rendition): boolean {
  if (sniff(r.bytes) !== 'jpeg' || inspect(r.bytes).length > 0) return false;
  const h = readHeader(r.bytes, 'jpeg');
  return !!h && h.width === r.width && h.height === r.height;
}

export async function processUpload(raw: Uint8Array): Promise<ProcessResult> {
  const pre = precheck(raw);
  if (!pre.ok) return pre;
  try {
    // The decoder gets the same pixel limit as the header check, reads one frame only, and fails on a damaged file
    // instead of guessing at the missing part.
    const open = () => sharp(raw, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false, pages: 1, sequentialRead: true });
    const meta = await open().metadata();
    if ((meta.pages ?? 1) > 1) return { ok: false, code: 'animated' };
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? pre.height : pre.width;
    const height = turned ? pre.width : pre.height;
    // Upright first (the orientation tag is about to be dropped with the rest), transparency onto white (JPEG has none).
    const upright = () => open().rotate().flatten({ background: '#ffffff' });
    const full = await encode(upright(), fit(width, height, RENDITIONS.full));
    // The two smaller renditions are made from the full one: one decode of the upload, not three.
    const from = () => sharp(full.bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const display = await encode(from(), fit(full.width, full.height, RENDITIONS.display));
    const thumb = await encode(from(), fit(full.width, full.height, RENDITIONS.thumb));
    const renditions = { full, display, thumb };
    // The check the fixtures also make: the OUTPUT is re-read, and one segment that is not picture fails the ingest.
    if (!Object.values(renditions).every(clean)) return { ok: false, code: 'strip' };
    return { ok: true, image: { mime: 'image/jpeg', width: full.width, height: full.height, renditions, [PROCESSED]: true } };
  } catch {
    return { ok: false, code: 'unreadable' };
  }
}

/**
 * Grey-level statistics of a processed image's thumbnail, for the photo classifier's local stub (D-135). Here so sharp
 * stays in the pipeline alone: it reads a rendition this file made (never the upload), and writes nothing.
 */
export async function greyStats(image: Processed): Promise<{ mean: number; stdev: number; entropy: number }> {
  const stats = await sharp(image.renditions.thumb.bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).greyscale().stats();
  const grey = stats.channels[0]!;
  return { mean: grey.mean, stdev: grey.stdev, entropy: stats.entropy };
}
