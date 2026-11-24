// Clone-owned, like cron-jobs.ts and org-hooks.ts: modules this clone's own code depends on
// outside the marked lines (an import `foundation:check-modules` wouldn't otherwise see coming).
// foundation:check-modules leaves these in place and still removes the rest.
// Knotwork: RSVP reminders are enqueued in the notifications outbox (src/lib/knotwork/guests/store.ts).
export const REQUIRED_MODULES: string[] = ['notifications'];
