// P1-4: the name-change workflows, as data. Each file in rules/name-change/ is one jurisdiction's ordered workflow,
// ILLUSTRATIVE ONLY (not legal advice; no fees or processing times): a generic fallback and three US states. Every
// file is parsed by the zod schema below and then checked for order and gating (workflow.ts `checkRules`) when this
// module loads, so a broken file stops the app at start-up rather than misleading anyone; tests/knotwork/
// namechange-pure.test.ts loads every file in the folder and fails on one that is not listed here.
//
// Not on the pure list only because it imports zod; it reads no database and no clock.
import { z } from 'zod';
import generic from '../../../../rules/name-change/generic.json';
import usCa from '../../../../rules/name-change/us-ca.json';
import usNy from '../../../../rules/name-change/us-ny.json';
import usTx from '../../../../rules/name-change/us-tx.json';
import { checkRules, PHASES, type Ruleset } from './workflow';

export const KEY_RE = /^[a-z0-9-]{1,40}$/;
const key = z.string().regex(KEY_RE, 'a key is lowercase letters, digits and dashes');
const text = (max: number) => z.string().trim().min(1).max(max);

export const RULESET = z.strictObject({
  jurisdiction: key,
  name: text(80),
  fallback: z.boolean(),
  illustrative: z.literal(true),
  notice: text(600).refine((t) => /illustrative/i.test(t) && /not legal advice/i.test(t), 'the notice must say the content is illustrative and not legal advice'),
  artifacts: z.array(z.strictObject({ key, label: text(120), producedBy: key.nullable() })).min(1).max(30),
  steps: z.array(z.strictObject({
    key,
    phase: z.enum(PHASES),
    title: text(120),
    notes: text(400),
    prerequisites: z.array(key).max(10),
    artifacts: z.array(key).max(10),
    startAfterDays: z.number().int().min(0).max(365),
  })).min(1).max(40),
});

/** A ruleset from JSON: the zod shape, then the order and gating checks. Throws with every problem named. */
export function parseRuleset(json: unknown, file = 'rules'): Ruleset {
  const parsed = RULESET.safeParse(json);
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const problems = checkRules(parsed.data);
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
  return parsed.data;
}

const FILES: Record<string, unknown> = { generic, 'us-ca': usCa, 'us-ny': usNy, 'us-tx': usTx };
/** Every jurisdiction, by key (its file name). Exactly one is the fallback. */
export const RULESETS: Readonly<Record<string, Ruleset>> = Object.fromEntries(
  Object.entries(FILES).map(([k, json]) => {
    const r = parseRuleset(json, `rules/name-change/${k}.json`);
    if (r.jurisdiction !== k) throw new Error(`rules/name-change/${k}.json: jurisdiction must be "${k}"`);
    return [k, r];
  }),
);
export const FALLBACK = Object.values(RULESETS).find((r) => r.fallback)!.jurisdiction;
if (Object.values(RULESETS).filter((r) => r.fallback).length !== 1) throw new Error('rules/name-change: exactly one file must be the fallback');

/** The rules for a jurisdiction, or the fallback's for one Knotwork has no file for. */
export const rulesFor = (jurisdiction: string): Ruleset => RULESETS[jurisdiction] ?? RULESETS[FALLBACK]!;

/** The choices on the form: the states first, A to Z, then the fallback. */
export const JURISDICTIONS: readonly { key: string; name: string }[] = [
  ...Object.values(RULESETS).filter((r) => !r.fallback).sort((a, b) => a.name.localeCompare(b.name)),
  RULESETS[FALLBACK]!,
].map((r) => ({ key: r.jurisdiction, name: r.name }));
