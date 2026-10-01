---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (broad-scan 2026-10-01, Batch 3 -- "per-call agent identity and the per-call reports"):
- PC-1  the per-call capture writers (inbound + outbound) store the ROSTER-canonical agent name through the SAME INV-24 rule the DQE build uses -- one shared canonicalizeAgentNameWith_ (both INV-16 copies), not a new hand-mirror; agent names in the journey are rewritten, queue / masked-customer / IVR nodes never
- PC-2  (resolved through PC-1's data fix, owner decision "Capture + Neon rewrite") the editor-run previewPerCallAgentNameRewrite / rewritePerCallAgentNames (cdr-import CDR Tools menu) re-canonicalize stored outbound_calls.agent_name, inbound_calls.first_agent / origin_agent and both journey columns; bound UPDATEs, 120 s statement timeouts, idempotent, stops at the backfill budget
- PC-3  Agent Day no longer counts a transfer leg in the inbound role a second time (the transferred call is already cross-referenced)
- PC-4  Direct-call metrics: an Outgoing leg the agent placed on a call that has an Incoming leg is that INBOUND call's own talk (credited to it), never a fake connected outbound; a direct call is answered only with talk > 0
- PC-5  a manager may drill an OUTBOUND call an internal record of theirs links to (related_call_id), on the Neon path (inboundLinkEntitled_) and the sheet fallback
- PC-6  the Outbound Calls export keeps an unknown ring blank (was COALESCEd to 0, which the fallback read as a "brief" unconnected call)
- PC-7  origin_agent is never taken from a leg whose caller is an external number
- PC-8  the journey sheet fallback no longer refuses a blank-dept manager request before the entitlement arms run
- PC-9  (owner ruling: implement) the R49 06:00 floor reaches the inbound/outbound query mirror: per ENTRY queue, CSR family by raw AND canonical (Dept Config raw=canonical) name; SQL CASE + the sheet-fallback JS twin; inbound:v16, outboundReport:v6
- PC-10 a per-call capture with HMAC_SECRET unset logs it and writes a `failure` Pipeline Health row naming Operator State #17 (was a silent success with NULL caller hashes)

Files modified:
apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/outboundCalls.js, apps-script/cdr-import/autoImport.js, apps-script/cdr-import/directCallMetrics.js, apps-script/cdr-import/buildDQEHistoricalData.js, apps-script/cdr-import/CDR Tools.js, apps-script/cdr-report/buildDQEHistoricalData.js, apps-script/cdr-report/outboundCallsExport.js, apps-script/department-dashboard/AgentDay.gs, apps-script/department-dashboard/InboundReport.gs, apps-script/department-dashboard/OutboundReport.gs, apps-script/department-dashboard/Config.gs, tests/unit/percall-agent-canon.test.js (new), tests/unit/agent-day.test.js, tests/unit/inbound-calls.test.js, tests/unit/csr-transfer.test.js, tests/unit/outbound-fallback.test.js, tests/unit/journey-fallback.test.js, tests/unit/call-journey-entitlement.test.js, tests/unit/direct-call-metrics.test.js, tests/unit/cross-file-pins.test.js, tests/unit/inbound-window-scope.test.js, tests/unit/inbound-qcd-parity.test.js, tests/unit/outbound-report.test.js, tests/README.md, CLAUDE.md (Operator State index #72), docs/operator-state.md (#72), docs/invariants.md (INV-24, INV-30), docs/per-call-capture.md, docs/architecture.md, docs/known-issues.md, docs/conventions.md, docs/module-dependencies.md (regenerated)

CHANGES:
PC-1 | buildDQEHistoricalData.js x2 (canonicalizeAgentNameWith_ / dqeStripParens_ / dqeFlattenParens_ top-level; the build's closure delegates; loadRosterCanonicalNames_ accepts a Spreadsheet), inboundCalls.js (icAgentCanonicalizer_ per-execution memo, icCanonicalizeRecordAgents_), outboundCalls.js | capture-time canonicalization; a roster read failure is the identity
PC-2 | inboundCalls.js (perCallAgentRewrite_, PCR_* constants), CDR Tools.js menu | preview lists only names that change; apply = bound UPDATE per pair + a jsonb journey rewrite that skips kind:'queue'
PC-3 | AgentDay.gs (agentDayInboundRole_) | transfer legs skipped in the inbound role
PC-4 | directCallMetrics.js (incomingCallIds, ownTalkOnInbound, talk>0 answered) | occupancy still recorded before the skip, so busy classification is unchanged
PC-5 + PC-8 | InboundReport.gs (inboundLinkEntitled_, getCallJourney arm, outboundCallJourneySheetFallback_) | server re-derived; blank dept reaches the link arm
PC-6 | outboundCallsExport.js | COALESCE(o.ring_seconds::text,'')
PC-7 | inboundCalls.js (icOriginAgentName_) | external-caller guard
PC-9 | Config.gs (INBOUND_WORK_WINDOW_PST.earlyStart), InboundReport.gs (inboundEarlyQueueSet_, inboundWindowStartSql_, inboundWindowStartFor_, inboundWindowClause_, parity research counts), OutboundReport.gs (fallback floor) | cache bumps inbound:v16 / outboundReport:v6
PC-10 | inboundCalls.js + outboundCalls.js (hashless flag + log), autoImport.js (perCallHashlessNote_, failure status) | failure row names #17

TEST RESULTS: passed -- `npm run ci` 2026/2026 (23 new tests incl. the new percall-agent-canon suite), INV-16 guard clean, module-deps regenerated + up to date; bare `TZ=UTC node --test` 2026/2026; `CI=true npm run lint:gas` clean (75 files). Every new pin was mutation-checked (fails against the reverted line / the flat 06:30 / a dropped canonical-pair derivation). Seven pre-existing assertions grepped for the flat literal `c.call_start >= '06:30:00'` and were updated to the CASE form (the SQL they check is unchanged otherwise). ci:ui not run -- no client file touched.
REGRESSION RISKS:
- PC-9: CSR-family inbound/outbound figures GROW by the 06:00-06:30 calls (abandons, callback denominator, insurer daily) -- intended, matching DQE since R49; the Inbound-vs-QCD parity research block now compares like with like for the family. A Dept Config pair whose raw side is a family queue widens its canonical name too (that is the point); a config read failure falls back to the raw names only.
- PC-1: a roster or alias edit now changes what NEW per-call rows store; old rows keep the old name until the rewrite is re-run (#72). An ambiguous paren name is still stored raw.
- PC-2 rewrite: a mass UPDATE on Neon -- preview first and take a backup (#72). A journey entry with a missing `kind` is rewritten like any agent entry (matches capture).
- PC-4: Direct report figures move: fewer outbound connects, more answered direct calls, and zero-talk "answered" legs drop out of answered (ATT rises). Not retroactive -- stored direct_call_history rows change only on rebuild/backfill.
- PC-10: an install that never set HMAC_SECRET in cdr-import now shows a daily Inbound/Outbound failure row until it is set -- intended, it was silently degrading Caller Lookup and callbacks.
- PC-5: widens manager drill access by exactly one server-derived capability (a linked outbound call of an entitled internal record); no new public endpoint.
INVARIANTS AT RISK: INV-16 (both buildDQEHistoricalData.js copies edited -- guard confirms byte-identical); INV-24 (rule moved, not changed -- pipeline-build pins pass unmodified; entry updated); INV-06 (a new mirror of the R49 floor -- pinned in the cross-file-pins R49 block); INV-30 (inbound v16, outboundReport v6 -- entry + tables synced, cache-version-sync green); INV-01 (rewrite tool is an editor-run cdr-import function, not a dashboard RPC). None violated.
NET SCORE: 1 − 2 = -1 (production fixes: PC-1/PC-2 -- nickname agents read "Unrostered" in the Outbound report today; PC-9 -- every CSR-family window figure missed 06:00-06:30 since R49; PC-4 / PC-6 -- live miscounts on every run. New failure modes, documented above: the PC-2 rewrite is a mass Neon UPDATE an operator must run; PC-10 turns an unset secret into a daily red row.)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (capture canonicalization, PC-4, PC-7, PC-10, the rewrite tool) | BLOCKS DEPLOY: Y
- Deploy cdr-report (INV-16 build copy + PC-6 export) | BLOCKS DEPLOY: N
- Deploy the dashboard (PC-3, PC-5, PC-8, PC-9) | BLOCKS DEPLOY: Y
- After the cdr-import deploy: CDR Tools -> "Preview per-call agent-name rewrite", Health -> "Back up now", then "Rewrite per-call agent names (Neon)" (Operator State #72) | BLOCKS DEPLOY: N
- If an Inbound/Outbound failure row names HMAC_SECRET: set it in cdr-import to the dashboard's value (Operator State #17) | BLOCKS DEPLOY: N
- Optional: rebuild direct_call_history for recent dates (backfillDirectCallToNeon, #26) to apply PC-4 retroactively | BLOCKS DEPLOY: N
Deploy:
CDR Import: `scripts/deploy.sh apps-script/cdr-import`
CDR Reporting Tools / CDR DQE Pipeline: `scripts/deploy.sh apps-script/cdr-report`
Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- PC-10's other half -- normalizing caller numbers to 10 digits before hashing -- is DEFERRED: it changes the hash space (every stored caller_hash / callee_hash and the insurer reference table), so it needs a live measurement of how many numbers differ first.
- PC-12 deferred (as scoped).
- PC-9 for Direct is not applicable: R49 is per queue and a direct call has no queue.
- The work-window pill still shows 8:30 for everyone (pre-existing R49 note).
DOCUMENTATION UPDATES NEEDED:
- None beyond this commit (Operator State #72 + index, INV-24, INV-30, per-call-capture.md, the version tables). /sync-docs optional.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
