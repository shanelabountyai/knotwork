// The thank-you obligation ledger (PRD P1-3): gift → giver → acknowledged, with aging. PURE.
//
// One obligation per gift and giver, from three places: a pooled gift that funded (one per household that gave toward
// it, Phase 3's ThankYou rows), a link-out item a household marked as bought (P1-8), and a gift the couple logged by
// hand. Each has a received-on day and, once a partner marks the note as sent, an acknowledged-on day: both dates of
// fact. How long a thank-you has been owed is computed here from received-on and today, never stored (rule 1).
// Nothing here carries an amount: an obligation is who gave and what, never how much (P0-5).
// tools/thanks_oracle.py recomputes fixtures/thanks/ without sharing any of this code.
import { diffDays, type Day } from '../days';

export type Source = 'pooled' | 'claimed' | 'logged';
export type Obligation = { source: Source; id: string; giver: string; what: string; receivedOn: Day; acknowledgedOn: Day | null };

/** "Unthanked > 3 weeks": owed for more than this many days. */
export const OVERDUE_AFTER_DAYS = 21;

/** The aging buckets, by days owed (inclusive bounds; the last has no end). */
export const BUCKETS = [
  { key: 'fresh', label: 'Under a week', from: 0, to: 6 },
  { key: 'weeks', label: '1 to 3 weeks', from: 7, to: 21 },
  { key: 'late', label: '3 to 6 weeks', from: 22, to: 42 },
  { key: 'later', label: 'Over 6 weeks', from: 43, to: null },
] as const;
export type BucketKey = (typeof BUCKETS)[number]['key'];

/** Days a thank-you has been owed on `today`. A gift logged with a later day than today counts as owed from today. */
export const ageDays = (receivedOn: Day, today: Day): number => Math.max(0, diffDays(today, receivedOn));

export const bucketOf = (days: number): BucketKey => BUCKETS.find((b) => days >= b.from && (b.to === null || days <= b.to))!.key;

export type Owed = Obligation & { ageDays: number; bucket: BucketKey; overdue: boolean };
export type Ledger = {
  /** Still to thank, oldest first. */
  owed: Owed[];
  /** Thanked, most recently first. */
  thanked: Obligation[];
  total: number;
  overdue: number;
  /** "14 unthanked > 3 weeks". */
  headline: string;
  buckets: { key: BucketKey; label: string; count: number }[];
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const SOURCE_ORDER: Record<Source, number> = { pooled: 0, claimed: 1, logged: 2 };

export function ledger(all: readonly Obligation[], today: Day): Ledger {
  const owed = all
    .filter((o) => o.acknowledgedOn === null)
    .map((o) => {
      const days = ageDays(o.receivedOn, today);
      return { ...o, ageDays: days, bucket: bucketOf(days), overdue: days > OVERDUE_AFTER_DAYS };
    })
    .sort((a, b) => cmp(a.receivedOn, b.receivedOn) || cmp(a.giver, b.giver) || cmp(a.what, b.what) || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || cmp(a.id, b.id));
  const thanked = all
    .filter((o) => o.acknowledgedOn !== null)
    .sort((a, b) => cmp(b.acknowledgedOn!, a.acknowledgedOn!) || cmp(a.receivedOn, b.receivedOn) || cmp(a.giver, b.giver) || cmp(a.what, b.what) || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || cmp(a.id, b.id));
  const overdue = owed.filter((o) => o.overdue).length;
  return {
    owed, thanked, total: all.length, overdue,
    headline: `${overdue} unthanked > 3 weeks`,
    buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label, count: owed.filter((o) => o.bucket === b.key).length })),
  };
}

/** "today", "1 day", "23 days". */
export const showAge = (days: number) => (days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`);

/**
 * A note to start from, per obligation: text only, for the couple to copy into a card. Nothing is sent from here.
 * It names the gift and never an amount (a pooled gift says "toward", as the guest page does).
 */
export function noteTemplate(o: Pick<Obligation, 'source' | 'giver' | 'what'>, signOff: string): string {
  const line =
    o.source === 'pooled' ? `Thank you so much for giving toward ${o.what}. It means a great deal to us that you were part of it.`
    : o.source === 'claimed' ? `Thank you so much for the ${o.what} from our registry. We love it, and we will think of you every time we use it.`
    : `Thank you so much for ${o.what}. It was so thoughtful of you.`;
  return `Dear ${o.giver},\n\n${line}\n\nWith love,\n${signOff}`;
}
