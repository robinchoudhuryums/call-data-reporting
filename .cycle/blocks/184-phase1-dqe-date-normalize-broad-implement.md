---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Phase 1 — DQE col B normalization. (a) WRITER: `buildDQEHistoricalData.js` (both INV-16 copies) writes col B a second time as `callDateObj` after the main setValues, so the date column no longer depends on string coercion — the pattern the CDR writer already uses for its own date column. (b) REPAIR: `previewDqeDateNormalize()` / `repairDqeDateNormalize()` in cdr-report/sheetRepairs.js convert the 9,442 post-cutover text cells to Dates and sort once. (c) HARNESS: the fake sheet renders a Date cell as "M/D/YYYY" on the display path (Sheets' rendering; `String(date)` never was), which Phase 1 made load-bearing.
Files modified: apps-script/cdr-report/buildDQEHistoricalData.js, apps-script/cdr-import/buildDQEHistoricalData.js, apps-script/cdr-report/sheetRepairs.js, tests/harness/fakeSheet.js, tests/unit/pipeline-build.test.js, tests/unit/historical-date-columns.test.js, tests/README.md, docs/date-column-normalization-plan.md

CHANGES:
Phase 1 (writer) | buildDQEHistoricalData.js ×2 | After `setValues(outputRows)`, one more write: `getRange(firstBlank, 2, n, 1).setValues(outputRows.map(() => [callDateObj]))`. `outputRows[1]` stays the string — the Neon mirror reads it (`callDate: r[1]`) and parseDateForNeon expects text. The dup guard reads col B via getDisplayValues + displayToDate and sees "3/9/2026" either way (verified before claiming). Applied to both copies by one script; `cmp` clean; INV-16 guard clean.
Phase 1 (repair) | sheetRepairs.js | Types every col-B cell with the census's own `hdCellType_` (one definition of "text:mdy" in the file). Converts `text:mdy` → `new Date(Y, M-1, D)` — the writer's nested `displayToDate` construction, local midnight — via `dqeDateFromMdy_`, which ALSO refuses an impossible calendar date (`2/30/2026`) instead of letting `new Date` roll it to March 2. Skips Date cells and blanks; writes NO number formats (the census showed automatic-format cells); no Neon re-mirror (dates unchanged, only the cell type). **Whole-run refusal:** any non-blank cell that is neither Date nor exactly M/D/YYYY refuses the apply and is named — converting around it would leave the column mixed and unsortable while looking repaired. Writes contiguous row runs in one setValues each, then runs the build's own after-write sort once. Idempotent.
Phase 1 (harness) | fakeSheet.js | `fakeDisplay_`: a Date renders as "M/D/YYYY" (local getters; CI pins TZ to the manifest's). The old `String(date)` fallback would have made the build's dup guard blind to its own Date-typed rows in the fake — the F1 mutation below proves the fidelity fix is load-bearing.
Phase 1 (pins) | pipeline-build.test.js | The two pins that encoded col B as a STRING (`'03/09/2026'` at the INV-21 test; `'3/9/2026'` at the I2-9 test) now assert `instanceof Date`, correct local calendar date, and local midnight. Shared `localIso_` helper.
Phase 1 (pins) | historical-date-columns.test.js | Five new tests: preview counts + writes nothing; apply converts to local-midnight Dates, skips Dates/blanks, no format writes; idempotent; whole-run refusal on a stray ISO string + a bare serial (the good cells are left untouched); impossible calendar date refused.
Phase 1 (docs) | plan doc, tests/README.md | Plan: the 0b live-run reading (automatic-format cells; boundary = the 2026-03-09 cutover; writer emits text, coercion unexplained and the fix does not depend on it); Phase 1 rewritten — the earlier "reset col B's number format first" step is GONE. README suite entry extended.

TEST RESULTS: passed — `npm run ci`: 1288/1288 (1283 + 5 new); INV-16 duplicated-file guard clean; the two build copies `cmp` byte-identical. `ci:ui` not run: nothing client-side touched.
MUTATION TESTING: 9/9 fire. Writer: second col-B write removed; string written instead of Date; noon instead of local midnight. Repair: converts nothing; no whole-run refusal; calendar round-trip check removed; builds noon; not idempotent. Fake: `String(date)` rendering restored → the build's dup-guard test fails (proving the harness change is load-bearing, not cosmetic). Sources restored byte-identical (cmp against pre-mutation snapshots). **Honestly un-pinnable here:** the post-repair SORT — the fake's `sort` is a no-op by design ("tests filter by key rather than row order"); the apply test asserts the converted SET instead. The live acceptance check (re-census → DQE CLEAN, zero inversions) covers it.

REGRESSION RISKS:
- Time-of-day on the written Date: `callDateObj` is local midnight in the SCRIPT TZ (America/Chicago); the spreadsheet is America/Mexico_City (no DST since 2022). In CDT months the instant is 01:00 Mexico City — same calendar date, and every col-B reader is date-prefix-tolerant (`displayToDate` splits on space; `parseDateForNeon`'s M/D/YYYY match is unanchored at the end; `rowDateIso_` formats in the sheet TZ). This is the SAME construction the old pipeline used across two summers, so it is verified-by-history rather than new. Cosmetic: a summer-written cell may DISPLAY with a "1:00:00" suffix under automatic format. Check after the first live build.
- The T-8 fingerprinted resume pointers (`DQE_UPSERT_RESUME` etc.) key on display values; after the repair's sort (row order) — and possibly after the display change — a mid-run backfill restarts from 0. Documented, harmless (ON CONFLICT idempotent).
- The fake's display change touches every suite; the full 1288 run is green, so no existing test relied on `String(date)`.

INVARIANTS AT RISK: None.
- INV-16 — both copies patched by one script, `cmp` clean, guard clean.
- INV-02 — the repair types from getValues and resolves from the display; never `String()`s a getValues date cell. The writer adds no duration-column reads.
- INV-01 — cdr-report; the repair is an editor-run, non-underscore entry point by the file's own convention; the preview is pinned write-free.
- INV-10 — `HISTORICAL_COLS.DATE = 2` unchanged; only the cell TYPE in col B changes, not its position or meaning.
- INV-44 — no Pipeline Health vocabulary change.

REGRESSION SCENARIOS: overlapping Subsystems are CDR DQE Pipeline + CDR Import + CDR Reporting Tools → S5, S7, S15, S28, S31, S33, S34, S38. All are live/deploy-time walks and were NOT RUN here (no live Apps Script in this environment). S5/S34's mechanics — a build lands rows, the dup guard suppresses a rebuild — are exercised by pipeline-build.test.js on the new Date-typed col B. **The operator's first post-deploy morning build IS the S5/S34 walk**: col B of the new rows must read as a Date (the re-census will say).

NET SCORE: 1 production fix − 0 new failure modes = 1
(The writer defect fires on EVERY daily build — each one wrote a non-sortable text cell; its symptom was waiting on the first pre-cutover reprocess. The repair is a one-time operator migration.)

OPERATOR ACTIONS / DEPLOY:
- `cd apps-script/cdr-report && clasp push -f` AND `cd apps-script/cdr-import && clasp push -f` — the writer fix lives in both projects; pushing only one leaves the daily integrated build (cdr-import) still emitting text. | BLOCKS DEPLOY: N (the repair is safe before the writer lands; the writer is safe before the repair runs)
- Outside the import window: `previewDqeDateNormalize()` (expect ~9,442 to convert, 0 refused), then `repairDqeDateNormalize()`. | BLOCKS DEPLOY: N
- Re-run `previewHistoricalDateColumns()`: DQE must read CLEAN, one type, zero inversions. After the next morning's build, run it once more — the new rows must be Date-typed. | BLOCKS DEPLOY: N
- If `DQE_UPSERT_RESUME` (or any `*_RESUME`) is mid-run, expect one restart-from-0 log line on its next run. | BLOCKS DEPLOY: N
Deploy: `cd apps-script/cdr-report && clasp push -f`; `cd apps-script/cdr-import && clasp push -f`

FOLLOW-ON ITEMS:
- **Why setValues coerces "M/D/YYYY" in Direct Call History (F-3) but not in DQE col B is unresolved.** The fix deliberately does not depend on the answer. Worth one probe if it ever matters: compare the two sheets' column-level default formats.
- **QCD reading CLEAN on Sept 1 / 3 / 4** (the three reprocessed dates that reordered CSR Transfer and Q Path) is STILL unexplained and still the most important open item — check Pipeline Health for `processIntegratedHistory:QCD` on those dates for a 0-row force rebuild.
- CSR Transfer carries three date formats across its history (`""`, `m/d/yyyy`, `mm/dd/yyyy`) — all Date-typed, cosmetic; Phase 2 sorts it regardless.
- Phase 2 (nightly single-typed-AND-ordered check-and-sort over all five sheets) is now unblocked for DQE too. The CLAUDE.md bullet lands with it.
- Carried: `parseDateForNeon` bare-numeric → year 45726; the daily-path sort gap (Q Path / QCD / CSR); qcd-report.test.js `delete` leak; `getDeptQueueExts_` A–D vs C+D; QCD budget per-run.

DOCUMENTATION UPDATES NEEDED:
- None beyond what shipped (plan doc + README). The span bullet's "a col B holding mixed Date-typed and text cells does not sort chronologically" stays TRUE until the operator runs the repair; the bullet is rewritten at the end of Phase 2 per the write-once rule.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
