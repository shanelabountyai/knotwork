# Knotwork — Phase 5 plan (PRD "Future Considerations", P2)

Written 2026-11-25, before any Phase 5 code. Shane asked in chat on 2026-11-25: "Build all the future
considerations", after PR #5 was merged. The PRD's P2 line has four items: a photo classifier-assist seam, a
date-move insurance info page, an anniversary rollover into a couples' life-admin mode, and real delivery providers
(the productionize pass). Branch `phase-5`, from `main` at f684765. Two slices, one after the other; one draft PR.

The standing limits shape all four. No live model calls, so the classifier is a seam with a local stub. No live email,
SMS or payments, and no env vars or secrets added, so "real providers" means the wiring and the readiness work: the
template already has a Resend email transport (`src/core/email/transport.ts`) and a Twilio SMS transport
(`src/modules/notifications/sms.ts`), both template-owned and both inert without their keys. No invented numbers: the
insurance page states no prices, insurers or claim figures.

## Slice E: classifier seam, insurance info page, delivery providers

- **Photo classifier-assist seam.** A `PhotoClassifier` interface in `src/lib/knotwork/photos/classifier.ts`:
  given a processed image (never the raw upload, rule 4), return labels with scores and a suggestion (`ok`,
  `review`, `hold`). Two implementations: `none` (the default: no suggestion, today's behaviour) and a deterministic
  local `stub` for tests and the demo. The suggestion is advice to the moderator only: it may put a photo in the
  review queue under post-moderation, it never removes, approves or publishes on its own (the PRD: human-only
  moderation in v1). Which classifier runs is a per-event setting, off by default. The moderation console shows the
  suggestion and why. A suggestion is logged. Nothing leaves the server.
- **Date-move insurance info page.** `/o/[org]/wedding/date/insurance`, linked from the date-move preview. Plain
  information: what wedding insurance and vendor contracts commonly cover when a date moves, questions to ask a
  vendor or an insurer, and the couple's own facts pulled from the app (the vendors whose contracts are signed, the
  payments already made and due, the tasks the move would make late or impossible). Labelled "general information,
  not insurance or legal advice". No prices, no named insurers, no statistics.
- **Delivery providers (productionize pass).** Make Knotwork's sends ready for the template's real transports without
  sending anything: (1) reminders on a schedule, through the template's cron hook (`src/app/cron-jobs.ts`) as well as
  the button; (2) a channel per household (email, SMS when a phone and SMS consent are recorded, or none), with a
  consent date of fact; (3) an opt-out link in every reminder, working through the household's own RSVP token, that
  stops further reminders at once (a guest-facing route on rule 3's closed list); (4) message bodies checked for
  length and for no wave signal; (5) tests that run the outbox drain against a stubbed `fetch` and assert the request
  each provider would receive (URL, headers without secrets, body), and that nothing is sent when the keys are unset;
  (6) `docs/knotwork/PRODUCTIONIZE.md`: the env vars to set, the cron to schedule, the DNS and sender-verification
  steps, and what is still a stub.

## Slice F: anniversary rollover, life-admin mode

- After the wedding day (derived from the wedding date, nothing stored), the workspace offers a switch into
  life-admin mode. The switch is a designated action (two keys, or solo before pairing, rule 2), reversible the same
  way, logged. A date of fact records when it happened.
- In life-admin mode the planning pages move behind an "Archive" view (read-only), and the home page becomes a
  couple's dashboard: anniversaries (derived each year from the wedding date), recurring household tasks with a
  cadence (stored as a rule, dates computed on read: rule 1 extended to recurrence), the name-change workflow carried
  on, thank-yous still owed, documents (the vendor attachments and contracts, read-only), and the photo album.
- Recurrence engine (pure): every N days/weeks/months, or yearly on the anniversary, with a done-on log; next due is
  computed, never stored. Fixtures and a Python oracle (month ends, leap days, daylight-saving).
- Secrecy (ADR-001) holds in life-admin mode; helpers keep only grants that still make sense (decided and recorded).
- The four build rules hold.

## Acceptance

| # | Item | Test |
|---|---|---|
| 1 | Classifier seam: interface, `none` default, local stub; suggestion never acts alone | `classifier-pure`, `photos-db` additions, structure scan (no network call in the classifier) |
| 2 | Insurance info page: the couple's own facts, no prices or insurers, labelled | `insurance-db`, leak sweep, e2e |
| 3 | Providers: scheduled reminders, channels with consent, opt-out, request shape per provider, nothing sent without keys | `delivery-db`, `delivery-pure`, structure (opt-out route on the closed list), A-vs-B sweep |
| 4 | Life-admin mode: designated switch, archive, anniversaries, recurrence, carried-over items | `lifeadmin-pure` + oracle, `lifeadmin-db`, e2e |
