# Knotwork design system

Knotwork's own look: **plum on linen**. It is not the shared saas-foundation clone palette (Shane's call, as for
Earmark): a consumer app for two people planning a wedding, used on a phone as often as on a laptop. Its headline
claim is the two-key shared account, so the one visual idea that is Knotwork's alone is **the keys**: two rings, one
per partner, filled when that partner's key is turned.

- Stylesheet (the only one): `src/app/ui/knotwork.css`. Components: `src/app/ui/kw.tsx` (server) and
  `src/app/ui/nav-link.tsx` (the one client piece: marks the current tab).
- Artboards: `docs/design/*.dc.html`, listed with their routes in `docs/design/HANDOFF.md`.
- Evidence: `npm run design:contrast` (`tools/contrast.py`) measures every token pair below in both schemes.

## Rules

1. **An outcome is a word first, then a glyph, then a colour.** Colour is never the only signal. The glyph is drawn by
   CSS (`content: '▲' / ''`) so a screen reader reads the word once, not "black up-pointing triangle".
2. **A figure travels with its rule.** "12 of 12 seats held", not "100%"; "3 days short on the longest chain", not
   "at risk". Every figure on a page comes from the engine that owns it; components do no arithmetic.
3. **Semantic HTML carries the design.** Element styles come first, so the template-owned pages (sign-in, settings,
   onboarding, the audit log) look right with no classes. Classes exist for a handful of components (`kw-*`).
4. **Phone first.** Everything works at 390 px with a 16 px gutter and no sideways page scroll; long tab rows and wide
   tables scroll inside themselves.
5. **One stylesheet, no new dependency, no web font, no image.** The mark is two CSS circles.
6. **Guest-facing pages say less.** The RSVP, gift, opt-out, photo and vendor pages show only what their projection
   builds (CLAUDE.md rule 3); the design adds no field, count, date or state to them.

## Tokens

Three layers in one file: primitives (`--n-*` neutral, `--a-*` plum, type, space, radius), semantic, status. Dark mode
remaps the semantic layer only, under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme='light'])`,
and again under `:root[data-theme='dark']` (the contrast script fails if the two blocks differ).

### Colour (semantic)

| Token | Use | Light | Dark |
|---|---|---|---|
| `--bg` | page | `oklch(0.975 0.007 350)` linen | `oklch(0.18 0.012 350)` |
| `--sf` | card, input, bars | `oklch(0.995 0.004 350)` | `oklch(0.225 0.014 350)` |
| `--sf-2` | well inside a card, table head, code | `oklch(0.95 0.01 350)` | `oklch(0.27 0.015 350)` |
| `--ink` | text | `oklch(0.24 0.02 350)` | `oklch(0.94 0.008 350)` |
| `--mu` | secondary text | `oklch(0.47 0.02 350)` | `oklch(0.77 0.015 350)` |
| `--ln` | card borders, rules (decorative) | `oklch(0.86 0.014 350)` | `oklch(0.37 0.015 350)` |
| `--ln-strong` | form control borders (3:1) | `oklch(0.58 0.02 350)` | `oklch(0.6 0.02 350)` |
| `--ac` | links, primary button, current tab edge, focus ring | `oklch(0.45 0.14 345)` plum | `oklch(0.8 0.1 345)` |
| `--acf` | text on `--ac` | `--n-0` | `--n-d-bg` |
| `--ac-tint` | behind the current tab | `oklch(0.945 0.03 345)` | `oklch(0.31 0.06 345)` |

### Status families

Each family is a hue; lightness and chroma come from the scheme (`--k-bg-l/c`, `--k-fg-l/c`, `--k-dot-l/c`). Use with
`data-k` on any element (`--k-bg`, `--k-fg`, `--k-dot`), or the `<Status k>` pill.

| Family | Hue | Glyph | Knotwork words |
|---|---|---|---|
| `ok` | 150 green | ✓ | on track, approved, attending, done, paid, signed, acknowledged |
| `late` | 27 red | ▲ | late, impossible, over the estimate, declined (a request), refused |
| `wait` | 75 amber | ○ | waiting for a key, not answered, needs re-confirmation, due soon |
| `info` | 245 blue | ● | invited, queued, in progress, coming up |
| `off` | grey (chroma × 0.15) | ■ | expired, withdrawn, archived, not invited, nobody yet |
| `priv` | 300 violet (chroma × 0.6) | ◇ | private to one partner, until revealed |

`role="alert"` is `late` with ▲; `role="status"` is `ok` with ✓; `role="note"` is a neutral well with ●.

### Type

System fonts only: `--sans` (`system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`) for everything;
`--serif` (`ui-serif, 'Iowan Old Style', Georgia`) italic for one thing, the couple's name (`h1.display`) on the home
page and the guest-facing pages; `--mono` for links shown as text and the vendor brief.

| Token | px | Use |
|---|---|---|
| `--t-xs` | 13 | table heads (uppercase, tracked), pills |
| `--t-sm` | 14 | meta lines, hints, buttons, account links |
| `--t-base` | 16 | body (line height 1.55) |
| `--t-md` | 20 | `h2` (card titles) |
| `--t-lg` | 25 | figures |
| `--t-xl` | 31 | `h1` on a phone (36 from 720 px) |
| `--t-2xl` | 39 | the countdown on the home page |

### Space, radius, size

A 4 px grid: `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 20 · `--s-6` 24 · `--s-8` 32 · `--s-10` 40 ·
`--s-12` 56. Radius `--r-1` 10 (controls, wells), `--r-2` 16 (cards), `--r-pill` (buttons, tabs, pills).
`--tap` 44 px: every button, input, select, tab, account link and checkbox label is at least 44 px tall.
Page width `--container` 72rem; guest-facing pages `--narrow` 34rem; the vendor brief 48rem.

## Accessibility floors (measured)

- Text 4.5:1 and UI edges (control borders, the focus ring, pill edges, the current tab's edge) 3:1, in light and dark:
  `npm run design:contrast` checks 34 pairs per scheme and exits 1 under any floor. Decorative card borders (`--ln`)
  are not the only edge of anything a person must find; controls use `--ln-strong`.
- Focus: a 3 px `--ac` outline with 2 px offset on `:focus-visible`, never removed.
- Touch targets 44 px (`--tap`). Checkbox and radio labels are 44 px rows with a 22 px box.
- Works at 390 px: one column; the top bar's account links and the tab rows scroll inside themselves; a wide table sits
  in `.table-wrap`, a named focusable region that scrolls sideways.
- Motion: one 140 ms colour transition on buttons; `prefers-reduced-motion` removes it. The wall's slide timer is the
  product's, not decoration.
- Landmarks: a skip link to `#content`, one `<nav>` for the workspace (top bar), one for the wedding's tabs, one per
  section's tabs, one `<main>` per page.

## Components

| Name | File | What it is |
|---|---|---|
| Top bar | `o/[org]/layout.tsx` | the mark, "Knotwork", the workspace name, the account links (template settings) |
| `WeddingNav` | `o/[org]/wedding/bits.tsx` | the wedding's tabs (`nav.kw-tabs`), current tab marked by `NavLink` |
| `GuestNav`, `GiftNav`, `PhotoNav` | their `nav.tsx` | a section's tabs (`nav.kw-subtabs`) |
| `NavLink` | `ui/nav-link.tsx` | a link that sets `aria-current="page"` on its own route |
| `Status` | `ui/kw.tsx` | the pill: `<Status k="late">late</Status>` |
| `Keys` | `ui/kw.tsx` | the two-key state: rings plus words ("1 of 2 keys", "both keys", "solo") |
| `Figs` | `ui/kw.tsx` | a row of figures, each a number with its rule |
| `TableWrap` | `ui/kw.tsx` | a table that scrolls sideways inside a named, focusable region |
| `GuestHead` | `ui/kw.tsx` | the guest-facing header: the mark and the couple's name (`h1.display`) |
| `stateKind`, `rsvpKind`, … | `ui/kw.tsx` | word → family maps for the engines' own words |
| `designatedSentence` | `o/[org]/wedding/bits.tsx` | the designated actions in one sentence (home and Approvals) |
| Not found | `app/not-found.tsx` | one page for every 404, fixed words, no data (rule 3) |

## Changing it

Change the token here and in `knotwork.css` together, run `npm run design:contrast`, and add a row to
`docs/knotwork/decisions.md` if a rule changes. A new screen gets an artboard in `docs/design/` first.
