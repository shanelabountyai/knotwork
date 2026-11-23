// The default task template a new wedding starts from. PURE data.
//
// The lead times and buffers are ILLUSTRATIVE DEFAULTS, not sourced figures (decisions D-20): they exist so a new plan
// has a shape the couple can edit. The one number taken from a document is the PRD's own example, "alterations need
// 3 months". Every number is whole days; `bufferDays` is how long before the wedding the task must be finished.
import type { PlanTask } from './engine';

export type TemplateTask = { key: string; title: string; leadDays: number; bufferDays: number; dependsOn: string[] };

export const DEFAULT_TEMPLATE: readonly TemplateTask[] = [
  { key: 'set-budget', title: 'Agree the budget', leadDays: 7, bufferDays: 270, dependsOn: [] },
  { key: 'book-venue', title: 'Book the venue', leadDays: 30, bufferDays: 240, dependsOn: [] },
  { key: 'draft-guest-list', title: 'Draft the guest list', leadDays: 14, bufferDays: 240, dependsOn: ['set-budget'] },
  { key: 'book-caterer', title: 'Book the caterer', leadDays: 21, bufferDays: 210, dependsOn: ['book-venue'] },
  { key: 'book-photographer', title: 'Book the photographer', leadDays: 14, bufferDays: 210, dependsOn: ['book-venue'] },
  { key: 'book-officiant', title: 'Book the officiant', leadDays: 14, bufferDays: 180, dependsOn: ['book-venue'] },
  { key: 'book-music', title: 'Book the music', leadDays: 14, bufferDays: 180, dependsOn: ['book-venue'] },
  { key: 'send-save-the-dates', title: 'Send save-the-dates', leadDays: 10, bufferDays: 180, dependsOn: ['draft-guest-list', 'book-venue'] },
  { key: 'book-florist', title: 'Book the florist', leadDays: 14, bufferDays: 150, dependsOn: [] },
  { key: 'choose-attire', title: 'Choose the attire', leadDays: 30, bufferDays: 0, dependsOn: [] },
  { key: 'order-attire', title: 'Order the attire', leadDays: 150, bufferDays: 0, dependsOn: ['choose-attire'] },
  { key: 'alterations', title: 'Alterations', leadDays: 90, bufferDays: 14, dependsOn: ['order-attire'] },
  { key: 'menu-tasting', title: 'Menu tasting', leadDays: 7, bufferDays: 90, dependsOn: ['book-caterer'] },
  { key: 'order-invitations', title: 'Order invitations', leadDays: 30, bufferDays: 75, dependsOn: ['draft-guest-list'] },
  { key: 'send-invitations', title: 'Send invitations', leadDays: 5, bufferDays: 60, dependsOn: ['order-invitations'] },
  { key: 'order-cake', title: 'Order the cake', leadDays: 14, bufferDays: 60, dependsOn: [] },
  { key: 'marriage-licence', title: 'Get the marriage licence', leadDays: 3, bufferDays: 14, dependsOn: [] },
  { key: 'seating-chart', title: 'Make the seating chart', leadDays: 7, bufferDays: 7, dependsOn: [] },
  { key: 'final-walkthrough', title: 'Final venue walkthrough', leadDays: 1, bufferDays: 7, dependsOn: ['book-venue'] },
  { key: 'write-vows', title: 'Write vows', leadDays: 7, bufferDays: 3, dependsOn: [] },
];

/** The template as plan tasks (ids are the keys), for the engine and for fixture 12. */
export const templatePlan = (): PlanTask[] => DEFAULT_TEMPLATE.map((t) => ({ id: t.key, title: t.title, leadDays: t.leadDays, bufferDays: t.bufferDays, dependsOn: [...t.dependsOn], done: false }));
