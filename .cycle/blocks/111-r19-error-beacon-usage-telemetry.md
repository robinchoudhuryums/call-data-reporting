---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- R19-1 (owner: "if users face any issues or something fails to load, I am notified immediately") | Client-error beacon → immediate admin email, throttled
- R19-2 (owner) | Overview landings tracked in Report Usage
- R19-3 (owner) | Escalations page views tracked in Report Usage
- R19-4 (owner) | Health page Report Usage section expandable to per-user activity
- (prior turn, same push) | logStatusReturn_ on 23 editor-run trigger/status RPCs so the Execution log prints state

Files modified:
- apps-script/department-dashboard/SystemHealth.gs (reportClientIssue endpoint; computeReportUsageSummary_ per-user rollup; users section rows)
- apps-script/department-dashboard/CompanyOverview.gs (overview landing telemetry, auto-flag-gated)
- apps-script/department-dashboard/Escalations.gs (pageView telemetry)
- apps-script/department-dashboard/script-1-core.html (beacon: listeners for every user + reportClientIssue_)
- apps-script/department-dashboard/script-2-chrome.html (escLoad_(true) on page entry)
- apps-script/department-dashboard/script-3-overview.html (auto flag; ov failure beacon)
- apps-script/department-dashboard/script-5-dept.html (onError beacon)
- apps-script/department-dashboard/script-8-insights.html (failure beacon)
- apps-script/department-dashboard/script-10-escalations.html (escLoad_ pageView param; failure beacon)
- apps-script/department-dashboard/script-9-inbound-direct.html (Health folded users section)
- apps-script/department-dashboard/styles.html (.sh-fold-*)
- apps-script/department-dashboard/Util.gs (logStatusReturn_, prior turn)
- 9 engine .gs files (logStatusReturn_ wraps, prior turn)
- tests/unit/system-health.test.js (+5)
- CLAUDE.md (one new bullet)

CHANGES:
R19-1 | script-1-core + SystemHealth.gs | The dev overlay records errors admin-only and page-local; a manager hitting a broken page still told nobody. New listeners install for EVERY signed-in user (window error + unhandledrejection) and the four top-level load-failure handlers (Overview / My Dept summary onError / Insights generate / Escalations list) call reportClientIssue_('load-failure', ...). Server endpoint reportClientIssue emails admins immediately with user/page/kind/message/stack/UA. Bounded both ends: client sends each signature once per session (max 6 total, reporter never throws); server one email per signature per 30 min + 15 per rolling 6h CacheService window; throttled reports still Logger.log. INV-01-clean: email + cache writes only, no sheet.
R19-2 | CompanyOverview.gs + script-3-overview.html | One log site right at the cache check covers every return path: logReportUsage_('overview', dept-or-(all), user, !!cached) gated on !req.auto. The client's 5-min auto-refresh AND the warn-banner Retry pass auto:true, so 'overview' rows mean deliberate visits (Overview is the default landing = per-session who-showed-up row). Cache-warm traffic already suppressed via REPORT_USAGE_SUPPRESS_.
R19-3 | Escalations.gs + script-2-chrome/script-10 | getEscalations logs 'escalations' when req.pageView; ONLY setPage's entry path passes escLoad_(true). Filter changes, refresh, view-as reload and the post-mutation reloads pass nothing — rows count visits, not re-fetches. Dept column = requested dept or joined deptList.
R19-4 | SystemHealth.gs + script-9 + styles | computeReportUsageSummary_ grew a byUser rollup (runs, top-3 report digest, last-seen date + role-as-of-last-row, cap REPORT_USAGE_USER_CAP_=40, busiest-first). getSystemHealth emits them as muted rows under a new 'users' section; the client renders any section in HEALTH_FOLDED_SECTIONS_ collapsed behind a clickable/keyboard-operable header row (aria-expanded, per-render state). A stale client would render them flat, not break.

TEST RESULTS: passed. node --test 699/699 (+5 in system-health: per-user rollup, health rows, beacon email/throttle/cap/role-gate/field-caps). INV-16 green. claude-md-split + cache-version-sync green (no cache version changed — telemetry is side-effect, not payload). npm run ci:ui pending at block-write time — see STATE.

REGRESSION RISKS:
- The beacon adds a new public endpoint; abuse bounded by signature TTL + window cap + admin-only recipients. A genuinely broken deploy will burst ≤15 emails per 6h — that is the feature.
- getCompanyOverview gained a telemetry append per landing (sheet appendRow, try/catch, ~10ms) — on the cache-HIT path too, which was previously append-free. Watched as acceptable; REPORT_USAGE_SUPPRESS_ covers warm traffic.
- Health payload grew (≤40 user rows); modal renders them collapsed.
- escLoad_ signature gained an optional param — all existing callers pass nothing (falsy) and are unchanged.

INVARIANTS AT RISK: None violated. INV-01: reportClientIssue writes no spreadsheet (email + CacheService only); the two new logReportUsage_ call sites ride the existing sanctioned telemetry carve-out with code-constant report names. INV-30: no aggregation rule changed, no bump needed.

NET SCORE: 4 owner-requested capabilities − 0 new failure modes = 4

OPERATOR ACTIONS / DEPLOY:
- None required — beacon + telemetry are on for everyone once deployed; no flags, no setup() change | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Feedback/comment box (owner asked whether to build): recommended shape = email-only submission modal reusing the beacon's throttle discipline + html2canvas-pro screenshot; awaiting owner decision.
- Overview landings on the SWR cache path: the row logs on the server fetch, which every landing performs; if the fetch fails the landing is uncounted (acceptable — the beacon reports the failure instead).

DOCUMENTATION UPDATES NEEDED:
- DONE: one new CLAUDE.md bullet (beacon bounds, the load-failure-handler rule for new page loaders, the two telemetry scope rules, the Health users section).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
