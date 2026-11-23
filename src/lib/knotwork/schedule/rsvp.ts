// The RSVP deadline (PRD P0-1, bride review #2). PURE.
//
// "RSVP deadline derives from the earliest vendor-count deadline minus chase-buffer." A vendor's count deadline is
// "N days before the wedding"; the earliest of them is the largest N. The RSVP deadline is a task whose buffer is that
// N plus the chase buffer, so it moves with the wedding like everything else and no date is stored.

export const RSVP_TASK_KEY = 'rsvp-deadline';

/** Buffer (days before the wedding) of the RSVP deadline, or null when no vendor has asked for a count. */
export function rsvpBufferDays(countDueDaysBefore: readonly (number | null | undefined)[], chaseBufferDays: number): number | null {
  const asked = countDueDaysBefore.filter((n): n is number => typeof n === 'number');
  return asked.length ? Math.max(...asked) + chaseBufferDays : null;
}
