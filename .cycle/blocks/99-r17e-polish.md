# Increment 99 — R17e: post-deploy polish round (owner screenshot)

Six owner items after deploying R17c/R17d, all verified against the live
DOM in the harness plus a re-rendered email mock.

## The one real bug: the Queue Call Data panel was half-width

The multi-queue CAROUSEL (`.dept-qcd-carousel`) is a SINGLE child of the
`#dept-qcd-tiles` grid, and R17c's side-column override pins that grid to
`1fr 1fr` — so the carousel landed in COLUMN 1 (half the panel) and its
inner tiles overflowed the track, leaving the dead right gutter the owner
screenshotted. One rule fixes it: `.dept-qcd-carousel { grid-column: 1 /
-1; }` — the same span `.dept-qcd-queue-row` already carries. Every
multi-queue dept had this since R17c; single-queue depts (flat tiles,
no carousel) never did, which is why it survived the R17c probes.

## Daily-breakdown lenses: cards, chronology, ⓘ

- Each lens in the detail row is its own bordered `--paper` card on the
  row's `--paper-2` — the lists sat on the row surface and read as loose
  text. The old between-lens border-left divider is gone (redundant
  between cards), which also retired its narrow-viewport override.
- The abandons lens now renders CHRONOLOGICALLY like the missed-rings
  lens beside it. Display-only: the SQL keeps `ORDER BY … DESC` so the
  row cap retains the NEWEST calls; the re-sort runs AFTER truncation,
  so "(newest N shown)" stays true. Applies to the heatmap cell drill
  too (same renderer, same consistency argument).
- `meta.reconcileNote` renders as a hover-ⓘ on the heading (side-hint-i)
  instead of a text box. The R16i rule — the explainer ships WITH the
  data — survives; only its form changed.

## Folds: Team detail joins the store, open by default

`#ins-team-detail` (heatmap + call-share row) kept bare element state:
closed by default, forgotten across loads. It now carries
`data-fold="detail"` and rides `cdr.ins.folds.v1:<email>` — open by
default for EVERYONE (unlike qh/trend's role-seeded default), and a
pre-R17e blob without the key is treated as open. `insFoldsApply_`
matches the bare attribute since the element lacks `.ins-fold`.

## Small visual asks

- Team Rings KPI cards center vertically (flex column) — the shorter
  Avg-ans-time card sat top-anchored in its stretched grid cell.
- The call-share equal-share delta is color-coded: sage above / warm
  below, but |delta| < 2 pts stays muted (the WOW noise discipline).
  This deliberately overrides R17c's "neutral gray on purpose" ruling —
  owner asked.

## Email tally: 20 calls/block

The unit ladder picks the finest unit whose block count fits
`TALLY_MAX_BLOCKS`, so the owner's "make CSR 20/block" is a CEILING
change, not a unit constant: cells slimmed 5px+2px → 3px+1px
(4px/block), ceiling 14 → 25. 25 × 4px = 100px stays under the ~112px
squeeze threshold, and a ~350–500-call queue day now lands on unit 20
(the old ceiling forced 50). Measured post-change: every block renders
exactly 3px across rows spanning 6–20 blocks. Three test pins
re-targeted (block width, ceiling, per-section units — finer units are
the intended effect, not collateral).

## Gates

661/661 unit (queue-report 39/39 after re-targeting), INV-16 green,
UI gate re-run (50/50 + 16/16 + 30/30 + 14/14 expected — confirm in
STATE). Probed live: carousel 290/320px (full), KPI topGap==botGap,
detail fold open + persisted through a close, lens cards distinct from
the row surface, ⓘ title 238 chars, abandons ascending.

## Where I left off

Awaiting owner review; PR on their word. Deploy is Department Dashboard
only. Owner question answered in chat: recommend keeping TWO lenses
(different sources/definitions; an interleaved merge would invite
row-level reconciliation that structurally can't exist) — now visually
tied by matching order, shared card chrome, and the ⓘ.
