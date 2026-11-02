---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (Batch 4 is a new capability)
New capabilities (G/ST):
- TR-1: Admin ▾ → Transfer retries -- the admin list of calls where an agent tried someone in another department, got no answer, and tried someone else there on the same call (owner: build now, as an Admin modal)
Files modified:
- apps-script/department-dashboard/TransferRetries.gs (new)
- apps-script/department-dashboard/dashboard.html, script-2-chrome.html, script-4-nav.html, script-7-admin.html, styles.html
- tests/unit/transfer-retries.test.js (new), tests/unit/client-correctness.test.js
- tools/ui-harness/gen-phase3.js, build-harness.js, drive-admin.js, README.md
- docs/operator-state.md (#89), docs/fix-history.md, docs/regression-scenarios.md (S69), docs/module-dependencies.md, tests/README.md, CLAUDE.md (S69 index, #89 index, Subsystems list)

CHANGES:
TR-1 | TransferRetries.gs | getTransferRetries({from, to, dept?}) -- assertAdmin_, ISO dates, 92-day cap, a known department; ONE metered read (neonNoteEgress_ 'transfer-retries') of inbound_calls (is_internal false) + outbound_calls journeys prefiltered to `"transfer":true` AND `"missed":true`, no number or hash selected; trRetriesOfJourney_ (cdr-import's tfRetriesOfJourney_ mirrored, TR_QUICK_SECS_ = 8), departments via buildDeptsByAgent_ folded one level with getOverviewParentMap_; newest-first cases (cap 500, truncated flag) filtered by the TRIED department, summary with outcome counts, top callees (with quick declines) and sender -> tried pairs; Neon down / a failure reads available:false; a Report Usage row. getTransferRetriesInit: the department list + the cap + the decline line
TR-1 | dashboard.html, script-4-nav.html, script-2-chrome.html, script-7-admin.html, styles.html | Admin ▾ "Transfer retries" (data-admin-only) -> /admin/transfer-retries -> #transfer-retries-modal: From / To, Last 7 / 30 days (datePresetRange_), department tried, Show; the summary, "Most often not answering first", the pairs line, and one row per call (when, the path chip via parentIdBadge, an Outbound pill, sent by, tried first + how it ended, then tried + how that went, the gap); frost while loading, error / unavailable states, truncation note

TEST RESULTS: node --test 2800 pass / 0 fail (TZ=America/Chicago); lint:gas clean; module-deps --check clean (regenerated); bites 5/5 (mirror own-dept exclusion removed, decline line drifts, admin gate removed, SQL prefilter removed, department filter ignored); drive-admin.js all PASS standalone; ci:ui see STATE
REGRESSION RISKS:
- A second copy of the retry rule (cdr-import + dashboard): a change to one that skips the other fails transfer-retries.test.js's parity test, but only for shapes the corpus covers
- The read is Neon-only: during an outage the modal is unavailable (the export tabs carry journeys, a sheet fallback was not built)
- The 8-second decline line is a guess until the TR-0 census is in (owner chose to build first)
INVARIANTS AT RISK:
- INV-01: read-only, admin-gated; the only write is the append-only Report Usage row (the existing carve-out)
- INV-38: the sub-queue fold reads getOverviewParentMap_, the same map, one level
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability)

OPERATOR ACTIONS / DEPLOY:
- After the TR-0 census (diagnoseTransferRetriesAllDates, cdr-import), retune the decline line in BOTH TF_RETRY_QUICK_SECS_ and TR_QUICK_SECS_ if it should move (Operator State #89) | BLOCKS DEPLOY: N
- Delete nothing remote; the new TransferRetries.gs is pushed by clasp | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

FOLLOW-ON ITEMS:
- A sheet fallback from the Inbound / Outbound Calls tabs' journey column
- A CSV download of the list
- Release to the tried department's managers once the owner has checked the list

DOCUMENTATION UPDATES NEEDED:
- None beyond those made
---END BROAD SCAN IMPLEMENTATION SUMMARY---
