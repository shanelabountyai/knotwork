// A vendor's scheduled payments, summed for the vendor book (design round 2, D-175). PURE. Read-only: it sums the
// existing VendorPayment rows in integer cents and finds the next unpaid one; it stores nothing and changes no rule.
// Rule 1: a payment's due day is derived from the wedding date (`dueDaysBefore`), never stored. The wedding date is a
// calendar day in the wedding's time zone (`weddingDay`), so the due day is too.
import { addDays, type Day } from '../days';

export type PaymentRow = { amountCents: number; dueDaysBefore: number; paidOn: Date | null };
export type PaymentSummary = { count: number; paidCents: number; balanceCents: number; nextDue: { day: Day; amountCents: number } | null };

export function paymentSummary(rows: PaymentRow[], weddingDate: Day): PaymentSummary {
  let paidCents = 0;
  let balanceCents = 0;
  let nextDays: number | null = null; // the earliest unpaid due day is the most days before the wedding
  let nextCents = 0;
  for (const p of rows) {
    if (!Number.isInteger(p.amountCents)) throw new Error('money is integer cents');
    if (p.paidOn) {
      paidCents += p.amountCents;
      continue;
    }
    balanceCents += p.amountCents;
    if (nextDays === null || p.dueDaysBefore > nextDays) [nextDays, nextCents] = [p.dueDaysBefore, p.amountCents];
    else if (p.dueDaysBefore === nextDays) nextCents += p.amountCents; // two due the same day: both are due then
  }
  return { count: rows.length, paidCents, balanceCents, nextDue: nextDays === null ? null : { day: addDays(weddingDate, -nextDays), amountCents: nextCents } };
}
