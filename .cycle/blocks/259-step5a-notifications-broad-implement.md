---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner plan "Step 5", part 5a (2026-10-16; not scan findings), admin-only until the owner tests and releases:
  - 9a  Notifications page: the Alerts modal rewritten so each low-answer-rate rule reads as the sentence it enforces
  - 9b  "Would it have fired?" history per rule (last 20 workdays, beside the Alert Log's real outcome) and a test send to the requesting admin only
  - 9a/9b manager-editable layer, BUILT BUT OFF behind the admin-only NOTIFY_MANAGER_EDIT switch: a manager may only set a STRICTER threshold than the admin's; the server refuses a looser one, and the stricter of the two always applies at send time; window length / schedule / recipients stay admin-only
New capabilities (G/ST): None (owner-requested feature)
Files modified:
  apps-script/department-dashboard/Notifications.gs (new: NOTIFY_STRICTER_ / notifyStricterOf_ / notifyCheckStricter_, the switch + stored layer readers, alertEffectiveThreshold_, notifyRulesFor_, getNotifyRules / saveNotifyManagerRule / setNotifyManagerEdit, getAlertHistory + notifyAlertLogByDate_, sendAlertTest, notifyWorkdaysEnding_)
  apps-script/department-dashboard/Alerts.gs (alertRowsForRange_: the per-date memo became a window memo; runAlertsCore_ applies + logs + emails the effective threshold and names a manager value; sendAlertEmail_ opts.test; the config section carries managerLayer)
  apps-script/department-dashboard/Code.gs (user envelope: notifyEdit, manager-only, follows the switch)
  apps-script/department-dashboard/Config.gs (PROP_REGISTRY_: NOTIFY_MANAGER_EDIT, NOTIFY_MANAGER_RULES)
  apps-script/department-dashboard/dashboard.html (modal titled Notifications; rules list replaces the config table; Manager layer section; Settings "Answer rate alerts" section, hidden)
  apps-script/department-dashboard/script-7-admin.html (sentence cards, History, Test send, manager-layer switch + admin value, the manager's Settings section)
  apps-script/department-dashboard/script-2-chrome.html (Settings open asks for the manager section)
  apps-script/department-dashboard/styles.html (.al-rules / .al-rule / history table / settings row)
  tests/unit/notifications.test.js (new, 14 tests), dqe-span-readers.test.js (window read), client-dead-ends.test.js (busy cue on the rules list), tests/README.md
  tools/ui-harness: drive-notify.js (new asserting driver, 18 checks), ci.mjs (new stage), build-harness.js (five mocks; a THROWING fixture now reaches the failure handler like a server throw), gen-phase3.js (loads Notifications.gs)
  docs: invariants.md (INV-01 manager-layer write, INV-32, INV-34 test-sent + applied threshold), operator-state.md (#77), regression-scenarios.md (S63), conventions.md (Notifications), module-dependencies.md (regenerated), CLAUDE.md (S63, #77, driver list, Alert Log statuses, Subsystems)

CHANGES:
9a | dashboard.html, script-7-admin, styles | One card per Alert Config row: "When CSR's answer rate on a workday falls below 85%, email its managers and a@x.com." (Paused / not-monitored variants), chips for drift, skip dates, a manager value (applied or why not), duplicate / unknown dept; Edit / History / Test send / Remove.
9b | Notifications.gs, Alerts.gs, script-7 | getAlertHistory (admin): last N workdays (default 20, max 60), ONE DQE window read (alertRowsForRange_), the engine's own per-dept rate per day, the verdict under the rule as it stands (skip dates marked, not counted), joined to the newest real Alert Log row per date (preview / test rows skipped). sendAlertTest (admin, throttled): the real email to the caller only, "[Test]" subject + a callout saying whether it would have fired, logged `test-sent` / `test:<email>` (drift and History skip it).
9a/9b | Notifications.gs, Alerts.gs, Code.gs, Config.gs, script-7, script-2 | NOTIFY_STRICTER_ names the stricter direction per field (alertThreshold: higher); saves refuse a looser value; the run applies notifyStricterOf_ (admin raising past the manager wins). Off by default: managers refused, no Settings section, stored values inert. Admins can set a value to try it. Write path: assertManagerOrAdmin_ + assertDeptAccess_ + switch + validation + script lock + Logger + `notify:manager-rule` usage row; stored in a Script Property (no spreadsheet write).

TEST RESULTS: passed -- node --test 2587 tests, 2586 pass, 0 fail, 1 skipped; lint:gas clean; INV-16 clean; module-deps regenerated; drive-notify 18/18; 8/8 bites land (switch-off inertness, stricter direction, manager refusal while off, History skipping test rows, the run using the applied threshold, test send to the admin only, the manager-only envelope flag, the one window read); full ci:ui recorded in the commit.
REGRESSION RISKS:
  - The modal's config TABLE is gone (sentence cards); anyone used to the table layout sees a different shape. Same data, same edit form.
  - alertRowsForDate_'s memo now holds a window; a single-date run reads exactly as before (from === to).
  - The harness change routes a throwing fixture to the failure handler (it used to be logged as a console error); no existing fixture throws.
  - Once the switch is ON, a manager's value changes who is emailed on which days -- by design, and only toward MORE alerts.
INVARIANTS AT RISK: INV-01 (a new non-admin write -- Script Property only, INV-55 mitigations, documented); INV-32 (Notifications.gs's manager pair is the documented exception); INV-34 (new `test-sent` status, documented; schema unchanged). INV-30 untouched (no caches).
NET SCORE: 0 production fixes - 0 new failure modes = 0 (owner-requested feature)

OPERATOR ACTIONS / DEPLOY:
- None to deploy. To RELEASE the manager layer later: walk S63, then turn on "Let managers set a stricter threshold" in Admin > Alerts (Operator State #77) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- 5b (coaching release prep) adds its gates to NOTIFY_STRICTER_ and the same manager layer; 5c adds the two new alert reasons.
- The 11 legacy window.confirm calls (incl. the rule Remove) stay the documented ratchet backlog.

DOCUMENTATION UPDATES NEEDED:
- None beyond those in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
