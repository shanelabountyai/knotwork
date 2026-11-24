import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoryMix, checkAllocation, checkPledge, checkReceipt, checkUnreceive, pledgeLines, replay, stageOf, type Step } from '@/lib/knotwork/funding/ledger';
import { readJson, ROOT } from './fixtures';

// P1-2: the pledge arithmetic, without a database. The fixtures' expect blocks are written by the TypeScript replay
// (npm run fixtures:check) and recomputed independently by tools/funding_oracle.py under pytest.
const DIR = 'fixtures/funding';
const files = readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('.json')).sort();

describe('funding fixtures', () => {
  it('there are at least nine', () => expect(files.length).toBeGreaterThanOrEqual(9));
  it.each(files)('%s', (f) => {
    const fx = readJson<{ steps: Step[]; expect: unknown }>(`${DIR}/${f}`);
    expect(replay(fx.steps)).toEqual(fx.expect);
  });
});

describe('the stages and the checks', () => {
  it('pledged → partly received → received → spent', () => {
    expect([stageOf(100, 0, 0), stageOf(100, 50, 0), stageOf(100, 100, 50), stageOf(100, 100, 100)]).toEqual(['pledged', 'partly_received', 'received', 'spent']);
  });
  it('lines and mixes are integer sums; a float is refused', () => {
    const lines = pledgeLines([{ id: 'p1', funderId: 'f1', categoryId: 'c1', amountCents: 1000 }, { id: 'p2', funderId: 'f2', categoryId: 'c1', amountCents: 500 }], [{ id: 'r', pledgeId: 'p1', amountCents: 400 }], [{ id: 'a', pledgeId: 'p1', expenseId: 'e', amountCents: 150 }]);
    expect(lines[0]).toEqual({ pledgeId: 'p1', funderId: 'f1', categoryId: 'c1', pledgedCents: 1000, receivedCents: 400, spentCents: 150, outstandingCents: 600, unspentCents: 250, stage: 'partly_received' });
    expect(categoryMix(lines)).toEqual([{ categoryId: 'c1', pledgedCents: 1500, receivedCents: 400, spentCents: 150, pledges: lines }]);
    expect(() => pledgeLines([{ id: 'p', funderId: 'f', categoryId: 'c', amountCents: 1.5 }], [], [])).toThrow(/integer cents/);
  });
  it('each refusal, by name', () => {
    const line = pledgeLines([{ id: 'p', funderId: 'f', categoryId: 'c', amountCents: 1000 }], [{ id: 'r', pledgeId: 'p', amountCents: 600 }], [{ id: 'a', pledgeId: 'p', expenseId: 'e', amountCents: 500 }])[0]!;
    expect([checkPledge(99), checkPledge(100_000_001), checkPledge(100), checkPledge(599, line), checkPledge(600, line)]).toEqual(['amount', 'amount', null, 'below-received', null]);
    expect([checkReceipt(line, 0), checkReceipt(line, 401), checkReceipt(line, 400)]).toEqual(['amount', 'over-pledge', null]);
    expect([checkUnreceive(line, 101), checkUnreceive(line, 100)]).toEqual(['spent', null]);
    const e = { id: 'e2', categoryId: 'c', amountCents: 300 };
    expect([checkAllocation(line, { ...e, categoryId: 'x' }, 0, 1), checkAllocation(line, e, 0, 101), checkAllocation(line, e, 250, 51), checkAllocation(line, e, 250, 50)]).toEqual(['wrong-category', 'over-received', 'over-expense', null]);
  });
});
