# Cycle State — resume note

**Branch:** `claude/dazzling-heisenberg-2png1z` · working tree has uncommitted design Phase 1 changes
**Verify on resume:** `node --test` (132 pass) + `bash scripts/check-duplicated-files.sh` (INV-16 in sync)

> Prior session's F1–F6 bug-fix work was **merged via PR #83** (commit `06639f5`),
> so the earlier "not yet committed" note is superseded. This is a new work-stream:
> the Claude Design package redesign (`docs/design-package/`), planning + Phase 1.

## What shipped this session (NOT yet committed/pushed)
Design-package planning + **Phase 1 foundation** (additive, zero behavioral change):
- **Plan of record:** `docs/design-update-plan.md` — full conflict register (C1–C8),
  decisions, and the phased sequence. Decisions: keep `--r:2px` (C1-A), binary
  thresholds only (C2-A), keep `data-mode` dark (C3-A), chart factory yes / SRI-restore
  no (C4-A), wire to `getDepartmentSummary` not `computeSummary_` (C5), adopt SWR with
  per-viewer guardrails (C6-A), consolidation parked (C7), nav deferred (C8-A).
- **Phase 1 / Part 1 — tokens** (`styles.html` `:root`): added `--r-sm/--r-lg/--r-pill`,
  `--shadow-1/2/modal`, `--ease/--dur-1..3/--stagger`. **`--r` LEFT at 2px** (decision C1).
- **Phase 1 / Part 2 — component layer** (`styles.html`, new block before `</style>`):
  `.is-good/.is-warn/.is-bad` status helpers + 8 `ds-*` components (kicker/section,
  chip/delta, KPI tile, status-rail card, table+bar, banner, toolbar/seg, modal shell).
  Net-new `ds-` namespace (verified collision-free); NOTHING references them yet, so
  the live app renders byte-identically. Static (no animation — that's Phase 2).

Tests: 132/132 pass; whole-file CSS brace balance 860/860; INV-16 untouched. No invariants at risk.

## OPEN / next steps
1. **Commit + push** the Phase 1 CSS + `docs/design-update-plan.md` to this branch (not yet done).
2. **Deploy (only when ready):** Department Dashboard `clasp push -f` + new deployment version.
   Inert until markup uses the classes, so deploy is non-urgent / non-blocking.
3. **Phase 1 / Part 3 — DONE (contained proof):** Insights team-rollup KPI tiles
   migrated onto `ds-*`. New Insights-only `insKpiTileDs_` (script.html) emits `.ds-kpi`
   markup; the four `prKpiTile_` calls in `insRenderReport_` swapped to it. Behavior
   identical (same valence→color map, same binary `benchValueCls_` 92%/5% tint, shared
   `irSparkline_`). Performance Report's `prKpiTile_` untouched; shared `reportHeadline_`
   (used by all reports) intentionally NOT migrated. `.ds-kpi__spark` height nudged
   20→22px so the 70×22 sparkline isn't clipped. **Live visual verify still pending**
   (manual S37 post-deploy — can't run Apps Script here).
   - **Increment 2 (DONE):** Insights queue-health per-queue table migrated to `.ds-table`
     inside a `.ds-card` (dashboard.html) — the card supplies the chrome ds-table omits.
     Contained to that one table; QCD's own `.qcd-source-table` instances untouched; no
     JS references it (`.num`/`.qcd-warn-*` classes stay harmless). Tbody row builder
     unchanged. Whole-file divs balanced 608/608.
   - **Next increments:** at-a-glance banner is BLOCKED as a clean per-report move (it uses
     the SHARED `reportHeadline_` across all reports — needs a decision before diverging).
     Remaining: per-agent cards → `ds-card--rail` + `ds-chip` + `ds-bar` (marquee component,
     higher complexity — touches insBuildCard_ classification/drill-through), and the
     queue-health KPI tiles (inboundKpiTile_ → ds-kpi variant, low risk).
4. **/sync-docs:** add a CLAUDE.md note for the new `ds-*` component layer + radius scale
   under CSS conventions (currently only `docs/design-update-plan.md` documents it).
5. **Later phases (planned, not started):** Phase 2 (loaders + motion + `.ds-state` kit +
   SWR Overview, per-viewer keyed), Phase 3 (chart factory + graceful fallback +
   debounce/token on date edits). Held for sign-off: C7 consolidation, C8 nav restructure.

## Where I left off
Implemented Phase 1 Parts 1+2 (additive tokens + 8 `ds-` components) AND a contained Part 3 proof
(Insights KPI tiles → `ds-kpi`, then Insights queue-health table → `ds-table`/`ds-card`, PR + QCD
untouched) per `/broad-implement Phase 1`; tests 132/132 green, INV-16 in sync, script.html JS
`node --check` clean, dashboard.html divs balanced 608/608. Live visual check is the only open
verify (manual S37, post-deploy). Next: per-agent cards → `ds-card--rail` (or pause for deploy).
Also confirmed access control: non-manager/non-admin domain users land on access-denied with zero
data (Code.gs doGet + per-RPC re-auth); out-of-domain users can't reach the app. Awaiting
commit/push/deploy direction.
