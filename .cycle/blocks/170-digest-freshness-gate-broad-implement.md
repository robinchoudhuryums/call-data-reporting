---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: R31 | Freshness gate for the daily digest: send only once the window day's DQE data exists; DEFERRED + one-shot hourly retry until the noon cutoff, which sends with an explicit data-not-available callout
Files modified: apps-script/department-dashboard/Digest.gs; tests/unit/digest-freshness-gate.test.js (new); docs/operator-state.md (#12h), docs/invariants.md (INV-45), CLAUDE.md (Operator State index #12), tests/README.md

CHANGES:
R31 | Digest.gs | runDailyDigests_ now delegates to digestDailyAttempt_(now, source): weekend/holiday skips unchanged; resolves the window; reads the latest DQE date on the ACTIVE read source (digestLatestDqeIso_: Neon MAX(call_date) when DQE_READ_SOURCE=neon, else the memoized sheet bounds scan -- trigger-safe, no Session user); pure digestDailyDecision_ (done / send / defer / send-stale). defer -> records `DEFERRED <date>: DQE data is through …` in DIGEST_LAST_RESULT_daily and schedules ONE one-shot runDailyDigestRetry_ (+60 min; replaces, never stacks); send-stale (hour >= 12, or a retry that could not be scheduled) -> sends with staleLatest. The gate hands its window to sendDigestsForCadence_(cadence, runOpts) so the send can never drift onto a different day than the one checked; the run-claim marker still owns dedup; a done window clears pending retries; uninstallDigestTriggers_ removes a pending retry. sendDigestEmail_ renders a warn callout ("Data not yet available for <date> … data is through <latest>") above the tiles on a stale send; the run record says `… sent at the 12:00 cutoff WITHOUT <date> data`. Installed trigger unchanged (no reinstall); weekly/monthly untouched; previews unchanged.

TEST RESULTS: passed — node --test 1208/1208 (9 new): decision table, trigger-safe latest date, defer records + schedules exactly one retry and sends nothing, fresh sends with the checked window and no note, cutoff sends stale and clears the retry, unschedulable retry falls through to a stale send, already-sent window is done, retry handler self-cleans and weekends skip, end-to-end cutoff email carries the callout and the record. Existing digest-wow / digest-insights suites unchanged and green. No client / pipeline / INV-16 file touched.
REGRESSION RISKS: (1) sendDigestsForCadence_ gained an optional second arg; every existing caller passes none (byte-equivalent). (2) A deploy while a DEFERRED state is pending leaves no orphan: the retry trigger is a one-shot and is cleared on the next done/send. (3) The gate reads the sheet bounds once per attempt (memoized per execution) -- the same scan getLatestDataDate pays, now on the R27 memo. (4) If the import lands after noon the digest already went out stale; the callout says so and the dashboard shows the day -- an accepted cost vs. sending nothing.
INVARIANTS AT RISK: INV-45 (digest run-claim/failure semantics) -- extended, not changed: the marker still dedups; DEFERRED does not claim the window. INV-33 (weekend/holiday skips) preserved for trigger and retry alike.
NET SCORE: 1 − 0 = 1 (every 8 AM digest sent before the import landed showed blank tiles -- the owner's every test send)

OPERATOR ACTIONS / DEPLOY:
- None (the installed 8 AM daily trigger is reused; the retry is self-scheduled) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`

FOLLOW-ON ITEMS:
- The SUMMARY digest still renders bare zero tiles on a genuinely quiet day (rung 0 with fresh data); an explicit "no calls recorded" callout there is a small separate change.
- Weekly/monthly digests are not gated (closed windows); a Monday-morning weekly run before Friday's late import would be equally blank -- rare, noted.
- The Alerts modal's "Last runs" line renders DEFERRED in the neutral style (only FAILED-ALL is tinted); a muted tint for DEFERRED is cosmetic.

DOCUMENTATION UPDATES NEEDED:
- Done in this commit: Operator State #12 (h), INV-45, CLAUDE.md index line, tests/README.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
