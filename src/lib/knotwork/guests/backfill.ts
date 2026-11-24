// Tiered backfill cap math (PRD P0-4). PURE. Checked against tools/guest_oracle.py on every fixture.
//
// An INVITED household holds one seat per guest who has not declined (a pending invite holds its seat: that is the
// overbooking guard), plus one for an unused plus-one while an adult invitee is still pending. Queued and regrets
// households hold nothing. The invariant, always: held ≤ cap.
import { activeGuests, entitlement, type GuestCore } from './plus-one';

export type HouseholdIn = { id: string; name: string; list: 'A' | 'B'; state: 'queued' | 'invited' | 'regrets'; priority: number; plusOneOverride: 'grant' | 'deny' | null; guests: GuestCore[] };
export type CapState = { cap: number; held: number; attending: number; pending: number; declined: number; available: number };
export type ReleaseReason = 'ok' | 'nothing-queued' | 'a-list-waiting' | 'locked-out' | 'no-room' | 'below-batch';
export type ReleasePlan = { ids: string[]; seats: number; reason: ReleaseReason };
export type ReleaseRules = { cap: number; list: 'A' | 'B'; lockoutDays: number; minBatchSeats: number; daysToWedding: number };

/** Seats an invited household holds right now. */
export function heldSeats(h: HouseholdIn): number {
  if (h.state !== 'invited') return 0;
  const guests = activeGuests(h);
  const seats = guests.filter((g) => g.rsvp !== 'declined').length;
  const plusOneNamed = guests.some((g) => g.isPlusOne);
  const stillDeciding = guests.some((g) => g.rsvp === 'pending' && g.ageGroup === 'adult' && !g.isPlusOne);
  return seats + (entitlement(h).entitled && !plusOneNamed && stillDeciding ? 1 : 0);
}

/** Seats a queued household would hold the moment it is invited. */
export const seatsNeeded = (h: HouseholdIn): number => activeGuests(h).length + (entitlement(h).entitled ? 1 : 0);

export function capState(households: readonly HouseholdIn[], cap: number): CapState {
  const invited = households.filter((h) => h.state === 'invited').flatMap((h) => activeGuests(h));
  const held = households.reduce((n, h) => n + heldSeats(h), 0);
  const attending = invited.filter((g) => g.rsvp === 'attending').length;
  return { cap, held, attending, pending: held - attending, declined: invited.filter((g) => g.rsvp === 'declined').length, available: cap - held };
}

const inOrder = (a: HouseholdIn, b: HouseholdIn) => a.priority - b.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Which queued households of `list` to invite now: priority order, first fit. For the B list: nothing while an A
 * household is still queued, nothing inside the lockout, and no batch smaller than `minBatchSeats` unless it is
 * everything that is left (batch releases, not one-by-one drips).
 */
export function planRelease(households: readonly HouseholdIn[], r: ReleaseRules): ReleasePlan {
  const none = (reason: ReleaseReason): ReleasePlan => ({ ids: [], seats: 0, reason });
  const queued = households.filter((h) => h.state === 'queued' && h.list === r.list).sort(inOrder);
  if (!queued.length) return none('nothing-queued');
  if (r.list === 'B') {
    if (households.some((h) => h.state === 'queued' && h.list === 'A')) return none('a-list-waiting');
    if (r.daysToWedding < r.lockoutDays) return none('locked-out');
  }
  const room = capState(households, r.cap).available;
  const ids: string[] = [];
  let seats = 0;
  for (const h of queued) {
    const need = seatsNeeded(h);
    if (need <= room - seats) {
      ids.push(h.id);
      seats += need;
    }
  }
  if (!ids.length) return none('no-room');
  if (r.list === 'B' && seats < r.minBatchSeats && ids.length !== queued.length) return none('below-batch');
  return { ids, seats, reason: 'ok' };
}

/** Inside the lockout, every B household still queued becomes regrets (PRD: "converts remaining B-list ... cleanly"). */
export function lockoutRegrets(households: readonly HouseholdIn[], r: Pick<ReleaseRules, 'lockoutDays' | 'daysToWedding'>): string[] {
  if (r.daysToWedding >= r.lockoutDays) return [];
  return households.filter((h) => h.state === 'queued' && h.list === 'B').map((h) => h.id).sort();
}

export const RELEASE_TEXT: Record<ReleaseReason, string> = {
  ok: 'Ready to release.',
  'nothing-queued': 'Nobody is waiting on this list.',
  'a-list-waiting': 'Release the A list first: someone on it is still waiting.',
  'locked-out': 'Too close to the wedding for another round of invitations.',
  'no-room': 'No seats are free for anyone who is waiting.',
  'below-batch': 'Not enough seats are free for a batch yet. Invitations go out in batches, not one at a time.',
};
