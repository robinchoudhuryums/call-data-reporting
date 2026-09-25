---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- FO-DATA-5: IndividualReport and InsightsReport now read the DQE window through the memoized `sheetFetchDqeRows_` (R40) instead of private span reads.
- FO-DATA-6: `getOrphanFixInit` walks the rosters once, not twice.
- DOC-1: INV-01 carve-out list now includes the answer targets, the Queue Report subscribers and the Alert Log writers.
- DOC-2: conventions.md Access Control section describes the multi-row / ALL / INV-38 / agent-role model.
- DOC-3: corrected "Queue Split cannot be backfilled"; it can be, by re-import.
- DOC-4: report-cache TTL claims changed from 30 min to 6 h everywhere.
- DOC-5: module-dependencies prose now says `--check` runs in CI and quotes no stale counts.
- DOC-6: drive-admin covers nine modals; the exemptions are Inbound and Direct.
- DOC-7: `OVERVIEW_PARENT_OF` docblock says it is a seed default that grants access and shapes rollups.
- DOC-8: Operator State #46 index line fixed.
- DOC-9: architecture.md and the README list all write paths and the current Access Control columns.
- DOC-10: next-steps.md row 6 status corrected.
- DOC-11: fix-history gains a third collision note ("Batch N" means a roadmap batch or a broad-scan batch).
- DOC-12: QCDReport comments point at `getDeptQcdQueues_` and describe the all-dept report as manager+admin; known-issues new-dept runbook now goes through Dept Config.
- DOC-13: neonbackfill.js no longer claims the live CDR writer uses DO NOTHING.
- DOC-14: `scripts/deploy.sh` records a dirty-tree deploy as `<sha>+dirty`, so a later clean run of the same HEAD is not skipped.
- DOC-15: count drift fixed: SystemHealth said four flag-gated engines (eight), README said S1–S44 (S47), 14 vs 16 depts, and six files missing from the architecture table.
- SEC-6: accepted-PHI note for `ESC_SNAPSHOT_*` (Operator State #24(c) plus an Escalations.gs comment).

Files modified:
- Dashboard server: `apps-script/department-dashboard/` IndividualReport.gs, InsightsReport.gs, OrphanFix.gs, QCDReport.gs, SystemHealth.gs, Code.gs, CompanyOverview.gs, Config.gs, Escalations.gs, CacheWarm.gs, DirectCallReport.gs, InboundReport.gs, MissedCallsReport.gs, Data.gs, DeptConfig.gs, Util.gs.
- cdr-report: `apps-script/cdr-report/neonbackfill.js`.
- Scripts: `scripts/deploy.sh`.
- Tests: `tests/unit/` dqe-span-readers, digest-insights, individual-report, insights-report, orphan-roster-add.
- Docs: CLAUDE.md, README.md, `tools/ui-harness/README.md`, and in `docs/`: invariants, conventions, architecture, module-dependencies, next-steps, known-issues, operator-state, fix-history.
- Cycle: `.cycle/STATE.md`, `.cycle/blocks/195-broadscan-0923-plan.md`.

CHANGES:
FO-DATA-5 | IndividualReport.gs, InsightsReport.gs, 4 test files | Both reports get their deptQueueExts from `deptQueueExtsFromSheet_` (whole sheet, INV-53) and their rows from `sheetFetchDqeRows_(fetchFrom, fetchTo)`, which is memoized with a shallow clone per caller. Tests load NeonRead.gs and reset all four DQE memos. New pin: two depts over one window cost ONE wide read. Bite-checked. `computeActiveAgentsInRange_` and Alerts were left on the span on purpose, because the shared full-width read would cost them more.
FO-DATA-6 | OrphanFix.gs, orphan-roster-add.test.js | `collectAllRosterNames_()` is called once and fed to both `computeOrphans_` and the payload. Pinned and bite-checked.
DOC-1 | docs/invariants.md, CLAUDE.md | INV-01 carve-outs are complete.
DOC-2 | docs/conventions.md | Managers entry now has the Role / Agent Name columns, multi-row, ALL and INV-38.
DOC-3 | docs/invariants.md, Config.gs, CLAUDE.md | "Backfilling past ~14 days is an operator job" (re-import the source).
DOC-4 | the six report file headers, inline comments in 7 .gs files, README, INV-35/54 | 30 min changed to 6 h, with the freshness-tag note.
DOC-5 | docs/module-dependencies.md, CLAUDE.md | CI `--check` is stated; no stale counts.
DOC-6 | CLAUDE.md, tools/ui-harness/README.md | Nine driven modals; the Inbound and Direct exemptions.
DOC-7 | CompanyOverview.gs | OVERVIEW_PARENT_OF docblock rewritten.
DOC-8 | CLAUDE.md | #46 index line.
DOC-9 | docs/architecture.md, README.md | Write-path table (addOrphanToRoster, the Neon rename mirror) and the Access Control columns.
DOC-10 | docs/next-steps.md | Row 6 reads "6a/6b/6d done; 6c release pending (#63)".
DOC-11 | docs/fix-history.md, CLAUDE.md | Third collision: roadmap "Batch N" vs broad-scan "Batch N".
DOC-12 | QCDReport.gs, docs/known-issues.md | Comments route through getDeptQcdQueues_ / getOverviewParentMap_; the all-dept report is manager+admin; new-dept onboarding goes through the Dept Config modal (no redeploy).
DOC-13 | cdr-report/neonbackfill.js | The live CDR writer has used DO UPDATE (name lists included) since IMP-4; the backfill repairs every date from the sheet.
DOC-14 | scripts/deploy.sh | Dirtiness is captured before the build-stamp write; `record_deploy` writes `<sha>+dirty` for a dirty tree; the skip guard uses the captured flag.
DOC-15 | SystemHealth.gs, README.md, CLAUDE.md, docs/architecture.md, Code.gs | "Eight" engines; S1…S47; 16 roster depts vs 14 visible; the architecture table gains AgentDay.gs, execCeilingProbe.js, qcdDqeDiagnostic.js, both propRegistry.js files and sheetSpace.js; the holiday comment reflects H1 (the sheet first, the property as fallback).
SEC-6 | docs/operator-state.md, Escalations.gs | PHI in `ESC_SNAPSHOT_*` accepted by owner ruling. The standing condition is that the org's Workspace BAA covers Apps Script. Keep editors to admins; the inventory shows keys only.
Also | CLAUDE.md R41 bullet | Only `computeActiveAgentsInRange_` and Alerts still use `dqeWindowRowSpan_`, and the bullet says why.

TEST RESULTS:
- `TZ=America/Chicago node --test`: 1896/1896 pass.
- INV-16 guard: in sync.
- module-deps `--write` then `--check`: up to date.
- `CI=1 npm run lint:gas`: clean (75 files, 3 projects).
- `CI=1 npm run ci:ui`: all stages pass (20/20 layout checks).
- `deploy.sh` was only syntax-checked (`bash -n`); it has no automated test.

REGRESSION RISKS:
- IR and Insights now share the per-execution DQE row memo. A mutation of a returned row array would leak, but the memo returns a shallow clone per caller and `slots` is only ever assigned (the R40 rule), so this is safe.
- A test suite that loads IR or Insights without NeonRead.gs, or without the four memo resets, fails loudly or serves stale fixtures. All current suites are updated, and cross-file-pins enforces the resets.
- deploy.sh uses `local` inside a function, which is valid in bash; the script is bash (shebang).
- Everything else is comments and docs only.

INVARIANTS AT RISK: None.
- INV-53: the ext derivation still reads the whole sheet.
- INV-16: neonbackfill.js is not in a byte-identical pair, and its function-level sanitize copies are untouched (the guard passes).
- INV-01: no new write path.

NET SCORE: 1 − 0 = 1
- DOC-14 is a real hazard: a clean re-run after a dirty deploy was being skipped.
- The DATA-5/DATA-6 follow-ons are per-request cost savings, not bugs that fire.
- The docs fixes do not fire in production.

OPERATOR ACTIONS / DEPLOY:
- SEC-6 condition: confirm that the org's Google Workspace BAA covers Apps Script (it is listed among HIPAA Included Functionality). If it does not, the escalation snapshot must move or be switched off. | BLOCKS DEPLOY: N
- Existing `.last-deployed` files keep the bare sha. A tree that was dirty at its last deploy should be redeployed once with FORCE=1 to be safe. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from the repo root, then Manage deployments → New version).
- CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (comment-only change; it can ride the next push).
(Not complete in production until the deploy is confirmed.)

FOLLOW-ON ITEMS:
- Carried, unchanged:
  - CRT-4 lost-cell channel through the INV-16 dup-guard / deferred mirror.
  - S2C-1 agentBusy (needs live evidence).
  - The first_agent audit.
  - The callback table (`outboundReport:v5`).
  - The chip warm for sub-queue parents.
  - The SEC-2 cap is per user only.
- Batch 11 (flag-flip prerequisites) is next, and carries S2A-1's queue-split half.

DOCUMENTATION UPDATES NEEDED: None (this batch was the docs batch).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
