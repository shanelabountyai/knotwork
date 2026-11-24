// RULE 3: the ONLY shape the photo upload page (/p/[token]) is built from. PURE.
//
// A guest with the link sees the wedding's title and the event's name, and nothing else: no date, no guest, no
// household, no list, no count of photos, no other photo. The page is the same for everyone who holds the link.
import { UPLOAD_PROBLEM } from '../uploads/caps';

export type UploadView = { weddingTitle: string; eventName: string };
export const uploadView = (i: { wedding: { title: string }; event: { name: string } }): UploadView => ({ weddingTitle: i.wedding.title, eventName: i.event.name });

export const NAME_MAX = 60;
export const CAPTION_MAX = 200;

// Closed lists: only a code travels in the URL; the sentence comes from here.
export const PHOTO_PROBLEM = {
  ...UPLOAD_PROBLEM,
  text: 'Use one line of plain text for your name and for the caption.',
  name: `That name is too long. Use ${NAME_MAX} characters or fewer.`,
  caption: `That caption is too long. Use ${CAPTION_MAX} characters or fewer.`,
  busy: 'A lot of photos are arriving just now. Wait a few minutes and try again.',
  full: 'This wall has all the photos it can hold.',
  refused: 'That photo could not be added. If you think this is a mistake, ask the couple.',
} as const;
export type PhotoProblem = keyof typeof PHOTO_PROBLEM;
export const isPhotoProblem = (code: string): code is PhotoProblem => Object.hasOwn(PHOTO_PROBLEM, code);

export const PHOTO_DONE = {
  live: 'Thank you. Your photo is on the wall.',
  pending: 'Thank you. Your photo will appear on the wall once it has been approved.',
} as const;
export type PhotoDone = keyof typeof PHOTO_DONE;
export const isPhotoDone = (code: string): code is PhotoDone => Object.hasOwn(PHOTO_DONE, code);

/** One line of plain text: no control characters (line breaks, tabs, NUL) and no direction overrides (D-61's rule). */
const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]*$/;

export type CheckedText = { ok: true; name: string; caption: string } | { ok: false; code: 'text' | 'name' | 'caption' };
/** The optional name and caption a guest typed: trimmed, one plain line each, within their lengths. */
export function checkText(input: { name: string; caption: string }): CheckedText {
  const name = input.name.trim();
  const caption = input.caption.trim();
  if (!ONE_LINE.test(name) || !ONE_LINE.test(caption)) return { ok: false, code: 'text' };
  if ([...name].length > NAME_MAX) return { ok: false, code: 'name' };
  if ([...caption].length > CAPTION_MAX) return { ok: false, code: 'caption' };
  return { ok: true, name, caption };
}
