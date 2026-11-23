// Vendor briefs (PRD P0-7): call-sheet-style, filtered by the vendor's category, regenerable. PURE.
//
// A brief is an explicit projection of ONE vendor's own facts: nothing about other vendors, the budget or the couple's
// other plans can appear, because nothing else is passed in. It is regenerated on demand; a new version is stored
// only when `inputsHash` changed. The sections fed by the guest engine (headcounts, dietary rollups, the do-not-play
// list) are Phase 2 data and say so instead of showing a made-up value.
import { createHash } from 'node:crypto';
import { showDay, type Day } from '../days';
import { usd } from '../money';
import { hhmm } from './scope';

export const VENDOR_CATEGORIES = ['venue', 'caterer', 'photographer', 'dj', 'florist', 'officiant', 'baker', 'attire', 'transport', 'planner', 'other'] as const;
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

type Section = 'counts' | 'music' | 'timeline';
/** Which optional sections each category gets. Everyone gets the header, times, deliverables, payments and open flags. */
export const BRIEF_SECTIONS: Record<VendorCategory, readonly Section[]> = {
  venue: ['counts', 'timeline'],
  caterer: ['counts', 'timeline'],
  baker: ['counts'],
  dj: ['music', 'timeline'],
  photographer: ['timeline'],
  florist: ['timeline'],
  officiant: ['timeline'],
  attire: [],
  transport: ['timeline'],
  planner: ['counts', 'music', 'timeline'],
  other: [],
};

export type BriefInput = {
  wedding: { title: string; date: Day };
  vendor: {
    name: string; category: VendorCategory; contactName: string; deliverables: string;
    arriveMin: number | null; departMin: number | null; countEstimate: number | null; countDueDaysBefore: number | null; countDue: Day | null;
    contractTotalCents: number | null; contractSignedOn: Day | null;
  };
  payments: { label: string; amountCents: number; due: Day; paidOn: Day | null }[];
  tasks: { title: string; due: Day; state: string }[];
  openFlags: { reason: 'date_moved' | 'scope_changed'; raisedOn: Day; text: string }[];
};

export function renderBrief(i: BriefInput): { body: string; inputsHash: string } {
  const v = i.vendor;
  const has = (s: Section) => BRIEF_SECTIONS[v.category].includes(s);
  const L: string[] = [];
  L.push(`BRIEF: ${v.name} (${v.category})`, `${i.wedding.title}, ${showDay(i.wedding.date)}`, v.contactName ? `Contact: ${v.contactName}` : 'Contact: not set', '');
  if (i.openFlags.length) {
    L.push('NEEDS RE-CONFIRMATION');
    for (const f of i.openFlags) L.push(`- ${f.text} (flagged ${showDay(f.raisedOn)})`);
    L.push('');
  }
  L.push('ON THE DAY', `- Arrive: ${hhmm(v.arriveMin) || 'not set'}`, `- Depart: ${hhmm(v.departMin) || 'not set'}`, '');
  L.push('DELIVERABLES', v.deliverables.trim() || 'Not written yet.', '');
  if (has('counts')) {
    L.push('COUNTS', `- Estimate: ${v.countEstimate ?? 'not set'}`);
    L.push(v.countDue ? `- Final count due: ${showDay(v.countDue)} (${v.countDueDaysBefore} days before)` : '- Final count due: not set');
    L.push('- Confirmed headcount, meal counts, dietary and accessibility rollups: arrive with the guest engine (Phase 2).', '');
  }
  if (has('music')) L.push('MUSIC', '- Song requests and the do-not-play list: arrive with the guest engine (Phase 2).', '');
  if (has('timeline')) {
    L.push('TIMELINE');
    if (!i.tasks.length) L.push('- No tasks are linked to this vendor.');
    for (const t of [...i.tasks].sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.title < b.title ? -1 : 1))) L.push(`- ${showDay(t.due)}: ${t.title}${t.state === 'done' ? ' (done)' : ''}`);
    L.push('');
  }
  L.push('PAYMENTS');
  if (v.contractTotalCents !== null) L.push(`- Contract total: ${usd(v.contractTotalCents)}${v.contractSignedOn ? `, signed ${showDay(v.contractSignedOn)}` : ', not signed'}`);
  if (!i.payments.length) L.push('- No payments scheduled.');
  for (const p of [...i.payments].sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))) L.push(`- ${p.label}: ${usd(p.amountCents)}, due ${showDay(p.due)}${p.paidOn ? ` (paid ${showDay(p.paidOn)})` : ''}`);
  const body = `${L.join('\n').trimEnd()}\n`;
  return { body, inputsHash: createHash('sha256').update(body).digest('hex').slice(0, 16) };
}
