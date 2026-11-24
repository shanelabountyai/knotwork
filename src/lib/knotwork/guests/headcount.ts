// Live headcount → cost (PRD P0-3, bride reviews #3 and #5). PURE. Integer cents. Checked against tools/guest_oracle.py.
//
// Counts come only from INVITED households and guests who have not been removed. An adult costs a head, a child a kids
// meal, an infant nothing; each vendor who eats on site adds a vendor meal. Rollups for vendors are counts, never names.
import { usd } from '../money';
import { activeGuests, type GuestCore } from './plus-one';

export type GuestFull = GuestCore & { meal?: string | null; dietary?: string[]; accessibility?: string[]; songRequest?: string };
type H = { state: string; guests: readonly GuestFull[] };
export type Headcount = { attending: number; adults: number; kids: number; infants: number; vendorMeals: number; catererMeals: number; invited: number; responded: number; pending: number; declined: number; responseRatePct: number };
export type Prices = { perHeadCents: number; kidsMealCents: number; vendorMealCents: number };

const invitedGuests = (hs: readonly H[]) => hs.filter((h) => h.state === 'invited').flatMap((h) => activeGuests(h));

export function headcount(households: readonly H[], onSiteVendors: number): Headcount {
  const invited = invitedGuests(households);
  const going = invited.filter((g) => g.rsvp === 'attending');
  const by = (age: string) => going.filter((g) => g.ageGroup === age).length;
  const [adults, kids, infants] = [by('adult'), by('child'), by('infant')];
  const responded = invited.filter((g) => g.rsvp !== 'pending').length;
  return {
    attending: going.length, adults, kids, infants, vendorMeals: onSiteVendors, catererMeals: adults + kids + onSiteVendors,
    invited: invited.length, responded, pending: invited.length - responded, declined: responded - going.length,
    responseRatePct: invited.length ? Math.floor((responded * 100) / invited.length) : 0,
  };
}

export const costCents = (c: Headcount, p: Prices) => c.adults * p.perHeadCents + c.kids * p.kidsMealCents + c.vendorMeals * p.vendorMealCents;

export type VenueStatus = 'unset' | 'below-min' | 'ok' | 'over-max';
export const venueStatus = (attending: number, min: number | null, max: number | null): VenueStatus =>
  min === null && max === null ? 'unset' : max !== null && attending > max ? 'over-max' : min !== null && attending < min ? 'below-min' : 'ok';

/** One line of the delta feed: "Linda declined: −$87.00". */
export function deltaFor(firstName: string, verb: string, before: Headcount, after: Headcount, p: Prices) {
  const deltaCents = costCents(after, p) - costCents(before, p);
  const label = `${firstName} ${verb}`;
  const money = deltaCents === 0 ? 'no change in cost' : `${deltaCents < 0 ? '−' : '+'}${usd(Math.abs(deltaCents))}`;
  return { label, deltaSeats: after.attending - before.attending, deltaCents, text: `${label}: ${money}` };
}

const tally = (items: string[]) => Object.fromEntries([...new Set(items)].sort().map((k) => [k, items.filter((x) => x === k).length]));

/** What a vendor may see (PRD P0-3: "counts, never names"): meal counts, kids meals, dietary and accessibility counts, songs. */
export function rollups(households: readonly H[]) {
  const going = invitedGuests(households).filter((g) => g.rsvp === 'attending');
  return {
    meals: tally(going.filter((g) => g.ageGroup === 'adult' && g.meal).map((g) => g.meal!)),
    kidsMeals: going.filter((g) => g.ageGroup === 'child').length,
    dietary: tally(going.flatMap((g) => g.dietary ?? [])),
    accessibility: tally(going.flatMap((g) => g.accessibility ?? [])),
    songs: [...new Set(going.map((g) => (g.songRequest ?? '').trim()).filter(Boolean))].sort(),
  };
}
export type Rollups = ReturnType<typeof rollups>;
