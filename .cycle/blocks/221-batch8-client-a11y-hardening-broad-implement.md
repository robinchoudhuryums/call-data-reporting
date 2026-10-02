---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (broad-scan 2026-10-01, Batch 8 -- "Client accessibility and hardening", dashboard client only):
- CL-3  after any escalation mutation the list re-render puts keyboard focus back on the acted-on control (else its card, else the card now in its place) instead of dropping it to <body>; the create/edit form path lands on the edited card or the New button
- CL-21 escalation remove-dept / restore-dept allow one change per row in flight (mutationBusy_), released on success and failure
- CL-13 the agent app's tabs follow the WAI-ARIA tabs pattern (roving tabindex, Left/Right/Home/End, role=tabpanel panels with aria-labelledby), and a second tab switch no longer fires a second getAgentHistory
- CL-12 escapeHtml renders null / undefined as '' (not the text "null"), and alStatusBadge_ escapes an unknown Alert Log status
- CL-19 the #/dev dev-overlay entry reads the PARENT URL hash through google.script.url.getLocation (the sandbox iframe's own window.location never carries it)
- CL-10 removed the dead client helpers clampToLatestData_, daysAgo_, insWorstMover_, ovBuildHeroTile_, ovBuildWowDriver_, insSetExportMenuOpen_ -- plus isoDate_, whose only caller was daysAgo_ (insMetricPerDay_ was on the scan's list but Batch 7 wired it in)
- CL-8  .qcd-hero-sub's font declaration is valid (var(--ui); the --body token never existed and an `inherit` fallback inside the shorthand dropped the whole declaration)
- CL-11 lang="en" on dashboard.html, agent.html and access_denied.html

Files modified:
apps-script/department-dashboard/script-1-core.html, script-2-chrome.html, script-3-overview.html, script-7-admin.html, script-8-insights.html, script-10-escalations.html, script-11-qcd-boot.html, agentApp.html, agent.html, dashboard.html, access_denied.html, styles.html, tools/ui-harness/drive-admin.js, tools/ui-harness/drive-agent.js, tests/unit/client-correctness.test.js, tests/README.md, docs/client-ui-conventions.md (two accessibility rules + the R18 clamp reference), docs/invariants.md (INV-43 / INV-48 references to the removed helpers)

CHANGES:
CL-3 | script-10-escalations.html (ESC_FOCUS_ACTIONS_, escFocusIntent_, escNoteFocusIntent_ in escOnListClick_, escRestoreFocus_ after escRenderList_ in escLoad_, the create/edit success handler sets an intent with editingId / fallbackId 'esc-new-btn') | never steals focus from a live, visible element; intents expire after 2 min
CL-21 | script-10-escalations.html (escRemoveDept_ / escRestoreDept_ busyKey 'escDept:<id>') |
CL-13 | agent.html (tabpanel roles, tab tabindex), agentApp.html (roving tabindex in setTab_, tablist keydown, histInFlight_) |
CL-12 | script-1-core.html (escapeHtml), script-7-admin.html (alStatusBadge_) | the agent app's own esc() was already null-safe
CL-19 | script-11-qcd-boot.html (devInstallToggle_ openIfDevHash_ via getLocation; window.location fallback) |
CL-10 | script-2-chrome.html, script-3-overview.html, script-8-insights.html | a pointer comment left where R18's clamp lived; docs updated where they named the removed helpers
CL-8 | styles.html |
CL-11 | dashboard.html, agent.html, access_denied.html |

TEST RESULTS: passed -- `npm run ci` 2090/2090 (7 new unit pins in client-correctness), INV-16 guard clean, module-deps up to date; bare `TZ=UTC node --test` 2090/2090; `CI=true npm run lint:gas` clean (75 files); `npm run ci:ui` all eight stages (smoke 113/113, keyboard 18/18, sub-queue 38/38, journey 14/14, admin 124/124 incl. the new CL-3 focus check, dev overlay 14/14, agent 23/23 incl. the three new CL-13 checks). Mutation-checked: every touched file reverted to HEAD in turn fails its own unit pin; the CL-3 driver check fails with the restore call removed (focus on BODY); the CL-13 driver checks fail against the pre-batch agent app. Two failures mid-run were this session's own, both test-side (a doctype regex; my own CSS comment quoting the token the pin forbids). No test double encoded the old behaviour. Regression Scenarios S39/S45/S50-S53 not walked live (no deployed app); the rendered gate drives the escalation delete path and the agent tabs.
REGRESSION RISKS:
- CL-3: focus() on a card scrolls it into view, so after an action the worklist can scroll back to the acted-on card -- intended for keyboard users, and only when focus had fallen to <body> (a mouse user who clicked a button had focus on it too, so they get the same scroll).
- CL-12: a field that is genuinely null now renders empty where it used to print "null" -- that text was never meaningful, but a surface relying on it to SHOW a gap now shows nothing.
- CL-13: the inactive tab leaves the Tab order (roving tabindex) -- keyboard users reach it with the arrow keys, which is the pattern.
- CL-19: the overlay opens a beat later on a #/dev load (an async getLocation round trip).
- CL-10: none -- every removed function had zero callers in client, tests and harness (grep-verified).
INVARIANTS AT RISK: INV-43 / INV-48 (doc references only -- behaviour unchanged; entries updated); INV-55 (escalation write paths unchanged server-side; CL-21 only adds a client in-flight guard). None violated.
NET SCORE: 2 − 0 = 2 (production fixes this month: CL-8 -- the declaration has been dropped on every render; CL-19 -- #/dev has never opened the overlay in production. CL-3/CL-13/CL-21/CL-12/CL-11 are real but need a keyboard / screen-reader user, a double submit or a null field to fire; CL-10 is cleanup. No new failure mode beyond the scroll-on-focus noted above.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (every change is client-side in the dashboard project) | BLOCKS DEPLOY: Y
- After deploy, try `<dashboard URL>#/dev` once as an admin -- the dev overlay should open (CL-19 could not be exercised outside Apps Script) | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- CL-3's pattern (record intent, restore after render) applies to other rebuild-after-mutation surfaces (the Coaching worklist, the Access Control / Dept Config tables) -- not in this batch's scope.
- CL-9 (a narrow-viewport assertion in drive-smoke / drive-agent) is queued for Batch 11.
DOCUMENTATION UPDATES NEEDED:
- None beyond this commit. /sync-docs optional.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
