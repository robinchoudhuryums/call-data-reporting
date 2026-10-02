---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- CH-1 (Med) -- the Diagnostics.gs operator tools are public (visible in the editor's Run dropdown) and admin-gated
- CH-2 (Low) -- invalidateAuthCache_ deleted (unrunnable from the editor, unreferenced, superseded by the Access Control modal's own bust)
- CH-3 (Low) -- three dead helpers deleted: yesterdayIso_ (Alerts.gs), ekDashUrl_ (EmailKit.gs), escRowDepartment_ (Escalations.gs)
- CR-8 (Low) -- the sheetRepairs.js date-normalize docblock no longer prescribes the R46 bug
- DX-1, DX-2, DX-3, DX-4, DX-5, DX-7, DX-8, DX-9, DX-10, DX-12 (Low) -- one docs-truth pass
- DX-6 (Low) -- CLAUDE.md back under 85% of its cap (90.2% -> 84.8%)

Files modified:
- apps-script/department-dashboard/Diagnostics.gs, Auth.gs, Alerts.gs, EmailKit.gs, Escalations.gs, BuildStamp.gs
- apps-script/cdr-report/sheetRepairs.js
- tests/unit/diagnostics-tools.test.js (new), tests/unit/cross-file-pins.test.js (comment), tests/README.md
- CLAUDE.md, README.md
- docs/conventions.md, docs/known-issues.md, docs/invariants.md, docs/next-steps.md, docs/fix-history.md,
  docs/operator-state.md, docs/client-ui-conventions.md, docs/module-dependencies.md (regenerated)

CHANGES:
CH-1 | Diagnostics.gs | diagnoseDate_, whyNoMatches_, diagnoseTimes_, dumpCell_, diagnoseAbandoned_ renamed without the `_` (the editor's Run dropdown hides private functions, so the tool the docs name -- whyNoMatches_ -- could not be picked); each now opens with assertAdmin_() since un-suffixed means RPC-reachable. They only read and Logger.log (INV-01 untouched). The scan said "four"; there were five, all hidden the same way. Helpers typeOfCell_/formatHms_/columnLetter_ stay private.
CH-1 | docs/conventions.md, known-issues.md, invariants.md (INV-23), cross-file-pins comment | references updated to the new names.
CH-1 | tests/unit/diagnostics-tools.test.js | Pins: every public function in Diagnostics.gs is in the tool list, none is `_`-suffixed, and each refuses a non-admin before reading the workbook. Bites against HEAD and with one gate removed.
CH-2 | Auth.gs | invalidateAuthCache_(email) deleted: an argument-taking `_` function cannot be run from the editor, nothing called it, and the Access Control modal already busts `access:<email>` on save (a hand-edit waits at most AUTH_CACHE_TTL_SECONDS = 60 s).
CH-3 | Alerts.gs, EmailKit.gs, Escalations.gs | yesterdayIso_ (server copy; agentApp.html's client copy is live and kept), ekDashUrl_, escRowDepartment_ deleted -- confirmed unreferenced across all projects + tests; lint-gas clean.
CR-8 | cdr-report/sheetRepairs.js | The date-normalize docblock now says the cell is built at SPREADSHEET-TZ midnight (dateAtSheetMidnight_ via dqeDateFromMdy_), not `new Date(Y, M-1, D)` (the R46 shift). Comment only.
DX-1 | README.md | S1…S53 (was S47); "six" split files (+ neon-layer, per-call-capture); layout gains apps-script/dqe-report, tools/ui-harness, .github/workflows, .cycle, .claude, CLAUDE.md; the dqe-report line now says frozen, not "not pulled in".
DX-2 | docs/conventions.md | individual_active attributed to Util.gs; table gains outboundReport v6, overviewChartYtd v3, agentHome v1, agentHist v1, deptExts v1, neonAgentExts v1, plus a line for the operational keys (orphanFix:init, deptConfig:init, presence, mailThrottle, escSchema) -- every version checked by cache-version-sync.
DX-3 | docs/next-steps.md | blocks 212-213 recorded as MERGED #349; header date 2026-10-02; a row for the 2026-10-01 broad scan (blocks 214-225, on this branch, deferred items named).
DX-4 | BuildStamp.gs | header names its three readers (Health row, Code.gs template injection into both apps, the presence beat's update notice) instead of "nothing else reads it".
DX-5 | CLAUDE.md, docs/fix-history.md, docs/conventions.md, docs/known-issues.md | "six split files", "~130 suites", S1…S53 in fix-history's header; buildDQEHistoricalData.gs -> .js.
DX-7 | CLAUDE.md (H2 bullet) | says the H2 standard is what team-tools, the table and the agent app compute, and that the server surfaces join it only under ANSWER_RATE_FORMULA=answerable -- the default is `rung`.
DX-8 | Escalations.gs | the unique-index comment cites INV-55 (INV-57 does not exist).
DX-9 | CLAUDE.md (checklist #3 index) | the Access Control email match is case-INsensitive (matches Operator State #3 and the code).
DX-10 | CLAUDE.md (System Health bullet) | runLiveSmoke = seven read-path checks; it emails admins and stamps SMOKE_LAST*; "three other read-only sections" -> "three other sections".
DX-12 | docs/operator-state.md (#24) | escalation tables are created by the first escalation call, read OR write, with the once-per-execution / once-an-hour check (INV-55 already said so after AC-5).
DX-6 | CLAUDE.md, docs/client-ui-conventions.md | Seven Key Design Decisions bullets that describe how CLIENT surfaces are built (Overview admin banners, agent-table column model, Source column, Phase E surfaces, My Department export, draggable modals, Help FAB) moved VERBATIM to a new "Moved from CLAUDE.md (DX-6)" section (cross-references re-pointed at CLAUDE.md), replaced by one index bullet naming them and the invariants (INV-39/53/06) that pin their server rules. 184.6 KB -> 173.7 KB (84.8%). Version claims in the moved text stay checked (client-ui-conventions.md is in cache-version-sync's DOC_FILES).

TEST RESULTS: passed -- `npm run ci` 2120/2120 + INV-16 guard + module-deps --check; `CI=true npm run lint:gas` clean; bare `TZ=UTC node --test` 2120/2120. `npm run ci:ui` not re-run: no client file changed (BuildStamp.gs comment only). One run of the full suite hit a timing flake in neon-mirror-tail ("B1: budget-skipped dates keep their attempt count", a 1 ms budget) -- pre-existing, untouched by this batch, green on every rerun and 5/5 in isolation; listed below.
REGRESSION RISKS:
- CH-1: five functions became RPC-callable. Each is admin-gated as its first statement and only reads/logs; a manager calling one gets the admin-only error. Any saved bookmark or note naming the old `_` names now points at nothing (they could not be run before anyway).
- CH-2/CH-3: deletions of unreferenced code; lint-gas confirms no remaining reference. INV-17: `clasp push -f` does not delete -- but these are functions inside files that still exist, so the push removes them.
- DX-6: a reader looking for those seven bullets in CLAUDE.md now follows the index bullet; the text itself is unchanged.
INVARIANTS AT RISK: None. INV-01 (CH-1 tools are admin-gated and write nothing); INV-23 text updated to the new tool name only.
NET SCORE: 1 production fix (CH-1: the documented operator diagnostics could not be run from the editor at all) − 0 new failure modes = 1. The rest is dead code and docs truth.

OPERATOR ACTIONS / DEPLOY:
- Deploy the Department Dashboard (Diagnostics/Auth/Alerts/EmailKit/Escalations changed) | BLOCKS DEPLOY: N (no behaviour a manager sees changes; ships with the earlier batches' dashboard deploy)
- Deploy cdr-report only if convenient -- sheetRepairs.js changed a comment only | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy
Deploy: CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (comment-only change; optional)

FOLLOW-ON ITEMS:
- tests/unit/neon-mirror-tail.test.js "B1: budget-skipped dates keep their attempt count" uses NEON_MIRROR_BUDGET_MS='1' and a 3 ms spin, so under heavy parallel load the budget can expire before the first date runs (left.length 2, not 1). Seen once in this session; the budget should be measured from the first date or the test should inject a clock.
- Diagnostics.gs typeOfCell_ looked unreferenced in an earlier sweep (block 71); not in CH-3's list, left alone.
- CLAUDE.md is at 84.8% -- the next trim candidates by the same rule are the remaining client-flavoured KDD bullets (Multi-page architecture, View-as-Manager).

DOCUMENTATION UPDATES NEEDED:
- None remaining -- this batch WAS the docs pass (all edits listed above).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
