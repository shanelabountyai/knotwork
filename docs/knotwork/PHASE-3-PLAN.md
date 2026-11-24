# Knotwork — Phase 3 plan ("the delighters")

Written 2026-11-24, before any Phase 3 code. Scope is PRD v1.1 Phase 3: **P0-5** group gifting and **P0-6** photo
wall, plus the contract attachments Shane parked until this phase (D-39: one upload pipeline, shared with the wall).
Shane asked for it in chat on 2026-11-24 ("Good to merge and start next phase"), after PR #2 and PR #3 were merged.
Branch `phase-3`, from `main` at 160b037. Phase 4 does not start in this run.

## 0. What rule 4 means here

This is the first phase that accepts a file. Every file enters through ONE module, `src/lib/knotwork/uploads/`, and
nothing else may read a request body as a file (structure test). The raw upload is never stored: what is stored is a
re-encoded copy. Each of the three guards has its own test and its own fixture:

- **Allowlist.** By magic bytes, not by file name or the browser's `Content-Type`: JPEG, PNG, WebP. Everything else is
  refused, including a file whose name says `.jpg` and whose bytes do not.
- **Cap.** Bytes (10 MB) checked before the body is buffered past the cap; pixels (50 megapixels) checked from the
  header before decoding, so a small file cannot expand into a huge bitmap.
- **Strip.** Decode and re-encode with `sharp` (orientation applied first, then no metadata written). Then a pure
  segment walker (`uploads/inspect.ts`) re-reads the OUTPUT and the ingest fails unless it finds no EXIF, GPS, XMP,
  IPTC, ICC or comment segment. The same walker is what the strip-verification fixtures assert with.

## 1. Data model (added to `prisma/schema/knotwork.prisma`)

| Table | Holds | Notes |
|---|---|---|
| `RegistryItem` | title, note, `targetCents`, `state` (open, funded, closed_unfunded), `fundedOn`/`closedOn` (dates of fact) | pooled items only (link-out items are P1-8) |
| `GiftEntry` | the ledger: item, household, `kind` (contribution, excess_return, refund), signed `amountCents`, created | append-only (trigger refuses update and delete); integer cents; mock money |
| `ThankYou` | item, household, created, `acknowledgedOn` | emitted when an item funds; P1-3 adds aging on top |
| `PhotoEvent` | name, `mode` (pre, post), upload token hash and sealed copy, `uploadsOpen`, `uploadDays`, `retentionDays` | link expiry and retention are DERIVED from the wedding date (rule 1); no stored deadline |
| `Photo` | event, device, uploader name, caption, `status` (pending, live, removed), `hiddenFromWall`, `hiddenFromAlbum`, mime, width, height, purged-at | bytes live in `PhotoBlob` |
| `PhotoBlob` | photo, `kind` (full, display, thumb), bytes, size | Postgres `bytea` for now (D-64); never in the export |
| `PhotoDevice` | event, device-token hash, blocked when and by whom | a device is a random cookie set on the upload page |
| `VendorAttachment` | vendor, label, mime, size, bytes, who, when | images only this phase (D-65) |

Every table: `orgId`, forced RLS policy, export hook, harness row (INV-42). `GrantScope` gains `photos_moderate`.

## 2. Gifting (`src/lib/knotwork/gifts/`)

- **Who gives.** A household, through its existing RSVP link: `/r/[token]/gifts`. No new credential, and the same
  404 for unknown, malformed, queued and regrets tokens as the RSVP page (rule 3). The page is built by
  `gifts/projection.ts`, which has no list, wave, priority, invite date or state in it.
- **Ledger (pure, `ledger.ts`).** `funded = sum(entries)`. A contribution of `offer` against `remaining`:
  refused when `remaining = 0`; otherwise one `contribution` entry for the whole offer and, when `offer > remaining`,
  one `excess_return` entry for `-(offer - remaining)`. The pot therefore lands on the target exactly.
- **The race.** The store takes the wedding lock, re-reads the sum, then writes. Two givers completing the pot at once:
  the first lands, the second sees the true remaining and gets an excess return (or a refusal when nothing remains).
  Fixture and a concurrent database test.
- **Funded.** When the sum reaches the target the item becomes `funded`, and one `ThankYou` row is written per
  household that contributed.
- **Close.** "Close the registry" refunds every open item's contributions (one `refund` entry per household, netting
  each to zero) and marks the item `closed_unfunded`. One transaction.
- **Privacy, structurally.** The couple's loader (`gifts/couple.ts`) reads sums per item (SQL aggregate) and the
  distinct contributor names; no code path on the couple's side selects an entry's amount. The change log line for a
  contribution carries no amount. The export carries per-item totals, not entries. A structure test scans the
  couple-side files and the export hook for `amountCents`. Contributors see the item, its progress, and their own entries.

## 3. Photo wall (`src/lib/knotwork/photos/`, `src/lib/knotwork/uploads/`)

- **Upload.** `/p/[token]` (page) and `/p/[token]/upload` (route): the second guest-facing surface. Token as for RSVP
  (32 random bytes, sha256 stored, sealed copy for the QR). Optional name and caption (one plain line each, D-61's
  rule). The link stops `uploadDays` after the wedding date. A QR code (SVG, `qrcode`) for the couple to print.
- **Pipeline.** Sniff → cap → decode → re-encode three renditions (full ≤ 4096 px, display ≤ 1600 px, thumb ≤ 400 px)
  → inspect each output → store. Done inside the upload request (D-66); `processUpload` is one function so a queue can
  call it later.
- **Moderation (pure state machine, `moderation.ts`).** Per event: `post` (default: live at once, remove on sight) or
  `pre` (pending until approved). Transitions: approve, reject, take down, undo. A takedown removes the photo from the
  wall and the album at once and can be undone. Hide-from-wall and hide-from-album are independent flags.
- **Devices and limits.** A blocked device's uploads are refused. Limits as data (`rules/photo-limits.json`): per
  device, per address (generous: a venue shares one address), per event. Python oracle and a rate-limit suite.
- **Wall.** `/o/[org]/wedding/photos/[event]/wall`: dark, full screen, newest first then rotation, corner QR, polling
  a JSON route every few seconds. Signed-in (a partner or a helper with `photos_moderate`), not public.
- **After.** Full-gallery download as a zip (stored, no compression; written here, no dependency); retention purge
  (`retentionDays` after the wedding date) as a function called by the cron job list and by a button.
- **Contract attachments.** Same pipeline, on the vendor page; a route handler, not a server action (a file is not a
  JSON input). Images only (D-65).

## 4. Fixtures and oracles

`fixtures/gifts/` (ledger cases incl. the funding race and close-with-refunds; `tools/gift_oracle.py`),
`fixtures/photos/strip/` (generated images carrying EXIF, GPS, XMP, ICC, a comment; expected: none after),
`fixtures/photos/moderation.json` (every state × action × mode), `fixtures/photos/limits/` (`tools/photo_limits.py`).
Load fixture: 200 uploads in 10 minutes from 20 devices, all stored, all on the wall feed.

## 5. Acceptance (PRD text) and the test that proves each

| # | PRD item | Test |
|---|---|---|
| 1 | P0-5 partial contributions toward a target, fully-funded trigger | `gifts-pure`, `gifts-db` |
| 2 | P0-5 refund-on-unfunded at close (mock money, ledgered) | `gifts-db` close |
| 3 | P0-5 privacy: couple sees progress and names, never amounts; contributors only their own | `gifts-db` + `structure` |
| 4 | P0-5 over-contribution at the race → exactly funded, clean excess | fixture + concurrent `gifts-db` |
| 5 | P0-5 thank-you feed emits obligations | `gifts-db` |
| 6 | P0-6 tokenized upload, no account; name and caption | `photos-db`, e2e |
| 7 | P0-6 EXIF/GPS stripped on ingest; allowlist; caps; renditions | `uploads-pure`, `photos-db` |
| 8 | P0-6 live wall: dark, polling, newest first with rotation, corner QR | e2e, `photos-pure` (rotation order) |
| 9 | P0-6 moderation: pre/post, takedown with undo, device blocking, per-device limits | `photos-pure`, `photos-db` |
| 10 | P0-6 gallery download; hide wall vs album independently; retention expiry | `photos-db` |
| 11 | P0-6 fixtures: strip verification, moderation machine, rate-limit suite | the three fixture suites |
| 12 | Metric: 200 uploads in 10 min render without loss | `photos-db` load |

Demo story (PRD capstone, third story): a guest scans the QR and their photo hits the moderated wall — `e2e/photos.spec.ts`.

## 6. Order of work

1. Gifting, whole vertical (schema, migration, RLS, pure, store, pages, fixtures, tests).
2. Upload pipeline, then photo wall, then contract attachments.
3. CLAUDE.md (rule 3 now names three guest-facing routes; rule 4 names the module), seed, e2e demo story, gate, PR.
