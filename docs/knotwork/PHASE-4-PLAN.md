# Knotwork — Phase 4 plan (P1, in ranked order)

Written 2026-11-24, before any Phase 4 code. Scope is PRD v1.1 Phase 4: **P1-1 to P1-8 in ranked order**, plus the
vendor read-only link Shane placed here (D-42). Shane asked for it in chat on 2026-11-24 ("Merge it start phase 4"),
after PR #4 was merged. Branch `phase-4`, from `main` at a932b6d. Built in four slices, one after another, because
they share the schema, export hooks, harness rows and structure tests. One draft PR at the end.

The four build rules hold for every item. In particular: no new stored deadline (rule 1: reveal dates, "aging" and
name-change steps are derived from the wedding date or from a date of fact); the vendor link and any new
guest-visible text go through a projection (rule 3); the only file-like input is still the upload pipeline (rule 4).

## Slice A: P1-1 secrecy compartments, P1-2 multi-funder family budget

- **P1-1.** A partner may mark a task, an expense, a vendor or a budget category line as *private to me until* a
  reveal point. The reveal point is stored as an offset from the wedding date (days before or after; 0 = the wedding
  day) or "never", so no free-floating date (rule 1). Until then the other partner sees the item only as a masked
  line: a budget amount still counts in every total ("amounts visible in totals, line hidden"); the label, vendor
  name, notes and the line itself are hidden. Helpers see what the other partner sees. The change log hides a
  private entry's before/after from the other partner the same way. A designated action on a private item (booking a
  vendor, a spend over the threshold) cannot be private: it needs the other partner's key, so proposing it reveals it
  (stated in the ADR). **Ships with its own ADR** (`docs/knotwork/adr/ADR-001-secrecy-compartments.md`): problem,
  options, choice, consequences, and the leak paths checked (pages, change log, export, activity feed, vendor briefs,
  dashboard counts).
- **P1-2.** A `Funder` (a parent or relative; not a member, just a named source) pledges against budget categories.
  States per pledge: pledged → received (a date of fact and an amount, may be partial) → spent (allocated to expenses
  in that category). Integer cents. "Contributor-scoped visibility": a funder who is invited as a helper with a new
  `funder` grant sees only the categories they fund, their pledge, what was received and what was spent from it, and
  nothing else of the budget. The budget page shows each category's funding mix.

## Slice B: P1-3 thank-you obligation ledger, P1-8 registry aggregation

- **P1-3.** Builds on Phase 3's `ThankYou` rows (one per giving household when a gift funds) and adds hand-entered
  gifts (the gift log: a household or a named person, what, received on). One obligation per gift and giver:
  received → acknowledged (acknowledged-on is a date of fact). Aging is computed on read from received-on, never
  stored: the headline "14 unthanked > 3 weeks", buckets, oldest first. A note template per obligation (text only;
  nothing is sent).
- **P1-8.** Link-out registry items (store name, URL, price, quantity wanted/claimed) shown alongside pooled items on
  the guest gift page and the couple's registry. The URL is validated (https only, no credentials, length cap) and
  rendered with `rel="noopener noreferrer nofollow"`. A guest may mark "I bought this" through their household link
  (claims count, the couple sees which household claimed — names, as for pooled gifts); a claim feeds P1-3 as a gift.
  Nothing is fetched from the store (no scraping, no live calls).

## Slice C: P1-4 name-change sequence, P1-6 contingency decision trees

- **P1-4.** Rules as data (`rules/name-change/*.json`): an ordered workflow per jurisdiction (federal steps, then
  state DMV, passport, then accounts), each step with prerequisites and the artifacts it needs ("certified marriage
  certificate", "new Social Security card"). A step can be started only when its prerequisite steps are done and its
  artifacts are marked held (gating). Steps carry no dates; "start after the wedding" offsets come from the wedding
  date. Illustrative content only, labelled as such and not legal advice; two or three US states plus a generic
  fallback. Per partner, private to that partner unless shared. A Python oracle checks the ordering and gating.
- **P1-6.** A contingency plan is a small decision tree (rain plan, vendor no-show, late arrival): a question node
  with branches, leaves that are actions (a checklist, a vendor to call, a task to add). `createPlan`, `previewBranch`
  (what would change: tasks added, vendors to notify) and `executeBranch` (one transaction, logged; adding tasks goes
  through the scheduler so dates derive from the anchor). Showcall's engine is a reference this run cannot read (repo
  scope), so the shape is rebuilt from the PRD text. Executing a branch that touches a designated action proposes it
  through consent; it never executes it.

## Slice D: P1-5 seating chart, P1-7 progress dashboard, vendor read-only link (D-42)

- **P1-5.** Tables with capacities; constraint pairs (keep apart, seat together) between guests; households kept
  together by default. Generate (greedy draft, seeded PRNG so results are reproducible) → score (hard violations,
  soft preferences) → repair (bounded local search). Bracketry's code is a reference this run cannot read, so the
  generate-score-repair shape is rebuilt. Only attending (or still pending, by choice) guests are seated. Manual moves
  and locks; a regenerate keeps locked seats. Fixtures with known optimal or known-infeasible cases and a Python oracle
  that scores a seating independently.
- **P1-7.** One page: percent of tasks on track (from the scheduler), overdue tasks, unacknowledged vendor flags,
  headcount against cap, pending approvals, budget spent vs estimate, unthanked gifts and their aging. Every figure
  is read from the existing engines (no new stored state) and respects secrecy (P1-1: a masked item counts in totals,
  shows no label).
- **Vendor read-only link (D-42).** A tokenized link per vendor (hash only, sealed copy, replaceable, the PRD v1.1
  house rules), showing that vendor's brief only (the Phase 1/2 brief, role-filtered: the DJ gets the do-not-play list
  and song requests, the caterer gets counts) through a projection, never names of guests where the brief has counts.
  Expiry derived from the wedding date (a set number of days after). A third entry on the closed list of public routes.

## Acceptance (PRD text) and the test for each

| # | PRD item | Test |
|---|---|---|
| 1 | P1-1 per-item visibility between owners, reveal points; category masking (totals include, line hidden); its own ADR | `secrecy-db`, `secrecy-pure`, structure leak scan; ADR file |
| 2 | P1-2 pledges against categories; pledged/received/spent; contributor-scoped visibility | `funders-db`, `funders-pure` |
| 3 | P1-3 gift → giver → acknowledged, aging ("N unthanked > 3 weeks") | `thanks-db`, `thanks-pure` |
| 4 | P1-4 ordered workflow, rules as data, artifacts gating steps, jurisdiction-aware | `namechange-pure` + oracle |
| 5 | P1-5 generate-score-repair, keep-apart / seat-together, capacities | `seating-pure` + fixtures + oracle, `seating-db` |
| 6 | P1-6 decision trees: create, preview branch, execute branch | `contingency-pure`, `contingency-db` |
| 7 | P1-7 % on track, overdue, unacknowledged flags, headcount vs cap | `dashboard-db`, e2e |
| 8 | P1-8 link-out items alongside pooled items | `registry-links-db`, `gifts-db` sweep |
| 9 | D-42 vendor read-only link | `vendor-link-db`, structure route list, e2e |
