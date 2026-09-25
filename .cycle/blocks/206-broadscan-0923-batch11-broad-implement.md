---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- DATA-1: the B-1 "dept mapping matched nothing" fall-open now judges only the dept's ROSTER rows, so the My Department table, Missed, IR, Insights, Overview and Alerts reach the same verdict on the same data. `unmatchedQueues` no longer lists every other dept's queues.
- S2A-1 (the queue-split half): the digest's week-over-week callout now narrows through the shared helper, like every other DQE reader.
- CRT-2: a duplicate merge now NULLs dqe_history's queue_split and after-hours columns for the merged keys. Before, the upsert's COALESCE kept Neon's pre-merge values.
- S2B-5: under CONFIG_SOURCE=neon, Dept Config saves and deactivates now also write the sheet that cdr-import's capture and cdr-report's audit read. A failed sheet write is a warning, not a failed save.

Files modified:
- `apps-script/department-dashboard/`: Data.gs, IndividualReport.gs, InsightsReport.gs, MissedCallsReport.gs, AgentHome.gs, Digest.gs, DeptConfig.gs, script-7-admin.html
- `apps-script/cdr-report/sheetRepairs.js`
- `tests/unit/`: queue-split, digest-wow, sheet-repairs-merge, dept-config-neon
- CLAUDE.md, and in `docs/`: invariants.md (INV-54), operator-state.md (#25), fix-history.md, module-dependencies.md (regenerated)
- `.cycle/STATE.md`, `.cycle/blocks/195-broadscan-0923-plan.md`

CHANGES:
DATA-1 | Data.gs, IR, Insights, Missed, AgentHome, queue-split.test.js |
- `applyQueueSplitToRows_` collects the observed/matched B-1 evidence only from rows in the set `qsAssessAgentSet_` returns. That set comes from `opts.assessAgents`; or `opts.rowsAreRoster`, which `queueSplitNarrowedCopy_` now always passes (its contract: callers hand it roster rows only); or one `getRosterForDepartment_` read.
- An empty or failed roster assesses every row, which is the old behaviour. Every row is still narrowed.
- The four owning readers pass `roster.names`. The AgentHome "me" detail falls back to the roster read.
- New tests:
  - the mixed-row mismatch case: roster verdict, `unmatchedQueues` scoped, the Overview path agrees;
  - the no-roster fallback;
  - a source pin that every owning reader passes `assessAgents`.
- The new tests fail against the old code.
S2A-1 half | Digest.gs, digest-wow.test.js |
- `computeDigestWowDriver_` collects roster rows in the window, from Neon, or from the sheet through the memoized `sheetFetchDqeRows_` (which carries col AI). The old read was a whole-sheet A..H read.
- It then narrows them via `queueSplitNarrowedCopy_` before building `trendByDate` / `agentTrendByDate`. With the flag off, the rows are untouched.
- The suite loads NeonRead.gs and resets the four DQE memos. New test: off rates 45% all-queue, dept rates 90% own-queue. It fails against the old code.
CRT-2 | cdr-report/sheetRepairs.js, sheet-repairs-merge.test.js |
- Each re-summed write carries its (date, agent) key. After the sheet apply, `scClearNeonMergeExtras_` runs one batched `UPDATE dqe_history SET queue_split = NULL, after_hours_answered = NULL, after_hours_ttt = NULL` for exactly those keys, through `getReachableNeonConn_` (no new Jdbc callsite).
- Best-effort: 'unreachable' / 'error' are logged, with the keys to clear by hand. The result is returned as `neonExtrasCleared`.
- Double-append and already-merged groups are not re-summed, so they are not cleared.
- New test with a fake connection; it fails against the old code.
S2B-5 | DeptConfig.gs, script-7-admin.html, dept-config-neon.test.js |
- `upsertDeptConfigRow_` / `deactivateDeptConfig_` under neon write Neon first (a failure still throws), then mirror to the sheet via `dcMirrorToSheet_`. That returns null on success or a warning string on failure.
- `saveDeptConfig` appends the warning to `warnings`, which the modal already shows. `removeDeptConfig` now returns `warnings` too, and the modal's deactivate status shows them.
- `deactivateDeptConfig_` now returns `{count, warning}`; its only caller is `removeDeptConfig`.
- The suite loads Util.gs (for `sheetSafeCell_`). New tests cover the mirror, the failed-mirror warning, and the unchanged sheet path. They fail against the old code.
Docs | CLAUDE.md, invariants.md, operator-state.md, fix-history.md |
- The queue-split narrowing bullet notes the DATA-1 roster basis.
- The col-AI bullet notes the CRT-2 Neon clear.
- INV-54 no longer calls the alias accessor "SHEET-ONLY"; it names the sheet-only cross-project consumer and the mirror.
- Operator State #25 describes the mirror and what it does not cover (direct Neon edits; Alert/Digest config).
- fix-history has a Batch 11 section.

TEST RESULTS:
- `TZ=America/Chicago node --test`: 1903/1903 pass.
- INV-16 guard: in sync.
- module-deps `--write` then `--check`: up to date.
- `CI=1 npm run lint:gas`: clean (75 files).
- `CI=1 npm run ci:ui`: all stages pass (20/20 layout).

REGRESSION RISKS:
- All four fixes only change behaviour behind a flag that is off by default (`QUEUE_SPLIT_SCOPE`, `CONFIG_SOURCE`) or inside an admin-run repair. With the flags off:
  - `applyQueueSplitToRows_` still returns before any roster read;
  - the digest's rows are identical, now from a span-bounded memoized read instead of a whole-sheet read;
  - the Dept Config writes are unchanged.
- `queueSplitNarrowedCopy_`'s roster-rows contract is prose. Its five callers (Overview ×3, Alerts, Digest) all pass roster rows today; a future caller passing mixed rows would reintroduce the DATA-1 disagreement.
- The AgentHome detail path adds one roster read on a cache miss when the flag is on.

INVARIANTS AT RISK: None.
- INV-53: every row is still narrowed; only the fall-open verdict changed.
- INV-54: the accessors are unchanged; writes now reach both stores.
- INV-01: no new public write path; the sheet mirror rides the existing admin-gated save.
- INV-16: sheetRepairs.js is not a duplicated file.

NET SCORE: 0 − 0 = 0
- All four are latent: nothing fires in production while the flags stay off, and merges are rare.
- These are the prerequisites for flipping the flags.

OPERATOR ACTIONS / DEPLOY:
- If a duplicate merge was ever applied while Neon was mirrored (before this fix), NULL `queue_split` / `after_hours_*` in dqe_history for those (date, agent) keys, or rebuild those dates. The merge log lists the keys. | BLOCKS DEPLOY: N
- Before flipping CONFIG_SOURCE=neon, re-save any dept edited directly in Neon so the sheet copy catches up (Operator State #25). | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from the repo root, then Manage deployments → New version)
- CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
(Not complete in production until the deploy is confirmed.)

FOLLOW-ON ITEMS:
- `queueSplitNarrowedCopy_`'s "roster rows only" contract has no test; a pin on its callers' filters would make it one.
- Direct edits to Neon's dept_config (outside the modal) still do not reach the sheet. A "sync sheet from Neon" editor function would close that.
- Carried:
  - CRT-4 lost-cell channel.
  - S2C-1 agentBusy.
  - The first_agent audit.
  - The callback table.
  - The sub-queue chip warm.
  - The per-user SEC-2 cap.
  - The plan's Deferred list (S2C-2, S2C-5, ING-4, DATA-4).

DOCUMENTATION UPDATES NEEDED: None (done in this batch).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
