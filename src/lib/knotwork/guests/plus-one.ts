// Plus-one entitlement (PRD P0-3): etiquette as rules-as-data. PURE.
//
// One plus-one per household at most. A per-household override by the couple wins over every rule (and is logged by
// the store). Otherwise the rules below are tried in order against the household's one adult invitee.

export type GuestCore = { id: string; name: string; ageGroup: 'adult' | 'child' | 'infant'; partnerStatus: 'none' | 'dating' | 'long_distance' | 'engaged' | 'married'; inWeddingParty: boolean; isPlusOne: boolean; rsvp: 'pending' | 'attending' | 'declined'; removed: boolean };
export type HouseholdCore = { plusOneOverride: 'grant' | 'deny' | null; guests: readonly GuestCore[] };
export type Entitlement = { entitled: boolean; rule: string; reason: string };

/** First match wins. `when` sees the household's single adult invitee. */
export const PLUS_ONE_RULES: readonly { rule: string; when: (g: GuestCore) => boolean; entitled: boolean; reason: string }[] = [
  { rule: 'wedding-party', when: (g) => g.inWeddingParty, entitled: true, reason: 'In the wedding party: invited with a guest.' },
  { rule: 'married', when: (g) => g.partnerStatus === 'married', entitled: true, reason: 'Married: their spouse is invited.' },
  { rule: 'engaged', when: (g) => g.partnerStatus === 'engaged', entitled: true, reason: 'Engaged: their partner is invited.' },
  { rule: 'long_distance', when: (g) => g.partnerStatus === 'long_distance', entitled: true, reason: 'Travelling a long way: invited with a guest.' },
  { rule: 'dating', when: (g) => g.partnerStatus === 'dating', entitled: false, reason: 'Dating: no guest by rule. Override it for this household if you want to.' },
  { rule: 'single', when: () => true, entitled: false, reason: 'No partner listed: no guest by rule.' },
];

export const activeGuests = <G extends { removed: boolean }>(h: { guests: readonly G[] }): G[] => h.guests.filter((g) => !g.removed);

export function entitlement(h: HouseholdCore): Entitlement {
  if (h.plusOneOverride === 'grant') return { entitled: true, rule: 'override-grant', reason: 'You gave this household a guest.' };
  if (h.plusOneOverride === 'deny') return { entitled: false, rule: 'override-deny', reason: 'You decided this household comes without a guest.' };
  const adults = activeGuests(h).filter((g) => g.ageGroup === 'adult' && !g.isPlusOne);
  if (adults.length === 0) return { entitled: false, rule: 'no-adult', reason: 'No adult on the invitation.' };
  if (adults.length > 1) return { entitled: false, rule: 'partner-named', reason: 'Two or more adults are already named on the invitation.' };
  const r = PLUS_ONE_RULES.find((x) => x.when(adults[0]!))!;
  return { entitled: r.entitled, rule: r.rule, reason: r.reason };
}
