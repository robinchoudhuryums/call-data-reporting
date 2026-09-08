---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: R32 | Block-170 follow-ons: (a) the freshness gate now covers weekly + monthly digests, (b) a quiet day with fresh data explains its zero tiles, (c) DEFERRED runs are warn-tinted in the Alerts modal's "Last runs" line
Files modified: apps-script/department-dashboard/Digest.gs, script-7-admin.html, styles.html; tests/unit/digest-freshness-gate.test.js; docs/operator-state.md (#12h), docs/invariants.md (INV-45), tests/README.md

CHANGES:
R32a | Digest.gs | digestDailyAttempt_ generalized to digestGatedAttempt_(cadence, now, source) (the daily name kept as a wrapper). runWeeklyDigests_ / runMonthlyDigests_ now go through the gate: the window's last day (last Friday / the month's last day) must exist on the DQE read source, else DEFERRED + a one-shot per-cadence retry (runWeeklyDigestRetry_ / runMonthlyDigestRetry_, +60 min) until the noon cutoff, which sends with the data-not-available note. Daily keeps its weekend/holiday skips; weekly/monthly deliberately do not (B-6 preserved -- a holiday Monday still runs the weekly). digestScheduleRetry_ / digestClearRetryTriggers_ take a cadence (clear-all when omitted; uninstall clears all).
R32b | Digest.gs | digestSummaryHtml_(…, opts): when rung === 0 and the send is NOT stale, a neutral "No calls recorded" callout names the dept + window and points at Operator State #44; on a stale send the sender's data-not-available callout already explains the zeros, so it is skipped.
R32c | script-7-admin.html + styles.html | the "Last runs" line tints a DEFERRED result with the new .al-active-wait (warn-soft / warn), distinct from FAILED-ALL's muted pill.

TEST RESULTS: passed — node --test 1211/1211 (3 new: weekly defers with its own handler on a holiday Monday while the daily skips, then sends fresh with the checked window; monthly defers then sends stale at the cutoff + clear-all; quiet-day callout end-to-end and its absence on a stale send; the retry-handler pin now stubs digestGatedAttempt_). npm run ci:ui 20/20 (client files touched).
REGRESSION RISKS: (1) Weekly/monthly runs that used to send at 8:xx on Monday / the 1st now wait for the window's last day -- on a normal morning that is already true and nothing changes; on a late-build morning the digest arrives up to ~4 h later, or at noon with the note. (2) digestSummaryHtml_ gained an optional 4th arg; the one caller passes it. (3) .al-active-wait is additive CSS.
INVARIANTS AT RISK: INV-45 extended (all cadences gated; marker semantics unchanged). INV-33 skips unchanged for daily; B-6 asymmetry preserved.
NET SCORE: 1 − 0 = 1 (the weekly/monthly blank-tiles shape was the same production bug on a rarer schedule)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`

FOLLOW-ON ITEMS:
- cdr-import / cdr-report failure emails (notifyNeonWriteFailure, notifyDqeBuildFailure_, emailDailyReport.js) stay plain text: EmailKit lives in the dashboard project and copying it would create a third INV-16-style duplication.
- The Daily Call Queue Report keeps its own pinned shell (deliberate).

DOCUMENTATION UPDATES NEEDED:
- Done in this commit: Operator State #12 (h), INV-45, tests/README.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
