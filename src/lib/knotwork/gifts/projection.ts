// RULE 3 (CLAUDE.md): guest-facing surfaces never leak wave data. PURE.
//
// This file is the ONLY thing the guest's gift page (/r/[token]/gifts) is built from. `giftView` copies, field by
// field, what a household may see: the registry items with their progress, and that household's OWN entries. Nothing
// about the household's list, wave, priority, invite date, creation time or state has a path out, and neither does
// anything about another household: not who else gave, not how many gave, not what any of them gave (PRD P0-5:
// "contributors see only their own"). The sweep in tests/knotwork/gifts-pure.test.ts and gifts-db.test.ts compares an
// A household with a B household, and walks the view for guests/projection.ts's FORBIDDEN_KEYS.
import { showDay, type Day } from '../days';
import { usd } from '../money';
import { GIFT_MAX_CENTS, GIFT_MIN_CENTS, type EntryKind, type ItemState } from './ledger';

export type GiftViewInput = {
  wedding: { title: string };
  household: { name: string; [internal: string]: unknown };
  items: { id: string; title: string; note: string; targetCents: number; potCents: number; state: ItemState; [internal: string]: unknown }[];
  /** This household's own ledger entries, oldest first. Never anyone else's. */
  own: { itemId: string; kind: EntryKind; amountCents: number; on: Day; [internal: string]: unknown }[];
};

const STATUS = { open: 'open', funded: 'funded', closed_unfunded: 'closed' } as const;
const LINE = { contribution: 'You gave', excess_return: 'Returned to you (more than was still needed)', refund: 'Refunded to you (the gift was closed before it was funded)' } as const;

export type GiftView = {
  weddingTitle: string;
  householdName: string;
  items: {
    id: string;
    title: string;
    note: string;
    status: 'open' | 'funded' | 'closed';
    targetText: string;
    raisedText: string;
    remainingText: string;
    percent: number;
    /** What this household has in the pot: its own entries added up. */
    yoursText: string | null;
    yours: { text: string; amountText: string; onText: string }[];
  }[];
  anyOpen: boolean;
};

export function giftView(i: GiftViewInput): GiftView {
  const items = i.items.map((it) => {
    const mine = i.own.filter((e) => e.itemId === it.id);
    const net = mine.reduce((n, e) => n + e.amountCents, 0);
    const pot = Math.min(Math.max(it.potCents, 0), it.targetCents);
    return {
      id: it.id, title: it.title, note: it.note, status: STATUS[it.state],
      targetText: usd(it.targetCents), raisedText: usd(pot), remainingText: usd(it.targetCents - pot), percent: Math.floor((pot * 100) / it.targetCents),
      yoursText: mine.length ? usd(net) : null,
      yours: mine.map((e) => ({ text: LINE[e.kind], amountText: usd(Math.abs(e.amountCents)), onText: showDay(e.on) })),
    };
  });
  return { weddingTitle: i.wedding.title, householdName: i.household.name, items, anyOpen: items.some((x) => x.status === 'open') };
}

/**
 * Why a contribution was not taken. A closed list, like RSVP_PROBLEM: the page shows these fixed sentences and the
 * redirect carries only the code, so no amount and nothing a guest typed ever rides in a URL.
 */
export const GIFT_PROBLEM = {
  amount: `Enter an amount from ${usd(GIFT_MIN_CENTS)} to ${usd(GIFT_MAX_CENTS)}, like 25 or 25.00.`,
  'not-here': 'That gift is not on this registry.',
  funded: 'That gift is already fully funded.',
  closed: 'That gift is no longer open.',
  fail: 'We could not record that. Please get in touch with the couple.',
} as const;
export type GiftProblem = keyof typeof GIFT_PROBLEM;
export const isGiftProblem = (code: string): code is GiftProblem => Object.hasOwn(GIFT_PROBLEM, code);

/** What the page says after a contribution went through. The amounts are on the page itself, under the item. */
export const GIFT_DONE = {
  thanks: 'Thank you. Your contribution is recorded below.',
  part: 'Thank you. Your contribution completed the gift; the part that was more than needed was returned to you, as shown below.',
} as const;
export type GiftDone = keyof typeof GIFT_DONE;
export const isGiftDone = (code: string): code is GiftDone => Object.hasOwn(GIFT_DONE, code);
