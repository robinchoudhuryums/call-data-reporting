---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: **Owner round — retire the My Department sub-queue scope switcher in favour of a combined-always table with collapsible per-dept groups**, keeping a "View <sub-queue>'s missed calls" button in the sub-queue's group header. Plus (same round, prior commit) scaling the aggregate rows so they read as a different kind of number.

Files modified:
- apps-script/department-dashboard/script.html (scope bar → relationship line; collapsible groups; missed-dept override; delegated handlers; `subScope` no longer sent)
- apps-script/department-dashboard/styles.html (group-header affordance, missed button, aggregate-row scaling)
- tools/ui-harness/drive-subqueue.js (tab assertions REPLACED, not supplemented)
- CLAUDE.md, docs/client-ui-conventions.md, docs/regression-scenarios.md (S43)

CHANGES:
UI | script.html | The three-way segmented control is gone. Every view it offered is reachable by collapsing a group — "<dept> only" *is* the combined view with the sub-queue collapsed — and each dept's subtotal stays on screen either way. The tabs cost a **server round trip per view** to show the same thing and put the reader in a mode they had to track. What replaces them is a one-line relationship note plus the disclosure itself.
UI | script.html | The group HEADING ROW is the control (`role=button`, `tabindex`, caret, `aria-expanded`). Collapsing hides the agent rows and **deliberately keeps the subtotal** — that is the whole point, and it is precisely what made the tabs redundant. Default is EXPANDED so the combined view is unchanged on open; state persists per parent in `cdr.dept.subqcollapse`.
UI | script.html | **The client no longer sends `subScope`.** The server still honors it (it drives the CSV's Department column and the combined default), so this is a client retirement rather than a capability removal — the comment says so, because the obvious "fix" later is to restore a parameter that was never broken. Omitted rather than hardcoded to `'all'` so the default keeps living in one place.
Missed | script.html | Phase 3 cannot merge the missed section across depts (`queuesForDept_` already rolls a parent's sub-queue queues into its abandoned section, so summing would double-count every queue abandon and hour-of-day bucket). The scope tabs were the only route to a child's missed timelines; now the sub-queue's group header carries an explicit button. It re-scopes the section, scrolls to it, and the scope note offers "Back to <parent>" — the section sits far enough down the page that the header it was launched from is off screen.
Missed | script.html | The override **resets on every dept or window change**. A child's missed calls left pinned across a department switch would be *wrong*, not merely stale.
Events | script.html | The missed button is checked BEFORE the group-collapse handler and stops propagation, so it never also toggles the group it sits inside — the same trap the agent-scope button hits with `<details>` two handlers below.
Rows | styles.html | Grand total and per-dept subtotal rows scale up (text + split-bar height) so they read as a different KIND of number. Scoped to `.agents` so the Overview mini-table and the Insights reuse of `.ans-bar` are untouched, and the compact-density toggle still wins.

TEST RESULTS: passed. `npm run ci` → **590/590**. `npm run ci:ui` → **24/24 + 16/16 + 24/24**. INV-16 + cache-version-sync + claude-md-split clean. No server file changed, so no cache bump was needed.
**The driver's tab assertions were REPLACED, not supplemented** — a driver that still passed with the tabs present would not be testing what shipped. New coverage: tabs are gone, both groups render, groups start expanded, the header looks clickable (computed `cursor`), only the sub-queue carries the missed button, collapsing hides rows while keeping BOTH subtotals, and re-expanding restores every row.
Two assertions were **re-targeted rather than deleted**: the S35 parity check now compares the rendered subtotal against the SERVER's `summary-30d-own` payload (the property itself, not a UI proxy, and it no longer depends on a round trip the product doesn't make); the multi-slot SWR check now flips two DATE RANGES, the remaining A/B a manager actually performs.
Regression Scenarios: NOT EXECUTED. **S4, S6, S35 and S43 all overlap and need a live walk.** S43 was rewritten — see the coverage loss below.

REGRESSION RISKS:
- **One assertion was genuinely LOST and is named rather than quietly dropped:** "single-dept CSV has NO Department column" required the retired `own` tab to produce a one-dept payload, and the fixture has no dept without sub-queues. The branch it guarded (`meta.deptsShown.length > 1`) is unchanged, but it is now covered only by S43's manual walk, which I rewrote to make that step explicit. Restoring it needs a fixture for a sub-queue-less dept.
- **A saved `cdr.dept.subscope` of `own` or `subs` is now ignored**, so a manager who had pinned a non-combined view will see combined on next load. Intended, and the collapse replaces it — but it is a visible change for exactly the people who used the feature most.
- **The whole header row is clickable**, so a click anywhere in it toggles. The missed button inside it is guarded by ordering + `stopPropagation`; anything added to that row later needs the same treatment.
- Collapse state is per PARENT dept, keyed by group name. A dept renamed in the roster orphans its entry — harmless (it just reads as expanded).
- Server untouched: no auth, cache, or payload behavior moved. `subScope` still works if anything sends it.

INVARIANTS AT RISK: None violated.
- **INV-53 / S35** — the parity property is unchanged and is now asserted against the server payload directly. Collapsing is display-only: totals, subtotals and the CSV are computed from `state`, not from what is visible, and the driver pins that the CSV is unaffected.
- **INV-30** — no cache key or version touched; no server file changed.
- **INV-37** — no page/route change.
- The `csvSafeCell_` formula-injection rule is untouched (no CSV cell writer changed).

NET SCORE: 1 − 0 = 1
- Fixes a real, owner-reported production problem: switching views took a server round trip each time. It is now instant and local.
- No new failure mode. The one behavior change (a saved scope pref is ignored) is the intended retirement, and the lost assertion is coverage, not behavior.

OPERATOR ACTIONS / DEPLOY:
- **Tell the Sales / CSR / Power managers the tabs are gone** and that collapsing a group heading does the same thing — they are the only people who will notice. | BLOCKS DEPLOY: N
- Walk **S43** including its new single-dept step, plus **S4 / S6 / S35**. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + a new deployment version (script.html, styles.html).
- No other subsystem touched.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **A harness fixture for a dept with NO sub-queues** would restore the single-dept CSV assertion and sharpen several others that currently only ever see the parent case.
- `meta.subQueueAgentHint` is still a dead reference — it was read by the retired `own`-scope branch, so it is now unambiguously removable.
- Phase 3 (Missed) and Phase 4 (IR / Insights) remain all-queue; an IR run for a sub-queue still disagrees with My Department for a crossover agent.
- The Insights combined view is still unstarted.
- The missed section's one-dept-at-a-time rule is unchanged — the button navigates it, it does not merge it.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. CLAUDE.md's sub-queue decision now leads with the combined-always view and states that `subScope` survives server-side; `docs/client-ui-conventions.md` gained the switcher-retirement entry and the orphaned-key note; S43 was rewritten to carry the single-dept step that lost its automated cover.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
