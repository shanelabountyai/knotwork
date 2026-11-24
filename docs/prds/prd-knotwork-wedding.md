# PRD: Knotwork — Wedding Planning, Engagement Through Name Change

> **v1.1 (2026-11-23).** v1.0 (2026-09-25) is kept below, unchanged. v1.1 adds only the section that follows: where each
> "house pattern" and "reuse" line lands in real code, the stack, the port and the status. Product scope, P0/P1
> membership and the four phase gates are as v1.0 wrote them.

## v1.1 changes (2026-11-23)

Written by Claude in an unattended run that Shane asked for on 2026-11-23. Judgment calls are rows in
`docs/knotwork/decisions.md`; open product questions are under "Questions for Shane" at the end of this section and are
not decided here.

### Status, stack, port

- **Not deployed. Synthetic data only; no real people.** No hosting, database or account was created or changed. Email
  and SMS stay stubbed (captured in the database), money is mock and ledgered, and no model is called.
- **Stack:** saas-foundation **v1.7.0** (`FOUNDATION_VERSION`), merged with shared history so later `git merge vX.Y.Z`
  stays clean. Next.js 16, React 19, Prisma 7, Postgres 17, zod 4, vitest 5, Playwright (versions in `package.json`).
  The `billing` module is removed (decisions D-03); `notifications`, `sso` and `apikeys` are still installed.
- **Port 8400** (`package.json`, `playwright.config.ts`, `.github/workflows/ci.yml`). It was free in the template's
  `CLONES.md` on 2026-11-23.
- **Build status:** Phase 1 is built on branch `kickoff` (see `NEXT.md` for the gate results). Phases 2 to 4 are not started.

### House patterns → saas-foundation v1.7.0

Paths are in this repo after the merge. "Template-owned" means `npm run foundation:drift` fails if the file is edited.

| PRD says | Used by | Real module or seam (v1.7.0) | Notes |
|---|---|---|---|
| RBAC house module; scoped helper grants | P0-2 | `src/core/authz/permissions.ts` (`Role`, `can`, `mayAssign`), `src/core/authz/guards.ts` (`requireOrg`, `inOrg`), `src/core/authz/action.ts` (`orgAction`, `ref`) | Roles are a fixed enum (`owner`, `admin`, `member`, `scorekeeper` in `prisma/schema/core.prisma`), template-owned. The two partners are the workspace's two `owner` memberships. The template has **no scoped grants**, so helper scopes are a clone table (`HelperGrant`) checked in `src/lib/knotwork/access.ts`: pattern rebuilt here (D-08). |
| Audit-log house pattern → activity feed | P0-2 | `src/core/audit.ts` (`audit`, `auditEvents`), model `AuditEvent` in `prisma/schema/core.prisma`, append-only by database trigger (`tests/invariants/inv-19-audit-append-only.test.ts`), raw viewer at `src/app/o/[org]/settings/audit/` | The change log writes through `audit()` with `{ before, after }` in `data` (`src/lib/knotwork/changelog.ts`); the feed is a consumer rendering of the same rows (D-15). |
| Outbox stubs (no real SMS/email) | Non-goals, P0-3 chasing | `src/modules/notifications/outbox.ts` (`enqueue`, `drainOutbox`), `src/modules/notifications/templates.ts`, `src/modules/notifications/sms.ts`, `src/core/email/transport.ts` (captures to `CapturedMessage` when no provider key is set) | Phase 1 sends nothing. Phase 2 chasing enqueues here. |
| Tokenized links (RSVP, photo upload) | P0-3, P0-6 | `src/core/tokens.ts` (`newToken`, `hashToken`; only the sha256 is stored, INV-07), `src/core/share/links.ts` (`ShareLink`, expiry required, INV-08), public page `src/app/s/[token]/` | The `shareable` registry lives in template-owned `src/core/share/links.ts`, so guest links will be a clone table built on `tokens.ts` with the same rules (hash only, expiry, revoke). Phase 2 and 3; not built. |
| Import house pattern (guest CSV) | P0-3 | none in v1.7.0 (the template has CSV export only: `toCsv` in `src/core/audit.ts`) | **Pattern only, rebuilt here** in Phase 2: validate, preview, then write. The library's import pipeline lives in another clone that this run did not read. |
| Demo gate | status | `src/core/demo-gate.ts` (`gate`, `gateResponse`), `src/core/auth/demo.ts`, `src/app/(public)/demo/`, `scripts/seed-demo.ts` | Not deployed, so no `src/proxy.ts` gate is wired. `/demo` works locally with `DEMO_MODE=1`. |
| Export hooks | every org table | `src/app/export-hooks.ts` (`exportTables`, `exportSkipped`), `src/core/tenancy/export.ts`, `tests/invariants/inv-34-export.test.ts` | Every Phase 1 table is listed in `exportTables`. |
| RLS | every org table | `src/core/db/rls.ts` (`withOrg`, `asSystem`), `scripts/rls-policies.ts` (`npm run rls:policies`), `tests/invariants/inv-29-33-rls.test.ts`, `tests/invariants/inv-42-org-scope.test.ts`, harness rows in `tests/fixtures/app.ts` | Every Phase 1 table has `orgId`, a generated policy and a harness row. RLS stays off at runtime unless `RLS_MODE=enforce` (the template's default). |
| Data-minimization house pattern (counts, never names) | P0-3 | no module; the nearest seam is the allowlisted projection in `src/core/share/project.ts` | **Pattern only, rebuilt here** in Phase 2, with a sweep test. |
| House entitlement/ledger pattern | P0-5 | none in this clone (the template's only money code was `billing`, removed) | **Pattern only, rebuilt here** in Phase 3 as an append-only ledger in integer cents. |
| Polling (house rule) | P0-6 wall | no module | **Pattern only** (plain interval fetch), Phase 3. |
| "Mock/house convention" for payments | Non-goals | no module | Phase 1 records payments as rows the couple marks paid; nothing is charged. |
| Server "now" | scheduler | `src/core/clock.ts` (`now`, `advanceClock`) | The only clock the scheduler and consent expiry read. |
| Cron | consent expiry | `src/core/cron.ts`, `src/app/api/cron/route.ts`, clone-owned `src/app/cron-jobs.ts` | Expiry is also checked on every read and transition, so cron is a sweep, not the gate. |

### Reuse lines → real code

Read on 2026-11-23 from public clones, read-only. Showcall is not a saas-foundation clone (its own `src/db.ts`, no orgs,
no RLS), so nothing from it can be imported as is.

| PRD line | Source read | Verdict |
|---|---|---|
| P0-1 "previewed cascade (Groundwork's preview pattern)" | Groundwork was not read in this run. The same pattern is in showcall `src/runsheet/cascade.ts` (`previewCascade`, `commitCascade`: a preview is the commit rolled back; the commit refuses unless it moves exactly what the preview showed) and `src/runsheet/cues.ts` (`resolveCues`, `diffTimings`) at d484826 | **Pattern only, rebuilt here** in `src/lib/knotwork/schedule/`. Showcall resolves minute-of-day cues against agenda sessions; Knotwork resolves whole days backward from one date, and needs `withOrg`. The commit-must-match-preview rule is kept. |
| P0-1 anchor/cascade scheduling | showcall `src/runsheet/cues.ts` | Pattern only, as above. |
| P0-7 "integer cents" | showcall `src/money.ts` (`usd`, `parseCents`, 8 lines) | **Reused**: copied into `src/lib/knotwork/money.ts` with the source noted. |
| P0-7 "vendor briefs (call-sheet-style, role-filtered)" | showcall `src/callsheet/callsheet.ts` (`projectCallSheet`, `diffCallSheets`) | **Pattern only, rebuilt here**: a brief is an explicit per-category projection, regenerated when its inputs change. No PDF in Phase 1. |
| P0-3 "RSVP chasing: reminder cadence" | showcall `src/chase/chase.ts` (`CADENCE`, `cadenceStep`) | Candidate for Phase 2; not built. |
| P0-6 "per-device rate limits (Commons' pattern)" | commons branch `foundation/v1.7.0` at 36fe554: `rules/limits.json`, `src/limits/index.ts`, `src/forum/limits-store.ts`, `tools/limitslib.py`, `fixtures/expected_limits.csv`; primitive `src/core/rate-limit.ts` (`hit`, `LIMITS`) is in the template | Candidate for Phase 3 (limits as data plus a Python oracle); not built. Commons' default branch holds only its kickoff kit. |
| P1-5 "Bracketry's generate-score-repair" | bracketry `src/lib/league/schedule.ts` (`greedyDraft`, `scoreSchedule`, `repair`, `generateSchedule`), `src/lib/league/quality.ts`, `src/lib/league/prng.ts` at 1c6d632 | P1 only; not built. |
| P1-6 "Showcall's engine reused consumer-side" | showcall `src/contingency/contingency.ts` (`createPlan`, `previewBranch`, `executeBranch`) | P1 only; not built. |
| P0-3 "Adjuster's pattern", P0-5 "Quorum's separation discipline", P1-4 "Coursework's gating", Non-goals "Tradepost's lesson" | not read in this run (not on the list of repos to read) | **Pattern only**; to be mapped when their phase starts. |

### What Phase 1 delivers against v1.0

Phase 1 is P0-1, P0-7 and P0-2 as written. Two parts of P0-7 are cut down in this build and listed as "not done" in
`NEXT.md`: contract **attachments** (needs a storage decision, see Questions) and brief content that depends on the
guest engine (counts, do-not-play list), which is Phase 2 data.

### Questions for Shane

Each has a default in force so the build could proceed; the default is a row in `docs/knotwork/decisions.md`.

1. **Solo partner.** Until the second partner joins, nothing designated can execute (D-13). Should a solo owner be
   able to book and spend alone until then, with those actions marked "solo" in the feed?
2. **Second factor.** The template requires TOTP for every `owner`, so both partners must enrol an authenticator app
   before they can use the workspace. Is that acceptable for a consumer product, or should Knotwork ask the template
   for a role that owns without MFA?
3. **Impossible tasks on a date move.** The preview names them and the commit goes ahead (D-10). Should a move that
   makes anything impossible be refused instead, the way Showcall refuses a run sheet with problems?
4. **Spend threshold and expiry defaults.** $500.00 and 7 days (D-14). What should they be?
5. **Changing the rules takes two keys.** The spend threshold and expiry can only change through a consent request
   (D-12). Should single classes (for example "book vendor") be switchable off, and by whom?
6. **Contract attachments.** Where do files live: a database column with a size cap, or a blob store? Nothing is built
   until this is decided (D-17).
7. **Who is a helper.** Every non-owner role is a helper with scoped grants; the template's `admin` role still reaches
   the template's own settings pages (D-08). Should Knotwork hide `admin` at invite time?
8. **Which vendors get flags.** Only booked vendors are flagged for re-confirmation (D-16). Should vendors still being
   considered be flagged too?
9. **Vendor access.** Briefs are read and printed by the couple in Phase 1. Should vendors get a tokenized read-only
   link (a clone table on `src/core/tokens.ts`), and in which phase?
10. **Default task template.** The lead times in `src/lib/knotwork/schedule/template.ts` are illustrative defaults,
    not sourced figures (D-20). Do you want them reviewed by the wedding-planner persona before anyone sees them?

---

**Sample business:** "Knotwork," a consumer wedding-planning app for one couple + their circle
**Status:** Draft v1.0 — written with PM + wedding-planner review AND a bride-persona deep review baked in (tags: *planner review*, *bride review*)
**Scope stance:** deliberately the largest consumer project in the library (six net-new artifacts). Built in shippable phases — every phase gate is a working product.
**Learning objectives:** backward scheduling from a movable anchor, two-peer shared accounts (dual-consent, change auditing), household-unit/individual-response RSVP with rules-engine entitlements, tiered invite backfill, pooled group gifting, media upload pipeline with live moderated display

---

## Problem Statement

A wedding is a 14-month project run by two untrained project managers, funded by committee, executed by a dozen vendors, and attended by the most socially sensitive audience they'll ever assemble. Every date derives backward from one movable anchor; every decision belongs to two equal owners; every guest is a household that answers as individuals. Generic tools model none of that — which is why couples run weddings on spreadsheets and group texts.

## Goals

1. Every deadline in the plan derives from the wedding date and vendor lead times; moving the date re-baselines the plan with a previewed cascade.
2. Both partners are equal owners: designated decisions require both, and every change by anyone is logged and vendor-flagged.
3. The guest list runs the wedding: household invites, individual responses, plus-one entitlements by rule, tiered backfill that guests can never detect, and RSVP chasing that feeds real vendor deadlines and costs.
4. Guests contribute photos through a QR to a live, moderated social wall.
5. **(Builder goal)** The six artifacts above — peer-shared ownership and anchor-derived scheduling being the two nothing else in the library models.

## Non-Goals

- Vendor marketplace/discovery (Tradepost's lesson; vendors here are the couple's own book)
- Payments processing (mock/house convention; registry links out for purchases — group gifting pools are ledgered, not charged)
- Wedding-website builder beyond a functional RSVP + info page (design tooling is out)
- Real SMS/email delivery (outbox stubs), native apps (responsive web; the wall and upload flows are mobile-first)
- AI moderation of photos (human-only v1; classifier assist is a named seam)

## Personas

Partner A + Partner B (equal owners) · Helper (parent/planner/MOH — scoped permissions) · Guest (tokenized links only: RSVP, photo upload) · Vendor (receives call-sheet-style briefs; no login).

## Requirements — Must-Have (P0)

**P0-1: Backward scheduler** *(core artifact #1)*
Task templates with dependencies and lead times anchor to the wedding date ("alterations need 3 months, so dress ordered by month-8"); critical path computed and rendered.
- [ ] Date move → full re-baseline with a previewed cascade (Groundwork's preview pattern): what shifts, what's now late, what's now impossible (lead time exceeds runway) — commit is atomic
- [ ] Vendor payment schedules (deposits, balances-due) enter as scheduled tasks; **RSVP deadline derives from the earliest vendor-count deadline minus chase-buffer** *(bride review #2 — deadlines connect or brides keep spreadsheets)*
- [ ] Tasks: assignee (either partner/helper), status, overdue states; manual tasks insert with dependencies
- [ ] Fixtures: cascade correctness, critical-path identification, impossible-runway detection

**P0-2: Two-peer ownership — dual-consent + change log** *(core artifact #2)*
One shared workspace, two equal owners. Designated action classes (book vendor, sign contract, spend > $X, change date, guest-list removals) require both partners' approval before executing; everything else is open but audited.
- [ ] Consent requests: propose → partner approves/declines/expires; the action executes only on approval (two-key pattern); thresholds configurable
- [ ] **Universal change log** *(bride review #4)*: who/what/when/before-after on every entity (audit-log house pattern, consumer-rendered as an activity feed)
- [ ] **Vendor re-confirmation flags** *(bride review #4)*: any change touching a vendor's scope (counts, times, deliverables) flips that vendor to "needs re-confirmation" until marked acknowledged; unacknowledged flags surface on the dashboard and the vendor's brief
- [ ] Helper permissions are scoped grants (guest-list-only, budget-view-only) through the RBAC house module

**P0-3: Guest engine — households, RSVP, rules, chasing, headcount** *(core artifact #3)*
Households as the invitation unit (addresses, save-the-date/invite states); individuals as the response unit (attending, meal choice, song request, dietary/accessibility needs).
- [ ] **Plus-one rules engine** (Adjuster's pattern on etiquette): entitlements by rule (engaged/married/long-distance/bridal-party = plus-one), per-household overrides logged
- [ ] **RSVP chasing** *(bride review #2)*: reminder cadence for non-responders (outbox), escalating to a "call personally" worklist as the derived deadline approaches; response-rate tracking
- [ ] **Live headcount → cost link** *(bride review #3)*: attending count vs. venue min/max, per-head cost recalc on every response, delta feed ("Linda declined: −$87")
- [ ] **Vendor meals + kids' meals** *(bride review #5)*: separate count lines (vendor meals from the vendor book's on-site flags; kids from guest ages) rolled into caterer counts
- [ ] Dietary/accessibility rollups render vendor-facing as counts, never names (data-minimization house pattern)
- [ ] Guest import via validated CSV (import house pattern); RSVP via tokenized links
- [ ] **Do-not-play list** *(bride review #6)* rides song requests onto the DJ brief

**P0-4: Tiered backfill (A/B lists)** *(core artifact #4)*
Invite waves against a headcount cap: declines free seats that queue B-list invitations, gated by etiquette rules (no B-wave inside N weeks of the wedding; batch releases, not one-by-one drips).
- [ ] **Undetectability invariant** *(bride review #1)*: no guest-facing surface (RSVP page, website, links, timestamps in URLs) reveals wave membership or invite dates — asserted by a fixture sweep of every guest-visible response
- [ ] Cap math: released invites + accepted ≤ cap with pending-invite accounting (the overbooking fixture); wave promotion is atomic
- [ ] Inside-N-weeks lockout converts remaining B-list to "regrets" state cleanly

**P0-5: Group gifting** *(core artifact #5)*
Registry items poolable by multiple givers: partial contributions toward a target, fully-funded trigger, refund-on-unfunded at close (mock money, ledgered — house entitlement/ledger pattern).
- [ ] Contribution privacy: couple sees progress + contributor names, never individual amounts; contributors see only their own (structural test, Quorum's separation discipline scaled down)
- [ ] Over-contribution at the race (two givers completing the pot simultaneously) resolves to exactly-funded + clean excess handling (fixture)
- [ ] Thank-you feed: funded items emit obligations into P1-3's ledger

**P0-6: Photo wall** *(core artifact #6 — the media pipeline)*
Per-event QR → tokenized upload (no account): camera/gallery, optional name + caption; **EXIF/GPS stripped on ingest**; format allowlist, size caps; pipeline job generates thumbnail + display renditions.
- [ ] Live wall: projector-safe dark theme, polling (house rule), newest-first with rotation, corner QR recruiting contributors
- [ ] **Moderation console** (per-event mode): pre-moderation (approval queue before display) or post-moderation (live + remove-on-sight, default); takedown pulls wall + gallery instantly with undo; device-token blocking; per-device rate limits (Commons' pattern)
- [ ] After: couple's full-gallery download; per-photo hide from wall vs. album independently; retention expiry job
- [ ] Fixtures: strip verification, moderation state machine, rate-limit suite

**P0-7: Budget + vendor book** *(supporting, reuse)*
Categories, estimates vs. actuals (integer cents, snapshots), vendor contacts + contracts (attachments) + payment status feeding P0-1; vendor briefs (call-sheet-style, role-filtered: DJ gets DNP list + timeline slice, caterer gets counts) generated as regenerable artifacts.

## Nice-to-Have (P1)

- **P1-1:** Secrecy compartments — per-item visibility between the two owners with reveal dates (surprises, bachelor/ette); the shared-finance tension resolved by category-masking (amounts visible in totals, line hidden) — ships with its own ADR
- **P1-2:** Multi-funder family budget — parents pledge against categories, pledged/received/spent states, contributor-scoped visibility *(planner review)*
- **P1-3:** Thank-you obligation ledger — gift → giver → acknowledged, with aging ("14 unthanked >3 weeks") *(bride-adjacent; feeds from P0-5 and gift log)*
- **P1-4:** Name-change sequence — jurisdiction-aware ordered workflow (SSA → DMV → passport → accounts), rules as data, artifacts gating steps (Coursework's gating + Adjuster's rules composed)
- **P1-5:** Seating chart — Bracketry's generate-score-repair against keep-apart/seat-together constraint pairs and table capacities
- **P1-6:** Contingency decision trees (rain plan) — Showcall's engine reused consumer-side *(bride review #7)*
- **P1-7:** Progress dashboard — % on track, overdue items, unacknowledged vendor flags, headcount vs. cap *(bride review #8)*
- **P1-8:** Registry aggregation across stores (link-out items alongside pooled items)

## Future Considerations (P2)

Photo classifier-assist seam · date-move insurance info page · anniversary rollover into a couples' life-admin mode · real delivery providers (productionize pass).

## Success Metrics (seeded)

- Scheduler: cascade, critical-path, impossible-runway fixtures 100%; a scripted date move re-baselines with zero orphaned tasks
- Consent + audit: designated actions never execute single-signed (API-level test); change log complete against a scripted edit session; vendor flags raised on 100% of scope-touching fixtures
- Guest engine: plus-one rules fixtures; headcount/cost recalc matches hand math; chase worklist matches the derived deadline
- Backfill: undetectability sweep clean; cap accounting exact under the race fixture
- Gifting: privacy structural test clean; funding race resolves exactly
- Wall: strip verification, moderation transitions, rate limits — all clean; load fixture (200 uploads in 10 min) renders without loss
- Capstone demo: date moves 6 weeks → cascade preview → commit; a decline triggers B-list release + cost delta; a guest scans the QR and their photo hits the moderated wall — three stories, five minutes

## Phasing — each gate ships

- **Phase 1 (usable planner):** P0-1 scheduler + P0-7 budget/vendor book + P0-2 ownership/consent/log
- **Phase 2 (guest machine):** P0-3 guest engine + P0-4 backfill
- **Phase 3 (the delighters):** P0-5 gifting + P0-6 photo wall
- **Phase 4:** P1 in ranked order (1→8)
Rule: a phase isn't done until its fixtures and demo story pass; no Phase-N+1 work while Phase-N gates fail.

## Build Notes for Claude Code

CLAUDE.md: house conventions + **all deadlines derive from the anchor (no free-floating dates)**, **designated actions only via the consent module**, **guest-facing surfaces never leak wave data**, **uploads are hostile input (strip, validate, cap)**. TDD order: scheduler cascade → consent gating → undetectability sweep → strip pipeline. WRITEUP.md angle: peer-shared ownership — the two-key consumer account — is the headline claim; the phase-gate discipline is the meta-story for a six-artifact project that shipped.
