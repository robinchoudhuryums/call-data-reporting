---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (owner requests 2026-10-21, not scan findings):
  - DC-D1  Direct Calls report: a window ending on a not-yet-imported day summed it as a quiet day (the owner's 10/20 run); a window with a missing workday compared its prior with a whole one; the "Last 30 days" label disagreed with its default dates; the unavailable copy named only Neon. Now: clamped to the last data day + said so + the End date corrected, missing workdays listed (company-wide; weekends / holidays never), vs-prior chips withheld on a gap, never cached when clamped / gappy; the default dates follow the preset; copy fixed. directCall:v5.
New capabilities (G/ST): None from a scan. Owner-requested features:
  - DC-D1b  The internal / external split on every Direct count (screen, KPI tiles, CSV)
  - DC-D0   diagnoseDirectCallCounting (cdr-import, read-only, Operator State #80): sizes the suspected Direct counting gaps before any re-import (an opt-in diagnose pass inside the engine)
  - DC-D3   Team Direct Calls side card on My Department (admin trial, lazy, the report's own endpoint)
  - DBT-1   Day-bar target line, option 2 (% Ans + Abandoned %, fitted scale, off-scale tag)
  - LAYB-1  Agent table layout B (an IN line over an OUT line per agent, one bar scale, per-line sorts)
  - OBMIX-1 probeOutboundCallMix (dashboard, read-only, Operator State #79): company line / colleague / inbound twin / misdial / redial / external, with sample call ids
  - D2 (the Direct capture fixes) is NOT built: it waits on the owner's D0 run (each fix needs a re-import)
Files modified:
  apps-script/department-dashboard/DirectCallReport.gs (dcMissingWorkdays_, dcHolidayFn_, dcCoverage_, dcApplyCoverageMeta_; the coverage read; clamped SQL windows; split columns; directCallSplit_; sheet fallback coverage; cache guard; v5)
  apps-script/department-dashboard/OutboundReport.gs (OB_MIX_*; obMixBucket_, obMixSummarize_, obMixAgentList_, probeOutboundCallMix)
  apps-script/department-dashboard/Config.gs (PROP_REGISTRY_: OUTBOUND_MIX_AGENTS 'tool')
  apps-script/department-dashboard/script-5-dept.html (DTS_METRICS_ .t targets; dtsScale_; target line / off tag; obThPairHtml_, obPairCells_, shared unit, inRung sort, sort handler on [data-ob-sort]; TDC_ / tdcSync_ / tdcFetch_ / tdcRender_ / tdcOpenReport_)
  apps-script/department-dashboard/script-9-inbound-direct.html (default dates via datePresetRange_; directCallCoverageNote_; directSplitHtml_ / directSplitText_; split CSV columns + coverage lines; comment fix)
  apps-script/department-dashboard/dashboard.html (Direct form hint + unavailable copy; #dept-team-direct card)
  apps-script/department-dashboard/styles.html (.dts-plot / .dts-target / .dts-target-off; layout B .ob-line / .ob-pair / .ob-sort-pick; .dc-split; .dtd-fold)
  apps-script/cdr-import/directCallMetrics.js (opts.diagnose counters + dcDiagSummary_; ev.root; dcBuildExtMaps_ allExtToAgent; diagnoseDirectCallCounting)
  tests/unit: day-bars (+4, one tightened), outbound-call-mix (new, 5), outbound-report (anchored-window pin 4 -> 5), direct-call-report (+6 + coverage fake + SQL pin), direct-fallback (coverage fake, split fixture, sheet-read counter), direct-call-metrics (+3), client-dead-ends (UD-6 hint count 3 -> 4), cross-file-pins (direct-call-modal leaves DRIVER_MODAL_EXEMPT)
  tools/ui-harness: gen-payloads (direct-30d / direct-all-clean / direct-meta from the REAL getDirectCallReport), build-harness (getDirectCallReport mock), drive-admin (Direct Calls modal + probe, +7), drive-deptoutbound (layout B +5, D3 +6, manager +1), drive-daybars (+2), README
  docs: client-ui-conventions (layout B, day-bar target, Team Direct Calls), per-call-capture (Direct D1/D0/D3), regression-scenarios (S57, S62, S67 new), operator-state (#79, #80), invariants / architecture / known-issues / conventions / direct-extension design (directCall:v5), fix-history (6 rows), next-steps (row), module-dependencies (regenerated), tests/README, CLAUDE.md (S67, #79, #80 index lines)

CHANGES:
DC-D1 | DirectCallReport.gs, script-9, dashboard.html | Coverage read first ({mx, days} from the unclamped prior start to the asked end); dcCoverage_ clamps to mx, lists missing workdays in both windows (holidays read once per request), drops kpisPrior / deptsPrior on a gap; the main SQL reads the clamped window; meta carries requestedTo / to / clampedTo / dataThrough / missingDates / missingCount / priorMissingCount / priorSuppressed / noDataInRange; a clamped or gappy payload is not cached. The sheet fallback derives the same from its own dates. Client: a status note, the End date moved back (preset -> Custom), no chips on a gap.
DC-D1b | same | kpis.split + agents[].split ({int, ext} for ib answered / missed free / missed busy, ob total / connected); sub-lines under each count; CSV columns.
DC-D0 | directCallMetrics.js | Diagnose counters on the build's own pass (rows unchanged with it on -- pinned); the editor tool reads Raw Data + the roster, logs counter / share / top agents / sample ids; writes nothing.
DC-D3 | script-5, dashboard.html, styles | A collapsed <details> under Team Outbound; opens -> one getDirectCallReport for (dept, page window); key-cached; tiles + agent table + note; a button opens the modal on the same dept + dates and runs it. data-admin-only + tdcActive_.
DBT-1 | script-5, styles | dtsScale_ (pure): reach = max(2 x spread, 5); in reach -> fitted scale incl. the target + a dashed line in .dts-plot; out of reach -> days-only scale + an axis tag. Standards: answerStdFor_(dept).target, ABANDON_STANDARD_.
LAYB-1 | script-5, styles | Both table: one <tr> per agent, 5 cells (agent, IN/OUT tags, Calls, Rate, Talk), each metric an .ob-line.ob-dir-in over .ob-line.ob-dir-out; inUnit = obUnit = max; header pick buttons sort by inRung / answerRate / tttSeconds or obTotal / obConnectRate / obTalkSec.
OBMIX-1 | OutboundReport.gs, Config.gs | Two metered reads ('outbound-mix'): distinct inbound dial-in numbers (90 days) hashed with the capture's HMAC + DIAL_IN_LABELS; the agents' calls with prev-gap (lag) and an inbound-twin EXISTS (±120 s). First-match buckets; samples; anchored window like the other four outbound tools.

TEST RESULTS: passed -- node --test 2633 tests, 2632 pass, 0 fail, 1 skipped (one pre-existing skip); lint:gas clean; INV-16 clean; module-deps --check clean (regenerated); ci:ui full gate green on the final code (rc=0, all 15 stages; drive-smoke 176/176, drive-admin 123/123, drive-deptoutbound 41/41, drive-daybars 24/24). Bites: 14 unit + 8 rendered = 22 land. Three first-round misses were fixed by tightening the pin, never by loosening it: the in-reach target scale (the fixture's target sat inside the days' range -- an equivalent mutant until a just-above case was added), the split columns in the Direct SQL (the fake connection ignores SQL -- now a source pin on the query), and the out-sort (the first mutation removed the button the driver clicks, so the driver crashed rather than reporting; re-bitten on the sort itself). Test doubles updated as part of the change: the Direct fakes route the new coverage read; the fallback's Neon fixture carries the split; its "never touches the sheet" counter now counts the Direct sheet only (the healthy path reads the holiday sheet since D1).
REGRESSION RISKS:
  - DC-D1: every uncached Direct request is now TWO Neon round trips (coverage + main), and a window with a permanent gap (a capture outage day) is never cached, so it reads Neon on every run. Admin-only; noted.
  - DC-D1: the healthy Neon path now reads the Company Holidays sheet once per request (getCompanyHolidayRanges_); a failed read falls back to weekends-only gaps (holidays may then be listed as missing).
  - DC-D1: the client moves the user's End date back when clamped -- deliberate (the owner asked for a correction), and announced in the note.
  - LAYB-1: rows are taller (two lines); the column count changed (6 -> 5), so anything that counted cells in #agents-ob-tbody had to move (only drive-deptoutbound did).
  - DC-D3: an ⓘ inside a <summary> toggles the fold when clicked (its tooltip still shows on hover / focus).
  - OBMIX-1: up to 8000 rows with their journeys in one read -- a few MB of Neon egress per run (editor-run, rare).
INVARIANTS AT RISK: INV-30 (directCall v4 -> v5; every current-truth doc moved; cache-version-sync green). INV-06 (the Direct form copy states 8:30-5:00 CST = the engine's 6:30-15:00 PST; no window constant changed). INV-28 (the prior window is computePriorWindow_ of the CLAMPED window -- the rule, applied to what is shown). INV-01 (no writes: both new tools read only). INV-39 / the vetting gates (Direct stays admin-only server-side; the card is data-admin-only + admin-checked). INV-16 (directCallMetrics.js is cdr-import-only, not a duplicated file). INV-03 (the all-extension parse takes digit-only tokens after the first comma). None violated.
NET SCORE: 1 production fix (DC-D1 -- the owner hit it on 10/20) − 1 new failure mode (DC-D1's per-request cost: a second round trip, and no caching for a permanently gappy window) = 0. DBT-1, LAYB-1, DC-D3, OBMIX-1, DC-D0, DC-D1b are new capabilities.

OPERATOR ACTIONS / DEPLOY:
- Run `diagnoseDirectCallCounting` (cdr-import editor) after an import on 3-4 different days and report the shares -- D2 is scoped from them | BLOCKS DEPLOY: N
- Optional: set `OUTBOUND_MIX_AGENTS` and run `probeOutboundCallMix` (dashboard editor); needs `HMAC_SECRET` on the dashboard for the company-line bucket | BLOCKS DEPLOY: N
Deploy:
  Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)
  CDR Import: `scripts/deploy.sh apps-script/cdr-import` (or `cd apps-script/cdr-import && clasp push -f`)
Walk S57, S62, S67.

(Not complete in production until the deploy steps are confirmed.)

FOLLOW-ON ITEMS:
- D2: the Direct capture fixes (Internal-direction dials credited as ob_int, every roster extension, same-root dedup, anonymous callers kept, a third "unrostered extension" bucket) -- each needs the affected dates re-imported; scope from D0's shares.
- Outbound: if probeOutboundCallMix shows a material company-line / colleague share, a capture-side exclusion (or a labelled bucket) is the follow-up -- an owner ruling first.
- The unreachable Outbound-only table rendering (Step 3) is still inert code; layout B makes the 'out' branch even less likely to return.
- Release questions stay the owner's: the Direct report (one-line gate), the brief / day bars / layout B / Team Direct Calls (admin trials).

DOCUMENTATION UPDATES NEEDED:
- None beyond those in these commits.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
