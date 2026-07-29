---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
1. **UI-harness fixture + asserting driver for the sub-queue surfaces** — DONE.
2. **CSV export regression coverage** — DONE (the first automated coverage of any CSV writer in this repo).
3. **Insights combined view** — **NOT STARTED. Deliberately.** See the note below; this is the honest report, not a partial ship.

**Why item 3 was not attempted.** I measured it before committing: `InsightsReport.gs` is 992 lines with 23 references to the team-comparison fields (`teamStats`, `rosterAgentCount`, `answeredDeptTotal`, `trendData`, `agentData`), and the client has 93 `ins*` functions with 15 more touch points on those same fields. A combined view means per-dept team rollups threaded through the KPI tiles, the share-of-answered donut, the per-agent cards, the trend chart AND the Insights↔My-Department hand-off, plus `insights:v19→v20`. Starting it with the context I had left would have produced a half-wired report — and Insights is the flagship surface managers actually use, where a half-wired team average is worse than no feature. Items 1 and 2 are complete, verified, and gate-wired; item 3 needs its own session with room to do the rollup properly.

Files modified:
- tools/ui-harness/drive-subqueue.js (NEW — 19 asserting checks)
- tools/ui-harness/gen-payloads.js (`summary-30d-own`, `summary-30d-subs`)
- tools/ui-harness/build-harness.js (subScope-aware `getDepartmentSummary` stub)
- tools/ui-harness/ci.mjs (third gate driver)

CHANGES:
1 | gen-payloads.js | **The fixture already nested Spanish under CSR** (via the `OVERVIEW_PARENT_OF` constant), so the default CSR payload was *already* the combined view — no new fixture was needed, only the missing scopes. Added `summary-30d-own` and `summary-30d-subs` so the switcher's round-trip is exercised for real instead of the stub serving the combined payload back regardless of scope. Finding the fixture already capable was worth checking first: building a parent/child roster from scratch would have been wasted work.
1 | build-harness.js | The `getDepartmentSummary` stub now dispatches on `req.subScope` for the 30-day window. Without this the driver could assert the combined render but not that a scope switch changes anything — the most likely real regression.
1 | drive-subqueue.js | 19 assertions across the surfaces four phases left untested: the scope bar renders with all three options and defaults to combined; the note names the sub-queue in every scope (including `own`, where it must disclose the exclusion); the table groups by dept with the child tagged; each dept gets its own subtotal; all 7 agents from both depts render; switching to `own` drops the grouping; and the missed section discloses its scope.
1 | drive-subqueue.js | **The S35 parity property is now automated.** The driver reads the CSR subtotal from the combined view, switches to `own` scope, reads the totals row, and compares every numeric cell. That is the one property that makes the combined view trustworthy — a dept's subtotal must equal what its own view shows — and it was previously only checkable by a human with two screenshots.
2 | drive-subqueue.js | **First automated CSV coverage in the repo.** The exporter builds a Blob and clicks an anchor, so the driver stubs `URL.createObjectURL` and reads the Blob's text — asserting the real bytes a manager would open rather than re-implementing the builder. Checks: a single-dept export has NO `Department` column (byte-compatibility with pre-sub-queue exports), a combined export leads with it, carries `CSR subtotal` and `Spanish subtotal` rows and an `All shown` grand total, and has NO group-header banner rows (the deliberate CSV-vs-table divergence).
1+2 | ci.mjs | Wired as the third gate driver, so all of the above runs on `npm run ci:ui` and in the `ui-harness` CI job.

TEST RESULTS: passed. `npm run ci` → **546/546** (no unit tests added — these are browser assertions by necessity), INV-16 + cache-version-sync + claude-md-split clean. `npm run ci:ui` → **24/24 + 16/16 + 19/19, all stages passed**.
**Both new assertion classes were verified by breaking them:** removing the CSV `Department` header fails the column check, and making `combineSummaries_` mutate a part it should only read (`t.totalRung += 1`) fails the S35 parity check with a visible off-by-one in the diff — which is exactly the silent bug class that property exists to catch.
Regression Scenarios: S43 (combined-view CSV) is now **partly automated** by this driver; the manual walk still covers the formula-injection spot-check and the filename-collision case, which a headless download can't observe. S35's addendum is automated for the parent-subtotal comparison; the weighted-duration check remains manual (it needs a dept whose durations differ).

REGRESSION RISKS:
- **The harness stub is now scope-aware only for the 30-day window.** Other windows serve the combined payload for any `subScope`, so a driver asserting scope behavior outside 30 days would silently pass. Scoped deliberately (three payload dumps per window would triple fixture size); the driver only uses the 30-day window.
- **`URL.createObjectURL` is stubbed for the whole page** in this driver. It restores nothing, but the page is closed immediately after and no other driver shares the context.
- The CSV click is located by matching visible text (`/download csv/i`) rather than an id, because the item lives inside the R9-2 Export dropdown. A label change would break the driver rather than the feature — an acceptable trade for not adding a test-only id, but worth knowing when the failure reads as "CSV export produces a file at all".
- No `apps-script/` file was modified in this increment, so **no production behavior changed at all**. This is pure test infrastructure.
- Gate runtime grew by one browser launch (~20s). The `ui-harness` job still carries `continue-on-error: true`, so a flake cannot block a PR — which also means these assertions are advisory until that line is dropped.

INVARIANTS AT RISK: None. No production file touched; no cache key, payload shape, auth path or invariant behavior involved.

NET SCORE: 0 − 0 = 0
- No production bug fixed. Under /reflect's three-way tally this is one defensive/structural item — but it is the one that changes the odds on every *future* sub-queue change, which is why it was worth doing before item 3 rather than after.

OPERATOR ACTIONS / DEPLOY:
- **Nothing to deploy.** No `apps-script/` file changed; this increment is harness-only.
- Phase 0's action still stands and still blocks the *earlier* increments: confirm the four seeded parent pairings (`PAP→Sales`, `PAP Q→Sales`, `Spanish→CSR`, `PAK→Power`) should confer access at all. | BLOCKS DEPLOY: **Y**
- Consider dropping `continue-on-error: true` from the `ui-harness` job now that a third asserting driver has been added and all three are green — until then every one of these checks is advisory. | BLOCKS DEPLOY: N
Deploy:
- N/A for this increment. The pending deploys from increments 53–62 are unchanged.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **The Insights combined view is the one remaining substantial sub-queue piece** and needs its own session: per-dept team rollups through the KPI tiles, share donut, per-agent cards, trend chart and the My-Department hand-off, plus `insights:v19→v20`. The Phase 2 one-dept-per-run rule is the correct interim behavior, so nothing is broken while it waits — a parent manager reaches a sub-queue's Insights by selecting its picker group.
- The weighted-duration half of S35's addendum is not automated (needs a fixture where two depts' duration means differ enough to distinguish weighted from unweighted).
- `meta.subQueueAgentHint` is still referenced in a dead branch of `subqRenderScopeBar_` and never populated — wire it as an agent count in the `own`-scope note, or remove it.
- `Field Ops Power` is not in the parent map though it looks like a `Field Ops` sibling; under the Phase 0 widening that decides whether a Field Ops manager sees it. Owner to confirm.
- The missed section's `all` scope remains a documented partial (it shows the parent, because merging would double-count queue abandons).

DOCUMENTATION UPDATES NEEDED: None outstanding. The driver's own header documents why it exists, why the CSV is asserted via a `createObjectURL` stub, and that the fixture was already parent/child capable; `docs/client-ui-conventions.md` and CLAUDE.md already carry the CSV-vs-table divergence and the scope contracts from increment 62. Worth noting for a future `/sync-docs`: CLAUDE.md's Key-commands text lists the gate's asserting drivers as "drive-smoke.js … and drive-f13.js" and should now name three.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
