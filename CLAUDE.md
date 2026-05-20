# CLAUDE.md

Project-level guidance for Claude (and any new engineer) working in this repo.
Pair with the longer docs in [`docs/`](docs/) for full context.

## What this project is

A multi-spreadsheet Google Apps Script stack that ingests call detail records
(CDR) from a telephony provider, aggregates them into per-agent per-day
metrics ("DQE"), and serves them to ~14 department managers via a web app.
The **Department Dashboard** web app has replaced the legacy DQE Report
spreadsheet (migration complete: 4 reports + low-answer-rate alerts ported);
legacy `apps-script/dqe-report/` is kept frozen for reference until the
spreadsheet is decommissioned.

- **Owner / admin**: Robin Choudhury (`robin.choudhury@universalmedsupply.com`)
- **Domain**: Universal Med Supply (Google Workspace)
- **Lifecycle**: active development; small internal user base (<20)

## Read first

For deeper context, in priority order:

- [`docs/architecture.md`](docs/architecture.md) — data flow across CDR
  Import, CDR Report, Department Dashboard, Neon Postgres. Read this first
  when chasing a bug to figure out which layer is involved.
- [`docs/known-issues.md`](docs/known-issues.md) — institutional memory.
  Fixed bugs, design rules, drift risks. Read before changing the source
  pipeline or the dashboard's data layer.
- [`docs/conventions.md`](docs/conventions.md) — time windows, aggregation
  rules, naming conventions, scope semantics.
- [`README.md`](README.md) — clasp setup + deploy flow.

## Key commands

```bash
# Department Dashboard (web app) deploy
clasp push -f                                # from repo root
# Then in the Apps Script editor:
# Deploy → Manage deployments → pencil → Version: New version → Deploy

# Sibling project deploys
cd apps-script/cdr-report  && clasp push -f
cd apps-script/cdr-import  && clasp push -f
cd apps-script/dqe-report  && clasp push -f   # frozen — cleanup deploys only

# No tests. Verification is manual deploy + smoke-test against
# Regression Scenarios in the Cycle Workflow Config below.
```

## Common Gotchas

A few things that have bitten us repeatedly. See `docs/known-issues.md` for full detail.

- **Spreadsheet TZ ≠ script TZ**. The CDR Report spreadsheet is on
  `America/Mexico_City`; the script is on `America/Chicago`. Duration cells
  (TTT, ATT, AvgAbdWait, CSRAvgAbdWait) get a phantom +36:36 offset if you
  read them via `getValue()`. **Always use `getDisplayValues()`** for those
  columns and parse the H:MM:SS string directly.
- **`clasp push -f` does NOT delete remote files** that are absent locally.
  Removing files from an Apps Script project requires manual deletion in
  the web editor.
- **No write paths via `google.script.run`**. Every public-callable
  function must be read-only. Helpers that touch spreadsheet state end in
  `_` — Apps Script blocks trailing-underscore names from RPC. Belt-and-
  suspenders against the "Execute as: Me" model letting any visitor reach
  through Robin's permissions.
- **Roster cells embed extensions**: `DO NOT EDIT!` cells follow
  `"Name, ext1, ext2"`. Take everything before the first comma as the name;
  digit-only tokens after are queue extensions.
- **Agent-name match at the dashboard layer is exact** — no case folding,
  no whitespace normalization. The pipeline canonicalizes paren variants
  to roster names before writing, so downstream code can rely on exact
  match against the roster.
- **Pipeline canonicalizes paren variants via the roster.**
  `buildDQEHistoricalData` reads `DO NOT EDIT!` at the start of every
  build; if an incoming CDR row's agent name's paren-stripped form
  matches exactly one roster entry, the pipeline rewrites it to the
  canonical roster form (so "Roman Robin Paulose" becomes
  "Roman (Robin) Paulose"). Ambiguous (>1 match) and unknown (0
  matches) names are written as-is. Soft coupling: the pipeline now
  depends on the dashboard's roster sheet schema — see
  `loadRosterCanonicalNames_` in the pipeline.
- **ATT semantics differ between the main dashboard and the per-agent
  reports.** Main dashboard table uses the SIMPLE MEAN of stored per-row
  ATT values (INV-05); the Individual, Performance, and Compare Ranges
  reports use a WEIGHTED average (`sum(att * answered) / sum(answered)`)
  so days where the agent didn't answer any calls don't drag the ATT
  down. Intentional — matches the legacy reports they migrated from.
- **`TEAM_AVG_EXCLUDES` in `Config.gs`** lists per-dept agent names to
  subtract from BOTH numerator and denominator of the Individual
  Report's team-average. Used for managers who are on the roster but
  take only a token number of calls (currently
  `'CSR': ['Robin Choudhury']`). Match is exact on the roster name.
- **Performance Report prior period = same duration ending one day
  before current start**, NOT "previous calendar month". A 31-day
  current window compares against the immediately-preceding 31 days.
  Surfaced in the form's inline hint + the results header so the
  comparison basis is visible to users.
- **`neonWrite.js` is duplicated** between `apps-script/cdr-report/` and
  `apps-script/cdr-import/`. Currently byte-identical. Any change to one
  is a two-file edit; `diff` before editing.
- **Per-report client prefs in localStorage.** Each report persists its
  own form state under `cdr.ir.prefs.v1`, `cdr.pr.prefs.v1`, and
  `cdr.cr.prefs.v1`. Bump the trailing version when the prefs schema
  changes; older saved blobs are silently dropped if JSON parsing
  fails.

## Key Design Decisions

- **Web app deploys as "Execute as: Me"** with **"Access: Anyone within
  domain"**. The script runs with the deployer's spreadsheet permissions,
  so managers never get direct access to CDR Report. Read-only safety
  relies on the trailing-underscore convention plus auth re-resolution
  inside every public function.
- **`SPREADSHEET_ID` lives in Script Properties**, not in code. Lets dev
  and prod copies of the dashboard run from the same source without
  edits.
- **Per-project gitignored `.clasp.json`**. Each developer keeps their own
  `scriptId` locally; pulls never conflict on it. Template at
  `.clasp.example.json`.
- **CacheService tiers**: 5 min on aggregated dashboard responses, 60 sec
  on auth lookups. Each report file owns its own versioned cache prefix
  (`summary:`, `individual:`, `individual_active:`, `performance:`,
  `compareRanges:`); bump the relevant version on any aggregation-rule
  change. See INV-30 for current versions.
- **Scope toggle (`roster | queue | both`)**: managers can see strictly
  their roster, anyone who handled their queue extensions, or the union.
  Default is `roster` (matches the legacy DQE Report's behavior).
- **DQE Report Legacy is FROZEN and the migration is COMPLETE.** All four
  legacy reports (Individual / Performance / Compare Ranges / Missed
  Calls) plus the Low Answer Rate Alerts engine are in the dashboard.
  Awaiting decommission of the spreadsheet; meanwhile accepts only
  cleanup deletions.

## Operator State Checklist

When something looks wrong, before assuming a code bug, check:

1. Did the daily ingest run? Verify the latest date in `DQE Historical Data` (CDR Report sheet).
2. Did the dashboard's deployed version include the latest code? Apps
   Script editor → Deploy → Manage deployments → check the timestamp.
3. Did the user actually have access? `Access Control` sheet rows are
   case-sensitive on email.
4. Is the cache stale? Bump the relevant per-report prefix (see INV-30)
   or wait 5 min.
5. Did the source-pipeline bugs (window inclusion / ATT denominator / leg
   attribution — see `known-issues.md`) get re-introduced? Spot-check Sonia
   2026-03-09: TTT should be `0:15:03`, ATT should be `0:03:01`.
6. After pulling the Alerts code, was `setup()` re-run? It now creates
   `Alert Config` + `Alert Log` alongside `Access Control` and is
   idempotent on re-runs (existing data untouched).
7. For alerts: is the `DASHBOARD_URL` Script Property set? Without it,
   alert emails still send — they just omit the "Open Dashboard" link.
8. For alerts: is the daily trigger installed? Apps Script editor →
   Triggers should list `runDailyAlerts_` (or use the "Install daily
   trigger" button in the Alerts modal). Without it, alerts only fire
   when an admin clicks "Send alerts" manually.

## Cycle Workflow Config

### Test Command
manual

### Health Dimensions
Data Accuracy (DQE), Access Control Integrity, Source Pipeline Reliability, Migration Progress, Cross-Project Consistency, Documentation Freshness, Performance & Cache Effectiveness, Error Surfacing & Observability, Manager-Facing UI Polish, Deployment Hygiene, Code Health

### Subsystems
Department Dashboard:
  apps-script/department-dashboard/Auth.gs, apps-script/department-dashboard/Code.gs, apps-script/department-dashboard/Config.gs, apps-script/department-dashboard/Data.gs, apps-script/department-dashboard/Diagnostics.gs, apps-script/department-dashboard/Setup.gs, apps-script/department-dashboard/MissedCallsReport.gs, apps-script/department-dashboard/IndividualReport.gs, apps-script/department-dashboard/PerformanceReport.gs, apps-script/department-dashboard/CompareRangesReport.gs, apps-script/department-dashboard/Alerts.gs, apps-script/department-dashboard/access_denied.html, apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script.html, apps-script/department-dashboard/styles.html, apps-script/department-dashboard/appsscript.json

CDR DQE Pipeline:
  apps-script/cdr-report/buildDQEHistoricalData.js, apps-script/cdr-report/DQEdrilldown.js, apps-script/cdr-report/DQEDrilldownSidebar.html, apps-script/cdr-report/dataFilters.js, apps-script/cdr-report/CDR Tools menu.js, apps-script/cdr-report/appsscript.json

CDR Reporting Tools:
  apps-script/cdr-report/dashboardCDR.js, apps-script/cdr-report/dbHistorical.js, apps-script/cdr-report/dbReporting.js, apps-script/cdr-report/emailDailyReport.js, apps-script/cdr-report/neonbackfill.js, apps-script/cdr-report/neonWrite.js

CDR Import:
  apps-script/cdr-import/AbandonedFilter.js, apps-script/cdr-import/CDR Tools.js, apps-script/cdr-import/DeleteOldSheets.js, apps-script/cdr-import/autoImport.js, apps-script/cdr-import/importBulkCSVsFromDrive.js, apps-script/cdr-import/neonWrite.js, apps-script/cdr-import/appsscript.json

DQE Report Legacy:
  apps-script/dqe-report/DQEdashboard.js, apps-script/dqe-report/FAQGuide.html, apps-script/dqe-report/IndividualReport.js, apps-script/dqe-report/IndividualReportModal.html, apps-script/dqe-report/MissedCallsReport.js, apps-script/dqe-report/MissedReportModal.html, apps-script/dqe-report/MultiCompModal.html, apps-script/dqe-report/MultiComparisonTool.js, apps-script/dqe-report/SingleRangeReport.js, apps-script/dqe-report/SingleReportModal.html, apps-script/dqe-report/menu DQE Tools.js, apps-script/dqe-report/sendManualAlert.js, apps-script/dqe-report/showFAQ.js, apps-script/dqe-report/appsscript.json

### Invariant Library
INV-01 | No public function (callable via google.script.run) writes to any spreadsheet; all write-capable helpers end in `_` so Apps Script blocks them from RPC. | Subsystem: Department Dashboard
INV-02 | Duration columns (TTT, ATT, AvgAbdWait, CSRAvgAbdWait) are read via getDisplayValues(), not getValue(), to bypass spreadsheet-vs-script TZ mismatch. | Subsystem: Department Dashboard
INV-03 | DO NOT EDIT! roster cells follow the format "Name, ext1, ext2, …" — name is everything before the first comma; subsequent digit-only tokens are extensions. | Subsystem: Department Dashboard
INV-04 | Agent-name match between DQE Historical Data Col C and DO NOT EDIT! roster cells is exact (case + whitespace sensitive); no alias normalization. | Subsystem: Department Dashboard
INV-05 | Per-agent ATT in the dashboard is the simple mean of per-row stored ATT values, NOT TTT/Answered weighted. Source ATT denominator sometimes ≠ Answered. | Subsystem: Department Dashboard
INV-06 | Work window for TTT/ATT/Missed/Answered is 6:30 AM – 3:00 PM PST (8:30 AM – 5:00 PM CST), hardcoded as DQE_WINDOW_START/DQE_WINDOW_END. | Subsystem: CDR DQE Pipeline
INV-07 | TTT/ATT loop in buildDQEHistoricalData iterates `windowLegs` (in-window subset), not all-day `legs`, to match Answered's denominator. | Subsystem: CDR DQE Pipeline
INV-08 | TTT attribution uses each agent's own leg.talkSec on the parent call via findAgentTalkOnParent, NOT parent.talkSec (max across all legs). | Subsystem: CDR DQE Pipeline
INV-09 | Cache key in Data.gs is versioned (`summary:vN:...`); bump N on any aggregation rule change to invalidate stale caches. | Subsystem: Department Dashboard
INV-10 | HISTORICAL_COLS in department-dashboard/Config.gs must match actual column positions in DQE Historical Data (Date=2, Agent=3, TTT=9, ATT=10, AVG_ABD_WAIT=33, CSR_AVG_ABD_WAIT=34). | Subsystem: Department Dashboard
INV-11 | ROSTER constants pin DO NOT EDIT! layout: HEADER_ROW=1, DATA_START_ROW=2, DEPT_FIRST_COL=6. | Subsystem: Department Dashboard
INV-12 | setup() in Department Dashboard is idempotent — creates Access Control sheet only if missing, never overwrites existing rows. | Subsystem: Department Dashboard
INV-13 | Web app deployment is "Execute as: Me" + "Anyone within domain"; deployer's spreadsheet permissions back the script. | Subsystem: Department Dashboard
INV-14 | SPREADSHEET_ID is read from Script Properties, not hardcoded; missing property = clear error at request time. | Subsystem: Department Dashboard
INV-15 | Per-project .clasp.json files are gitignored at any depth; scriptIds stay out of the repo. | Subsystem: operational/cross-cutting
INV-16 | neonWrite.js is duplicated between cdr-report/ and cdr-import/; must stay byte-identical. Any change requires a two-file edit. | Subsystem: CDR Reporting Tools / CDR Import
INV-17 | `clasp push -f` does NOT delete remote files absent locally; removing files from a project requires manual web-editor deletion. | Subsystem: operational/cross-cutting
INV-18 | Missed Calls Report chart range is 8:00 AM – 5:00 PM CST in 30-minute buckets (18 total). | Subsystem: Department Dashboard
INV-19 | DQE_EXCLUDED_AGENTS allowlist in buildDQEHistoricalData.js is the canonical source for pseudo-agent exclusions; additions go upstream, not downstream. | Subsystem: CDR DQE Pipeline
INV-20 | Time-slot columns K-AC in DQE Historical Data store CST timestamps (already PST→CST converted); downstream code must NOT re-convert. | Subsystem: CDR DQE Pipeline / Department Dashboard
INV-21 | parentMap in buildDQEHistoricalData builds from rows with parentId='N/A' or ''; each parent leg's calleeName must be captured for findAgentTalkOnParent. | Subsystem: CDR DQE Pipeline
INV-22 | DQE Report Legacy is frozen — accepts only deletions and minimal menu cleanups during migration; no new features or improvements. | Subsystem: DQE Report Legacy
INV-23 | Queue-sentinel rows in DQE Historical Data carry queue-only abandoned data (no agent rang). Agent Name (col C) holds a queue identifier (`A_Q_*` or `Backup CSR`); col D holds the queue's extensions; K-AC, AD, AF are populated normally; cols E-J and AG/AH are 0/"0:00:00". Consumers must filter these out by agent-name pattern: the main per-agent dashboard (Data.gs) and Diagnostics (whyNoMatches) skip them; MissedCallsReport.gs reads them specifically for the queue-only section. | Subsystem: CDR DQE Pipeline / Department Dashboard
INV-24 | buildDQEHistoricalData canonicalizes raw CDR agent names against the DO NOT EDIT! roster on every build: if the paren-stripped form of an incoming name matches exactly one roster entry, the row is written under that roster name. Ambiguous (>1 match) or unknown (0 match) names are written as-is. Soft coupling: pipeline depends on the dashboard's roster sheet schema. Edits to roster layout must keep `loadRosterCanonicalNames_` working. | Subsystem: CDR DQE Pipeline
INV-25 | The Individual Report and Performance Report compute ATT as weighted by Answered (`sum(att * answered) / sum(answered)`), NOT the simple-mean used by the main dashboard table (INV-05). Days with answered=0 contribute 0 to both numerator and denominator, so unanswered/abandoned days don't drag the ATT down. Intentional — matches each legacy report's source semantics. | Subsystem: Department Dashboard
INV-26 | TEAM_AVG_EXCLUDES in Config.gs lists per-dept agent names removed from BOTH numerator and denominator of the Individual Report's team-average. Used for managers on the roster who take only a token number of calls (current entry: 'CSR': ['Robin Choudhury']). Match is exact on the roster name. Does NOT apply to the Performance Report, which treats the user's selection AS the team. | Subsystem: Department Dashboard
INV-27 | Individual Report's team-avg denominator counts only roster members with ANY call activity (rung/answered/missed > 0) in the selected range, NOT the full roster size. Zero-call roster members don't dilute the average. | Subsystem: Department Dashboard
INV-28 | Performance Report's prior period is the immediately-preceding window of the same duration (durationDays before currentStart, ending one day before currentStart) -- NOT "previous calendar month". Documented in the form's inline hint and the results-header "Comparing against..." line. Match legacy SingleRangeReport semantics. | Subsystem: Department Dashboard
INV-29 | Individual Report's monthly trend window: range itself when selected range > 366 days OR equals a full calendar year (Jan 1 - Dec 31 of one year); else `first-of-month(end - 12 months)` to `end`. Performance Report uses identical logic so the 12-mo trends align across both reports for the same dept. | Subsystem: Department Dashboard
INV-30 | Each report has its own versioned cache key prefix; bump on any aggregation rule change so stale entries don't bleed in. Current: `summary:v3` (Data.gs), `individual:v4` (IndividualReport.gs), `individual_active:v1` (active-agents-in-range subset used by Individual + Performance + Compare Ranges pickers), `performance:v2` (PerformanceReport.gs), `compareRanges:v2` (CompareRangesReport.gs). Alerts.gs holds no cached compute. | Subsystem: Department Dashboard
INV-31 | `script.send_mail` OAuth scope in appsscript.json is required for the Individual / Performance / Compare Ranges "Email image" exports AND for the Low Answer Rate Alerts engine (MailApp.sendEmail). Removing the scope breaks all four paths; adding new send-mail features here doesn't need a re-scope. | Subsystem: Department Dashboard
INV-32 | Compare Ranges and Low Answer Rate Alerts are admin-only at the server boundary. Every public callable in CompareRangesReport.gs and Alerts.gs starts with an admin role check (`assertAdmin_` in Alerts.gs; inline `user.role !== 'admin'` in CR). The launcher buttons are hidden client-side too, but server checks are the source of truth. Adding a new admin = editing `ADMIN_EMAILS` in Config.gs. | Subsystem: Department Dashboard
INV-33 | `runDailyAlerts_` (time-triggered alerts) skips Saturdays and Sundays. Holiday handling is intentionally not built in -- if it becomes noise in practice, add a skip-dates column to the Alert Config sheet rather than hardcoding in Alerts.gs. Manual sends via the UI ignore this skip. | Subsystem: Department Dashboard
INV-34 | `Alert Config` columns: Department \| Threshold % \| Extra Recipients \| Active \| Notes. `Alert Log` columns: Timestamp \| Department \| Date Checked \| Threshold % \| Answer Rate % \| Sent \| Recipients \| Triggered By \| Notes \| Status. Both sheets idempotently created by setup(); never overwritten. Alerts.gs's `readAlertConfig_` and `appendAlertLog_` depend on these schemas. | Subsystem: Department Dashboard
INV-35 | Compare Ranges flags `meta.lengthMismatch=true` when the longer of the two periods is at least 1.2x the shorter (`Math.max(p1Days,p2Days) / Math.min(...) >= 1.2`). The flag drives the form's warning hint, the results-page banner, KPI per-day captions, and CSV per-day columns. Tunable threshold in `computeCompareRanges_`. | Subsystem: Department Dashboard

### Policy Configuration
Policy threshold: 6/10
Consecutive cycles: 2

### Regression Scenarios
S1 | Manager loads own-dept dashboard | Subsystem: Department Dashboard
  Steps:
    - Manager opens the deployed web app URL.
    - Confirm header shows their dept + email + blue "manager" tag.
    - Confirm From/To default to current-month-to-date; agent table populates within 3 seconds.
    - Confirm scope toggle defaults to "Roster".
  Expected: only that manager's dept agents appear; info-line shows "fresh read" first load, "cache hit" on immediate refresh.

S2 | Admin switches departments | Subsystem: Department Dashboard
  Steps:
    - Admin opens deployed URL.
    - Confirm dept dropdown lists all departments.
    - Switch from default to a different dept.
  Expected: agent table re-fetches and re-renders within 3s; info-line shows "fresh read".

S3 | Unmapped user gets access-denied | Subsystem: Department Dashboard
  Steps:
    - User not in Access Control and not in ADMIN_EMAILS opens the URL.
  Expected: red access-denied card with their email + admin contact + mailto button.

S4 | Missed Calls Report renders for a known date | Subsystem: Department Dashboard
  Steps:
    - Open dashboard for a dept with known missed calls in range.
    - Click "Missed Calls" button.
  Expected: modal opens; 18-bucket bar chart (8 AM-5 PM CST); per-agent cards with timestamps; abandoned ones red + 🚨.

S5 | Daily DQE aggregation completes for a typical day | Subsystem: CDR DQE Pipeline
  Steps:
    - In CDR Report Apps Script, manually run buildDQEHistoricalData for a day's Raw Data.
  Expected: new rows in DQE Historical Data; Neon mirror succeeds; no failure email; per-agent TTT ≈ ATT × Answered (±1s rounding).

S6 | Scope toggle captures queue-only floaters | Subsystem: Department Dashboard
  Steps:
    - Open dashboard for a dept with known floaters.
    - Switch scope to "Queue" or "Both".
  Expected: floaters appear with "(queue-only)" suffix; Diagnostics panel lists them.

S7 | Source pipeline numbers match dashboard | Subsystem: CDR DQE Pipeline → Department Dashboard
  Steps:
    - Verify Sonia 2026-03-09: source TTT/ATT vs dashboard TTT/ATT.
  Expected: 0:15:03 / 0:03:01 on both sides.

S8 | New manager visible within 60s of being added to Access Control | Subsystem: Department Dashboard
  Steps:
    - Add a row (Email | Department | Notes) to Access Control sheet.
    - Have that user open the URL.
  Expected: dashboard loads as manager within 60s (AUTH_CACHE_TTL_SECONDS).

S9 | clasp push from sibling subdir deploys only that project | Subsystem: operational
  Steps:
    - `cd apps-script/cdr-report` → trivial change → `clasp push -f`.
  Expected: only that project receives the change; Department Dashboard unaffected.

S10 | setup() is safely re-runnable | Subsystem: Department Dashboard
  Steps:
    - Run setup() in editor.
    - Run again.
  Expected: first run creates Access Control if missing; second logs "already exists, skipping" — no data overwrite.

S11 | Individual Report renders for one agent with monthly trend | Subsystem: Department Dashboard
  Steps:
    - Open dashboard. Click Individual Report.
    - Pick a single agent + a date range that includes activity.
    - Generate.
  Expected: KPI tiles per agent (with sparklines), insights callout (if rules trigger), three trend charts in tabs (Volume / Efficiency / Duration). 1 agent = "Individual Performance Report" title. Edit-selection popover in the results header re-runs without going back to the form.

S12 | Individual Report peer comparison with shared legend | Subsystem: Department Dashboard
  Steps:
    - Open Individual Report. Pick 2+ agents in the picker.
    - Generate.
  Expected: title flips to "Peer Comparison Report"; shared chip legend renders above the chart tabs; clicking a chip hides that agent's series across all three charts; hovering dims the others.

S13 | Individual Report agent picker active/inactive grouping | Subsystem: Department Dashboard
  Steps:
    - Open Individual Report; pick a date range with known no-data agents.
    - Wait for active set to load (350ms debounce after last date edit).
  Expected: picker splits into "Active in range (N)" and "No activity in range (N)"; inactive items are muted but still pickable; search box filters live across both groups.

S14 | Performance Report current vs prior deltas | Subsystem: Department Dashboard
  Steps:
    - Open Performance Report. Pick the full dept roster + "Last month".
    - Generate.
  Expected: 6 KPI tiles with delta vs the immediately-preceding 30 days; Missed delta colored as orange when above; Rung/Answered/% Answered colored blue when above; TTT/ATT always neutral. "Comparing against..." line + form hint both show the explicit prior dates.

S15 | Pipeline canonicalizes paren-variant agent names | Subsystem: CDR DQE Pipeline
  Steps:
    - In Raw Data, ensure a leg exists with calleeName "Roman Robin Paulose" (no parens) on a date where the roster has "Roman (Robin) Paulose".
    - Run buildDQEHistoricalData for that day.
  Expected: the resulting DQE Historical Data row's Agent Name (col C) is "Roman (Robin) Paulose" -- consolidated under the canonical form. No duplicate rows for the same person on the same day.

S16 | Export menu captures all chart tabs | Subsystem: Department Dashboard
  Steps:
    - Generate any Individual or Performance Report.
    - Without clicking through every chart tab, click Export -> Email image.
  Expected: emailed PNG contains all three chart panels rendered (not blank slots). Same expectation for Copy image and Print.

S17 | Compare Ranges is admin-only | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard as a manager (non-admin).
    - Inspect the Reports row; attempt to call `getCompareRanges` via the browser console.
  Expected: the "Compare Ranges" button is hidden in the UI; direct google.script.run calls throw "Compare Ranges is admin-only" on the server.

S18 | Compare Ranges length-mismatch surfaces per-day | Subsystem: Department Dashboard
  Steps:
    - Open Compare Ranges. Pick P1 = 7 days, P2 = 30 days (or any pair with >= 1.2x ratio).
    - Generate.
  Expected: form shows a "(period 2 is N.Nx longer)" warning hint; results show an orange length-mismatch banner; KPI volume tiles gain a "Per day: X vs Y (P1)" caption; agent cards' P1/P2 cells show "X/day" sublines.

S19 | Compare Ranges custom prior range round-trip | Subsystem: Department Dashboard
  Steps:
    - Open Compare Ranges; set P1 = same month last year and P2 = this month-to-date.
    - Generate, then click "change" in the results header, swap one agent out, Apply.
  Expected: report re-runs in place against the same P1/P2; editing-line updates; the edit-selection popover dismisses; the new agent's card appears.

S20 | Alerts preview + send flow | Subsystem: Department Dashboard
  Steps:
    - Open Alerts (admin only). Pick a date with known low-answer-rate activity.
    - Click Preview; review the table; click Send alerts; confirm the prompt.
  Expected: preview shows "Will alert" badges (red rows) and "Healthy" (green) per dept; Send disabled until preview matches the date; after Send, status flips to "Sent" and the Alert Log table refreshes with new entries.

S21 | Alerts daily trigger install/uninstall | Subsystem: Department Dashboard
  Steps:
    - In the Alerts modal "Daily trigger" section, click "Install daily trigger (8 AM)".
    - Refresh via the Apps Script editor's Triggers panel.
    - Back in the modal, click "Uninstall trigger".
  Expected: status line updates to "Daily trigger is installed... runs at 8:00 CST. Weekends are skipped."; Apps Script editor shows a `runDailyAlerts_` trigger; after uninstall, status line reverts to "No daily trigger installed."

S22 | setup() creates Alert Config + Alert Log idempotently | Subsystem: Department Dashboard
  Steps:
    - In a fresh spreadsheet without those sheets, run setup() once.
    - Run setup() again.
  Expected: first run creates Access Control + Alert Config + Alert Log (each with their header row + frozen first row); second run logs "already exists, skipping" for all three -- no data overwritten.

### Frozen Subsystems
- DQE Report Legacy — manager-facing reports in `apps-script/dqe-report/`. Frozen because migration to Department Dashboard is complete: Individual Report, Performance Report, Compare Ranges, Missed Calls Report, and Low Answer Rate Alerts all live in the dashboard. Replacement: Department Dashboard. Awaiting decommission of the legacy spreadsheet. Unfreeze only if a bug is found in legacy that affects production decisions before the spreadsheet is retired.

### Deploy Command
Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy
CDR DQE Pipeline: `cd apps-script/cdr-report && clasp push -f`
CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (same Apps Script project as CDR DQE Pipeline)
CDR Import: `cd apps-script/cdr-import && clasp push -f`
DQE Report Legacy: `cd apps-script/dqe-report && clasp push -f` (frozen — cleanup deploys only)
