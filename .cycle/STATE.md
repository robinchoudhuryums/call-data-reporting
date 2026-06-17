# Cycle State — resume note

**Branch:** `claude/practical-franklin-toyvnp` · working tree has uncommitted broad-implement changes (F1–F6)
**Verify on resume:** `node --test` (128 pass) + `bash scripts/check-duplicated-files.sh` (INV-16 in sync)

## What shipped this session (NOT yet committed/pushed)
Broad-scan audit (3 stages) + broad-implement of findings **F1–F6**:
- **F1 (High):** `backfillInboundCalls` now returns a status object (was `undefined`);
  `mirrorInboundForDate_` honors unreachable/failures so deferred-mode inbound mirror
  can't silently drop unrecoverable `inbound_calls` data. (cdr-import: inboundCalls.js, NeonMirror.js)
- **F2 (Med):** parity gate (`compareDqeSources_`) now diffs the 19 slot + abandoned
  cols (certifies the Missed-Calls Neon reader); range from DQE_PARITY_FROM/TO props.
  `sheetFetchDqeRows_` gained an `includeMissedDetail` opt. (NeonRead.gs)
- **F3 (Med):** `computeNeonReadHealth_()` surfaces NEON_READ_LAST_ERROR in the Alerts
  modal (#al-neon-read line). (NeonRead.gs, Alerts.gs, dashboard.html, script.html)
- **F4 (Med):** LockService on `runAlertsCore_` (real sends) + `sendDigestsForCadence_`
  to prevent duplicate sends. (Alerts.gs, Digest.gs)
- **F5 (Low):** `emptyInsights_` now returns trendDaily + queueHealth (shape parity). (InsightsReport.gs)
- **F6 (obs):** CDR deferred mirror surfaces phone-child count in Pipeline Health note.
  NOTE: the "silent data loss" framing did NOT reproduce — phone failures already
  throw+requeue; this was an observability gap only. (NeonMirror.js)

Tests: 128/128 pass; INV-16 clean; all edited files node --check clean. No invariants at risk.

## OPEN / next steps
1. **Commit + push** the F1–F6 changes (not yet done).
2. **Deploy:** Department Dashboard (`clasp push -f` + new version) AND CDR Import
   (`cd apps-script/cdr-import && clasp push -f`). CDR Report NOT needed.
3. **/sync-docs:** CLAUDE.md NeonMirror gotcha (mirrorInboundForDate_ return contract)
   + Operator State (new Alerts read-back line F3, DQE_PARITY_FROM/TO props F2).
4. **Remaining audit findings (not implemented):** F7 (Insights Neon-ext divergence),
   F8 cluster (predicate inlining, removeDeptConfig stamp, testConnection close, cache-key
   suffix, backfill resume index), F9/F10/F11, dead code (insMetricPerDay_).

## Where I left off
Implemented F1–F6 per /broad-implement; tests green; answered the user's spreadsheet-
topology question (web app depends on ONE spreadsheet — the CDR Report workbook — plus
optional Neon; DQE Report legacy spreadsheet is separate and slated for decommission).
Awaiting commit/push/deploy direction.
