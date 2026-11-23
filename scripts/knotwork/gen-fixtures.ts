// `npm run fixtures:check` (or `-- --write`): the TypeScript engine recomputes every schedule fixture's expect blocks.
// The expectations were first produced by the Python oracle (tools/schedule_oracle.py --write), so a clean check here
// means two implementations that share no code agree byte for byte (decisions D-23, D-25). Fixture 12 is the shipped
// default template; its tasks are written from src/lib/knotwork/schedule/template.ts so the two cannot drift.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeSchedule, previewMove, type PlanTask } from '../../src/lib/knotwork/schedule/engine';
import { templatePlan } from '../../src/lib/knotwork/schedule/template';

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
  const { expect: _e, move, ...rest } = fx;
  const expect = computeSchedule(fx.tasks, fx.weddingDate, fx.today);
  const full: Record<string, unknown> = { ...rest, expect: expect.invalid ? { invalid: expect.invalid } : expect };
  if (move) full.move = { to: move.to, expect: previewMove(fx.tasks, fx.weddingDate, move.to, fx.today) };
  return `${JSON.stringify(full, null, 2)}\n`;
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
  if (diffs && !write) process.exit(1);
}
