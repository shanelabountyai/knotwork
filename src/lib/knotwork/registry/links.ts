// Link-out registry items (PRD P1-8): things a guest buys from a store, shown alongside the pooled gifts. PURE.
//
// The store's URL is typed by a partner and later rendered as a link on a guest's page, so it is hostile input: it is
// checked here (https only, a real host name, no user or password, nothing invisible, a length cap) and stored in its
// parsed, canonical form, so what is shown is what was checked. It is rendered with rel="noopener noreferrer nofollow"
// and target="_blank". Nothing is ever fetched from it: no scraping, no preview, no price lookup (D-107).
// The database checks its half again (RegistryLink_url_check).

/** The longest URL kept, before and after parsing. Real product links are far shorter; a page of junk is refused. */
export const URL_MAX = 2000;
export const TITLE_MAX = 120;
export const STORE_MAX = 80;
/** How many of one thing the couple may want, and a household may claim at once. */
export const QUANTITY_MAX = 99;
/** A price, when given: $0.01 to $100,000.00 (the same ceiling as a pooled gift's target). */
export const PRICE_MAX_CENTS = 10_000_000;

export type UrlProblem = 'empty' | 'long' | 'scheme' | 'credentials' | 'host' | 'malformed' | 'token';
export type UrlCheck = { ok: true; href: string; host: string } | { ok: false; why: UrlProblem };

export const URL_PROBLEM: Record<UrlProblem, string> = {
  empty: 'Paste the link to the item in the store.',
  long: `That link is too long (at most ${URL_MAX.toLocaleString('en-US')} characters).`,
  scheme: 'The link must start with https:// (a secure store page).',
  credentials: 'The link must not carry a user name or password.',
  host: 'The link must name a store\'s web address, like www.example.com.',
  malformed: 'That does not look like a web address. Copy it again from the store\'s page.',
  token: 'That link carries a long code that looks like a sign-in or tracking token. Copy the item\'s plain page address instead.',
};

// Control characters, every kind of space, a backslash (browsers read it as a slash), and the invisible characters
// that reorder or hide text (bidi controls, zero-width marks, the BOM).
const INVISIBLE = /[\u0000-\u0020\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff\\]/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Checks a store URL a partner typed. On success, `href` is the canonical form to store and `host` is shown beside it. */
export function checkStoreUrl(raw: string): UrlCheck {
  const s = raw.trim();
  if (s === '') return { ok: false, why: 'empty' };
  if (s.length > URL_MAX) return { ok: false, why: 'long' };
  if (INVISIBLE.test(s)) return { ok: false, why: 'malformed' };
  // The scheme is read from the text itself, before any parser: javascript:, data:, http:, a protocol-relative //x
  // and "https:x" (which a parser would quietly repair) are all refused here.
  if (!/^https:\/\//i.test(s)) return { ok: false, why: 'scheme' };
  // The authority as typed: anything with an @ in it carries a user (even an empty one, "https://@host").
  const authority = s.slice('https://'.length).split(/[/?#]/, 1)[0]!;
  if (authority.includes('@')) return { ok: false, why: 'credentials' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, why: 'malformed' };
  }
  if (u.protocol !== 'https:') return { ok: false, why: 'scheme' };
  if (u.username !== '' || u.password !== '') return { ok: false, why: 'credentials' };
  // A store has a name: at least two labels, letters, digits and hyphens (an international name arrives here in its
  // punycode form), and not an address in numbers (the last label of a name is never all digits).
  const host = u.hostname;
  const labels = host.split('.');
  if (host === '' || host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) return { ok: false, why: 'host' };
  if (u.href.length > URL_MAX) return { ok: false, why: 'long' };
  // A run of 64 hex digits is token-shaped: the data export refuses to carry one (INV-34), and a link that holds a
  // session or a personal token should not be handed to every guest anyway.
  if (/[0-9a-f]{64}/i.test(u.href)) return { ok: false, why: 'token' };
  return { ok: true, href: u.href, host };
}

/** A stored URL, checked again on the way out: the href to render, or null (shown as text, never as a link). */
export function safeLink(stored: string): { href: string; host: string } | null {
  const c = checkStoreUrl(stored);
  return c.ok && c.href === stored ? { href: c.href, host: c.host } : null;
}

/** The attributes every store link is rendered with. */
export const LINK_REL = 'noopener noreferrer nofollow';
export const LINK_TARGET = '_blank';

// ---- claims: "I bought this", bounded by how many the couple wants

export type ClaimRefusal = 'quantity' | 'already' | 'taken' | 'too-many';
export type ClaimPlan = { ok: true; claimedAfter: number; remainingAfter: number } | { ok: false; code: ClaimRefusal };

export const isQuantity = (n: number) => Number.isInteger(n) && n >= 1 && n <= QUANTITY_MAX;

/**
 * One household's claim of `quantity` against an item the couple wants `wanted` of, of which `claimed` are already
 * claimed by anyone (`mine` of them by this household, or null if it has no claim). The caller must have read
 * `claimed` and `mine` under the wedding lock. A household holds one claim per item: to change it, withdraw it first.
 */
export function planClaim(wanted: number, claimed: number, mine: number | null, quantity: number): ClaimPlan {
  if (!isQuantity(quantity)) return { ok: false, code: 'quantity' };
  if (mine !== null) return { ok: false, code: 'already' };
  const remaining = wanted - claimed;
  if (remaining <= 0) return { ok: false, code: 'taken' };
  if (quantity > remaining) return { ok: false, code: 'too-many' };
  return { ok: true, claimedAfter: claimed + quantity, remainingAfter: remaining - quantity };
}

/** Whole numbers only, typed or posted: "2" is 2; "2.0", "", "1e1", " 2x" are not numbers here. */
export function parseQuantity(v: string | number): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const t = v.trim();
  return /^\d{1,3}$/.test(t) ? Number(t) : null;
}
