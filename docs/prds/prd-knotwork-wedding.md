# PRD: Knotwork — Wedding Planning, Engagement Through Name Change

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
