// `npm run fixtures:check` (or `-- --write`): the TypeScript engine recomputes every schedule fixture's expect blocks.
// The expectations were first produced by the Python oracle (tools/schedule_oracle.py --write), so a clean check here
// means two implementations that share no code agree byte for byte (decisions D-23, D-25). Fixture 12 is the shipped
// default template; its tasks are written from src/lib/knotwork/schedule/template.ts so the two cannot drift.
// The same goes for fixtures/gifts/ (Phase 3): the TypeScript ledger writes each expect block, and tools/gift_oracle.py
// recomputes it independently under pytest. The photo fixtures (strip verification, the moderation table, the upload
// limits) are in gen-photo-fixtures.ts; tools/photo_limits.py is the oracle for the last two. Phase 4: fixtures/funding/
// (P1-2, the pledge arithmetic) is written by the TypeScript replay and recomputed by tools/funding_oracle.py;
// fixtures/thanks/ (P1-3, aging of the thank-you ledger) by thanks/aging.ts, recomputed by tools/thanks_oracle.py;
// fixtures/namechange/ (P1-4, ordering and gating) by namechange/workflow.ts against the rules files, recomputed by
// tools/namechange_oracle.py, which also re-checks the order of every file in rules/name-change/; fixtures/seating/
// (P1-5, generate-score-repair) by seating/engine.ts, re-scored (and, being small, solved by brute force) by
// tools/seating_oracle.py. Phase 5: fixtures/lifeadmin/ (anniversaries and recurring household tasks: month ends, leap
// days, daylight-saving days) by lifeadmin/recurrence.ts, recomputed by tools/recurrence_oracle.py.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeSchedule, previewMove, type PlanTask } from '../../src/lib/knotwork/schedule/engine';
import { replay as replayFunding, type Step as FundingStep } from '../../src/lib/knotwork/funding/ledger';
import { replay, type Step } from '../../src/lib/knotwork/gifts/ledger';
import { templatePlan } from '../../src/lib/knotwork/schedule/template';
import { ledger, type Obligation } from '../../src/lib/knotwork/thanks/aging';
import { RULESETS } from '../../src/lib/knotwork/namechange/rules';
import { board, invariantProblems, replay as replayNameChange, type Op as NameOp } from '../../src/lib/knotwork/namechange/workflow';
import { generate, type Problem as SeatingProblem } from '../../src/lib/knotwork/seating/engine';
import { addMonths, dayAt, nextAnniversary, nextDue, ruleText, type Rule } from '../../src/lib/knotwork/lifeadmin/recurrence';
import { LIMITS_DIR, MODERATION_FILE, regenerateLimits, regenerateModeration, regenerateStrip, STRIP_DIR, writeStripImages, type LimitFx } from './gen-photo-fixtures';

const DIR = 'fixtures/schedule';
type Fx = { name: string; note: string; weddingDate: string; today: string; tasks: PlanTask[]; expect?: unknown; move?: { to: string; expect?: unknown } };

export const TEMPLATE_FIXTURE: Fx = {
  name: '12-default-template',
  note: 'The shipped default template, about a year out: it resolves with nothing late and nothing impossible. Tasks are written from src/lib/knotwork/schedule/template.ts.',
  weddingDate: '2027-11-20',
  today: '2026-11-23',
  tasks: templatePlan(),
  move: { to: '2028-01-01' },
};

export function regenerate(fx: Fx): string {
  const { move } = fx;
  const rest = { name: fx.name, note: fx.note, weddingDate: fx.weddingDate, today: fx.today, tasks: fx.tasks };
  const expect = computeSchedule(fx.tasks, fx.weddingDate, fx.today);
  const full: Record<string, unknown> = { ...rest, expect: expect.invalid ? { invalid: expect.invalid } : expect };
  if (move) full.move = { to: move.to, expect: previewMove(fx.tasks, fx.weddingDate, move.to, fx.today) };
  return `${JSON.stringify(full, null, 2)}\n`;
}

const GIFT_DIR = 'fixtures/gifts';
export type GiftFx = { name: string; note: string; targetCents: number; race?: boolean; steps: Step[]; expect?: unknown };

/** A gift fixture with its expect block recomputed by the ledger: every step's outcome, then the ledger as it ends. */
export function regenerateGift(fx: GiftFx): string {
  const rest = { name: fx.name, note: fx.note, targetCents: fx.targetCents, ...(fx.race && { race: true }), steps: fx.steps };
  return `${JSON.stringify({ ...rest, expect: replay(fx.targetCents, fx.steps) }, null, 2)}\n`;
}

const FUNDING_DIR = 'fixtures/funding';
export type FundingFx = { name: string; note: string; steps: FundingStep[]; expect?: unknown };

/** A funding fixture with its expect block recomputed: every step's outcome, then each pledge and each category's mix. */
export function regenerateFunding(fx: FundingFx): string {
  return `${JSON.stringify({ name: fx.name, note: fx.note, steps: fx.steps, expect: replayFunding(fx.steps) }, null, 2)}\n`;
}

const THANKS_DIR = 'fixtures/thanks';
export type ThanksFx = { name: string; note: string; today: string; obligations: Obligation[]; expect?: unknown };

/** A thank-you ledger fixture with its expect block recomputed: still owed (oldest first, aged), thanked, the buckets. */
export function regenerateThanks(fx: ThanksFx): string {
  return `${JSON.stringify({ name: fx.name, note: fx.note, today: fx.today, obligations: fx.obligations, expect: ledger(fx.obligations, fx.today) }, null, 2)}\n`;
}

const NAMECHANGE_DIR = 'fixtures/namechange';
export type NameChangeFx = { name: string; note: string; rules: string; weddingDate: string; ops: NameOp[]; expect?: unknown };

/**
 * A name-change fixture with its expect block recomputed: each move's answer (allowed, or the refusal and what it
 * names), the progress it ends with, that the gating's invariants hold there, which steps could start next, and each
 * step's "from" day (the wedding date plus its offset).
 */
export function regenerateNameChange(fx: NameChangeFx): string {
  const r = RULESETS[fx.rules];
  if (!r) throw new Error(`${fx.name}: no rules file "${fx.rules}"`);
  const { outcomes, final } = replayNameChange(r, fx.ops);
  const b = board(r, final, fx.weddingDate);
  const expect = { outcomes, final, invariants: invariantProblems(r, final), next: b.next, from: Object.fromEntries(b.phases.flatMap((p) => p.steps.map((s) => [s.key, s.from]))) };
  return `${JSON.stringify({ name: fx.name, note: fx.note, rules: fx.rules, weddingDate: fx.weddingDate, ops: fx.ops, expect }, null, 2)}\n`;
}

const SEATING_DIR = 'fixtures/seating';
export type SeatingFx = SeatingProblem & { name: string; note: string; claim: 'optimal' | 'infeasible' | 'unsolved'; seed: number; expect?: unknown };

/** A seating fixture with its expect block recomputed: the status, any reasons it cannot work, the seats and the score. */
export function regenerateSeating(fx: SeatingFx): string {
  const { name, note, claim, seed, tables, guests, rules, locked } = fx;
  return `${JSON.stringify({ name, note, claim, seed, tables, guests, rules, locked, expect: generate({ tables, guests, rules, locked }, seed) }, null, 2)}\n`;
}

const LIFE_DIR = 'fixtures/lifeadmin';
export type LifeFx = { name: string; note: string; weddingDate: string; timeZone: string; at: string; tasks: { id: string; rule: Rule; done: string[] }[]; months: { from: string; n: number }[]; expect?: unknown };

/**
 * A life-admin fixture with its expect block recomputed: today (the calendar day at `at` in the wedding's time zone),
 * the next anniversary, each task's next due day and state, and each month step.
 */
export function regenerateLife(fx: LifeFx): string {
  const today = dayAt(fx.timeZone, new Date(fx.at));
  const expect = {
    today,
    anniversary: nextAnniversary(fx.weddingDate, today),
    tasks: fx.tasks.map((t) => ({ id: t.id, rule: ruleText(t.rule), ...nextDue(t.rule, fx.weddingDate, t.done, today) })),
    months: fx.months.map((m) => addMonths(m.from, m.n)),
  };
  const { name, note, weddingDate, timeZone, at, tasks, months } = fx;
  return `${JSON.stringify({ name, note, weddingDate, timeZone, at, tasks, months, expect }, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const write = process.argv.includes('--write');
  if (write) writeFileSync(join(DIR, `${TEMPLATE_FIXTURE.name}.json`), regenerate(TEMPLATE_FIXTURE));
  let diffs = 0;
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.json')).sort()) {
    const text = readFileSync(join(DIR, f), 'utf8');
    const next = regenerate(JSON.parse(text) as Fx);
    if (next !== text) {
      diffs++;
      if (write) writeFileSync(join(DIR, f), next);
    }
    console.log(`${next === text ? 'same ' : write ? 'wrote' : 'DIFF '} ${f}`);
  }
  for (const f of readdirSync(GIFT_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const text = readFileSync(join(GIFT_DIR, f), 'utf8');
    const next = regenerateGift(JSON.parse(text) as GiftFx);
    if (next !== text) {
      diffs++;
      if (write) writeFileSync(join(GIFT_DIR, f), next);
    }
    console.log(`${next === text ? 'same ' : write ? 'wrote' : 'DIFF '} gifts/${f}`);
  }
  for (const f of readdirSync(FUNDING_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const text = readFileSync(join(FUNDING_DIR, f), 'utf8');
    const next = regenerateFunding(JSON.parse(text) as FundingFx);
    if (next !== text) {
      diffs++;
      if (write) writeFileSync(join(FUNDING_DIR, f), next);
    }
    console.log(`${next === text ? 'same ' : write ? 'wrote' : 'DIFF '} funding/${f}`);
  }
  for (const f of readdirSync(THANKS_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const text = readFileSync(join(THANKS_DIR, f), 'utf8');
    const next = regenerateThanks(JSON.parse(text) as ThanksFx);
    if (next !== text) {
      diffs++;
      if (write) writeFileSync(join(THANKS_DIR, f), next);
    }
    console.log(`${next === text ? 'same ' : write ? 'wrote' : 'DIFF '} thanks/${f}`);
  }
  for (const f of readdirSync(NAMECHANGE_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const text = readFileSync(join(NAMECHANGE_DIR, f), 'utf8');
    const next = regenerateNameChange(JSON.parse(text) as NameChangeFx);
    if (next !== text) {
      diffs++;
      if (write) writeFileSync(join(NAMECHANGE_DIR, f), next);
    }
    console.log(`${next === text ? 'same ' : write ? 'wrote' : 'DIFF '} namechange/${f}`);
  }
  for (const f of readdirSync(SEATING_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const text = readFileSync(join(SEATING_DIR, f), 'utf8');
    const next = regenerateSeating(JSON.parse(text) as SeatingFx);
    if (next !== text) {
      diffs++;
      if (write) writeFileSync(join(SEATING_DIR, f), next);
    }
    console.log(`${next === text ? 'same ' : write ? 'wrote' : 'DIFF '} seating/${f}`);
  }
  for (const f of readdirSync(LIFE_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const text = readFileSync(join(LIFE_DIR, f), 'utf8');
    const next = regenerateLife(JSON.parse(text) as LifeFx);
    if (next !== text) {
      diffs++;
      if (write) writeFileSync(join(LIFE_DIR, f), next);
    }
    console.log(`${next === text ? 'same ' : write ? 'wrote' : 'DIFF '} lifeadmin/${f}`);
  }
  // Photos. Images are written only when missing, or with --images (their bytes depend on the encoder's version).
  for (const name of await writeStripImages(process.argv.includes('--images'))) console.log(`wrote photos/strip/${name}`);
  const check = (label: string, path: string, text: string, next: string) => {
    if (next !== text) {
      diffs++;
      if (write) writeFileSync(path, next);
    }
    console.log(`${next === text ? 'same ' : write ? 'wrote' : 'DIFF '} ${label}`);
  };
  const manifest = join(STRIP_DIR, 'manifest.json');
  check('photos/strip/manifest.json', manifest, readFileSync(manifest, 'utf8'), await regenerateStrip(readFileSync(manifest, 'utf8')));
  check('photos/moderation.json', MODERATION_FILE, existsSync(MODERATION_FILE) ? readFileSync(MODERATION_FILE, 'utf8') : '', regenerateModeration());
  for (const f of readdirSync(LIMITS_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const text = readFileSync(join(LIMITS_DIR, f), 'utf8');
    check(`photos/limits/${f}`, join(LIMITS_DIR, f), text, regenerateLimits(JSON.parse(text) as LimitFx));
  }
  if (diffs && !write) process.exit(1);
}
