---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Sub-queue view work, **Phase 1 — the My Department scope switcher + transparent combined view**. Phases 2 (Insights / IR) and 3 (Missed / Escalations) are NOT in this change.

Files modified:
- apps-script/department-dashboard/Data.gs (`combineSummaries_`, subScope resolution, `summary:v16`, rows carry `dept`)
- apps-script/department-dashboard/script.html (`subqRenderScopeBar_`, `subqRowGroups_`, `subqSubtotalRowHtml_`, prefs, request wiring)
- apps-script/department-dashboard/dashboard.html (`#dept-subq-bar` host)
- apps-script/department-dashboard/styles.html (scope bar, group header, subtotal row)
- tests/unit/subqueue-access.test.js (+5, the merge layer)
- CLAUDE.md, docs/invariants.md (INV-30 v16), docs/client-ui-conventions.md, plus the `summary:v15→v16` sweep across OrphanFix.gs + 4 docs

CHANGES:
Phase 1 | Data.gs | **`combineSummaries_` merges per-department summaries rather than teaching `computeSummary_` to aggregate a list.** Deliberate: `computeSummary_` carries INV-02/04/05/23/53 + S35 + E5 and is the most heavily pinned function in the app, so merging outside it leaves every one of those rules untouched — and it buys the property the owner actually asked for, that **a dept's subtotal in the combined view is produced by the EXACT code path as that dept's own view**, so the two cannot disagree. Cost: N reads instead of 1 for a combined view (2 for the three real parents), paid once per 30-min TTL per (dept, range, scope).
Phase 1 | Data.gs | Duration means (`attSeconds` / `avgAbdWaitSeconds` / `csrAvgAbdWaitSeconds`) merge as an agent-count-WEIGHTED mean, never a mean of means — which would over-weight a one-agent sub-queue. A dept with no non-zero agents drops out of both sides, matching `avgNonzero_`'s own semantics (v11 / F-29). Pinned, and verified by breaking it.
Phase 1 | Data.gs | **`qcd` / `csrTransfer` / `diagnostics` come from the PRIMARY dept only.** This is a trap, not an omission: `queuesForDept_` already rolls a parent's sub-queue queues into the parent's QCD snapshot (the v6 change), and that snapshot has its own Main / Sub-queues / All-queues carousel — merging QCD across depts here would double-count every sub-queue call. Pinned with the reason in the assertion.
Phase 1 | Data.gs | `subScope` ('own' | 'subs' | 'all') resolved server-side, defaulting to `all` for a dept WITH sub-queues and `own` otherwise, forced to `own` when there are no children. Every dept in the resolved set is authorized INDEPENDENTLY via `assertDeptAccess_` — Phase 0 put the children in `user.departments`, but that must be checked rather than assumed, so a child whose access edge was dropped by the read-side guards (cycle / phantom / inactive) cannot be reached by asking for it here.
Phase 1 | script.html | `subqRenderScopeBar_` renders the switcher **and the relationship line in EVERY scope, including `own`** — where it states the sub-queue is excluded. That sentence is the highest-value part of the change: before it, a parent manager had no way to learn the exclusion existed. A CHILD dept gets an upward pointer only, no switcher, matching the server's one-level rule.
Phase 1 | script.html | `subqRowGroups_` returns grouped tbody HTML or **null** when there is nothing to group, so a single-dept payload takes the unchanged flat path — that null is what keeps 11 of 14 depts byte-identical. Group order follows `meta.deptsShown` (parent first); sorting stays global and applies inside each group, so a manager's chosen sort still means what it did.
Phase 1 | script.html | The scope preference is per dept in `cdr.dept.subscope` and **omitted from the request when unset**, so the server owns the default. Hardcoding it client-side too would let the two drift. `subScope` joins the SWR signature via `reportSig_(req)`, so a scope switch can't be served the other scope's keep-last-good payload.
Phase 1 | Data.gs + docs | `summary:v15 → v16` because `subScope` joins the cache key — without it a manager toggling inside the 30-min TTL would be served the other scope's table. **The cache-version guard caught the bump** and forced the sweep across `OrphanFix.gs`, `invariants.md`, `conventions.md`, `known-issues.md`, `architecture.md`, `client-ui-conventions.md`.

TEST RESULTS: passed. `npm run ci` → **540/540** (was 535; +5), INV-16 + cache-version-sync + claude-md-split clean. `npm run ci:ui` → 24/24 + 16/16, including `admin/dept` and `manager/dept` clean renders with no blank canvases and no horizontal overflow (the new bar sits above the table, so overflow was the specific risk).
**The weighted-mean guard was verified by breaking it** — swapping the accumulator to a naive mean of means fails the test. The cache-key guard fired on its own during the change, which is the second time this cycle it has caught a real omission.
Regression Scenarios: NOT EXECUTED. **S1 / S2 / S6 / S35 overlap this change and need a live walk** — S35 (Phase D totals parity) is the important one, because it pins that dept totals exclude floaters, and the combined view adds a second totals concept beside it. Flagged below.

REGRESSION RISKS:
- **Combined-by-default changes what three departments see on open.** Sales, CSR and Power now land on a combined table. The owner chose this over my recommendation; their choice of per-dept subtotals substantially de-risks it, because the familiar own-dept figure stays on screen as that dept's subtotal rather than disappearing into a merged number. Still worth telling those three managers before deploy.
- **A combined view costs N DQE reads instead of 1** (2 for the real parents), paid on a cold cache per (dept, range, scope). Acceptable at this shape; would need revisiting if a dept ever had many children.
- **`rows` gained a `dept` field and the payload gained `deptGroups` / four `meta` fields.** Purely additive. The CSV exporter builds from `COLUMNS` + rows and is untouched, so **the CSV of a combined view is currently a flat list with no group headers or subtotals** — it carries the `dept` per row only implicitly (no Dept column). That is a real gap, listed as a follow-on rather than quietly shipped as if complete.
- `state.deptGroups` is null for single-dept payloads, and `subqRowGroups_` returns null on `order.length < 2` — so the flat path is taken whenever there is nothing to group, including a parent whose children have no agents in range.
- The team strip, QCD snapshot and missed section still read the PRIMARY dept only. Correct for QCD (see the double-count note) but it means the missed section does not yet follow the switcher — that is Phase 3, and the switcher's note does not currently say so.
- No auth path was widened in this phase; Phase 0 did that, and every dept in the set is still re-checked here.

INVARIANTS AT RISK: None violated; one extended, one clarified in Phase 0 and relied on here.
- **INV-30** — `summary:v16` with the new key dimension and payload shape documented in the entry.
- **INV-53** — the floater gate stays INSIDE each dept's own subtotal, untouched. The combined grand total sums per-dept totals that each already excluded their own floaters, so floaters are excluded exactly once. This is the invariant most at risk from a careless merge and it is why the merge sums `totals` rather than re-deriving from `rows`.
- INV-05 — per-agent ATT is still the stored simple mean; only the cross-dept ROLLUP is weighted, and by agent count, not by answered.
- INV-38 — relied on (the parent map now shapes data scope); rewritten in Phase 0.
- INV-01 — no new write path.

NET SCORE: 0 − 0 = 0
- Correct for a feature phase: no pre-existing bug is fixed. Under /reflect's three-way tally this is one capability plus its guards.
- Deliberately not counted: the invisible-sub-queue-exclusion was a design gap, not a defect.

OPERATOR ACTIONS / DEPLOY:
- **Tell the Sales, CSR and Power managers their My Department view now opens combined** before deploying. Their own dept's figure is still on screen as a subtotal, but the table gains rows and a grand total. | BLOCKS DEPLOY: N
- Phase 0's blocking action still stands: confirm the four seeded parent pairings should confer access at all. | BLOCKS DEPLOY: **Y**
- After deploying, walk **S35** (totals parity — verify a combined grand total equals the sum of the two subtotals, and that each subtotal equals that dept's own view), plus S1 / S2 / S6. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + a new deployment version (Data.gs, script.html, dashboard.html, styles.html).
- No other subsystem touched.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **CSV export does not reflect the combined view** — no Dept column, no group headers, no subtotals. Should gain a Dept column at minimum. Not in Phase 1's stated scope, so not silently added.
- The missed section and team strip still show the primary dept only; Phase 3 covers the missed section. The switcher's note should eventually say what it does and does not scope.
- Phases 2 and 3 remain: Insights + IR picker (`insights:v20`, `individual_active:v3`), then Missed (`missed:v18`) + Escalations.
- The S41/S42 numbering collision is still unresolved — the new sub-queue scenarios need those promoted or a start at S43.
- `meta.subQueueAgentHint` is referenced in one dead branch of `subqRenderScopeBar_` and never populated; harmless, but it should either be wired (an agent count in the `own`-scope note would be genuinely useful) or removed.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. INV-30 describes v16 and the merge contract; CLAUDE.md gained a "Sub-queue scope switcher" decision bullet ahead of the roster-scope bullet; `docs/client-ui-conventions.md` gained the render contract including why the client omits the default rather than duplicating it.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
