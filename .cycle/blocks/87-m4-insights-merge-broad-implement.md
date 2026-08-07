---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: M4 — Insights→My Department merge phase 4 (retirement sweep; the merge M1–M4 is COMPLETE), per docs/insights-merge-plan.md
Files modified: apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script-2-chrome.html, apps-script/department-dashboard/script-4-nav.html, apps-script/department-dashboard/script-5-dept.html, apps-script/department-dashboard/script-6-ir.html, apps-script/department-dashboard/script-8-insights.html, apps-script/department-dashboard/styles.html, docs/insights-merge-plan.md, docs/client-ui-conventions.md, docs/regression-scenarios.md, CLAUDE.md

CHANGES:
M4-lens | script-2, dashboard.html | Lens switcher KEPT as a jump affordance (owner-endorsed lean): "Insights" → deptInsightsOpen_({scroll:true}) directly — no date carry (dept controls are the authority), no forced re-generate per click (the old handoffToInsights_ armed one; convergence sync + first-open auto-run cover every real case). Titles reworded to "jump".
M4-delete | script-4, script-8, script-6, dashboard.html, styles.html | Deleted: handoffToInsights_ (no callers); the #ins-hdr-controls header-dates row + insInitHeaderDates_/insSyncHeaderDates_/insHeaderDatesWired_ + CSS (hidden since M2; insApplyWindow_ survives as the shared re-run tail); the #5-Option-A hover-prefetch on the two ex-hand-off buttons; basePageRoute_'s insights branch; updateTabActiveState_'s effRoute mapping; irDrillToAgent_'s data-page belt (origin = opts.fromInsights only); the dwell-prefetch 'insights' arm + pageActiveWindow_.insights slot (store is dept-only); the prefs blob's preset/from/to (saved VIEWS keep their own dates deliberately).
M4-compat | script-2, script-4 | setPage('insights') + ROUTES_/SHARE_STATE_ '/report/insights' documented as PERMANENT compat surface (deep links + Digest email links), not leftovers.
M4-docs | docs/*, CLAUDE.md | Plan doc M4 marked shipped (lens decision recorded); conventions header-dates bullet → DELETED + region bullet final state; CLAUDE.md index line; S37 wording; comment sweep across dashboard.html/script-2/4/5 (lens titles, teaser note, popover title's stale "header row below").

TEST RESULTS: passed — 651/651 node --test, INV-16 guard, npm run ci:ui 28+16+30+14 (drivers unchanged — they click the kept lens jump, which now exercises the new direct-open path). Live-DOM probe: lens first-open opens + generates (4 KPI tiles); lens re-click is a PURE SCROLL (no loading pane, results untouched, page scrolled); the quick-start chip route from Overview still lands on the open region with Queue health visible; the prefs blob carries compareMode but no from/preset. Zero errors.

REGRESSION RISKS:
- Lens re-click no longer forces a re-generate (was: one report RPC per click). The Insights header's own ↻ Refresh button remains the explicit re-run; convergence handles window/dept changes. Strictly less RPC; behavior change is intentional.
- Saved-view/share-link '/report/insights' state still applies through the untouched SHARE_STATE_ provider; the deleted header inputs were mirrors, not the canonical fields.
- pageActiveWindow_ is dept-only now — any future code expecting an 'insights' slot must not assume it (none does; grep-verified).

INVARIANTS AT RISK: None — deletions only touched client transition machinery; INV-45 (first-open auto-generate), the routes contract, and all server surfaces unchanged.

NET SCORE: 0 − 0 = 0 (pure retirement; net -62 lines)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N (no server files changed across the whole M1–M4 merge — no remote-orphan risk, no scopes, no properties)
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh . <dashboard-deployment-id>`)

FOLLOW-ON ITEMS:
- The merge is COMPLETE. Post-deploy manual walk: S37 + S32 (Insights region end-to-end), S14/S18/S19 (compare modes), S23 (nav), S39 keyboard walk — the live-wiring parts the harness can't see.
- Optional future: `.cycle` docs mention the ex-page in historical blocks — left as history per fix-history discipline.
- The `insights-page-plan.md` doc stays as superseded history.

DOCUMENTATION UPDATES NEEDED:
- None beyond those shipped in this commit
---END BROAD SCAN IMPLEMENTATION SUMMARY---
