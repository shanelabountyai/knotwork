// RULE 2 (CLAUDE.md): this file is the ONLY writer of designated fields. Nothing here runs unless consent/store.ts has
// just marked the request approved, by a second partner or solo (D-33), in the same transaction; if anything below throws, that
// approval is rolled back with it, so there is never an approved request whose action did not happen.
//
//   book_vendor      Vendor.status = booked            (Vendor_guard trigger checks the request)
//   sign_contract    Vendor.contractSignedOn           (Vendor_guard)
//   spend            an Expense over the threshold     (Expense_guard)
//   change_date      Wedding.date, via commitMove      (Wedding_guard)
//   change_settings  the three wedding settings        (Wedding_guard)
//   remove_guest     Guest.removedAt                   (Guest_guard)
//   set_mode         Wedding.mode, planning ⇄ life     (Wedding_mode_guard; Phase 5, D-143)
//   (date, rules and mode: Wedding_request_once also refuses a request the wedding has used before; D-170)
//
// tests/knotwork/structure.test.ts scans src/ for any other writer.
import { z } from 'zod';
import { inOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { createExpense } from '../budget-store';
import { logChange } from '../changelog';
import { lifeModeOpen, requireWedding, todayOf } from '../context';
import { dbOfDay, isRealDay } from '../days';
import { deltaFor } from '../guests/headcount';
import { assertWithinCap, loadGuestState } from '../guests/store';
import { commitMove, lockWedding, syncRsvpTask } from '../schedule/store';
import { ARCHIVE_REFUSAL } from '../access';
import { PLAN_KINDS, type ConsentKind } from './machine';

const day = z.string().refine(isRealDay);
export const PAYLOAD = {
  book_vendor: z.object({ vendorId: z.uuid() }),
  sign_contract: z.object({ vendorId: z.uuid(), totalCents: z.number().int().min(0) }),
  spend: z.object({ categoryId: z.uuid(), vendorId: z.uuid().nullable(), description: z.string().min(1), amountCents: z.number().int().positive(), paidOn: day, paymentId: z.uuid().nullable() }),
  change_date: z.object({ from: day, to: day }),
  change_settings: z.object({ spendThresholdCents: z.number().int().min(0), consentExpiryDays: z.number().int().min(1), chaseBufferDays: z.number().int().min(0) }),
  remove_guest: z.object({ guestIds: z.array(z.uuid()).min(1).max(50) }),
  set_mode: z.object({ to: z.enum(['planning', 'life']) }),
} as const;
export type Payload<K extends keyof typeof PAYLOAD> = z.infer<(typeof PAYLOAD)[K]>;

type Ctx = { orgId: string; userId: string };
type Approved = { id: string; kind: ConsentKind; payload: unknown };

/** How the log marks a designated change: two keys, or one partner alone before pairing (D-33). Never both. */
export const keysMark = (solo: boolean | undefined) => (solo ? { twoKey: false, solo: true } : { twoKey: true });

/** Does what an approved request allows. `seen` is the date-move fingerprint the approver was shown, and whether the approval was solo. */
export async function executeApproved(tx: Tx, ctx: Ctx, r: Approved, seen: { fingerprint?: string; solo?: boolean }): Promise<void> {
  const mark = keysMark(seen.solo);
  // D-144: a change to the plan asked for before the switch to life-admin mode cannot happen in the archive.
  if (PLAN_KINDS.includes(r.kind) && (await requireWedding(tx, ctx)).mode === 'life') throw new Refused(ARCHIVE_REFUSAL);
  switch (r.kind) {
    case 'book_vendor': {
      const p = PAYLOAD.book_vendor.parse(r.payload);
      const v = await tx.vendor.findFirst({ where: { id: p.vendorId, ...inOrg(ctx) } });
      if (!v) throw new Refused('That vendor no longer exists.');
      if (v.status !== 'considering') throw new Refused(v.status === 'booked' ? 'That vendor is already booked.' : 'That vendor was dropped.');
      await tx.vendor.update({ where: { id: v.id }, data: { status: 'booked', bookedRequestId: r.id } });
      await logChange(tx, ctx, 'vendor', 'updated', v.id, v.name, { status: v.status }, { status: 'booked' }, mark);
      await syncRsvpTask(tx, ctx); // a booked vendor's count deadline now drives the RSVP deadline
      return;
    }
    case 'sign_contract': {
      const p = PAYLOAD.sign_contract.parse(r.payload);
      const v = await tx.vendor.findFirst({ where: { id: p.vendorId, ...inOrg(ctx) } });
      if (!v) throw new Refused('That vendor no longer exists.');
      if (v.contractSignedOn) throw new Refused('That contract is already signed.');
      const signedOn = todayOf(await requireWedding(tx, ctx));
      await tx.vendor.update({ where: { id: v.id }, data: { contractSignedOn: dbOfDay(signedOn), contractTotalCents: p.totalCents, contractRequestId: r.id } });
      await logChange(tx, ctx, 'vendor', 'updated', v.id, v.name, { contractSignedOn: null, contractTotalCents: v.contractTotalCents }, { contractSignedOn: signedOn, contractTotalCents: p.totalCents }, mark);
      return;
    }
    case 'spend': {
      const p = PAYLOAD.spend.parse(r.payload);
      const wedding = await requireWedding(tx, ctx);
      if (!(await tx.budgetCategory.findFirst({ where: { id: p.categoryId, ...inOrg(ctx) }, select: { id: true } }))) throw new Refused('That budget category no longer exists.');
      if (p.paymentId) {
        const pay = await tx.vendorPayment.findFirst({ where: { id: p.paymentId, ...inOrg(ctx) }, select: { paidOn: true } });
        if (!pay) throw new Refused('That payment no longer exists.');
        if (pay.paidOn) throw new Refused('That payment has already been paid.');
      }
      const vendorId = p.vendorId && (await tx.vendor.findFirst({ where: { id: p.vendorId, ...inOrg(ctx) }, select: { id: true } })) ? p.vendorId : null;
      await createExpense(tx, ctx, wedding, { ...p, vendorId }, r.id, seen.solo);
      return;
    }
    case 'change_date': {
      const p = PAYLOAD.change_date.parse(r.payload);
      if (!seen.fingerprint) throw new Refused('Look at the preview of this move before approving it.');
      await commitMove(tx, ctx, { to: p.to, fingerprint: seen.fingerprint, requestId: r.id });
      return;
    }
    case 'change_settings': {
      const p = PAYLOAD.change_settings.parse(r.payload);
      const w = await requireWedding(tx, ctx);
      const before = { spendThresholdCents: w.spendThresholdCents, consentExpiryDays: w.consentExpiryDays, chaseBufferDays: w.chaseBufferDays };
      if (JSON.stringify(before) === JSON.stringify(p)) throw new Refused('Those are already the rules.');
      await tx.wedding.update({ where: { orgId: ctx.orgId }, data: { ...p, settingsRequestId: r.id } });
      await logChange(tx, ctx, 'wedding', 'updated', w.id, 'Approval rules', before, p, mark);
      await syncRsvpTask(tx, ctx); // the chase buffer moves the RSVP deadline
      return;
    }
    case 'set_mode': {
      // Phase 5 (D-143): into life-admin mode only once the wedding day has passed (today in the wedding's time zone is
      // after the wedding date: derived, nothing stored); back to planning at any time. The moment is a date of fact.
      const p = PAYLOAD.set_mode.parse(r.payload);
      const w = await requireWedding(tx, ctx);
      if (w.mode === p.to) throw new Refused(p.to === 'life' ? 'The workspace is already in life-admin mode.' : 'The workspace is already in planning mode.');
      if (p.to === 'life' && !lifeModeOpen(w)) throw new Refused('Life-admin mode opens the day after the wedding.');
      await tx.wedding.update({ where: { orgId: ctx.orgId }, data: { mode: p.to, modeRequestId: r.id, modeChangedAt: now() } });
      await logChange(tx, ctx, 'wedding', 'updated', w.id, 'Workspace mode', { mode: w.mode }, { mode: p.to }, mark);
      return;
    }
    case 'remove_guest': {
      const p = PAYLOAD.remove_guest.parse(r.payload);
      await lockWedding(tx, ctx.orgId);
      const guests = await tx.guest.findMany({ where: { id: { in: p.guestIds }, ...inOrg(ctx) }, include: { household: { select: { name: true } } } });
      if (guests.length !== p.guestIds.length) throw new Refused('Someone on that request is no longer on the guest list.');
      if (guests.some((g) => g.removedAt)) throw new Refused('Someone on that request was already removed.');
      const before = await loadGuestState(tx, ctx);
      const t = now();
      for (const g of guests) {
        await tx.guest.update({ where: { id: g.id }, data: { removedAt: t, removedRequestId: r.id } });
        await logChange(tx, ctx, 'guest', 'deleted', g.id, `${g.name} (${g.household.name})`, { name: g.name, rsvp: g.rsvp, removed: false }, null, mark);
      }
      // Held seats never pass the cap, on this path too. A removal can RAISE the count: the plus-one rule is re-read
      // (D-47), so a spouse left alone on an invitation becomes entitled to a guest and holds a seat for one. Throwing
      // here rolls back the removal and the approval with it (review 2026-11-24, M3; D-58).
      const after = await assertWithinCap(tx, ctx, 'That removal leaves someone alone on their invitation, who may then bring a guest. It');
      if (after.count.attending !== before.count.attending) {
        const d = deltaFor(guests.length === 1 ? guests[0]!.name.split(/\s+/)[0]! : `${guests.length} guests`, 'removed', before.count, after.count, after.prices);
        await tx.headcountDelta.create({ data: { orgId: ctx.orgId, label: d.label, deltaSeats: d.deltaSeats, deltaCents: d.deltaCents, attendingAfter: after.count.attending, costAfterCents: after.costCents } });
      }
      return;
    }
  }
}
