---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- A-1 | Dept Config → Neon migration helpers dropped `finalDeptLabels` (backfill wrote '' into col 11; parity gate omitted the field and printed PARITY CLEAN over the loss)
- G-1 | IR/Insights sub-queue picker groups never rendered — all four client roster-cache writers dropped the server-sent `subQueueGroups`
- C-1 | Inbound/outbound zero-record cleanup deleted the expected date's rows when the source grid yielded ONLY stray-dated records (wrong-day-grid signature) — now refuses with `allStray`
- C-2 | Daily import swallowed the delete-only pass's `unreachable`/`cleared` outcomes (no Pipeline Health row, toast stayed ok) — all outcomes now surfaced, incl. the new allStray refusal (failure row + email)
- B-1 | Direct report company view collapsed a crossover agent under `max(department)` — now GROUP BY (agent_name, department); `directCall:v2` → `v3`
- B-3 | `getOverviewChartTrend` cached outage-empty / config-degraded payloads for 30 min — now skips the put per the R8-C1/R8-C4 discipline
- E-2 | My Department missed section silently hid itself on fetch failure — now renders an inline error + Retry

Files modified:
- apps-script/department-dashboard/DeptConfig.gs (A-1)
- apps-script/department-dashboard/script.html (G-1 ×4 sites, E-2)
- apps-script/department-dashboard/dashboard.html (E-2 error container)
- apps-script/department-dashboard/DirectCallReport.gs (B-1 + cache v3)
- apps-script/department-dashboard/CompanyOverview.gs (B-3)
- apps-script/cdr-import/inboundCalls.js (C-1 gate + backfill failure class)
- apps-script/cdr-import/outboundCalls.js (C-1 gate + backfill failure class)
- apps-script/cdr-import/autoImport.js (C-2: 3 new branches per capture block)
- tests/unit/dept-config-neon.test.js (A-1 fixture + 3-part pin)
- tests/unit/inbound-calls.test.js, tests/unit/outbound-calls.test.js (C-1 pins)
- CLAUDE.md, docs/invariants.md, docs/architecture.md, docs/conventions.md, docs/known-issues.md, docs/direct-extension-metrics-design.md (directCall v3 sync; INV-30 v3 entry)

CHANGES:
A-1 | DeptConfig.gs | backfillDeptConfigToNeon's record + compareDeptConfigSources' parity key both carry finalDeptLabels; save path was already correct
G-1 | script.html | ensureIrRoster / scheduleActiveAgentRefetch_ / insEnsureRoster / insScheduleActiveRefetch_ persist data.subQueueGroups into the roster caches the renderers read
C-1 | inboundCalls.js, outboundCalls.js | zero-record delete-only pass additionally gated on strayCount===0; all-stray returns {allStray, strayCount}; both editor backfills classify allStray as a per-date failure
C-2 | autoImport.js | inbound + outbound blocks gained unreachable (failure row + unreachable toast), allStray (failure row + email + error toast), and cleared (success row, rows:0) branches ahead of the old skipped/inserted chain
B-1 | DirectCallReport.gs | agents sub-select: department AS dept + GROUP BY agent_name, department; DIRECT_CALL_CACHE_KEY_PREFIX → directCall:v3; four doc tables synced
B-3 | CompanyOverview.gs | getOverviewChartTrend skips cache.put when deptConfigReadFailed_() or dqeRows is empty despite a known latestDate (outage shape)
E-2 | script.html, dashboard.html | new #dept-missed-error note + Retry; failure path keeps the section visible and hides only its content; fetch start clears the error and restores the chart row it hides

TEST RESULTS: passed — node --test 615/615 (was 612; +3 new pins), INV-16 guard clean, and the FULL rendered-UI gate ran locally (playwright installed into tools/ui-harness): all stages passed — drive-smoke (both roles incl. view-as), drive-f13 (S39 keyboard walk), drive-subqueue 31/31 (S35 addendum / S43 CSV), drive-devoverlay 14/14. Regression scenarios overlapping the changed subsystems that require a LIVE deployment (S1/S2/S4/S13/S23/S28/S33/S36/S37/S38) are NOT APPLICABLE in this container (no Apps Script/Sheets/Neon); walk S36 (Dept Config round-trip), S38 (inbound capture), and the IR/Insights picker after deploy, and run runLiveSmoke per the standing post-deploy rule.

REGRESSION RISKS:
- C-1 makes the cleanup CONSERVATIVE: a legitimately-zero day whose grid carries ≥1 stray carry-over record now keeps its stale Neon rows until a retry/re-import instead of clearing them — deliberate loss-asymmetry trade-off (stale rows are recoverable, a wrong delete is not), and never silent (failure row + email).
- B-1 changes the company-view agents payload shape semantically: a crossover agent now appears once per dept (was once total). Client card grouping, flat single-dept table, CSV, and server post-processing were all verified row-generic; kpis.agents stays count(DISTINCT agent_name). Cache bump prevents mixed-shape serving.
- G-1 makes the previously-unreachable subqPickerScope_ mixed-selection refusal reachable — verified it is a clean form error, and a sub-queue-confined pick routes to that dept, which the INV-38 Phase-0 access widening already authorizes server-side.
- E-2's failure path hides the chart row; the retry/fetch path restores it (nothing in the render path touches that display — restored at fetch start, verified).

INVARIANTS AT RISK: None violated. INV-30 followed (directCall v3 bump + all doc tables synced; cache-version-sync + claude-md-split guards green — the CLAUDE.md per-bullet ratchet forced the v3 annotation into docs/invariants.md, which is the intended shape). INV-16 untouched (no duplicated-pair files changed; guard clean). INV-44 respected (new Pipeline Health rows reuse the existing step names + status vocabulary). INV-01/55 untouched.

NET SCORE: 2 − 0 = 2
(G-1 and B-1 were live this month — every parent-dept manager's picker and any company-view Direct report with a crossover agent; A-1/C-1/C-2/B-3/E-2 are latent/conditional hardening and are not counted as fired-this-month, though A-1 sat directly on the README's instructed migration runbook.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the Department Dashboard as a NEW VERSION (Operator State #2 — clasp push alone does not update /exec) | BLOCKS DEPLOY: Y
- Deploy cdr-import | BLOCKS DEPLOY: Y
- If backfillDeptConfigToNeon was EVER run with the old code, re-run it + compareDeptConfigSources after deploying (Neon's final_dept_labels are currently blank from the old backfill); skip if the migration was never started | BLOCKS DEPLOY: N
- No new Script Properties, OAuth scopes, sheets, or triggers.
Deploy: scripts/deploy.sh . <dashboard-deployment-id> ; scripts/deploy.sh apps-script/cdr-import <cdr-import-deployment-id> (cdr-report and dqe-report unchanged)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Remaining audit findings, roughly by impact: C-3 (deleteOldCDRSheets retention has no in-repo installer/trigger — the 14-day window everything assumes is unverifiable), C-5 (Direct force-path zero-row loss guard per the S2-2 rule), B-2 (SmokeCheck/NeonCoverage must become DQE_READ_SOURCE-aware before any sheet trim), B-5 (ALL-sentinel managers resolve as no dept's alert recipients), G-2 (export button strandable at "Capturing…"), G-3 (IR hardcoded 95% goal line vs the tunable 92% standard), F-5/F-6 (fakeSheet can't enforce REP-10 or the setNumberFormat coercion protections), F-10 (deploy.sh doesn't run ci:ui), D-1/D-2 (Custom Report Builder width throw; dataFilters sidebar unescaped innerHTML), A-2/A-3/A-4/A-5, B-4/B-6/B-8, C-6..C-9, D-3..D-7, E-1/E-3..E-10, G-4..G-8, F-8/F-9/F-11.
- Add a ui-harness assertion that the IR/Insights picker renders the sub-queue groups from a payload that carries them (the G-1 class: server-sent fields silently dropped client-side).
- tools/ui-harness playwright installs cleanly in this container class (root package.json pollution reverted; harness .gitignore covers its package files) — prior "will not install" notes are stale.

DOCUMENTATION UPDATES NEEDED:
- /sync-docs pass for the audit's doc-drift findings not touched here: CLAUDE.md INV-38 index line (F-3, security-relevant), the "three public write surfaces" gotcha bullet (A-6), the phone-child chunking + counts.neon sentences (C-4), the 38/39-vs-42 operator-item and 40-vs-43 scenario counts (F-1/F-2), tests/README's summary:v8 (F-4).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
