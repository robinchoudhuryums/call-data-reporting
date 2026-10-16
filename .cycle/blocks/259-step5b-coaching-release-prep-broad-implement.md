---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner plan "Step 5", part 5b (item 10, 2026-10-16; not scan findings), admin-only until the owner releases coaching:
  - 10  Per-department coaching gates with the stricter-only clamp (admin overrides over the company defaults; the Step 5a manager layer may only tighten them)
  - 10  The worklist closes as Met / Rotated / Dismissed
  - 10  The manager email -- each department's own new flags, worded for the person who has the conversation -- built and sent HELD FOR ADMINS only
New capabilities (G/ST): None (owner-requested feature)
Files modified:
  apps-script/department-dashboard/Coaching.gs (COACHING_DEPT_RULES + readCoachingDeptRules_ / coachingAdminGates_ / coachingEffectiveGates_ / coachingFlagOpts_ / saveCoachingDeptRule / coachingAllDeptGates_; coachingDeptFlags_ + coachingCurrentWindow_; COACHING_CLOSE_ACTIONS_ met/rotated/dismissed with resolved -> met; worklist meta.deptGates + managerLayerOn; coachingManagerRecipients_ (the release seam) / coachingManagerEmail_ / coachingSendHeldManagerEmails_ (weekly run) / previewCoachingManagerEmail)
  apps-script/department-dashboard/Notifications.gs (NOTIFY_STRICTER_ gains coachRatioPct higher / coachBehindPts lower / coachMinMissed lower; saveNotifyManagerRule takes any subset of fields, all validated before any write; notifyRulesFor_ lists every reachable dept with its alert rule (if any) and coaching gates)
  apps-script/department-dashboard/Config.gs (PROP_REGISTRY_: COACHING_DEPT_RULES)
  apps-script/department-dashboard/dashboard.html (Gates by department section; delivery hint names the held email)
  apps-script/department-dashboard/script-7-admin.html (Met / Rotated / Dismissed + their confirm copy and status labels; gates cards with Save + "Email me the manager version"; the manager's Settings section gains a coaching row)
  apps-script/department-dashboard/styles.html (.coaching-gates / .coaching-gate-row)
  tests/unit/notifications.test.js (+7 tests), coaching.test.js (held email in the delivery test, met/rotated closes), tests/README.md
  tools/ui-harness: drive-notify.js (+8 checks, 26 total), build-harness.js (coaching meta.deptGates, saveCoachingDeptRule / previewCoachingManagerEmail mocks, coaching in the manager rules)
  docs: operator-state.md (#48 Step 5b note, #77 coaching fields), regression-scenarios.md (S64), invariants.md (INV-01 note), conventions.md, module-dependencies.md, CLAUDE.md (S64, #48 / #77 index lines, driver list)

CHANGES:
10 | Coaching.gs, Notifications.gs | Gates resolve per dept: company default -> the dept's admin override (COACHING_DEPT_RULES, saveCoachingDeptRule: admin, validated, locked, logged) -> the manager layer's stricter value once NOTIFY_MANAGER_EDIT is on. The preview and the weekly run judge each dept under its applied gates; every flag carries them.
10 | Coaching.gs, script-7 | Closes are met / rotated / dismissed (the old resolved is accepted and stored as met; old resolved rows read Met); each button confirms in its own words.
10 | Coaching.gs | The weekly run sends, per department with NEW flags, the manager-format email to the ADMINS (subject "[Held for admins] ...", naming the managers it will reach); a failed held send is counted in the outcome, never thrown. previewCoachingManagerEmail sends the current version to the requesting admin (throttled). coachingManagerRecipients_ is the one function release changes.

TEST RESULTS: passed -- node --test 2594 tests, 2593 pass, 0 fail, 1 skipped; lint:gas clean; INV-16 clean; module-deps regenerated; drive-notify 26/26; 7/7 bites land (manager clamp, the missed-floor direction, flags under the applied gates, admins-only recipients, the resolved alias, the held send in the weekly run, the empty-save refusal); the EmailKit steps bug (string steps rendered empty) was caught by the preview test and fixed before commit.
REGRESSION RISKS:
  - Admins now receive one extra email per department with new flags each week (held manager emails) -- by design, counted in the run outcome.
  - New closes store met / rotated; anything reading coaching_flags.status for 'resolved' would miss them (nothing in the repo does; the worklist maps both).
  - notifyRulesFor_ now lists every reachable dept (not only those with an alert rule); the alert fields are null where there is no rule.
INVARIANTS AT RISK: INV-01 (a new admin config write + the manager layer's coaching fields; documented). INV-53 / INV-26 untouched (the gates feed computeCoachingFlags_, whose population rules are unchanged).
NET SCORE: 0 production fixes - 0 new failure modes = 0 (owner-requested feature)

OPERATOR ACTIONS / DEPLOY:
- None to deploy. Optional: set per-department gates in Admin > Coaching. Release (later): change coachingManagerRecipients_ to the managers, swap the coaching gates' assertAdmin_ per the F-e note | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- 5c (two new alert reasons) remains.
- The worklist itself is still admin-only (owner ruling); manager access to it is a release step, not built here.

DOCUMENTATION UPDATES NEEDED:
- None beyond those in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
