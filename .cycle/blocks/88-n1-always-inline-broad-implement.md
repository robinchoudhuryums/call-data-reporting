---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: N1 — always-inline Insights (post-deploy owner feedback on M1–M4: one continuous page, no toggle), per docs/insights-merge-plan.md §N1
Files modified: apps-script/department-dashboard/dashboard.html, script-2-chrome.html, script-4-nav.html, script-5-dept.html, script-8-insights.html, script-10-escalations.html, styles.html, tools/ui-harness/drive-smoke.js, drive-f13.js, drive-insights.js, docs/insights-merge-plan.md, docs/client-ui-conventions.md, docs/regression-scenarios.md, CLAUDE.md

CHANGES:
N1-inline | dashboard.html, script-8, script-2, script-5 | The region renders OPEN by default (`<details ... open>`) and the report loads WITH the dept page: new deptInsightsEnsureLive_ runs on dept entry (setPage dept branch) + every refresh(), gated on data-page='dept' (Overview landing pays nothing) and on the region being open (manual collapse respected per session; toggle listener re-ensures on reopen). Wraps insEnsurePage_ (first call arms the INV-45 auto-run), the M2/M3 sync, and the new insRearmZeroCharts_ (recreates 0×0 charts created while the page was hidden — the page-switch variant of the toggle re-arm).
N1-lens | dashboard.html, script-2, script-8, styles.html | The lens switcher REMOVED on both sides (read as a page toggle) with its .ds-lens-switch CSS and the #ins-open-mydept-btn wiring; deep links / Digest links / quick-start chips still land via the mapped setPage('insights').
N1-retire | script-4, script-5 | The R11-C2 dwell prefetch + ex-R9-3 shared-window store (pageActiveWindow_, recordPageWindow_, armDwellPrefetch_, insDwellPrefetch_) and prefetchDeptSummary_ deleted — the real fetch fires up front, nothing left to pre-warm.
N1-harness | drive-smoke/f13/insights | smoke navs drop the lens step (dept step waits 5s and its blank-canvas check now covers the inline Insights canvases; 24 checks); f13/insights enter via #my-dept-btn alone.
N1-docs | docs/*, CLAUDE.md | Plan doc §N1 (incl. the viewport-approach escape hatch); CLAUDE.md multi-page bullet + conventions index; conventions region/M4-N1 bullets; scenarios S14/S18/S32/S37; Help topics + tour step.

TEST RESULTS: passed — 651/651 node --test, INV-16 guard, ci:ui 24+16+30+14. Live-DOM probe: Overview landing renders no Insights (no RPC cost); entering My Department with ZERO extra clicks renders the agent table AND the generated Insights section on one page (dept pill, headline, 4 KPI tiles); manual collapse survives navigation and reopen restores the report; the quick-start chip route lands. Zero errors.

REGRESSION RISKS:
- Every My Department visit now fires the Insights RPC (in parallel with the summary; server 30-min cache + CacheWarm make repeats cheap; a cold 30–60s generate renders progressively and never blocks the table). Escape hatch documented in the plan: switch the trigger to viewport-approach if it feels heavy live.
- Report Usage telemetry will show a step-up in 'insights' rows (every dept visit logs a run, as the dwell prefetch already did for engaged users) — expected, not a usage surge.
- The manual-collapse session state is not persisted — a user who always collapses re-collapses per visit (deliberate; persistence would recreate the two-page feel).

INVARIANTS AT RISK: None — INV-45 unchanged (the auto-run now fires on page entry); no server/cache changes across the entire merge arc.

NET SCORE: 0 − 0 = 0 (product-shape change per owner ruling; net −46 lines)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh . <dashboard-deployment-id>`)

FOLLOW-ON ITEMS:
- Owner to eyeball the continuous page live, then decide whether the overlapping surfaces (team strip vs Insights KPI tiles; QCD side panel vs Queue health) should merge — deliberately deferred.
- If cold generates feel heavy in practice: the viewport-approach trigger (IntersectionObserver) is a one-function change in deptInsightsEnsureLive_.

DOCUMENTATION UPDATES NEEDED: None beyond those shipped
---END BROAD SCAN IMPLEMENTATION SUMMARY---
