# Design pass — how it was run

Written 2026-11-26 from Shane LaBounty's scheduled request (Thanksgiving; nobody watching, no questions asked). The
same method as Turnstile's design pass (`shanelabountyai/turnstile`, `docs/design/RUN.md`), with Knotwork's own look.

1. **Design system first.** `docs/DESIGN_SYSTEM.md` and the tokens in `src/app/ui/knotwork.css`; `npm run
   design:contrast` (`tools/contrast.py`, stdlib) passes before any screen is drawn.
2. **Artboards.** `docs/design/*.dc.html`, self-contained (inline styles, `renderVals()` sample data, `[placeholders]`
   for every figure), listed with their routes in `HANDOFF.md`, every other route mapped to the artboard it reuses.
   Committed before implementation.
3. **Implement** on branch `design/impl`, cut from `phase-5`. Visual and interaction layer only: no engine, consent
   rule, secrecy mask, money arithmetic, permission, schema or API contract changes; no new server action, page,
   dependency, web font or image. Guest-facing pages render the same projections as before.
4. **Three independent reviews** by fresh agents given only the repo path, how to run it, `docs/design` and their
   role: design fidelity; UX across the PRD's personas; accessibility (WCAG 2.1 AA). Must-fixes are fixed; a finding
   that would change product behaviour goes to the PRD as a numbered item for Shane instead of being built.
5. **Gate** as CI runs it, plus `npm run design:contrast`; then one draft PR, based on `phase-5`.

Judgment calls are rows in `docs/knotwork/decisions.md` (from D-154).
