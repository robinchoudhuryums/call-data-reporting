# Increment 97 — R17b: the Team Rings Data sticky panel

Owner-approved plan (Round 17, item 2, with their four refinements:
tally per row, vertical scroll cap, per-dept mini-groups, panel named
"Team Rings Data", rollup section title removed entirely). CLIENT-ONLY.

## P1 — the sticky rail rides the whole page

`#dept-insights-region` (640 lines) moved INSIDE `.dept-layout >
.dept-main`, so the aside -- the sticky element -- accompanies the page
end to end and Insights renders at the main-column width (~1052px at
1500). The print path's `#dept-page > :not(#dept-insights-region)` carve
broke by construction; it now walks the chain (#dept-page keeps only
.dept-layout, which collapses to display:block so the hidden 320px aside
leaves no gap, keeps only .dept-main, keeps only the region).

## P2 — the panel

`#dept-team-rings` below Queue Call Data in the same aside (both cards
ride one sticky element -- no second sticky context needed):
- `% Ans (rings)` KPI: value on the 92% tint, foot "N rings (a / m)",
  the team strip's prior-window delta chip (same deptTeamPrior_ data).
- `Avg ans time` (queue, answered-weighted) -- renders only when QCD
  shipped it.
- Condensed agent table: trpShortName_ ("Roman P."; parentheticals
  stripped; FULL name on the row title), per-row mini tally at
  `ansTallyUnitFor_(rows, 12)` (the shared helper gained an optional
  maxBlocks cap -- prior callers byte-identical), Ans/Miss + %,
  worst-%-first, per-dept mini-group headers in a combined view
  (deptGroups order), max ~10 rows then internal scroll with a sticky
  thead, "= N calls" legend when unit > 1. Row click/Enter scrolls to +
  flashes the agent's main-table row (reduced-motion-gated).
Rendered by renderTeamRingsPanel_ from the SAME summary payload at both
renderDeptTeamStrip_ call sites (incl. the no-rows path, where it hides).
Hideable via the `dept-team-rings` UI flag (#34 convention).

## P3 — the replaced Insights card sets

The Department-rollup card row + its section title (owner: remove
entirely) and the Queue-health card column are display:none with wiring
inert (Round-16 convention). The region sub-line drops "Department
rollup ·". Nothing orphaned: figures live on in this panel, panel 1's
tiles, the queue table (full width again) and the team strip; the
rollup's deltas/sparklines survive in the per-agent cards + emails + CSV.

## Verification

Probes both roles: panel with 2 KPI tiles + 7 rows in 2 dept groups
(CSR/Spanish combined view), tallies, full-name hover, region inside
dept-main, both card sets hidden, panel on screen at scrollY 3127 (deep
in Insights), zero horizontal overflow, row-jump flashes Carla Diaz's
main-table row. +3 drive-smoke checks per role (40 -> 46). Gates:
node --test 660/0, INV-16, ci:ui 46+16+30+14.

**WHERE I LEFT OFF:** R17a (increment 96) + R17b committed + pushed on
claude/broad-scan-l9ojgm. No PR (owner asks explicitly). Owner may want
live-deploy tweaks to the panel's density/columns.
