---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: **R44** — the two whole-sheet DQE grids that a span CANNOT bound were being re-read per department. Diagnosed from a live 53.4s `getDepartmentSummary` trace supplied by the owner.

Files modified: apps-script/department-dashboard/Data.gs, tests/unit/dqe-span-readers.test.js, tests/unit/cross-file-pins.test.js, tests/unit/dal-cutover.test.js, tests/unit/dept-summary-email.test.js, tests/unit/digest-freshness-gate.test.js, tests/unit/missed-report.test.js, tests/unit/individual-report.test.js, CLAUDE.md

THE DIAGNOSIS (from the owner's live log, Sales + PAP combined view, 31.9k-row sheet):
```
dqeDateBounds        scanMs=7418
computeSummary_:Sales  ms=16131  rows=142
[qcd-grid]             readMs=7687
computeSummary_:PAP    ms=15696  rows=142
```
142 rows out for ~16s in — the cost was never the aggregation. Each `computeSummary_` re-read (a) the whole DATE COLUMN for its span and (b) the whole cols-A..D slice for the all-history ext derivation; `sheetScanDqeDateBounds_` had already read that same column. **Three reads of one column (~22s) and two of one grid (~16s), every one returning identical bytes** — both grids are dept-independent; only the rosterSet filter applied to the ext grid is per-dept, and that is in-memory. R41 bounded the WIDTH of the windowed read; these two reads are the ones a span structurally cannot bound, and nothing had bounded their COUNT.

CHANGES:
R44 | Data.gs | NEW `dqeDateColumnIso_(sheet, lastRow, ssTZ)` — the date column read ONCE per execution and returned already ISO-normalized (which also drops the per-row `rowDateIso_` pass each caller ran 31.9k times). Consumed by `sheetScanDqeDateBounds_` AND `dqeWindowRowSpan_`.
R44 | Data.gs | NEW `dqeExtGrid_(sheet, lastRow)` — the cols-A..D slice read ONCE per execution, shared by BOTH ext derivations (`deptQueueExtsFromSheet_` and the Neon path's sheet fallback `deptQueueExtsForNeonReader_`, which had the same repetition).
R44 | both memos | Row-count guard so a sheet that grew mid-execution is re-read, never served stale.
R44 | cross-file-pins.test.js | Both join `DQE_EXEC_MEMOS`; the R40 family tripwire then named all five suites needing resets, which were applied.
R44 | individual-report.test.js | Reset added — see the known hole below.

EXPECTED SAVING (arithmetic on the owner's own numbers, NOT measured by me — I cannot run against the live sheet): the date column goes 3 reads → 1 (~15s) and the ext grid 2 → 1 (~8s), so a 2-dept combined view should fall from ~53s to roughly ~30s. A 3-dept parent saves more; a single-dept view saves the one duplicated date-column read (~7s). **The `[dqe-read]` lines are how to confirm it** — after deploy, `computeSummary_:<2nd dept>` should drop to near the span read alone.

TEST RESULTS: passed. `npm run ci` 1265 pass / 0 fail; INV-16 guard clean. `npm run ci:ui` skips (playwright not installed locally).

Four new read-count pins in dqe-span-readers.test.js, all mutation-tested:
| mutation | pin that fired |
|---|---|
| date-column memo never stores | 3 pins (per-dept count, bounds+span sharing, growth guard) |
| ext-grid memo never stores | per-dept count |
| row-count guard dropped | growth guard |
| span re-reads the raw column | per-dept count + bounds/span sharing |

Payload equality is pinned separately (warm vs cold must agree), so the memos cannot change an answer — only the cost.

REGRESSION RISKS:
- **The reset trap fired for real, twice.** Five suites were named by the R40 tripwire; a SIXTH (`individual-report.test.js`) broke and was NOT named, because that tripwire only sees suites resetting at least one family member. Fixed, and the hole is now documented in the tripwire itself.
- **Measured and deliberately did not widen the tripwire:** the obvious rule ("any suite building a DQE fixture must reset the family") flags 20 suites of which ~1 is real — mostly pipeline suites that never call a dashboard reader. A 20-flag tripwire teaches ritual resets or suppression. Recorded as a known hole rather than shipped.
- Memory: the date memo holds ~32k short ISO strings and the ext grid ~128k cells for the length of one execution. Both were already being materialized per call; this holds one copy instead of N.
- SCOPE constraint documented in-code: both memos are for `DQE Historical Data` only. The row-count guard catches a grown sheet but cannot distinguish a different sheet of the same height, so they must not be reused for another sheet.
- No cache-version bump: no aggregation rule changed and payload identity is pinned.

INVARIANTS AT RISK: None. INV-02 (the span read still takes both grids), INV-53 (the ext derivation stays ALL-HISTORY — the R41 pin still passes), INV-04/05/23 untouched, INV-30 no bump, INV-01 both helpers `_`-suffixed.

NET SCORE: 1 production fix − 0 new failure modes = 1
(a) YES — this is a live 53s request the owner is feeling today. (b) NO — the stale-serve risk is guarded and pinned, and the reset trap it revives is now enforced for the family.

OPERATOR ACTIONS / DEPLOY:
- None. No Script Properties, triggers or migrations. | BLOCKS DEPLOY: N
- After deploy, re-open a parent dept (Sales) and compare the `[dqe-read] computeSummary_:*` lines — the second dept's should drop sharply. | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `clasp push -f` from repo root, then Manage deployments → New version (or `scripts/deploy.sh .`).

REGRESSION SCENARIOS: NOT RUN (manual, needs a live deploy). **S6, S35, S13** first — they exercise the floater/ext derivation, the only place a stale ext grid could change an answer — then S1, S2, S4.

FOLLOW-ON ITEMS:
- The ext derivation is still a whole-sheet read ONCE per request. It is dept-scoped and changes only when new rows land, so it is a candidate for a CacheService entry anchored on `reportFreshnessTag_()` — that would take it to ~0 on a warm cache, at the cost of INV-30 anchor reasoning. Not attempted here.
- `getDeptQueueExts_` only reads cols C and D but is handed A..D because it indexes from col A. A C:D-only read would halve those cells; it needs an offset parameter.
- The span bullet in CLAUDE.md is at 4026 / 4096 bytes. It now carries R25b/R26b/R40/R41/R42/R44 — the next addition will trip the ratchet, and the honest fix is to move the incident detail to `docs/fix-history.md` rather than trim prose again.
- The QCD grid read (7.7s) is already once-per-execution via `QCD_SHEET_DATA_MEMO_`; it is now a visible share of what remains.

DOCUMENTATION UPDATES NEEDED: None outstanding — CLAUDE.md's span bullet (the R44 rule) and the memo-family trap (now four memos) were updated in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
