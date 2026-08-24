---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- HF-0 | JDBC fail-fast timeouts on EVERY Neon connection builder (the prerequisite: without
  bounded connects, the fallback's trigger condition — a Neon FAILURE — never fires during a
  hang; the hang burns the 6-min ceiling whose kill skips catch blocks).
- HF-1 | 'Inbound Calls' export tab schema extension: Call Start + Is Internal (cols 16-17),
  with the K-AC-class coercion protections on the time-shaped column.
- HF-2 | Scheduled daily export + retention prune (menu-installed trigger, `inboundExport`
  Pipeline Health rows, log-only on Neon-down).
- HF-3 | The heatmap SHEET FALLBACK itself: getInboundHeatmap degrades to the export tab on
  any Neon failure, mirroring the SQL's bucketing + two-arm dept attribution; never cached;
  disclosed via meta.fallbackSource/fallbackThrough.
- HF-4 | Client: fallback caption below the legend + drill suppression (cell drill stays
  Neon-only).

Files modified:
- apps-script/department-dashboard/NeonRead.gs               (HF-0: timeout params)
- apps-script/cdr-report/neonWrite.js                        (HF-0; INV-16 pair)
- apps-script/cdr-import/neonWrite.js                        (HF-0; byte-identical copy)
- apps-script/cdr-report/dbHistorical.js                     (HF-0)
- apps-script/cdr-report/neonbackfill.js                     (HF-0 — found by the new sweep)
- apps-script/department-dashboard/OrphanFix.gs              (HF-0 — found by the new sweep)
- apps-script/cdr-report/inboundCallsExport.js               (HF-1 + HF-2)
- apps-script/cdr-report/CDR Tools menu.js                   (HF-2: menu items)
- apps-script/department-dashboard/InboundReport.gs          (HF-3)
- apps-script/department-dashboard/script-9-inbound-direct.html (HF-4)
- tests/unit/cross-file-pins.test.js                         (+1 test: HF-0 pin + sweep)
- tests/unit/heatmap-fallback.test.js                        (NEW, 8 tests)
- tests/unit/inbound-export.test.js                          (NEW, 7 tests)
- CLAUDE.md, docs/operator-state.md (#49), docs/invariants.md (INV-44 vocab),
  docs/known-issues.md (fallback limits entry)

CHANGES:

HF-0 | 5 connection builders (6 files) | Every `jdbc:postgresql://` URL now carries
`?connectTimeout=10&socketTimeout=120&loginTimeout=10`. Rationale: the 2026-08-24 queue-report
incident — a runDailyQueueReport_ execution hung 5+ min on a Neon connect; the 6-min kill
skips catch blocks, so no result property, no flag, no email, and every "fall back on error"
path (including this increment's fallback) was unreachable. cross-file-pins.test.js pins the
params in all listed files AND sweeps apps-script/ for unlisted Jdbc.getConnection callsites —
the sweep immediately found TWO builders the plan missed (neonbackfill.js, OrphanFix.gs's
renameAgentInNeon_), both patched. socketTimeout=120 bounds a wedged read well under the
6-min ceiling while leaving headroom for the slowest legitimate json_agg reads.

HF-1 | inboundCallsExport.js | INBOUND_EXPORT_HEADERS grew to 17 (Call Start = raw PST
'HH:MM:SS'; Is Internal = TRUE/FALSE), APPENDED so existing pivots don't shift; the export SQL
fetches both (COALESCE'd) in header order; is_internal booleans normalize to strings.
Coercion protections on the time-shaped column (the K-AC class): '@' format over the current
height (sort-safe) AND the exact write range, with the grid PRE-EXPANDED via insertRowsAfter
so an append can never spill past getMaxRows unformatted (the buildDQE recurrence vector).
Pre-extension tabs (15 cols) are widened + reheadered before any col-16 range is touched
(REP-10). exportInboundCalls now returns {written, replaced} for the runner's health row.

HF-2 | inboundCallsExport.js + CDR Tools menu.js | runInboundCallsExport_ (daily trigger, 9 AM
script-TZ): incremental export + ic_pruneOldRows_ (keeps INBOUND_EXPORT_KEEP_DAYS days,
default 400 — the tab is date-ascending so the prune is one head-block deleteRows), one
`inboundExport` Pipeline Health row per run. Neon-down is the EXPECTED failure: log-only
failure row, never an email (the copy just stays at its last good date — which is the whole
point of a fallback copy). Menu: install/uninstall submenu + "Refresh Inbound Calls Tab Now".
The retention-prune pattern deliberately — no *_ENABLED flag, so no svc() readiness row.

HF-3 | InboundReport.gs | inboundHeatmapSheetFallback_ wired into getInboundHeatmap's three
failure branches (conn null / null result / catch). ihSheetHeatmapCells_ reads the tab via a
widening TAIL scan of col A (the F-20 discipline — a recent window costs O(recent)), then
buckets the covered block with the SAME INBOUND_HEATMAP_* constants the SQL is built from
(+2h shift with %86400 midnight wrap, 8–17 window, hourly slots, weekday filter, call_start
regex, is_internal exclusion). ihRowInDept_ mirrors inboundDeptPredicate_'s two-arm
attribution exactly: on-hold-answered by Final Dept label (same guarded accessors), everything
else — plus unmapped-label on-hold calls, the union fallback — by entry queue,
case-insensitive both sides (B-4). Fallback payloads are NEVER cached (a recovered Neon must
not be masked for the TTL) and set meta.fallbackSource='sheet' + fallbackThrough (the tab's
newest date). A missing or pre-extension tab keeps the old behavior (available=false → the
panel hides). The CELL DRILL deliberately does not fall back — its "↳ path" journey is
irreducibly Neon.

HF-4 | script-9-inbound-direct.html | renderAbandonHeatmap_ reads meta.fallbackSource: cells
render but the drill affordance is suppressed (no data-dow/tabindex, so the delegated handler
never fires), and a `.ds-note` caption below the legend says "Served from the sheet fallback
copy … data through <date> … cell drill unavailable". Inert on all existing payloads (no
fallbackSource) — the ci:ui fixtures and the deliberate unmocked-getInboundHeatmap audit are
unchanged.

Tests | +16 (854 → 870). heatmap-fallback.test.js (8): the full fallback payload from a
fixture tab with boundary rows on BOTH window edges + every guard (blank call_start, internal,
weekend, out-of-range date); the two-arm attribution incl. the mutually-exclusive-arms case
(a label mapped in ANOTHER dept's list must NOT fall back to its entry queue) and the union
fallback; company view unfiltered; a query-throw (not just conn-null) degrading to the sheet;
missing/15-col tab hiding as before; the healthy Neon path never touching the sheet and still
caching; the cell drill NOT falling back; the INBOUND_HEATMAP_* constants pinned so the
boundary fixtures re-derive on a constant change. inbound-export.test.js (7): the 17-col
schema contract + SQL field order; boolean normalization; the '@'-format + pre-expand
discipline; the REP-10 widen path; the prune's head-block-only delete + property override;
the runner's log-only failure and success rows. cross-file-pins (+1): HF-0 above.

TEST RESULTS: PASSED — 870/870 (was 854). INV-16 guard green (neonWrite pair re-synced).
`npm run ci:ui` FULL GATE PASSED (all six asserting stages; drive-smoke 20/20) — required,
script-9-inbound-direct.html changed. CLAUDE.md split/ratchet guards green (heatmap bullet
4,116 B → within budget after the sentence; verified by the suite). node --check clean on
every edited .gs/.js.

REGRESSION RISKS:
- socketTimeout=120 (HF-0) would abort a legitimate Neon statement running >120s. Survey of
  callers: every read is a single json_agg fetch measured in seconds (the 20-min per-row
  pattern was eliminated by F1), writers chunk statements; the known-slow cold-start is a
  CONNECT cost, bounded separately at 10s + the 5s probe. Residual risk accepted and
  documented in the bullet; the symptom would be a clean error row, not silence.
- The fallback's attribution mirror can drift from inboundDeptPredicate_ (the
  dataFilters-sidebar class). Mitigated, not eliminated: shared constants + the boundary-pin
  suite; the known-issues entry names the suite as the change-gate.
- getInboundHeatmap's conn-null path now opens the spreadsheet (one openById per failed
  request, uncached). Bounded: heatmap requests are per-panel-load, and the tail scan is
  O(recent window).

INVARIANTS AT RISK: None violated. INV-01 clean (fallback is read-only; the export writes
live in cdr-report, not RPC-reachable). INV-16 pair re-synced (guard green). INV-18 (the
heatmap band) is what the mirror pins. INV-44 vocabulary extended (`inboundExport`) in
docs/invariants.md. INV-30: no cache-rule change — fallback payloads are deliberately
uncached; the healthy path's key is untouched.

NET SCORE: 1 − 0 = +1
  (HF-0 fixes the hanging-connect class that DID fire in production this month — the silent
  queue-report day. The fallback itself is resilience for the ongoing outage class; no new
  failure mode identified beyond the documented socketTimeout residual.)

OPERATOR ACTIONS / DEPLOY:
- Deploy all three projects (dashboard + cdr-report + cdr-import — HF-0 touches all three;
  the INV-16 pair must ship together). | BLOCKS DEPLOY: N (but partial deploys leave some
  builders un-timeouted)
- CDR Report spreadsheet → CDR Tools → "⏰ Daily Inbound Export Trigger" → Install. | BLOCKS
  DEPLOY: N
- ONE-TIME, once Neon is reachable again: run `exportInboundCalls('<capture-start-ISO>',
  '<today-ISO>')` from the cdr-report editor so historical rows gain Call Start / Is Internal
  — until then the fallback only covers rows exported after this deploy. (Capture start =
  the earliest date in Neon inbound_calls; any earlier is harmless.) | BLOCKS DEPLOY: N
- Live smoke (Regression Scenarios are the verification of record for UI/live): after deploy,
  load Insights as admin with Neon down (or before recovery) and confirm the heatmap renders
  from the sheet with the caption; after recovery, confirm it reverts to live + drillable.
  Walks S38's heatmap leg. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`;
CDR Reporting Tools/DQE Pipeline: `cd apps-script/cdr-report && clasp push -f`;
CDR Import: `cd apps-script/cdr-import && clasp push -f`.

FOLLOW-ON ITEMS:
- The Insights/Inbound heatmap is the ONLY Neon surface with a sheet fallback; the Inbound/
  Direct/Outbound reports and Caller Lookup still render "unavailable" during an outage (by
  design — they have no sheet source). No action unless the owner wants more fallbacks.
- The long-term Neon-ceiling fix (paid tier or egress reduction via the Health page's MTD
  gauge) remains the real remedy; this increment is mitigation.
- Unchanged ledger: Outbound release runbook (deploy → backfillOutboundCalls →
  runOutboundVettingCheck → release on 'ok'), 08/20 backfills before ~Sep 3, coaching arming.

DOCUMENTATION UPDATES NEEDED:
- Applied in this change: CLAUDE.md (heatmap bullet fallback sentence; Neon-guard bullet
  JDBC-timeout rule + its enforcement name; Operator State index line 49),
  docs/operator-state.md #49, docs/invariants.md INV-44 `inboundExport` vocabulary,
  docs/known-issues.md "Heatmap sheet fallback: honest limits". Nothing further.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
