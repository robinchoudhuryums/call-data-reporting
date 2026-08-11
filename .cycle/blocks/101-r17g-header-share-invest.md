# Increment 101 — R17g: header date cleanup, share overflow, tile centering (+ the consolidation investigation)

Three fixes shipped; the fourth item (missed/abandoned surface
consolidation) was INVESTIGATE-ONLY per the owner — findings in chat +
summarized at the bottom, NO changes made to those surfaces.

## Insights header date chip → sticky-strip workdays

The dept controls are the page's single date authority (M4), so the
"(Jul 1 – Jul 31 · 22 workdays)" chip beside the Insights title restated
it — worse, it could restate it WRONG after a monthly trend-point drill
(insDrillToRange_ reruns Insights without moving the dept controls,
R16h). Now:
- `#ins-results-date` is HIDDEN whenever `meta.from/to` equal the page
  controls' values (the normal case).
- It SURVIVES warn-tinted (`.ins-results-date--scoped`, the
  ins-dept-pill--scoped discipline) reading "(scoped: …)" when the
  windows diverge — the split range is visible, never silent.
- The workday count lives on the sticky controls strip
  (`#dept-workdays-wrap`, after Quick select): `updateDeptWorkdays_`
  fills it from the S5 holiday-aware client mirror on every `refresh()`,
  and a same-window Insights render refines it with the server's INV-35
  `meta.currentWorkDays`. A diverged render deliberately passes 0 so the
  strip keeps describing the DEPT window.

## Call-share card overflow

The share card inherits `.ir-chart-wrap`'s FIXED 420px height — sized
for a canvas — but since Round-16 the tally is DOM rows, one per agent,
and a real roster overflows a fixed box with `overflow: visible`
straight into the drill tables below (the owner's screenshot; the
5-agent harness fixture fits, which is why no probe caught it). Fix:
`height: auto; max-height: 560px` on the row-scoped wrap +
`overflow-y: auto` on the tally, so the card grows to its rows and a
huge roster scrolls internally while the header/legend stay. The
heatmap beside it stretches to the row height either way (R16e intent).

## Panel-1 tile centering

`.dept-side .dept-qcd-tile` gets the flex-column/justify-center
treatment (the Team Rings card discipline) — the Abandoned % tile has no
MTD sub-lines and sat top-anchored at the equal grid height.

## The investigation (NO changes — owner approval pending)

FIVE missed/abandoned list surfaces live on the dept page, all slices of
TWO stores (DQE missed detail; `inbound_calls` abandons): (1) per-agent
Missed-section cards (by agent over the window), (2) the missed chart's
hour-bucket drill (`makeMissedBucketDetail_`), (3) the Queue-health
per-queue no-ring drill, (4) the Daily-breakdown day drill (one date,
two lenses), (5) the heatmap cell drill (weekday×slot, two lenses).
3/4/5 already share `missedSliceListHtml_`/`heatCellDetailHtml_`.
Findings: the surfaces answer five DIFFERENT questions in-context, so
removing any forces manual re-slicing; the real redundancy is (a) the
bucket drill (2) still uses its own older `bucket-detail-list` renderer
— no date groups, no run grouping, different look for the same rows —
and (b) the agent cards (1) and the shared lens carry two separate
same-call grouping implementations (`ms-callgroup` vs `hd-run`).
Recommended: Option A — port surface (2) onto the shared renderer (one
visual language, nothing removed, pure client). Option B (cross-links
between slices) optional. Option C (one universal filterable explorer
replacing the drills) recommended AGAINST: it destroys the in-context
affordances the R16/R17 rounds built, and risks blurring the SETTLED
DQE-vs-inbound definitional split (the queue-only abandoned card and the
abandons lens must never merge — different definitions, owner ruling).

## Gates

661/661 unit, INV-16 green, UI gate re-run (confirm in STATE). Probed:
chip hidden on matched windows + scoped-tinted on the diverged ytdprobe
fixture, "21 workdays" on the strip for a 30-day window, tiles
flex-centered, share-card mechanism measured (fixed 420px + visible
overflow).

## Where I left off

Committed + pushed; PR on the owner's word. The consolidation waits for
an owner decision on Option A / B / C.
