import { describe, expect, it } from 'vitest';
import { rsvpBufferDays } from '@/lib/knotwork/schedule/rsvp';

// PRD P0-1: "RSVP deadline derives from the earliest vendor-count deadline minus chase-buffer".
describe('RSVP deadline', () => {
  it('is the earliest count deadline (the largest days-before) plus the chase buffer', () => {
    // Caterer wants the count 14 days before, the venue 21 days before; chasing takes 14 days: RSVPs are due 35 days before.
    expect(rsvpBufferDays([14, 21], 14)).toBe(35);
    expect(rsvpBufferDays([14, null, undefined], 10)).toBe(24);
    expect(rsvpBufferDays([0], 0)).toBe(0);
  });
  it('does not exist until a vendor asks for a count', () => {
    expect(rsvpBufferDays([], 14)).toBeNull();
    expect(rsvpBufferDays([null], 14)).toBeNull();
  });
});
