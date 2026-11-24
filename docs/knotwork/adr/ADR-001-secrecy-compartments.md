# ADR-001: Secrecy compartments (PRD P1-1)

Status: accepted (Phase 4, slice A, 2026-11-24). Decisions D-93 to D-105 in `docs/knotwork/decisions.md` record each
judgment call; this file is the argument and the list of leak paths that were checked.

## Problem

PRD P1-1: "Per-item visibility between owners, with reveal points; category masking (amounts visible in totals, line
hidden)." A partner planning a surprise (a gift, a vendor, a honeymoon upgrade) needs a task, a spend, a vendor or a
whole budget category the other partner cannot see until a chosen moment, while the shared plan still works: the
budget totals are the real totals, the schedule still has the task's deadline, and nothing designated (rule 2) can
happen behind the other partner's back.

Constraints that shape the answer:

- **Rule 1.** No free-floating date. A reveal point is a deadline-shaped thing, so it is stored as an offset in whole
  days from the wedding date, or "never" (D-92), and worked out on every read. It moves with the wedding.
- **Rule 2.** A designated action needs the other partner's key, and the approver must see what they approve.
- **The change log is append-only and exported whole** (the template's audit log, INV-19, INV-34). Anything written
  into it about a secret is there forever, readable by both partners on Settings → Audit log, in its CSV, and in the
  data export. Either partner can download the export (both are owners).
- **Helpers** see what the other partner sees (plan, P1-1). In solo mode (D-33) there is no other partner yet.

## Options

1. **Per-item columns** on the four item tables (`privateToId`, `revealDays`), masked on read by one function.
2. **A separate compartment table** (entity, id, owner, reveal) joined on read.
3. **Encrypt** the label and notes of a private item with a key only its owner holds.
4. **Filter, don't mask**: a private item is simply left out of the other partner's views.

(4) breaks the PRD's own requirement (amounts visible in totals) and the schedule (a task's deadline still binds the
plan). (3) protects the database at rest but not what the app itself renders, needs key management the template does
not have, and still needs (1) or (2) to decide what to show. (2) makes every read a join keyed by a string entity
name and cannot carry database checks on the rows it describes. (1) keeps the compartment on the row, so the database
can refuse what may never be private (a booked vendor, a spend that went through consent) and who may own one.

## Choice

**Option 1, with one masking function, masking at write for what is stored and shared, and masking at read for
everything a person is shown.**

- `Task`, `Expense`, `Vendor` and `BudgetCategory` gain `privateToId` (a partner's user id) and `revealDays` (whole days
  after the wedding date; negative before; 0 the wedding day; null with an owner means "until revealed by hand").
  Nothing else in the schema changed for P1-1; `tests/knotwork/structure.test.ts` pins that it is exactly these four
  tables and that no date column was added.
- `src/lib/knotwork/secrecy/compartment.ts` (pure) holds the rules. An item is **sealed** while its owner is still a
  partner and today (in the wedding's time zone) is before the reveal day. It is **hidden** from a viewer when any
  compartment it sits in is sealed and is not the viewer's own. It sits in its own compartment and inherits others:
  a payment task from its vendor; an expense from its category and its vendor; a vendor payment, flag, brief or
  attachment from its vendor; a pledge (P1-2) from its category; a payment from a pledge from its spend.
- `src/lib/knotwork/secrecy/lens.ts` (pure) is **the** masking function: `lens(seen)`. A hidden item comes out as a
  masked line `{ hidden: true, kind, label: 'Private task' | 'Private spend' | 'Private vendor' | 'Private category',
  owner, revealsOn }`: whose it is and when it shows, nothing of the row. It is the only file that makes a masked line
  (structure test). Totals are computed from the rows before they are masked, so a hidden amount counts in every total.
- `src/lib/knotwork/secrecy/views.ts` is the only reader the signed-in pages have for those tables (structure test: no
  page or route under `/o/[org]` reads them, the schedule, the budget or the change log itself). Each loader builds its
  answer with `lens(seen)` for the person asking. Funding has its own reader, `fundingView`, which uses the same lens.
- `src/lib/knotwork/changelog.ts` asks `sealedNow` before every entry: an entry about a sealed item is written as
  "a private item", who, when, and the names of the fields that changed; no label, before, after or extras.
- What is stored and shared (a budget snapshot's lines, a baseline's task titles, a vendor brief's task list) and the
  data export are built with the lens for **nobody**: every sealed item is blanked, whoever owns it.
- A ref to a hidden item in any action or route is `notFound()`, exactly like a row of another workspace (INV-04's
  rule, applied to secrecy).
- **Reveal**: automatic when the reveal day comes (derived; nothing is written), or early by the owner (privacy set
  back to "Shared", logged `revealed` with the label, since it is now shared).
- **Designated actions cannot stay private.** Proposing to book a vendor, sign its contract, or spend over the threshold
  first reveals every private item the request names (the vendor; the category; the spend itself cannot be private at
  all and is refused). The reveal is logged `revealed` with `why: proposed`, then the request is written. An item ever
  named in a request (any status) cannot be made private again: its name is on the approvals page for good. The
  database refuses a private vendor that is booked or signed and a private expense with a request
  (`Vendor_designated_shared_check`, `Expense_designated_shared_check`), and an owner who is not a partner
  (`*_private_owner` triggers). This holds in solo mode too (D-97): the request stays on the approvals page for the
  partner who joins later.
- **Who may keep a secret**: a partner only. **From whom**: the other partner and every helper, whatever their grants
  (helpers see what the other partner sees), including a helper linked to a funder (P1-2). **Solo mode** (D-97): with
  one partner the helpers are the others; when the second partner joins, the first partner's secrets stay private to
  her (pairing reveals nothing). An owner who stops being a partner holds no secret (D-96): the item is shared.

## Consequences

- The other partner always knows that something private exists, whose it is and when it reveals itself, because the
  masked line is there. That is the design (the PRD's "line hidden, amount in totals"), not a leak.
- **Arithmetic.** With one hidden budget line, the total minus the visible lines is that line's amount; per-line
  amounts are not shown, but they cannot be hidden from subtraction (as D-70 for gifts). Accepted; open for Shane.
- **History written while an item was shared stays.** The log is append-only. Marking an existing item private hides
  its earlier entries on the Activity page, but Settings → Audit log, its CSV and the export still hold what was
  written before (it was shared then, and both partners could already read it). The forms offer "Private to me" at
  creation, which is how to keep a surprise from the start. The owner's own history of a secret is also "a private
  item" in the log: the details were never written.
- **The export carries no unrevealed secret, even for its owner** (D-100). Ids, amounts and dates of fact stay, so its
  totals still add up.
- **Name probing.** Category names are unique per workspace; adding a category with exactly the name of a private one
  is refused, which tells the other partner that name exists (D-98). The refusal no longer echoes the name.
- Every log write about a task, expense, vendor, category, payment, flag, brief, attachment, pledge, receipt or payment
  from a pledge costs one extra lookup (and two more only when some compartment is set). A deletion is logged before
  the row goes, so its privacy can still be read.
- A partner editing a shared task that waits for a hidden one keeps that dependency (it is not on their form, so it is
  merged back), and a plan refusal that would name a hidden task names "Private task".

## Leak paths checked

Each is covered by `tests/knotwork/secrecy-db.test.ts` (the sweep renders every page as Rowan, as a helper with every
grant and as a helper linked to a funder, and asserts the marker never appears; Juniper sees all of it, so the sweep is
not blind), `secrecy-pure.test.ts`, `funders-db.test.ts`, the structure tests, or `e2e/secrecy.spec.ts`.

| Path | What could leak | How it is closed |
|---|---|---|
| Workspace home (`/o/[org]`) | task counts, open vendor flags | counts include hidden tasks unnamed; flags through `flagsView` (flags exist only on booked vendors, which are never private) |
| Schedule | title, assignee, dependencies, critical path, the edit form, "comes after" options | masked line keeps derived dates and state only; titles via `lens.titles`; hidden tasks not offered; `?edit=` of a hidden task shows nothing |
| Budget | category name and figures, spend description, vendor name, category of a spend, the forms' category and vendor lists, funding mix | masked lines with no figures; totals real; a note counts private lines; hidden options not offered; funding mix only on shown lines |
| Funding page | pledge toward a private category, payment toward a private spend, other funders (for a funder helper) | `fundingView`: scoped per viewer, masked per line |
| Vendor book and vendor page | name, category, contact, notes, deliverables, payments, brief, attachments | masked line in the book; the page is a 404 |
| Attachment routes (view and add) | image bytes, adding to a hidden vendor | `attachmentFile` and `vendorVisible`: 404 |
| Vendor flags | vendor name | through the lens (and only booked vendors are flagged) |
| Approvals | a request's summary; the date-move preview lists every task | proposing reveals what the request names; the preview's titles masked (`movePreview`) |
| Date page | the move preview | `movePreview` |
| Activity feed | label, before, after of entries about hidden items, including entries written before an item became private | masked at write (`changelog.ts`) and again at read (`activityView`, compartments looked up per entry) |
| Settings → Audit log and its CSV (template pages) | the same entries | masked at write; swept |
| Data export | every item table, baselines, snapshots, payments, briefs, attachments, the audit log | built for nobody (`secrecy/export.ts`); the audit log masked at write |
| Vendor briefs | a private task linked to a shared vendor; a private vendor's own brief | the task list excludes sealed tasks (written for nobody); a private vendor's brief is on a 404 page and blanked in the export |
| Budget snapshots, schedule baselines | category lines, task titles frozen into JSON | written for nobody; the export re-masks older ones |
| Refusals | a plan cycle message lists task titles; "there is already a category called X" | titles via the lens; the category message no longer echoes the name (D-98) |
| Action refs | an id of a hidden item posted to any action or route | `notFound()`, like another workspace's row |
| Helpers page | — | lists people and grants only |
| Guests, gifts, photos pages | — | no task, expense, vendor or category is read there (swept anyway) |
| Counts | open tasks, late, impossible, "N private lines" | allowed: the masked line already says the item exists |
| Designated actions | booking, signing, a large spend kept secret | revealed on proposal; refused for a large private spend; database checks |
| Name probing | a duplicate category name | accepted, recorded (D-98) |
| Arithmetic | total minus visible lines | accepted, recorded (D-94) |
