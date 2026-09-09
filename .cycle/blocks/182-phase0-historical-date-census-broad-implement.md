---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Phase 0 — read-only date-column CENSUS across all five historical sheets (the measurement step that decides whether a `.sort({column:<date>})` can order each sheet at all, and therefore what Phase 1 normalization and the Phase 2 nightly sort trigger have to cover)
Files modified: apps-script/cdr-report/sheetRepairs.js, tests/unit/historical-date-columns.test.js (new), tests/README.md

CHANGES:
Phase 0 | apps-script/cdr-report/sheetRepairs.js | Added `previewHistoricalDateColumns()` + `scanHistoricalDateColumns_` / `hdScanOneSheet_` / `hdCellType_` / `hdVerdict_` / `hdLogCensus_`, driven by the `HISTORICAL_DATE_COLUMNS_` table (DQE col B; QCD / CDR / CSR Transfer / Q Path col C). Per sheet it reports a storage-type histogram with per-type first/last row (so an ERA split is visible, not just a count), single-typedness, ISO order + inversion samples, unresolvable-cell samples, min/max ISO, elapsed ms, and a verdict (CLEAN / MIXED-TYPE / UNSORTED / UNPARSED, combinable / EMPTY / MISSING). Writes nothing. File header updated: it is no longer DQE-repairs-only.
Phase 0 | apps-script/cdr-report/sheetRepairs.js | Cells are TYPED from `getValues()` but RESOLVED to ISO via the existing `parseDateForNeon` on the DISPLAY value — deliberately reusing the project's single date resolver rather than adding a sixth hand-mirrored parser (the Extraction Sidebar / DQE Drill-Down class of drift).
Phase 0 | apps-script/cdr-report/sheetRepairs.js | Bare-numeric guard: a display matching `/^\d+(\.\d+)?$/` is treated as unresolvable INSTEAD of being passed to `parseDateForNeon`, because that helper's `new Date(s)` fallback reads "45726" as the YEAR 45726 (verified) — a valid-looking ISO that would land in maxIso and hide the exact rows the census exists to find.
Phase 0 | tests/unit/historical-date-columns.test.js | New suite, 9 tests. Fixtures model Sheets properly as (raw value, rendered display) pairs — stringifying a JS Date instead feeds `parseDateForNeon` a UTC instant and shifts it a day (the F-8 class), which is a property of the fake, not of Sheets.
Phase 0 | tests/README.md | Registered the new suite in the coverage map (enforced by claude-md-split.test.js).

TEST RESULTS: passed — `npm run ci`: 1280/1280 tests pass; INV-16 duplicated-file guard clean. `npm run ci:ui` NOT run: no client file (script.html / script-*.html / styles.html / dashboard.html / agent*.html) and no payload shape was touched.
MUTATION TESTING: all 8 mutations of the new code were shown to fail a pin — singleTyped forced true; verdict ignoring mixed type; dropping the bare-numeric guard; counting blanks as a type; dropping a sheet from the table; typeRanges not tracking lastRow; removing inversion detection; making the census write a cell (6 fired on the first pass; 2 initially failed to APPLY on anchor escaping/ambiguity and fired once re-anchored). Source restored byte-identical afterward (diff-verified).

REGRESSION RISKS: None. The census is additive and nothing calls it — no existing function, interface, return type or default changed. Apps Script shares one global scope per project, so all 8 new global names were swept across the whole cdr-report project: no collisions. Read-only by construction, pinned by a test asserting cell values are unchanged AND that `setNumberFormat` is never called (that mutation fails 6 of 9 tests).

INVARIANTS AT RISK: None.
- INV-02 (duration cells via getDisplayValues) — respected in spirit and extended: the census never `String()`s a `getValues()` date cell to decide what it says; typing and resolution read separate grids.
- INV-01 (public write paths) — cdr-report is not the RPC-callable dashboard project, and the function writes nothing regardless. Non-underscore naming is required here for the opposite reason: the editor Run picker hides `_`-suffixed functions.
- INV-16 (byte-identical duplicated files) — sheetRepairs.js is not a duplicated file; guard re-run clean.

REGRESSION SCENARIOS: S38 (Inbound capture → Inbound report → insurer labeling) is the only scenario whose Subsystem includes CDR Reporting Tools. NOT APPLICABLE — the census is a new, uncalled, read-only function on a different sheet family and cannot reach the inbound capture path.

NET SCORE: 0 production fixes − 0 new failure modes = 0
(Phase 0 is a measurement instrument, not a fix. It fires no production bug this month by design; the count it produces is what sizes Phases 1–2.)

OPERATOR ACTIONS / DEPLOY:
- Run `previewHistoricalDateColumns()` from the CDR Report Apps Script editor's Run dropdown and capture the logged census. This IS the Phase 0 deliverable — Phase 1's scope (which sheets need normalizing, and whether any rows are unresolvable and need a serial-aware repair rather than a sort) is undecidable without it. | BLOCKS DEPLOY: N
Deploy: `cd apps-script/cdr-report && clasp push -f` (CDR Reporting Tools / CDR DQE Pipeline share one Apps Script project)

FOLLOW-ON ITEMS:
- **`parseDateForNeon` resolves a bare-numeric string to an absurd year rather than null** — `new Date("45726")` is year 45726 (verified). ~13 callers feed it display values from date columns; a serial cell carrying a numeric number format would key that row to year 45726 instead of failing loudly. The census now guards itself, but the helper is unchanged — deliberately out of Phase 0 scope. Worth a targeted fix once the census says whether any such cells actually exist.
- **The daily/Manual-Export path never sorts Q Path / QCD / CSR Transfer**, and sorts CDR only conditionally against the LAST row (so it cannot repair pre-existing disorder). Only DQE sorts unconditionally on every write. This is the Phase 2 finding that reframed the nightly trigger from safety-net to primary mechanism. Sites: `autoImport.js` daily appends ~1954 / ~1989 / ~2083 (no sort), ~1854-57 (CDR conditional), bulk ~1329 (all four); `buildDQEHistoricalData.js:1075` (DQE, unconditional).
- **CLAUDE.md's F-20 note claims `nmReadDateRowsTail_`'s sheet "is kept date-sorted by its own exporter"** — not true for QCD. The reader is still correct (it widens until a date's block is fully inside the window, and per-date contiguity holds because a force re-import deletes then re-appends), but it is correct for a different reason than the doc gives. Correct the note when Phase 2 lands.
- Carried, unchanged: qcd-report.test.js's `delete`-instead-of-restore leak; `getDeptQueueExts_` handed cols A–D but reading only C+D; the CLAUDE.md span bullet at ~4026/4096 bytes needing a fix-history split; the QCD budget being per-run rather than per-dept; the other ~20 cut-over readers having no whole-run budget.

DOCUMENTATION UPDATES NEEDED:
- None yet. Phases 1–2 will need a CLAUDE.md bullet, but per the "write the bullet ONCE, at the END of a phased rollout" habit that belongs at the end of Phase 2, not here. `docs/date-column-normalization-plan.md` is offered but not yet written.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
