# 177 — Bound the Neon-outage fallback, Phase 1: a per-execution memo on the sheet DQE DAL

**Command:** `/broad-implement` (Phase 1 of the "Bound the Neon-outage fallback" plan)
**Branch:** `claude/sync-commands-kmeo99`
**Code:** R40 (R32 was already taken by the digest freshness gate — checked before assigning)

## Pre-work: the three confirmations the owner asked for

Before starting, verified the Daily Call Queue Report's failure semantics in
`QueueReportEmail.gs::runDailyQueueReport_`:

- **No subscriber email on error or an empty/partial report.** `emptyReport`
  (QCD sheet had the date but the report computed with zero departments) and
  `noRecipients` both `return` before any send; the all-fail branch and the
  outer catch likewise send nothing to subscribers.
- **The day is not marked complete.** `QUEUE_REPORT_LAST_SENT` is claimed only
  on `result.count > 0 || !failed.length`. Every failure shape leaves it unset,
  so the next poll retries.
- **Only admins are notified.** `notifyQueueReportFailure_`,
  `notifyQueueReportSendFailures_` and `queueReportFlagMissedDay_` all resolve
  recipients as `getAdminEmails_().join(',')` and bail when it is empty.

One nuance reported to the owner rather than glossed: a **partial DELIVERY**
failure (report computed fine, some addresses bounced) DOES claim the day and
the successful recipients keep their copy — deliberate, so a retry cannot
re-blast them. No subscriber ever receives an incomplete report.

## What Phase 1 shipped

`sheetFetchDqeRows_` is **dept-independent** — it filters by date, and each
caller filters by roster afterwards — so every department asking the same
question for the same window paid an identical read. R26b bounded each read's
WIDTH (min/max span, ~2.2M cells → ~37k); nothing bounded the COUNT, because
the callers are separate functions with no channel between them.

- **`DQE_SHEET_ROWS_MEMO_`** (NeonRead.gs): per-EXECUTION memo, keyed
  `(fromIso, toIso, includeMissedDetail)`, FIFO-capped at
  `DQE_SHEET_ROWS_MEMO_MAX_ = 6`. The original body moved to
  `sheetFetchDqeRowsUncached_` (still `_`-suffixed, so INV-01 holds).
- **Clone-on-read is the load-bearing part**, not defensive tidiness. Six
  readers hand this result straight to `applyQueueSplitToRows_`, which rewrites
  rows **in place** — correct while each reader owned its fetch, corrupting the
  moment two readers share one array. `dqeRowsShallowCopy_` preserves the old
  ownership contract exactly, so no caller changed. Shallow suffices for the
  same reason it does in `queueSplitNarrowedCopy_`: `slots` is always ASSIGNED,
  never index-mutated (verified by grep — the only writes are four whole-array
  assignments).
- **Not CacheService, on purpose.** A cross-request cache would need
  invalidating against the morning ingest, and the freshness-tag machinery that
  does that job is keyed per report, not per DAL read. Per-execution is the
  whole scope that is provably safe: the dashboard never writes DQE.
- **Measurement, not assertion.** Memo hits log
  `[dqe-read] sheetFetchDqeRows_:memo-hit source=sheet-memo`, timed from before
  the clone so the ms is what a hit genuinely costs. Counting `sheet-memo`
  against `sheet` lines is how the saving is judged; no test claims it is faster.

## What enforces it (C2)

Six pins in `dal-cutover.test.js` — repeat-read elision (counted via a wrapped
`getRange`), hit-vs-fresh value parity, hit-vs-uncached parity, **per-caller row
ownership**, key separation on both window and detail shape, bounded retention.
All six mutation-tested; each fires on its own pin and only its own:

| mutation | pin that fired |
|---|---|
| remove the clone | per-caller row ownership |
| drop `includeMissedDetail` from the key | key separation |
| drop `toIso` from the key | key separation |
| never store | repeat-read elision + bounded retention |
| no FIFO eviction | bounded retention |
| evict from `order` but leak `byKey` | bounded retention |

The ownership pin is the one that matters: **a memo without the clone passes
every parity assertion and silently corrupts the second department's numbers.**

### The test-side trap, mechanized

Adding a second per-execution DQE memo broke **eight tests in two suites** on
stale fixtures — the trap CLAUDE.md documented in prose for
`DQE_DATE_BOUNDS_MEMO_`. Prose was sufficient for one memo and is not for two:
the failure mode is a suite copying the reset it knows about and missing the one
it doesn't.

So `cross-file-pins.test.js` now pins that the family resets TOGETHER
(`DQE_EXEC_MEMOS`): any suite resetting one must reset all, with a
discovery-floor assert so a reshaped reset breaks the pin loudly instead of
silently passing. Mutation-tested both ways — deleting one suite's reset fires
it, and reshaping the reset syntax fires the floor.

This is a direct application of the C2 corollary: the convention was written,
"what enforces this?" was answered in the same commit.

## Finding: Phase 1 reaches 2 of 7 readers

Scoping this work surfaced that the premise was incomplete. **Five DQE readers
bypass the DAL entirely and never adopted R26b:**

| reader | note |
|---|---|
| `Data.gs::computeSummary_` | called **once per dept** — the N× multiplier that motivated the task |
| `IndividualReport.gs:350` | |
| `InsightsReport.gs:375` | |
| `Util.gs::computeActiveAgentsInRange_` | |
| `Alerts.gs:639` | |

Each runs its own `getRange(2, 1, lastRow-1, ~35)` + `getValues()` +
`getDisplayValues()` over the whole sheet. Only `MissedCallsReport` and
`AgentHome` use `sheetFetchDqeRows_`, so the memo helps those two.

**This is the remaining cost of the sheet path** — which is the DEFAULT read
source (`getDqeReadSource_()` returns `'neon'` only when the property is
explicitly set) and the whole of the Neon-outage fallback. Recorded in
CLAUDE.md's span bullet as a known gap rather than left to be rediscovered.

**Phase 1b (proposed, not started):** apply the R26b span transform to those
five. It is the same proven change, ~60× per read, no memory retention — and
unlike the memo it needs no ownership reasoning, since each reader keeps its own
fetch. Deliberately NOT bundled here: five separate readers with five different
column requirements is its own change with its own review surface.

## Verification

- `npm run ci` — 1245 pass / 0 fail; INV-16 guard clean.
- `npm run ci:ui` — skips cleanly (playwright not installed locally).
- No new Script Properties, so no `PROP_REGISTRY_` entry needed.
- No UI/payload change, so no Regression Scenario walk applies.
