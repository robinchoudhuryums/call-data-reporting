---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (P7 is new capability from the owner's follow-up plan of 2026-11-13)
New capabilities (G/ST): P7 -- partial days, core. A day an agent was on the phones for only part of it is marked by an admin and counts as its share (0, 0.25, 0.5, 0.75) in the divisor of the per-day figures; nothing else changes. Owner rule A ("pace while present") and picks 1-7 confirmed 2026-11-16.
Files modified:
  apps-script/department-dashboard/PartialDays.gs (new), Config.gs, Setup.gs, Util.gs, Data.gs, OutboundReport.gs, AgentHome.gs, agentApp.html, dashboard.html, script-1-core.html, script-2-chrome.html, script-4-nav.html, script-5-dept.html, script-7-admin.html, styles.html
  tests/unit/partial-days.test.js (new), setup.test.js, outbound-fallback.test.js, cache-version-sync.test.js, client-correctness.test.js, keyboard-focus.test.js
  tools/ui-harness/gen-payloads.js, build-harness.js, drive-admin.js, drive-deptoutbound.js, README.md
  CLAUDE.md, README.md, docs/operator-state.md, docs/invariants.md, docs/regression-scenarios.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/known-issues.md, docs/module-dependencies.md, tests/README.md

CHANGES:
P7 | Config.gs, Setup.gs | `SHEETS.PARTIAL_DAYS` ('Partial Days'), its header (`Date | Agent | Credit | Reason | Added By | Added At`), the fixed credit list (0 / 0.25 / 0.5 / 0.75), the fixed reason list (Partial shift, Training, Meeting, Leave, Other) and the one-credited-day floor. `setup()` creates the sheet with a plain-text Date column (fourteen managed sheets).
P7 | PartialDays.gs (new) | The admin editor's server side: `getPartialDaysInit`, `savePartialDay`, `removePartialDay`. Admin gate, validation (ISO date not in the future, an agent on some roster by exact name, a credit and a reason from the two lists), the script lock, one row per (date, agent), `sheetSafeCell_`, an Added By / At stamp, a usage row that names the date and the credit but not the reason, and a cache bust on every write. The save creates the sheet if `setup()` has not been re-run.
P7 | Util.gs | The list reader (per-execution memo + a 5-minute cache; a failed read is not cached and reads as no marks), `partialDayCredit_`, `creditedDays_`, `perCreditedDay_` (null below one credited day), `partialMarkedDatesIn_`, and `partialDaysTag_` folded into `reportFreshnessTag_` -- empty with no marks (every key unchanged), else a hash of date / agent / credit, so a mark re-keys every cached report and the reason is not part of any key.
P7 | Data.gs | `computeSummary_` rows: `ansPerDay` over credited days, plus `daysCredited`, `partialDays`, `partialMarks` (`[iso, credit]`, never the reason). The team pair's agent-days and the combined view's crossover subtraction use credited days (`rowCreditedDays_`, falling back to active days for a row cached before the field). Counts, totals and rates are computed exactly as before.
P7 | OutboundReport.gs | Outbound "/ day": when the window holds marks the per-agent query also returns which marked dates the agent placed a call on (the SQL text is unchanged otherwise); the sheet twin returns the same. Rows carry `obDaysCredited` / `obPartialDays`; `obPerDay` is null below one credited day; the team per-agent-day divisor is credited.
P7 | AgentHome.gs, agentApp.html | The agent app carries the agent's OWN credited days and partial count (no dated marks, no reason, no teammate's) and shows the attendance line when they have a partial day.
P7 | dashboard.html, script-4-nav, script-2-chrome, script-7-admin, styles.html | Admin > Partial days: date, department (to narrow the list), agent, share and reason -- all pickers, no free text; the marks listed with Remove (asks first, danger tone).
P7 | script-1-core, script-5-dept, styles.html | The attendance line ("19.75 of 22 workdays, 2 partial", marked dates and shares on hover) under the inbound "ans/day" and the outbound "/ day" on every My Department view, and a dash with the line when the agent has less than one credited day. A row with no mark renders byte-identically.
P7 | docs | Operator State #94 (the rule, who sees what, six things to know, and the planned matching change for the CSR team app -- written, not built), INV-01 (new admin carve-out), INV-12 (fourteen sheets), scenario S73, client conventions, fix-history, the coverage map, the harness README.

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 3,102 pass / 0 fail (14 new in partial-days.test.js); `npm run lint:gas` clean; the INV-16 guard and the module-map check clean; `npm run ci:ui` all 18 driver runs passed (drive-admin walks the editor; drive-deptoutbound checks the row line as a manager). Bite-checks: 11 of 11 bite (the credit in the divisor, the dash, the reason out of the cache tag, teammates credited, the crossover subtraction, outbound credit, the sheet twin's marked days, no dated marks in the agent app, setup creating the sheet, and both editor write gates). The first run of the editor-gate check did NOT bite: each verb ends by returning the admin-gated init, so the test passed with the verb's own gate removed; the test now proves a refused save or remove wrote nothing, and both gates bite.
REGRESSION RISKS:
- `summary` rows gain three fields and the team pair's agent-days can now be fractional (2 dp). Every consumer found reads them through the per-day helpers; with no marks every value is identical to before.
- No cache version was bumped: the marks join the freshness tag, and a row cached before the field falls back to its active days. A cached payload from before the deploy has no `daysCredited` -- same figures as before, no attendance line -- until its key moves.
- A single-day window on a marked day shows a dash for that agent's pace (less than one credited day). By the confirmed rule; the line beside it says why.
- If the Partial Days sheet cannot be read, that run treats every day as whole (no last-good copy, unlike exception days). The uncredited payload is stored under the no-marks key, so it is not served once the read recovers.
INVARIANTS AT RISK: None broken. INV-01 gains an admin-gated carve-out (documented in the same commit); INV-12 is now fourteen sheets (pinned by setup.test.js); INV-04 exact-name matching is what the credit lookup uses; INV-30: a new registered prefix `partialDays:v1`, no report version bump (the tag suffix pattern); INV-39 / agent privacy: the reason is in no report payload and the agent app gets no dated marks (pinned); INV-53: floaters and team-average excludes stay out of the team pair as before.
NET SCORE: 0 production fixes − 1 new failure mode (a failed sheet read falls back to whole days for that run) = −1

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (push + new version). | BLOCKS DEPLOY: N
- Re-run `setup()` once to create the `Partial Days` sheet (optional -- the editor's first save creates it). | BLOCKS DEPLOY: N
- Walk S73 after the deploy, then `runLiveSmoke`. | BLOCKS DEPLOY: N
- The CSR team app (team-tools): make the matching change described in Operator State #94 when convenient; until then its per-day pace, if it shows one, counts a partial day as whole. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor -> Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- P8: apply partial days in the Individual Report and the Insights comparisons (not done here by scope).
- P9: suggest likely partial days to the admin.
- team-tools: the matching change is planned in #94, not built (separate repo).
- A failed Partial Days read has no last-good copy; exception days keep one. Worth matching if the sheet is ever seen to fail.
- The agent app's attendance line has no rendered check (the harness agent has no marks); it is covered at the payload only.
- The My Department CSV exports the credited ans/day with no attendance column.
- Outbound's partial count only counts marks on days the agent placed a call, so the inbound and outbound lines on one row can show different counts.
- A hand-edited sheet row naming an agent no longer on a roster has no effect and is not flagged anywhere (the editor only offers roster names).

DOCUMENTATION UPDATES NEEDED:
- None -- written in this session (Operator State #94, INV-01, INV-12, S73, client conventions, fix-history, coverage map, harness README, README).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
