---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (P9 is new capability from the owner's follow-up plan of 2026-11-13)
New capabilities (G/ST): P9 -- partial-day suggestions: the Partial days editor lists likely partial days from each agent's first-to-last call times over the last 90 days, for the admin to confirm or dismiss.
Files modified:
  apps-script/department-dashboard/Config.gs, PartialDays.gs, dashboard.html, script-7-admin.html, styles.html
  tests/unit/partial-day-suggestions.test.js (new)
  tools/ui-harness/gen-payloads.js, build-harness.js, drive-admin.js, README.md
  CLAUDE.md, docs/operator-state.md, docs/invariants.md, docs/regression-scenarios.md, docs/client-ui-conventions.md, docs/per-call-capture.md, docs/fix-history.md, docs/module-dependencies.md, tests/README.md

CHANGES:
P9 | Config.gs | The look-back (90 days), the floors for judging an agent (5 workdays of calls, a usual span of 4 hours), the list cap (200) and the reason text a dismissal is stored with.
P9 | PartialDays.gs | `getPartialDaySuggestions({department})` -- admin-only, read-only. Reads each roster agent's first and last call time per day from the per-call tables in Neon (inbound journey legs, outbound calls, direct calls; aggregated in the database, one row per agent-day, agent names bound as a parameter), then `partialDaySuggestionsFrom_` (pure) lists the workdays whose span is well short of that agent's own median day, with the share the span implies. Weekends, company holidays, exception days and any day that already has a row are left out; an agent with too little history or a usual day under 4 hours is not judged and is named.
P9 | PartialDays.gs | `dismissPartialDaySuggestion({date, agent})` -- admin-only, validated, under the script lock: appends a row with Credit 1 and the reason "Reviewed: whole day". A credit of 1 is not a mark, so no figure and no cache key moves; it only stops the suggestion coming back. `removePartialDay` un-dismisses it; `getPartialDaysInit` returns the reviewed rows apart from the marks.
P9 | dashboard.html, script-7-admin.html, styles.html | A Suggestions block in the editor: "Find likely partial days" for the form's department; each row shows the times (Central), the hours, the agent's usual hours, the calls against usual and the suggested share. Use fills the form (the admin still picks the reason and presses Save); Whole day dismisses. A "Reviewed as whole days" list with Remove.
(test) | drive-deptoutbound.js | The P4 fold-survives-reload check no longer depends on the browser carrying a just-written key across a reload (see TEST RESULTS).
P9 | docs | Operator State #94 (the suggestions paragraph and what to know), INV-01 (the dismissal joins the Partial Days carve-out), S73's three P9 steps, client conventions, per-call-capture (a new reader of those tables), fix-history, coverage map, harness README.

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 3,138 pass / 0 fail (19 new in partial-day-suggestions.test.js); `npm run lint:gas` clean; the module-map check clean after a regenerate; `npm run ci:ui` all 18 driver runs passed on the second run, with seven new rendered checks in drive-admin over the REAL suggestion payload. The first run failed ONE check that is not P9's -- the P4 fold-survives-reload check in drive-deptoutbound, for the second batch running. This time it was reproduced and diagnosed (2 of 5 runs with five drivers at once): headless Chromium drops a key written just before a reload while every other key survives; no product code removes it, and P8's settle time had not helped. The check now seeds the stored choice for the reload and tests what the product owns (the fold writes the choice; a stored choice is applied on load); 6 of 6 under heavier load, and it still fails when apply-on-load is removed. Bite-checks: 12 of 12 bite after one fix -- with an all-company exception day the workday rule already excludes it, so dropping the suggestion read's department check passed every test; the test now uses a department-scoped exception day.
REGRESSION RISKS:
- The span read has not been run against the production database. It expands every inbound journey for the look-back in SQL; if it is slow it stops at its 90-second statement limit and the editor says the tables could not be read -- nothing else is affected, but each press costs database time and a few hundred KB of read volume.
- The suggestion is a heuristic on first-to-last call time: an agent who took one early and one late call looks like a full day, and a long off-phone stretch mid-day is not seen. It never marks anything by itself.
- `getPartialDaysInit` gained two fields (`reviewed`, `suggestDays`); nothing that existed changed.
- A Credit-1 row in the sheet is new. The dashboard's reader already refused it as a mark (pinned in P7), and the plan for the CSR team app says to skip any row outside 0 <= credit < 1.
INVARIANTS AT RISK: None broken. INV-01: the dismissal is a second write inside the existing admin-gated Partial Days carve-out (gate, validation, lock, stamp, usage row; documented), and the suggestion read writes nothing (pinned). INV-04: names are matched exactly against the roster. Privacy: the suggestions carry agent names, times and counts to an admin only; no caller number is read. Neon rules: no timeout on the JDBC URL, statements bounded with setQueryTimeout, both reads metered (the OD-3 sweep passes).
NET SCORE: 0 production fixes − 1 new failure mode (an unmeasured database read that can time out) = −1

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (push + new version). | BLOCKS DEPLOY: N
- After the deploy, press "Find likely partial days" once for the largest department and note how long it takes; if it fails or takes more than about a minute, say so before relying on it. | BLOCKS DEPLOY: N
- Walk S73's three P9 steps; then `runLiveSmoke`. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor -> Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- If the read proves slow in production: narrow it to the department's own calls (by entry queue) before expanding journeys, or shorten the look-back.
- No sheet fallback: with Neon unreachable there are no suggestions (the Inbound / Outbound Calls export tabs could feed one).
- A suggestion cannot be marked in one click; Use always goes through the form so the admin chooses the reason. A "mark all shown" action would need the owner to say that is wanted.
- After every suggestion is handled the status still reads "Nothing stands out"; "Nothing left to look at" would be truer.
- Carried from P8: the same agent's vs-prior figures are not credited; the % Ans marker on Insights cards uses a different team basis from the count bars.
- team-tools' matching change (Operator State #94) is still planned, not built.

DOCUMENTATION UPDATES NEEDED:
- None -- written in this session.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
