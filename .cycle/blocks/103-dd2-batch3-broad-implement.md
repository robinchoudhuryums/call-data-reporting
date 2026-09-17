---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (broad-scan 2026-09-17: DD-2 by owner decision + Batch 3 -- all 5)
- DD-2 | ONE answer-rate formula for every server surface, behind the `ANSWER_RATE_FORMULA` switch ('rung' = default, today's numbers; 'answerable' = the H2 standard); the four Overview accumulators gained `missed`; the four rate caches carry `rf-<formula>`; `probeAnswerRateFormulas()` prints both rates per dept + the verdict flips. NOT FLIPPED -- owner runs the probe first (Operator State #69).
- O-2 | Weekly/monthly digest freshness gate compares against the LAST BUSINESS day of the window (`lastBusinessDayOnOrBeforeIso_`), not its calendar end -- no false "data not yet available" send for a month ending on a weekend or a Friday holiday.
- C1-3 | My Department Quick-select chips resolve through the shared `datePresetRange_`; script-2 joined the date-presets tripwire.
- C2-5 | Inbound / Direct / Outbound default To = the latest data day (R30 rule).
- C2-8 | Agent app: the "Yesterday" chip relabels to "Latest day (<iso>)" when the latest DQE date is not yesterday; a bad custom range shows an inline message instead of hiding the numbers.
- O-6 | Operator State #31's stale per-recipient send-loop paragraph replaced with the single-message / FAILED-ALL model.
Files modified: apps-script/department-dashboard/{Config,Alerts,Digest,IndividualReport,InsightsReport,CompanyOverview,Util,Diagnostics}.gs, script-2-chrome.html, script-9-inbound-direct.html, agentApp.html; CLAUDE.md (H2 bullet + Operator State index #69), docs/operator-state.md (#31 text, new #69), docs/invariants.md (INV-30), tests/README.md; tests/unit/answer-rate-formula.test.js (NEW), individual-report.test.js, company-overview.test.js, digest-freshness-gate.test.js, date-presets.test.js

CHANGES:
DD-2 | Config.gs | `getAnswerRateFormula_` (memoized; `ANSWER_RATE_FORMULA_MEMO_`), `answerRateDenom_`, `answerRatePct_`, `answerRateCacheTag_`; PROP_REGISTRY_: ANSWER_RATE_FORMULA (config), ANSWER_RATE_PROBE_FROM/_TO (tool)
DD-2 | Alerts.gs:720,743 · Digest.gs:716-727 · IndividualReport.gs:544,572,598,629,646 · InsightsReport.gs:600-601,636-637,668,693,711,727,746 · CompanyOverview.gs:174,698,726,732,855,864,1331-1332 | every rate through `answerRatePct_`; null-guards through `answerRateDenom_`
DD-2 | CompanyOverview.gs `companyTrendByDate`, `trendByDate`, the chart `cday` + YTD `day` maps, the WoW `cur`/`prev` | `missed` accumulated
DD-2 | IndividualReport.gs:209, InsightsReport.gs:186, CompanyOverview.gs overviewCacheKey_ + the YTD key | `+ ':' + answerRateCacheTag_()`
DD-2 | Diagnostics.gs | `answerRateProbeRow_` (pure) + `probeAnswerRateFormulas` (assertAdmin_, read-only, window props or 30 days ending yesterday)
O-2 | Util.gs `lastBusinessDayOnOrBeforeIso_`; Digest.gs digestGatedAttempt_ (`fresh = latest >= expectedIso`)
C1-3 | script-2-chrome.html buildDatePresetChips_ (keys -> datePresetRange_); tests/unit/date-presets.test.js FRAGMENTS += script-2
C2-5 | script-9-inbound-direct.html: the three *SetDefaultDates (To = latestDqeIso_ when known)
C2-8 | agentApp.html: `showInlineError`, `relabelYesterdayChip_` (called after the latest-date fetch)
O-6 | docs/operator-state.md #31

TEST RESULTS: passed -- `node --test` 1601/1601 (10 new incl. the new suite), INV-16 guard clean, `npm run lint:gas` clean. Bite-checks: DD-2 helper-ignores-switch, DD-2 bare-formula sweep, O-2 calendar-end gate, C1-3 local chip resolver -- all BITE. One PRE-EXISTING load-sensitive flake seen once in a full parallel run and not reproduced in three isolated runs: `neon-mirror-tail.test.js` "B1: budget-skipped dates keep their attempt count" (expected 1, got 2) -- untouched by this change; noted as follow-on. `npm run ci:ui` NOT run (playwright absent here) -- three client fragments changed (script-2 chips, script-9 defaults, agentApp), so run it before deploy.
REGRESSION RISKS:
- DD-2 with the default 'rung': every converted site is algebraically identical (denominator = rung, 0 when rung is 0; null-guards use the same denominator). The only observable change today is the cache-key suffix (`rf-rung`), which mints fresh keys once on deploy. On the flip: IR / Insights / Overview / Alerts / Digest rates rise by the neither-legs share; alert thresholds may need re-tuning where the probe shows a gap larger than the band.
- DD-2 memo: a suite that sets `ANSWER_RATE_FORMULA` must reset `ANSWER_RATE_FORMULA_MEMO_` (the tests do, in `finally`).
- O-2: only WIDENS what counts as fresh (a business-day end is unchanged); a window whose last business day's data is missing still defers / sends stale.
- C1-3: chip windows now end YESTERDAY (they ended today for "This month") -- the documented rule; the clamp still applies after.
- C2-5: report defaults now end on the latest data day; a user who wants today can still type it.
- C2-8: label text changes on non-yesterday days; validation no longer hides the page.
INVARIANTS AT RISK: INV-30 (suffix documented; cache-version-sync green); INV-25/INV-05 untouched (ATT semantics); INV-26 untouched; INV-01 untouched (the probe is a `_`-free editor function but admin-gated + read-only, the parity-tool convention).
NET SCORE: 2 − 0 = 2
  (a) fired this month: DD-2 NO (switch defaults to today's behaviour; the inconsistency persists until the flip -- by design); O-2 NO (next occurrence Nov 2); C1-3 YES (every "This month" chip click since M4 included today unless clamped); C2-5 YES (every Inbound/Direct/Outbound open defaulted to a window with an empty trailing day); C2-8 YES on Mondays; O-6 doc.
  (b) new failure modes: none identified.

OPERATOR ACTIONS / DEPLOY:
- Run `probeAnswerRateFormulas()` from the editor after deploy; read the per-dept gap and the "verdict changes" column; re-tune any Alert Config threshold whose gap exceeds its band. | BLOCKS DEPLOY: N (blocks the FLIP, not the deploy)
- Set `ANSWER_RATE_FORMULA=answerable` (Script Property) when satisfied -- no redeploy; clear it to revert. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>` (run where playwright is installed -- three client fragments changed), or `clasp push -f` + Manage deployments -> New version.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- After the flip has held: change the default to 'answerable' and retire the 'rung' arm (one-line + doc), so the switch does not live forever.
- Publish the active formula name in the `Dashboard Standards` sheet so team-tools can pin it (deferred: a column add on a tab team-tools reads is a two-repo edit, Operator State #68).
- `neon-mirror-tail.test.js` "B1: budget-skipped dates …" is load-sensitive under the parallel runner (seen once, not reproduced alone); worth a fake clock.
- Batches 4-9 of the scan plan remain.

DOCUMENTATION UPDATES NEEDED:
- docs/fix-history.md: entries for DD-2, O-2, C1-3, C2-5, C2-8.
- docs/regression-scenarios.md: a scenario for the probe -> flip -> IR/table agreement walk (S55), and S1's "From/To default" wording for the report modals (C2-5).
- Operator State #8/#12: mention the O-2 rule (a weekend/holiday window end is complete once the last business day landed).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
