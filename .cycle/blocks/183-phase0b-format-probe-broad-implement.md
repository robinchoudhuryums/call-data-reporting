---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Phase 0b — two read-only signals added to the historical date-column census: per-type ISO min/max (names the era boundary as a DATE) and a per-type number-format histogram via getNumberFormats (separates "cells are '@'-formatted" from "the writer's string changed"). Motivated by the 2026-09-10 live run of Phase 0: DQE reads as 22,469 Date rows then 9,442 text rows, in order by accident, with the CURRENT writer emitting text and no code path found that plain-texts col B.
Files modified: apps-script/cdr-report/sheetRepairs.js, tests/harness/fakeSheet.js, tests/unit/historical-date-columns.test.js, tests/README.md, docs/date-column-normalization-plan.md

CHANGES:
Phase 0b | apps-script/cdr-report/sheetRepairs.js | `hdScanOneSheet_` takes a THIRD single-column read (`getNumberFormats`), best-effort — a throw sets `formats: null` and every other finding still computes. `typeRanges[type]` gains `minIso`/`maxIso` (additive). New `formats[type][format] = count` map. The log prints `type X: N cell(s), rows a-b, <min>..<max>, formats: "@"×N ...` per type, plus an explicit note when `text:mdy` cells sit in `@` cells (the Phase 1 gate). Header comment records why.
Phase 0b | tests/harness/fakeSheet.js | Fixture shape `{ values, displays, formats }`; `getNumberFormats()` / `getNumberFormat()` serve the optional grid ('General' where absent); `deleteRow` / `deleteRows` splice `_formats` alongside `_data` / `_displays` so the three grids cannot drift. DOCUMENTED as read-only: it does NOT reflect `setNumberFormat` calls in the same test — those stay RECORDED on `sheet._numberFormats` (F-6). A future round-trip test must model the write-through first, not assume it.
Phase 0b | tests/unit/historical-date-columns.test.js | Cells carry `fmt`; `buildSheet` emits the formats grid. Three new pins: per-type ISO range; the `@` vs General histogram; a throwing format read costs only `formats`, never the verdict/rows/ranges. One Phase 0 pin updated from the old `{firstRow,lastRow}` shape to the additive one.
Phase 0b | docs/date-column-normalization-plan.md | Live census table + the three readings (DQE ordered by accident; the writer emits text — overturning the earlier "no writer change / no INV-16 edit" claim; QCD-clean unexplained). Phase 0b section. Phase 1 rescoped to one contiguous block, one shape, no serials.

TEST RESULTS: passed — `npm run ci`: 1283/1283 (1280 + 3 new); INV-16 duplicated-file guard clean. `ci:ui` not run: no client file or payload shape touched.
MUTATION TESTING: 4/4 Phase 0b mutations fail a pin — per-type minIso not tracked; histogram never accumulates; format-read throw propagates; histogram loses the per-type key. Source restored byte-identical (diff-verified). The 8 Phase 0 mutations from block 182 are unchanged in kind.

REGRESSION RISKS: None found. The fake gained a read accessor and an optional fixture grid; every existing fixture omits `formats` and gets 'General', and the full 1283-test harness stays green. The census's added fields are additive; nothing consumes the census yet. `getNumberFormats` is a real SpreadsheetApp Range method — the census calls it inside try/catch, so an environment where it throws degrades to the Phase 0 output.

INVARIANTS AT RISK: None. INV-02 respected (typing/resolution/formats are three separate grid reads; no `String()` of a getValues date cell). INV-01 n/a (cdr-report; writes nothing — the no-write pin still holds). INV-16 guard clean.

REGRESSION SCENARIOS: S38 is the only scenario whose Subsystem includes CDR Reporting Tools — NOT APPLICABLE (uncalled read-only function, different sheet family).

NET SCORE: 0 production fixes − 0 new failure modes = 0
(An instrument, like Phase 0. Its output is what unblocks Phase 1.)

OPERATOR ACTIONS / DEPLOY:
- `cd apps-script/cdr-report && clasp push -f`, then re-run `previewHistoricalDateColumns()` and paste the DQE block — the `formats:` tally decides whether Phase 1's repair resets col B's format first. | BLOCKS DEPLOY: N (blocks Phase 1)
- Check Pipeline Health for `processIntegratedHistory:QCD` on Sept 1 / 3 / 4 — QCD reading CLEAN while CSR/Q Path reordered on those dates is consistent with a 0-row QCD rebuild after a force-delete, which the force guard logs. | BLOCKS DEPLOY: N
Deploy: `cd apps-script/cdr-report && clasp push -f`

FOLLOW-ON ITEMS:
- **Phase 1 now includes a writer-side change in BOTH INV-16 copies** (a col-B format reset on the exact write range) — the earlier plan said none was needed; the census proved otherwise.
- The fake's `getNumberFormats` does not model write-through from `setNumberFormat`; documented, not built (no consumer).
- Carried: `parseDateForNeon` bare-numeric → year 45726; the daily-path sort gap (Q Path / QCD / CSR); qcd-report.test.js `delete` leak; `getDeptQueueExts_` A–D vs C+D; the QCD budget per-run not per-dept.

DOCUMENTATION UPDATES NEEDED:
- None beyond what shipped here (plan doc + README). The CLAUDE.md bullet still belongs at the end of Phase 2.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
