---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- DL-7 (Med) -- per-execution memo for openSpreadsheet_, the roster block and getAllDepartments_
- DL-8 (Low) -- skip the unused dept queue-ext derivation in the Missed Calls report

Files modified:
- apps-script/department-dashboard/Config.gs
- apps-script/department-dashboard/Auth.gs
- apps-script/department-dashboard/Data.gs
- apps-script/department-dashboard/OrphanFix.gs
- apps-script/department-dashboard/MissedCallsReport.gs
- tests/harness/loadGas.js
- tests/unit/workbook-memo.test.js (new)
- tests/unit/missed-report.test.js
- tests/README.md
- docs/module-dependencies.md (regenerated)

CHANGES:
DL-7 | Config.gs | openSpreadsheet_ memoizes the opened Spreadsheet per execution (OPEN_SS_MEMO_, keyed on the SPREADSHEET_ID it was opened for, so a changed id re-opens). New rosterDeptBlock_() reads the `DO NOT EDIT!` dept block in ONE range read (headers up to the first blank + the data cells) and memoizes it (ROSTER_BLOCK_MEMO_). resetWorkbookMemos_() / bustRosterMemo_() added. rosterDeptBlock_ lives in Config.gs, not Data.gs, because suites that load Auth.gs without Data.gs call getAllDepartments_.
DL-7 | Auth.gs | getAllDepartments_ returns a COPY of the memoized depts list (callers cannot mutate the memo).
DL-7 | Data.gs | getRosterForDepartment_ and rosterAllDeptsHash_ read the shared block instead of their own sheet reads; roster entries are built fresh per call. Degenerate case: a sheet with no dept headers now hashes to 'na' (was hash of the empty list) -- same "no roster" meaning, one-time key change.
DL-7 | OrphanFix.gs | appendRosterEntry_ (the only dashboard writer of `DO NOT EDIT!`) calls bustRosterMemo_() after its write, so a read later in the same execution sees the new hire.
DL-7 | tests/harness/loadGas.js | h.call / h.fn reset the workbook memos before each entry point -- one invocation = one Apps Script execution, the boundary the platform draws. Swapping h.state.spreadsheet between calls keeps working without per-suite resets.
DL-7 | tests/unit/workbook-memo.test.js | Four pins: one openById + one roster read per execution across several roster consumers; returned values are fresh objects; a write then read in the same execution sees the write; a fixture swapped between calls is served, and an empty workbook gives [] / 'na'. Mutation-checked: pin 1 fails against HEAD, pin 3 fails with the bust removed.
DL-8 | MissedCallsReport.gs | computeMissedCallsReport_ derives the dept queue-ext set (a Neon DISTINCT via deptQueueExtsForNeonReader_, or the whole-sheet A..D scan via getDeptQueueExts_) only when scope !== 'roster'. Both public callers lock scope to 'roster', and R6 attributes sentinels by queue NAME, so the set was never read on the live path. For roster scope it is {} (truthy, so the sheet fallback is skipped as well).
DL-8 | tests/unit/missed-report.test.js | Pin: roster scope calls neither derivation on the sheet path or the Neon path, and the report is unchanged; 'both' still derives on each path. Mutation-checked: fails against HEAD.

TEST RESULTS: passed -- `npm run ci` 2105/2105 + INV-16 guard + module-deps --check; `CI=true npm run lint:gas` clean (75 files, 3 projects); bare `TZ=UTC node --test` 2105/2105; `npm run ci:ui` all stages passed.
REGRESSION RISKS:
- A roster write added later that does not call bustRosterMemo_() would serve a stale roster to a read LATER IN THE SAME EXECUTION only (the next execution starts empty). Today appendRosterEntry_ is the only dashboard writer; pinned.
- The memoized Spreadsheet object is shared within one execution. Apps Script Spreadsheet handles are stateless proxies, so sharing one is the same as opening twice; no caller holds per-handle state.
- rosterAllDeptsHash_ on a dept-less roster changed from hash([]) to 'na': a one-time cache-key change for that degenerate case only.
- DL-8: a future caller passing 'queue' / 'both' still gets the set (pinned).
INVARIANTS AT RISK: None. INV-03 (roster cell parse) still goes through parseRosterCell_; INV-04 is unchanged (exact names); INV-11's ROSTER layout constants drive the single range read; INV-01 is untouched (no new write path; the bust is an in-memory reset).
NET SCORE: 2 production fixes (both are real per-request cost on every report load: repeated openById + roster reads, and a Neon DISTINCT / whole-sheet scan nobody read) − 0 new failure modes = 2

OPERATOR ACTIONS / DEPLOY:
- Deploy the Department Dashboard (scripts/deploy.sh . <id>, or clasp push -f + New version) | BLOCKS DEPLOY: Y
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

FOLLOW-ON ITEMS:
- acRosterNamesForDept_ / acRosterNamesByDept_ (Auth.gs, the Access Control admin modal) still read the roster on their own; left as-is because they are admin-only, one-shot modal reads and outside DL-7's named scope.
- Other per-execution readers of the same workbook (Dept Config rows, the DQE memos) have their own resets in suites' install(); folding them into resetWorkbookMemos_ would simplify the suites, but that is a harness change outside this batch.

DOCUMENTATION UPDATES NEEDED:
- Done in this batch: tests/README.md ("Three gotchas" -- the one-call-one-execution harness boundary + the bustRosterMemo_ rule for new roster writers; coverage-map entry for workbook-memo). CLAUDE.md deliberately NOT extended: it is past the 90% size warning, and the rule is enforced by a test.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
