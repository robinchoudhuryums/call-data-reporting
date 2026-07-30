---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
1. **Phase 0** — the combined view's grand total double-counted every CROSSOVER agent (one on two depts' rosters).
2. **Phase 1** — the pipeline now writes a per-queue breakdown (DQE col AI), additively.

Both from `docs/sub-queue-split-plan.md`. The owner's standing constraint for this increment was that pipeline changes be **strictly additive with existing columns and computations provably unchanged** — that shaped several decisions below and is asserted, not asserted-to.

Files modified:
- apps-script/department-dashboard/Data.gs (`combineSummaries_` crossover correction, `summary:v17`)
- apps-script/department-dashboard/script.html (totals-row caption + CSV total-row caption)
- apps-script/department-dashboard/Config.gs (`HISTORICAL_COLS.QUEUE_SPLIT` = 35)
- apps-script/cdr-import/buildDQEHistoricalData.js + apps-script/cdr-report/ (INV-16 pair)
- apps-script/cdr-report/neonWrite.js + apps-script/cdr-import/ (INV-16 pair)
- apps-script/cdr-report/neonbackfill.js, apps-script/cdr-import/NeonMirror.js, apps-script/cdr-report/sheetRepairs.js
- apps-script/department-dashboard/OrphanFix.gs (cache-version comment)
- tests/harness/fakeSheet.js, tests/unit/queue-split.test.js (NEW), subqueue-access.test.js, cross-file-pins.test.js, neon-write-mapping.test.js
- CLAUDE.md, docs/{invariants,architecture,conventions,known-issues,client-ui-conventions,sub-queue-split-plan}.md

CHANGES:
P0 | Data.gs | `combineSummaries_` SUBTRACTS each repeat appearance of a roster agent instead of re-deriving the grand total from `rows`. **Deliberate**: a correction pass over the untouched accumulation means a no-crossover combine is byte-identical *by construction* — the strongest form the additive guarantee can take — and it avoids coupling the totals to `matchedViaRoster` being present on every row, which is a property of `computeSummary_` output this function shouldn't assume. (I built the re-derivation first; it broke four existing fixtures that don't set that flag, which is exactly the coupling worth avoiding.)
P0 | Data.gs | Per-dept subtotals are **NOT** deduped — each must still equal that dept's own view (S35). The consequence is that the grand total can now be LESS than the sum of the subtotals, so `totals.crossoverAgentCount` ships with it.
P0 | script.html | Both the on-screen totals row and the **CSV** total row now say "N in both departments, counted once". Without this the change would trade a wrong number for an unexplained one — and a spreadsheet reader is *more* likely to add the subtotals up and find a shortfall, with no tooltip to fall back on.
P0 | Data.gs | The three DURATION means are deliberately left alone, crossover included. A doubled sum is arithmetically wrong; a mean weighting one agent in two depts stays in range, and recomputing it would move the number for EVERY combined view because a weighted mean of per-dept `avgNonzero_` results isn't `avgNonzero_` over the union. Phase 2 dissolves the question.
P1 | buildDQEHistoricalData.js | New pure `dqeQueueSplitForAgent_` emits col **AI** as JSON keyed by raw queue name. **Reconciliation contract**: leg-level figures partition by each leg's own queue; parent-level ones (unique, talk) attribute to the queue of that parent's EARLIEST leg — so an overflow call that rang one agent through two queues isn't counted twice and the split SUMS BACK to the rollup. Without that rule the split would silently exceed the rollup and Phase 2's slices would disagree with the totals above them.
P1 | buildDQEHistoricalData.js | The split call is **try/catch-wrapped**: on a throw the column goes out blank and cols A–AH are untouched. A defect in new code can therefore never cost a day of DQE history.
P1 | buildDQEHistoricalData.js | **Sheet-width guard.** Sheets does NOT auto-expand columns — `getRange` past `getMaxColumns` throws (the REP-10 failure) — and every production sheet is 34 wide, so the build now widens to 35 *before* any col-35 access. Without this the FIRST build after deploy would have thrown and lost that day: the worst possible outcome for an "additive" change, and not obvious from reading the code.
P1 | neonWrite.js | `queue_split` added (35 params/row), idempotent `ADD COLUMN IF NOT EXISTS` memoized per execution, and the upsert **COALESCEs** it: `remirrorExistingDqeDate_` re-reads the SHEET, so a pre-Phase-1 date would send NULL and erase a split a later build had already mirrored. A build with nothing to split emits `'{}'`, never NULL, so COALESCE can only ever preserve a value nothing meant to clear.
P1 | neonbackfill.js | Same treatment for both DQE backfills — `backfillDQEHistoryUpsert` is the documented post-bulk-rebuild step and uses DO UPDATE, so without carrying `queueSplit` it would have wiped every split in the table. Reads are `Math.min(35, getMaxColumns())` (REP-10 again); the two read-only diagnostics keep their 34.
P1 | sheetRepairs.js | `mergeDqeDuplicateRows_` recomputes the rollup from merged duplicates and has no way to merge two splits, so it now CLEARS col AI. A stale split describing fewer calls than the row it sits on is worse than no split, because a reader would trust it.
P1 | Config.gs | `HISTORICAL_COLS.QUEUE_SPLIT = 35`. Note every dashboard reader derives its width from `CSR_AVG_ABD_WAIT` (34), which is unchanged — so all ten of them still read exactly 34 columns and are untouched.

TEST RESULTS: passed. `npm run ci` → **571/571** (was 556; +15), INV-16 + cache-version-sync + claude-md-split clean. `npm run ci:ui` → 24/24 + 16/16 + 19/19.
**The additive claim is asserted twice over**: the 11 pre-existing `pipeline-build.test.js` cases — which pin the old output — all pass unmodified, and `queue-split.test.js` freezes cols A–AH as literals for a two-queue fixture. Three test doubles encoded the old 34-col shape and were updated as part of the change, not reactively: `fakeSheet` (no `getMaxColumns`/`insertColumnsAfter` — the pipeline suite failed until added), the writer param-order pin, and the R8-D1 width tripwire.
**Both fixes verified by breaking them:** disabling the crossover subtraction fails the Phase 0 total test; the Phase 1 suite covers the throw path, the narrow-sheet path, and the two-queues-one-parent path directly.
Regression Scenarios: NOT EXECUTED. **S35 (combined totals) and S6 overlap and need a live walk** — S35 specifically, since the grand-total semantics moved.

REGRESSION RISKS:
- **The build now MUTATES the live sheet's shape** (`insertColumnsAfter`) on its first run. Idempotent and one-time, but it is a structural change to a production spreadsheet, and it is NOT inside the split's try/catch — if it threw, the build would fail. Left uncaught deliberately: catching it doesn't help, since the col-35 write would throw next; the only real alternative is a dual 34/35-column write path, which is more complexity than the risk warrants on a 34-column sheet.
- **`dqe_history` gets a new column via DDL on first write.** If the Neon role lacked ALTER, every DQE mirror would fail where it previously succeeded. Precedent is strong — `inbound_calls` has run `ADD COLUMN IF NOT EXISTS` on every write in this same database for months — but it is a new dependency for the DQE path.
- **The grand total no longer equals the sum of the subtotals** when a crossover agent exists. Intended, and captioned in both surfaces, but it is a visible change to a number managers read.
- **`crossoverAgentCount` counts repeat ROWS, not distinct people** — an agent on three rosters contributes 2. That is the right number for "how many duplicate appearances were removed" and reads correctly in the caption; it is not a headcount.
- No dashboard READER changed. All ten DQE readers still take `CSR_AVG_ABD_WAIT` (34) as their width, so the extra column is invisible to them until Phase 2 opts in.

INVARIANTS AT RISK: None violated.
- **INV-10** — the schema grew by one column; the entry is updated with the new column's contract, its three states, and the widen/plain-text traps.
- **INV-16** — both duplicated pairs re-synced and the guard re-run; `dqeQueueSplitForAgent_` lives inside the duplicated file so it travels with it.
- **INV-30** — `summary:v17` (Phase 0 changed the payload); five docs synced, all found by the cache-version guard rather than by hand.
- **INV-53** — untouched. The floater gate lives in `computeSummary_`; Phase 0 only de-duplicates, and a floater is explicitly not a crossover (no roster claims them, so nothing was double-counted).
- **INV-02/07/20/23** — preserved by construction: the split reads `windowLegs` (INV-07), stores CST times via the same `pstToCSTStr` (INV-20), and sentinel rows carry `''` (INV-23).
- The number-coercion gotcha — col 35 embeds comma-joined times, so it is plain-texted on both the whole-column and exact-write-range passes, like AD–AF and K–AC.

NET SCORE: 1 − 1 = 0
- Phase 0 fixed a bug that IS firing in production right now (CSR/Spanish crossover agents inflate the combined grand total).
- Phase 1 introduces two new operations that can fail where nothing could before (the sheet widen and the Neon ALTER). Both are guarded and precedented, but counting them as zero would be flattering myself.

OPERATOR ACTIONS / DEPLOY:
- **Deploy CDR Import + CDR Report first, then re-run the DQE build for the surviving Call_Legs dates** (a force re-import of each). This is the only chance to capture split history for those ~14 days; after that they are permanently unsplittable. | BLOCKS DEPLOY: N (but time-critical)
- After the first build, confirm `DQE Historical Data` has 35 columns and col AI holds JSON, and that `dqe_history.queue_split` exists. | BLOCKS DEPLOY: N
- If the bulk-rebuild path is used, `backfillDQEHistoryUpsert()` now carries the split — no change to the runbook. | BLOCKS DEPLOY: N
- Walk **S35** in a combined view: the grand total should now be less than the sum of the subtotals for CSR+Spanish, with the caption explaining it. | BLOCKS DEPLOY: N
Deploy:
- CDR Import: `cd apps-script/cdr-import && clasp push -f`
- CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
- Department Dashboard: `clasp push -f` from repo root + a new deployment version.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **Phase 2 is where the reported bug actually gets fixed** — until it lands, each dept still shows a crossover agent's all-queue numbers. Phase 0 only corrects the total. `summary:v18`.
- Phase 1 stores `mt` (per-queue missed times) that nothing reads yet; it exists because Phase 3 cannot recover it later. Same reasoning for `n`.
- The AD/AE/AF abandoned columns are NOT split — Phase 3 territory. They are per-parent and would need the same earliest-leg attribution.
- No `backfillDqeQueueSplit` helper was written: re-running the existing build for a date does the job, and a second code path over the same data is a liability. If the 14-day sweep proves painful by hand, that is when to write one.
- The Insights combined view remains the largest open sub-queue piece, still unstarted.
- `meta.subQueueAgentHint` is still a dead reference.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. CLAUDE.md gained a Common Gotchas bullet for col AI (states, reconciliation, the two traps) and the Phase 0 caveat on the sub-queue decision's "every number reconciles" claim; INV-10 and INV-30 updated; the plan doc's status and Phase 1 section rewritten to match what shipped.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
