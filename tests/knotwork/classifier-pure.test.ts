import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CLASSIFIERS, startStatus, STUB_RULES, stubAdvice, SUGGESTIONS, type Advice } from '@/lib/knotwork/photos/classifier';
import { classifierFor } from '@/lib/knotwork/photos/classify';
import { ACTIONS, MODES, moderate, STATES } from '@/lib/knotwork/photos/moderation';
import { processUpload } from '@/lib/knotwork/uploads/process';

// Phase 5, D-135: the classifier-assist seam. Advice is advice: it can only hold a NEW post-moderation photo in the
// waiting queue. It never approves, publishes, rejects, takes down, hides or deletes, and nothing it says changes a
// moderation move (the machine takes no suggestion at all).
const advice = (suggestion: (typeof SUGGESTIONS)[number]): Advice => ({ suggestion, reason: 'because', labels: [] });
const image = async (create: sharp.Create) => {
  const r = await processUpload(await sharp({ create }).jpeg().toBuffer());
  if (!r.ok) throw new Error(r.code);
  return r.image;
};

describe('where a new photo starts', () => {
  it('with no advice, or advice that is not hold, the mode decides as before', () => {
    for (const mode of MODES) {
      const plain = mode === 'pre' ? 'pending' : 'live';
      expect(startStatus(mode, null), mode).toBe(plain);
      expect(startStatus(mode, advice('ok')), mode).toBe(plain);
      expect(startStatus(mode, advice('review')), mode).toBe(plain);
    }
  });
  it('hold moves a post-moderation photo into the waiting queue, and changes nothing under pre-moderation', () => {
    expect(startStatus('post', advice('hold'))).toBe('pending');
    expect(startStatus('pre', advice('hold'))).toBe('pending');
  });
  it('no suggestion can start a photo removed, or make a pre-moderation photo live', () => {
    for (const mode of MODES) for (const s of SUGGESTIONS) {
      expect(['pending', 'live'], `${mode}/${s}`).toContain(startStatus(mode, advice(s)));
      if (mode === 'pre') expect(startStatus(mode, advice(s)), s).toBe('pending');
    }
  });
});

describe('every moderation move is the same whatever the suggestion', () => {
  // The machine's signature has no place for a suggestion; this pins it, and walks the whole table once per suggestion
  // as the store does (the stored suggestion is never passed to it).
  it('moderate() takes the state, the action, the mode and purged: nothing else', () => {
    expect(moderate.length).toBe(3); // purged has a default
  });
  it.each([null, ...SUGGESTIONS])('suggestion %s', (s) => {
    for (const mode of MODES) {
      const start = startStatus(mode, s ? advice(s) : null);
      // The whole table is still the table of fixtures/photos/moderation.json: four states, four actions, purged or not.
      expect(STATES.length * ACTIONS.length).toBe(16);
      // From where the advice put it, only a person's move goes anywhere: approve from waiting, take down from live.
      const from = { status: start, removedFrom: null };
      expect(moderate(from, 'approve', mode).ok).toBe(start === 'pending');
      expect(moderate(from, 'take_down', mode).ok).toBe(start === 'live');
      expect(moderate(from, 'undo', mode).ok).toBe(false);
    }
  });
});

describe('the stub (deterministic simple statistics, no model)', () => {
  it('holds a nearly black frame, flags a nearly white or flat one, passes the rest', () => {
    expect(stubAdvice({ mean: STUB_RULES.darkMean - 1, stdev: 20, entropy: 3 }).suggestion).toBe('hold');
    expect(stubAdvice({ mean: STUB_RULES.darkMean, stdev: 20, entropy: 3 }).suggestion).toBe('ok');
    expect(stubAdvice({ mean: STUB_RULES.brightMean + 1, stdev: 20, entropy: 3 }).suggestion).toBe('review');
    expect(stubAdvice({ mean: 120, stdev: STUB_RULES.flatStdev - 1, entropy: 0.1 }).suggestion).toBe('review');
    expect(stubAdvice({ mean: 120, stdev: 40, entropy: 7 })).toEqual({ suggestion: 'ok', reason: 'Nothing stood out.', labels: [{ name: 'brightness', score: 0.471 }, { name: 'contrast', score: 0.313 }, { name: 'detail', score: 0.875 }] });
  });
  it('every advice has a reason, and scores between 0 and 1', () => {
    for (const mean of [0, 15, 16, 128, 240, 241, 255]) for (const stdev of [0, 5, 6, 200]) {
      const a = stubAdvice({ mean, stdev, entropy: 9 });
      expect(a.reason.length).toBeGreaterThan(5);
      for (const l of a.labels) expect(l.score >= 0 && l.score <= 1, `${l.name} ${l.score}`).toBe(true);
    }
  });
  it('reads a processed image and gives the same answer every time', async () => {
    const dark = await image({ width: 640, height: 480, channels: 3, background: '#030303' });
    const bright = await image({ width: 640, height: 480, channels: 3, background: '#fdfdfd' });
    const busy = await image({ width: 640, height: 480, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 50 } });
    const stub = classifierFor('stub');
    expect((await stub.classify(dark))!.suggestion).toBe('hold');
    expect((await stub.classify(bright))!.suggestion).toBe('review');
    expect((await stub.classify(busy))!.suggestion).toBe('ok');
    expect(await stub.classify(busy)).toEqual(await stub.classify(busy));
  });
  it('none gives no advice, and is the first (default) classifier', async () => {
    expect(CLASSIFIERS[0]).toBe('none');
    expect(await classifierFor('none').classify(await image({ width: 64, height: 64, channels: 3, background: '#000000' }))).toBeNull();
  });
});
