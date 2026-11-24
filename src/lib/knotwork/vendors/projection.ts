// RULE 3 (D-42): the ONLY shape the vendor's read-only page (/v/[token]) is built from. PURE.
//
// A vendor with the link sees the wedding's title, its own name and its own brief: the Phase 1/2 brief, filtered by
// its category (brief.ts BRIEF_SECTIONS: the DJ gets song requests and the do-not-play list, the caterer gets counts).
// The brief carries counts and song titles, never a guest's name, and nothing about other vendors, the budget or the
// couple's plans, because nothing else is passed to it. It is built fresh on every read, so a count that changed
// reaches the vendor without anyone regenerating it.
import { addDays, type Day } from '../days';
import { renderBrief, type BriefInput } from './brief';

/** A vendor link stops working this many days after the wedding date (rule 1: derived, never stored). */
export const VENDOR_LINK_DAYS_AFTER = 7;
/** The last day the link works. */
export const linkLastDay = (weddingDay: Day): Day => addDays(weddingDay, VENDOR_LINK_DAYS_AFTER);
export const linkWorks = (weddingDay: Day, today: Day): boolean => today <= linkLastDay(weddingDay);

export type VendorLinkView = { weddingTitle: string; vendorName: string; brief: string };
export const vendorLinkView = (i: BriefInput): VendorLinkView => ({ weddingTitle: i.wedding.title, vendorName: i.vendor.name, brief: renderBrief(i).body });
