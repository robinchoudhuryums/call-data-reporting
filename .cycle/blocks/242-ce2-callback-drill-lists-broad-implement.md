---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: CE-2 (owner 2026-10-09; docs/next-steps.md "Callback episodes + direct lines") -- the two callback drill lists: the not-called-back list grouped by episode with status + late tags + the dialed line + the call id (copy, admin); a new called-back list with the dialer, their team, own / another team, the delay and a "↳ callback path" into the outbound call.
Files modified: apps-script/department-dashboard/OutboundReport.gs, dashboard.html, script-5-dept.html, script-8-insights.html, script-9-inbound-direct.html, styles.html; tests/unit/outbound-episodes.test.js, outbound-report.test.js, html-include-structure.test.js; tests/README.md; tools/ui-harness/build-harness.js, drive-callbacks.js; docs/per-call-capture.md, client-ui-conventions.md, regression-scenarios.md (S59), fix-history.md, next-steps.md, module-dependencies.md (regenerated).

CHANGES:
CE-2 | OutboundReport.gs | The engine records the DECIDING dial on own / other episodes (`ep.dial` = {iso, hms, id}; null for got-through / pending / none). obCallbackEventsSql_ takes `extraDays` (the lists read OUTBOUND_LATE_HORIZON_DAYS = 14 past the window; the engine's window expiry keeps those events from deciding anything). New pure `obEpLateTags_` (first dial / first family-queue got-through after the deadline, within the horizon, daysAfter from the last attempt, own vs another team). Shared list core `obCallbackListEpisodes_` (the report's event fetch + engine) + `obCallbackListDetail_` (ONE detail query, now incl. dial_in_number labelled from DIAL_IN_LABELS).
CE-2 | OutboundReport.gs | getOutboundUncalled returns `episodes` (newest first, whole episodes to the 200-attempt cap): status pending (daysLeft) / missed, attempts oldest first, late tags (missed only); `calls` keeps the flat rows (+ dialIn); meta pending / missed counts. NEW public read-only `getOutboundCalledBack` (same resolver + 6c gate, uncached, cap 200 episodes): first-attempt detail, attempts count, outcome, agent, roster team label, delay from the first attempt, connected, the dial's call id/date/start; meta own / other.
CE-2 | script-9 / script-8 / script-5 / dashboard.html / styles.html | outboundUncalledHtml_ (episode blocks: status chip, late-tag chips, rows with the dialed line + parentIdBadge = call id + copy for admins, path for managers) replaces heatCellDetailHtml_ in this drill only (the heatmap drill is untouched); outboundCalledBackHtml_ + outboundLoadCalledBackInto_ (UI-5 pattern, own counter INS_CB_.cbkSeq, reset with the fold); "List called-back calls" button + list in #ins-cb-fold; the shared .pid-journey handler passes an optional data-journey-kind (outbound) to callJourneyShow_; .ob-ep styles inside </style>.
CE-2 | tests / harness | Engine: deciding dial, past-window events never decide, late-tag rules (deadline edge, horizon, family, other caller). Endpoints: two-query sequence, late span in the SQL, statuses / daysLeft / tags / dialIn / cap / gate / unavailable; called-back list fields + gate. UI-5 pin extended to the new drill. Harness mocks for both lists; drive-callbacks +4 checks (episode grouping + chips, ids + copy + dialed line, the called-back list, the outbound path opening with kind outbound).

TEST RESULTS: npm run ci 2273 pass / 0 fail (exit 0); lint:gas clean; drive-callbacks 29/29; full CI=1 npm run ci:ui: all 13 asserting stages green (exit 0). Both endpoints were EXECUTED against a local Postgres 16 (company, dept and parent views; a later "today" made the late tag fire from SQL-sourced data). Bites: late deadline edge, late family, called-back filter, deciding dial, dial-in label -- all BITE.
REGRESSION RISKS: (1) The not-called-back response gained `episodes` and rows gained `dialIn`; the only consumer is the fold's drill (updated). (2) The lists read dials/answers 14 days further than the report -- a little more Neon read per list click (labelled 'outbound-drill'). (3) The .pid-journey handler now forwards a kind; absent attribute = inbound, so every existing chip is unchanged.
INVARIANTS AT RISK: INV-01 (getOutboundCalledBack is a new PUBLIC function -- read-only, behind outboundResolveRequest_'s allowlist + 6c gate; no write). No cache change (the lists are uncached), so INV-30 unaffected.
NET SCORE: 1 production fix (the not-called-back list gave no way to look a caller up or tell "not yet" from "missed", and nothing showed who did call back) − 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- Walk S59's two list steps after the deploy; copy a call id into the phone provider's portal once | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

FOLLOW-ON ITEMS:
- At the 6c release, decide whether MANAGERS see the call id + copy in these lists (today parentIdBadge shows managers the path chip only, the owner-round-4 rule).
- CE-3 (direct-line callbacks), as planned.
- Pre-existing (noted in block 241): agent-table tie order with a BLANK agent name differs between Neon and the sheet fallback.

DOCUMENTATION UPDATES NEEDED:
- None beyond those made.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
