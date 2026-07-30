---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Sub-queue view work, **Phase 2 — sub-queue groups in the Individual Report + Insights agent pickers, and the one-dept-per-run rule that makes them correct**. Phase 3 (Missed / Escalations) is NOT in this change.

**Scope honesty, read this first.** Phase 2 as planned said "Insights + Individual Report agent picker … Insights `queueHealth` already separates sub-queues, so this is mostly making the agent-level side agree with it." What shipped is the PICKER side of both reports plus the correctness rule it requires. **Insights' report BODY does not gain the Phase 1 scope switcher** — see FOLLOW-ON. The reason is a real design finding rather than time: a combined agent-level Insights run would need per-dept team rollups, and Insights' team comparison is threaded through the KPI tiles, the share donut, the per-agent cards and the trend chart. Bolting a second dept into one run would have compared agents against the wrong team average, which is exactly the failure the owner's per-dept-subtotals decision exists to prevent. So the correct move was the one-dept-per-run rule, not a partial combine.

Files modified:
- apps-script/department-dashboard/Util.gs (`computeSubQueuePickerGroups_`)
- apps-script/department-dashboard/IndividualReport.gs (`subQueueGroups` on the init payload)
- apps-script/department-dashboard/script.html (picker group render, `subqPickerScope_`, both generate handlers)
- apps-script/department-dashboard/styles.html (the un-muted sub-queue group + note)
- tests/unit/subqueue-access.test.js (+6)
- CLAUDE.md, docs/client-ui-conventions.md

CHANGES:
Phase 2 | Util.gs | `computeSubQueuePickerGroups_(dept, from, to)` returns `[{dept, agents, floaters}]`, one per one-level sub-queue with activity in range. **Deliberately a separate helper rather than a new mode on `computeActiveAgentsInRange_`**: that function's `{agents, floaters}` shape is pinned by `individual_active:v2`, is consumed by both pickers, and contains the INV-53 floater gate — leaving it untouched means no cache bump and no risk to that gate. Each child is computed with THAT child's roster, so a sub-queue's active set inside the parent's picker is identical to what its own report shows. Best-effort per child: a roster or scan failure omits the group and logs, because a picker that fails to open is worse than one missing a group the manager may not need.
Phase 2 | IndividualReport.gs | `getIndividualReportInit` returns `subQueueGroups`. `getInsightsReportInit` delegates to this same function, so **Insights inherited the field with no change** — worth knowing, because it means the two pickers cannot drift.
Phase 2 | script.html | `irBuildAgentListHtml_` takes a 4th argument and renders one collapsed `<details data-subq-dept>` per child, after Active / No-activity / Floaters. The group is **not muted**: inactive and floater groups are de-emphasised because you rarely want them, but a sub-queue is a department and a first-class choice. All four call sites updated.
Phase 2 | script.html | **`subqPickerScope_` + the one-dept-per-run rule.** A selection confined to one sub-queue group runs the report against THAT department; a selection spanning departments is REFUSED with a reason. The team average/rollup is per-dept (INV-25/27), so a mixed run would compare agents against the wrong team — silently. Both `runInsReport` and the IR generate handler check this before building their request, and the group carries an inline note saying which team average will be used, so the behavior is visible before the click rather than surprising after it.

TEST RESULTS: passed. `npm run ci` → **546/546** (was 540; +6), INV-16 + cache-version-sync + claude-md-split clean. `npm run ci:ui` → 24/24 + 16/16.
**The best-effort guard was verified by breaking it** — removing the per-child try/catch makes the suite fail, so the "picker still opens when one child blows up" claim is tested rather than asserted.
No cache version changed, so no INV-30 sweep was needed. That is a consequence of the separate-helper decision above, not an oversight.
Regression Scenarios: NOT EXECUTED. **S11 / S13 (IR renders, IR picker grouping) and S37 (Insights end-to-end) overlap and need a live walk** — S13 specifically, since it pins the picker's group structure and this change adds a fourth group kind.

REGRESSION RISKS:
- **`irBuildAgentListHtml_` gained a 4th parameter.** All four call sites pass it; a caller that forgot would pass `undefined`, which the `Array.isArray` guard turns into "no groups" — the pre-Phase-2 render. Fails safe.
- **The early-return fast path changed**: it previously returned a flat list when there were no inactive members and no floaters, and now also requires no sub-queue groups. A dept with no children still takes it, so the common case is unchanged.
- **A mixed-department selection is now refused where it previously would have run.** It could only arise from the new groups, so nothing that worked before now fails — but a manager who selects broadly across groups will hit the message, which is why the group carries the explanatory note up front.
- **The IR/Insights request `department` can now differ from the header's selected dept.** Server-side `assertDeptAccess_` still authorizes it independently, and Phase 0 put the children in `user.departments`, so a sub-queue that is not genuinely accessible is rejected there rather than trusted from the client.
- One extra `computeActiveAgentsInRange_` call per child on a cold picker cache (one child for each of the three real parents). Each per-child call uses and warms its own `individual_active` entry, so a repeat open is free.
- Departments with no sub-queues — 11 of 14 — get an empty array and no visible change anywhere.

INVARIANTS AT RISK: None violated.
- **INV-53** — untouched, and the reason the new helper is separate: the floater gate lives inside `computeActiveAgentsInRange_`, which was not modified. A sub-queue agent is a roster member of their own dept, never a floater, and the two now render as distinct picker groups instead of being conflated.
- **INV-25 / INV-27** — these are what the one-dept-per-run rule protects. Weighted ATT and the active-roster team-avg denominator are both per-dept; the rule guarantees a run never spans two.
- INV-30 — no cache key or version touched.
- INV-38 — relied on (the parent map shapes data scope), rewritten in Phase 0.
- INV-01 — no new write path; the init endpoint stays read-only.

NET SCORE: 0 − 0 = 0
- Correct for a feature phase; no pre-existing bug fixed. Under /reflect's three-way tally: one capability plus one correctness rule and their guards.

OPERATOR ACTIONS / DEPLOY:
- Phase 0's action still stands and still blocks: confirm the four seeded parent pairings should confer access at all. | BLOCKS DEPLOY: **Y**
- After deploying, walk **S13** (picker grouping — confirm the sub-queue group appears for Sales/CSR/Power, is NOT muted, and that a cross-dept selection is refused with the message) and **S11 / S37**. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + a new deployment version (Util.gs, IndividualReport.gs, script.html, styles.html).
- No other subsystem touched.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **Insights' report body does not gain the Phase 1 combined view** (the switcher + grouped agent cards + per-dept rollups). This is the deliberate gap named at the top. Doing it properly means per-dept team rollups threaded through the KPI tiles, share donut, per-agent cards and trend chart, plus `insights:v19→v20` — comparable in size to Phase 1 on its own, and worth its own phase rather than being half-done here. A parent manager can today see a sub-queue's Insights by selecting its group, which covers the "separately" half of the original request on this surface.
- Phase 3 remains: Missed Calls (`missed:v18`) + Escalations.
- Carried from Phase 1, still open: the combined-view **CSV has no Dept column, group headers or subtotals**; `meta.subQueueAgentHint` is referenced in a dead branch and never populated; the S41/S42 scenario-numbering collision; `Field Ops Power` is not in the parent map so a Field Ops manager will not see it.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. CLAUDE.md's sub-queue bullet gained the Phase 2 picker rule including the one-dept-per-run constraint and a pointer to this block for the Insights gap; `docs/client-ui-conventions.md` gained the picker contract and why the group is deliberately not muted.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
