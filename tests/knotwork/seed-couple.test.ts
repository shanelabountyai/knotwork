import { beforeAll, describe, expect, it } from 'vitest';
import { demoSignIn } from '@/core/auth/demo';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { loadBudget } from '@/lib/knotwork/budget-store';
import { loadGuestState } from '@/lib/knotwork/guests/store';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { loadSchedule } from '@/lib/knotwork/schedule/store';
import { COUPLE, seedCouple } from '../../scripts/knotwork/seed-couple';
import { resetAuthTables } from '../helpers/auth';

// The demo seed (PRD Phase 1 gate): one synthetic couple, built through the same stores the actions use.
let orgId: string;
const today = () => todayIn(COUPLE.timeZone, now());

beforeAll(async () => {
  await resetAuthTables();
  await seedCouple();
  await seedCouple(); // idempotent: the second run replaces the first
  orgId = (await db.org.findUniqueOrThrow({ where: { slug: COUPLE.slug } })).id;
});

describe('seed:couple', () => {
  it('makes exactly one workspace with two partners and one helper, all synthetic demo accounts', async () => {
    expect(await db.org.count()).toBe(1);
    const members = await db.membership.findMany({ where: { orgId }, include: { user: true }, orderBy: { user: { email: 'asc' } } });
    expect(members.map((m) => [m.user.email, m.role, m.user.isDemo])).toEqual([
      ['juniper@knotwork.demo.test', 'owner', true],
      ['maple@knotwork.demo.test', 'member', true],
      ['rowan@knotwork.demo.test', 'owner', true],
    ]);
    expect(await db.user.count()).toBe(3);
    for (const m of members) expect(m.user.email.endsWith('.demo.test')).toBe(true); // a reserved test domain, never a real address
    // The accounts sign in only while DEMO_MODE=1 (INV-27's rule, applied to these three).
    expect(await demoSignIn(members[0]!.userId, { DEMO_MODE: undefined })).toBeNull();
  });

  it('the wedding is 330 days out and the plan has nothing late or impossible', async () => {
    const wedding = await db.wedding.findUniqueOrThrow({ where: { orgId } });
    expect(dayOfDb(wedding.date)).toBe(addDays(today(), 330));
    const { schedule, rows } = await withOrg({ orgId }, (tx) => loadSchedule(tx, { orgId }, wedding));
    expect(rows).toHaveLength(24); // 20 from the template, 3 payments, the derived RSVP deadline
    expect(Object.values(schedule.tasks).filter((t) => t.state === 'late' || t.state === 'impossible')).toEqual([]);
    expect(rows.find((t) => t.key === 'rsvp-deadline')).toMatchObject({ bufferDays: 21 + 14 }); // the venue asks 21 days before; chase buffer 14
  });

  it('every booked or signed vendor, and the one large spend, carries a request approved by the OTHER partner', async () => {
    const vendors = await db.vendor.findMany({ where: { orgId }, include: { bookedRequest: true, contractRequest: true }, orderBy: { name: 'asc' } });
    expect(vendors.map((v) => [v.name, v.status])).toEqual([['Cedar Hollow Barn', 'booked'], ['Fennel & Fig Catering', 'booked'], ['Wild Rye Flowers', 'considering']]);
    const requests = await db.consentRequest.findMany({ where: { orgId } });
    expect(requests).toHaveLength(4);
    for (const r of requests) {
      expect(r.status).toBe('approved');
      expect(r.deciderId).not.toBeNull();
      expect(r.deciderId).not.toBe(r.proposerId);
    }
    for (const v of vendors.filter((x) => x.status === 'booked')) expect(v.bookedRequest).toMatchObject({ kind: 'book_vendor', status: 'approved' });
    expect(vendors[0]!.contractRequest).toMatchObject({ kind: 'sign_contract', status: 'approved' });
    const big = await db.expense.findMany({ where: { orgId, amountCents: { gt: 50_000 } }, include: { request: true } });
    expect(big).toHaveLength(1);
    expect(big[0]!.request).toMatchObject({ kind: 'spend', status: 'approved' });
  });

  it('the budget adds up: $31,000.00 estimated, $2,150.00 spent', async () => {
    const b = await withOrg({ orgId }, (tx) => loadBudget(tx, { orgId }));
    expect(b.estimateCents).toBe(950_000 + 1_200_000 + 300_000 + 250_000 + 400_000);
    expect(b.actualCents).toBe(200_000 + 15_000);
    expect(b.lines.map((l) => l.name)).toEqual(['Attire', 'Catering', 'Flowers', 'Music', 'Venue']);
  });

  it('the guest list fills the cap exactly, with the B list waiting, and costs $423.00 so far', async () => {
    const s = await withOrg({ orgId }, (tx) => loadGuestState(tx, { orgId }));
    expect(s.cap).toEqual({ cap: 12, held: 12, attending: 5, pending: 7, declined: 0, available: 0 });
    expect(s.count).toMatchObject({ attending: 5, adults: 4, kids: 1, vendorMeals: 1, catererMeals: 6, invited: 10, responded: 5, responseRatePct: 50 });
    expect(s.costCents).toBe(4 * 8700 + 3500 + 4000);
    expect(s.rows.filter((h) => h.list === 'B').map((h) => h.state)).toEqual(['queued', 'queued', 'queued']);
    for (const h of s.rows.filter((x) => x.state === 'invited')) expect(h.rsvpTokenHash).toMatch(/^[0-9a-f]{64}$/);
    for (const h of s.rows) for (const g of h.guests) expect(g.name).not.toMatch(/@/);
  });

  it('no vendor needs re-confirmation at the start, each has a brief, and the helper has one grant', async () => {
    expect(await db.vendorFlag.count({ where: { orgId } })).toBe(0);
    expect(await db.vendorBrief.count({ where: { orgId } })).toBe(3);
    expect((await db.helperGrant.findMany({ where: { orgId } })).map((g) => g.scope)).toEqual(['budget_view']);
  });
});
