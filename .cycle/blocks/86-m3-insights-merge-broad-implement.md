---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: M3 — Insights→My Department merge phase 3 (scope polish), per docs/insights-merge-plan.md
Files modified: apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script-8-insights.html, apps-script/department-dashboard/styles.html, docs/insights-merge-plan.md, docs/client-ui-conventions.md

CHANGES:
M3-dept | script-8, dashboard.html, styles.html | #ins-dept-pill on the results title line states the report's dept (meta.department; warn-tinted --scoped when a sub-queue selection narrowed it below the header dept) — a LABEL, not a second selector; the header dept selector stays the one authority. The dept also LEADS the collapsed region headline (a parent's table above is the combined view). Dept-SWITCH convergence closes the M2 gap: insSyncToDeptWindow_ tracks insLastHeaderDept_ (the header dept at run time, deliberately NOT meta.department, which a sub-queue run legitimately narrows) and on a switch rewrites the window + arms the agent-free first-open-style run behind the loading pane + re-ensures the roster (old dept's checked agents die with the old picker).
M3-scroll | script-8 | Both same-page hand-offs became in-page scrolls: Queue health's "See missed calls" → qsSpotlight_('dept-missed-section'); the lens "Agent table" side → scrollIntoView on .agents-table-wrap. Each keeps handoffToMyDept_ as the fallback when the target isn't rendered. (The old path cost a setPage + refresh() round trip re-fetching an already-rendered summary.)
M3-gap | script-8 | insCardsChartMode default 'abs' → 'gap' (the same-page agent table carries the Absolute info; Gap-vs-team is the one view it can't show). Saved 'abs' prefs SELF-HEAL to gap (restore narrowed to 'gap' — blobs carry 'abs' from mere usage under the old default, not intent; the non-admin 'att' self-heal precedent). Stale comments at the mode declaration + insRenderCardsChart_ updated.
M3-ab | script-8, styles.html | IntersectionObserver on the region toggles .ins-ab-offscreen on #ins-ab-panel (display:none !important beats the admin reveal loop's inline display:'') — the fixed A/B remote shows only while the region is on screen. Decoration; silently skipped without IntersectionObserver.

TEST RESULTS: passed — 651/651 node --test, INV-16 guard, npm run ci:ui 28+16+30+14. Live-DOM probes: pill "CSR" shown unscoped + gap basis active + metric selector visible + headline "CSR · 90.5% answered · …"; missed-link click spotlights the missed section in place (data-page stays dept, region stays open); "Agent table" click scrolls up with the table intact; a header dept switch to Sales shows the "Insights for Sales" loading pane SYNCHRONOUSLY (results hidden) then re-renders — the convergence path proven; the A/B panel carries .ins-ab-offscreen (hidden) at page top and shows again scrolled into the region. Zero page errors. (Fixture artifact: the mocked RPC returns the CSR payload for any request, so post-switch pill text can't be asserted — the mechanics were.)

REGRESSION RISKS:
- A user who deliberately preferred the Absolute basis loses it across sessions (self-heals to gap); it stays one click away and the in-session choice holds. Documented deliberate.
- The dept-switch convergence re-runs an open region on every header dept change — one report RPC per switch (server 30-min cache applies). A switch mid-generate: the armed-run skip means the sync stands down until the pending run lands; the NEXT refresh/open converges. Bounded, no loop.
- The "Agent table" scroll no longer carries a share-link window into the dept table (one-authority model; the old carry rewrote dept dates + refetched). Intended.
- The A/B hide rides scroll position: opening the region then scrolling far above keeps the panel hidden until the region re-enters the viewport — that is the point, but an admin mid-A/B who scrolls up loses the remote until they scroll back.

INVARIANTS AT RISK: None — no server changes, no cache-key changes (requests unchanged in shape), INV-25/27's one-dept-per-run rule untouched (subqPickerScope_ still refuses cross-dept selections; the pill only STATES the narrowing).

NET SCORE: 1 − 0 = 1 (the dept-switch gap was a real wrong-data exposure — an open region silently kept the previous dept's report under a new dept header; the rest is planned polish)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh . <dashboard-deployment-id>`)

FOLLOW-ON ITEMS:
- M4 (retirement sweep, the last phase): delete the inert #ins-hdr-controls markup + insInitHeaderDates_/insSyncHeaderDates_ wiring, the lens switcher (decide whether "Agent table"/"Insights" stays as pure scroll affordances or goes), handoffToInsights_/launcherOpenInsights_'s setPage detours, dead basePageRoute_/updateTabActiveState_ insights branches, the data-page belt in irDrillToAgent_, the insights-side recordPageWindow_ call, prefs-blob date slimming
- The hover-prefetch on the two ex-hand-off buttons still warms the dept summary for a jump that no longer refetches — harmless cache warm, M4 candidate for removal

DOCUMENTATION UPDATES NEEDED:
- None beyond those shipped in this commit
---END BROAD SCAN IMPLEMENTATION SUMMARY---
