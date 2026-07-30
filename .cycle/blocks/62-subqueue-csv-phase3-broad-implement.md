---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
1. **The combined-view CSV gap** (carried from Phase 1) — a combined export was a flat list with no way to tell which department a row belonged to, and no subtotals.
2. **Phase 3 — Missed Calls + Escalations** scope awareness.

Files modified:
- apps-script/department-dashboard/script.html (CSV Department column + per-dept subtotals + scope-tagged filename; `subqMissedDept_`, `subqMissedScopeNote_`, missed-fetch scoping)
- apps-script/department-dashboard/dashboard.html (`#dept-missed-scope-note` host)
- CLAUDE.md, docs/client-ui-conventions.md

CHANGES:
CSV | script.html | `exportTableCsv_` adds a leading **Department** column, but ONLY when `meta.deptsShown.length > 1` and `state.deptGroups` exists — so a single-dept export is byte-identical to before and 11 of 14 departments see no change. Rows are emitted per department, each group followed by that department's OWN subtotal (read from `deptGroups`, i.e. the same numbers its own view shows), then a grand total labelled `All shown`.
CSV | script.html | **Deliberately NO group-header pseudo-rows**, even though the on-screen table has them. A human reads a table top-to-bottom, so banners work there; a spreadsheet reader wants a Department COLUMN it can pivot and filter on, and banner rows break both sorting and filtering. The two surfaces differ on purpose, and that reasoning is now in `docs/client-ui-conventions.md` so the next person doesn't "fix" the inconsistency.
CSV | script.html | The download filename gains a `_subs` / `_all` scope tag. Without it, exporting two scopes of the same dept and date range silently overwrote the first file — a real data-loss-shaped annoyance, not cosmetic.
Phase 3 | script.html | The missed section follows the switcher **only when the scope resolves to a SINGLE department** — `subs` with one child runs on that child via `subqMissedDept_`. **It deliberately does NOT merge for `all`.** The queue-only abandoned section already covers a parent's sub-queue queues, because `queuesForDept_` rolls them up, so summing a child's report into the parent's would double-count every queue abandon AND every abandoned-ring bucket in the hour-of-day chart. This is the same trap the QCD snapshot has in Phase 1, from the same root cause.
Phase 3 | script.html + dashboard.html | `subqMissedScopeNote_` renders one line under the section title stating what is and isn't included — for `all`: "Per-agent timelines below are <dept>'s only. Queue abandons already include <subs>'s queues, so they are not added twice." That sentence is the difference between a defensible partial scope and a confusing one; without it the section silently disagrees with the table above it.
Phase 3 | Escalations | **NO CODE CHANGE, and that is the finding.** `getEscalations` already scopes by `user.departments`, so Phase 0's widening gave a parent manager their sub-queue's escalations automatically, and `metaDept` already reports the joined dept list. I verified this rather than inventing work to fill the phase.

TEST RESULTS: passed. `npm run ci` → **546/546** (unchanged — see the note below), INV-16 + cache-version-sync + claude-md-split clean. `npm run ci:ui` → 24/24 + 16/16.
**No new unit tests, and that is a real gap I am naming rather than papering over.** Both changes are pure client rendering: the CSV builder and the missed-section scope live in `script.html`, which the zero-dep `.gs` harness structurally cannot load. The UI harness *can* reach them but has no CSV-download or sub-queue fixture, and building one is a bigger job than either change. So these two are covered by the rendered-UI gate only at boot level (no console errors, no overflow) plus the manual scenarios below. If either regresses, it will be a person who notices.
No cache version changed — neither surface altered a payload shape.
Regression Scenarios: NOT EXECUTED. **S4 (missed section renders) and S6 (Source column + totals) overlap and need a live walk**, plus S40 for escalations. The CSV has no scenario at all — see FOLLOW-ON.

REGRESSION RISKS:
- **The CSV column count changes between scopes.** A combined export has one more column than a single-dept export of the same department. Anything downstream parsing these by fixed position would break — but the header row names the columns and the exports are ad-hoc manager downloads, not a feed.
- **The `isTotals` parameter went from boolean to boolean-or-`'sub'`.** `cellsFor` is local to `exportTableCsv_` and has three call sites, all updated. A truthiness check would still treat `'sub'` as totals, which is the safe direction.
- **The missed section can now show a different department than the header dept** (in `subs` scope). That is the intent, and the note states it — but a manager who misses the note could misread the section. It is one line directly under the title, in every scope where a sub-queue exists.
- **For `all` scope the missed section is NOT the combined figure** and never claims to be. This is the honest partial: fully merging it needs per-bucket chart merging plus a way to avoid the queue-abandon double-count, which is Insights-combined-view-sized work.
- `subqMissedDept_` returns null for `subs` when a parent has MORE than one child (it only auto-scopes the unambiguous single-child case), falling back to the header dept. Conservative: showing the parent with a note beats guessing which child was meant. Only relevant if a parent ever gains a second sub-queue — none has today.
- No server file was touched by either change, so no auth, cache, or payload behavior moved.

INVARIANTS AT RISK: None violated.
- **INV-53** — the CSV's per-dept subtotals come from `deptGroups`, which are each dept's own `totals`, so each already excluded its own floaters. The grand total sums those, excluding floaters exactly once. Identical reasoning to Phase 1's on-screen path.
- **CSV formula injection (the `csvSafeCell_` rule)** — the new Department cell routes through `csvEscape`, which wraps `csvSafeCell_`, like every other cell. This was the specific gotcha to not regress here and it is honored.
- INV-23 — the queue-sentinel/queue-only abandoned contract is exactly why `all` is not merged; respecting it is the reason for the partial scope.
- INV-30 — no cache key or version touched.

NET SCORE: 0 − 0 = 0
- No pre-existing production bug fixed. The CSV gap and the missed-section scope were both created by Phase 1 and closed here, which nets to zero rather than counting as a fix.
- Under /reflect's three-way tally: two structural/UX items.

OPERATOR ACTIONS / DEPLOY:
- Phase 0's action still stands and still blocks: confirm the four seeded parent pairings (`PAP→Sales`, `PAP Q→Sales`, `Spanish→CSR`, `PAK→Power`) should confer access at all. | BLOCKS DEPLOY: **Y**
- After deploying, **export a combined CSV for Sales and check it opens with a Department column, PAP's rows grouped, a `PAP subtotal` row, and an `All shown` grand total** — this is the one change with no automated coverage. | BLOCKS DEPLOY: N
- Walk **S4** (missed section) in all three scopes on Sales, confirming the scope note matches what the section shows, plus **S6** and **S40**. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + a new deployment version (script.html, dashboard.html).
- No other subsystem touched.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **No automated coverage for either change** (see TEST RESULTS). The tractable piece is a UI-harness fixture with a parent/child payload — it would cover the scope bar, the grouped table, the subtotal rows and the missed note in one go, and would have caught any of them rendering blank. Worth doing before the next sub-queue phase, since every phase adds more untested client surface.
- **No regression scenario covers CSV export at all** — not just the sub-queue case. S6 covers the Source column and totals on screen but nothing exercises a download. Promoting one is cheap and overdue.
- **Insights combined view** remains the largest open piece (own phase, `insights:v19→v20`).
- The missed section's `all` scope is a documented partial, not a finished state.
- Still open from earlier phases: `meta.subQueueAgentHint` referenced in a dead branch and never populated; the S41/S42 scenario-numbering collision (blocking promotion of any new scenario, including the CSV one above); `Field Ops Power` is not in the parent map so a Field Ops manager will not see it — owner to confirm.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. CLAUDE.md's sub-queue bullet gained the CSV rules and the Phase 3 rules including why `all` is not merged and why Escalations needed nothing; `docs/client-ui-conventions.md` gained a section covering the CSV-vs-table divergence (so it isn't "fixed" later) and the missed-section scope.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
