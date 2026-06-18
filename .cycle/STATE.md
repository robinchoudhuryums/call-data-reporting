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
3. **Phase 1 / Part 3 — STOPPED, by design:** migrate ONE report (Insights) onto `ds-*`
   as the proof. NOT done this session — it rewrites ~800 lines of `insRenderReport_`/
   `insBuildCard_`/… render code covered ONLY by manual scenario S37 (Node suite can't
   verify client DOM; Apps Script app can't run here). Needs to be done as a focused,
   separately-reviewed change with a live before/after check. Wire status color via the
   existing binary `benchValueCls_` (NOT 85%/8% bands).
4. **/sync-docs:** add a CLAUDE.md note for the new `ds-*` component layer + radius scale
   under CSS conventions (currently only `docs/design-update-plan.md` documents it).
5. **Later phases (planned, not started):** Phase 2 (loaders + motion + `.ds-state` kit +
   SWR Overview, per-viewer keyed), Phase 3 (chart factory + graceful fallback +
   debounce/token on date edits). Held for sign-off: C7 consolidation, C8 nav restructure.

## Where I left off
Implemented Phase 1 Parts 1+2 (additive tokens + 8 `ds-` components) per `/broad-implement Phase 1`;
tests green; CSS well-formed. Deliberately STOPPED before Part 3 (Insights migration) because it's
an unverifiable-here, manual-test-only render rewrite — handed back a recommended approach instead.
Also confirmed access control: non-manager/non-admin domain users land on access-denied with zero
data (Code.gs doGet + per-RPC re-auth); out-of-domain users can't reach the app. Awaiting
commit/push/deploy direction.
