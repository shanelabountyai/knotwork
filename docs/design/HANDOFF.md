# Design handoff

Source of truth for the UI built on branch `design/impl`. Written 2026-11-26 in an unattended run (RUN.md); there is no
Claude Design canvas for Knotwork yet, so the artboards here are the design. `canvas.json` lays them out in the same
format as Turnstile's, ready to open as a canvas.

- Design system: `docs/DESIGN_SYSTEM.md` (tokens, status families, type, space, accessibility floors).
- Stylesheet: `src/app/ui/knotwork.css` (the only one). Components: `src/app/ui/kw.tsx`, `src/app/ui/nav-link.tsx`.

## Artboards (`docs/design/*.dc.html`)

Each file is a self-contained Design Component: HTML with inline styles (light scheme), real `<button>`, `<a>`,
`<label>` and form controls, and `{{holes}}` filled by the `renderVals()` script at the bottom, which holds the sample
data. Opened as a plain file, a small inline script fills the holes, so no runtime is needed. Names are the synthetic
seed couples (`scripts/knotwork/seed-couple.ts`); every figure is a `[placeholder]`, never an invented number.

| File | Screen | Route | Frame |
| --- | --- | --- | --- |
| `Home.dc.html` | The couple's home in planning mode: date, countdown, at a glance, the keys explained, re-confirmations | `/o/[org]` | 1280×1180 |
| `Plan.dc.html` | Schedule with states, the critical path, and the date-move cascade preview | `/o/[org]/wedding/schedule`, `/o/[org]/wedding/date` | 1280×1520 |
| `Money.dc.html` | Budget (estimates, actuals, a masked private line, funding) and the vendor book | `/o/[org]/wedding/budget`, `/o/[org]/wedding/vendors` | 1280×1240 |
| `Guests.dc.html` | Headcount figures, what changed, households, and the RSVP chase panel | `/o/[org]/wedding/guests`, `/o/[org]/wedding/guests/chase` | 1280×1300 |
| `Approvals.dc.html` | The two-key inbox: waiting for you (with a date-move preview), waiting for your partner, the keys, the rules, decided | `/o/[org]/wedding/approvals` | 1280×1780 |
| `ApprovalsPhone.dc.html` | The same flow at 390 px, after approving | `/o/[org]/wedding/approvals` | 390×1000 |
| `RsvpPhone.dc.html` | The guest-facing RSVP link (guest-facing; rule 3) | `/r/[token]` | 390×1500 |
| `PhotoPhone.dc.html` | The photo wall's guest side: add a photo from the QR, after an upload (guest-facing; rule 3) | `/p/[token]` | 390×1000 |
| `Seating.dc.html` | Seating: score and problems, generate, tables as cards, not seated, rules | `/o/[org]/wedding/guests/seating` | 1280×1300 |
| `LifeHome.dc.html` | Life-admin home at 390 px: next anniversary, household tasks with due states, thank-yous, name change, documents, photos | `/o/[org]` in life-admin mode | 390×1400 |

## Owner calls (binding)

- Knotwork gets its own look, not the shared saas-foundation clone tokens (as Earmark did). (Shane, 2026-11-26)
- A consumer app for couples, used on phones as much as desktop; the headline claim is the two-key shared account.
- One stylesheet, no new UI library, no web font, no images, no new dependency.
- Synthetic data only. Guest-facing pages must not leak wave or secrecy data (CLAUDE.md rule 3).

## Every other route, and the artboard whose patterns it reuses

Patterns: **cards** (a `section` in `main`), **figures** (`Figs`), **status pills** (word, glyph, colour), **keys**,
**table in a scroll region** (`TableWrap`), **tab rows** (wedding tabs, section tabs), **guest head** (mark and the
couple's name in serif italic), **request card** (left plum edge).

| Route | Reuses | Notes |
| --- | --- | --- |
| `/` | RsvpPhone | landing: the guest head, sign in, demo accounts |
| `/login`, `/login/[token]`, `/login/mfa`, `/demo` | RsvpPhone (narrow column, full-width button) | template-owned; styled by element rules only |
| `/legal/privacy`, `/legal/terms` | element rules | template-owned stubs |
| `/onboarding`, `/onboarding/invite/[token]` | element rules, cards | template-owned |
| `/account/security`, `/account/email/[token]` | element rules, cards, table | template-owned |
| `/o/[org]/settings/members`, `audit`, `security`, `sso`, `apikeys`, `danger`, `danger/export/[id]` | top bar, element rules, table | template-owned; their tables scroll on a phone by element rule |
| `/o/[org]/projects` | element rules | template demo page |
| `/s/[token]` | element rules | template share link |
| `/o/[org]/wedding/dashboard` | Home (cards in a grid, pills) | every figure's section kept as a card |
| `/o/[org]/wedding/funding` | Money | tables and cards |
| `/o/[org]/wedding/vendors/[id]` | Money, Approvals (keys well for book/sign) | the brief in a well; attachments form unchanged (rule 4) |
| `/o/[org]/wedding/flags` | Home (re-confirmation rows), pills | |
| `/o/[org]/wedding/activity` | Money (rows) | the feed as rows |
| `/o/[org]/wedding/helpers` | Money (forms, table) | |
| `/o/[org]/wedding/date/insurance` | Plan (cards, figures) | general information page |
| `/o/[org]/wedding/contingency`, `contingency/[id]` | Plan (cards, table) | |
| `/o/[org]/wedding/name-change` | LifeHome (rows with states) | |
| `/o/[org]/wedding/guests/[id]` | Guests (cards, pills) | household detail |
| `/o/[org]/wedding/guests/waves` | Guests (figures, table) | |
| `/o/[org]/wedding/guests/music`, `guests/import` | Guests (cards, forms) | |
| `/o/[org]/wedding/gifts`, `gifts/[id]`, `gifts/links/[id]`, `gifts/thank-yous` | Money (tables), Guests (rows) | the couple never sees one household's amount (P0-5) |
| `/o/[org]/wedding/photos`, `photos/[event]`, `photos/[event]/moderate`, `photos/[event]/album` | Seating (cards in a grid), PhotoPhone | moderation and album are picture cards |
| `/o/[org]/wedding/photos/[event]/wall` | its own projector screen (always dark) | PRD P0-6: projector-safe dark theme; restyled through classes, same behaviour |
| `/o/[org]/wedding/life` | LifeHome (task rows with due pills) | |
| `/o/[org]/wedding/archive` | LifeHome, element rules | read-only plan |
| `/r/[token]/gifts` | RsvpPhone | guest-facing; the guest's own contributions only |
| `/r/[token]/stop` | RsvpPhone | guest-facing; fixed sentences only |
| `/v/[token]` | RsvpPhone (guest head), the brief in a well | vendor-facing; counts, never names |

## Placeholders

Every figure is `[n]`, `[$ amount]`, `[date]` or similar. The names are the synthetic seed's (Juniper Vale and Rowan
Ashby; Sage Linden and Wren Calder; the Lindqvists; Ruth Stern; Cedar Hollow Barn; Fennel & Fig Catering). The built
pages show the engines' real values; nothing from an artboard ships.

## What the artboards do not show

- Dark mode: the tokens remap in `knotwork.css`; the artboards show the light scheme only.
- Empty, refused and error states: they keep the pages' own sentences (`role="alert"` with ▲, `role="status"` with ✓),
  styled by the element rules.

## Built against the artboards (2026-11-26)

Where the build differs from an artboard, and why:

- **Home**: "Move the date" is a link in the date line (it stays a partner-only link, as before); the tiles are the
  `At a glance` list itself, not a titled card; the keys explainer is rows, not a well.
- **Plan**: the cascade preview keeps its sentences ("0 late after the move") as tiles, coloured `late` with ▲ when the
  number is not zero, rather than big figures: the e2e story reads those sentences. On the date page the keys show
  none turned before proposing (the artboard showed one).
- **Money**: figures from the budget's own totals (spent of estimated, left or over, categories over); the vendors'
  flag count is on the vendors page, not here (the budget page does not load flags).
- **Guests**: the headcount stays a list of sentences and the chase panel stays on its own tab (`/guests/chase`), which
  is where its data is loaded.
- **Dashboard**: the headings keep their wording ("Tasks: N% on track"), which the dashboard tests assert; see PRD DUX-8.
- **Every wedding tab row** hides tabs that would be a 404 to the viewer (D-162); counts show where the page loads them
  (PRD DUX-4).

## Round 2 (2026-11-28): navigation, home hero, approvals, money, phones, keys, plain words

Seven fixes from four persona reviews (style-focused, planner, phone-only, product-designer brides). Decisions
D-173 to D-182. Screenshots of the real routes at 1280 and 390 px: `docs/design/round-2/`.

### The tab map (D-173)

| Top tab | Its own page | Second row (each an existing route, unchanged) |
| --- | --- | --- |
| **Home** | `/o/[org]` | Progress (`/wedding/dashboard`) · Activity · Helpers |
| **Plan** | first of its row | Schedule · Move the date (`/wedding/date`, and `/date/insurance` under it) · Contingency plans · Name change; `/wedding/archive` belongs here in planning mode |
| **Money** | first of its row | Budget · Vendors (and `/vendors/[id]`) · Funding · Re-confirmations [n] (`/wedding/flags`) |
| **Guests** | first of its row | Guest list (its own row: Households · Invitations and cap · Chasing · Music · Import) · Seating · Gifts (its own row: Registry · Thank-yous) · Photos (an event keeps its row) |
| **Approvals [n]** | `/wedding/approvals` | none |

Life-admin mode: **Home** (Activity · Helpers) · **Household** (Household tasks · Name change) · **Gifts and photos**
(Thank-yous · Photos) · **Archive** (every planning page sits under it) · **Approvals**. A viewer sees only the pages
their grants open (D-162). Before: 15 tabs on up to two rows plus section rows; after: 5 top tabs.

### What changed on the boards

- **Home**: the countdown is the hero in `--t-2xl`/`--ink`, under the couple's name; none after the day. The keys card
  is `KeysLegend`.
- **Approvals**: Approve alone; "Decline…" opens "Why not? (optional)" and Decline; after you decide, the result card
  (`role="status"`) sits where the card was; "Waiting for <partner>"; the same keys legend as Home.
- **Money / vendor book**: Paid · Balance · Next due per vendor (D-175).
- **Plan / Schedule**: "Spare days", "The longest chain", "nobody yet" on unowned tasks; "can't fit before the day".
- **Phones**: Schedule, Vendors and Households are stacked cards under 600 px (D-178).
- **Guests**: a guest's "declined" is the neutral `off` pill (the Guests artboard's pill updated).

The artboards other than the Guests pill were not redrawn; the screenshots are the current record.
