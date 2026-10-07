---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Batch C / C1 (owner plan 2026-10-06): an editor-run, read-only probe comparing CDR Historical Data's day-level outbound counts per agent with the per-call outbound_calls data, ending CLEAN / MISMATCH / INCONCLUSIVE / FAILED.
Files modified: apps-script/department-dashboard/OutboundReport.gs, apps-script/department-dashboard/Config.gs, tests/unit/outbound-source-probe.test.js (new), tests/README.md, docs/operator-state.md, CLAUDE.md (Operator State index #74), docs/module-dependencies.md (regenerated)

CHANGES:
C1 | OutboundReport.gs | probeOutboundSourceAgreement() is admin-gated first and read-only. It is built from:
  - obSrcColumns_: header-resolved columns ('OB External Total' / 'OB External Answered' / 'OB External Total Duration'), with the INV-52 positions as fallback; the log names which was used.
  - obSrcReadSheet_: span-bounded on the date column, keeps the per-row date filter, reads DISPLAY values (INV-02 for the duration column), and sums per agent-day.
  - obSrcReadNeon_: one bound, grouped json_agg over outbound_calls; selects no hash, call id or journey; egress label 'outbound-source'.
  - obSrcCompare_ (pure): the verdict.
  - obSrcWindow_: default 28 days ending at the latest captured date; floored at 2026-07-10; capped at 92 days.
  - The verdict is PRE-REGISTERED on PLACED counts only. CLEAN needs all three:
    - at least 95% of agent-days within max(1 call, 5%);
    - company totals within 3%;
    - agent-days present on one side only at 10% or less.
  - Duration and connected are logged side by side but never voted on. The sheet sums leg duration (ring included) and counts legs of 20 s or more; Neon stores talk time and talk > 0.
  - Dates present on only one side are coverage gaps: they are listed and left out of the comparison.
  - INCONCLUSIVE when fewer than 20 agent-days are compared, or when coverage gaps exceed 20% of dates. FAILED when Neon is unreachable or the sheet is missing.
C1 | Config.gs | OUTBOUND_SOURCE_FROM / OUTBOUND_SOURCE_TO registered as 'tool' properties in PROP_REGISTRY_; the probe self-clears them on a CLEAN run only.
C1 | tests + docs | New suite outbound-source-probe.test.js (12 tests). Operator State #74 is the runbook, with its CLAUDE.md index line. tests/README map entry added; module-deps regenerated, since OutboundReport now uses NeonCoverage's ncCellDateIso_.

TEST RESULTS: passed.
  - npm run ci: 2219/2219, INV-16 in sync, module-deps up to date.
  - lint:gas: clean.
  - ci:ui under CI=1: all stages green.
  - Bite checks: all six bite (placed-only vote, minimum agent-days, coverage-gap exclusion, one-sided gate, per-row date filter, capture-start floor).
  - Fixed during the run (caused by this session): the R46 harness pin rejected a fixture pinned to the script timezone. Its dates are plain strings, so the option was dropped.
REGRESSION RISKS: None for existing behaviour. The probe is additive, editor-run and read-only; no payload, cache or UI changes. OutboundReport.gs now calls ncCellDateIso_ (NeonCoverage.gs, same project, always loaded in production).
INVARIANTS AT RISK: None.
  - INV-01: no write; the self-clear of tool properties follows the established convention.
  - INV-02: duration read as display values.
  - INV-52: header-resolved columns with positional fallback.
  - The dated-sheet span rule: span-bounded, with the per-row filter kept.
  - Egress label present.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (diagnostic tool, owner-requested)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard, then run probeOutboundSourceAgreement() once in the dashboard editor and send me the verdict line plus the [outbound-source] log lines (Operator State #74) | BLOCKS DEPLOY: N (it blocks the Batch D source decision)
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- Batch D: read placed from the sheet on CLEAN, or Neon with the Outbound Calls tab fallback on MISMATCH. Talk time and connects come from Neon in either case, since the sheet's definitions differ.
- On CLEAN, the Batch B strip's outbound count could move to the sheet, removing its small grouped Neon query.
- One-sided agent-days in the result would point at the #72 per-call name rewrite.

DOCUMENTATION UPDATES NEEDED:
- None beyond those made in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
