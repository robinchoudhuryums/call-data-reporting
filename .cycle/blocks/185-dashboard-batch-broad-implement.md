---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: the dashboard batch (owner testing notes, 2026-09-10) — #8 Range period on the Queue Call Data card (Yesterday stays default); #6 the Answered / Missed bar sorts by answered VOLUME, Answer % keeps the rate; #7 an "Ans / day" hideable column (answered per active day, server-computed, summary:v22); the stale freshness pill is AMBER via a dedicated `--stale` token.
Files modified: apps-script/department-dashboard/{dashboard.html, script-1-core.html, script-5-dept.html, styles.html, Data.gs, OrphanFix.gs (comment)}, CLAUDE.md, docs/{invariants.md, known-issues.md, conventions.md, operator-state.md, client-ui-conventions.md, architecture.md}, tests/unit/{compute-summary.test.js, html-include-structure.test.js}

CHANGES:
#8 | dashboard.html, script-5-dept.html | Third period button `Range`, shown only when the server shipped `qcd.range` (Batch D; same `buildBlock_` shape as `mtd`). Resolver: `range` when selected and present, else the existing yesterday/mtd logic; persisted `cdr.dept.qcdperiod` accepts `range`; default stays `yesterday` (owner). Deltas vs `qcd.rangePrior` (R11-C1) reuse the MTD context shape with `perDay:false` — the INV-28 prior has the same working-day count, so volume compares RAW and there is no low-signal gate; the "Ø N/day" sub-line is suppressed for Range (the tile already shows the raw total). Title branch + both hover hints now point at the Range button instead of "open Insights for a range". Client-only, no fetch, no cache bump.
#6 | dashboard.html ×2 theads, script-1-core.html COLUMNS, script-5-dept.html sortRows | Bar `<th data-sort>` and COLUMNS `sortKey` → `totalAnswered`; Answer % keeps `answerRate`. `sortRows`' idle-sink special case now covers BOTH keys (the old case covered `answerRate` alone; a volume sort would have floated idle agents to the top of an ascending sort). Default landing unchanged: `state.sortKey='answerRate'` (worst rate first) — the arrow now renders on the Answer % header, the column that carries the rate. Overview mini-table shares COLUMNS/sortRows and gets the same behavior.
#7 (server) | Data.gs | Per row: `ansPerDay` = answered / the EXISTING `daysActive` (days with any row in the USER window — `a.days` is user-window only; the E5 prior window accumulates in `priorAcc`), `round1_`, null when no active day. Totals: `daysActive` = distinct ROSTER-active days (`deptDays`, INV-53) and `ansPerDay` over it, so the team figure reconciles with `totals.totalAnswered` rather than averaging per-agent rates. `emptySummary_` emits the same shape. `summary:v21` → `v22`; every doc/comment mention synced (8 sites — the cache-version sweep caught three my first grep missed: OrphanFix.gs's comment and two version TABLES in known-issues.md / conventions.md).
#7 (client) | script-1-core.html, dashboard.html ×2 theads, script-5-dept.html fmtCell | `{ key:'ansPerDay', type:'num1', hideable:true }` after Answer %, in both static theads (1:1 by position). New `num1` cell type: one decimal, dash for null, the day count in the tooltip so the divisor is never a mystery. CSV emits it via the generic column path.
stale | styles.html, docs/client-ui-conventions.md, CLAUDE.md | `--stale` / `--stale-soft` (amber, hue ~80) defined at ALL five sites `--warn` is (light hex, light oklch, dark hex, dark oklch, the html2canvas export override). `.freshness-pill.is-stale` uses them. Rationale in the conventions doc: `--warn` sits at hue ~30 and read as red; staleness is a caution about age, not a fault. CLAUDE.md's "tints warm orange" corrected.
pins | html-include-structure.test.js | Three source pins: bar/Answer % sort keys agree across both theads + COLUMNS and sortRows idle-sinks both; Range wired end to end (markup, resolver, toggle, persisted default); `.is-stale` on `--stale` AND `--stale` defined at exactly as many sites as `--warn` (a token defined in one block and missing from another cannot ship).
pins | compute-summary.test.js | Two tests: per-row + totals `ansPerDay`/`daysActive` with prior-window rows AND a queue-only floater on a day no roster agent worked (neither counts); the empty window carries `totals.ansPerDay = null`, never 0.0.
docs | CLAUDE.md column-model bullet | Now says the bar sorts by volume, lists six hideable columns incl. Ans / day.

TEST RESULTS: passed — `npm run ci` 1293/1293 (1288 + 5 new), INV-16 guard clean. **`npm run ci:ui` run LOCALLY (playwright installed into the gitignored tools/ui-harness) and GREEN — all eight stages, 92/16/30/14/47/14/20 checks.** The harness payloads are computed by the REAL server code and carry `ansPerDay` per row and `qcd.range` + `rangePrior`, so the gate rendered the new column (folded) and SHOWED the Range button. No driver CLICKS the period toggle (drive-smoke does not drive it), so the Range RENDER path is covered by the source pins and the S32 walk, not by the gate.
MUTATION TESTING: html-include-structure 7/7 fire (each th reverted; COLUMNS sortKey reverted; sortRows idle-sink narrowed; Range button removed; resolver never resolves range; pill back on --warn; --stale missing from the dark block). compute-summary 5/5 fire — C5 (totals counting non-roster days) could NOT fire on the first fixture, which was all-roster; the fixture gained a floater on a roster-idle day and C5 fires. Sources restored byte-identical.

REGRESSION RISKS:
- #6 changes what a header click does for anyone who clicked the bar to sort by rate; the rate sort is one column right and the default landing is unchanged.
- #7 adds a CSV column (the CSV emits every column regardless of the fold), so a downstream consumer parsing by position shifts by one after Answer %.
- #7 `summary:v22`: every My Department view recomputes once after deploy (a version bump is a forced miss on the 6 h tier). Expected, one-time.
- #8: a browser with `cdr.dept.qcdperiod = range` persisted falls back to Yesterday whenever a payload lacks `qcd.range` — by design.
- stale: contrast NOT measured here. Dark `#e2b04e` / `oklch(78% 0.13 85)` sits in the same lightness band as the dark `--warn`; light `#a97a12` is darker than `--warn`. S41 (theme × mode, perceptual) is the check and is human-only.

INVARIANTS AT RISK: None. INV-30 / INV-09 — bumped, docs synced, enforced by cache-version-sync (which caught the three sites I missed). INV-53 — `totals.daysActive` counts ROSTER days only, pinned with a floater fixture. INV-05 untouched. INV-01 — no new public function.

REGRESSION SCENARIOS: S1, S2, S6, S23, S30, S32, S41, S43 overlap. NOT RUN here (live). The rendered gate covers S1/S2/S23 rendering; S30 (pill) + S41 (theme sweep) are the amber checks; S32 (queue data) is the Range walk; S43 the CSV shape.

NET SCORE: 0 production fixes − 0 new failure modes = 0
(A feature batch from owner testing notes, not bug fixes; the score is not the point.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the DASHBOARD: `clasp push -f` from the repo root, then Deploy → Manage deployments → New version (or `scripts/deploy.sh . <deployment-id>`, which gates on ci + ci:ui and stamps the build). | BLOCKS DEPLOY: N
- After deploy: S41 in both modes for the amber pill; open Queue Call Data → Range; sort the agent table by the bar header; toggle "Show all columns" for Ans / day. | BLOCKS DEPLOY: N
- If anything downstream parses the My Department CSV by column position, it gains a column after Answer %. | BLOCKS DEPLOY: N
Deploy: `clasp push -f` (repo root) + new version in Manage deployments

FOLLOW-ON ITEMS:
- IndividualReport.gs carries its own `activeDays` (`deptStats.activeDays` / `dayCount`) — a third spelling of the active-day concept next to `daysActive`. Unify someday; out of scope.
- drive-smoke.js does not click the QCD period toggle — a one-click addition would make the Range RENDER path gate-covered instead of pin-covered.
- Not in this batch, unchanged: #2 + #1 (help chips: drop the last-30-days override + seq guard; tour gated on `ovLoad_` instead of the 1200 ms timer), #5 (after-hours, two additive DQE columns — the 14-day clock is running), Phase 2 (nightly check-and-sort, incl. the bulk-path sort-failure Pipeline Health row).
- Carried: `parseDateForNeon` bare-numeric → year 45726; qcd-report.test.js `delete` leak; `getDeptQueueExts_` A–D vs C+D; QCD budget per-run.

DOCUMENTATION UPDATES NEEDED:
- None beyond what shipped: INV-30 v22 entry, the conventions doc's `--stale` bullet, CLAUDE.md's column-model bullet + pill wording, the eight version-mention syncs.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
