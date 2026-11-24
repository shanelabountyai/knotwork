# Knotwork — write-up

**Headline: the two-key consumer account.** Most shared accounts are one owner plus guests. A wedding has two owners
who are equals, and the expensive mistakes are the ones one of them makes alone: a vendor booked, a contract signed, a
large spend, the date moved. Knotwork makes those actions need both partners, and logs everything else.

Status on 2026-11-23: Phase 1 of 4 built on branch `kickoff` (gate results in `NEXT.md`), not merged, not deployed, synthetic data only. Entries
are added as each artifact lands. Every number in this file comes from a file in the repo or a command that was run;
none is a benchmark or a user result, because there are no users.

## Peer-shared ownership: dual consent (P0-2)

**Problem.** A normal account has one owner who can do anything. Give both partners that role and either can spend the
budget or move the date without the other knowing until the vendor calls.

**What it does.** Six classes of action are *designated*: book a vendor, sign a contract, spend over the threshold,
change the date, change the consent settings, and (from Phase 2) remove a guest. A partner *proposes* one; it is stored
as a request with its exact payload. Nothing changes until the other partner approves. Approval and the change happen
in one database transaction, so there is no approved-but-not-done state to get stuck in. A request can be declined,
withdrawn by its proposer, or expire.

**Why it holds.** Three layers, each tested:

1. One function, `executeApproved`, is the only code that writes a designated field. A test scans the source for any
   other writer.
2. The database refuses the shortcut, past all application code: triggers reject a booked or signed vendor, a moved
   date, changed rules or an over-threshold expense unless the row names an approved request of the right kind for
   that very thing, and a CHECK rejects a request whose approver is its proposer. The tests run raw SQL to prove it.
3. Every designated action is attacked at the action layer as a single partner; the test asserts no row changed.

The spend threshold is itself two-key. Otherwise one partner raises it and the claim is empty.

**What it deliberately does not do.** It does not stop a partner outside the app.

**Solo mode (owner decision, 2026-11-24).** A couple rarely signs up together. Until a second partner has ever been
in the workspace, the first one's designated actions go through at once and are marked "solo" in the feed. The first
time two partners are seen the workspace is paired for good: removing your partner does not bring solo back. So the
two-key claim is exact for paired workspaces and deliberately absent before pairing.

## Anchor-derived scheduling (P0-1)

**Problem.** Every wedding deadline is "N weeks before the date". Spreadsheets store the computed dates, so moving the
wedding means retyping all of them, and the one that is missed is the one that matters.

**What it does.** A task stores how long it takes and how long before the wedding it must be finished, plus what it
depends on. Dates are computed on read. Moving the date is a preview first: what shifts, what is now late, what is now
impossible because its lead time no longer fits. The commit carries the preview's fingerprint and is refused if the
plan changed in between.

**Why it holds.** No table has a due-date column (a test scans the schema). The cascade and the critical path are
checked against an independent Python implementation in `tools/` on every fixture.

**What the build taught.** The template's action harness, which feeds every server action generated input, found a
real bug on its first run: a task made to depend on itself reached a database CHECK and came back as a server error
instead of a refusal. The plan is now validated in memory before anything is written. Two mutation checks were run by
hand before hand-off (deleting one change-log call; deleting the "not your own request" rule): the scripted-session
test and eight two-key tests went red, then the code was restored.

## Phase gates (the meta-story)

Six artifacts, four phases, and a rule: no work on the next phase while this one's fixtures or demo story fail.
Phase 1's gate results are in `NEXT.md`.
