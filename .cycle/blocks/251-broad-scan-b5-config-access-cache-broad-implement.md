---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- CFG-1: `getOverviewParentMap_` takes the FIRST active Dept Config row (the A-3 rule every other accessor follows), so a later duplicate can no longer add or move an access-widening edge.
- PC-4 (owner: skip collisions + warn): an orphan rename skips the From rows on days where the To name already has a row, and reports those days instead of creating a duplicate `(date, agent)` pair.
- DATA-4: on the QCD Neon path, an outage-shaped empty read is flagged, so the 6 h payload put is skipped.
- SEC-3: deleted escalation ids are excluded from every outage-snapshot read, and a failed post-delete refresh is logged and reported instead of swallowed.
- ENG-8: a failed holiday-sheet read is retried once, then serves the sheet's last-good copy, then the property. It is never silently `[]` while a calendar exists.
- DATA-1: roster-hash suffix on the `companyOverview` key.
- DATA-2: roster hash on the `insights` key, so explicit picks move with the roster.
- DATA-10: roster hash on the agent-app keys (the team/me blob tag and `agentHist:v1`).
- DATA-5: `getLatestDataDates` does not cache a blob in which a component came back empty after its Neon read failed (R8-C2, applied per component).
- SEC-4: `ahWaitJoin_` uses PCR-5's quoted, wildcard-escaped LIKE pattern plus a 3000-row ceiling (newest first, flagged).
- SEC-5: the escalation row gate answers "Escalation not found." for a foreign-dept row, the same as for a missing id.
Files modified:
- apps-script/department-dashboard/DeptConfig.gs
- apps-script/department-dashboard/OrphanFix.gs
- apps-script/department-dashboard/script-7-admin.html
- apps-script/department-dashboard/QCDReport.gs
- apps-script/department-dashboard/Config.gs
- apps-script/department-dashboard/Data.gs
- apps-script/department-dashboard/CompanyOverview.gs
- apps-script/department-dashboard/Escalations.gs
- apps-script/department-dashboard/Util.gs
- apps-script/department-dashboard/SystemHealth.gs
- apps-script/department-dashboard/InsightsReport.gs
- apps-script/department-dashboard/AgentHome.gs
- tests/unit/dept-config.test.js
- tests/unit/orphan-rename-neon.test.js
- tests/unit/orphan-rename-race.test.js
- tests/unit/overview-qcd-snapshot.test.js
- tests/unit/escalations-snapshot.test.js
- tests/unit/escalations-hardening.test.js
- tests/unit/util.test.js
- tests/unit/cache-key.test.js
- tests/unit/company-overview.test.js
- tests/unit/dal-cutover.test.js
- tests/unit/agent-home.test.js
- tests/unit/snapshots/ch4-payloads.json
- CLAUDE.md
- docs/invariants.md
- docs/operator-state.md
- docs/next-steps.md
- docs/module-dependencies.md

CHANGES:
CFG-1 | DeptConfig.gs | `getOverviewParentMap_` reads `getActiveDeptConfigMap_()` (first active row per dept) instead of iterating every active row with the last one winning.
PC-4 | OrphanFix.gs, script-7-admin.html | Server:
  - `renameHistoricalAgent_` reads the date column, builds the set of days toName already holds, skips fromName rows on those days, and returns `out.collisionDates`.
  - `applyOrphanRename` puts the days, plus a pointer to the #56 duplicate-merge runbook, into the audit Notes and returns `collisionDates`.
  - An all-collided rename no longer throws "No rows…"; it logs an `alias-add` row when an alias was added.
  Client: the batch apply turns the status `warn`, names the days, and keeps that outlier listed.
DATA-4 | QCDReport.gs, Config.gs, Data.gs, CompanyOverview.gs |
  - `readQcdGrid_` sets `QCD_NEON_FELL_BACK_` when the Neon grid came back null.
  - `qcdFlagEmptyIfOutage_` calls `noteQcdSnapshotReadFailed_` only when that execution fell back, so a reachable empty source is not flagged.
  - Called from `computeDeptQcdSnapshot_`'s three null returns and `computeQcdSnapshots_`'s two empty returns.
  - `resetExecReadFailureFlags_` resets the flag.
SEC-3 | Escalations.gs |
  - New `ESC_SNAPSHOT_DELETED`: a capped list of 200 ids, no PHI, under the registered `ESC_SNAPSHOT_` prefix.
  - `escSnapshotLoad_` filters those ids out.
  - `escSnapshotStore_` and `escSnapshotMaybeRefresh_` now return whether the snapshot was stored; the refresh logs its failure.
  - `deleteEscalation` records the gone ids BEFORE refreshing, logs a refresh that did not land, and returns `snapshotRefreshFailed: true`.
ENG-8 | Util.gs, Config.gs, SystemHealth.gs |
  - `getCompanyHolidayRanges_` retries a failed sheet read once.
  - On a good read it keeps `COMPANY_HOLIDAYS_SHEET_COPY`, written only when the ranges change and deleted when the sheet reads EMPTY.
  - On failure it serves that copy (source `sheet-copy+sheet-error`) before the property, and logs when neither exists.
  - The copy is registered as engine state; the Health hint distinguishes copy from property.
DATA-1 | CompanyOverview.gs | `overviewCacheKey_` ends in `rosterAllDeptsHash_()`. It is the one helper, so every bust site inherits the suffix.
DATA-2 | InsightsReport.gs | The `insights` key ends in `hashAgents_(roster.names)`.
DATA-10 | AgentHome.gs | The agent-home tag (team + me blobs) and the `agentHist:v1` key end in `rosterSetHash_([dept])`.
DATA-5 | Data.gs | `failedSourceEmpty` is set when:
  - the DQE source is neon and `dqe` is null;
  - QCD's Neon max missed and the sheet had nothing;
  - DQE's Neon min missed and the sheet had nothing.
  In any of these cases the blob is served uncached and the event is logged.
SEC-4 | AgentHome.gs | `ahJourneyLikePattern_` is PCR-5's rule, pinned equal to `agentDayLikePattern_`. Also `ORDER BY call_date DESC, call_start DESC LIMIT AH_WAIT_JOIN_MAX_ROWS_+1` (3000), with `out.truncated` set and logged.
SEC-5 | Escalations.gs | The per-dept branch of `escAssertRowAccess_` throws "Escalation not found." instead of "Not authorized for this department." The role check (`assertManagerOrAdmin_`) still runs before any lookup.

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 2367 tests, 2366 pass, 0 fail, 1 skipped.
- INV-16 guard: in sync.
- module-deps: regenerated, `--check` up to date.
- `lint:gas` (CI=true): clean across 76 files in 3 projects.
- `npm run ci:ui` (CI=true): all stages passed.
- 14 bite checks, all BITE:
  - CFG-1: 1
  - PC-4: 1
  - DATA-4: 1
  - SEC-3: 3
  - ENG-8: 3
  - DATA-1: 1
  - DATA-5: 1
  - SEC-4: 2
  - SEC-5: 1
- Old pins updated to the new behaviour:
  - the six "Not authorized for this department" assertions on the escalation row gate;
  - the DD-2 Overview key regex (the key now ends in the roster hash);
  - the CH-4 Health golden, regenerated: the fixture's populated holiday sheet now writes `COMPANY_HOLIDAYS_SHEET_COPY`, so the property inventory and props-store rows list one more engine key.

REGRESSION RISKS:
- The Overview, Insights and agent-app keys change once on deploy, so each takes one cold compute; the Overview key also costs one roster-block read, memoized per execution.
- `escAssertRowAccess_`'s new message also reaches `getEscalationActivity` and `escSnapshotActServe_`, which catch it, so neither changes.
- DATA-5 stops caching only on the neon read sources, and only when a component is empty after a failed Neon read. On the sheet source the behaviour is unchanged.
- ENG-8 writes a Script Property from read paths only when the ranges change. A sheet edited while it is unreadable serves the previous copy until the next good read.
- PC-4 leaves the colliding From rows under the From name, so that outlier stays listed until the merge runbook runs. This is the owner's choice and is surfaced to the admin.

INVARIANTS AT RISK: None.
- INV-01: no new public write. The holiday copy and the deleted-ids list are Script Properties, and the rename stays inside the admin-gated carve-out.
- INV-30 / INV-36: suffixes, not version bumps; the keys stay under 250 characters (pinned).
- INV-38: CFG-1 narrows to the A-3 rule.
- INV-47: the action vocabulary is unchanged; the Notes column now carries the collision days.
- INV-55: the row gate is unchanged apart from its message.

NET SCORE: 1 − 0 = 1. Only DATA-1 would plausibly have fired this month: a roster edit leaves the Overview tiles stale while the chart beside them moves. The rest are latent or structural.

OPERATOR ACTIONS / DEPLOY:
- None new. Optionally, after the deploy, confirm the Health `company-holidays` row still reads `N ranges from sheet`. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy → Manage deployments → New version).
- CDR DQE Pipeline / CDR Reporting Tools / CDR Import: not touched by this batch.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- SEC-4: `detail` does not carry `join.truncated` to the agent app. A capped year only shows "timestamp only" on older rings, and the cap is logged. Surface it in Batch 9 (agent app) if the owner wants it.
- SEC-3: the client's delete toast does not mention `snapshotRefreshFailed`. The id is excluded on serve, so the admin has nothing to do.
- The escalation snapshot still holds patient data at rest in Script Properties (the structural half of SEC-3). That is an owner ruling, not a code fix.

DOCUMENTATION UPDATES NEEDED:
- None remaining. Done in this commit:
  - INV-30 (roster suffixes) and INV-47 (PC-4) in docs/invariants.md;
  - the CacheService-tiers bullet in CLAUDE.md;
  - Operator State #27 (the last-good copy);
  - the docs/next-steps.md Batch 5 row → IMPLEMENTED (block 251).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
