import { describe, expect, it } from 'vitest';
import { channelOf, checkMessage, E164, fitsSms, hourIn, LIMITS, smsQuiet, smsShape } from '@/lib/knotwork/guests/delivery';
import { reminderSms, reminderText, stopLink, stopView } from '@/lib/knotwork/guests/projection';

// Phase 5 (D-134): how a reminder reaches a household, and the guards on what is sent. Pure.
const URL = 'https://knotwork.example/r/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd';
const base = { remindVia: 'email' as const, email: 'a@b.example', phone: '', smsConsentOn: null, remindersStoppedAt: null };

describe('the channel a reminder goes on', () => {
  it('email needs an address; sms needs a phone in international form AND a consent date; none is none', () => {
    expect(channelOf(base)).toBe('email');
    expect(channelOf({ ...base, email: '' })).toBeNull();
    expect(channelOf({ ...base, remindVia: 'sms', phone: '+15551234567', smsConsentOn: new Date() })).toBe('sms');
    expect(channelOf({ ...base, remindVia: 'sms', phone: '+15551234567', smsConsentOn: null })).toBeNull(); // no consent, no text
    expect(channelOf({ ...base, remindVia: 'sms', phone: '555-123-4567', smsConsentOn: new Date() })).toBeNull(); // not a number a provider takes
    expect(channelOf({ ...base, remindVia: 'none' })).toBeNull();
  });
  it('a household that stopped reminders gets none, on any channel', () => {
    for (const remindVia of ['email', 'sms', 'none'] as const) expect(channelOf({ ...base, remindVia, phone: '+15551234567', smsConsentOn: new Date(), remindersStoppedAt: new Date() })).toBeNull();
  });
  it('international form', () => {
    for (const ok of ['+15551234567', '+447700900123', '+61412345678']) expect(E164.test(ok), ok).toBe(true);
    for (const bad of ['15551234567', '+0123456789', '+1 555 123 4567', '+1555', '+1234567890123456', '']) expect(E164.test(bad), bad).toBe(false);
  });
});

describe('message length guards', () => {
  it('counts GSM-7 and UCS-2 the way carriers do', () => {
    expect(smsShape('a'.repeat(160))).toEqual({ encoding: 'gsm7', units: 160, segments: 1 });
    expect(smsShape('a'.repeat(161))).toEqual({ encoding: 'gsm7', units: 161, segments: 2 });
    expect(smsShape('€'.repeat(80))).toEqual({ encoding: 'gsm7', units: 160, segments: 1 }); // an extension character costs two
    expect(smsShape('é'.repeat(10)).encoding).toBe('gsm7');
    expect(smsShape('💍')).toEqual({ encoding: 'ucs2', units: 2, segments: 1 });
    expect(smsShape('ł'.repeat(71))).toEqual({ encoding: 'ucs2', units: 71, segments: 2 });
  });
  it('refuses an empty body, a long or multi-line subject, a long email, and a text over three segments', () => {
    expect(checkMessage('email', { subject: 'Hi', body: ' ' })).toBe('empty');
    expect(checkMessage('email', { subject: 'Hi\r\nBcc: x@y', body: 'b' })).toBe('subject');
    expect(checkMessage('email', { subject: 'x'.repeat(LIMITS.subject + 1), body: 'b' })).toBe('subject');
    expect(checkMessage('email', { subject: 'Hi', body: 'x'.repeat(LIMITS.emailBody + 1) })).toBe('body');
    expect(checkMessage('sms', { subject: 'sms', body: 'x'.repeat(3 * 153) })).toBeNull();
    expect(checkMessage('sms', { subject: 'sms', body: 'x'.repeat(3 * 153 + 1) })).toBe('segments');
  });
});

describe('the reminder texts', () => {
  const email = (householdName: string, url = URL) => reminderText({ householdName, weddingTitle: 'Juniper & Rowan', rsvpBy: '2027-05-01', url, step: 14 });
  it('every reminder carries the household\'s own stop link, on its own RSVP token', () => {
    expect(stopLink(URL)).toBe(`${URL}/stop`);
    expect(email('The Okoros').body).toContain(`To stop these reminders: ${URL}/stop`);
    const sms = reminderSms({ weddingTitle: 'Juniper & Rowan', rsvpBy: '2027-05-01', url: URL }, fitsSms);
    expect(sms.body).toBe(`Juniper & Rowan: please reply by Sat, May 1, 2027: ${URL}\nStop reminders: ${URL}/stop`);
    expect(checkMessage('sms', sms)).toBeNull();
    expect(checkMessage('email', email('The Okoros'))).toBeNull();
  });
  it('a long title is shortened to fit; the links never are', () => {
    for (const title of ['A'.repeat(400), 'Ł'.repeat(300), '💍'.repeat(100)]) {
      const sms = reminderSms({ weddingTitle: title, rsvpBy: '2027-05-01', url: URL }, fitsSms);
      expect(fitsSms(sms.body), title.slice(0, 3)).toBe(true);
      expect(sms.body).toContain(`${URL}\nStop reminders: ${URL}/stop`);
    }
  });
  it('A and B households get the same words: only the name and the token differ, and no word says list, wave or priority', () => {
    const a = email('The Lindqvists', `${URL.slice(0, -4)}AAAA`);
    const b = email('The Okoros', `${URL.slice(0, -4)}BBBB`);
    const mask = (s: string) => s.replace(/The (Lindqvists|Okoros)/g, 'N').replaceAll(/\/r\/[\w-]+/g, '/r/TOKEN');
    expect(mask(b.body)).toBe(mask(a.body));
    expect(b.subject).toBe(a.subject);
    const fixed = [email('N').subject, email('N').body, reminderSms({ weddingTitle: 'T', rsvpBy: '2027-05-01', url: 'U' }, fitsSms).body].join('\n');
    expect(fixed).not.toMatch(/wave|list|priority|invited on|tier|queue/i);
  });
  it('the opt-out page is the wedding title and nothing else', () => {
    expect(stopView({ wedding: { title: 'Juniper & Rowan', list: 'B', waveId: 'w' } as never })).toEqual({ weddingTitle: 'Juniper & Rowan' });
  });
});

describe('quiet hours for scheduled text messages', () => {
  it('reads the hour in the wedding\'s time zone, across daylight saving', () => {
    expect(hourIn('America/Chicago', new Date('2027-01-15T06:00:00Z'))).toBe(0); // CST
    expect(hourIn('America/Chicago', new Date('2027-07-15T06:00:00Z'))).toBe(1); // CDT
    expect(hourIn('Europe/London', new Date('2027-07-15T06:00:00Z'))).toBe(7);
    expect(hourIn('Pacific/Auckland', new Date('2027-07-15T06:00:00Z'))).toBe(18);
  });
  it('9:00 to 19:59 only', () => {
    expect([0, 8, 9, 12, 19, 20, 23].map(smsQuiet)).toEqual([true, true, false, false, false, true, true]);
  });
});
