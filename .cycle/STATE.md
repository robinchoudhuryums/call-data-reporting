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

**Separate work-stream this session (NOT redesign):** added a DQE Historical Data TZ repair to
`cdr-report/sheetRepairs.js` — `previewDqeOldPstTimestampShift()` / `repairDqeOldPstTimestampShift()`.
Old rows (Date < 2026-03-09) stored slot/AF missed-times in PST; current pipeline stores CST (+2h).
Repair shifts K-AC (11-29) + AF (32) time-of-day strings +7200s, date-gated AND per-row PST-window
validated (re-run safe; skips already-CST/mixed/anomaly rows), AF follows the row's slot decision
(skips #REBUILD sentinel + non-time tokens), surgical per-row writes + plain-text lock. Fixes the
Missed Calls report (it buckets by parsing the stored time; old PST values mis-bucket / drop off the
8AM-5PM CST chart). Does NOT touch durations (TTT/ATT/AvgAbdWait) or counts. node --check clean;
core shift/window math sanity-checked. NEEDS: deploy cdr-report (`clasp push -f`), run preview ->
apply from the editor, then backfillDQEHistoryUpsert() if Neon mirror is consumed. NOT in the Node
suite (SpreadsheetApp-bound, like the existing two repairs).
  - **Follow-up (AF coercion ownership):** `repairDqeSlotTimestamps_` now recovers coerced
    time cells in BOTH K-AC (11-29) AND AF (32) — AF holds the same H:MM:SS strings and
    coerces to time serials identically; the slot repair previously skipped it. Correspondingly
    `repairDqeAbandonedIds_` narrowed to AD/AE (30-31): it was mis-marking coerced single AF
    times as "#REBUILD" (a fractional serial fails Number.isSafeInteger). CAVEAT: if anyone ran
    the OLD 3-col `repairDqeAbandonedIds()`, some single AF times may already be wrongly
    "#REBUILD" (serial overwritten → unrecoverable from the cell; needs a Raw Data rebuild).
    DOC: CLAUDE.md number-coercion gotcha still says repairDqeAbandonedIds handles "AD-AF" — /sync-docs.
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
   - **Increment 3 (DONE):** Insights length-mismatch warning → `.ds-banner is-warn`
     (badge + text). dashboard.html class swap (`cr-length-warning`→`ds-banner is-warn`,
     contained — CR's own `.cr-length-warning` untouched) + `insRenderLengthWarning_`
     restructured to emit `ds-banner__badge` ("Heads up") + a text `<div>`; warning copy
     verbatim. Demonstrates the banner component (a new one). NOTE: the at-a-glance
     headline still can't use ds-banner cleanly — it's the SHARED `reportHeadline_`.
   - **Agent cards → `ds-card--rail`: DEFERRED on purpose.** They ALREADY use a left-border
     classification rail (`.ins-card-improved/regressed/mixed` = accent/warn/muted), so a
     ds-card--rail migration is ~zero visual gain but high unverifiable risk (padding/layout
     preservation, drill-through, cards⇄chart toggle, collapsible details). Recommend doing
     it only alongside a live before/after, or skipping (the existing rail already matches
     the target look). Queue-health KPI tiles (inboundKpiTile_) remain a safe-but-quirky
     option (bench-tint-on-cap + pr-delta badges to preserve).
4. **/sync-docs:** add a CLAUDE.md note for the new `ds-*` component layer + radius scale
   under CSS conventions (currently only `docs/design-update-plan.md` documents it).
5. **Later phases (planned, not started):** Phase 2 (loaders + motion + `.ds-state` kit +
   SWR Overview, per-viewer keyed), Phase 3 (chart factory + graceful fallback +
   debounce/token on date edits). Held for sign-off: C7 consolidation, C8 nav restructure.

## Where I left off
Implemented Phase 1 Parts 1+2 (additive tokens + 8 `ds-` components) AND a contained Part 3 proof
(Insights KPI tiles → `ds-kpi`, queue-health table → `ds-table`/`ds-card`, length-warning →
`ds-banner`; PR + QCD + CR untouched) per `/broad-implement Phase 1`; tests 132/132 green, INV-16
in sync, script.html JS `node --check` clean, dashboard.html divs balanced 608/608. Live visual
check is the only open verify (manual S37, post-deploy). Agent-card rail migration deliberately
deferred (near-zero visual gain vs high unverifiable risk — see Increment notes). Recommend a
deploy + eyeball before further Insights surgery.
Also confirmed access control: non-manager/non-admin domain users land on access-denied with zero
data (Code.gs doGet + per-RPC re-auth); out-of-domain users can't reach the app. Awaiting
commit/push/deploy direction.
