# Knotwork — Phase 2 plan ("guest machine")

Written 2026-11-24, before any Phase 2 code. Scope is PRD v1.1 Phase 2: **P0-3** guest engine and **P0-4** tiered
backfill. Shane asked for it in chat on 2026-11-24 ("Merge, then Phase 2"). Branch `phase-2`, stacked on `solo-partner`
(PR #2). Phase 3 does not start in this run.

## 1. Data model (added to `prisma/schema/knotwork.prisma`)

| Table | Holds | Notes |
|---|---|---|
| `GuestPlan` | one per org: `cap`, `venueMin`, `venueMax`, `perHeadCents`, `kidsMealCents`, `vendorMealCents`, `lockoutDays`, `minBatchSeats`, `mealOptions` | plain settings, logged |
| `Household` | the invitation unit: name, address, email, phone, `list` (A or B), `priority`, `state` (queued, invited, regrets), `invitedOn` (a date of fact), wave, `saveTheDateSentOn`, plus-one override and its note, RSVP token hash and sealed token | the token is stored as sha256 (INV-07) plus a sealed copy so reminders can carry the same link |
| `Guest` | the response unit: name, `ageGroup`, `partnerStatus`, `inWeddingParty`, `isPlusOne`, `rsvp`, meal, dietary and accessibility tags, song request, private note, `respondedAt`, `removedAt` and the request that approved it | a guest is never deleted, only removed by an approved `remove_guest` request (rule 2) |
| `InviteWave` | number, list, released when and by whom, households, seats | one row per release |
| `HeadcountDelta` | label ("Linda declined"), seat and cost change, totals after | the delta feed |
| `ChaseEvent` | household, step, kind (reminder, call) | makes the cadence idempotent |
| `DoNotPlay` | title, artist | rides onto the DJ brief |

## 2. Modules (`src/lib/knotwork/guests/`)

Pure: `plus-one.ts` (rules as data), `backfill.ts` (held seats, cap state, release plan, lockout), `headcount.ts`
(counts, cost, deltas, rollups as counts), `chase.ts` (reminder cadence and call worklist), `csv.ts` (validated
import), `projection.ts` (the ONLY shape a guest ever sees, and the check of what a guest submits).
Stores: `store.ts` (households, guests, responses, waves, import, chase), `public.ts` (token lookup, the one cross-org
read). Routes: `/o/[org]/wedding/guests/...` for the couple; `/r/[token]` for a guest (public, token is the credential).

### Cap math, exactly

- A household that is **invited** holds one seat per guest who has not declined (a pending invite holds its seat), plus
  one for an unused plus-one while the entitled guest is still pending. Queued and regrets households hold nothing.
- `held ≤ cap` always. A release takes queued households of one list in priority order, first fit, and is one
  transaction under the wedding lock. Adding a guest to an invited household must fit too.
- B-list rules: nothing while an A household is still queued; nothing inside `lockoutDays` of the wedding; a batch
  must be at least `minBatchSeats` seats unless it is everything that is left (no one-by-one drips).
- Inside the lockout, remaining queued B households become `regrets`.

### Rule 3, exactly

A guest-facing response is built only from `projection.ts`. It carries the wedding, the household's name, its guests,
whether a plus-one is offered, the meal options and the RSVP-by date, which is the same date for everyone. It has no
list, wave, priority, invite date, creation time or state. Tokens are 32 random bytes; ids are random UUIDs. The sweep
(vitest on the projection and the reminder text, Playwright on the served HTML and headers) compares an A household and
a B household and requires the responses to be identical once names are masked.

## 3. Fixtures and oracle

`fixtures/guests/backfill/*.json` (cap accounting, first fit, batch minimum, lockout, A-before-B, the overbooking
case), `fixtures/guests/headcount.json` (hand math for counts and cost), `fixtures/guests/plus-one.json`,
`fixtures/guests/chase.json`, `fixtures/guests/import-good.csv` and `import-bad.csv`. `tools/guest_oracle.py`
recomputes the backfill and headcount fixtures independently (pytest).

## 4. TDD order

1. Backfill: fixtures, oracle, failing tests, then `backfill.ts`.
2. Undetectability sweep: failing tests on the projection, then `projection.ts`.
3. Plus-one, headcount, chase, CSV with their tests.
4. Schema, migration, RLS, export hooks, harness rows.
5. Stores and actions: the race tests (two releases at once; responses during a release), removal through consent.
6. Pages, the public RSVP page, seed, e2e.

## 5. Demo story (`e2e/guests.spec.ts`)

The seeded couple has a cap, an invited A-list and a queued B-list. A guest opens their RSVP link and declines. The
headcount drops, the cost delta appears ("declined: −$…"), and seats are free. When enough are free, the couple
releases the B batch; held seats never pass the cap. The B household's RSVP page is the same page as an A household's.
The caterer's brief shows counts and dietary rollups with no names; the DJ's shows requests and the do-not-play list.

## 6. Out of Phase 2

Seating (P1-5), gifts and the photo wall (Phase 3), a wedding website beyond the RSVP page, real email or SMS (the
outbox captures), save-the-date sending (the state is recorded by hand), per-guest RSVP links (one link per household),
automatic release without a person pressing the button, and file upload for the import (the CSV is pasted text).
