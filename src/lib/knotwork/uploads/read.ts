// RULE 4: the ONE place a file is read out of a request. An upload route calls `receiveImage` and gets back either a
// processed image (re-encoded, inspected clean) or a refusal code; the raw bytes never leave this function, so no
// caller can store them. The file's name and the Content-Type the browser gave the part are never read.
import { MAX_BYTES, type UploadProblem } from './caps';
import { processUpload, type Processed } from './process';

/** Room for the form's text fields and the multipart boundaries around a file of exactly MAX_BYTES. */
const FORM_OVERHEAD = 64 * 1024;

/**
 * The request body, read chunk by chunk and abandoned the moment it passes `cap`: an oversized body is never fully
 * buffered. A Content-Length that already says "too big" is refused without reading anything.
 */
export async function readCapped(req: Request, cap: number): Promise<Uint8Array | 'too-big'> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > cap) {
    await req.body?.cancel().catch(() => {});
    return 'too-big';
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return 'too-big';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Reads the body and keeps none of it: for a request that is being refused before its file is looked at (a limit, a
 * blocked device). The browser gets its answer after sending, instead of a reset connection. Stops at the same cap.
 */
export async function discardBody(req: Request, cap = MAX_BYTES + FORM_OVERHEAD): Promise<void> {
  if (!req.body) return;
  const reader = req.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
      if (total > cap) return void (await reader.cancel().catch(() => {}));
    }
  } catch {
    // the client went away: nothing to keep either way
  }
}

export type Received = { ok: true; image: Processed; text: Record<string, string> } | { ok: false; code: UploadProblem; text: Record<string, string> };

/**
 * One image out of a multipart form post, through the whole pipeline. `field` is the file input's name; `text` names
 * the plain fields to hand back (each cut to 500 characters; the caller validates them).
 */
export async function receiveImage(req: Request, opts: { field: string; text: readonly string[] }): Promise<Received> {
  const none: Record<string, string> = Object.fromEntries(opts.text.map((k) => [k, '']));
  const type = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\b/i.test(type)) return { ok: false, code: 'empty', text: none };
  const body = await readCapped(req, MAX_BYTES + FORM_OVERHEAD);
  if (body === 'too-big') return { ok: false, code: 'too-big', text: none };
  let form: FormData;
  try {
    form = await new Response(body as BodyInit, { headers: { 'Content-Type': type } }).formData();
  } catch {
    return { ok: false, code: 'unreadable', text: none };
  }
  const text = Object.fromEntries(opts.text.map((k) => [k, typeof form.get(k) === 'string' ? (form.get(k) as string).slice(0, 500) : '']));
  const file = form.get(opts.field);
  if (!file || typeof file === 'string' || file.size === 0) return { ok: false, code: 'empty', text };
  if (file.size > MAX_BYTES) return { ok: false, code: 'too-big', text };
  const result = await processUpload(new Uint8Array(await file.arrayBuffer()));
  return result.ok ? { ok: true, image: result.image, text } : { ok: false, code: result.code, text };
}
