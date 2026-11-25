// P1-7, the progress dashboard's figures that are not tasks, vendors or budget lines (those come through
// secrecy/views.ts `dashboardView`, so they pass the lens): headcount against the cap, the approvals waiting, the
// thank-you ledger and its aging, the contingency plans and the seating chart. A store; it reads only, through the
// existing engines, and stores nothing. Each figure is read only when the viewer holds its capability, so a helper's
// dashboard never computes (let alone shows) what their grants do not reach.
import { inOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { allows, type Who } from '../access';
import type { Day } from '../days';
import { loadGuestState } from '../guests/store';
import { loadSeating } from '../seating/store';
import { ledger } from '../thanks/aging';
import { loadObligations } from '../thanks/store';
import { percentOf } from './figures';

export async function dashboardExtras(tx: Tx, ctx: { orgId: string; userId: string }, who: Who, today: Day) {
  // One at a time: these share the transaction's single connection.
  let guests = null;
  let seating = null;
  if (allows(who, 'guests.view')) {
    const g = await loadGuestState(tx, ctx);
    guests = { attending: g.count.attending, pending: g.count.pending, declined: g.count.declined, held: g.cap.held, cap: g.cap.cap, available: g.cap.available, heldPct: percentOf(g.cap.held, g.cap.cap), responseRatePct: g.count.responseRatePct, venueMin: g.plan.venueMin, venueMax: g.plan.venueMax };
    const s = await loadSeating(tx, ctx);
    seating = { tables: s.tables.length, toSeat: s.guests.length, seated: Object.keys(s.seats).length, hard: s.score.hard };
  }
  let approvals = null;
  if (allows(who, 'consent.view')) {
    const open = { ...inOrg(ctx), status: 'pending' as const, expiresAt: { gt: now() } };
    approvals = { waitingForYou: await tx.consentRequest.count({ where: { ...open, proposerId: { not: ctx.userId } } }), yours: await tx.consentRequest.count({ where: { ...open, proposerId: ctx.userId } }) };
  }
  const thanks = allows(who, 'gifts.view') ? ledger(await loadObligations(tx, ctx), today) : null;
  let contingency = null;
  if (allows(who, 'contingency.view')) {
    const plans = await tx.contingencyPlan.count({ where: inOrg(ctx) });
    const ran = await tx.contingencyRun.count({ where: inOrg(ctx) });
    const openItems = await tx.contingencyItem.count({ where: { ...inOrg(ctx), doneOn: null } });
    contingency = { plans, ran, ready: plans - ran, openItems };
  }
  return { guests, seating, approvals, thanks, contingency };
}
