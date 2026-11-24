// RULE 3 (CLAUDE.md): guest-facing surfaces never leak wave data. PURE.
//
// This file is the ONLY thing a guest-facing response is built from. `rsvpView` copies, field by field, what a guest
// may see; everything else about a household (its list, wave, priority, invite date, creation time, state, the
// couple's private notes) simply has no path out. The RSVP-by date is the same for every household. The sweep in
// tests/knotwork/guests-pure.test.ts and e2e/guests.spec.ts compares an A household with a B household.
import { showDay, type Day } from '../days';

export const DIETARY = ['vegetarian', 'vegan', 'gluten_free', 'dairy_free', 'nut_allergy', 'shellfish_allergy', 'kosher', 'halal'] as const;
export const ACCESSIBILITY = ['wheelchair', 'step_free', 'hearing', 'vision', 'seating_near_exit'] as const;
export const TAG_LABEL: Record<string, string> = {
  vegetarian: 'Vegetarian', vegan: 'Vegan', gluten_free: 'Gluten-free', dairy_free: 'Dairy-free', nut_allergy: 'Nut allergy', shellfish_allergy: 'Shellfish allergy', kosher: 'Kosher', halal: 'Halal',
  wheelchair: 'Wheelchair user', step_free: 'Step-free access', hearing: 'Hearing support', vision: 'Vision support', seating_near_exit: 'Seat near an exit',
};

/** Keys that must never appear in anything a guest receives. The sweep walks every response for them. */
export const FORBIDDEN_KEYS = ['list', 'tier', 'waveId', 'waveNumber', 'wave', 'priority', 'invitedOn', 'invitedAt', 'createdAt', 'updatedAt', 'state', 'privateNote', 'plusOneOverride', 'plusOneNote', 'saveTheDateSentOn', 'rsvpTokenHash', 'rsvpTokenSealed', 'orgId', 'removedAt'];

export type RsvpViewInput = {
  wedding: { title: string; date: Day };
  rsvpBy: Day;
  mealOptions: string[];
  household: { name: string; plusOneAllowed: boolean; [internal: string]: unknown };
  guests: { id: string; name: string; ageGroup: 'adult' | 'child' | 'infant'; isPlusOne: boolean; rsvp: 'pending' | 'attending' | 'declined'; meal: string | null; dietary: string[]; accessibility: string[]; songRequest: string; [internal: string]: unknown }[];
};
export type RsvpView = {
  wedding: { title: string; date: Day; dateText: string };
  rsvpBy: Day;
  rsvpByText: string;
  mealOptions: string[];
  householdName: string;
  plusOneAllowed: boolean;
  plusOneNamed: boolean;
  guests: { id: string; name: string; ageGroup: 'adult' | 'child' | 'infant'; isPlusOne: boolean; rsvp: 'pending' | 'attending' | 'declined'; meal: string | null; dietary: string[]; accessibility: string[]; songRequest: string }[];
};

export function rsvpView(i: RsvpViewInput): RsvpView {
  return {
    wedding: { title: i.wedding.title, date: i.wedding.date, dateText: showDay(i.wedding.date) },
    rsvpBy: i.rsvpBy,
    rsvpByText: showDay(i.rsvpBy),
    mealOptions: [...i.mealOptions],
    householdName: i.household.name,
    plusOneAllowed: i.household.plusOneAllowed === true,
    plusOneNamed: i.guests.some((g) => g.isPlusOne),
    guests: i.guests.map((g) => ({ id: g.id, name: g.name, ageGroup: g.ageGroup, isPlusOne: g.isPlusOne, rsvp: g.rsvp, meal: g.meal, dietary: [...g.dietary], accessibility: [...g.accessibility], songRequest: g.songRequest })),
  };
}

/** The reminder a household gets. Built from the same few facts for every household; nothing about its list. */
export function reminderText(i: { householdName: string; weddingTitle: string; rsvpBy: Day; url: string; step: number }): { subject: string; body: string } {
  return {
    subject: `Please reply: ${i.weddingTitle}`,
    body: `Dear ${i.householdName},\n\nWe would love to know whether you can join us. Please reply by ${showDay(i.rsvpBy)}:\n${i.url}\n\n${i.weddingTitle}`,
  };
}

export type RsvpSubmission = { responses: { guestId: string; attending: boolean; meal: string; dietary: string[]; accessibility: string[]; songRequest: string }[]; plusOneName: string };
export type CheckedRsvp =
  | { ok: true; responses: { guestId: string; attending: boolean; meal: string | null; dietary: string[]; accessibility: string[]; songRequest: string }[]; plusOneName: string | null }
  | { ok: false; message: string };

/** Validates what a guest sent against what that guest was shown. Nothing outside the view can be touched. */
export function checkRsvp(view: RsvpView, s: RsvpSubmission): CheckedRsvp {
  const no = (message: string): CheckedRsvp => ({ ok: false, message });
  if (!s.responses.length) return no('Tell us whether each person is coming.');
  const byId = new Map(view.guests.map((g) => [g.id, g]));
  if (new Set(s.responses.map((r) => r.guestId)).size !== s.responses.length || s.responses.some((r) => !byId.has(r.guestId))) return no('That reply names someone who is not on this invitation.');
  const out = [];
  for (const r of s.responses) {
    const g = byId.get(r.guestId)!;
    if (r.dietary.some((d) => !(DIETARY as readonly string[]).includes(d)) || r.accessibility.some((a) => !(ACCESSIBILITY as readonly string[]).includes(a))) return no('Pick dietary and access needs from the list.');
    const song = r.songRequest.trim();
    if (song.length > 120) return no('Keep the song request under 120 characters.');
    const wantsMeal = r.attending && g.ageGroup === 'adult';
    if (wantsMeal && !view.mealOptions.includes(r.meal)) return no(`Pick a meal for ${g.name}.`);
    out.push({ guestId: g.id, attending: r.attending, meal: wantsMeal ? r.meal : null, dietary: r.attending ? [...new Set(r.dietary)].sort() : [], accessibility: r.attending ? [...new Set(r.accessibility)].sort() : [], songRequest: r.attending ? song : '' });
  }
  const name = s.plusOneName.trim();
  if (name && !view.plusOneNamed) {
    if (!view.plusOneAllowed) return no('This invitation does not include a guest.');
    if (name.length > 120) return no('That name is too long.');
    const adultComing = view.guests.some((g) => g.ageGroup === 'adult' && !g.isPlusOne && (out.find((r) => r.guestId === g.id)?.attending ?? g.rsvp === 'attending'));
    if (!adultComing) return no('A guest can only come with someone who is attending.');
  }
  return { ok: true, responses: out, plusOneName: name && !view.plusOneNamed ? name : null };
}
