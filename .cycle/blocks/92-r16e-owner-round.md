# Increment 92 — R16e: five owner notes (post-#224 deploy)

## 1. My Department totals label
The Total cell reads a bare "Total"; the roster/floater/crossover caption
moved into its `title` (+ `.agents-total-label.has-note` dotted underline).
NOT dropped -- CLAUDE.md's sub-queue rule requires the subtotal-vs-total
shortfall to be stated, so the tooltip carries it and the CSV total row
still spells it out in full. Both halves asserted in drive-smoke.

## 2. Insights header
`#ins-views-btn`'s wrapper hidden (Round-16 removal convention: markup +
wiring inert, saved views/share link return by dropping display:none);
`#ins-edit-selection-btn` moved into `.ir-results-title-line` as
`.ins-edit-inline-btn` (same id => popover wiring untouched; probe
confirms it still opens).

## 3. Heatmap row
- STRETCH: `.ins-detail-row` align-items:stretch + the heatmap panel as a
  flex column whose grid fills the leftover height. `grid-template-rows:
  auto` keeps the hour-label row content-sized; `grid-auto-rows:
  minmax(26px,1fr)` gives the slack to the DAY rows. Probe: 420px vs 420px.
- DRILL BELOW THE ROW: `data-heat-detail="ins-heat-detail"` on the panel
  opts out of the shared renderer's in-panel `.ds-heatmap-detail`;
  `heatDetailEl_(host)` resolves the external element. Two lenses side by
  side >=900px. `renderAbandonHeatmap_` now RESETS the external panel on
  every render -- the innerHTML swap can't reach outside itself, and a
  stale cell list surviving a dept/window change would read as current.
  Inbound sets no attribute => unchanged.

## 4. Daily breakdown
`ins-daily-row-in` on the sub-row CELLS (a <tr> can't animate a display
flip) + the shared `ins-fold-in` on the <details> body, both
reduced-motion-gated. Over-5% abandoned rate now bold + `--bad`: the
weight had to be RESTATED locally because the global `.qcd-rate-over
{font-weight:700}` loses on specificity to `.ans-nums .ans-rate
{font-weight:500}` -- so it had never actually been bold here.

## 5. Queue health cards
Avg answer + Longest wait promoted from the muted secondary strip (now
empty for the dept total; still serves per-queue expanded rows);
Transfer % mirrored from the dept strip; Queue calls adopts the strip's
"total (answered / abandoned)" + per-workday foot via a new
`insQhKpiTileHtml_` (value-as-HTML; callers escape). Transfer % reads
`state.csrTransfer` (DEPT payload, CSR-only) and renders ONLY on a
window match -- a saved view/share link can put Insights on its own
window and a foreign-range transfer rate would be a quiet lie. Six cards
=> the left column is a 2-up grid.

## Harness
`gen-payloads.js` gained a `CSR Transfer Historical Data` fixture sheet:
every payload carried `csrTransfer: null` before, so the My Department
Transfer % tile AND the new card were structurally unreachable from the
gate. drive-smoke +12 checks (24 -> 36).

Gates: node --test 652/0, INV-16, ci:ui 36+16+30+14. Mocks sent
(mock-qh-cards.png, mock-heat-drill.png).

**WHERE I LEFT OFF:** committed + pushed on claude/broad-scan-l9ojgm.
No PR (owner asks explicitly).
