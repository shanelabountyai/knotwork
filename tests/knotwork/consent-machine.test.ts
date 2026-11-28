import { describe, expect, it } from 'vitest';
import { canPropose, DESIGNATED_KINDS, expiresAt, spendNeedsConsent, transition, type ConsentEvent, type ConsentStatus } from '@/lib/knotwork/consent/machine';
import { readJson } from './fixtures';

// P0-2: propose → the other partner approves, declines, or it expires; the proposer may withdraw. The table is written by
// tools/consent_table.py (independent Python rules) and holds every status × event × actor × time.
type Case = { status: ConsentStatus; event: ConsentEvent; actor: 'A' | 'B' | 'C' | 'H'; when: 'before' | 'at' | 'after'; expect: { ok: boolean; status: ConsentStatus; reason?: string } };
const { cases } = readJson<{ cases: Case[] }>('fixtures/consent/transitions.json');

const EXPIRES = Date.UTC(2026, 11, 1, 12, 0, 0);
const at = { before: EXPIRES - 1, at: EXPIRES, after: EXPIRES + 1 };
const actors = { A: { userId: 'user-a', isPartner: true }, B: { userId: 'user-b', isPartner: true }, C: { userId: 'user-c', isPartner: true }, H: { userId: 'user-h', isPartner: false } };

describe('consent state machine', () => {
  it('has the whole table', () => {
    expect(cases).toHaveLength(240);
  });

  it.each(cases.map((c) => [`${c.status} + ${c.event} by ${c.actor} ${c.when} expiry`, c] as const))('%s', (_, c) => {
    const got = transition({ status: c.status, proposerId: 'user-a', expiresAt: EXPIRES }, c.event, actors[c.actor], at[c.when]);
    expect(got).toEqual(c.expect);
  });

  it('never approves with the proposer as the approver, whatever else is true', () => {
    for (const status of ['pending', 'approved', 'declined', 'withdrawn', 'expired'] as const)
      for (const t of Object.values(at)) expect(transition({ status, proposerId: 'user-a', expiresAt: EXPIRES }, 'approve', actors.A, t).ok).toBe(false);
  });

  it('only a partner can propose', () => {
    expect(canPropose(actors.A)).toBe(true);
    expect(canPropose(actors.H)).toBe(false);
  });

  it('expiry is whole days from the proposal', () => {
    expect(expiresAt(Date.UTC(2026, 10, 23, 15, 30), 7)).toBe(Date.UTC(2026, 10, 30, 15, 30));
    expect(() => expiresAt(0, 0)).toThrow();
    expect(() => expiresAt(0, 1.5)).toThrow();
  });

  it('a spend needs both partners only when it is strictly over the threshold', () => {
    expect(spendNeedsConsent(50_000, 50_000)).toBe(false);
    expect(spendNeedsConsent(50_001, 50_000)).toBe(true);
    expect(spendNeedsConsent(1, 0)).toBe(true);
  });

  it('names the designated kinds of the PRD, plus the settings themselves and (Phase 5) the switch into life-admin mode and back', () => {
    expect([...DESIGNATED_KINDS].sort()).toEqual(['book_vendor', 'change_date', 'change_settings', 'remove_guest', 'set_mode', 'sign_contract', 'spend']);
  });
});
