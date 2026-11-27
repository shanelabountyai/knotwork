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
 * The two-key state of a designated action: one ring per partner, filled when that partner's key is turned.
 * `on` is how many keys are turned (0, 1 or 2); `solo` draws the second ring dashed (D-33). The words carry the meaning.
 */
export function Keys({ on, solo, children }: { on: 0 | 1 | 2; solo?: boolean; children: ReactNode }) {
  return (
    <span className="keys">
      <span className={solo ? 'keys-rings solo' : 'keys-rings'} aria-hidden="true">
        <i className={on >= 1 ? 'on' : undefined} />
        <i className={on >= 2 ? 'on' : undefined} />
      </span>
      <span>{children}</span>
    </span>
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
