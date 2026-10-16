---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner plan "Step 5", part 5c (item 9c, 2026-10-16; not scan findings), admin-only while trialled:
  - 9c  New alert reason: an agent's answer rate below X% on each of the last N workdays
  - 9c  New alert reason: callers who could not get through and were not called back within a business day
New capabilities (G/ST): None (owner-requested feature)
Files modified:
  apps-script/department-dashboard/AlertReasons.gs (new: ALERT_REASON_RULES + readAlertReasonRules_ / saveAlertReasonRule; alertAgentLowFindings_ (pure); alertCallbackMisses_ over the callback engine; runAlertReasons_ (the run's second pass); the two admin-only emails)
  apps-script/department-dashboard/Alerts.gs (computeDeptAnswerRateForDate_ returns every agent's figures; runAlertsCore_ calls runAlertReasons_; pushAndLog tags reason rows `reason:<kind>:`; alertsOutcomeString_ keeps reason rows out of the dept counts and reports "reasons: N checked, M fired"; the config section carries reasonRules)
  apps-script/department-dashboard/OutboundReport.gs (obCallbackListEpisodes_ takes an optional windowDays; every existing caller unchanged)
  apps-script/department-dashboard/Notifications.gs (History skips reason rows)
  apps-script/department-dashboard/Config.gs (PROP_REGISTRY_: ALERT_REASON_RULES)
  apps-script/department-dashboard/dashboard.html, script-7-admin.html (the "More alert reasons" section: sentences + form; Preview rows label their reason, a callbacks threshold reads "N+ callers", status `quiet` = "Did not fire")
  tests/unit/alert-reasons.test.js (new, 10 tests), tests/README.md
  tools/ui-harness: drive-notify.js (+3 checks, 29 total), build-harness.js (saveAlertReasonRule + previewAlerts mocks), gen-phase3.js (loads AlertReasons.gs)
  docs: operator-state.md (#78), regression-scenarios.md (S65), invariants.md (INV-01, INV-34), conventions.md, module-dependencies.md, CLAUDE.md (S65, #78, Alert Log statuses, Subsystems, driver list)

CHANGES:
9c | AlertReasons.gs, Alerts.gs | agent-low: the last N workdays (N 2..20) in ONE window read; an agent fires only when EVERY day has answerable calls below X (a day off or one day at/above X clears them); the dept's TEAM_AVG_EXCLUDES are left out; same narrowed roster population as the answer-rate rule.
9c | AlertReasons.gs, OutboundReport.gs | callbacks: the previous workday's callers judged through the assessed day by the callback engine (obCallbackEpisodes_, a business-day window: Friday -> Monday = 3); an own-team dial or the caller getting through clears them; fires at the configured caller count. Neon unreachable / a pending (not loaded) day -> `skipped`, never a miss. Emails list first-attempt CST times + queue, never a number.
9c | Alerts.gs, script-7, dashboard.html | Both ride the daily run under its claim and skip dates; email ADMINS only; Alert Log rows tagged `reason:<kind>:<runner>`, status `quiet` added; drift / History / dept counts exclude them; Preview shows them.

TEST RESULTS: passed -- node --test 2604 tests, 2603 pass, 0 fail, 1 skipped; lint:gas clean; INV-16 clean; module-deps regenerated; drive-notify 29/29; 8/9 bites land (1 equivalent mutant: the per-day index check is shadowed by the final day-count check); full ci:ui recorded in the commit.
REGRESSION RISKS:
  - The Health alerts outcome string gains a "; reasons: ..." segment when any reason is configured (OPS-8 prefix unchanged); a reason ERROR makes the run FAILED-PARTIAL like a dept error.
  - computeDeptAnswerRateForDate_'s return gains `agents` (all agents with answerable calls); callers that read lowAgents are unchanged.
  - With rules configured, each daily run reads one more DQE window per agent-low dept and one Neon callback query per callbacks dept.
INVARIANTS AT RISK: INV-34 (new status + reason tag; documented). INV-01 (a new admin config write; documented). INV-53 / INV-26 respected (roster population, excludes out). The 6c vetting gate is respected: callback data reaches admins only.
NET SCORE: 0 production fixes - 0 new failure modes = 0 (owner-requested feature)

OPERATOR ACTIONS / DEPLOY:
- None to deploy. To try the reasons: Admin > Alerts > More alert reasons (Operator State #78); walk S65 | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- Releasing the reasons to managers is a recipient change in AlertReasons.gs (the two send functions) plus, for callbacks, the 6c release.
- History ("would it have fired?") covers the answer-rate rule only; a reasons history would need its own pass.

DOCUMENTATION UPDATES NEEDED:
- None beyond those in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
