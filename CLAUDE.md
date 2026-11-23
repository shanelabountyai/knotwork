# Knotwork — working conventions

Wedding planning for one couple and their circle, on saas-foundation v1.7.0. **Synthetic data only; not deployed.**
Spec: `docs/prds/prd-knotwork-wedding.md` (v1.1). Decisions: `docs/knotwork/decisions.md`, which outranks the PRD
where they differ. Current phase plan: `docs/knotwork/PHASE-1-PLAN.md`. Session state: `NEXT.md`. Write-up: `WRITEUP.md`.

## The four build rules (PRD "Build Notes")

1. **All deadlines derive from the anchor.** The wedding date is the only stored deadline. A task stores `leadDays`,
   `bufferDays` and its dependencies; its dates are computed on read by `src/lib/knotwork/schedule/`. No model may gain
   a due-date column (`tests/knotwork/structure.test.ts` scans the schema). A date of fact (paid on, completed on,
   signed on) is not a deadline and may be stored.
2. **Designated actions only through the consent module.** Booking a vendor, signing a contract, spending over the
   threshold, changing the wedding date, changing the consent settings (and, from Phase 2, removing a guest) happen
   only inside `executeApproved` in `src/lib/knotwork/consent/execute.ts`, after a second owner approves. No action
   file writes those fields itself (`tests/knotwork/structure.test.ts` scans for it; the database also checks it).
3. **Guest-facing surfaces never leak wave data.** No Phase 1 surface is guest-facing. From Phase 2, every
   guest-visible response is an explicit projection and is swept by a fixture.
4. **Uploads are hostile input: strip, validate, cap.** Phase 1 accepts no uploads. Nothing that takes a file ships
   without an allowlist, a size cap and metadata stripping, each with a test.

## Foundation rules (the template's, unchanged)

- **Never edit a template-owned path**: `src/core`, `src/modules`, `prisma/schema/core.prisma` and the module schema
  files (one exception: back-relation lines ending `// app`), template migrations, `tests/invariants`,
  `scripts/foundation-*.ts`, the template's settings, login, demo, onboarding and account routes. `npm run
  foundation:drift` must pass. An unavoidable patch goes in `FOUNDATION_PATCHES.md` with a decisions row.
- Knotwork's own code lives in `src/lib/knotwork/` (pure engines and stores), `src/app/o/[org]/wedding/` (routes),
  `prisma/schema/knotwork.prisma`, `tests/knotwork/`, `fixtures/`, `tools/` (Python stdlib oracles) and `scripts/knotwork/`.
- Every page and route handler awaits `requireOrg` first. Every server action is built by `orgAction`, every row id in
  its schema is `ref('<model>')`, and a row from another org is `notFound()` before any other answer (INV-01 to 04).
- Every org-owned table has `orgId`, an RLS policy (`npm run rls:policies`), an entry in `src/app/export-hooks.ts` and
  a harness row in `tests/fixtures/app.ts`. A table with no `orgId` must be named in `GLOBAL_MODELS` (INV-42).
- Reads and writes go through `withOrg(ctx, tx => ...)`. "Now" comes from `src/core/clock.ts`; no bare `new Date()` for
  the current time. Money is integer cents (`src/lib/knotwork/money.ts`); never a float.
- Every write to a Knotwork entity calls `logChange` in the same transaction (`src/lib/knotwork/changelog.ts`).
- Never weaken, skip or delete a test, invariant or gate to get green. If a gate fails, stop and report.
- No deploys, no hosting or account changes, no secrets in commits, no real people, no live email, SMS, payments or
  model calls.

## Local environment

- Port **8400**. Node 22, Postgres 17. `npm ci`, `npm run db:setup`, `npm run seed:demo`, `npm run seed:couple`,
  `npm run dev`, then `/demo`.
- Gate: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run foundation:drift`,
  `npm run foundation:check-modules`, `npm run test:e2e`, `python3 -m pytest tools -q`.
- Migrations are hand-written in Prisma's shape when the schema engine is unavailable; CI's
  `prisma migrate diff --exit-code` step proves they equal `prisma/schema` (D-04).

## Phase discipline

A phase is not done until its fixtures and its demo story pass. No Phase N+1 work while a Phase N gate fails. Record
each judgment call as the next row in `docs/knotwork/decisions.md`; never edit an existing row.
