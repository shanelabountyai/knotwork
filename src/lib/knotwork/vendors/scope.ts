// Vendor re-confirmation flags (PRD P0-2, bride review #4). PURE.
//
// "Any change touching a vendor's scope (counts, times, deliverables) flips that vendor to needs re-confirmation."
// Scope is exactly these fields, plus the wedding date itself. Contact details and notes are not scope. Only a booked
// vendor is flagged: one still being considered has confirmed nothing yet (D-16).

export const SCOPE_FIELDS = ['deliverables', 'arriveMin', 'departMin', 'countEstimate'] as const;
export type ScopeField = (typeof SCOPE_FIELDS)[number];
export type VendorScope = { deliverables: string; arriveMin: number | null; departMin: number | null; countEstimate: number | null };
export type ScopeChange = { field: ScopeField; before: string | number | null; after: string | number | null };

const norm = (v: string | number | null | undefined) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : (v ?? null));

/** The scope fields that differ. Whitespace-only edits to deliverables are not a change. */
export function scopeChanges(before: VendorScope, after: Partial<VendorScope>): ScopeChange[] {
  const out: ScopeChange[] = [];
  for (const field of SCOPE_FIELDS) {
    if (!(field in after)) continue;
    const [b, a] = [norm(before[field]), norm(after[field])];
    if (b !== a) out.push({ field, before: b, after: a });
  }
  return out;
}

export type FlagDraft = { vendorId: string; reason: 'date_moved' | 'scope_changed'; detail: Record<string, unknown> };

/** The flag for a vendor whose scope fields changed, or null (not booked, or nothing in scope changed). */
export function flagForScopeChange(vendor: { id: string; status: string }, changes: ScopeChange[]): FlagDraft | null {
  if (vendor.status !== 'booked' || !changes.length) return null;
  return { vendorId: vendor.id, reason: 'scope_changed', detail: { changes } };
}

/** A date move touches every booked vendor's times: one flag each. */
export function flagsForDateMove(vendors: readonly { id: string; status: string }[], from: string, to: string): FlagDraft[] {
  if (from === to) return [];
  return vendors.filter((v) => v.status === 'booked').map((v) => ({ vendorId: v.id, reason: 'date_moved' as const, detail: { from, to } }));
}

/** 'HH:MM' for a minute of the wedding day; '' when unset. */
export const hhmm = (min: number | null) => (min === null ? '' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);
export function parseHHMM(s: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
