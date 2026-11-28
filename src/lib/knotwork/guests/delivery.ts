// How a reminder reaches a household, and the guards on what is sent (Phase 5, D-134). PURE.
//
// A household is reminded on ONE channel: email (an address is on file), sms (a phone in international form AND a
// consent date of fact; the database checks the pair), or none (the couple calls). A household that stopped
// reminders from its own link gets none, whatever its channel. Every message passes `checkMessage` before it is
// queued: one line of subject, bounded lengths, and for a text message at most three segments.
//
// Rule 3: a reminder is built from the household's name, the wedding's title, the RSVP-by date (the same for every
// household) and the household's own link. Nothing about lists or waves is an input, so nothing about them can be
// in a body; tests/knotwork/delivery-pure.test.ts and guests-db.test.ts compare an A household with a B household.

export const CHANNELS = ['email', 'sms', 'none'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_TEXT: Record<Channel, string> = { email: 'Email', sms: 'Text message', none: 'No reminders (we will call)' };

export const LIMITS = {
  subject: 150,
  emailBody: 4000,
  /** Segments of a concatenated text message: 153 GSM-7 characters each, or 67 UCS-2 characters each. */
  smsSegments: 3,
  gsmSegment: 153,
  ucsSegment: 67,
} as const;

/** International form (E.164): what an SMS provider takes. */
export const E164 = /^\+[1-9]\d{7,14}$/;

export type Reachable = { remindVia: Channel; email: string; phone: string; smsConsentOn: unknown; remindersStoppedAt: unknown };

/** The channel a reminder would go on today, or null (then the household is on the call-personally worklist early). */
export function channelOf(h: Reachable): Exclude<Channel, 'none'> | null {
  if (h.remindersStoppedAt) return null;
  if (h.remindVia === 'email') return h.email ? 'email' : null;
  if (h.remindVia === 'sms') return E164.test(h.phone) && h.smsConsentOn ? 'sms' : null;
  return null;
}

// GSM 03.38: the basic set, and the extension set (each of those costs two characters).
const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€\f';

/** How a text message would be sent: its encoding, length in that encoding's units, and segments. */
export function smsShape(body: string): { encoding: 'gsm7' | 'ucs2'; units: number; segments: number } {
  const chars = [...body];
  const gsm = chars.every((c) => GSM_BASIC.includes(c) || GSM_EXT.includes(c));
  if (gsm) {
    const units = chars.reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0);
    return { encoding: 'gsm7', units, segments: units <= 160 ? 1 : Math.ceil(units / LIMITS.gsmSegment) };
  }
  const units = body.length; // UTF-16 code units: what UCS-2 counts
  return { encoding: 'ucs2', units, segments: units <= 70 ? 1 : Math.ceil(units / LIMITS.ucsSegment) };
}

export type Message = { subject: string; body: string };
export type MessageProblem = 'empty' | 'subject' | 'body' | 'segments';

/** Why a message may not be queued, or null. Checked for every reminder, on every channel. */
export function checkMessage(channel: Exclude<Channel, 'none'>, m: Message): MessageProblem | null {
  if (!m.body.trim()) return 'empty';
  if (channel === 'email') {
    if (!m.subject.trim() || m.subject.length > LIMITS.subject || /[\u0000-\u001f\u007f]/.test(m.subject)) return 'subject';
    if (m.body.length > LIMITS.emailBody) return 'body';
    return null;
  }
  return smsShape(m.body).segments > LIMITS.smsSegments ? 'segments' : null;
}

export const fitsSms = (body: string) => checkMessage('sms', { subject: 'sms', body }) === null;

/**
 * Quiet hours for text messages sent by the schedule (D-140): only from 9:00 to 19:59 in the wedding's time zone. A
 * text the schedule may not send now stays due, and goes on a later run inside the hours (or from the button, which a
 * person presses on purpose). Email has no quiet hours: it waits in the inbox.
 */
export const SMS_HOURS = { from: 9, until: 20 } as const;
export const hourIn = (timeZone: string, at: Date): number => Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(at));
export const smsQuiet = (hour: number) => hour < SMS_HOURS.from || hour >= SMS_HOURS.until;
