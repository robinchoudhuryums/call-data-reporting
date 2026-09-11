# Historical date columns: normalization + ordering plan

**Status:** Phases 0 / 0b shipped and run live (2026-09-10). Phase 1 shipped and run live (2026-09-11); the run exposed a timezone shift (R46, fixed same day) — DQE is CLEAN once the corrected repair has re-anchored the shifted block. Phases 2–3 not started.
**Why this exists:** five historical sheets are read by windowed date queries,
and none is reliably date-ordered. Today that is *handled* — every dashboard
reader uses a min/max SPAN, which is correct at any row order (CLAUDE.md,
"A dated sheet read is bounded by a min/max SPAN"). This plan is about making
the sheets genuinely ordered, which is a precondition for replacing the span
SCAN (~31.9k cell reads on DQE) with a binary search (~15).

Read the SPAN and MEMO bullets in CLAUDE.md first. `R40`–`R45` in
[`fix-history.md`](fix-history.md) covers what has already been done to bound
these reads, including two optimizations that were measured and **refused**.

## The two problems, which are not the same problem

Sorting a date column only works if the column is single-typed: Sheets groups
numeric/Date cells ahead of text, so a MIXED column sorts into dates-then-text,
each half ascending and the whole thing wrong. Worse, the result then reads as
non-decreasing, so a naive "is it ordered?" check certifies it forever.

| Sheet | Daily / Manual Export | Bulk | Date cell written |
|---|---|---|---|
| DQE Historical Data | **sorts** every write (`buildDQEHistoricalData.js:1075`, col B) | same code | `callDateStr` **string**, coerced to Date by Sheets |
| CDR Historical Data | **conditional** sort (`autoImport.js:1854-57`) | sorts (`:1329`) | `dateObj` (real Date) |
| Q Path Historical Data | **none** (`:1954` bare append) | sorts (`:1329`) | `dateObj` |
| QCD Historical Data | **none** (`:1989` bare append) | sorts (`:1329`) | `dateObj` |
| CSR Transfer Historical | **none** (`:2083` bare append) | sorts (`:1329`) | `dateObj` |

So: **DQE sorts every day and cannot work** (mixed col B). **Q Path / QCD / CSR
Transfer work fine and never run** on the daily path — the path Operator State
#56 tells operators to use when reprocessing a date, which is exactly when rows
land out of order. CDR sorts only against the LAST row, so it prevents a fresh
tail inversion but can never repair disorder already present.

*Make the sort work* (DQE) and *make the sort run* (the other four) are
different fixes. Note this also settles the canonical type: four of five sheets
already store real `Date`, so DQE normalizes toward them, not the reverse.

## Phase 0 — census (SHIPPED)

`previewHistoricalDateColumns()` in `apps-script/cdr-report/sheetRepairs.js`.
Read-only; writes nothing (test-pinned, including that `setNumberFormat` is
never called).

**To run it:** `cd apps-script/cdr-report && clasp push -f`, then in the CDR
Report Apps Script editor pick `previewHistoricalDateColumns` from the Run
dropdown (it is non-underscore precisely so the picker shows it) and read the
Execution log. No new OAuth scope. Expect roughly 10–30 s — ten single-column
reads, the widest being DQE at ~31.9k rows.

Per sheet it reports a storage-type histogram with **per-type first/last row**
(so an era split is visible, not just a count), single-typedness, ISO order with
inversion samples, unresolvable-cell samples, min/max ISO, and a verdict:
`CLEAN` / `MIXED-TYPE` / `UNSORTED` / `UNPARSED` (combinable) / `EMPTY` /
`MISSING`.

Cells are TYPED from `getValues()` but RESOLVED through the existing
`parseDateForNeon` on the DISPLAY value — reusing the project's one date
resolver rather than adding a sixth hand-mirrored parser. One guard sits on top:
a bare-numeric display is treated as unresolvable rather than passed to that
helper, whose `new Date(s)` fallback reads `"45726"` as the **year 45726**
(verified). That is a latent issue for its ~13 other callers and is filed as a
follow-on, not fixed here.

**Read the output for three things:** which sheets say `MIXED-TYPE` (that is
Phase 1's scope); whether `unparsed` is non-zero anywhere (those rows need a
serial-aware repair, not a sort — and a non-zero count means the
`parseDateForNeon` bug is live rather than theoretical); and whether the type
row ranges are contiguous (a clean era split, like the PST→CST cutover, allows a
date-gated repair) or scattered (row-by-row, more work).

### Live census, 2026-09-10

| Sheet | Verdict | Rows | Finding |
|---|---|---|---|
| DQE Historical Data | **MIXED-TYPE** | 31,911 | 22,469 `Date` rows (2–22,470), then 9,442 `text:mdy` rows (22,471–31,912). **Zero inversions, zero unparsed.** |
| QCD Historical Data | CLEAN | 23,486 | all `Date` |
| CDR Historical Data | CLEAN | 27,784 | all `Date` |
| CSR Transfer Historical | **UNSORTED** | 4,931 | 3 inversions: Aug 5 / 12 / 20 appended after Sept 1 / 3 / 4 |
| Q Path Historical Data | **UNSORTED** | 1,855 | the same 3 dates, same shape |

Three things the numbers say:

- **DQE is in date order by accident.** Every Date-typed row is older than every
  text row, so Sheets' dates-before-text grouping happened to produce
  chronological order. It breaks the first time a pre-boundary date is
  reprocessed: the current writer emits TEXT, so that row lands in the text
  block after every Date row, however old it is. The three reprocessed dates
  so far are all post-boundary, which is the only reason it has not happened.
- **The current writer is producing text** — the text block runs to yesterday's
  build. Col B is not in the plain-text list and `callDateStr` is a coercible
  `M/D/YYYY`, and a sweep of every `setNumberFormat` across all three projects
  found none reaching col B. So the cause is outside the code, most likely a
  plain-text format on col B that new rows inherit. **This overturns the
  earlier "no writer change, no INV-16 edit" claim**: Phase 1 needs a col-B
  format reset on the exact write range in BOTH `buildDQEHistoricalData.js`
  copies — the a350042 "re-format the EXACT write range" discipline, pointed
  the other way. One line, two files.
- **CSR Transfer and Q Path are exactly the predicted shape**; Phase 2's first
  run fixes both. **QCD reading CLEAN — resolved (2026-09-11):** Pipeline
  Health shows `processIntegratedHistory:QCD` wrote 48 rows for Aug 5 on 9/3
  (the normal per-day shape), so no data was lost; the Aug-5 block sits in
  chronological position because the sheet was **sorted by hand** on 9/10.
  The census was right about the sheet as it stood — and the episode is the
  case for Phase 2: a manual sort leaves no record, and the nightly job would
  have made the question answerable from a Pipeline Health row.

## Phase 0b — the format probe (SHIPPED, run live 2026-09-10)

The first census printed row numbers per type but not dates, and read values
but not formats — so it could not say WHEN the era started or WHY the writer
emits text. Two additions to the same function, both read-only:

- **per-type ISO min/max** in `typeRanges`, so the boundary is a date;
- **per-type number-format histogram** (`formats`, via `getNumberFormats`),
  which separates *"the cells are `@`-formatted, so a coercible string stays
  text"* from *"the writer's string changed"*. Best-effort: a throw leaves
  `formats: null` and the rest of the census stands.

**What the live run said (2026-09-10):**

```
type date:      rows 2-22470,     2024-02-29..2026-03-06,  formats: ""×22469
type text:mdy:  rows 22471-31912, 2026-03-09..2026-09-08,  formats: ""×9442
```

Both hypotheses it was built to separate turned out wrong in the same
direction: the text cells are **automatic-format** (`""`), not `@`, so no
format reset is needed; and the boundary is **2026-03-09 — the documented
pipeline cutover** (CLAUDE.md's PST→CST bullet). The old pipeline wrote `Date`
objects; the current one writes `callDateStr` and the string is simply **not
coerced** — why it coerces in Direct Call History (F-3) and not here is
unresolved, and the fix below deliberately does not depend on knowing. CSR
Transfer also showed three date formats across its history (`""`,
`m/d/yyyy`, `mm/dd/yyyy`) — all Date-typed, cosmetic, sorts fine.

## Phase 1 — normalize DQE col B (SHIPPED + RUN LIVE 2026-09-11)

Smaller than either earlier version of this section, and the earlier
"reset col B's number format first" step is **gone** — the cells are
automatic-format and a Date displays as a date there.

**Writer (both INV-16 copies, `buildDQEHistoricalData.js`).** After the main
`setValues`, col B is written a second time as `callDateObj` — the pattern the
CDR writer already uses for its own date column (`autoImport.js`,
`raw.map(() => [dateObj])`), which never depends on string coercion.
`outputRows[1]` stays the string so the Neon mirror (`callDate: r[1]`) is
untouched; the dup guard reads col B through `getDisplayValues` +
`displayToDate` and sees `3/9/2026` either way. Pinned in
`pipeline-build.test.js`: col B `instanceof Date`, local midnight, correct
calendar date — including the I2-9 ISO-START_TIME case.

**Repair (`sheetRepairs.js`): `previewDqeDateNormalize()` /
`repairDqeDateNormalize()`.** Types every col-B cell with the census's own
`hdCellType_`; converts each `text:mdy` cell to `new Date(Y, M-1, D)` — the
writer's own construction, so a repaired cell is indistinguishable from one
the build writes — skips Date cells and blanks, writes no number formats,
then runs the build's own after-write sort once. **Whole-run refusal**: any
non-blank cell that is neither a Date nor exactly `M/D/YYYY` refuses the apply
and is named, because converting around it would leave the column mixed while
looking repaired. An impossible calendar date (`2/30/2026`) is refused rather
than rolled forward. Idempotent. No Neon re-mirror needed — the dates are
unchanged, only the cell type. A mid-run DQE backfill's T-8 resume pointer
restarts from 0 after the sort (harmless, ON CONFLICT idempotent).

**Acceptance:** re-run `previewHistoricalDateColumns()` — DQE reads `CLEAN`,
one type, zero inversions. Then the next morning's build must keep it so.

**Harness:** the fake sheet now renders a `Date` cell as `M/D/YYYY` on the
display path (it used to return `String(date)`, a rendering Sheets never
produces) — Phase 1 made that load-bearing, since the dup guard reads the
Date-typed col B back through `getDisplayValues`.

**Live run, 2026-09-11 (both projects pushed first).** Preview: 31,985
rows — 22,469 already Date, 0 blank, 9,516 text `M/D/YYYY`, 0 refused (74
more than the 2026-09-10 census: the builds in between still wrote text).
Apply converted 9,516 cells and sorted in 16 s. Re-census: **DQE CLEAN** —
one `date` type across all 31,985 rows, 2024-02-29..2026-09-08, zero
inversions, formats `""` throughout (automatic — nothing to reset). QCD and
CDR unchanged (CLEAN). CSR Transfer + Q Path still UNSORTED with the same
three Aug 5 / 12 / 20 reprocess inversions — Phase 2's job. CSR Transfer's
date column carries three number FORMATS (`""` / `m/d/yyyy` / `mm/dd/yyyy`)
on one type; cosmetic, single-typed either way, not a sort hazard.
**But CLEAN was wrong (R46, same day).** DQE's latest date read 2026-09-08
while Pipeline Health showed a 74-row build for 09-09: the repair (and the
writer change) built each Date as `new Date(Y, M-1, D)` — midnight in the
SCRIPT's TZ — and `setValues` converts a Date in the SPREADSHEET's TZ, one
hour behind in summer, so all 9,516 cells landed as 23:00 of the previous day.
The census could not see it (a display of "9/8/2026 23:00:00" parses as a
valid 9/8) and neither could the harness (CI pins the process TZ to the
script's; the fake rendered Dates in the process TZ). Fix, shipped 2026-09-11:
`dateAtSheetMidnight_` (buildDQEHistoricalData.js, both copies) is the one
construction for a date-only cell; the writer and `dqeDateFromMdy_` route
through it; `repairDqeDateNormalize()` re-anchors a Date at script-TZ
midnight to sheet midnight of the same calendar day (and reports the
re-anchored row/ISO range — expect the converted block, 2026-03-09..latest);
the census flags the shape as **TZ-SPLIT**. Backstory: fix-history R46.

**Corrected acceptance:** push both projects, `previewDqeDateNormalize()`
(expect N re-anchor, 0 refused, the range = the converted block),
`repairDqeDateNormalize()`, then `previewHistoricalDateColumns()`: DQE CLEAN
with NO TZ-SPLIT line and its latest date equal to the latest build's. Then
the next morning's build must keep it so.

## Phase 2 — nightly check-and-sort (NOT STARTED)

Modeled on `runRetentionPrune_` / `installRetentionPruneTrigger`
(`DeleteOldSheets.js:100,136`): daily ~3 AM, installed from a CDR Tools menu
item, with an uninstall. Home: cdr-report (it owns `sheetRepairs.js` and the DQE
build's own sort).

- **Flag-gated** `HISTORICAL_SORT_ENABLED`, per the eight-engine convention, so
  an installed trigger with the flag off is a visible no-op. (Note
  `PROP_REGISTRY_` is the *dashboard's* store; cdr-report has no registry, so
  that enforcement does not extend here.)
- **The check is "single-typed AND non-decreasing", never just ordered** — see
  the top of this document for why an order-only check would certify DQE
  forever. Reuse Phase 0's two predicates.
- Read the date column, sort only on failure. Most nights: a no-op.
- All five sheets, at their own date columns (DQE col B; the rest col C).
- **Log a Pipeline Health row per sheet** (new INV-44 step name) so a sort that
  starts firing *every* night — meaning a writer regressed — surfaces rather
  than quietly churning.
- **Follow-on folded in here: the bulk path's sort failures are invisible.**
  `autoImport.js` (~1319–1331) sorts all four sheets after a bulk write inside
  `try { … } catch (e) { console.warn(...) }`. In Apps Script `console.warn`
  goes to Cloud Logging, not to `Logger` or the Pipeline Health sheet, so a sort
  that fails there is seen nowhere an operator looks — a run could leave CDR
  and QCD sorted and CSR / Q Path not, with no trace. Two remedies, both
  cheap: (1) Phase 2's nightly check would catch the *result* the next
  morning; (2) the bulk path should log a Pipeline Health **failure** row for
  the sheet whose sort threw (the `guardForceRebuildLoss_` pattern — log, don't
  throw, so the already-written sheets stand) instead of `console.warn`. Ship
  (2) with Phase 2, since it uses the same new step name.
- **Skip when any `*_RESUME` property is set.** A sort invalidates the four T-8
  fingerprinted resume pointers. That is safe (the key check trips, the run
  restarts from 0, logged, and every backfill is `ON CONFLICT` idempotent) but a
  nightly sort during a multi-run backfill would reset it every night and the
  backfill would never finish.

This is worth shipping for Q Path / QCD / CSR Transfer **even if Phase 1 slips**
— those three are single-typed today, so the trigger fixes them on its first
run. The nightly job is a compensating control for the missing writer-side
sorts; if it fires on QCD every night, that is the writer talking.

## Phase 3 — binary-search span (DEFERRED, gated)

Payoff: ~31,911 cell reads → ~15. It does **not** fall out of Phase 2.

A nightly sort means the sheet can be unsorted *during the day* — a force
re-import appends. Binary-searching a maybe-sorted sheet is the same silent
under-report class that got the span cache refused (see the note at the end of
`R40`–`R45` in fix-history): rows never read cannot be recovered by the per-row
date filter. The cheap signatures do not close it either — `getLastRow()` is
unchanged when a re-import rebuilds an interior date to the same row count, and
first/last dates do not move.

Making it safe needs a sorted-ness stamp that every writer across two projects
maintains, plus a B-2-style tripwire — a real cross-project invariant. Revisit
only after Phases 1–2 have been live long enough to show the per-write sort
actually holds.
