---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F20 The brief's Callbacks row could quote another dept's / window's callback rate (INS_CB_ held the last loaded window; insCbSync_ returns early on the Inbound view before resetting the key)
- F21 Entering / leaving View-as did not redraw the Insights trend, so the admin-only point shading stayed on in a manager preview of the dept already on screen
- F22 insHeadline_'s "N behind" counted against the all-agent dept rate while the chips and card rails beside it use the R18 benchmark (TEAM_AVG_EXCLUDES out)
- F23 A red / amber top-line pill could be followed by "Nothing needs a look." -- the count ignored the top line's own tier
- F24 A brief jump to Callbacks from the "Both" view clicked the Outbound switch, whose handler SAVES the choice -- silently replacing the admin's saved direction
- F28 The brief ranked a Queue health row that pointed at a hidden section (no payload, or no totals and neither error nor unmapped)
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/script-4-nav.html
- apps-script/department-dashboard/script-3-overview.html
- tests/unit/insights-brief.test.js
- .cycle/STATE.md, .cycle/blocks/259-broad-scan-b5-ux2-brief-broad-implement.md

CHANGES:
F20 | script-8-insights.html | new PURE insBriefCallbackFor_(store, curKey): quotes INS_CB_.data.callback only when INS_CB_.key equals the on-screen window key (built exactly as insCbSync_ builds it, from insCbWindow_); insCbRender_ repaints the brief (best-effort) so a fresh load replaces the placeholder
F21 | script-3-overview.html | applyViewAs_ redraws insDrawTrendChart_(insLastData) (best-effort) -- the shading is decided at draw time and a same-dept preview re-renders nothing else
F22 | script-4-nav.html | insHeadline_'s teamPctH = insTeamBenchmarkPct_(data) (the R18 basis the chips use) instead of the raw team pct
F23 | script-8-insights.html | new PURE insBriefLookCount_(ranked, topTier): the section rows' red/amber count + 1 when the top line is red/amber (grey when there are no calls)
F24 | script-8-insights.html | insBriefGo_ clicks the Outbound switch (and waits 150 ms) only when obEffectiveDir_() is 'in'; from Both / Outbound it scrolls straight to the section
F28 | script-8-insights.html | new PURE insBriefQueueVisible_(qh) mirroring insRenderQueueHealth_'s hide test; the queue row is unshifted only when the fold is visible (keeping it first in tie order)

TEST RESULTS: passed -- 2460 tests (2459 pass, 0 fail, 1 pre-existing skip; +6 in insights-brief.test.js). lint:gas clean (75 files), module-deps up to date, INV-16 guard in sync. ci:ui: all stages passed. Bites: 8/8 (F20 x2, F21, F22, F23, F24, F28 x2).
REGRESSION RISKS:
- insCbRender_ now repaints the brief each time it renders (cached reopen included) -- cheap, wrapped in try, and insRenderBrief_ does not call back into the callbacks code (no recursion).
- applyViewAs_ redraws the trend on every preview enter/exit while Insights data is held -- a redraw of a closed fold is a no-op until opened (the C3 draw-on-open rule still applies).
- F22 changes the headline's "behind" count for depts with TEAM_AVG_EXCLUDES entries (CSR by seed) -- intended; it now agrees with the chips.
INVARIANTS AT RISK: None (INV-26 is now honoured by the headline count, where it was not before; INV-37/INV-39 untouched -- View-as still only hides).
NET SCORE: 6 − 0 = 6

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Department Dashboard -- `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The brief is still an admin-only trial (UX-2); S61 should be re-walked after deploy, incl. the Both-view Callbacks jump and a dept change on the Inbound view.
- Batches 6-10 of the cycle-259 plan remain.

DOCUMENTATION UPDATES NEEDED:
- None (docs/regression-scenarios.md S61 already covers the brief; no rule text changed)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
