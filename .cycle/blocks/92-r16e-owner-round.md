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

## Follow-up (same day): centered queue-health cards

Owner: "center the text of the cards (and reduce width if necessary)."
`.ins-qh-left .ds-kpi { text-align:center }` + a centered `__top`, SCOPED
to the queue-health column so the IR / Inbound / Direct rows sharing the
same `.ds-kpi` component keep their left alignment. The top line needed
`white-space:nowrap` + `flex-wrap:wrap`: at the narrower width the
default space-between flung a lone label left, and centering alone broke
"Abandoned %" across two lines with the delta badge wedged beside it --
now the badge drops under the label instead. Column trimmed 480 -> 400px
max (centered text needs no run-up), giving the queue table 968px.
Gates re-run: 652/0, INV-16, ci:ui 36+16+30+14.

## Follow-up 2: tally block uniformity (email) + per-section units (web)

Owner, from the live deploy:

1. **Email blocks were not uniform between rows.** Measured in headless
   Chromium against the real builder: a 20-block row rendered each cell at
   4.09px while a 9-block row rendered 5px. Cause is layout, not the unit
   ladder -- the tally is a table of width="5" cells inside the ~150px
   "Abandoned %" column, and past ~16 blocks the renderer shrinks every
   cell to fit. Fix: `TALLY_MAX_BLOCKS = 14` (email-local, NOT the web's
   shared 36), so the widest row stays under the fit threshold and every
   block renders at its natural 5px everywhere. Re-measured: all rows 5px.
   New pin asserts no tally row exceeds 14 blocks across a fixture spanning
   three orders of magnitude in one section.
2. **The web all-dept report never got the per-section unit** (R16d changed
   the email only). `qcdSectionUnit` is now computed per section inside the
   `topLevel.forEach` and read by `queueRow`; each dept banner discloses
   "block ≈ N calls" (`.qcd-deptrow-unit`); the single company-row
   "= N calls" legend is removed (one number would be wrong for every
   section but one). The web keeps the shared 36-block ceiling on purpose:
   its blocks are `flex: 0 0 auto` and WRAP rather than shrink, so the
   compression that forced the email's 14 does not exist there.

Gates: node --test 653/0 (queue-report 39), INV-16, ci:ui 36+16+30+14.
