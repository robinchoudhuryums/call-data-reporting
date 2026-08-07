---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: M1 — Insights→My Department merge phase 1 (move + route), per docs/insights-merge-plan.md (owner-approved 2026-08-07)
Files modified: apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script-2-chrome.html, apps-script/department-dashboard/script-6-ir.html, apps-script/department-dashboard/script-8-insights.html, apps-script/department-dashboard/script-10-escalations.html, apps-script/department-dashboard/styles.html, docs/insights-merge-plan.md (NEW), docs/insights-page-plan.md, docs/client-ui-conventions.md, docs/regression-scenarios.md, docs/invariants.md, CLAUDE.md

CHANGES:
M1-move | dashboard.html | The Insights page <section> (598 lines) moved inside #dept-page as <details id="dept-insights-region"> below the dept layout; every inner id unchanged incl. #insights-page (now a plain div, .page class dropped); Help topics ("three pages", Insights-as-section) updated
M1-route | script-2-chrome.html | setPage('insights') maps to 'dept' + deptInsightsOpen_({scroll:true}) after the dept branch; the retired insights page branch (kicker/title, insights-side adoptSharedWindow_) deleted; setRoute_ ternary simplified
M1-lazy | script-8-insights.html | deptInsightsOpen_ (SYNC ensure — programmatic details.open fires toggle async, and handoff/launcher callers write ins-* fields right after setPage returns; ensure-defaults-first is the page-era ordering contract) + region toggle listener (user-click open → insEnsurePage_, idempotent); comments updated
M1-drill | script-6-ir.html + script-8 call sites | irDrillToAgent_ gains opts.fromInsights — data-page==='insights' no longer exists to read; the 4 Insights call sites pass {fromInsights:true}, the dept-table drill passes nothing
M1-css | styles.html | .ins-region styles (fold-family summary, square caret box); data-page="insights" toggles + container padding rule retired; sticky stacking (Insights results header top: var(--dept-sticky-h), z 59 under the controls' 60); print path retargeted (body.ins-printing hides chrome + #dept-page > :not(#dept-insights-region); the old rule hid > .container which now CONTAINS the region)
M1-tour | script-10-escalations.html | My Department tour step body reworded (expandable Insights section at the bottom)
M1-docs | docs/* + CLAUDE.md | New insights-merge-plan.md (M1–M4 plan of record); insights-page-plan.md marked SUPERSEDED; INV-37 entry rewritten (three data-page values, the setPage mapping); CLAUDE.md multi-page bullet; client-ui-conventions lens-switcher bullet replaced by the Insights-region bullet; S32/S37 steps

TEST RESULTS: passed — 651/651 node --test, INV-16 guard clean, npm run ci:ui 28+16+30+14 (all four asserting drivers; they already routed via #my-dept-btn → #lens-ins-btn so needed no changes). Plus two live-DOM Playwright probes against the built harness: cold dept load = region present/closed/no RPC side effects; lens click = region opens, report auto-generates (4 KPI tiles, 4 QH rows), data-page stays 'dept', My-Dept tab highlighted, insights header pins at 77px (the measured --dept-sticky-h); quick-start chip from Overview routes to dept+open region; IR drill from an Insights card shows Back-to-Insights (close restores, region + report intact); dept-table drill keeps it hidden; zero console errors.

REGRESSION RISKS:
- A report that finishes generating while the region is CLOSED (user opens, then collapses mid-generate) can draw charts at zero size — the same class as the page-era switch-away-mid-generate exposure, now one click easier to reach. The inner folds' draw-on-open + insResizeCharts_ on reopen mitigate; flagged for M2.
- The admin A/B panel (position:fixed, inside the region) now floats over the whole dept page whenever the region is open, not just while "on Insights". Admin-only cosmetic; M3 item in the plan.
- The .is-stuck elevation shadow never fires on the offset Insights strip (intersectionRatio stays 1 while pinned below the controls) — decoration only, documented in the CSS.
- The insights-side R9-3 adoptSharedWindow_ went with the page branch; convergence now rests on the dept-side adoption + the handoffs' explicit date carries. pageActiveWindow_.insights is still recorded (its dwell re-arm is dead — harmless), retired fully in M4.

INVARIANTS AT RISK: INV-37 (multi-page model) — deliberately amended, entry + CLAUDE.md index updated in the same commit; split-guard test passes. INV-45 (Insights auto-generate) unchanged — first OPEN now plays the role of first ENTRY. INV-30: no cache change (no aggregation-rule change). INV-01: zero server-side changes.

NET SCORE: 0 − 0 = 0 (feature restructure, not bug fixes; no new failure modes shipped — the three risks above are documented pre-existing-class or cosmetic items carried into M2/M3)

OPERATOR ACTIONS / DEPLOY:
- None (no Script Properties, triggers, sheets, or migrations; no remote file deletions — no files were removed, only content moved between existing ones)
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh . <dashboard-deployment-id>`)

FOLLOW-ON ITEMS:
- M2 (controls reconciliation): one date authority, Refresh contract for open folds, region-summary KPI headline, region open-state persistence decision, adoptSharedWindow_/pageActiveWindow_ retirement
- M3 (scope polish): dept pill on the region header for parent depts, "See missed calls" as in-page scroll, Agents section default → Gap vs team, A/B panel visibility scoping
- M4 (retirement): handoff/launcher setPage detours, lens switcher, dead basePageRoute_/updateTabActiveState_ branches, the data-page belt in irDrillToAgent_, driver + docs sweep
- The closed-mid-generate chart-size exposure (regression risk 1) wants a render-time "region open?" re-arm in M2

DOCUMENTATION UPDATES NEEDED:
- None beyond those shipped in this commit (plan doc, INV-37, CLAUDE.md bullet, conventions, scenarios, Help, tour)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
