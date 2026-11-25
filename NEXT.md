# NEXT

## ▶ 2026-11-25 (latest): Knotwork Phase 5 built (branch `phase-5`, draft PR #6, two slices, not merged, not deployed)
Shane asked in chat on 2026-11-25: "Build all the future considerations" (PR #5 merged; `phase-5` from `main` at
`f684765`). Plan: `docs/knotwork/PHASE-5-PLAN.md`. Two slices, one after the other (D-136). Decisions D-134 to D-151.
Synthetic data only; no live email, SMS, payments or model calls; no env var or secret added.

- **Slice E. Photo classifier-assist seam** (D-135, D-137): a `PhotoClassifier` interface given only a processed image;
  `none` by default, a deterministic local `stub`; per photo event, off by default. A suggestion is advice: `hold` puts
  a new post-moderation photo in the waiting queue, nothing else; it never removes, approves or publishes. Nothing in
  the seam can reach a network (a structure scan). **Date-move insurance information page** (D-141):
  `/wedding/date/insurance`, partners only, the couple's own facts through `insuranceView` (signed contracts, payments
  made and due, what a move leaves late), general questions to ask; no prices, insurers or statistics. **Delivery
  readiness** (D-134, D-138 to D-140): a reminder channel per household (email, SMS with a recorded consent day, none),
  an opt-out page and post on the household's own link (`/r/[token]/stop`, `/stop/confirm`, on rule 3's closed list),
  scheduled reminders per couple (off by default) through the cron, request shapes for the template's Resend and Twilio
  transports tested against a stubbed `fetch`; `docs/knotwork/PRODUCTIONIZE.md`. Turning sends on is setting keys.
- **Slice F. Life-admin mode** (D-143 to D-150): once the wedding day has passed (derived), a partner proposes the
  switch; it is a designated action (`set_mode`, executed only in `executeApproved`, a database trigger refuses any
  other writer, solo mode as D-33), reversible the same way, logged, with a date of fact (`Wedding.modeChangedAt`). In
  life-admin mode the home page is the couple's dashboard (the next anniversary and which one, household tasks, the
  name change, thank-yous still owed, the vendors' contract pages read-only, the photo albums) and the plan is a
  read-only archive (`/wedding/archive`; every write to it refused with one sentence; designated changes to the plan
  refused when proposed and when approved). Recurring household tasks (`/wedding/life`): a rule (every N days, weeks or
  months, or yearly on the anniversary) and a done-on log; next due computed on read (`lifeadmin/recurrence.ts`, pure:
  month ends clamp, Feb 29 weddings on Feb 28, calendar days in the wedding's time zone); nine fixtures recomputed by
  `tools/recurrence_oracle.py`. Helpers keep their grants read-only and the album if they moderate it; household tasks
  are the partners'. Secrecy holds: a sweep of every page by glob in life-admin mode shows no private label. On the
  guest side the RSVP link takes no reply ("Replies are closed now") and no reminder goes; gifts, the opt-out, the photo
  and vendor links are unchanged (D-148). A second synthetic couple (Sage & Wren, married 40 days ago, still planning)
  carries the e2e story; Juniper and Rowan stay in planning mode.
- **Server actions:** 124 → 126 (slice F added `proposeMode` and `householdTask`, one action with an `op`). The template's
  action harness ("passes INV-01/02/03/04/22") still runs past its fixed 180 s in this sandbox (the only cause of failure in
  both vitest legs); an uncommitted copy with only the time limit lifted passed every assertion in 286.4 s, and
  305.3 s when run again, with slice F (126 actions); 259.2 s at `7984011` (slice E, 124 actions, a worktree on the same
  machine and database, run between the two). The sandbox varies by tens of seconds run to run. CI took 149.5 s at 123
  actions (D-133); scaled by these ratios slice F would take about 165 to 176 s of its 180 s there. Not measured in CI
  yet: **likely to run out of the budget soon, if not on this PR** (D-150).
- **Gate (sandbox, 2026-11-25, after slice F):** lint 0 problems; typecheck clean; vitest (RLS off) 87 files, 1529 passed / 66 skipped, 2 failed: the
  harness's 180 s timer, and in the same file a control ("refuses an untagged id field") that hit a deadlock against the
  timed-out harness still running beside it (run alone, the file's other 13 tests pass); RLS
  enforce leg 87 files, 1595 passed / 1 skipped, 1 failed (the harness's 180 s timer, as above); `npm run build` OK;
  `foundation:drift` clean; `foundation:check-modules` pass; `fixtures:check` 88 the same, no difference; pytest 132
  passed; sandbox schema check after rebuilding the test database from scratch: 46 clone models, 31 enums, 72 tables,
  no difference; Playwright 52 passed (all specs, one worker).
- **CI (GitHub Actions) at `de056af`:** `ci (off)` success (migrate deploy, "Migrations match the schema", vitest 87
  files 1531 passed / 66 skipped, Playwright 52 passed), `modules-removed` success, `oracles` success. The action harness
  took **154.5 s** of its 180 s at 126 actions (149.5 s at 123, 158.5 s at 124: CI's run-to-run spread is as large as
  the per-action cost; D-152).
- **Not verified:** real sends through Resend or Twilio (no keys, by rule); a real photo classifier; the life-admin
  pages with years of done-day history (the household page lists the last five days per task).
- **Open for Shane** (a line each is enough):
  - D-133/D-150/D-152: the template's action harness has a fixed 180 s; CI used 154.5 s at 126 actions. A per-action
    budget upstream, or a `FOUNDATION_PATCHES.md` entry, before a phase adds many more actions?
  - D-134: delivery uses the template's Resend and Twilio transports; another provider only if those are not the ones.
  - D-135/D-137: plug a real classifier into the seam at productionize; should `review` hold a photo too?
  - D-138/D-139: may the couple undo a household's own stop (with a recorded reason)? Drop the `none` channel?
  - D-140: scheduled reminders off by default; on by default instead? Other SMS hours?
  - D-141: the insurance page is partners only; open it to helpers with `vendors_edit`?
  - D-143: the switch to life-admin mode is designated (two keys); automatic the day after the wedding instead?
  - D-144: the archive is enforced in the app (one gate); a database trigger per planning table as well?
  - D-145/D-146: household tasks count from the day last done (never done: due now); Feb 29 weddings on Feb 28.
  - D-147: helpers keep their grants read-only after the switch; end them at the switch instead?
  - D-148: in life-admin mode the RSVP link takes no reply, but the gift page stays open; close that too?
- **You:** review draft PR #6; answer what you care about above.

## ▶ 2026-11-25: Knotwork Phase 4 built (branch `phase-4`, four slices, not merged, not deployed)
Shane asked in chat on 2026-11-24: "Merge it start phase 4" (PR #4 merged; `phase-4` branched from `main` at `a932b6d`). Plan:
`docs/knotwork/PHASE-4-PLAN.md`. Built in four slices, one after another (D-90). Decisions D-89 to D-130; ADR-001 for
secrecy. Synthetic data only. No PR opened yet for `phase-4`.

- **Slice A. P1-1 secrecy compartments** (ADR-001, D-93 to D-105): a partner marks a task, spend, vendor or category
  "private to me until" an offset from the wedding date (or never). The other partner and the helpers see a masked line;
  amounts count in every total. Every signed-in page reads those four tables through `secrecy/views.ts` (a structure
  test enforces it) and a leak sweep renders every Knotwork page as three viewers. The change log is masked at write;
  the export is built for nobody. A designated action reveals what it names (rule 2). **P1-2 multi-funder budget**
  (D-95, D-103): funders pledge toward categories; pledged, received, spent; a `funder` grant sees only its own pledges.
- **Slice B. P1-3 thank-you ledger** (D-110 to D-112): one obligation per gift and giver from three sources (pooled gifts,
  claimed store items, gifts logged by hand), aged on read from a date of fact ("N unthanked > 3 weeks", four buckets), a
  note template generated, never stored. **P1-8 link-out registry items** (D-107 to D-109, D-113): https-only store
  links checked from the text, claimed by a household through its own link (`/r/[token]/gifts/claim`).
- **Slice C. P1-4 name-change sequence** (D-114 to D-117): rules as data for a generic fallback and three US states
  (illustrative, not legal advice), steps gated on prerequisites and documents held, private to the partner unless
  shared. **P1-6 contingency decision trees** (D-118 to D-123): create from a starter or pasted JSON, preview a branch,
  execute once in one transaction; a spend over the threshold is only proposed through consent.
- **Slice D. P1-5 seating chart** (D-125, D-127): tables with capacities, apart/together pairs (hard or soft),
  households kept together as a soft rule; generate = seeded greedy draft + bounded local search over six drafts,
  locked seats kept, a move by hand locks the seat; a chart that cannot keep every hard rule is refused with its
  reasons and nothing is written. Attending guests are seated; those who have not answered only when the couple turns
  it on. Twelve fixtures (seven optimal, four infeasible, one unsolvable) re-scored and brute-forced by
  `tools/seating_oracle.py`; 200 guests at 20 tables in under two seconds (test bound; about 0.6 s measured here).
  **P1-7 progress dashboard** (D-126): `/wedding/dashboard`, linked first on the home page: % of tasks on track,
  overdue tasks, open vendor flags, headcount against the cap and seating progress, approvals waiting, budget spent
  against estimate, the thank-you headline and aging, contingency plans. All read from the engines on the request;
  private items counted and masked; each section only for its capability. **Vendor read-only link (D-42; D-128, D-129)**:
  `/v/[token]` (a third public prefix on rule 3's closed list, same headers as `/r/` and `/p/`), 32 random bytes, sha256
  stored plus a sealed copy, replaceable and endable, works until 7 days after the wedding (derived), rate limited,
  one 404 for every link that does not work; shows the vendor's own role-filtered brief, worked out on each read
  (counts, never guests' names). A private vendor has no link.
- **Gate (sandbox, 2026-11-25, after slice D):** lint 0 problems; typecheck clean; vitest 81 files, 1440 passed / 64 skipped (RLS off) and
  1503 passed / 1 skipped (RLS enforce); `npm run build` OK; `foundation:drift` clean; `foundation:check-modules` pass;
  `fixtures:check` 79 the same, no difference; pytest 121 passed; sandbox schema check after rebuilding the test database
  from scratch: 44 clone models, 26 enums, 70 tables, no difference; Playwright 45 passed (all specs, one worker).
- **Not verified:** `prisma migrate deploy` / `migrate diff` (D-04; CI is the proof, the sandbox schema check stands in);
  the seating engine beyond the 200-guest bound test (no load test of the page with hundreds of move forms); the vendor
  page in a real vendor's mail client; GitHub CI on `phase-4` (see the PR).
- **Open for Shane** (a line each is enough):
  - D-89: the earlier open questions still stand as built: D-58, D-59, D-60, S4, D-65, D-70, D-72, D-79 to D-82.
  - D-94: with one hidden line, total minus the visible lines is its amount (accepted, as D-70).
  - D-98: a category named exactly like a private one is refused, which tells that the name exists (accepted).
  - D-118: plans are edited as JSON; a form-based tree editor is not built.
  - D-121: a plan runs once; "run it again" as a copy of the plan is not built.
  - D-123: contingency plans are partners only; a day-of coordinator helper who may run a plan that proposes nothing?
  - D-125: households are a soft seating rule and guests who have not answered are not seated by default; hard instead?
  - D-129: vendor links stop 7 days after the wedding and show the live brief, not the last generated version.
- **Re-check after a sandbox restart (2026-11-25):** lint, typecheck, drift, `fixtures:check` and pytest (121) pass
  again; vitest with RLS off passed 81 files, 1440 / 64 skipped before the restart. After it, on the new machine, the
  template's action harness (`tests/invariants/inv-01-04-22-actions.test.ts`, "passes INV-01/02/03/04/22") ran past its
  fixed 180-second budget, with RLS off and enforced: the server actions grew from 79 (main) to 123, and each check
  truncates every table. An uncommitted copy with no time limit passed every assertion in 229.6 s. The test is
  template-owned and its budget is not changed (D-131). CI is the judge: the same test took 31 s there on PR #2. **CI at `aca9081`: 149.5 s, passing, 30 s of headroom (D-133).**
- **You:** review the Phase 4 draft PR; answer what you care about above.

## ▶ 2026-11-24 (latest): PR #2 and PR #3 merged; Knotwork Phase 3 built (branch `phase-3`, draft PR, not merged, not deployed)
Shane asked in chat: "Good to merge and start next phase". PR #2 then PR #3 were merged with merge commits (main at
160b037). He did not pick among the options the review left open, so they were taken "as built" (D-62) and are still
open. Plan: `docs/knotwork/PHASE-3-PLAN.md`. Decisions D-62 to D-88. Phase 4 is not started.

- **P0-5 group gifting:** a household gives through its own RSVP link (`/r/[token]/gifts`); an append-only ledger in
  integer cents (mock money); a pot lands on its target exactly, an over-offer gets an excess return; funding writes
  one thank-you per giving household; closing refunds every unfunded gift. The couple sees totals and names, never an
  amount per giver (structure test, database test, export and change log checked).
- **One upload pipeline (rule 4, D-39):** `src/lib/knotwork/uploads/`. JPEG, PNG, WebP by magic bytes; 10 MB and 50
  megapixels; everything stored is re-encoded and then re-inspected for metadata; the raw upload is never stored.
- **P0-6 photo wall:** `/p/[token]` upload link with a QR code, no account; pre- or post-moderation; takedown with
  undo; device blocking; limits as data; dark polling wall; album, zip download, retention purge derived from the
  wedding date. Contract attachments on the vendor page use the same pipeline (images only, D-65).
- **Gate (cloud sandbox, 2026-11-24, re-run after the build):** lint 0 problems; typecheck clean; vitest 1180 passed /
  48 skipped (RLS off) and 1227 passed / 1 skipped (RLS enforce); `foundation:drift` clean; `fixtures:check` 42 the
  same; pytest 74 passed. Run once by the build workers: build OK, `foundation:check-modules` pass, Playwright 34
  passed, sandbox schema check no difference.
- **Not verified:** `prisma migrate deploy` / `migrate diff` (D-04; CI is the proof); the upload page on a real phone
  (camera picker, HEIC); load beyond the 200-upload fixture (sharp runs in the request, the zip is built in memory).
- **Open for Shane:** from the review: D-58, D-59, D-60, S4 (regrets are final). From this phase: D-65 (PDF
  contracts), D-70 (one giver's amount equals the total), D-72 (closing the registry is one key), D-79 and D-80
  (device cookie; what a blocked device is told), D-81 (the wall needs a signed-in laptop), D-82 (retention).
- **You:** review the Phase 3 PR; answer what you care about above; then "Phase 4" (P1 items in ranked order).

## ▶ 2026-11-24 (later): independent review of PR #2 and PR #3; fixes pushed; Phase 3 NOT started
Unattended run Shane asked for in chat on 2026-11-24. Two review agents that had not seen the author's reasoning read
each PR; every finding was then reproduced with a failing test or traced before anything was changed. Decisions D-55
to D-61. The full account is the "Independent review (2026-11-24)" comment on each PR.

- **PR #2 (solo mode): 1 must-fix, 4 should-fix, all fixed** on `solo-partner` and merged into `phase-2`. The solo
  migration left already-paired weddings unpaired (backfill migration `20261124000003`); the pairing latch is now set
  by the database when the second partner joins (`20261124000004`), not by the next page load; a solo action is logged
  as solo, not as two keys.
- **PR #3 (Phase 2): 4 must-fix, 9 should-fix.** Fixed: a full room crashed a guest's reply (500); several replies at
  once could add several plus-ones; an approved removal could push held seats past the cap; a rule-2 structure test
  had been narrowed; the reply redirect carried free text and names; dietary-only changes were not logged; guest text
  could forge lines on the DJ's brief; a plus-one could attend without their host; the CSV parser took 186 seconds on
  one hostile line and ran before the access check; a link could not be revoked and was silently replaced after a
  secret rotation; RSVP messages were not announced. Tests: `tests/knotwork/guests-review.test.ts` (17) and additions
  to `solo.test.ts` (7), `structure.test.ts`, `guests-db.test.ts`, `e2e/guests.spec.ts`.
- **Left for Shane (product calls, not fixed):** the plus-one seat rule (D-60), whether a removal re-entitles (D-58),
  RSVP link expiry (D-59), whether closing the B list or a lockout to regrets should be undoable or need both keys
  (D-50), two wordings ("you can change it here until the RSVP date" against D-51; "Needs both of you" shown in solo
  mode), and keeping what a guest typed when a reply is refused.
- **Why Phase 3 was not started:** the run's rule was "only if the review ends clean", and clean excluded any open
  product call that changes the RSVP projection or the Phase 2 data model. D-60 option (b) changes what the RSVP page
  offers, and D-59 option (b) adds a column; both are open. Phase 3's photo-upload links also copy whatever D-59
  settles.
- **Gate and CI:** in the PR comments, per check.
- **You:** read the two review comments; answer D-60 and D-59 (a line each is enough); merge #2, then #3; then say
  "Phase 3".

## ▶ 2026-11-24: Knotwork Phase 2 built (branch `phase-2`, draft PR against main, not merged, not deployed)
Shane asked for it in chat ("Merge, then Phase 2"). Plan: `docs/knotwork/PHASE-2-PLAN.md`. Stacked on `solo-partner`
(PR #2), so merge #2 first. Stopped at the Phase 2 gate; Phase 3 is not started. Shane's ten answers to the PRD v1.1
questions are rows D-34 to D-43; this phase's judgment calls are D-44 to D-54.

- **P0-3 guest engine:** households invited, individuals answer through one tokenized link per household (`/r/[token]`,
  the first guest-facing surface); plus-one rules as data with logged overrides; headcount and cost recomputed on every
  reply with a delta feed; kids and vendor meals; rollups for vendors as counts, never names; validated CSV import
  (pasted text, preview, all or nothing); reminder cadence into the outbox and a call-personally worklist; do-not-play
  list and song requests on the DJ's brief.
- **P0-4 tiered backfill:** cap math where a pending invitation holds its seat; A before B; batches, not drips; lockout
  to regrets; a release is one transaction under the wedding lock. Guest removal is designated (two keys, or solo).
- **Rule 3:** one projection is the only guest-facing shape; the sweep compares an A household with a B household on
  the projection, on real database responses, on reminder text, and on the served HTML and headers.
- **App:** 7 more tables (20 in all), 16 guest actions, 6 couple pages, the public RSVP page and route, seed extended.
- **Gate (cloud sandbox, 2026-11-24):** lint 0 problems; typecheck clean; vitest 930 passed / 40 skipped (RLS off) and
  969 passed / 1 skipped (RLS enforce); `tests/knotwork` 545 in 15 files; build OK; `foundation:drift` clean;
  `foundation:check-modules` OK (notifications now required and left in place); Playwright 25/25 (7 in
  `e2e/guests.spec.ts`); pytest 40 passed; `fixtures:check` 17 of 17.
- **Phase 2 acceptance: 11 of 11 PRD items met** (table in the PR). Limits worth knowing: nothing is really sent (the
  outbox captures); reminders are queued by a button, not a cron; save-the-dates are a date you record, not something
  the app sends; one RSVP link per household, not per guest.
- **Not verified here:** `prisma migrate deploy` / `migrate diff` (D-04; CI's "Migrations match the schema" is the
  proof for the two new migrations). The RSVP page on a phone or with a screen reader. Old browsers that send neither
  `Sec-Fetch-Site` nor a usable `Origin` are let in by design (D-45), untested. The `pg` "already executing a query"
  warning still prints once; it appears on the first page whose query includes several relations, which points at the
  Prisma adapter inside a transaction, not confirmed.
- **You:** merge PR #2 (solo mode), then review this PR. Things to look at first: D-45 (the same-site check on RSVP
  posts), D-47 (guests are never deleted), D-50 (B-wave rules). Then "Phase 3" starts gifts and the photo wall, where
  the one upload pipeline you asked for (D-39) gets built.

## ▶ 2026-11-24: PR #1 merged; solo mode (branch `solo-partner`, draft PR #2)
Shane approved PR #1 in chat on 2026-11-24 and asked for it merged (merge commit 9f2c532, not a squash, so v1.7.0 stays
an ancestor), then Phase 2. He also answered Question 1: a solo partner may act alone until the second joins. That is
D-33: one migration (`20261124000000_knotwork_solo`), `soloAllowed`, the pairing latch `Wedding.pairedAt`,
`tests/knotwork/solo.test.ts`. Phase 2 is branch `phase-2`, stacked on `solo-partner`.

## ▶ 2026-11-23: Knotwork Phase 1 built (branch `kickoff`, one draft PR, not merged, not deployed)
Unattended run Shane asked for on 2026-11-23. Plan: `docs/knotwork/PHASE-1-PLAN.md`. Decisions: `docs/knotwork/decisions.md`
(D-01 to D-32). Stopped at the Phase 1 gate; Phase 2 is not started.

- **Phase 0:** saas-foundation v1.7.0 merged with shared history, `new-project knotwork 8400`, `billing` removed (D-03).
- **Docs:** PRD v1.1 (house patterns and reuse lines mapped to file paths, Questions for Shane), `CLAUDE.md`,
  `WRITEUP.md`, this file, the plan.
- **P0-1 scheduler:** pure engine `src/lib/knotwork/schedule/engine.ts` (dates derived, never stored; critical path;
  late vs impossible; move preview with a fingerprint), default template, derived RSVP deadline, atomic `commitMove`.
  17 fixtures in `fixtures/schedule/`, each checked by an independent Python oracle (`tools/schedule_oracle.py`), plus
  300 seeded random plans compared across the two languages.
- **P0-2 two-key ownership:** state machine with expiry (240-case table), one executor of designated actions, database
  triggers that refuse a single key (D-27), change log on the template's append-only audit log, vendor re-confirmation
  flags, scoped helper grants.
- **P0-7 budget and vendor book:** categories, spends in integer cents, snapshots, vendors, scheduled payments as tasks,
  regenerable briefs filtered by vendor category.
- **App:** 13 tables in `prisma/schema/knotwork.prisma` (RLS policies, export hooks, harness rows), 24 server actions,
  9 pages under `/o/[org]/wedding` plus the workspace home, `npm run seed:couple` (one synthetic couple).
- **Gate (cloud sandbox, 2026-11-23; exact commands in the PR):** lint 0 problems; typecheck clean; vitest
  825 passed / 33 skipped (RLS off) and 857 passed / 1 skipped (RLS enforce, run locally as the `app_rw` role);
  of those, `tests/knotwork` is 440 in 12 files; build OK; `foundation:drift` clean against v1.7.0;
  `foundation:check-modules` OK; Playwright 18/18 (5 are Knotwork's demo story); pytest 25 passed;
  `fixtures:check` 17 of 17 the same.
- **GitHub CI on PR #1 at 2c2daf8:** `ci (off)` success (including `prisma migrate deploy`, "Migrations match the
  schema", vitest and Playwright with the real Prisma engine), `modules-removed` success, `oracles` success.
- **Phase 1 acceptance: 10 of 12 items met, 2 partial.** Partial: P0-7 contract **attachments** (no upload exists;
  needs a storage decision, D-17) and P0-7 brief content that depends on the guest engine (counts, do-not-play list:
  Phase 2 data; the brief says so instead of inventing it).
- **Not verified here:** `prisma migrate deploy` and `prisma migrate diff` (Prisma's schema engine cannot be downloaded
  in the sandbox, D-04): the migrations were applied by a stand-in and compared with the schema by a sandbox script;
  **CI's "Migrations match the schema" step is the proof.** `npm run db:setup` as written (same reason). Postgres was
  17.12 from an npm package, not a system install (D-05). `foundation:check-modules` ran with a tar stand-in for rsync
  (D-32). A `pg` deprecation warning ("client.query() when the client is already executing a query") still prints once
  during the e2e run; its source was not found. Nothing was checked on a phone-sized screen or with a screen reader.
  No real couple has used any of this.
- **You:**
  1. Read the draft PR; its "Questions for Shane" are the ten in PRD v1.1. Decide Question 1 first (may a solo
     partner act alone until the second joins): it changes what a new user can do on day one.
  2. Look at CI on the PR, the "Migrations match the schema" step above all.
  3. To run it: `npm ci && npm run db:setup && npm run seed:couple && npm run dev`, open `http://localhost:8400/demo`,
     sign in as `juniper@knotwork.demo.test`, and in a second browser as `rowan@knotwork.demo.test`.
  4. `git remote add template https://github.com/shanelabountyai/saas-foundation` in your clone, so
     `npm run foundation:drift` finds `v1.7.0` and later releases merge.
  5. If you keep it: add the `CLONES.md` row from the PR body to saas-foundation, and port 8400 to your port table.
  6. Merge or not; then say "Phase 2" to start the guest engine.

Everything below this section is the template's own NEXT.md, kept for its history; it is not Knotwork's to-do list.

## ▶ 2026-11-17: v1.7.0 PR open (branch `security/v1.7.0`): A-04, A-08 (owner decisions 2026-11-17)
Webhook endpoints are disabled with their creator's membership; a demotion below `apikeys.manage` revokes keys and disables
endpoints. One migration (guarded; backfills creators from the audit log and disables orphans), one breaking change
(`changeRole` takes `onRoleChanged`). After the owner merges: tag `v1.7.0`, push the tag to quorum, coursework and commons,
roll to every clone within 7 days (each adds `onRoleChanged` to its own `org-hooks.ts`; earmark keeps its guest lines).
**Decision (agent, 2026-11-17; owner may reverse):** a demotion also disables the person's endpoints, not only their keys,
by the same rule.

## ▶ 2026-11-17: v1.7.0 continued (branch `security/v1.7.0`): A-11, A-12, A-14, webhook pinning, `AiHold` CHECK
PR #26 (A-04, A-08) merged as 0c0f709 but untagged; this branch finishes the release (CHANGELOG 1.7.0, second half), so the
tag goes on after it merges. Every audit finding is then fixed. Rollout extras per clone: `GLOBAL_MODELS` in
`tests/fixtures/app.ts` (INV-42 lists what to name), the `recheckSsoDomains` cron line, and adjuster's reseed needs
`SET LOCAL app.allow_truncate = 'on'` if it runs outside a `_test` database. Not done: SSO issuer fetches are not pinned.

## ▶ 2026-11-17: v1.6.5 PR open (branch `security/v1.6.5`): A-06, A-10 (owner decisions), A-05 guard half, demo gate in core
v1.6.4 is tagged and on all 19 clones (CLONES.md). After the owner merges v1.6.5: tag `v1.6.5`, push the tag to quorum,
coursework and commons too (their CI drift step needs it in their own repo), roll to every clone; in ledgerleave, gavel,
tradepost and callboard replace the local demo gate with `@/core/demo-gate`. Still open from the audit (v1.7.0): A-04,
A-08, A-11, A-12, A-14, webhook address pinning, the `AiHold` CHECK.

## ▶ 2026-11-17: v1.6.4 PR open (branch `security/v1.6.4`): `security:` fixes from the 2026-11-17 audit
A-01, A-02, A-03, A-05 (session half), A-07, A-09, A-13 (CHANGELOG 1.6.4). The branch includes the audit itself (draft PR #20's
three commits), so merging it lands the report too and #20 can be closed. After the owner merges: tag `v1.6.4`, roll the
`security:` release to every v1.6.x clone within 7 days (CLONES.md), apikeys first in the deployed four (tradepost, callboard,
gavel, ledgerleave). Still open from the audit: owner decisions A-06 (who Require SSO refuses) and A-10 (fresh sign-in for an
export download); v1.7.0 A-04, A-08, A-05 guard half, A-11, A-12, A-14, address pinning for webhooks, `AiHold` CHECK.
**Decision (agent, 2026-11-17; owner may reverse):** v1.6.4 is the audit's security set only. The demo-gate env fix planned
for v1.6.4 (K11 in ledgerleave, gavel, tradepost, callboard) moves to v1.6.5, so this release stays a pure `security:` one.

## ▶ 2026-11-16: v1.6.3 PR open (branch `fix/module-table-guard-removed-modules`): module-table guard respects removed modules (BACKLOG F-17, F-18)
Housefile PR #1 (`fbab45b`, billing removed) was red on `ci (off)`: the v1.6.2 F-09 guard test asserted all four modules present.
After the owner merges: tag `v1.6.3`, push the tag to the clones, roll them (CHANGELOG 1.6.3: clones with the "F-17 test patched"
note take the template's `describe` block on conflict). Housefile is unblocked by merging v1.6.3 into its PR #1 branch.
**Decision (agent, 2026-11-16, unattended run; owner may reverse):** v1.6.3 is scoped to this fix only. It ships the F-17 test
change already on `main` in its stronger form (F-18), since both are the same bug. The **demo-gate env fix** (`DEMO_ACCESS_PASSWORD`/`VERCEL`
read outside `src/core/env.ts`, missing from `.env.example`; K11 ✗ in ledgerleave, gavel, tradepost, callboard), previously
planned "as v1.6.3 (with F-17)" below, **moves to v1.6.4**.

## ▶ Next session: scorecard gap plan **Step 2** (Opus, one project per session). Order: event toolkit (K2, K5, K11, K12), storage (K11, K12), reservations, use-case-studio, showcall, countertop.
**Step 1 DONE (2026-11-13), scorecard version 13** (https://claude.ai/artifact/TognMvisj8T9GNQGtE9MbJ): items 1-2 earlier (design bridge retired, `≈` state);
**item 3 (BACKLOG F-15) closed: 14 clone rows added**, one Sonnet sweep each against `origin/main` (data `audit/rescore/clones/<name>.json`, built by `build-scorecard.py` `CLONES`;
boxloop is a paused row). Results: bracketry, coursework, earmark, loanbook, pulseboard, quorum clean (0 ✗); adjuster 1, commons 1, gavel 1, housefile 1, ledgerleave 1, tradepost 1, callboard 3, footnote 3.
**Clone findings worth a template change:** the demo gate reads `DEMO_ACCESS_PASSWORD`/`VERCEL` from `process.env` outside `src/core/env.ts` and omits it from `.env.example`
(K11 ✗ in ledgerleave, gavel, tradepost, callboard): fix once in the template as v1.6.4 (moved from v1.6.3, decision 2026-11-16 above), then clones inherit it.
Other ✗: adjuster K4 (no org column, D73, candidate for `≈`); commons K11 `UPLOAD_ROOT`; housefile K14 port 5500 on `main`; footnote K5 (`/api/answers` unlimited, paid LLM calls), K11, K13 (key/role grants unaudited);
callboard K6 (`/p/*` referrer, no per-link revoke), K9 (Twilio inbound replayable), K11. Clone rows show a Re-check button that nothing services (cosmetic).
Earlier `≈` candidates and republish recipe: build `audit/scorecard.template.html` with `__DATA__` replaced by `audit/scorecard.json`; read the live source in full first (saved to tool-results), then resend.
Also owed: template patch **v1.6.4** for the demo-gate env fix above (F-17 ships in v1.6.3).

## ✅ 2026-11-09: every clone is on **v1.6.2** (13 PRs merged; earmark is the owner's, boxloop is on hold)

| Clone | PR | Merge | Production | Notes |
|---|---|---|---|---|
| pulseboard | #6 | ce2d574 | not deployed | |
| loanbook | #7 | 557b487 | not deployed | e2e first failed: F-08's child-process seed ran `seedDemoBook()`, whose book-wide accrual/status charged fees on loans.spec's loans. Owner chose D33 (skip the book when `TEST_WORKER_INDEX` is set) |
| adjuster | #6 | 7fd88f7 | not deployed | |
| bracketry | #5 | 22e6143 | not deployed | |
| housefile | #12 | 9463f76 | not deployed | `main` only |
| footnote | #4 | 3c9b0c7 | not deployed | F-17 test patched; apikeys stays removed |
| ledgerleave | #7 | 6e1ae9e | auto-deployed, Ready, 401 | F-17 |
| commons | #18 | dab862d | not deployed | F-17; F-14 ci.yml conflict |
| coursework | #6 | 0a91945 | not deployed | F-17; F-14 |
| quorum | #7 | 5999bc4 | not deployed | F-17; F-14; README conflict |
| gavel | #6 | 1ad1934 | auto-deployed, Ready, 401 | F-17; F-14; kept its own e2e demo flows |
| callboard | #21 | ee3c2f5 | hook redeploy, Ready, 401 | F-06 patch row dropped |
| tradepost | #6 | 824bfc3 | hook redeploy, Ready, 401 | hand port; D-031 |

Template audit: production 0; dev-only `minimatch` advisory logged as BACKLOG F-16.

## (done) roll every clone to **v1.6.2**
v1.6.2 released 2026-11-09 (PR #15 merged `51fbd33`, tag pushed to the template only; push it to each clone repo first).
No migration, no env change. Per-clone notes from the CHANGELOG 1.6.2 entry:
- **F-06** `Org.events` → `orgEvents`: callboard drops its `FOUNDATION_PATCHES.md` rename row; expect a merge conflict on that line.
- **F-14** CI enforce step: coursework, quorum, gavel hand-edited the DB name; take the template's lines (conflict expected).
- **F-08** e2e specs: callboard and tradepost patched `security-pages.spec.ts`/`demo.spec.ts`; take the template's unless their
  slugs/org names differ (tradepost's do: keep its demo orgs, take the seeding + nav change).
- gavel keeps its billing stub pair (D-102); nothing to undo.
Open owner decision: **BACKLOG F-15**, add clone rows to the scorecard or keep the disclaimer (page version 10 says clones are not scored).

## ✅ 2026-11-09: v1.6.2 released (BACKLOG F-06, F-08, F-09, F-11 to F-14). Scorecard republished (versions 9 and 10).

## (done) template v1.6.2 from BACKLOG F-06, F-08, F-09, F-11 to F-14 (rollout fallout). Model: Sonnet for the mechanics; F-09 and F-12 touch RLS migration output and upgrade claims, so Opus.
(done 2026-11-09: scorecard republished, version 9, foundation row v1.6.1, 286 pass + 21 skipped.)

## ✅ 2026-11-09: v1.6.x rollout done. Every clone is on **v1.6.1** (measured `FOUNDATION_VERSION` on each `origin/main`)

| Clone | v1.6.0/1.6.1 PR(s) | Production | Owner decisions / notes |
|---|---|---|---|
| pulseboard | #4 (owner-reviewed), #5 | not deployed | `/ingest` on `apikeys` (D-025..027) |
| tradepost | #4 (hand port), #5 | migrated (11), redeployed via hook, 401 | D-029 |
| callboard | #19, #20 | migrated (11), redeployed via hook, 401 | `Org.events` renamed locally (F-06); day-of e2e fixture fixed |
| loanbook | #5, #6 | not deployed | D31: ledger not in org export (no `orgId`), open item |
| adjuster | #4, #5 | not deployed | D104 |
| bracketry | #3, #4 | not deployed | D-57 |
| housefile | #10, #11 (`main` only) | not deployed | phase PRs #1/#5 still owe the merge (donor-table RLS + export, `Org.events`); `main` says port 5500 |
| footnote | #2, #3 | not deployed | **owner: `apikeys` removed** (D-55), key model `FootnoteApiKey`; owner: pull + `migrate deploy` on dev DB `footnote` |
| gavel | #4, #5 | migrated (13) before merge, auto-deployed, 401 | D-102 billing RLS stub; local `gavel_test` was migrated early |
| quorum | #6 (straight to 1.6.1) | not deployed | **owner: `quorum_app` BYPASSRLS** (D-61); before any deploy, `quorum_web` needs real RLS or the same |
| ledgerleave | #6 (straight to 1.6.1) | migrated (13) before merge, auto-deployed, 401 | D-64 |
| coursework | #5 (straight to 1.6.1) | not deployed | D-73 |
| commons | #17 (straight to 1.6.1) | not deployed | D-110: votes and reporter ids not exported |
| earmark | owner's | owner's | measured on v1.6.1 |
| boxloop | — | paused | on hold since 2026-10-19 (v1.2.1) |

**Owner decisions this rollout (2026-11-07/09):** migrate deployed clones' production DBs before merging; footnote drops the
`apikeys` module; quorum gets `BYPASSRLS`; remaining clones went straight to v1.6.1. Rollout lessons are in the
`foundation-rollout` skill. Cleanups done: `~/Projects/pulseboard-pr4` and `~/Projects/footnote-m12` worktrees removed,
`footnote_m12_test` dropped, the template's merged local `v1.6.0` branch deleted (it shadowed the tag; the remote branch remains).

## (done) v1.6.1 (merged and tagged, 329baf5): cross-org module markers + status regex
Earmark Phase 1.5 found INV-32 red in any clone that removed `billing` or `notifications` (unmarked cross-org entries).
Fixed on branch `v1.6.1`. After the owner merges: tag `v1.6.1`, push the tag to the clones, and roll clones to v1.6.1
instead of v1.6.0 (every clone that removed billing/notifications would hit the same INV-32 failure on v1.6.0).

## ▶ Next session: v1.6.0 clone rollout (`foundation-rollout` skill; Opus for Pulseboard, its `/ingest` key migration is auth code and stops for the owner)
**v1.6.0 released 2026-11-06:** PR #12 merged (`b131bc0`), tag `v1.6.0` pushed to the template and to all 15 clone repos
(the 14 in CLONES.md + earmark). `foundation:status` in quorum: "current v1.4.0, latest v1.6.0" (quorum's folder sits on the
stale branch `next-v1.4.0-merged`; its `main` is v1.4.1). Okta/Google hand checks done and recorded in CHANGELOG; they found
and fixed the Okta `email_verified` bug.
**Order (kickoff "After M14"):** Earmark Phase 1.5 is the owner's (merge v1.6.0, keep `sso` + `apikeys`, `RLS_MODE=enforce`,
`gh variable set RLS_ENFORCE --body 1 --repo shanelabountyai/earmark`). Claude: Pulseboard first (its proof PR #4 already
carries v1.6.0, worktree `~/Projects/pulseboard-pr4`), then the v1.4.1 order, one at a time, merge once green. The v1.5.0
rollout hold is moot: clones go straight to v1.6.0, which carries it.
**Small bug noticed:** `foundation:status` lists the 1.5.0 line "Not `security:`: ..." as a SECURITY entry (its regex matches
any line containing `security:`). Fix in the next template patch.
**Cleanups still owed:** footnote M12 worktree (`git -C ../footnote worktree remove ../footnote-m12 && dropdb footnote_m12_test`)
once footnote PR #2 is closed; `~/Projects/pulseboard-pr4` once Pulseboard's upgrade merges.

## ▶ Next session: v1.6.0 M14 (release). Model: Sonnet is enough for the mechanics, but merging RLS/SSO/auth release PR #12 is a phase gate: Opus. Prompt: `docs/v1.6.0-KICKOFF.md`, M14 row + header; read PR #12's M13 section first.
**Before the tag:** the owner's Okta and Google hand checks (M10, `.env.local` lines 6-8) are still owed, and the Pulseboard proof PR must be reviewed by the owner (addendum §9 M13 gate).

**M13 done 2026-11-05** (`84d8baa`, `2419b84` on `v1.6.0`, PR #12): `apikeys` module, core `emit` + `OrgEvent`, INV-40/41.
**Owner decisions:** (1) a member's API keys are revoked when their membership ends (removal, leaving, account deletion), via the
clone-owned `onMembershipEnded` hook, now a required argument of `removeMember`/`deleteAccount`; (2) retries and page-action events
ride the **daily** `/api/cron` (kept daily for cost; addendum §7 item 3); (3) Pulseboard reissues its `pk_` write keys as `api_` keys
(no row copy) with an `ingest` scope at 3,000/min. Deviations: addendum §7 "As built in M13" (13 items). Gate: off 282 + 21 skipped,
enforce 302 + 1 skipped, e2e enforce 14/14, check-modules passes with all four modules removed; scope, revocation, dedupe and the
membership hook each mutation-checked red. **Pulseboard proof PR #4** (https://github.com/shanelabountyai/pulseboard/pull/4, unmerged; clone decisions D-025 to D-027): `ci (off)` and
`modules-removed` green; `ci (enforce)` was red because the template made enforce mandatory for clones. **Fixed in the template**
(owner, 2026-11-05: enforce is opt-in via repo variable `RLS_ENFORCE=1`; addendum §7 item 14). **Next step:** merge the template's latest
`v1.6.0` commit into PR #4's branch (in a worktree; Pulseboard's folder is on `foundation-v1.4.0` with draft PR #2 open, leave it), take
the template `ci.yml` (drop the clone's D-027 if it only records the enforce failure), watch CI green, then the owner reviews the diff.
Local e2e trap: vitest leaves an org with slug `acme`, and the demo seed then shows no "Acme Studio"; truncate the test DB before e2e.

**M12 done 2026-11-05** (`ef2ce1f`, `55a3390` on `v1.6.0`, PR #12): AI spend guards, INV-39. **Owner decision: hard cap by reservation**
(`AiHold` under a row lock; the signature gains `maxCostMicros`), addendum §6 "As built in M12". Gate: off 266 + 16 skipped, enforce 281 + 1 skipped,
e2e enforce 14/14. Proof: footnote PR #2 (`v1.6.0-withbudget-proof`, unmerged), worked in the worktree `~/Projects/footnote-m12` against its own DB
`footnote_m12_test`, so Shane's uncommitted `CLAUDE.md` edit in `footnote/` is untouched. Remove both once the PR is closed:
`git -C ../footnote worktree remove ../footnote-m12 && dropdb footnote_m12_test`. INV-34 is red there on purpose (footnote's `CorpusChunk`, `StaffRole`,
`Answer`, `ApiKey` need export decisions in its real upgrade; `ApiKey` must never be exported whole).

**M11 done 2026-11-05** (`e3f2280` on `v1.6.0`, PR #12): audit viewer, org and account security pages, per-org data export, INV-34.
Gate: off 254 + 13 skipped, enforce 266 + 1 skipped, e2e enforce 14/14, demo-org exports verify against their manifests,
check-modules pass. Owner decision: export archives live in Postgres (`OrgExport`, 24 h), not Vercel Blob (addendum §5 "As built in M11", item 1).
**Still open from M10:** CI on `e3f2280`; owner's Okta and Google hand checks (`.env.local` lines 6-8), due before the M14 tag. Doc sync hazard
unchanged: never sync the Claude Doc copy of the addendum back to the file.

### (done) M10 handoff, 2026-11-05: Okta app set up (Integrator Free org `integrator-1711217`, redirect `http://localhost:4100/login/sso/callback`)

### (done) M9 handoff, 2026-11-04

**Owner decisions 2026-11-04:** (1) The RLS/SSO/enterprise release is **v1.6.0**, not v1.5.0: v1.5.0 is already tagged (`cdc146b`,
vitest 5) and pushed tags never move. `docs/v1.6.0-ADDENDUM.md` and `docs/v1.6.0-KICKOFF.md` are renamed and carry a note; the branch
is `v1.6.0`, the PR "v1.6.0: RLS, SSO, enterprise modules". (2) Claude created the local `app_rw` role (NOBYPASSRLS, no superuser),
granted DML on `saas_foundation_test` plus default privileges; its URL is `DATABASE_URL_APP_RW` in `.env.test` (gitignored, password
never printed). M9's `db:setup` takes it over and writes `DATABASE_URL` (app_rw) / `DATABASE_URL_SYSTEM` (owner).

**Kickoff pre-flight:** addendum APPROVED 2026-11-04 (§10: 2 and 3 tightened). Still the owner's: Okta and Google
`SSO_TEST_*` in `.env.local`, which does not exist yet (needed by M10, not M9). Done: every clone on v1.4.1; `app_rw`.

**Merge rule (owner, 2026-11-04): "merge without me if saas foundation based".** Template release PRs and clone upgrade PRs merge
once green (v1.6.0's at M14); kickoff, memory and `foundation-rollout` skill all say so. An owner "hold" overrides it.

**v1.5.0 (vitest) clone rollout is ON HOLD** (owner): only tradepost PR #4 open, unmerged. The rest wait for the owner's go;
`foundation-rollout` skill resumes it. A clone can also skip straight to v1.6.0 later (it carries v1.5.0).

## ▶ 2026-11-04 (later): v1.5.0 released (vitest 5, F-05, `cdc146b`); rolling out to clones under the standing rule

Owner, 2026-11-04: run updates end to end without asking (memory `foundation-updates-autonomous`; procedure in
`~/.claude/skills/foundation-rollout/SKILL.md`, per-clone agent `~/.claude/agents/clone-upgrader.md`, both user-level so clones
don't inherit them). v1.5.0: vitest 2.1 -> 5.1, dev only, not `security:`; full `npm audit` 14 -> 8 moderate (lint-only minimatch).
Clones roll out in batches; housefile goes last (its phase-branch merge is running).
**ON HOLD (owner, 2026-11-04).** Done: tradepost PR #4 (open, unmerged, CI was pending). Not started: every other clone. Resume only on the owner's go.

## ▶ 2026-11-04: v1.4.1 is live in every clone. Next item: housefile phase branches (in housefile's folder).

All 13 `security:` v1.4.1 PRs merged by owner request (checks re-verified green before each). Production redeployed: gavel and
ledgerleave built from `main` automatically; callboard via its manual deploy hook (HTTP 201). All three were Ready by 18:12 CST and
answer 401 behind their shared password. `CLONES.md`: 13 rows on v1.4.1. Left open, each in its own folder: housefile (merge `main`
into `phase-1` and the phase-2 branch; refresh `housefile_test`), footnote (`CLAUDE.md` line 33 says v1.3.0, beside Shane's
uncommitted edit), template F-05 (vitest 5).

## ▶ 2026-11-04: clone upgrades to v1.4.0 run FROM HERE, one at a time (owner decision)

Shane chose to drive every clone's v1.4.0 merge (carries `security:` v1.3.1) from this session instead of one session per
clone: one Opus subagent per clone, **sequential** (no overlapping builds or pools). Each one merges, runs typecheck, lint,
unit tests, drift and a build, then opens a PR and **does not merge it**. CI runs e2e. Order: ledgerleave, coursework,
tradepost, gavel, pulseboard, callboard (`onsitestaffing/`), loanbook, adjuster, bracketry, housefile (no `template` remote yet),
footnote. Skipped: boxloop (on hold), gridline (12 uncommitted files, not in `CLONES.md`). `CLONES.md` rows move only when a PR merges.

**Mid-queue 2026-11-04 (owner decision): v1.4.1 `security:` cut.** `npm audit` found a critical `next` RCE (Image Optimization +
SVG, `<=16.4.0`, so v1.3.1's 16.3.8 doesn't cover it) plus highs in zod/prisma/sharp/source-map-js/fast-uri. v1.4.1 bumps next to
16.4.5 (audit 0). Remaining clones take **v1.4.1**; already-open v1.4.0 PRs (tradepost #3, gavel #3, pulseboard #3, callboard #18,
loanbook) and the clones already on v1.4.0 (quorum, commons, coursework, ledgerleave) each get v1.4.1 merged in.

**Roll-out done 2026-11-04 (all merged later the same day, see top): every clone (except boxloop, gridline) had an open `security:` v1.4.1 PR; `npm audit --omit=dev` 0 in each.**
Owner merges each, by 2026-11-11 (sooner: critical RCE), and moves the `CLONES.md` row to v1.4.1 as each merges.

| Clone | PR | CI | Owner note |
|---|---|---|---|
| tradepost | #3 | green | hand port (no shared history) |
| gavel | #3 | green | D-99 spec scoped, D-100 previews off; **deployed: redeploy after merge** |
| pulseboard | #3 | green | |
| callboard | #18 | green | next 16.4.0 → 16.4.5; **deployed: fire deploy hook after merge** |
| loanbook | #4 | green | `modules-removed` flaked once (Google font fetch) |
| adjuster | #3 | green | `sharp` pin 0.35.4 → 0.35.5 (D91 c) |
| bracketry | #2 | green | |
| housefile | #9 | green | then merge `main` into `phase-1` and the phase-2 branch; local `housefile_test` has the phase schema (17 billing tests fail on `main`) |
| footnote | #1 | green | also fixes CI (pgvector image); `main` red until merged; your `CLAUDE.md` edit untouched, line 33 still says v1.3.0 |
| quorum | #5 | green | |
| commons | #13 | green | note is D-99; phase-7.1 numbers from D-100 |
| coursework | #4 | green | |
| ledgerleave | #5 | green | D-63 Preview builds off (owner, like gavel D-100); **deploying: redeploy after merge** |

**Release-process lesson:** a clone's CI resolves `FOUNDATION_VERSION` via the tag *in the clone's own repo*. quorum, commons,
coursework and ledgerleave failed `foundation:drift` (`bad revision 'v1.4.1'`) until the tag was pushed to each. Next release: push
the tag to clone repos as part of the roll-out (or keep the `Release vX:` commit-message line some clones fall back on).
Follow-up: F-05 vitest 5 (dev-only advisories) in `BACKLOG.md`.

## ▶ 2026-11-03: v1.3.1 and v1.4.0 both tagged and pushed. Nothing open in this repo.

v1.4.0 (PR #7) was already merged and tagged; v1.3.1 (`security:`) was tagged at `1bc3386` and pushed 2026-11-03, a week
past its 10-27 date. Still owed, **each in that clone's own session**: every clone still on v1.3.0 in `CLONES.md` owes
v1.3.1 (`security:`, overdue); quorum, ledgerleave, coursework also implement `filterListedOrgs` (v1.4.0, steps in PR #7).
Older queue: talk4me SEC-01, storage SEC-01/02, both in their own folders.

### (done) v1.4.0 prepared 2026-10-26 on branch `org-list-hook`

Owner decision 2026-10-26 (D-22): clone hook `filterListedOrgs(userId, orgs) => orgs` in clone-owned `src/app/org-hooks.ts`,
beside `beforeOrgDelete`. `/onboarding` and `/demo` call it through `keepListedOrgs` (`src/core/tenancy/listed.ts`), which
intersects with the input, so the hook can only hide. Local gate: lint clean (1 pre-existing warning), typecheck clean,
207 tests, e2e 10/10, `foundation:check-modules` passes.

**Version settled (owner, 2026-10-26):** PR #4 (`next` 16.3.8 `security:` bump) merged as **v1.3.1**; this hook is
renumbered **v1.4.0** (an additive change is a minor under §3.3). `main` merged into this branch; CHANGELOG lists 1.4.0
above 1.3.1.

**Owner to-do:**
1. Tag v1.3.1 from the Mac on `main` at the PR #4 merge commit `1bc3386`: `git tag v1.3.1 1bc3386 && git push origin v1.3.1`.
   Clones must take it by 2026-10-27 (`security:`).
2. Merge PR #7, then tag v1.4.0 at its merge commit and push (the cloud proxy refuses tag pushes).
3. Each of quorum, ledgerleave, coursework merges v1.4.0 (which carries v1.3.1) and implements the hook against its
   `OrgArchive` (steps in the PR body); its `CLONES.md` row moves to v1.4.0.

## ▶ v1.3.0 released 2026-10-14 (model: Opus — permissions)

✅ **Good to clear.** `scorekeeper` role + `results.write` (D-21), a `security:` release for two INV-22/INV-28 latent defects
the new role exposed. 172 tests pass (4 new), lint and typecheck clean; e2e and `check-modules` run in CI on the push and tag.
Bracketry merged it the same day for L-040. **Every other clone owes v1.3.0 by 2026-10-21** (with v1.2.1, due 10-20), each in
its own session.

## ▶ Next session here: talk4me is next in the older queue if picked up; storage SEC-01/02 runs in its own folder (Opus, money)

✅ **Good to clear.** **`v1.2.1` released and pushed 2026-10-13** (model: Opus — `security:` release). Four fixes from the
2026-10-12 review, each with a red-first test: stale invites (`e47af9a`), the email-change oracle (`71b5fd8`), demo sessions
(`2cc20a8`), and the owner's 2026-10-13 decision that a demo session also cannot create an org or use billing (`4cae624`).
168 tests pass, typecheck and lint clean. No schema change. **Every clone owes this within 7 days (due 2026-10-20)**, each in
its own session; `CLONES.md` rows stay as they are until each merges. Not run locally: `foundation:check-modules` and the
e2e sweep (both build) — CI runs them on the push and on the tag.

**Older checkpoint (superseded above):** **F-03 done and pushed 2026-09-28, tagged `v1.2.0`** (model: Sonnet — spec-following tooling, no new
logic). A clone declares a module required in the clone-owned `src/app/required-modules.ts`; `foundation:check-modules`
(`scripts/foundation-modules.ts`'s new `modulesToRemove()`) leaves that module in place and still removes the rest. 3 new
unit tests (157 total pass), the filter mutation-checked red (dropped it, confirmed the test failed, restored). Verified
for real, not just unit-tested: ran `foundation:check-modules` once with `notifications` required — passed with only
billing removed and `notifications` left in place — and once with the template's default (nothing required) to confirm
the existing CI job is unchanged. **Also fixed in passing:** `FOUNDATION_VERSION` was still `v1.1.0` — the `v1.1.1`
release (`a121708`) never bumped it, a step the release process (`IMPLEMENTATION_PLAN.md` §3.3) requires; a clone created
between those two commits would have stamped the wrong base version. Now `v1.2.0`, current.
**Not done, on purpose:** callboard hasn't merged the release yet — that's callboard's own session, per the established
pattern (it still owes `v1.1.0` and the `security:` `v1.1.1` too, due 2026-10-05). Its `CLONES.md` row stays `v1.0.1`
until then.

**CI fixed 2026-09-28** (`37cf7c4`, model: Opus — real regression, not a stale-test triage). Root cause: `e2e/billing.spec.ts`
still injected a cookie named `session` via `context.addCookies`; K1 (`a121708`) had renamed the real cookie to `__Host-session`.
Fixed to the new name — but Chromium's CDP rejects a `__Host-` cookie set with a plain `http://` `url` field ("Invalid cookie
fields"), so it's set via `domain: 'localhost', path: '/', secure: true` instead, which Chromium accepts and still sends over
`http://localhost` (treated as a secure context). Verified: 10/10 e2e, 154/154 unit+integration, lint/typecheck clean, `gh run
watch` on the push shows green. Clones (tradepost, pulseboard, callboard) can now safely take v1.1.1.

✅ **Good to clear.** 6 of 8 LOWs fixed and pushed 2026-09-28 (`a121708`, tagged **`v1.1.1`**, model: Sonnet — `security:` release,
**clones (tradepost, pulseboard, callboard) owe this within 7 days, by 2026-10-05**). 10 new tests (154 total pass, 1 file:
`tests/integration/low-2026-09-28.test.ts`), each of the 5 test-covered fixes (K1 x2, K2, K5, K6, K13) mutation-checked red by
reverting just that source file with the new test in place, confirming failure, then restoring — not just asserted done.
Typecheck and lint clean.
- **K1** (`session.ts`, `link.ts`): `signOutEverywhere`/`confirmEmailChange` now also spend the user's other unused sign-in
  links, atomically with the session/email change. Cookie renamed `session` → `__Host-session`, `Secure` unconditional.
- **K2** (`totp.ts`): `confirmTotp` now runs `assertFresh` and claims enrolment via a conditional `updateMany` on
  `totpEnrolledAt: null`, so a concurrent second confirm loses the race instead of also minting 10 more recovery codes.
- **K5** (`http.ts`): IPv6 rate-limit key now scoped to the address's first 64 bits, not the exact address.
- **K6** (`orgs.ts`): `removeMember` now revokes that user's active share links in the org, same transaction as the delete.
- **K13** (`invites.ts`, `links.ts`, `projects/actions.ts`): `addProject`, `createShareLink`, `revokeShareLink`,
  `revokeInvite` now wrap their write and `audit()` call in one `db.$transaction`. Only `invites.ts` has direct mutation-check
  coverage in the new test file; `links.ts`/`actions.ts` got the identical pattern, not separately mutation-checked.
- **Not fixed, deferred on purpose** (see `audit/FOUNDATION-REVIEW-2026-09-26.md` LOW section): K13's `audit_append_only`
  role separation (needs a second non-owner Postgres role — real infra change, add if the audit log ever needs to survive a
  compromised app role) and the `.env.example`/drift tooling item (already accepted, documented behavior, D-19d).
- **Not done, on purpose**: clone upgrade notes for v1.1.1 in tradepost/pulseboard/callboard's own `NEXT.md` — each clone
  upgrades in its own session, per the established pattern; they're still behind (all at v1.0.1 per `CLONES.md`) and now
  owe both v1.1.0 and this v1.1.1 `security:` release.

**Older checkpoint (superseded above):** FR-09..11 done and pushed 2026-09-28 (`d422d1a`, tagged **`v1.1.0`**, model: Sonnet). 5 new tests (144 total
pass), each confirmed red against the prior behavior before its fix (patched-to-old-code, ran, restored). Typecheck and lint clean.
- **FR-09**: `FOUNDATION_PATCHES.md` entries now carry a hash of the excused diff (`` `path` `hash` — reason ``); `foundation:drift`
  fails again once that path's diff moves on, instead of excusing it forever. Error message prints the hash to paste in.
- **FR-10**: Billing nav link in `layout.tsx` marked `{/* billing */}` (JSX — a trailing `//` renders as literal text) and added to
  `MARKED_FILES`. Verified end-to-end: ran `foundation:check-modules` for real, confirmed `/o/[org]/settings/billing` is gone from
  the build output and drift stays clean.
- **FR-11**: `new-project` now refuses a port already `in use`/`reserved` in `~/.claude/CLAUDE.md`'s port table (best-effort, skips
  if the file is unreadable), and refuses a second run once `package.json`'s name is no longer `saas-foundation`.
- **Not done, on purpose**: clone upgrade notes for v1.1.0 — FR-09..11 is tooling, not a `security:` release, so no 7-day clock;
  each clone (tradepost, pulseboard, callboard) picks up v1.1.0 whenever it next upgrades, in its own session.
- **Also not done**: the 8 LOWs from `audit/FOUNDATION-REVIEW-2026-09-26.md` — queued, not urgent, "as time allows."

**Decided 2026-09-26 (Shane): queue all of it for a fresh session; nothing was changed in code.** Findings, confirmed in source:
`audit/FOUNDATION-REVIEW-2026-09-26.md` (no HIGH, 11 MED, 8 LOW). Order:
1. ~~**FR-01 first**~~ **Done 2026-09-27, tagged `v1.0.2`** (lease claim, send outside tx, 15s fetch timeout; 3 new tests, 3 mutations red, 125 pass). Was: outbox sends inside a 5s interactive tx; a slow provider → delivered, not recorded, re-sent every cron run
   and blocks the queue. Callboard's cron is `*/5`, so this is the live risk. Worth its own patch tag (v1.0.2) if the rest runs long.
2. ~~FR-02..05~~ **Done 2026-09-27, tagged `v1.0.3`** (`8e4dd35`; 18 mutations red, 133 pass + 10/10 e2e, check-modules green). Clone notes added to each clone's NEXT.md (uncommitted there, beside the v1.0.2 note).
   Choices: pending-MFA TTL 10 min; wrong-code cap 20/user/UTC day; invite caps 50/sender, 100/org, 5/recipient per day; the cancel hook lives in clone-owned `src/app/org-hooks.ts` (core may not import modules); concurrent pending checkouts still make two subs (ponytail note, logged).
3. ~~FR-06/07/08~~ **Done 2026-09-28, untagged (CHANGELOG *Unreleased (1.1.0)*)**: `unguardedEntrypoints()` + `// public: <reason>` markers (14 files), glob all of `src/` + inline `'use server'` refused, id-like untagged fields throw (`notRef()` opt-out). 7 mutations red, 139 pass. Tag v1.1.0 after FR-09..11, then add each clone's upgrade note (their NEXT already says v1.1.0 follows).
4. ~~FR-09/10/11 tooling~~ **Done 2026-09-28, tagged `v1.1.0`** (`d422d1a`). See the checkpoint note above.
5. ~~LOWs (K1, K2, K5, K6, K13 writes)~~ **6 of 8 done 2026-09-28, tagged `v1.1.1`** (`a121708`). See the checkpoint note above.
   Remaining 2 are deliberately deferred/no-action, not open work (K13 audit-role separation needs new infra; drift/.env.example
   item is accepted behavior) — the LOW queue item is closed.
Clones: tradepost (4200), pulseboard (4500), callboard (4600) — each upgrades in its own session. All three still owe v1.1.0
*and* v1.1.1 (`security:`, due 2026-10-05) — neither has an upgrade note yet.

**Also done 2026-09-26:** clinic D-32 (group leader writes notes for own group only, `f35252c`) and rental SEC-16 / D-266
(unrouted inbox portfolio-wide only, `58a0b5b`); CI green in both. Both repos had another session active at the time.

**Decided 2026-09-23: urgent live-security fixes run before foundation M0.** Each one is its own session, run in
**that project's folder** (one session per project). The details for each are in that repo's *Security findings*
section and in `audit/<repo>.md` here.

**Session pick 2026-09-25: item 5 (storage SEC-01/02) runs on Opus, in the storage business folder, not here. Foundation has nothing open; safe to /clear.**

**2026-09-26: Opus K4 pass done** (`audit/K4-SWEEP-2026-09-26.md`, scorecard v7). Rental K4 ✗ (3 HIGH, confirmed in source), clinic K4 ✗ (1 HIGH),
alongside ✔, reservations N/A. Rental's Re-check processed: 10/14, not the 14/14 its own NEXT claims (K1, K6, K11 still ✗).
Storage's Re-check stays queued in the artifact db until its SEC-01/02 edits are committed (they were uncommitted in flight at the time).
Carried notes moved to `BACKLOG.md` (F-01, F-02). Items 9–10 were fixed the same day (scorecard v8: rental 11/14, clinic 10/14).

## Queue (in order)

1. ~~**clinic: SEC-01 HIGH.**~~ **Live** (verified 2026-09-23): env vars set, pushed (`5f24c71`, in sync with origin),
   `curl -I https://clinic.labintelligence.co/` returns 401 with a Basic challenge, and the cron route returns 401 with no challenge. gitleaks is clean (196 commits),
   so `clearpath` was **made public** on 2026-09-23. **Done.**
2. ~~**event toolkit: SEC-01 HIGH.**~~ Fixed (`2de11b8`); SEC-02 fixed too. **The repo is still blocked from going public:**
   gitleaks flags a literal Vercel bearer token in `.claude/settings.json` (plus the ` 3`/` 4` copies), commit `b8310aa` (2026-08-14).
   Shane: revoke that Vercel token. The files are no longer tracked, but they are not gitignored either, so add `.claude/settings*.json` to `.gitignore`. The token stays in history, so revoking it is the real fix.
   SEC-03/04 (MED) are in progress in that folder (uncommitted edits).
3. ~~**claude-dashboard: SEC-01 HIGH.**~~ Fixed (`a009fce`, pushed). The server binds to 127.0.0.1 and a LAN connection is refused. SEC-02 and OPS-01 are covered by the same fix. **Done.**
4. ~~talk4me~~: **deferred to the end of the queue** (Shane, 2026-09-23). See item 8.
5. **storage business: SEC-01, SEC-02** (webhook re-apply; cross-facility echo). Model: Opus (money). The repo was made private on 2026-09-23 because of these findings; make it public again once both are fixed.
6. ~~design bridge~~: dead project (the API it needed cost too much), 2026-09-23. The repo stays private. SEC items dropped.
7. ~~**Foundation M0**~~ **Done** 2026-09-23 (Shane chose to run it before storage). The repo `shanelabountyai/saas-foundation` is **private**.
   The scaffold is pushed, and spikes S1–S3 all passed (the results are in spec §0). CI is lint + typecheck. Port 4100 is claimed in `~/.claude/CLAUDE.md`.
   **M1 core platform: done** 2026-09-23 (env/clock/log/db + guard, headers, health, error pages, vitest, prod-build e2e, CI; INV-14, 15 (public + api), 18, 20 green).
   **M2 Auth: done** 2026-09-23 in one session (est. 2). INV-05/07/09 (scoped to M2), 13, 15 (signed-in), 17, 23, 24, 25, 26 (TOTP) are green,
   and each was mutation-checked red. The first migrations exist: core, billing and notifications, each separate (D-14d). Build choices are in spec **D-14**.
   **M3 Tenancy + authz: done** 2026-09-23 in one session (est. 2). INV-01/02/03/04/22 run through the glob harness
   (`tests/invariants/harness.ts`; six negative controls, and mutation-checked red on real code), plus INV-05 (membership removal),
   06, 07 (invite), 09 (invite accepts), 19, 21 (including concurrent demotion), 26 (deletion) and 28, all green. D-13 confirmed; build choices are in spec **D-15**.
   **M4 Share links: done** 2026-09-23. `Project` is the example resource, with `core/share/{links,project}.ts`, `/s/[token]` and `/o/[org]/projects`.
   INV-07 (share link), 08, 09 (share reads) and 15 (share route) are green, each mutation-checked red (7 mutations). The e2e sweep passed 8/8. Build choices are in spec **D-16**.
   **M5 Cron + secret hygiene: done** 2026-09-24. `core/cron.ts` (`isAuthorizedCron`: fails closed, `safeEqual`, header only), hourly `/api/cron`
   (also sweeps `RateLimit` rows older than a day), `CRON_SECRET` in env + `.env.example`, `vercel.json` cron. INV-10/11/16 green, 5 mutations red. 84 unit/integration tests pass.
   **M6 Billing: done** 2026-09-24. `modules/billing/{provider,webhook}.ts`, `/api/webhooks/stripe`, `/o/[org]/settings/billing` (+ nav link),
   mock provider when no key. INV-12 green (13 tests, 8 mutations red, including the SB "any row = duplicate" bug and a dropped row lock).
   98 unit/integration + 9/9 e2e. **Found and fixed a defect present since M1**: Prisma writes were stored 5–6h off in a non-UTC Postgres zone (D-17g).
   Build choices are in spec **D-17**.
   **M7 Notifications: done** 2026-09-24. `modules/notifications/{outbox,sms,templates}.ts`, drain + 7-day sweep in `/api/cron`, Twilio/SMS env keys.
   11 new tests (109 total pass), 4 drain mutations red (no row lock, no backoff, no attempt cap, no sentAt filter). Build choices are in spec **D-18**.
   **M8 Demo, clone tooling, release: done** 2026-09-25. `/demo` + `seed:demo` (INV-27, 3 mutations red), `new-project`, `db:setup`, `foundation:drift|status|check-modules`
   (CI job `modules-removed`), README, legal stubs, CHANGELOG, CLONES. 122 tests + 10/10 e2e. **Tagged `v1.0.0`, then `v1.0.1`** (the acceptance run found the README's
   `git checkout -b main` fails in a fresh clone; a pushed tag is not moved, so the fix is a patch release). Clone from **v1.0.1**. Acceptance run from a clean clone:
   install to a working `/demo` sign-in took about 10s warm-cache (limit 30 min; not measured cold). Build choices in spec **D-19**.
   **M9 scorecard: done** 2026-09-25, artifact https://claude.ai/artifact/TognMvisj8T9GNQGtE9MbJ. Foundation row all ✔ (122 tests). All rows re-scored 2026-09-25 by Sonnet agents (audit/rescore/*.json; design bridge stays baseline). K3/K4 spot-checks flagged; the Opus K3/K4 pass has not run. Per-project Re-check buttons queue requests in the artifact db (docs checks/<project-id>); process them by reading with ArtifactData, re-running that project's scorer, then writing doneAt + summary back.
   **Clinic K11/OPS-04 cleanup landed 2026-09-25** (`clinic` a2e07eb: zod env schema, OPS-04 was already satisfied). Clinic is now 10/14. `audit/scorecard.json` and `build-scorecard.py` are updated and committed, but the artifact was republished (v5) with clinic at 10/14. **Next: storage (item 5)**, then talk4me. Earlier: storage (item 5) and talk4me (item 8).
   - Not built, on purpose: `scripts/seed.ts`, `scripts/drain-outbox.ts` (nothing needs them).
   - Shane, optional: to try real Stripe test mode, set `STRIPE_SECRET_KEY` (sk_test_), `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` in `.env.local`
     and forward with `stripe listen --forward-to localhost:4100/api/webhooks/stripe`. Not needed for M7.
   - Carried notes: an audit-log viewer (`audit.read`) and `/o/[org]/settings/security` are not built. Neither is in any milestone yet, so add them to `BACKLOG.md` if wanted.
   - The harness takes ~2.5s on an idle machine and ~80s under a sibling project's sweep (load 45). That is CPU contention, not a hang.
8. **talk4me: SEC-01 HIGH** (deferred here from item 4 on 2026-09-23). Cap `api/tts.ts` at about 500 chars, allowlist voice ids,
   add a Vercel Firewall rule. Model: Sonnet. After it is fixed, make the `talk4me` repo public.
9. ~~**rental business: K4-R1/R2/R3 HIGH**~~ **Fixed 2026-09-26** (`6d75d45`, SEC-09–15, CI green). Open in that repo: SEC-16 (unrouted inbox, a design
   question for Shane), the K4 LOWs, and K1/K6/K11 (tenant sign-out not server-side, same-origin referrer + no no-store on token pages, env schema covers 6 vars).
10. ~~**clinic: K4-C1 HIGH**~~ **Fixed 2026-09-26** (`8c060a5`, SEC-07–11). Also fixed: clinic CI had been red at `npm ci` since SEC-06 (`b72b1f3`, 09-23) —
   `a4d11ba` — which hid a date-rotted e2e spec, fixed in `62d7f1c`; CI green. Open in that repo: whether a group leader may write notes for attendees
   they don't treat (Shane), and two LOWs (forms for any client; not-found vs forbidden oracle).

**Shane-only, no code (still to do):**
- Revoke the Vercel token leaked in event-toolkit history (`b8310aa`, `.claude/settings.json`). This blocks making the repo public.
- ElevenLabs spend cap (talk4me).
- Rotate or remove the live Anthropic key and Neon credentials in `use-case-support-ticket-deflection/.env.local`.

## Where things are
- Spec (APPROVED v2): `FOUNDATION_SPEC.md`. Plan (APPROVED, M0–M9): `IMPLEMENTATION_PLAN.md`. Both were revised on 2026-09-23 after a Codex review (D-10 to D-12, INV-28, tighter S1–S3), and the revision is approved.
- Portfolio audit baseline for the M9 scorecard: `audit/` (17 reports on the K1–K14 checklist).
- SEC items were appended (uncommitted, for each repo's own session to commit) to:
  - storage, Bookable and rental: `docs/prds/06-backlog.md`
  - Countertop and reservations: `docs/backlog.md`
  - clinic, groundwork and talk4me: `NEXT.md`
  - alongside: `BACKLOG.md`
  - showcall: `docs/backlog.md`
  - event toolkit, design bridge, claude-dashboard and the three use-case repos: `SECURITY_BACKLOG.md`
  - Use-Case Studio: its backlog file
