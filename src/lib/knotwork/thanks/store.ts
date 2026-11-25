// The thank-you ledger in the database (PRD P1-3). It reads three tables and writes one:
//   - ThankYou (Phase 3): one per household that gave toward a pooled gift that funded; received on the day it funded.
//   - RegistryClaim (P1-8): a household marked a store item as bought; received on the day it said so.
//   - GiftLog: a gift the couple records by hand (the gift log), from a household or a named person.
// Every obligation is (who, what, received on, acknowledged on). PRIVACY (P0-5): nothing here reads the gift ledger or
// any amount; for a pooled gift the obligation names the gift and the household, as the couple's registry does.
// Aging is computed on read (thanks/aging.ts) from received-on; nothing about it is stored (rule 1).
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { logChange } from '../changelog';
import { requireWedding, todayOf } from '../context';
import { dayOfDb, dbOfDay, todayIn, type Day } from '../days';
import type { Obligation } from './aging';

type Ctx = { orgId: string; userId: string | null };

/** Every obligation of the workspace, in no particular order (aging.ts `ledger` sorts and buckets them). */
export async function loadObligations(tx: Tx, ctx: { orgId: string }): Promise<Obligation[]> {
  const wedding = await requireWedding(tx, ctx);
  const pooled = await tx.thankYou.findMany({ where: { orgId: ctx.orgId }, select: { id: true, createdAt: true, acknowledgedOn: true, household: { select: { name: true } }, item: { select: { title: true, fundedOn: true } } } });
  const claimed = await tx.registryClaim.findMany({ where: { orgId: ctx.orgId }, select: { id: true, claimedOn: true, acknowledgedOn: true, household: { select: { name: true } }, link: { select: { title: true } } } });
  const logged = await tx.giftLog.findMany({ where: { orgId: ctx.orgId }, select: { id: true, giverName: true, what: true, receivedOn: true, acknowledgedOn: true, household: { select: { name: true } } } });
  const ack = (d: Date | null): Day | null => (d ? dayOfDb(d) : null);
  return [
    ...pooled.map((t) => ({ source: 'pooled' as const, id: t.id, giver: t.household.name, what: t.item.title, receivedOn: t.item.fundedOn ? dayOfDb(t.item.fundedOn) : todayIn(wedding.timeZone, t.createdAt), acknowledgedOn: ack(t.acknowledgedOn) })),
    ...claimed.map((c) => ({ source: 'claimed' as const, id: c.id, giver: c.household.name, what: c.link.title, receivedOn: dayOfDb(c.claimedOn), acknowledgedOn: ack(c.acknowledgedOn) })),
    ...logged.map((g) => ({ source: 'logged' as const, id: g.id, giver: g.household?.name ?? g.giverName, what: g.what, receivedOn: dayOfDb(g.receivedOn), acknowledgedOn: ack(g.acknowledgedOn) })),
  ];
}

/** A gift from a household (`householdId`) or from a named person (`giverName`): exactly one of the two. */
export type GiftInput = { householdId: string | null; giverName: string; what: string; receivedOn: Day };

export async function logGift(tx: Tx, ctx: Ctx, input: GiftInput) {
  const household = input.householdId ? await tx.household.findFirstOrThrow({ where: { id: input.householdId, ...inOrg(ctx) }, select: { name: true } }) : null;
  const giver = household?.name ?? input.giverName;
  const row = await tx.giftLog.create({ data: { orgId: ctx.orgId, householdId: input.householdId, giverName: household ? '' : input.giverName, what: input.what, receivedOn: dbOfDay(input.receivedOn), createdById: ctx.userId } });
  await logChange(tx, ctx, 'giftlog', 'created', row.id, `${giver}: ${input.what}`, null, { giver, what: input.what, receivedOn: input.receivedOn });
  return row;
}

/** A gift logged by mistake goes (thanked or not); the change log keeps what it was. */
export async function removeGift(tx: Tx, ctx: Ctx, id: string) {
  const g = await tx.giftLog.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { household: { select: { name: true } } } });
  const giver = g.household?.name ?? g.giverName;
  await tx.giftLog.delete({ where: { id } });
  await logChange(tx, ctx, 'giftlog', 'deleted', id, `${giver}: ${g.what}`, { giver, what: g.what, receivedOn: dayOfDb(g.receivedOn), acknowledgedOn: g.acknowledgedOn ? dayOfDb(g.acknowledgedOn) : null }, null);
}

/** A partner marks the thank-you for a logged gift as sent. Once. */
export async function acknowledgeGift(tx: Tx, ctx: Ctx & { userId: string }, id: string) {
  const g = await tx.giftLog.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { household: { select: { name: true } } } });
  if (g.acknowledgedOn) throw new Refused('That thank-you is already marked as sent.');
  const on = todayOf(await requireWedding(tx, ctx));
  await tx.giftLog.update({ where: { id }, data: { acknowledgedOn: dbOfDay(on), acknowledgedById: ctx.userId } });
  await logChange(tx, ctx, 'giftlog', 'acknowledged', id, `${g.household?.name ?? g.giverName}: ${g.what}`, { acknowledgedOn: null }, { acknowledgedOn: on });
}
