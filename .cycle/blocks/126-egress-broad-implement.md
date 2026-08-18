---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: R24-ship (merge/deploy path for the agent-filtered DQE
fetch), EGRESS-1 (skip queue_split fetch while QUEUE_SPLIT_SCOPE=off),
EGRESS-2 (positional json_build_array DQE payloads), EGRESS-3 (report cache
TTL 30 min -> 6 h + the reportFreshnessTag_ key suffix that makes it safe)
Files modified: NeonRead.gs, Config.gs, Util.gs, Data.gs, CompanyOverview.gs,
MissedCallsReport.gs, IndividualReport.gs, InsightsReport.gs,
DirectCallReport.gs, InboundReport.gs, tests/unit/dal-cutover.test.js,
CLAUDE.md, docs/known-issues.md

CHANGES:
EGRESS-1 | NeonRead.gs | neonFetchDqeRows_ selects '' instead of the stored
queue_split JSON unless QUEUE_SPLIT_SCOPE=dept or opts.withQueueSplit
(compareDqeSources_ forces it so the parity gate certifies the real column);
position 12 stays occupied so the array protocol never shifts
EGRESS-2 | NeonRead.gs + dal-cutover fixture | json_agg(t) keyed objects ->
json_agg(json_build_array(...)) positional rows (~half the payload -- no
repeated column names); parse loop + test fixture are the two mirrors of the
column order, and the fixture keys off the actual SQL so a drift fails in CI
EGRESS-3 | Config.gs + Util.gs + 8 report files | REPORT_CACHE_TTL_SECONDS
30 min -> 6 h; NEW reportFreshnessTag_() (latest DQE date, 5-min tier)
suffixed into summary / overview / missed x2 / individual /
individual_active / insights / direct / inbound keys so the morning ingest
mints new keys within minutes -- REQUIRED companion, since overviewCacheKey_
had no date anchor and would otherwise hide fresh data for hours

TEST RESULTS: 761/761 pass; INV-16 guard + CLAUDE.md ratchet +
cache-version-sync green; ci:ui green (164 checks)
REGRESSION RISKS: a NEW heavy report cache key added without the freshness
tag inherits a stale-morning bug at 6 h (documented in the CacheService
bullet); admin corrections can lag up to 6 h in views not explicitly busted
INVARIANTS AT RISK: INV-30 (no version bumps needed -- tag is a suffix, the
S2-0/CORE-3 pattern); INV-16 untouched
NET SCORE: 3 production fixes (egress ~10-20x cut on the dominant read path
stack) - 0 new failure modes = +3

OPERATOR ACTIONS / DEPLOY:
- Deploy the DASHBOARD (clasp push -f + Manage deployments -> New version)
  | BLOCKS DEPLOY: Y (nothing lands until deployed; R24's agent filter is
  the single biggest egress cut)
- cdr-import deploy still pending from R22 (4% violation gate) | BLOCKS: N
- Optional for the rest of August: DQE_READ_SOURCE=sheet to conserve
  remaining transfer for the Neon-only surfaces | BLOCKS: N
- Sep 1 (Neon reset): run backfillInboundCalls + backfillOutboundCalls
  first thing, then runNeonCoverageCheck | BLOCKS: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps
Script editor -> Deploy -> Manage deployments -> pencil -> New version

FOLLOW-ON ITEMS:
- Outbound report plan (incl. callbacks cross-reference phase) parked until
  Neon is stable
- Sheet twins ruled out for Escalations/Inbound/Direct (owner Q answered in
  chat: dual-source drift cost > outage-window benefit; Direct's sheet
  primary is the one feasible fallback if ever wanted)

DOCUMENTATION UPDATES NEEDED: None further (CacheService tiers bullet, Neon
read-back bullet, operator checklist line 4, known-issues TTL note updated
in this round)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
