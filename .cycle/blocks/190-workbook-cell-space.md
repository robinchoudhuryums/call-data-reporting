---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- R47 (INCIDENT-DRIVEN) | The CDR Report workbook reached 9,983,599 of Google's 10,000,000-cell cap and the daily import's Direct write failed ("This action would increase the number of cells in the workbook above the limit of 10000000 cells") with NO prior signal. Google counts the ALLOCATED grid (maxRows x maxColumns per tab), not cells holding data; 36.7% of the whole cap was ONE tab, `QCDR Output`, holding a 49x24 report inside a 12,607x291 grid. Three pieces: a cdr-report audit + refuse-by-default trim, a CDR Tools submenu, and a dashboard Health page row that warns at 80%.

Files modified:
- apps-script/cdr-report/sheetSpace.js (NEW: `sheetSpacePlanOne_` + `sheetSpaceVerdict_` pure, `sheetSpaceEntries_`, `auditSheetSpace`, `trimGrid`, preview/apply wrappers, `showConditionalFormatRanges`)
- apps-script/cdr-report/CDR Tools menu.js (🧮 Workbook Cell Space submenu)
- apps-script/department-dashboard/SystemHealth.gs (`workbook-cells` row + WORKBOOK_CELL_CAP_ / WORKBOOK_CELL_WARN_PCT_)
- tests/unit/sheet-space.test.js (NEW, 6), tests/unit/system-health.test.js (+2), tests/README.md
- CLAUDE.md (index #62; the System Health bullet's row list; re-trimmed under the 4 KB ratchet), docs/operator-state.md (#62), docs/module-dependencies.md (regenerated), .cycle/STATE.md

CHANGES:
R47-plan | sheetSpace.js | `sheetSpacePlanOne_(entry, keepRows, keepCols)` PURE -> {before, after, frees, refused, reason, needRows, needCols}. HARD REFUSES on data OR a named range past the bounds (truncating a named range silently changes every reader -- the roster ranges on `DO NOT EDIT!` run to row 1000 over 47 used rows). Protections / conditional formatting / charts are reported by the caller and never block: they shrink harmlessly, and whole-column rules would otherwise refuse every trim.
R47-targets | sheetSpace.js | `SHEET_SPACE_TARGETS_` is HAND-SET per tab with a comment naming what each bound clears, because a WRITER's reach is not derivable from the grid: `updateQcdrOutputSheet` clears `getRange(2, 10, max(agents+20, 100), 15)` however few agents exist, so trimming QCDR Output to its 49 used rows converts a space outage into a daily-import outage. QCDR Output 200x30 (frees 3,662,637); Daily Queue Report 400x20 (frees 641,844).
R47-verdict | sheetSpace.js + SystemHealth.gs | `sheetSpaceVerdict_` totals the ALLOCATED grid, computes the percentage, and names the tab with the most reclaimable space (the LEVER -- the biggest tab is usually not the biggest waste). The Health `workbook-cells` row renders it in the SHEETS section of the FAST half: sheet metadata only, no cell reads, no Neon, so it survives an outage. warn >= 80%; the warn hint leads with "at 100% every WRITE to this workbook fails", because the failing STEP name misleads (Direct was blamed, the workbook was the cause).
R47-menu | CDR Tools menu.js | 🧮 Workbook Cell Space: Audit (read-only) / Preview trim (read-only) / APPLY trim / Conditional-format ranges…, the sheetRepairs.js preview-then-apply convention.

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 1365/1365 (1357 + 8 new); UTC green too (the host-TZ fix from 005a7b1 holds); INV-16 guard in sync; claude-md-split / cross-file-pins / prop-registry green. Mutations 6/6 killed: named-range refusal removed (2 suites); QCDR bound cut to the 49 used rows; verdict counting USED instead of ALLOCATED; warn threshold 80 -> 99; Health row counting used not grid (2 suites); Health row made to open Neon, breaking the mid-outage guarantee (3 suites). `npm run ci:ui` NOT run (playwright absent here) and not needed: no client or payload-shape change -- the Health payload gains one row, which the renderer draws generically from `section`. Regression Scenarios overlapping: none by name (the Health page has no S# scenario); the live check is Operator State #62.

REGRESSION RISKS:
- The trim DELETES grid. Not covered by the #59 repair-backup workbook (which snapshots `repair*` cell rewrites only), so #62 says File > Make a copy first. Preview-by-default and the named-range refusal are the in-code protections.
- A formula elsewhere in the workbook pointing into a trimmed region becomes #REF! SILENTLY -- undetectable from code and caught by no probe here. #62 says to sweep with `createTextFinder(tab).matchFormulaText(true)` before a first trim. Done for both vetted tabs on 2026-09-14: zero references.
- `workbook-cells` adds ~28 getMaxRows/getMaxColumns metadata pairs to every Health load (no cell reads). Measured client-side at well under the page's existing sheet work.
- The cap + threshold now live in TWO projects with no shared module; sheet-space.test.js pins that both literals agree, which is the only tie between them.

INVARIANTS AT RISK: INV-01 (the trim is cdr-report menu/editor code, not a dashboard RPC -- no new public write path); INV-12 (setup() untouched; `QCDR Output` is hand-maintained operator state, not setup-created -- C-8); INV-17 (a NEW file, so `clasp push -f` ships it; nothing removed). None violated.
NET SCORE: 3 (the unmeasured cap that became an outage; the writer-reach trap that would have made the fix worse; the silent-#REF! gap now documented) − 0 = 3
