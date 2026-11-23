// RULE 2 (CLAUDE.md): this file is the ONLY writer of designated fields. Nothing here runs unless consent/store.ts has
// just marked the request approved by a second partner, in the same transaction; if anything below throws, that
// approval is rolled back with it, so there is never an approved request whose action did not happen.
//
//   book_vendor      Vendor.status = booked            (Vendor_guard trigger checks the request)
//   sign_contract    Vendor.contractSignedOn           (Vendor_guard)
//   spend            an Expense over the threshold     (Expense_guard)
//   change_date      Wedding.date, via commitMove      (Wedding_guard)
//   change_settings  the three wedding settings        (Wedding_guard)
//
// tests/knotwork/structure.test.ts scans src/ for any other writer.
import { z } from 'zod';
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { createExpense } from '../budget-store';
import { logChange } from '../changelog';
import { requireWedding, todayOf } from '../context';
import { dbOfDay, isRealDay } from '../days';
import { commitMove, syncRsvpTask } from '../schedule/store';
import type { ConsentKind } from './machine';

const day = z.string().refine(isRealDay);
export const PAYLOAD = {
  book_vendor: z.object({ vendorId: z.uuid() }),
  sign_contract: z.object({ vendorId: z.uuid(), totalCents: z.number().int().min(0) }),
  spend: z.object({ categoryId: z.uuid(), vendorId: z.uuid().nullable(), description: z.string().min(1), amountCents: z.number().int().positive(), paidOn: day, paymentId: z.uuid().nullable() }),
  change_date: z.object({ from: day, to: day }),
  change_settings: z.object({ spendThresholdCents: z.number().int().min(0), consentExpiryDays: z.number().int().min(1), chaseBufferDays: z.number().int().min(0) }),
} as const;
export type Payload<K extends keyof typeof PAYLOAD> = z.infer<(typeof PAYLOAD)[K]>;

type Ctx = { orgId: string; userId: string };
type Approved = { id: string; kind: ConsentKind; payload: unknown };

/** Does what an approved request allows. `seen` is the date-move fingerprint the approver was shown. */
export async function executeApproved(tx: Tx, ctx: Ctx, r: Approved, seen: { fingerprint?: string }): Promise<void> {
  switch (r.kind) {
    case 'book_vendor': {
      const p = PAYLOAD.book_vendor.parse(r.payload);
      const v = await tx.vendor.findFirst({ where: { id: p.vendorId, ...inOrg(ctx) } });
      if (!v) throw new Refused('That vendor no longer exists.');
      if (v.status !== 'considering') throw new Refused(v.status === 'booked' ? 'That vendor is already booked.' : 'That vendor was dropped.');
      await tx.vendor.update({ where: { id: v.id }, data: { status: 'booked', bookedRequestId: r.id } });
      await logChange(tx, ctx, 'vendor', 'updated', v.id, v.name, { status: v.status }, { status: 'booked' }, { twoKey: true });
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
      await logChange(tx, ctx, 'vendor', 'updated', v.id, v.name, { contractSignedOn: null, contractTotalCents: v.contractTotalCents }, { contractSignedOn: signedOn, contractTotalCents: p.totalCents }, { twoKey: true });
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
      await createExpense(tx, ctx, wedding, { ...p, vendorId }, r.id);
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
      await logChange(tx, ctx, 'wedding', 'updated', w.id, 'Approval rules', before, p, { twoKey: true });
      await syncRsvpTask(tx, ctx); // the chase buffer moves the RSVP deadline
      return;
    }
    case 'remove_guest':
      throw new Refused('Guest removals arrive with the guest list in Phase 2.');
  }
}
