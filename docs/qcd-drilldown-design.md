# Design — QCD Drill-Down Sidebar (Option A: faithful, trace-based)

Status: **PLAN ONLY — not implemented.** Awaiting owner approval before any
code lands. Respects the standing rule that the QCD engine
(`calcQcdReport`) is core/critical: this design adds a **read-only trace path
that does not change a single written QCD number.**

## Goal

Give the operator the same "show me the rows behind this number" affordance the
**DQE Drill-Down** already provides (`apps-script/cdr-report/DQEdrilldown.js`),
but for **QCD Historical Data**. Select a cell in QCD Historical Data — a
`(Date, Call Queue, Call Source, metric)` — and open a sidebar listing the exact
Raw Data legs that produced that number, with the same search / filter / sort /
summary UX as the DQE sidebar.

Primary use: verifying QCD numbers (abandoned counts, violations, transfers,
wait times) against the underlying call legs when a manager or admin questions a
figure, the same way the DQE drilldown is used to audit DQE rows today.

## Why this is genuinely hard (and why "Option A" specifically)

There is **no existing QCD drilldown** anywhere in the four projects — confirmed
by enumerating every custom menu and every `HtmlService` sidebar. Only the DQE
drilldown exists (cdr-report "DQE Tools" menu).

The QCD numbers are NOT produced by a simple "filter Raw Data by queue + status"
rule that a sidebar could re-implement. They come from `calcQcdReport`
(`apps-script/cdr-import/autoImport.js`, ~line 2091), which is a faithful
in-memory re-creation of a legacy **"QCDR Output" spreadsheet formula engine**:

- It reads static `(queue, source)` labels from `QCDR Output!A2:B49` and emits
  **48 fixed rows** into `qcdOutput[r][c]` (cols C–G → Total / Answered /
  Abandoned / Longest Wait / Avg Answer).
- Each Raw Data leg is swept into **dozens of distinct named counters**
  (`csrTransfers`, `nonCsrAbnd20s`, `stat3NonDnisAbnd`, `r34_abnd1m`,
  `r35_C_p1`, `r40_tot3`, …) under deeply branchy conditions: work-window gates
  (`time600AM` / `time630AM` / `time300PM` / `time330PM`), `status` (col 1),
  `type` (col 5, internal/incoming), `team` (col 9) ∈ `csr_team` named range,
  `queueName` (col 11), `dnisNum` (col 16) against two hardcoded DNIS numbers,
  `abandoned` (col 24), `transfer` (col 26), wait-time thresholds
  (`time20Sec` / `time1Min` / `time2Min`), plus `csr_exceptions` and
  `Steering Number` named ranges.
- Several output rows are **derived from other output rows** (parent/total rows
  via `totalRowMap`, child rows via `parentMap`, the row-40 subtraction
  `(r40_tot1+…) - c39`), so a single QCD cell can be a sum/max across other
  cells, not a direct leg count.

The QCD Historical Data write (`autoImport.js` ~line 1549) is then a flat copy:
one history row per `qcdOutput` row, `Call Queue = labels[i][0]`,
`Call Source = labels[i][1]`, `Total/Answered/Abandoned/Longest Wait/Avg Answer
= r[0..4]`, with `Abandoned %` and `Violations` computed downstream.

**Implication:** a hand-written drilldown that re-derives "which legs are
abandoned for this queue" would be a second, parallel implementation of this
380-line branch tree. It WILL drift from production the first time anyone tweaks
a threshold or a named range. That defeats the entire purpose (auditing the
real numbers).

**Option A** therefore does NOT re-implement the bucketing. It instruments the
SAME `calcQcdReport` to record, per Raw Data leg, **which output cells that leg
incremented** — a trace — and the drilldown replays the function in trace mode
for the selected date and shows the legs tagged for the selected cell. The
drilldown can't drift because it IS the production engine, just observed.

## Architecture

Three pieces. The only change to the core engine is additive and inert when the
trace flag is off.

### 1. Instrument `calcQcdReport` with an optional trace (additive, inert by default)

Change the signature to `calcQcdReport(cleanData, targetSS, opts)`. When
`opts.trace` is truthy, the function maintains a `trace` structure keyed by
output cell and pushes the contributing Raw Data row index every time a counter
that feeds that cell is incremented.

Mechanically, the cleanest seam is the counter increments themselves. Two
sub-options, in increasing fidelity:

- **A1 (cell-grain, recommended):** wrap each `results[queueName].<counter>++`
  and each module-scope counter (`r34_*`, `r35_*`, …) so that, in trace mode, it
  also appends the current row's index to a bucket keyed by the **counter name**.
  Then, AFTER the existing parent/total/derived passes run, map counter-name →
  output `(row, col)` using the SAME assignments already in the writeback passes
  (e.g. `csrTransfers` → col D of the primary rows; `nonCsrAbnd20s` → col E of
  the `cRows20s`; `r35_C_p1`+`r35_C_p2`+`r35_C_p3` → row 35 col C). Derived/total
  rows (col-of-parent = Σ children) inherit the **union** of their children's
  traced rows, computed from `totalRowMap` / `parentMap` exactly as the number
  is. This keeps the trace's definition of "what produced this cell" identical
  to the arithmetic that produced the number.
- **A2 (lower-effort, coarser):** trace only at the `(queueName, status, type,
  abandoned, transfer, dnis)` predicate level and re-bucket in the drilldown.
  Rejected — it reintroduces the drift risk Option A exists to avoid.

Recommend **A1**. Effort is concentrated here.

**Inertness guarantee:** with `opts` absent or `opts.trace` falsy, the function
returns exactly `{ output, labels }` as today, allocates no trace, and runs the
identical code path. The daily import call site (`results.qcdData =
calcQcdReport(cleanData, targetSS)`) is unchanged. Pinned by a unit test
asserting `calcQcdReport(fixture, ss)` and `calcQcdReport(fixture, ss,
{trace:true}).output` are deep-equal (numbers never move).

Trace shape returned alongside the existing output:
```
{ output, labels,
  trace: { [outputRowIndex]: { [colKey]: number[] /* Raw Data row indices */ } } }
```
where `colKey ∈ {C,D,E,F,G}` (Total/Answered/Abandoned/LongestWait/AvgAnswer)
and indices are into `rawDisplay` (so the sidebar can resolve the original Raw
Data row + jump to it).

### 2. A QCD drilldown orchestrator (read-only, cdr-import side)

Because `calcQcdReport` + the `QCDR Output` / `csr_team` / `csr_exceptions` /
`Steering Number` ranges all live in the **CDR Import** project against its Raw
Data, the trace must be computed there (same place the production numbers are
computed). New file `apps-script/cdr-import/qcdDrilldown.js`:

- `getQcdDrilldownRows({ date, queue, source, metric })` — public, read-only:
  1. Load the day's Raw Data (the `Raw Data` sheet, the current-day source the
     QCD engine already consumes; for historical dates, the per-day import
     sheets if still within the ~14-day retention — documented limit, same as
     the direct-call engine's "going-forward only" boundary).
  2. Run `calcQcdReport(cleanData, ss, { trace: true })`.
  3. Resolve `(queue, source)` → the matching `labels` row index, and `metric`
     → `colKey`. Pull the traced Raw Data row indices for that cell.
  4. Build display entries from those rows (reuse the DQE sidebar's
     `buildRowEntry` shape: id, leg, start/end, caller/callee, status,
     abandoned/transfer flags, wait, talk) + a `computeSummary`-style footer
     (count, that it equals the cell's number — a built-in self-check).
  5. Return `{ rows, summary, meta:{ date, queue, source, metric, cellValue,
     traceCount } }`. **Hard invariant surfaced in the UI:** `traceCount ===
     cellValue` (the count of traced legs equals the QCD number); if they ever
     diverge, the sidebar shows a loud "trace/number mismatch" banner — that's
     the drift alarm.

No write path. Trailing-underscore helpers for anything sheet-touching;
the public entry is read-only so it doesn't need `assertAdmin_` for safety
(it exposes only Raw Data the operator already sees), but since it's an
operator-editor tool, gate the **menu** to the spreadsheet, not RPC.

### 3. The sidebar UI (reuse the DQE shell)

QCD Historical Data lives in the **CDR Report** spreadsheet, NOT CDR Import.
Two placement options:

- **3a (recommended): selection-driven, in CDR Report.** Add a "QCD Drill-Down"
  item to a CDR Report menu (its own menu, NOT the frozen DQE Tools — built via
  the existing `onOpen`/`installDQEDrilldownMenu_` composition pattern so we
  don't clobber menus, per the "one onOpen wins" gotcha). It reads the active
  cell in `QCD Historical Data`, derives `(date=colC, queue=colD, source=colE,
  metric=which column was selected)`, and calls across to the CDR Import project
  for the trace. **Cross-project call problem:** Apps Script can't directly
  invoke another project's function. Resolve by either (i) moving the trace
  orchestrator's Raw Data read into CDR Report (Raw Data already lives in CDR
  Report — the engine reads `targetSS` which IS the CDR Report ss; only the
  `calcQcdReport` *function* lives in cdr-import), or (ii) duplicating
  `calcQcdReport` into CDR Report under INV-16 byte-identical discipline.
  Option (i) is far cleaner: **the QCD engine reads CDR Report's ranges already**
  — so the faithful move is to put a copy of the trace-capable `calcQcdReport`
  (or a shared, extracted module) where the sidebar runs. This needs a decision
  (see Open Items) because it brushes against INV-16.
- **3b: keep it in CDR Import**, drill from a date+queue+source picker in the
  sidebar instead of cell-selection. Loses the "click the cell I'm questioning"
  ergonomics but sidesteps the cross-project + INV-16 issue entirely (the engine
  and Raw Data are both in CDR Import's `targetSS` via `getTargetSsId_`). Lower
  risk, slightly worse UX.

UI itself reuses `DQEDrilldownSidebar.html` almost verbatim (search box, status
filter, sort, grouping, summary footer, jump-to-row). The only changes are the
column set shown (QCD-relevant: status, type, queue, DNIS, abandoned, transfer,
wait, talk) and the header (queue/source/metric/cell-value instead of
agent/metric).

## What the operator sees

1. Open QCD Historical Data, click the `Abandoned` cell on the
   `A_Q_CustomerSuccess / Total Calls` row for 2026-06-22.
2. Menu → QCD Drill-Down. Sidebar opens: header "A_Q_CustomerSuccess · Total
   Calls · Abandoned · 2026-06-22 · value 7".
3. Lists the 7 Raw Data legs the engine counted as abandoned for that cell, each
   with start/wait/status/queue, searchable + sortable, each with a
   "jump to Raw Data row" link.
4. Footer: "7 legs · matches QCD value ✓". If it said "6 legs · ⚠ does not match
   QCD value 7", that's a real bug signal (trace ≠ engine).

## Validation plan (before it's trusted)

- Unit: `calcQcdReport` numeric output is byte-identical with/without
  `{trace:true}` (the inertness pin).
- Unit: on a hand-built Raw Data fixture, the trace for each populated cell has
  `length === cellValue`, and the traced indices are exactly the legs the
  fixture intends (a few representative buckets: a CSR transfer cell, a
  non-CSR abandoned-20s cell, a DNIS cell, a derived total row).
- Live: run against 2–3 known days; for several cells, confirm
  `traceCount === cellValue` and that the listed legs are sane. The self-check
  banner makes any drift impossible to miss.

## Risks / boundaries

- **Retention:** Raw Data is pruned (~14 days). Drilldown works for recent dates
  only; older QCD Historical rows have no legs left to show. Surface this as a
  clear "Raw Data for this date is no longer retained" empty state (same
  boundary the direct-call engine documents).
- **INV-16 / cross-project (placement 3a):** the decision below. Until resolved,
  3b (CDR Import sidebar with a picker) is the zero-INV-risk fallback.
- **Derived rows:** for total/parent rows the trace is the UNION of child-cell
  legs (matching the arithmetic). Worth a one-line note in the sidebar so a
  total row's leg list reading larger than a child's is understood, not
  mistaken for double-count.
- **Engine churn:** the instrumentation must be threaded through EVERY counter
  to be complete; a missed counter shows up immediately as a trace/number
  mismatch on that cell (fail-loud, not silent) — acceptable, and the unit
  fixture should cover at least one cell per writeback pass.

## Phased delivery

- **Phase 1 — instrument + trace, no UI.** Add `opts.trace` to `calcQcdReport`,
  return the trace, unit-pin inertness + a couple of bucket fixtures. Zero
  behavior change to the daily import.
- **Phase 2 — orchestrator + sidebar.** `qcdDrilldown.js` + the sidebar (3a or
  3b per the placement decision), with the trace/number self-check banner.
- **Phase 3 — polish.** Grouping by parent call, near-miss buckets (legs that
  ALMOST matched a cell — e.g. abandoned but under the 1-min threshold), the way
  the DQE sidebar surfaces rejected rows.

## Open items (pre-build, need owner decision)

1. **Placement 3a vs 3b** — cell-selection in CDR Report (needs the trace engine
   reachable there; brushes INV-16 if duplicated) vs a picker-driven sidebar in
   CDR Import (zero INV risk, slightly worse UX). Recommend starting **3b** to
   de-risk, move to 3a only if cell-click ergonomics are wanted.
2. **Engine relocation vs duplication** (only if 3a): extract `calcQcdReport`
   into a shared module both projects load, or duplicate it byte-identically
   under the INV-16 check. Extraction is cleaner but a bigger refactor of a
   critical function.
3. **Trace fidelity A1 vs A2** — recommend A1 (cell-grain) so the drilldown can
   never drift; confirm the effort is acceptable.
4. **Historical reach** — accept the ~14-day Raw Data retention limit (drilldown
   is recent-days-only), or out of scope to do anything more.
