import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays } from '@/lib/knotwork/days';
import { computeSchedule, previewMove, type PlanTask } from '@/lib/knotwork/schedule/engine';
import { templatePlan } from '@/lib/knotwork/schedule/template';
import { regenerate, TEMPLATE_FIXTURE } from '../../scripts/knotwork/gen-fixtures';
import { ROOT, scheduleFixture, scheduleFixtures } from './fixtures';

// Cross-language: random plans through the TypeScript engine and the Python oracle must agree exactly (dates, states,
// critical path, move sets, fingerprint). Skips without python3 unless KNOTWORK_REQUIRE_PYTHON=1 (CI sets it).
const python = process.env.KNOTWORK_PYTHON ?? 'python3';
const hasPython = spawnSync(python, ['-c', 'import sys; assert sys.version_info >= (3, 9)']).status === 0;
if (process.env.KNOTWORK_REQUIRE_PYTHON === '1' && !hasPython) throw new Error('KNOTWORK_REQUIRE_PYTHON=1 but python3 is not available');

// mulberry32: a seeded generator, so a failure reproduces.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPlan(rand: () => number): PlanTask[] {
  const n = 1 + Math.floor(rand() * 9);
  const tasks: PlanTask[] = [];
  for (let i = 0; i < n; i++) {
    const id = `t${String.fromCharCode(97 + ((i * 7) % 26))}${i}`; // ids not in creation order, so tie-breaks are exercised
    const dependsOn = tasks.filter(() => rand() < 0.3).map((t) => t.id); // only earlier tasks: no cycles
    tasks.push({ id, title: id, leadDays: Math.floor(rand() * 4) * Math.floor(rand() * 40), bufferDays: Math.floor(rand() * 3) * Math.floor(rand() * 60), dependsOn, done: rand() < 0.2 });
  }
  return tasks;
}

describe.skipIf(!hasPython)('TypeScript engine and Python oracle', () => {
  it('agree on 300 seeded random plans, each with a random move', () => {
    const rand = prng(20261123);
    const today = '2026-11-23';
    const plans = Array.from({ length: 300 }, () => {
      const tasks = randomPlan(rand);
      const weddingDate = addDays(today, Math.floor(rand() * 500) - 20);
      return { tasks, weddingDate, today, to: addDays(weddingDate, Math.floor(rand() * 240) - 120) };
    });
    const r = spawnSync(python, ['-I', join(ROOT, 'tools/schedule_oracle.py'), '--stdin'], { input: JSON.stringify(plans), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    const theirs = JSON.parse(r.stdout) as { expect: unknown; move: unknown }[];
    const states = new Set<string>();
    plans.forEach((p, i) => {
      const mine = computeSchedule(p.tasks, p.weddingDate, p.today);
      expect(mine, `plan ${i}`).toEqual(theirs[i]!.expect);
      expect(previewMove(p.tasks, p.weddingDate, p.to, p.today), `move ${i}`).toEqual(theirs[i]!.move);
      for (const t of Object.values(mine.tasks ?? {})) states.add(t.state);
    });
    expect([...states].sort()).toEqual(['done', 'impossible', 'late', 'ok']); // the sample reaches every state
  });
});

describe('fixtures on disk', () => {
  it('are exactly what the TypeScript engine regenerates (the oracle wrote them first)', () => {
    for (const f of scheduleFixtures) expect(regenerate(f as never), f.name).toBe(`${JSON.stringify(f, null, 2)}\n`);
  });
  it('fixture 12 is the shipped default template', () => {
    expect(scheduleFixture('12-default-template').tasks).toEqual(templatePlan());
    expect(TEMPLATE_FIXTURE.tasks).toEqual(templatePlan());
  });
  it('the default template has nothing late or impossible about a year out, and its critical path is the attire chain', () => {
    const f = scheduleFixture('12-default-template');
    const s = computeSchedule(f.tasks, f.weddingDate, f.today);
    expect(Object.values(s.tasks!).filter((t) => t.state !== 'ok')).toEqual([]);
    expect(s.criticalPath).toEqual(['choose-attire', 'order-attire', 'alterations']);
  });
});
