---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: FO-1 — Batch D's obViewSync_ re-sent getDeptOutboundSummary while the same window's request was still in flight; FO-2 — the ui-harness README did not warn that a stale manager build makes manager "never sees / never fetches" checks pass vacuously when a driver is run by hand. (The third block-238 follow-on, G3, is a planned batch of its own and is NOT in this scope.)
Files modified: apps-script/department-dashboard/script-5-dept.html, tools/ui-harness/drive-deptoutbound.js, tools/ui-harness/README.md, .cycle/STATE.md

CHANGES:
FO-1 | script-5-dept.html | OB_VIEW_ gains `inFlight`; obViewSync_ returns early when the SAME key is already in flight (set when the request is sent, cleared by its own success/failure handler under the seq guard). An explicit Refresh still refetches (it nulls the key first), and a changed window still supersedes via seq.
FO-1 | drive-deptoutbound.js | new fresh-page check replaying the user order that reproduced it (land on Inbound -> switch to Outbound -> Refresh, twice): each outbound window (current + prior) is sent exactly ONCE per Refresh. Before the fix Refresh #1 sent each window twice ({"…":2,"…":2}); after, 1 and 1, stable over repeated runs.
FO-2 | tools/ui-harness/README.md | a "Running ONE asserting driver by hand — rebuild BOTH roles first" section: the command line, both failure modes of a stale manager site (the loud locator miss and the SILENT vacuous pass), that ci.mjs is unaffected, and to rebuild the manager site AFTER a bite-check mutation.

TEST RESULTS: passed — `npm run ci` 2243 pass / 0 fail (exit 0); `npm run lint:gas` clean; `CI=1 npm run ci:ui` all stages passed (drive-deptoutbound 31/31, was 29/29 + the new two-round check). The new check FAILED on the pre-fix code (reproduction) and passes after. Live scenario walks: S57 (My Department Inbound / Outbound / Both) — NOT APPLICABLE here (needs a deploy); behavior is unchanged except one fewer duplicate request.
REGRESSION RISKS: A request that never answers (neither handler fires) would leave inFlight set for that key -- the same window would then not be re-sent until the key changes or the user presses Refresh (which nulls the key). google.script.run always calls one of the two handlers, so this needs a platform failure; the frost stays visible, so it is not silent.
INVARIANTS AT RISK: None — client only.
NET SCORE: 1 production fix (a duplicate Neon-backed request on Refresh, cached server-side but sent and metered) − 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy → Manage deployments → New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- On a switch to Outbound, the Batch D table and the Insights Outbound fold each fetch the SAME two windows from their own stores (OB_VIEW_ and INS_OB_) -- four requests where two would do (server-cached). Sharing one store would halve it; it is a design change across two fragments, so left for an owner call.
- G3 (retire the Outbound modal: router repoint, 6c pin, drivers, S46, #63, the stale OutboundReport.gs release comment) -- the next planned batch, required before the 6c release.

DOCUMENTATION UPDATES NEEDED:
- None.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
