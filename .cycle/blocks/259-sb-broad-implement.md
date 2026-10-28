---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- SB-1 -- Agent Day outbound: Placed as one bar (connected / rang out / brief / ring not recorded), talk time + dial attempts underneath (modal + inline agent panel).
- SB-2 -- Direct Calls report + Team Direct Calls card: calls that rang a person's line as one bar (answered / missed while free / missed while busy) with colleague / outside-caller rows; the busy-excluded answer rate moved under the bar; dialed calls as connected / not.
- SB-3 -- Outbound "Placed": the Outbound summary and Team Outbound panel draw connected / rang out / brief / unknown; the Overview tile's outbound line gets a slim connected / did-not-connect bar.
- SB-5 -- Inbound report: one bar of answered / rang out or voicemail / hung up that adds up to Inbound calls (the missed disposition was computed but never shown, so the rates fell short of 100%); company view adds where the hang-ups happened; on-hold and transfers-not-answered labelled under the bar. Admin-only (owner).
- SB-6 -- CSR Transfer detail: destinations as one bar incl. the untracked part (hatched); each agent's bar = calls handled with the transferred part in the R23 tier colour; sorted by transfers (owner).
New capabilities (G/ST): None
Files modified: apps-script/department-dashboard/{script-9-inbound-direct.html, script-10-escalations.html, script-5-dept.html, script-8-insights.html, script-3-overview.html, dashboard.html, styles.html}; tools/ui-harness/{build-harness.js, gen-payloads.js, drive-admin.js, drive-agentpanel.js, drive-deptoutbound.js, drive-outbound-e.js, README.md}; tests/unit/{cross-file-pins.test.js, html-include-structure.test.js}; tests/README.md; docs/{fix-history.md, client-ui-conventions.md, regression-scenarios.md}

CHANGES:
SB-1..6 | script-9 | shared obSplitSummaryHtml_ / obSplitMiniHtml_ / obPlacedParts_ on obOutcomeBarHtml_ (gains a slim size) + legend deltaHtml; generic segment classes in styles.html.
SB-1 | script-10 adKpiRowsHtml_ | outbound tile row -> split summary (.ob-split--out keeps the direction hue; the .ad-kpi-row--out tile rule retired, pin moved).
SB-2 | script-9 directSummaryHtml_, script-5 TDC card | report pair + slim card form.
SB-3 | script-8 insObRender_, script-5 obPanelRender_, script-3 ovBuildOutboundLine_ | Placed bars; Overview uses the two parts its block carries (no payload / cache change).
SB-5 | script-9 inboundSummaryHtml_ | three-part bar + where-hung-up bar + labelled quality line; the harness gains its first getInboundReport mock.
SB-6 | script-5 deptRenderTransferDetail_, dashboard.html, styles.html | destination + per-agent split bars; the fixture gains destination columns.

TEST RESULTS: node --test 2730 pass / 0 fail (TZ=America/Chicago); lint:gas clean; INV-16 guard clean; module-deps up to date; `CI=true npm run ci:ui` exit 0, no FAIL. Bites: 1/1 unit (brief-ring fallback pin) + 7/7 UI (inbound drops missed, placed drops rang out, direct drops busy, transfer drops hatch, transfer sorted ascending, agent day drops connected -- bit after the check was tightened to the exact parts; the Direct and Inbound sums).
REGRESSION RISKS: CSV exports, emails and table columns are untouched (display only). The Inbound email still shows the old KPI row (follow-on). The Overview tile bar is two-part only (its payload has no ring split).
INVARIANTS AT RISK: None (display layer only; INV-39 strip unchanged -- every surface touched is admin-only or already manager-visible with the same figures; the transfer detail stays CSR-only).
NET SCORE: 1 - 0 = 1 (SB-5 fixed a report whose rates did not add up; the rest are presentation changes counted as capability).

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- SB-4 Queue calls (answered / abandoned + a 4% line, four places) -- held by the owner pending a full-page before/after.
- The Inbound report EMAIL's KPI row has the same missing-"missed" gap.

DOCUMENTATION UPDATES NEEDED:
- None (fix-history SB-1..6, client-ui-conventions "Split summaries", S38/S44/S47/S58/S67, harness + tests READMEs done).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
