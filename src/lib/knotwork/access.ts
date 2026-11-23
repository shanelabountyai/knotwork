// Who may do what (PRD P0-2: "Helper permissions are scoped grants"). PURE.
//
// The two partners are the workspace's `owner` memberships and can do everything that is not designated; designated
// actions go through consent whoever asks. Every other role is a helper (D-08): a helper can always read the schedule
// and update their own tasks, and gets anything else only by a grant.

export const GRANT_SCOPES = ['schedule_edit', 'budget_view', 'budget_edit', 'vendors_view', 'vendors_edit', 'guests_edit'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export const SCOPE_LABEL: Record<GrantScope, string> = {
  schedule_edit: 'Edit the schedule',
  budget_view: 'See the budget',
  budget_edit: 'Edit the budget',
  vendors_view: 'See vendors',
  vendors_edit: 'Edit vendors',
  guests_edit: 'Edit the guest list (Phase 2)',
};

export type Capability =
  | 'schedule.view' | 'schedule.edit'
  | 'budget.view' | 'budget.edit'
  | 'vendors.view' | 'vendors.edit'
  | 'consent.view' | 'consent.propose' | 'consent.decide'
  | 'activity.view' | 'helpers.manage' | 'wedding.create';

/** `role` is the template's membership role: owner, admin, member or scorekeeper. */
export type Who = { role: string; grants: readonly GrantScope[] };

export const isPartner = (role: string) => role === 'owner';

const HELPER: Record<Capability, (g: readonly GrantScope[]) => boolean> = {
  'schedule.view': () => true,
  'schedule.edit': (g) => g.includes('schedule_edit'),
  'budget.view': (g) => g.includes('budget_view') || g.includes('budget_edit'),
  'budget.edit': (g) => g.includes('budget_edit'),
  'vendors.view': (g) => g.includes('vendors_view') || g.includes('vendors_edit'),
  'vendors.edit': (g) => g.includes('vendors_edit'),
  'consent.view': () => false,
  'consent.propose': () => false,
  'consent.decide': () => false,
  'activity.view': () => true, // filtered per entry by canSeeEntity
  'helpers.manage': () => false,
  'wedding.create': () => false,
};

export const allows = (who: Who, cap: Capability): boolean => isPartner(who.role) || HELPER[cap](who.grants);

/** Which change-log entries a person may see: a helper sees only entities inside their grants. */
const ENTITY_CAP: Record<string, Capability> = {
  task: 'schedule.view', wedding: 'schedule.view', baseline: 'schedule.view',
  category: 'budget.view', expense: 'budget.view', snapshot: 'budget.view',
  vendor: 'vendors.view', payment: 'vendors.view', flag: 'vendors.view', brief: 'vendors.view',
  request: 'consent.view', grant: 'helpers.manage',
};
export const canSeeEntity = (who: Who, entity: string): boolean => {
  const cap = ENTITY_CAP[entity];
  return cap ? allows(who, cap) : isPartner(who.role); // an unknown entity is partners-only
};
