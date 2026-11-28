// Knotwork's shared UI pieces (docs/DESIGN_SYSTEM.md). Presentational only: each takes words and figures the engines
// already worked out and adds no arithmetic, no data and no state. Server components; safe on guest-facing pages
// (they render only what they are handed).
import type { ReactNode } from 'react';

/** A status family (layer 3 of knotwork.css). The glyph comes from CSS and is not read out; the word is the text. */
export type Kind = 'ok' | 'late' | 'wait' | 'info' | 'off' | 'priv';

/** The pill: word, then glyph, then colour. Not a live region (role="status" stays the pages' own notices). */
export function Status({ k, children }: { k: Kind; children: ReactNode }) {
  return <span className="st" data-k={k}>{children}</span>;
}

/**
 * The two-key state of a designated action (round 2, D-176): one ring per partner, filled when that partner's key is
 * turned; solo draws the second ring dashed (D-33). The component owns its words, one fixed set used everywhere
 * (docs/DESIGN_SYSTEM.md "Keys"): `none` nothing proposed, `yours` you proposed and wait for your partner, `theirs`
 * your partner proposed and waits for you, `both` approved, `solo` one key while there is one partner. `partner` is
 * the other partner's name (falls back to "your partner"). `short` is the table form ("1 of 2 keys").
 */
export type KeyState = 'none' | 'yours' | 'theirs' | 'both' | 'solo';
const RINGS: Record<KeyState, 0 | 1 | 2> = { none: 0, yours: 1, theirs: 1, both: 2, solo: 1 };
export const keyWords = (state: KeyState, partner = 'your partner', short = false): string =>
  short
    ? ({ none: 'no key turned', yours: '1 of 2 keys', theirs: '1 of 2 keys', both: 'both keys', solo: 'solo' } as const)[state]
    : ({
      none: `No key turned yet. Proposing turns yours; it happens when ${partner} turns theirs.`,
      yours: `Your key is turned; ${partner}'s is the second.`,
      theirs: `${partner}'s key is turned; yours is the second.`,
      both: 'Both keys turned: approved and done in the same step.',
      solo: 'Solo: your key alone is enough until a second partner joins, and it is marked solo.',
    } as const)[state];

export function Keys({ state, partner, short }: { state: KeyState; partner?: string; short?: boolean }) {
  const on = RINGS[state];
  return (
    <span className="keys" data-keys={state}>
      <span className={state === 'solo' ? 'keys-rings solo' : 'keys-rings'} aria-hidden="true">
        <i className={on >= 1 ? 'on' : undefined} />
        <i className={on >= 2 ? 'on' : undefined} />
      </span>
      <span>{keyWords(state, partner, short)}</span>
    </span>
  );
}

/** The keys explained: the same four rows on the home page and on Approvals. */
export const KEYS_LEGEND: { state: KeyState; text: string }[] = [
  { state: 'none', text: 'No key turned: nothing proposed yet.' },
  { state: 'yours', text: 'One key turned: proposed. Nothing has changed yet.' },
  { state: 'both', text: 'Both keys turned: approved and done in the same step.' },
  { state: 'solo', text: 'Solo: one key is enough until a second partner joins, and it is marked solo.' },
];
export function KeysLegend() {
  return (
    <ul className="kw-plain kw-rows" aria-label="The keys">
      {KEYS_LEGEND.map((x) => (
        <li key={x.state}>
          <span className="keys" data-keys={x.state}>
            <span className={x.state === 'solo' ? 'keys-rings solo' : 'keys-rings'} aria-hidden="true"><i className={RINGS[x.state] >= 1 ? 'on' : undefined} /><i className={RINGS[x.state] >= 2 ? 'on' : undefined} /></span>
            <span>{x.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A row of figures: each a number (as the engine gave it) with its rule under it. */
export function Figs({ label, items }: { label: string; items: { value: ReactNode; rule: ReactNode }[] }) {
  return (
    <ul className="kw-figs" aria-label={label}>
      {items.map((x, n) => <li key={n}><b>{x.value}</b> <span>{x.rule}</span></li>)}
    </ul>
  );
}

/**
 * A table that scrolls sideways on a phone, inside a named region a keyboard can reach (WCAG 2.1.1). The region's
 * name starts with "Table:" so it never collides with the table's own accessible name.
 */
export function TableWrap({ label, fit, children }: { label: string; fit?: boolean; children: ReactNode }) {
  return (
    <div className={fit ? 'table-wrap fit' : 'table-wrap'} role="region" aria-label={`Table: ${label}`} tabIndex={0}>
      {children}
    </div>
  );
}

/** The mark: two interlocked rings, drawn in CSS. Decorative. */
export const Mark = () => <span className="kw-mark" aria-hidden="true" />;

/** The head of a guest-facing page: the mark and the couple's name. Shows only the title it is handed (rule 3). */
export function GuestHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="kw-guest-head">
      <Mark />
      <h1 className="display">{title}</h1>
      {children}
    </header>
  );
}

// ---- the engines' own words, mapped to a family. The word shown is always the engine's. -----------------------------

/** The scheduler's task state (bits.tsx `stateText`). */
export const stateKind = (s: 'ok' | 'late' | 'impossible' | 'done'): Kind => (s === 'late' || s === 'impossible' ? 'late' : 'ok');
/** A consent request's status. */
export const requestKind = (s: 'pending' | 'approved' | 'declined' | 'withdrawn' | 'expired'): Kind =>
  ({ pending: 'wait', approved: 'ok', declined: 'late', withdrawn: 'off', expired: 'off' } as const)[s];
/** A vendor's status. */
export const vendorKind = (s: 'considering' | 'booked' | 'dropped'): Kind => ({ considering: 'info', booked: 'ok', dropped: 'off' } as const)[s];
/** A household's invitation state. */
export const householdKind = (s: 'queued' | 'invited' | 'regrets'): Kind => ({ queued: 'wait', invited: 'info', regrets: 'off' } as const)[s];
/** A person's answer. */
export const rsvpKind = (s: 'pending' | 'attending' | 'declined'): Kind => ({ pending: 'wait', attending: 'ok', declined: 'off' } as const)[s];
/** A household task's due state in life-admin mode (life/home.tsx `DUE_TEXT`). */
export const dueKind = (s: 'overdue' | 'today' | 'soon' | 'later'): Kind => ({ overdue: 'late', today: 'wait', soon: 'wait', later: 'info' } as const)[s];
