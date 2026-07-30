---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: **Phase 2** of `docs/sub-queue-split-plan.md` — My Department consumes the per-queue split, so a department's view shows only ITS OWN queues' calls. This is where the originally reported bug is actually fixed (Phase 0 only corrected the combined total; Phase 1 only captured the data).

Files modified:
- apps-script/department-dashboard/Data.gs (`applyQueueSplitToRows_`, the pre-pass call, `queueScoped` propagation, meta coverage fields, the Phase 0 interaction, `summary:v18`)
- apps-script/department-dashboard/NeonRead.gs (both DAL primitives carry `queueSplit`)
- apps-script/department-dashboard/script.html (`subqSplitNote_`, `daysInRangeInclusive_`)
- apps-script/department-dashboard/styles.html (`.subq-split-note`)
- apps-script/department-dashboard/OrphanFix.gs (cache-version comment)
- tests/unit/queue-split.test.js (+10)
- CLAUDE.md, docs/{invariants,architecture,conventions,known-issues,client-ui-conventions,sub-queue-split-plan}.md

CHANGES:
P2 | Data.gs | `applyQueueSplitToRows_` rewrites the six per-agent metrics from the dept's slice **before** the aggregation loop. Deliberately a pre-pass, not edits inside the loop: `computeSummary_` carries INV-02/04/05/23/53 + S35 + E5 and is the most heavily pinned function in the app — narrowing at the boundary means the E5 prior window, the floater gate, diagnostics and the totals row all inherit the fix without one of them having to learn what a queue is.
P2 | Data.gs | **Fails open three ways**, because showing a department ZERO calls is far worse than showing it too many: a dept with no mapped queues is left entirely alone (its slice would be all zeros — "nobody worked today"), a row with no split keeps its rollup, and unparseable JSON keeps the rollup rather than throwing. Each is tested separately.
P2 | Data.gs | ATT is **recomputed** as `t/n` on that queue's own denominator rather than scaled, mirroring the rollup's formula. `avgAbdWait`/`csrAvgAbdWait` are deliberately NOT narrowed — the pipeline computes them once per DAY and stamps the same value on every agent row, so they were never per-agent and there is nothing per-queue to slice.
P2 | Data.gs | Queue matching is case-insensitive against `inboundQueuesForDept_` (`queuesForDept_` ∪ the Dept Config raw-name aliases). Matching `queuesForDept_` alone would silently drop CSR's main queue, since raw `A_Q_CSR` ≠ canonical `A_Q_CustomerSuccess` — the R8-1 lesson.
P2 | Data.gs | **The Phase 0 rule is INVERTED for scoped rows, and this is the one place the two phases could silently fight.** Phase 0 subtracts a crossover agent's repeat appearance because both depts carried identical all-queue figures. Once narrowed, the two rows carry DIFFERENT figures that partition the day — summing is correct and subtracting would under-count. A `queueScoped` row now returns before the de-dup and never enters the seen map, so it can neither be subtracted nor cause a later un-scoped row to be. Judged per row, not per payload, because a range spanning the cutover holds both kinds.
P2 | Data.gs / NeonRead.gs | Sheet reads widened to col AI but clamped `Math.min(QUEUE_SPLIT, getMaxColumns())` — the DQE sheet is still 34 wide until the Phase 1 pipeline runs against it, and an unclamped read THROWS (REP-10). At 34 the cell reads `''` and every row keeps its rollup, which is exactly pre-Phase-2 behavior.
P2 | NeonRead.gs | `neonFetchDqeRows_` selects `COALESCE(queue_split,'')`; `sheetFetchDqeRows_` gained the same field so the two DAL primitives stay symmetric and `compareDqeSources_` remains faithful.
P2 | script.html + styles.html | `subqSplitNote_` renders the owner-chosen disclosure: "per-queue detail starts `<date>`; earlier days count all queues". Warn-tinted rather than muted **on purpose** — it changes how the numbers above it should be read, so it must not look like a footnote. Three distinct states: unmapped dept, no split at all in range, partially split. Silent when the range is fully split, so it disappears once history catches up.

TEST RESULTS: passed. `npm run ci` → **581/581** (was 571; +10). `npm run ci:ui` → 24/24 + 16/16 + 19/19. INV-16 + cache-version-sync + claude-md-split clean.
The reported bug is verified by breaking the fix: disabling the narrowing fails `P2: a dept sees ONLY its own queue's calls`. The partition property (`CSR slice + Spanish slice == the rollup`) and the Phase 0/Phase 2 interaction each have their own test.
Regression Scenarios: NOT EXECUTED. **S35, S6 and S4 overlap and need a live walk** — S35 above all, since both the per-dept subtotals and the grand-total semantics moved.

REGRESSION RISKS:
- **Every department's numbers change the day split history exists** — that is the point, but a manager watching a trend across the cutover will see a step down for any agent who works another department's queue. The note explains it; nothing else can.
- **A dept whose queues are mapped WRONG now shows too few calls**, where before it showed too many. This is the one direction where the change can make a number worse rather than better, and it is invisible without checking Dept Config. Mitigated only by the unmapped-dept fail-open, which does not fire for a dept that has *some* queues mapped but is missing one. Worth a spot-check per dept after deploy.
- **`rosterAgentCount` counts a crossover agent twice in a combined view** once rows are scoped (two rows, two data points). Correct for the duration weighting; reads as "agent-dept rows" rather than headcount in any caption that uses it.
- The DAL now carries one extra text field on every row. `neonFetchDqeRows_` is the 12-month IR/Insights window too, so payload size grows there — bounded, since the split is a few hundred bytes and only `computeSummary_` reads it.
- No pipeline file touched in this increment.

INVARIANTS AT RISK: None violated.
- **INV-05** — the dashboard's simple-mean ATT semantics are preserved; the narrowed row's ATT is the same *kind* of number (a per-row mean), recomputed on its own denominator, and the accumulator's zero-skipping is unchanged.
- **INV-53** — untouched. The floater gate lives in the aggregation loop, which this change deliberately does not enter.
- **INV-23** — sentinel rows carry no split, so they take the fail-open path and are skipped by the loop exactly as before.
- **INV-30** — `summary:v18`; six docs synced, all found by the cache-version guard.
- **INV-02** — the split is read as a DISPLAY value, consistent with the duration columns.
- **INV-10** — no new column; Phase 2 only reads the one Phase 1 added.

NET SCORE: 1 − 0 = 0 … recorded as **1 − 0 = 1**.
- Fixes the bug the owner actually reported, which is firing in production for every CSR/Spanish crossover agent.
- No new failure mode: all three uncertainty paths fail open to the previous behavior, and the read widening is clamped against the REP-10 throw.

OPERATOR ACTIONS / DEPLOY:
- **Phase 2 does nothing until Phase 1 has run.** Deploy cdr-import + cdr-report FIRST, let the build run (or force a re-import), and only then does the dashboard have splits to read. Deploying the dashboard alone is harmless — every row fails open to the rollup and the note says the range has no per-queue detail. | BLOCKS DEPLOY: N
- **Verify each department's queue mapping in Dept Config before trusting the narrowed numbers.** A dept missing one of its queues now under-reports rather than over-reports, and only the fully-unmapped case fails open. | BLOCKS DEPLOY: N (but do it early)
- Walk **S35** in a combined view and confirm a crossover agent's two rows now show DIFFERENT numbers that sum to their old single figure. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + a new deployment version.
- No pipeline subsystem changed in this increment (Phase 1's deploy still pending from increment 64).

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **Phase 3 (Missed report)** — the per-agent missed timelines and the hour-of-day chart still show all-queue misses. The split carries `mt` (per-queue missed times) for exactly this, but AD/AE/AF are not split and would need the same earliest-leg attribution.
- **Phase 4 (IR / Insights)** — per-agent cards, team averages and trends are still all-queue, so an IR run for a sub-queue disagrees with My Department for a crossover agent. Worth doing soon for that reason.
- `meta.subQueueAgentHint` is still a dead reference in `subqRenderScopeBar_`.
- The Insights combined view remains unstarted.
- No UI-harness coverage of the split note — the fixture has no crossover agent and no split column, so the note's three states are untested in a browser. Adding a crossover agent to the fixture would also give S35's parity property a sharper test.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. CLAUDE.md's sub-queue decision now carries the Phase 2 narrowing, the three fail-open paths, the non-narrowed abd-wait columns and the Phase 0 inversion; INV-30 records `summary:v18` and the new payload fields; the plan doc's status and Phase 2 section rewritten to match what shipped.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
