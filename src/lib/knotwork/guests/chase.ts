// RSVP chasing (PRD P0-3, bride review #2). PURE. The cadence is data.
//
// Input: invited households that still have someone who has not answered. `daysLeft` is days until the RSVP
// deadline, which is itself derived from the wedding date (rule 1). A reminder is the latest step that has come due
// and was not sent; a missed earlier step is not sent late. From CALL_FROM_DAYS the household is on the
// call-personally worklist, and a household with no email address is there from the first step.

export const CADENCE_DAYS = [21, 14, 7, 3] as const;
export const CALL_FROM_DAYS = 3;

export type ChaseHousehold = { id: string; hasEmail: boolean; remindersSent: number[]; called: boolean };
export type ChasePlan = { remind: { id: string; step: number }[]; call: string[] };

export function chasePlan(households: readonly ChaseHousehold[], daysLeft: number): ChasePlan {
  const due = CADENCE_DAYS.filter((s) => daysLeft <= s);
  const step = daysLeft >= 0 && due.length ? Math.min(...due) : null;
  const sorted = [...households].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    remind: step === null ? [] : sorted.filter((h) => h.hasEmail && !h.remindersSent.includes(step)).map((h) => ({ id: h.id, step })),
    call: sorted.filter((h) => !h.called && (daysLeft <= CALL_FROM_DAYS || (!h.hasEmail && daysLeft <= CADENCE_DAYS[0]))).map((h) => h.id),
  };
}
