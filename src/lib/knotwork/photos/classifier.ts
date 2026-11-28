// The photo classifier-assist seam (Phase 5, D-135). PURE: types, the stub's rule, and what advice may change.
//
// A classifier looks at a PROCESSED image (rule 4: the re-encoded renditions, never the raw upload) and returns
// labels with scores and a suggestion for the moderator:
//
//   ok      nothing to look at
//   review  shown flagged in the moderation console; the photo stays where its event's mode put it
//   hold    under post-moderation, the photo starts in the waiting queue instead of on the wall
//
// Advice is advice. It decides nothing but where a NEW photo starts under post-moderation, and only toward waiting:
// it never approves, publishes, rejects, takes down, hides or deletes. Every move after that is a person's
// (moderation.ts takes no suggestion at all). Which classifier runs is a per-event setting, `none` by default.
// Nothing leaves the server: tests/knotwork/structure.test.ts holds this file and classify.ts to imports that cannot
// reach a network.
import type { Processed } from '../uploads/process';
import { initialStatus, type Mode, type Status } from './moderation';

export const CLASSIFIERS = ['none', 'stub'] as const;
export type ClassifierName = (typeof CLASSIFIERS)[number];
export const SUGGESTIONS = ['ok', 'review', 'hold'] as const;
export type Suggestion = (typeof SUGGESTIONS)[number];

/** A score is a share from 0 to 1, rounded to three places. */
export type Label = { name: string; score: number };
export type Advice = { suggestion: Suggestion; reason: string; labels: Label[] };

/** The seam. A real classifier plugs in here at productionize; it gets the processed image and nothing else. */
export interface PhotoClassifier {
  readonly name: ClassifierName;
  classify(image: Processed): Promise<Advice | null>;
}

export const CLASSIFIER_TEXT: Record<ClassifierName, string> = {
  none: 'Off: no suggestions',
  stub: 'Local check (test and demo): flags very dark, very bright or blank photos',
};
export const SUGGESTION_TEXT: Record<Suggestion, string> = { ok: 'Nothing to look at', review: 'Worth a look', hold: 'Held for a decision' };

/**
 * Where a new photo starts. The mode decides (moderation.ts); a `hold` can only turn post's `live` into `pending`.
 * No suggestion can make a photo live, removed or hidden.
 */
export function startStatus(mode: Mode, advice: Advice | null): Extract<Status, 'pending' | 'live'> {
  const status = initialStatus(mode) as 'pending' | 'live';
  return advice?.suggestion === 'hold' ? 'pending' : status;
}

/** Grey-level statistics of the thumbnail rendition: mean and standard deviation (0 to 255) and entropy (bits, 0 to 8). */
export type ImageStats = { mean: number; stdev: number; entropy: number };

const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

/** The stub's thresholds: data, so the fixtures and the console say the same thing. */
export const STUB_RULES = { darkMean: 16, brightMean: 240, flatStdev: 6 } as const;

/**
 * The stub classifier's rule: deterministic simple statistics, no model. A nearly black frame (a pocket or a lens
 * cap) is held for a decision; a nearly white or a nearly flat one is worth a look; anything else is ok.
 */
export function stubAdvice(s: ImageStats): Advice {
  const labels: Label[] = [
    { name: 'brightness', score: round(s.mean / 255) },
    { name: 'contrast', score: round(s.stdev / 128) },
    { name: 'detail', score: round(s.entropy / 8) },
  ];
  if (s.mean < STUB_RULES.darkMean) return { suggestion: 'hold', reason: 'Almost entirely dark: it may have been taken by accident (a pocket or a lens cap).', labels };
  if (s.mean > STUB_RULES.brightMean) return { suggestion: 'review', reason: 'Almost entirely white: it may be overexposed or blank.', labels };
  if (s.stdev < STUB_RULES.flatStdev) return { suggestion: 'review', reason: 'Nearly one flat colour: there may be nothing in it.', labels };
  return { suggestion: 'ok', reason: 'Nothing stood out.', labels };
}
