// RULE 4, the caps (docs/knotwork/PHASE-3-PLAN.md section 0), and the one list of reasons an upload is refused. PURE.
import { looksLikePdf, readHeader, sniff, type ImageType } from './sniff';

/** Bytes: 10 MB. read.ts stops reading the request once it is past this; nothing longer is ever held in memory. */
export const MAX_BYTES = 10 * 1024 * 1024;
/** Pixels: 50 megapixels, from the header, before decoding. The decoder is given the same limit. */
export const MAX_PIXELS = 50_000_000;
/** The longest side of each stored rendition, in pixels. Never enlarged. */
export const RENDITIONS = { full: 4096, display: 1600, thumb: 400 } as const;
export type RenditionKind = keyof typeof RENDITIONS;
export const RENDITION_KINDS = Object.keys(RENDITIONS) as RenditionKind[];

// A closed list: only a code travels in a URL, and the sentence comes from here.
export const UPLOAD_PROBLEM = {
  empty: 'Choose a photo first.',
  'too-big': 'That file is larger than 10 MB. Choose a smaller one.',
  type: 'That file is not a JPEG, PNG or WebP image. Only those three kinds can be added.',
  pdf: 'That file is a PDF. PDFs are not accepted yet: upload a photo or a scan of each page as a JPEG, PNG or WebP image.',
  pixels: 'That image has more than 50 megapixels. Choose a smaller one.',
  animated: 'That image is animated. Only still images can be added.',
  unreadable: 'That image could not be read. It may be damaged; try another.',
  strip: 'That image could not be made safe to store, so it was not kept.',
} as const;
export type UploadProblem = keyof typeof UPLOAD_PROBLEM;
export const isUploadProblem = (code: string): code is UploadProblem => Object.hasOwn(UPLOAD_PROBLEM, code);

export type Precheck = { ok: true; type: ImageType; width: number; height: number } | { ok: false; code: UploadProblem };

/**
 * Everything that can be decided from the bytes without decoding them: is it one of the three types (by its magic
 * bytes), within the byte cap, still, and within the pixel cap its own header states.
 */
export function precheck(b: Uint8Array): Precheck {
  if (b.length === 0) return { ok: false, code: 'empty' };
  if (b.length > MAX_BYTES) return { ok: false, code: 'too-big' };
  const type = sniff(b);
  if (!type) return { ok: false, code: looksLikePdf(b) ? 'pdf' : 'type' };
  const h = readHeader(b, type);
  if (!h || h.width < 1 || h.height < 1) return { ok: false, code: 'unreadable' };
  if (h.animated) return { ok: false, code: 'animated' };
  if (h.width * h.height > MAX_PIXELS) return { ok: false, code: 'pixels' };
  return { ok: true, type, width: h.width, height: h.height };
}

/** The size a rendition comes out at: the longest side brought down to `max`, never enlarged, never below 1. */
export function fit(width: number, height: number, max: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  return { width: Math.max(1, Math.round((width * max) / long)), height: Math.max(1, Math.round((height * max) / long)) };
}
