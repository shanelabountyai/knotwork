// Who may do what (PRD P0-2: "Helper permissions are scoped grants"). PURE.
//
// The two partners are the workspace's `owner` memberships and can do everything that is not designated; designated
// actions go through consent whoever asks. Every other role is a helper (D-08): a helper can always read the schedule
// and update their own tasks, and gets anything else only by a grant.

export const GRANT_SCOPES = ['schedule_edit', 'budget_view', 'budget_edit', 'vendors_view', 'vendors_edit', 'guests_edit', 'photos_moderate', 'funder'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export const SCOPE_LABEL: Record<GrantScope, string> = {
  schedule_edit: 'Edit the schedule',
  budget_view: 'See the budget',
  budget_edit: 'Edit the budget',
  vendors_view: 'See vendors',
  vendors_edit: 'Edit vendors',
  guests_edit: 'See and edit the guest list',
  photos_moderate: 'See and moderate the photo wall',
  funder: 'A funder: sees only what their own pledges paid for',
};
/** The grants a partner gives from the Helpers page. `funder` is given by linking the person to a funder (P1-2). */
export const PLAIN_GRANT_SCOPES = GRANT_SCOPES.filter((s) => s !== 'funder');

export type Capability =
  | 'schedule.view' | 'schedule.edit'
  | 'budget.view' | 'budget.edit' | 'funding.view'
  | 'vendors.view' | 'vendors.edit'
  | 'guests.view' | 'guests.edit'
  | 'gifts.view' | 'gifts.edit'
  | 'photos.view' | 'photos.moderate' | 'photos.manage'
  | 'consent.view' | 'consent.propose' | 'consent.decide'
  | 'namechange.own' | 'contingency.view' | 'contingency.edit'
  | 'life.view' | 'life.edit'
  | 'activity.view' | 'helpers.manage' | 'wedding.create';

/**
 * `role` is the template's membership role: owner, admin, member or scorekeeper. `archived`: the workspace is in
 * life-admin mode (Phase 5, D-144), so the wedding plan is a read-only archive for everyone, partners included.
 */
export type Who = { role: string; grants: readonly GrantScope[]; archived?: boolean };

/**
 * Phase 5 (D-144): what the archive refuses in life-admin mode. The plan itself (schedule, budget and funding, vendors
 * and their documents, guests and seating, contingency plans) is kept read-only. What carries on into the couple's
 * life is not on this list: gifts and thank-yous, the photo album and its moderation, the name change, approvals,
 * helpers, and the life-admin pages themselves.
 */
export const ARCHIVED_CAPS: readonly Capability[] = ['schedule.edit', 'budget.edit', 'vendors.edit', 'guests.edit', 'contingency.edit'];
export const ARCHIVE_REFUSAL = 'The wedding plan is an archive now, read-only in life-admin mode. Switch back to planning mode (on the Archive page) to change it.';
export const archives = (who: Who, cap: Capability): boolean => !!who.archived && ARCHIVED_CAPS.includes(cap);

export const isPartner = (role: string) => role === 'owner';

const HELPER: Record<Capability, (g: readonly GrantScope[]) => boolean> = {
  'schedule.view': () => true,
  'schedule.edit': (g) => g.includes('schedule_edit'),
  'budget.view': (g) => g.includes('budget_view') || g.includes('budget_edit'),
  'budget.edit': (g) => g.includes('budget_edit'),
  // P1-2: a helper linked to a funder sees that funder's pledges, receipts and spends, and nothing else of the budget
  // (the funding page scopes it; funding/store.ts `fundingView`). A budget grant sees all of it.
  'funding.view': (g) => g.includes('funder') || g.includes('budget_view') || g.includes('budget_edit'),
  'vendors.view': (g) => g.includes('vendors_view') || g.includes('vendors_edit'),
  'vendors.edit': (g) => g.includes('vendors_edit'),
  'guests.view': (g) => g.includes('guests_edit'),
  'guests.edit': (g) => g.includes('guests_edit'),
  // Gifting is the partners' alone: no grant reaches it (who gave toward what is the couple's to know, P0-5).
  'gifts.view': () => false,
  'gifts.edit': () => false,
  // The photo wall (P0-6): one grant lets a helper see the album and the wall and moderate them. Making an event,
  // its link, its settings and the retention purge stay with the partners.
  'photos.view': (g) => g.includes('photos_moderate'),
  'photos.moderate': (g) => g.includes('photos_moderate'),
  'photos.manage': () => false,
  'consent.view': () => false,
  'consent.propose': () => false,
  'consent.decide': () => false,
  // P1-4: a name change is one partner's own (private unless shared with the other partner); no grant reaches it.
  'namechange.own': () => false,
  // P1-6: contingency plans are the partners' (a branch may propose a spend through consent, and names vendors).
  'contingency.view': () => false,
  'contingency.edit': () => false,
  // Phase 5 (D-147): life-admin mode's household tasks and anniversaries are the couple's; no grant reaches them.
  'life.view': () => false,
  'life.edit': () => false,
  'activity.view': () => true, // filtered per entry by canSeeEntity
  'helpers.manage': () => false,
  'wedding.create': () => false,
};

export const allows = (who: Who, cap: Capability): boolean => !archives(who, cap) && (isPartner(who.role) || HELPER[cap](who.grants));

/** Which change-log entries a person may see: a helper sees only entities inside their grants. */
const ENTITY_CAP: Record<string, Capability> = {
  task: 'schedule.view', wedding: 'schedule.view', baseline: 'schedule.view',
  category: 'budget.view', expense: 'budget.view', snapshot: 'budget.view',
  vendor: 'vendors.view', payment: 'vendors.view', flag: 'vendors.view', brief: 'vendors.view',
  request: 'consent.view', grant: 'helpers.manage',
  household: 'guests.view', guest: 'guests.view', wave: 'guests.view', guestplan: 'guests.view', song: 'guests.view',
  registry: 'gifts.view', gift: 'gifts.view', thankyou: 'gifts.view',
  photoevent: 'photos.view', photo: 'photos.view', photodevice: 'photos.view', attachment: 'vendors.view',
  // P1-2: the funding entries are the budget's; a funder-only helper sees none of them in the feed.
  funder: 'budget.view', pledge: 'budget.view', receipt: 'budget.view', allocation: 'budget.view',
  // P1-3 and P1-8: the gift log, store items and households' claims are gifting, the partners' alone.
  giftlog: 'gifts.view', registrylink: 'gifts.view', claim: 'gifts.view',
  // P1-4 and P1-6: partners only. A name change's entries are also masked at write while it is unshared (D-114).
  namechange: 'namechange.own', contingency: 'contingency.view',
  // P1-5: the seating chart is the guest list's (tables, pair rules, seats).
  seating: 'guests.view',
  // Phase 5: recurring household tasks and their done days.
  recurring: 'life.view',
};
export const canSeeEntity = (who: Who, entity: string): boolean => {
  const cap = ENTITY_CAP[entity];
  return cap ? allows(who, cap) : isPartner(who.role); // an unknown entity is partners-only
};
