---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (broad-scan 2026-09-17, Batch 1 -- 5 of 6; DD-2 stopped, see FOLLOW-ON)
- A-1 | The three vetted-report resolvers (Outbound / Direct / Inbound) gated by a `role === 'none'` DENYLIST; the agent role fell through to the admin-style dept branch the day the vetting gate flips. Now `assertManagerOrAdmin_` (allowlist), agent-role refusal pinned in all three.
- D-1 | MTD violation month start was a SCRIPT-TZ midnight instant formatted in the SPREADSHEET TZ (CDT vs Mexico City UTC-6) -> the previous month's last day Mar-Nov on the sheet path (Insights violationsMtd, Overview "viol MTD" chip + its read window). One script-TZ calendar-string resolver, `mtdStartIso_`.
- D-2 | IR deptStats + per-card share were computed over the TEAM_AVG_EXCLUDES basis, contradicting INV-26 R18 (exclusion = per-agent averages/benchmarks only). Second whole-roster accumulator `deptTotal`; `individual:v11` -> `v12`.
- DD-3 | IR activeDays counted 0/0/0 roster rows as active days; now activity-gated like activeAgentSet.
- DD-1 | Missed report's normTimeKey_ parsed a coerced "12/30/1899 10:23:33" slot render as hour 12 on the sheet path; now recovers the time part (the sanitizeSlotCellForNeon_ shape) and refuses a non-numeric hour token.
Files modified: apps-script/department-dashboard/OutboundReport.gs, DirectCallReport.gs, InboundReport.gs, QCDReport.gs, CompanyOverview.gs, IndividualReport.gs, MissedCallsReport.gs, OrphanFix.gs (comment); docs/invariants.md, docs/known-issues.md, docs/architecture.md, docs/conventions.md (individual:v12); tests/unit/outbound-report.test.js, direct-call-report.test.js, overview-qcd-snapshot.test.js, individual-report.test.js, missed-report.test.js

CHANGES:
A-1 | OutboundReport.gs:137-145, DirectCallReport.gs:56-64, InboundReport.gs:84-92 | `if (user.role === 'none') throw` -> `assertManagerOrAdmin_(user)` before the temporary vetting throw. Tests: outbound 6c released-gate test refuses an agent (incl. `department:'ALL'`) and asserts the inbound resolver refuses the agent with the allowlist message, never the vetting one; direct suite resolves an agent through real Auth.gs (agent Access Control row + AGENT_ROLE_ENABLED) and is refused.
D-1 | QCDReport.gs (new `mtdStartIso_(todayIso?)`, computeMtdViolations_, the Neon read-window block), CompanyOverview.gs (computeQcdSnapshots_ read window + MTD cutoff) | Month start = `todayIso.slice(0,7)+'-01'` with todayIso formatted in the SCRIPT TZ; `tz`/ssTZ still resolves the ROW dates. Test: FakeDate at 2026-09-15T18:00Z, ssTZ America/Mexico_City, Aug 31 violation row excluded (5, not 12) through both computeQcdSnapshots_ and computeMtdViolations_.
D-2 / DD-3 | IndividualReport.gs:480-500 (accumulators), 578-586 (deptStats), 644-652 (share), :73 (prefix) | `deptTotal` (every roster agent) feeds deptStats + share; `teamTotal` (excludes) feeds teamAvg only; activeDaySet gated on rung/answered/missed > 0. INV-30 table + every prefix mention synced to v12 (invariants.md, known-issues.md x2, architecture.md, conventions.md, OrphanFix.gs comment).
DD-1 | MissedCallsReport.gs:944-975 (normTimeKey_) | `^M/D/YYYY H:MM(:SS)$` render -> its time part; hour token must be 1-2 digits or the key is '' (unparseable), never parseInt-truncated. Tests: unit cases + a sheet-path render pinning label "10:23:33 AM", sortKey 37413, bucket 4.

TEST RESULTS: passed -- `node --test` 1576/1576 (6 new tests), `scripts/check-duplicated-files.sh` clean, `npm run lint:gas` clean (72 files / 3 projects), `cache-version-sync` + `claude-md-split` green. Bite-checks (scripts/bite.sh): A-1, D-1, DD-1, D-2 pins all BITE. `npm run ci:ui` NOT run -- playwright is absent in this environment (no client file changed; run deploy.sh where playwright exists).
REGRESSION RISKS:
- A-1: only the agent and none roles change outcome (both refused); admins/managers unchanged. The agent-role refusal now precedes the vetting throw, so an agent sees "Not authorized." instead of "admin-only while vetted" -- correct.
- D-1: `mtdStartIso_` is a new QCDReport.gs global consumed by CompanyOverview.gs (which already depended on QCDReport.gs for readQcdGrid_/computeMtdViolations_); every suite that exercises those paths loads both. `_readTo` (the Neon read window's end) is now formatted in the script TZ rather than the sheet TZ -- a one-hour-a-day difference at most, and the window only widens the read.
- D-2/DD-3: IR `deptStats.*` and `share.*` VALUES change for any dept with a TEAM_AVG_EXCLUDES entry (CSR: Robin) and for windows containing 0/0/0 rows; payload SHAPE unchanged; the v12 bump prevents a mixed cache. teamAvg untouched.
- DD-1: strings whose hour token is non-numeric now key as '' (unparseable) instead of "0:MM:SS"; callers already handled '' ("Returns '' if unparseable"). The raw `time` field on a timeline entry still carries the coerced source string; only `label`/`sortKey`/`bucket` are corrected.
INVARIANTS AT RISK: INV-30 (bumped `individual` to v12 and synced every mention -- guard green); INV-26 (now implemented as written); INV-02/INV-18/INV-20 untouched (DD-1 still reads display strings, buckets unchanged); INV-01 untouched (no new public function); INV-16 untouched (no cdr-report/cdr-import file changed).
NET SCORE: 3 − 0 = 3
  (a) fired this month: A-1 NO (latent until the #63 flip / #46 pilot); D-1 YES (September is DST: every sheet-path MTD figure included Aug 31); D-2 YES (CSR runs IR with Robin excluded); DD-3 YES/likely (any 0/0/0 roster row in the window); DD-1 NO unless unrepaired coerced rows sit in a viewed window.
  (b) new failure modes: none identified for any of the five.

OPERATOR ACTIONS / DEPLOY:
- None (no Script Property, trigger, sheet or migration). | BLOCKS DEPLOY: N
- The A-1 fix must be DEPLOYED before anyone flips `OUTBOUND_VETTING_GATE_` (Operator State #63) or enables `AGENT_ROLE_ENABLED` (#46). | BLOCKS DEPLOY: N (blocks those two operator steps)
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version). Run where playwright is installed so the ci:ui gate actually executes.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- DD-2 (one Answer % formula) STOPPED, not started -- larger than sized: 25 `answered / rung` sites (Alerts.gs:720; CompanyOverview.gs 174, 698, 726, 732, 855, 864, 1331-1332; Digest.gs:716-727; IndividualReport.gs 544, 572, 598, 629, 646; InsightsReport.gs 600-601, 636-637, 668, 693, 711, 727, 746), at least four accumulators with NO `missed` counter (CompanyOverview `cday`, the WoW `cur`/`prev`, `dqeDaily` per-day map, `trendByDate`), INV-30 bumps for individual/insights/companyOverview/overviewChartYtd, and the low-answer-rate ALERT threshold semantics move (thresholds were tuned against answered/rung). Needs its own session and a one-line owner confirmation that the H2 rule (answered/(answered+missed), whole percent) is the dashboard-wide standard. Suggested shape: `answerRatePct_(answered, missed)` in Config.gs (the every-suite file), add `missed` to the four accumulators, route all 25 sites, one cross-surface pin, publish the formula name in `Dashboard Standards`.
- The other Batch 1-9 items from the broad scan remain as planned.
- Cosmetic: a coerced slot's raw `time` field still carries the source string (the label/key/bucket are fixed); harmless, could route through the same recovery if any consumer reads `time`.
- `mtdStartIso_` could also serve the all-dept report's `mtdFrom` (QCDReport.gs ~365, derived from the `to` string -- already correct, left alone).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md "Spreadsheet TZ ≠ script TZ" bullet: one line for the READ-side twin of R46 -- never format a script-constructed `new Date(y, m, d)` in the spreadsheet's TZ; derive calendar strings from `Utilities.formatDate(now, TZ)`. (Not added here: CLAUDE.md sits 4% under its size cap, T-6.)
- docs/fix-history.md: entries for D-1, D-2/DD-3, DD-1, A-1 (backstories; the rules are in code comments + INV-26/INV-30).
- docs/operator-state.md #46: the "every pre-agent gate refuses the role by allowlist" claim is now TRUE for the three vetted resolvers (was A-8c).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
