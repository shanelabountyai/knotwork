import { globSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FALLBACK, JURISDICTIONS, parseRuleset, RULESETS, rulesFor } from '@/lib/knotwork/namechange/rules';
import { apply, board, check, checkRules, emptyProgress, invariantProblems, OPS, replay, type Op, type Progress, type Ruleset } from '@/lib/knotwork/namechange/workflow';
import { readJson, ROOT } from './fixtures';

// P1-4, the name-change sequence: rules as data (every file in rules/name-change/ loads through the zod schema and the
// order check), an ordered workflow, and artifacts gating steps. The fixtures are recomputed by
// scripts/knotwork/gen-fixtures.ts and, independently, by tools/namechange_oracle.py.
const generic = RULESETS.generic!;
const clone = (r: Ruleset): Ruleset => JSON.parse(JSON.stringify(r)) as Ruleset;
const run = (r: Ruleset, ops: [Op['op'], string][]) => replay(r, ops.map(([op, key]) => ({ op, key })));

describe('rules as data', () => {
  it('every file in rules/name-change/ is loaded, parsed and checked; exactly one is the fallback', () => {
    const files = globSync('rules/name-change/*.json', { cwd: ROOT }).map((f) => f.replace(/^.*\/(.+)\.json$/, '$1')).sort();
    expect(files).toEqual(Object.keys(RULESETS).sort());
    expect(files).toEqual(['generic', 'us-ca', 'us-ny', 'us-tx']); // a generic fallback and three US states
    for (const f of files) expect(parseRuleset(readJson(join('rules/name-change', `${f}.json`)), f)).toEqual(RULESETS[f]);
    expect(FALLBACK).toBe('generic');
    expect(JURISDICTIONS.map((j) => j.key)).toEqual(['us-ca', 'us-ny', 'us-tx', 'generic']);
  });
  it('every file is labelled illustrative and not legal advice, and claims no fee or processing time', () => {
    for (const r of Object.values(RULESETS)) {
      expect(r.illustrative).toBe(true);
      expect(r.notice).toMatch(/Illustrative example only, not legal advice/);
      const text = JSON.stringify(r);
      expect(text, r.jurisdiction).not.toMatch(/\$\d|\bbusiness days?\b|\bweeks?\b|\bwithin \d/i);
      if (!r.fallback) expect(r.name, r.jurisdiction).toMatch(/\(illustrative\)$/);
    }
  });
  it('the order is the PRD\'s: federal, then state, passport, accounts', () => {
    for (const r of Object.values(RULESETS)) {
      const phases = r.steps.map((s) => s.phase);
      expect(phases[0]).toBe('federal');
      expect(phases.at(-1)).toBe('accounts');
      expect([...phases].sort((a, b) => ['federal', 'state', 'passport', 'accounts'].indexOf(a) - ['federal', 'state', 'passport', 'accounts'].indexOf(b))).toEqual(phases);
    }
  });
  it('an unknown jurisdiction gets the generic fallback', () => {
    expect(rulesFor('us-zz')).toBe(generic);
    expect(rulesFor('us-ca').jurisdiction).toBe('us-ca');
  });
  it('the schema refuses a file that is not illustrative, has a bad key, a bad phase or an extra field', () => {
    const base = readJson<Record<string, unknown>>('rules/name-change/generic.json');
    expect(() => parseRuleset({ ...base, illustrative: false })).toThrow(/illustrative/);
    expect(() => parseRuleset({ ...base, notice: 'Official requirements.' })).toThrow(/not legal advice/);
    expect(() => parseRuleset({ ...base, jurisdiction: 'US CA' })).toThrow(/lowercase/);
    expect(() => parseRuleset({ ...base, fee: '$10' })).toThrow();
    const steps = (base.steps as Record<string, unknown>[]).map((s, i) => (i === 0 ? { ...s, phase: 'county' } : s));
    expect(() => parseRuleset({ ...base, steps })).toThrow(/phase/);
  });
  it('the order check refuses a step before what it waits for, a phase going back, an unknown name, and an undeclared product', () => {
    const swapped = clone(generic);
    swapped.steps.unshift(swapped.steps.splice(1, 1)[0]!); // the state step first
    expect(checkRules(swapped).join('\n')).toMatch(/waits for "ssa", which comes later/);
    expect(checkRules(swapped).join('\n')).toMatch(/comes after a state step/);
    const unknown = clone(generic);
    unknown.steps[1]!.prerequisites.push('nope');
    unknown.steps[1]!.artifacts.push('nada');
    expect(checkRules(unknown)).toEqual(expect.arrayContaining(['step "dmv" waits for "nope", which is not a step', 'step "dmv" needs "nada", which is not an artifact']));
    // The passport step needs the new Social Security card without waiting for the step that produces it.
    const sneaky = clone(generic);
    sneaky.steps.find((s) => s.key === 'employer')!.prerequisites = [];
    expect(checkRules(sneaky)).toEqual(['step "employer" needs "new-ss-card", which comes out of "ssa", a step it does not wait for']);
    const unused = clone(generic);
    unused.artifacts.push({ key: 'spare', label: 'A spare', producedBy: null });
    expect(checkRules(unused)).toEqual(['artifact "spare" is not needed by any step']);
    for (const r of Object.values(RULESETS)) expect(checkRules(r), r.jurisdiction).toEqual([]);
  });
});

describe('gating: a step starts only when what it waits for is done and the documents it needs are held', () => {
  it('nothing can start with nothing held; holding both documents opens exactly the first step', () => {
    expect(board(generic, emptyProgress(), '2027-10-09').next).toEqual([]);
    expect(check(generic, emptyProgress(), { op: 'start', key: 'ssa' })).toEqual({ ok: false, code: 'artifacts', keys: ['marriage-certificate', 'proof-of-identity'] });
    const p = run(generic, [['hold', 'marriage-certificate'], ['hold', 'proof-of-identity']]).final;
    expect(board(generic, p, '2027-10-09').next).toEqual(['ssa']);
    expect(check(generic, p, { op: 'finish', key: 'dmv' })).toEqual({ ok: false, code: 'prerequisites', keys: ['ssa'] });
  });
  it('a document produced by a step is held only after it, and the step cannot be reopened while it is held', () => {
    const r = run(generic, [['hold', 'new-ss-card'], ['hold', 'marriage-certificate'], ['hold', 'proof-of-identity'], ['finish', 'ssa'], ['hold', 'new-ss-card'], ['reopen', 'ssa']]);
    expect(r.outcomes.map((o) => (o.ok ? 'ok' : o.code))).toEqual(['not-produced', 'ok', 'ok', 'ok', 'ok', 'produced-held']);
  });
  it('every move keeps the three facts, whatever order the moves come in (every move tried from many states)', () => {
    // A breadth-first walk over the generic workflow's reachable states, trying every move from each.
    const moves: Op[] = [...generic.steps.flatMap((s) => (['start', 'finish', 'stop', 'reopen'] as const).map((op) => ({ op, key: s.key }))), ...generic.artifacts.flatMap((a) => (['hold', 'release'] as const).map((op) => ({ op, key: a.key })))];
    expect(OPS).toHaveLength(6);
    const seen = new Set<string>();
    const queue: Progress[] = [emptyProgress()];
    while (queue.length && seen.size < 3000) {
      const p = queue.shift()!;
      const id = JSON.stringify([Object.entries(p.steps).sort(), p.held]);
      if (seen.has(id)) continue;
      seen.add(id);
      expect(invariantProblems(generic, p), id).toEqual([]);
      for (const m of moves) if (check(generic, p, m).ok) queue.push(apply(p, m));
    }
    expect(seen.size).toBeGreaterThan(500);
  });
});

describe('the "from" day is the wedding date plus an offset (rule 1: nothing stored)', () => {
  it('moves with the wedding', () => {
    const a = board(generic, emptyProgress(), '2027-10-09').phases[0]!.steps[0]!;
    const b = board(generic, emptyProgress(), '2027-11-20').phases[0]!.steps[0]!;
    expect([a.from, b.from]).toEqual(['2027-10-16', '2027-11-27']);
  });
});

type Fx = { name: string; rules: string; weddingDate: string; ops: Op[]; expect: { outcomes: unknown; final: unknown; invariants: string[]; next: string[]; from: Record<string, string> } };
describe('the fixtures (also recomputed by tools/namechange_oracle.py)', () => {
  const files = globSync('fixtures/namechange/*.json', { cwd: ROOT }).sort();
  it('there are at least eight', () => expect(files.length).toBeGreaterThanOrEqual(8));
  it.each(files)('%s', (f) => {
    const fx = readJson<Fx>(f);
    const r = replay(RULESETS[fx.rules]!, fx.ops);
    expect(r.outcomes).toEqual(fx.expect.outcomes);
    expect(r.final).toEqual(fx.expect.final);
    expect(invariantProblems(RULESETS[fx.rules]!, r.final)).toEqual([]);
    expect(board(RULESETS[fx.rules]!, r.final, fx.weddingDate).next).toEqual(fx.expect.next);
  });
});
