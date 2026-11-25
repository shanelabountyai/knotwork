# Knotwork: turning on real delivery (productionize notes)

Phase 5, slice E (D-134). Knotwork's reminders are ready for the template's two transports, the Resend email transport
(`src/core/email/transport.ts`) and the Twilio SMS transport (`src/modules/notifications/sms.ts`). Neither is changed
by Knotwork, and nothing has been sent: there are no keys in any environment, and outside production every message is
captured as a `CapturedMessage` row instead. Turning sends on means setting the keys below. That step is Shane's.

## What happens today

| Piece | Where | State |
|---|---|---|
| RSVP reminders, by the button | `/wedding/guests/chase`, `sendDueReminders` in `src/lib/knotwork/guests/store.ts` | Ready |
| RSVP reminders, on a schedule | `sendRemindersEverywhere` in `guests/public.ts`, called first in `src/app/cron-jobs.ts` | Ready; per couple, off by default (`GuestPlan.autoReminders`, the checkbox on `/wedding/guests/waves`) |
| A channel per household | `Household.remindVia` (`email`, `sms`, `none`), set on the household page | Ready |
| SMS consent | `Household.smsConsentOn`, a date of fact typed by the couple; the database refuses `sms` without it and a phone | Ready (see the consent notes) |
| Opt-out | `/r/[token]/stop` (page) and `/r/[token]/stop/confirm` (post), on the household's own RSVP token | Ready; one-way (D-139) |
| Length and content guards | `checkMessage` in `guests/delivery.ts`: one-line subject up to 150, email body up to 4,000, a text message up to 3 segments | Ready |
| Quiet hours for scheduled texts | 9:00 to 19:59 in the wedding's time zone (`SMS_HOURS`) | Ready |
| Outbox drain | the template's `drainOutbox` (25 rows a run, 5 attempts with back-off, at-least-once) | Template-owned |
| Delivery status, bounces, replies | none | Stub: see "Still a stub" |

The request each provider would receive is pinned by `tests/knotwork/delivery-db.test.ts`, which drains the outbox
against a stubbed `fetch` with fake keys set in that test only: Resend gets `POST https://api.resend.com/emails` with
`Authorization: Bearer <key>`, `Content-Type: application/json` and `{ from, to, subject, text }`; Twilio gets
`POST https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json` with HTTP Basic auth and a form body
`To`, `From`, `Body`. With the keys unset in production nothing is sent, nothing crashes, and each row keeps its error
(`Email provider is not configured`, `SMS provider is not configured`) for the next attempt.

## Environment variables to set

Names only, all from `src/core/env.ts`. Set them in the hosting provider's environment settings, never in a file.

| Name | What for | Notes |
|---|---|---|
| `APP_URL` | the links in every reminder (RSVP and stop) | the public origin, `https://...`; already required |
| `AUTH_SECRET` | seals the stored copy of each RSVP link so a reminder can carry it | already required; rotating it makes saved links unreadable (D-59) |
| `CRON_SECRET` | `/api/cron` refuses without it | at least 16 characters |
| `RESEND_API_KEY` | the email transport | required in production by `parseEnv` |
| `EMAIL_FROM` | the sender, like `Juniper & Rowan <rsvp@mail.example.com>` | an address on the verified domain |
| `EMAIL_SANDBOX_TO` | outside production: really send, but only to this address | for a preview check before launch |
| `EMAIL_ENABLED` | `0` is the kill switch: nothing sent or captured | |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | the SMS transport | |
| `TWILIO_FROM` | the sending number, in international form (`+1...`) | must be registered for the messaging it carries (below) |
| `SMS_SANDBOX_TO` | outside production: really send texts, but only to this number | |
| `SMS_ENABLED` | `0` is the kill switch | |
| `VERCEL_ENV` | set by Vercel; real sends happen only when it is `production` (or with a sandbox address) | do not set by hand |

## The cron to schedule

`vercel.json` calls `GET /api/cron` once a day at 06:00 UTC (`0 6 * * *`), with `CRON_SECRET` as a bearer token.
Each run, in order: Knotwork's scheduled reminders (for couples who turned them on), then the outbox drain (up to 25
messages), then the template's other jobs, then the photo retention purge.

Before real sends, change the schedule:

- **06:00 UTC is midnight to 1 am in the US.** Emails go anyway (they wait in the inbox). Scheduled text messages are
  held by the quiet hours and would never go from a 06:00 UTC run for a US wedding; they still go from the button.
  Run the cron hourly (`0 * * * *`) or at least once in the couples' daytime (for the US, `0 15 * * *`).
- **The drain sends 25 messages a run.** One daily run can fall behind a large guest list on a reminder day. Hourly
  runs clear 600 a day. Reminders are idempotent (one per household per cadence step, recorded in `ChaseEvent` in the
  same transaction as the outbox row, under the wedding lock), so more frequent runs never send a step twice.
- Hobby plans allow one cron a day; hourly needs a paid plan, or an external scheduler calling `/api/cron` with the
  bearer token.

`vercel.json` is not changed by Knotwork; the schedule is a deploy decision.

## Email: sender and DNS verification (Resend)

1. In Resend, add the sending domain (a subdomain such as `mail.example.com` keeps the main domain's reputation apart).
2. Add the DNS records Resend shows for it, at the DNS host: the SPF record (TXT, or the MX + TXT pair on the
   subdomain Resend uses for bounces) and the DKIM record(s). Wait until Resend shows the domain as verified.
3. Add a DMARC record for the domain (TXT at `_dmarc`), starting with `p=none` and a reporting address, then
   tightening once reports are clean.
4. Set `EMAIL_FROM` to an address on that domain, and `RESEND_API_KEY` to a key scoped to sending.
5. On a preview deployment, set `EMAIL_SANDBOX_TO` to your own address, queue a reminder, run the cron, and read the
   message: the RSVP link and the stop link must both open on the deployed origin.
6. The template transport sends `from`, `to`, `subject` and `text` only, so no `List-Unsubscribe` header is set. The
   stop link is in every body. A `List-Unsubscribe` header (with the one-click post, RFC 8058) would need a change to
   the template-owned transport: a `FOUNDATION_PATCHES.md` entry and a decisions row, or an upstream change.

## Text messages: Twilio, registration and consent

1. Get a sending number (or a Messaging Service) in Twilio. For US recipients, application-to-person texts from a
   10-digit number need A2P 10DLC registration (a brand and a campaign describing these reminders, with sample
   messages and the opt-in wording); a toll-free number needs toll-free verification instead. Texts from an
   unregistered number are filtered or refused by the carriers.
2. Set `TWILIO_FROM` to that number in international form, then `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
3. On a preview, set `SMS_SANDBOX_TO` to your own phone and check one reminder end to end.

Consent notes:

- A household is reminded by text only when the couple has recorded **the day the household agreed** to texts
  (`smsConsentOn`, a date of fact) and a phone number in international form. The database refuses `sms` without both,
  and the phone cannot be cleared while texts are the channel.
- Knotwork records the date, not the evidence. Keep how the household said yes (a message, a form) outside the app,
  and record the date only after an explicit yes for reminder texts; an RSVP card or a phone number on file is not
  consent.
- Every text names the wedding, carries the RSVP link and a "Stop reminders" link on the same token. The stop is
  immediate and the couple cannot undo it (D-139).
- Replying STOP to the number is handled by Twilio's opt-out handling, not by Knotwork: Twilio blocks further texts
  to that phone, but the household is not marked as stopped here, and each later text to it fails at the provider and
  is retried by the drain up to five times. Until an inbound webhook exists (below), ask couples to use "No
  reminders" for anyone who texts STOP.
- Scheduled texts go only between 9:00 and 19:59 in the wedding's time zone.
- Texts carry no household name, and no list, wave or invite date (rule 3; the A-vs-B sweep covers every body).

## Still a stub, or not built

- **No delivery status.** A message counts as sent when the provider accepts it. Bounces, complaints, carrier
  failures and STOP replies are not received (no webhook routes for Resend or Twilio). Building them means two new
  public routes with signature checks, which is its own decision.
- **The classifier is a local stub** (D-135): `photos/classify.ts` holds `none` and a statistics-based `stub` for
  tests and the demo. A real model plugs into the `PhotoClassifier` interface in `photos/classifier.ts`. The structure
  test forbids network calls, model calls and environment keys in the classifier files; a hosted model would be a
  deliberate change to that test, with a decisions row, a data-processing agreement, and the same rule that advice
  never removes or publishes a photo.
- **Outbox rows keep the address and the body**, which carries the household's RSVP link (a credential), until the
  template's sweep deletes sent rows after 7 days. Anyone with database access can read them in that window.
- **Delivery is at least once** (the template's drain): a crash after the provider accepts a message sends it again
  when the lease runs out.
- **Captured messages** (outside production) are kept in `CapturedMessage` with their bodies; the demo inbox reads
  them.
- Only RSVP reminders use the outbox. Nothing else in Knotwork sends a message.
