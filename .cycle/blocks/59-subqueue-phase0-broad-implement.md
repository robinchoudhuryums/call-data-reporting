---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Sub-queue view work, **Phase 0 — access widening**. A manager assigned to a PARENT department can now reach its one-level sub-queues. Phases 1–3 (the My Department switcher, Insights/IR, Missed/Escalations) are NOT in this change.

This is the first time the Overview parent map affects AUTHORIZATION rather than tile layout, so it was scoped as its own phase and committed alone to be reviewable in isolation.

Files modified:
- apps-script/department-dashboard/DeptConfig.gs (`subQueueChildMap_`, `expandDeptsWithSubQueues_`)
- apps-script/department-dashboard/Auth.gs (`resolveUser_` returns the EFFECTIVE dept list)
- tests/unit/subqueue-access.test.js (NEW, +15)
- CLAUDE.md, docs/invariants.md (INV-38 rewritten, INV-53 clarified), docs/operator-state.md (#39 NEW)

CHANGES:
Phase 0 | DeptConfig.gs | `subQueueChildMap_()` inverts `getOverviewParentMap_()` (child→parent) into parent→children, dropping every edge that must not confer access: self-parent, an edge whose child OR parent is not a real department, and any edge participating in a cycle. **This read-side validation is deliberately NOT redundant with `saveDeptConfig`'s** (which already rejected self-parent / unknown parent / cycles via the pre-existing `dcWouldCreateParentCycle_`): the `Dept Config` sheet is hand-editable outside the modal, the Neon table can be written by the backfill, and `OVERVIEW_PARENT_OF` is a code constant — none of those pass through the modal's checks, so a malformed edge has to fail closed at read time.
Phase 0 | DeptConfig.gs | `expandDeptsWithSubQueues_(depts)` expands assigned depts with their children, **ONE LEVEL only** — a transitive walk would let a single mis-configured cell cascade into broad access. Assigned depts keep their order and come first. Wrapped in try/catch returning the assigned list unchanged, because auth must never widen *or break* because a config read failed.
Phase 0 | Auth.gs | `resolveUser_`'s manager branch now returns `departments` = assigned ∪ one-level children, plus a new `assignedDepartments` carrying the raw Access Control assignment. `department` (the landing dept) is still the assigned one, so the manager opens where they always did. **Widening in this one place is the design point**: `assertDeptAccess_`, `escAssertRowAccess_`, `getEscalations` scoping, `personalizeOverview_`, and the client's `canPickDept_` / dept selector all already read `departments`, so they inherit the change instead of my patching six gates and missing one. Admins and `allDepts` managers are untouched — they already resolve to `getAllDepartments_()`.

TEST RESULTS: passed. `npm run ci` → **535/535** (was 520; +15), INV-16 + cache-version-sync + claude-md-split clean. `npm run ci:ui` → 24/24 + 16/16 (no client file changed; run to confirm the auth-shape change doesn't break the harness's user envelope).
**Both guards were verified to actually catch their regression** — reverting `departments: effective` back to `departments: depts` fails 5 tests; disabling the cycle filter fails the cycle test. Two fixture bugs of my own surfaced and were fixed rather than worked around: the real `OVERVIEW_PARENT_OF` constant seeds live edges that bled into tests using PAP/Spanish/PAK as fixture names (renamed to neutral depts, with a dedicated test for the seeded constant), and a `getOverviewParentMap_` stub leaked across tests (install() now restores it).
Regression Scenarios: NOT EXECUTED — S1/S2/S3/S8 (auth + dept switching) overlap `Auth.gs` and SHOULD be walked live, but they need a deployed web app. Flagged as a blocking operator action below.

REGRESSION RISKS:
- **This is a real privilege widening and it takes effect on deploy with NO admin edit.** The shipped `OVERVIEW_PARENT_OF` constant already contains `PAP→Sales`, `PAP Q→Sales`, `Spanish→CSR`, `PAK→Power`, so the moment this deploys every Sales manager can see PAP, every CSR manager Spanish, every Power manager PAK — agent-level data included. Pinned by a test so it can't be a surprise later; called out as Operator State #39 with the pre-deploy check.
- **Escalations scope widens as a side effect.** `getEscalations` scopes a multi-dept manager by `departments`, so a parent manager now sees their sub-queue's escalations. That is the intended Phase 3 end state arriving early; it is consistent, not a bug, but it lands before the Phase 3 UI acknowledges it.
- **`canPickDept_()` now returns true for a parent manager** (departments.length > 1), so the header dept selector appears for someone who never had one, and the role tag reads "manager · 2 depts". Intended and the main visible effect of Phase 0 on its own — a parent manager can switch to their sub-queue today, before any of the Phase 1–3 UI exists.
- **One config cell now controls two different things.** Clearing `Overview Parent` to revoke access also un-nests the tile on the Overview grid. That coupling is inherent to reusing the existing map rather than adding a second one; noted in INV-38 and Operator State #39 as the trade-off.
- `resolveUser_`'s return shape GAINED a field (`assignedDepartments`); nothing reads it yet. Purely additive — no caller depends on the object's key set.
- A dept with no children expands to itself, so 11 of the 14 departments here are byte-for-byte unaffected. The `access:` auth cache is keyed on email and stores only the Access Control assignment, not the expansion, so no cache-version bump is needed and no stale expansion can be served.

INVARIANTS AT RISK: One CHANGED deliberately, one clarified.
- **INV-38 rewritten** — the parent map is no longer Overview-only. It now shapes data scope and authorization, so a typo in an Overview Parent cell moves numbers and access rather than just tiles. The entry documents the four guards (one-level, fail-closed, read-side re-validation, unaffected roles).
- **INV-53 clarified** — a sub-queue agent is NOT a floater. Sub-queues are full departments with their own roster columns; the floater exclusion governs shared-queue-extension overlap only and stays exactly as-is inside each department's own totals.
- INV-01 / INV-55 — no new write path; Escalations' row gate is unchanged in code and inherits the widened list.
- INV-30 — no cache key or version touched; sync guard clean.
- INV-11 / INV-12 — roster layout and setup() untouched.

NET SCORE: 0 − 0 = 0
- Correct score for an enabling change: no bug is fixed here. Under /reflect's three-way tally this is one structural item plus its guards.
- Deliberately NOT counted as a "fix": the pre-existing inability of a parent manager to see their sub-queue was a design gap, not a defect.

OPERATOR ACTIONS / DEPLOY:
- **Before deploying, confirm the four seeded pairings should confer access**: `PAP→Sales`, `PAP Q→Sales`, `Spanish→CSR`, `PAK→Power`. Any pairing that should NOT grant access needs its `Overview Parent` cell cleared in Dept Config FIRST — which also un-nests it on the Overview grid, since they are now the same setting. | BLOCKS DEPLOY: **Y**
- Confirm `Field Ops Power`: it looks like a sibling of `Field Ops` but is not in the parent map, so a Field Ops manager will NOT see it. Adding the mapping is a Dept Config edit; leaving it is correct if the two are genuinely independent. | BLOCKS DEPLOY: N
- After deploying, walk S1 / S2 / S3 / S8 (auth + dept switching) — they overlap `Auth.gs` and cannot be exercised by the unit harness. Specifically: a parent manager sees a dept selector containing their sub-queue, lands on their assigned dept, and still cannot reach an unrelated dept. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + a new deployment version (Auth.gs, DeptConfig.gs).
- No other subsystem touched.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **Phases 1–3 are the actual feature**; Phase 0 only unlocks the data. Phase 1 (My Department switcher + per-dept subtotals + the always-on relationship line, `summary:v15→v16`) is next.
- The two never-promoted perceptual checks from increment 54 are informally called S41/S42, so the new sub-queue scenarios need either those promoted first or a start at S43. Unresolved — flagged in the plan, not decided.
- `user.assignedDepartments` is populated but unread. Phase 1 will use it for the "your assigned dept vs. what you're seeing" distinction in the relationship line.
- Alerts and Digests are deliberately NOT expanded (per-dept subscriptions an admin configured on purpose). If that turns out to be wrong, it is a separate decision, not an oversight.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. INV-38 rewritten, INV-53 clarified, the CLAUDE.md "Overview-only sub-queue nesting" decision bullet retitled and rewritten (it asserted the opposite of what is now true), and Operator State #39 added with the pre-deploy check.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
