---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: R16c — the owner's test-pass notes on the always-inline deploy (7 items; item 3 verified already-done)
Files modified: apps-script/department-dashboard/{dashboard.html, script-2-chrome.html, script-5-dept.html, script-8-insights.html, styles.html, InsightsReport.gs, DeptSummaryEmail.gs}, docs/client-ui-conventions.md, docs/regression-scenarios.md

CHANGES:
R16c-1 | script-8, styles | Daily breakdown multi mode: one clickable "All queues" DAY row per date, per-queue rows collapsed beneath (insQhDayToggle_, Enter/Space F13 route); violation-date chips force-open their day then flash the queue row (insJumpToDailyRow_). Default = one totals row per day.
R16c-2 | dashboard, styles | Team detail: heatmap + Share-of-answered side by side (.ins-detail-row flex-wrap; manager sees the share table full-width since the heatmap is admin-gated display:none; narrow stacks). Mock screenshot sent to the owner (real share table; stand-in heatmap grid — the RPC is deliberately unmocked in the harness).
R16c-3 | (verified only) | The "agent table/Insights toggle" was already removed in the N1 merge — only a retirement comment survives. Likely a stale cached page.
R16c-4 | script-5 | deptMissedDetailFrost_ frosts #dept-missed-detail (queue-only + agent timelines — a SIBLING the section frost never covered) in step with the chart; cleared in both fetch handlers.
R16c-5 | dashboard, script-2, script-8, styles | ONE Export menu + ONE Refresh on the dept controls: #dept-export-menu gains labeled Agent-table/Insights groups (Insights group revealed at open once insLastData exists) dispatching to the hoisted ins* handlers; the region's own ↻/Export removed (the nested Views wiring un-nested from the dead guard); dept Refresh adds a same-window runInsReport() pass that stands down when the sync already fired (in-flight check = generate button disabled — the probe caught the naive version double-fetching, fixed).
R16c-6 | DeptSummaryEmail.gs | Combined parent payloads render per-dept SECTIONS (heading band + worst-first agents within each + a deptGroups subtotal row per dept; Dept column dropped; legend says "grouped by department").
R16c-7 | InsightsReport.gs, script-8, dashboard | Email summary RETIRED — one consolidated email: takeaway + tiles + insEmailBehindBlock_ (extracted ex-summary behind-team list, labeled mid-email) + per-agent table filtered to ACTIVE agents (hidden count in the legend). Legacy req.style ignored. NB the manager digest reuses insEmailReportRows_ and inherits both changes (its test pins still pass — fixture agents are active).

TEST RESULTS: passed — 651/651 node --test, INV-16, ci:ui 24+16+30+14. Live-DOM probe: 22 day rows collapsed by default, expand/re-collapse on click; violation chip opens its day + flashes the right queue row (visible); export menu shows csv/email/ins-csv/ins-copy/ins-email/ins-print with the old buttons gone; Refresh fires exactly ONE insights run (the first probe caught a double — fixed with the in-flight guard); heatmap + share on one row (724+644px). Zero errors.

REGRESSION RISKS:
- The digest's insights format inherits the behind-team block + active-only filter (shared rows builder) — a deliberate coherence choice, noted in code; digest pins unaffected.
- ekTallyUnit_ still computes from ALL rows incl. hidden zero-activity agents (harmless: zero-volume rows never set maxVol).
- The insBtnFeedback_ "Sending…/Copying…" button feedback targeted the removed #ins-export-btn — it now no-ops (null-guarded); toasts still confirm. Follow-on: point it at #dept-export-btn.
- Manager view: the side-by-side row leaves the share table full-width — verified by flex+display:none, not a screenshot.

INVARIANTS AT RISK: None — INV-01 (both emails remain read-only, caller-recipient), INV-31 (MailApp scope unchanged), INV-45 untouched; no cache-key changes.

NET SCORE: 1 − 0 = 1 (the missed-detail loader gap was a live UX defect the owner hit; the rest is requested product polish)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Manage deployments → New version (or `scripts/deploy.sh . <dashboard-deployment-id>`)

FOLLOW-ON ITEMS:
- The owner's note "could potentially make the same change to" was CUT OFF mid-sentence — asked them to complete it (likely another side-by-side pairing).
- The side-by-side mock uses stand-in heatmap data (RPC unmocked in the harness); owner judges the real thing post-deploy and we revert/tune if disliked.
- Deeper export consolidation (ONE email = dept table + insights in a single message) proposed but not built — awaiting owner reaction to the two-group menu first.
- insBtnFeedback_ retarget to the dept export button (cosmetic).

DOCUMENTATION UPDATES NEEDED: None beyond those shipped (conventions daily/multi + R16c bullets, email bullets, S32 step, DeptSummaryEmail docstring).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
