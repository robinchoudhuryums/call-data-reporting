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
- **Public write paths are admin-only and live in `OrphanFix.gs` only.**
  Every other public-callable function is read-only; helpers that
  touch spreadsheet state end in `_` so Apps Script blocks them
  from RPC. Belt-and-suspenders against the "Execute as: Me" model
  letting any visitor reach through Robin's permissions. The
  carve-out for `OrphanFix.gs` is admin-gated (`assertAdmin_()`
  first), input-validated (no queue-sentinel names, length cap,
  must-be-on-some-roster for the canonical destination), serialized
  via `LockService`, and every action is audited to the
  `Orphan Fix Log` sheet. **Do not add new public write functions
  outside `OrphanFix.gs` without the same four mitigations.**
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
  `loadRosterCanonicalNames_` in the pipeline. Admin-curated
  overrides in the `Agent Alias Overrides` sheet (see INV-46) take
  precedence over both the paren-strip and the exact-roster match;
  the dashboard's Orphan Fix modal writes there. Aliases with
  `Active=FALSE` are skipped by the pipeline.
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
  fails. The chrome layer also writes `dash-mode` (light/dark toggle)
  and `dash-theme.v1` (warm / cool / clinical paper theme) — the
  theme picker re-reads these on every render so no cache bump is
  needed when palette tokens change.
- **CacheService key length cap (250 chars).** Apps Script silently
  rejects cache keys longer than 250 characters, surfacing as an
  error on `cache.get`. The Individual / Performance / Compare
  Ranges reports include the selected agent list in their cache
  key, which overflows on big rosters (Sales is the canonical
  trigger). `Data.gs::hashAgents_` MD5-hashes the sorted agent
  list to a 32-char hex digest so the compound key stays bounded
  regardless of selection size. Never concatenate raw agent names
  into a cache key — always go through `hashAgents_`.
- **Chart.js v4 + chartjs-plugin-datalabels needs explicit
  registration.** v4 dropped the auto-register-on-script-tag
  behavior the plugin relied on, and the plugin itself defaults
  to `display: false` since v1.0.0. Both `Chart.register(ChartDataLabels)`
  AND `Chart.defaults.plugins.datalabels.display = true` must run at
  module load (see the `registerChartDataLabels_` IIFE in
  script.html). Per-chart `display: false` (Missed Calls radar,
  Overview multi-line trend) still wins via the normal options
  override. Use the boolean form for `display`; the function form
  (`display: function (ctx) {...}`) returned false unpredictably on
  mixed bar+line charts in this plugin version.
- **OKLCH colors break datalabels silently.** Modern browsers
  resolve `var(--paper)` etc. to `oklch(...)` strings, which
  chartjs-plugin-datalabels can't parse for `fillStyle` — labels
  render with an empty fill (invisible). `refreshChartTheme()` in
  script.html paints each CSS custom property onto a 1×1 canvas via
  `colorToCanvasRgb_()` and reads back the canonical `rgba(...)` form
  so the plugin always receives a parseable color. Don't pass raw
  `getComputedStyle(...).getPropertyValue('--foo')` strings to chart
  options — always go through `THEME.*`.
- **Recently-active denominator.** The Overview tile caption "X of Y
  agents" uses `recentlyActiveCount` (any rung / answered / missed
  activity in the last `OVERVIEW_RECENT_ACTIVE_DAYS` = 30 days), NOT
  full roster size. Ex-employees who are kept on the `DO NOT EDIT!`
  sheet for historical-data preservation fall out of this count
  naturally. The hover tooltip on the caption shows all three
  numbers (today's active, recent active, full roster) so the
  denominator choice is transparent.
- **Apps Script projects share one global scope across all .gs
  files.** Multiple top-level `function onOpen()` (or any other
  same-named global) declarations silently override each other --
  the last-loaded file's definition wins. If a project needs more
  than one menu, build them all from one `onOpen` (see
  `cdr-report/CDR Tools menu.js` calling `installDQEDrilldownMenu_`).
  The same pattern bit the cdr-report project before the F14 fix.
- **`<?!= JSON.stringify(x) ?>` is not script-tag safe.** Apps
  Script's force-print scriptlet doesn't HTML-escape, and
  `JSON.stringify` does not escape `</script>` inside string
  values. Do the escape SERVER-SIDE in `.gs` so the troublesome
  pattern never appears in the `.html` template file -- not even
  in comments. The HTML parser closes a `<script>` block on the
  literal end-of-script-tag pattern wherever it appears
  (including inside JS line comments inside the same script
  block, which is how an earlier inline-replace bug bit us).
  Canonical pattern: `tmpl.userJson = JSON.stringify(obj).replace(/</g, '\\u003c')`
  in `Code.gs::renderDashboard_`, then `window.__USER__ = <?!= userJson ?>;`
  in `dashboard.html`.
- **`ADMIN_EMAILS` is resolved at request time.** Membership checks
  and admin recipient lookups go through `Config.gs::getAdminEmails_()`,
  which reads the `ADMIN_EMAILS` Script Property (comma-separated
  emails) on every call and falls back to the `ADMIN_EMAILS_FALLBACK`
  constant if unset. Adding an admin is a Script Property edit; no
  redeploy. **Never read the `ADMIN_EMAILS` constant directly for
  membership checks** -- always go through `getAdminEmails_()` so the
  Script Property's value wins.
- **Alert Log captures every outcome of every run** -- `sent`,
  `would-send`, `above-threshold`, `no-data`, `no-recipients`,
  `skipped`, `error`. Preview rows (from the modal's **Preview**
  button) are marked by a `preview:` prefix on the Triggered By
  column and use the `would-send` status (real fires use `sent`).
  Filter on `triggeredBy NOT LIKE 'preview:%'` to scope to real
  runs. The `Sent` boolean is `TRUE` only for `sent` outcomes.
- **Header freshness pill goes orange past 36h.** The "Data through
  Mon May 19 · 14h ago" badge in `.header-meta` computes hours
  since end-of-day on the most recent date in `DQE Historical Data`
  (via `getLatestDataDate`); past 36h it adds the `.is-stale` class
  and tints warm orange. Tunable in `setFreshnessPill_` if 36h
  becomes too noisy. Pill is hidden until the server returns the
  latest date so the header doesn't show a stale fallback.

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
  (`summary:`, `latestDate:`, `individual:`, `individual_active:`,
  `performance:`, `compareRanges:`, `missed:`, `companyOverview:`);
  bump the relevant version on any aggregation-rule change. See INV-30
  for current versions.
- **Scope toggle (`roster | queue | both`)**: managers can see strictly
  their roster, anyone who handled their queue extensions, or the union.
  Default is `roster` (matches the legacy DQE Report's behavior).
- **DQE Report Legacy is FROZEN and the migration is COMPLETE.** All four
  legacy reports (Individual / Performance / Compare Ranges / Missed
  Calls) plus the Low Answer Rate Alerts engine are in the dashboard.
  Awaiting decommission of the spreadsheet; meanwhile accepts only
  cleanup deletions.
- **Two-page architecture: Overview + My Department.** The dashboard
  is one HTML doc with two top-level `<section>` pages toggled by
  `body[data-page="overview|dept"]`. **Overview is the default
  landing** for every page load; "My Department" is the per-dept
  agent table view that used to be the landing. Modals (Help,
  Settings, Missed Calls, Individual / Performance / Compare
  Ranges, Alerts) overlay either page. Admin clicks on Overview
  dept tiles route to the dept page via `setPage('dept')` + a
  dept-selector swap.
- **Overview-only sub-queue nesting.** `OVERVIEW_PARENT_OF` and
  `OVERVIEW_HIDDEN_DEPTS` in CompanyOverview.gs shape the Overview
  page only — dept dropdowns, Reports modals, and Alerts treat
  every dept as independent. Adding a sub-queue means: (1) it
  already appears as its own dept everywhere else (it's a real
  column in `DO NOT EDIT!`), and (2) add a row to
  `OVERVIEW_PARENT_OF` keyed on the column-header text
  byte-for-byte. The hero block shows parent + all its children
  together when the viewer is a parent, so the relationship stays
  visible even when the parent is spotlighted.
- **Company aggregate is admin-only via `personalizeOverview_`.**
  `getCompanyOverview()` always computes the company-wide
  aggregate and caches it inside the shared blob, but
  `personalizeOverview_` strips the `companyAggregate` field on
  serve for non-admins. Viewer-personalized fields (`viewerRole`,
  `viewerDept`) are injected per-request so a payload warmed by
  user A still personalizes correctly for user B.

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
6. After pulling new code that adds sheets, was `setup()` re-run? It
   creates `Access Control`, `Alert Config`, `Alert Log`,
   `Pipeline Health`, `Digest Config`, `Agent Alias Overrides`, and
   `Orphan Fix Log` -- whichever are missing. Idempotent on re-runs
   (existing data untouched). Without re-running setup() after a
   fresh pull, downstream writers (Pipeline Health appends, Digest
   config reads, Orphan Fix log appends) silently no-op against
   the missing sheet, and the Orphan Fix modal will throw "sheet
   missing -- run setup()" on first write.
7. For alerts: is the `DASHBOARD_URL` Script Property set? Without it,
   alert emails still send — they just omit the "Open Dashboard" link.
8. Are all three trigger types installed? Three independent triggers
   now feed the dashboard's freshness, and each one missing is a
   silent failure:
   - **Daily alerts**: dashboard project → Triggers should list
     `runDailyAlerts_` (or install via the Alerts modal). Without
     it, alerts only fire when an admin clicks "Send alerts".
   - **Daily DQE build** (CDR Report project, INV-44 prerequisite):
     editor → Triggers should list `runDailyDQEBuild_` (or install
     via CDR Tools → ⏰ Daily DQE Build Trigger → Install). Without
     it, DQE Historical Data goes stale and the dashboard silently
     serves yesterday's data.
   - **Daily + weekly digests**: dashboard project → Triggers should
     list both `runDailyDigests_` and `runWeeklyDigests_` (or install
     via Alerts modal → Manager Digest Subscribers → Install). Without
     them, Digest Config rows have no effect.
9. Did the latest push add a new OAuth scope? Open the Apps Script
   editor → Run → any function → grant the new permission. Scope-
   gated calls (trigger install, mail send) otherwise throw
   permission errors at runtime even though the dashboard page
   loads fine.
10. After adding a sub-queue to `OVERVIEW_PARENT_OF`, verify the
    key matches the `DO NOT EDIT!` column header byte-for-byte
    (case, spaces, and any ` Q` suffix). Mismatches show up as a
    `Logger.log` warning in the project's Stackdriver / execution
    log on every `getCompanyOverview` call; the sub-queue still
    renders as an unrelated top-level dept until the key is
    fixed. Use both spellings as aliases if you're unsure.
11. Pipeline Health sheet: open the dashboard's Alerts modal →
    Pipeline Health section. A long quiet stretch on `autoImport`
    or `buildDQE` (rows from 2+ days ago and nothing since) means
    the daily ingest or DQE rebuild hasn't run. Cross-check with
    Operator State #1 + #8. An empty sheet right after deploy
    means setup() hasn't been re-run on this project.
12. Manager digest delivery: if a subscriber says they didn't get
    their digest, check (a) Digest Config row Active=TRUE,
    (b) Cadence is `daily` or `weekly` (normalized -- other values
    are dropped), (c) digest triggers installed (#8), (d) admin
    inbox for a `notifyDigestFailure_` email if the run threw.
13. `ADMIN_EMAILS` Script Property: if a recently-added admin
    doesn't see admin-only features, verify Project Settings →
    Script Properties → `ADMIN_EMAILS` includes their email
    (comma-separated). Without the property, `getAdminEmails_()`
    falls back to `ADMIN_EMAILS_FALLBACK` in Config.gs (which
    requires a redeploy to change).

## Cycle Workflow Config

### Test Command
manual

### Health Dimensions
Data Accuracy (DQE), Access Control Integrity, Source Pipeline Reliability, Migration Progress, Cross-Project Consistency, Documentation Freshness, Performance & Cache Effectiveness, Error Surfacing & Observability, Manager-Facing UI Polish, Deployment Hygiene, Code Health

### Subsystems
Department Dashboard:
  apps-script/department-dashboard/Auth.gs, apps-script/department-dashboard/Code.gs, apps-script/department-dashboard/Config.gs, apps-script/department-dashboard/Data.gs, apps-script/department-dashboard/Diagnostics.gs, apps-script/department-dashboard/Setup.gs, apps-script/department-dashboard/MissedCallsReport.gs, apps-script/department-dashboard/IndividualReport.gs, apps-script/department-dashboard/PerformanceReport.gs, apps-script/department-dashboard/CompareRangesReport.gs, apps-script/department-dashboard/Alerts.gs, apps-script/department-dashboard/CompanyOverview.gs, apps-script/department-dashboard/Digest.gs, apps-script/department-dashboard/OrphanFix.gs, apps-script/department-dashboard/QCDReport.gs, apps-script/department-dashboard/access_denied.html, apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script.html, apps-script/department-dashboard/styles.html, apps-script/department-dashboard/appsscript.json

CDR DQE Pipeline:
  apps-script/cdr-report/buildDQEHistoricalData.js, apps-script/cdr-report/DQEdrilldown.js, apps-script/cdr-report/DQEDrilldownSidebar.html, apps-script/cdr-report/dataFilters.js, apps-script/cdr-report/CDR Tools menu.js, apps-script/cdr-report/appsscript.json

CDR Reporting Tools:
  apps-script/cdr-report/dashboardCDR.js, apps-script/cdr-report/dbHistorical.js, apps-script/cdr-report/dbReporting.js, apps-script/cdr-report/emailDailyReport.js, apps-script/cdr-report/neonbackfill.js, apps-script/cdr-report/neonWrite.js

CDR Import:
  apps-script/cdr-import/AbandonedFilter.js, apps-script/cdr-import/CDR Tools.js, apps-script/cdr-import/DeleteOldSheets.js, apps-script/cdr-import/autoImport.js, apps-script/cdr-import/importBulkCSVsFromDrive.js, apps-script/cdr-import/neonWrite.js, apps-script/cdr-import/appsscript.json

DQE Report Legacy:
  apps-script/dqe-report/DQEdashboard.js, apps-script/dqe-report/FAQGuide.html, apps-script/dqe-report/IndividualReport.js, apps-script/dqe-report/IndividualReportModal.html, apps-script/dqe-report/MissedCallsReport.js, apps-script/dqe-report/MissedReportModal.html, apps-script/dqe-report/MultiCompModal.html, apps-script/dqe-report/MultiComparisonTool.js, apps-script/dqe-report/SingleRangeReport.js, apps-script/dqe-report/SingleReportModal.html, apps-script/dqe-report/menu DQE Tools.js, apps-script/dqe-report/sendManualAlert.js, apps-script/dqe-report/showFAQ.js, apps-script/dqe-report/appsscript.json

### Invariant Library
INV-01 | No public function (callable via google.script.run) writes to any spreadsheet EXCEPT the admin-only write path in `OrphanFix.gs` (`addAgentAlias`, `removeAgentAlias`, `applyOrphanRename`). Every other write-capable helper ends in `_` so Apps Script blocks it from RPC. The OrphanFix carve-out is gated by `assertAdmin_()` first, input-validated (queue-sentinel names rejected, length-capped, canonical destination must be on some roster), serialized by `LockService`, and audited to the `Orphan Fix Log` sheet. No new public write functions may be added outside `OrphanFix.gs` without the same four mitigations. | Subsystem: Department Dashboard
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
INV-24 | buildDQEHistoricalData canonicalizes raw CDR agent names against the DO NOT EDIT! roster on every build: if the paren-stripped form of an incoming name matches exactly one roster entry, the row is written under that roster name. Ambiguous (>1 match) or unknown (0 match) names are written as-is. Admin-curated alias overrides (INV-46) are loaded by the same `loadRosterCanonicalNames_` and take precedence over the paren-strip; the dashboard's Orphan Fix modal is the canonical writer. Soft coupling: pipeline depends on the dashboard's roster sheet schema. Edits to roster layout must keep `loadRosterCanonicalNames_` working. | Subsystem: CDR DQE Pipeline
INV-25 | The Individual Report and Performance Report compute ATT as weighted by Answered (`sum(att * answered) / sum(answered)`), NOT the simple-mean used by the main dashboard table (INV-05). Days with answered=0 contribute 0 to both numerator and denominator, so unanswered/abandoned days don't drag the ATT down. Intentional — matches each legacy report's source semantics. | Subsystem: Department Dashboard
INV-26 | TEAM_AVG_EXCLUDES in Config.gs lists per-dept agent names removed from BOTH numerator and denominator of the Individual Report's team-average. Used for managers on the roster who take only a token number of calls (current entry: 'CSR': ['Robin Choudhury']). Match is exact on the roster name. Does NOT apply to the Performance Report, which treats the user's selection AS the team. | Subsystem: Department Dashboard
INV-27 | Individual Report's team-avg denominator counts only roster members with ANY call activity (rung/answered/missed > 0) in the selected range, NOT the full roster size. Zero-call roster members don't dilute the average. | Subsystem: Department Dashboard
INV-28 | Performance Report's prior period is the immediately-preceding window of the same duration (durationDays before currentStart, ending one day before currentStart) -- NOT "previous calendar month". Documented in the form's inline hint and the results-header "Comparing against..." line. Match legacy SingleRangeReport semantics. | Subsystem: Department Dashboard
INV-29 | Individual Report's monthly trend window: range itself when selected range > 366 days OR equals a full calendar year (Jan 1 - Dec 31 of one year); else `first-of-month(end - 12 months)` to `end`. Performance Report uses identical logic so the 12-mo trends align across both reports for the same dept. | Subsystem: Department Dashboard
INV-30 | Each report has its own versioned cache key prefix; bump on any aggregation rule change so stale entries don't bleed in. Current: `summary:v5` (Data.gs), `latestDate:v1` (Data.gs — most-recent ISO date with data; drives the dashboard's default From/To), `individual:v6` (IndividualReport.gs), `individual_active:v1` (active-agents-in-range subset used by Individual + Performance + Compare Ranges pickers), `performance:v3` (PerformanceReport.gs), `compareRanges:v3` (CompareRangesReport.gs), `companyOverview:v10` (CompanyOverview.gs), `qcd:v2` (QCDReport.gs). Alerts.gs holds no cached compute. | Subsystem: Department Dashboard
INV-31 | `script.send_mail` OAuth scope in appsscript.json is required for: (1) Individual / Performance / Compare Ranges / QCD "Email image" exports, (2) the Low Answer Rate Alerts engine, (3) the Manager Digest engine (Digest.gs), (4) the failure-notification paths (notifyImportFailure_ in autoImport.js, runDailyDQEBuild_ in buildDQEHistoricalData.js, notifyDigestFailure_ in Digest.gs). All eight paths use `MailApp.sendEmail`. Removing the scope breaks every one of them; adding new send-mail features here doesn't need a re-scope. | Subsystem: Department Dashboard (+ CDR Import / CDR DQE Pipeline for the notify-failure paths)
INV-32 | Low Answer Rate Alerts is admin-only at the server boundary. Every public callable in Alerts.gs starts with `assertAdmin_`. The launcher button is also hidden client-side via `data-admin-only`, but the server check is the source of truth. Compare Ranges was previously admin-only too but was opened to managers (with the same `dept !== user.department` check the other reports use) so they can run year-over-year comparisons within their own dept. Adding a new admin = setting/editing the `ADMIN_EMAILS` Script Property (comma-separated emails); falls back to `ADMIN_EMAILS_FALLBACK` in Config.gs if unset. | Subsystem: Department Dashboard
INV-33 | `runDailyAlerts_` (time-triggered alerts) skips Saturdays and Sundays. Holiday handling is intentionally not built in -- if it becomes noise in practice, add a skip-dates column to the Alert Config sheet rather than hardcoding in Alerts.gs. Manual sends via the UI ignore this skip. | Subsystem: Department Dashboard
INV-34 | `Alert Config` columns: Department \| Threshold % \| Extra Recipients \| Active \| Notes. `Alert Log` columns: Timestamp \| Department \| Date Checked \| Threshold % \| Answer Rate % \| Sent \| Recipients \| Triggered By \| Notes \| Status. Both sheets idempotently created by setup(); never overwritten. Alerts.gs's `readAlertConfig_` and `appendAlertLog_` depend on these schemas. | Subsystem: Department Dashboard
INV-35 | Compare Ranges flags `meta.lengthMismatch=true` when the longer of the two periods is at least 1.2x the shorter (`Math.max(p1Days,p2Days) / Math.min(...) >= 1.2`). The flag drives the form's warning hint, the results-page banner, KPI per-day captions, and CSV per-day columns. Tunable threshold in `computeCompareRanges_`. | Subsystem: Department Dashboard
INV-36 | Cache keys that embed agent selections must hash via `Data.gs::hashAgents_` (MD5 hex, 32 chars, order-insensitive). Apps Script CacheService silently rejects keys > 250 chars; raw-joined agent lists overflow on big rosters like Sales and surface as report-generation errors. IR / PR / CR all use the hash; future report code that caches per agent-selection must follow suit. | Subsystem: Department Dashboard
INV-37 | The dashboard is a two-page web app toggled via `body[data-page="overview"|"dept"]`. Default landing is `overview` (set inline on the body tag so the right page paints before JS runs). `setPage(name)` swaps the page, updates the header kicker+h1, and (for `overview`) triggers a fresh `getCompanyOverview()` fetch. `refresh()` only writes the dept name into `#page-title` when the dept page is active, so swapping dept on Overview doesn't clobber "Departments Snapshot". | Subsystem: Department Dashboard
INV-38 | `OVERVIEW_PARENT_OF` (CompanyOverview.gs) defines sub-queue parent-child relationships for the Overview tile grid ONLY. The dept dropdown, all Reports modals, and Alerts treat each dept as independent. Keys must match the `DO NOT EDIT!` column header byte-for-byte; aliases (e.g. both `PAP` and `PAP Q` mapping to Sales) are tolerated. `OVERVIEW_HIDDEN_DEPTS` excludes depts from the Overview only (e.g. `CSR Backup`). | Subsystem: Department Dashboard
INV-39 | `companyAggregate` in the Overview payload is admin-only via `personalizeOverview_`: the full blob (including aggregate) is cached for everyone, but the aggregate field is stripped on serve for non-admins. `personalizeOverview_` deep-clones via JSON round-trip so any future personalize step that mutates nested fields can't leak across viewers. Viewer-personalized fields `viewerRole` and `viewerDept` are injected per-request, never cached — so a payload warmed by user A still personalizes correctly for user B. Adding a new admin-only Overview field means stripping it inside `personalizeOverview_`. | Subsystem: Department Dashboard
INV-40 | Overview "X of Y agents" caption denominator is `recentlyActiveCount` = any rung/answered/missed activity in the last `OVERVIEW_RECENT_ACTIVE_DAYS` (=30) days, NOT full roster size. Filters out ex-employees who are kept on the `DO NOT EDIT!` sheet for historical-data preservation. Hover tooltip exposes today-active / recent-active / full-roster numbers so the choice is transparent. Same logic powers the company aggregate's Active count. | Subsystem: Department Dashboard
INV-41 | chartjs-plugin-datalabels requires `Chart.register(ChartDataLabels)` AND `Chart.defaults.plugins.datalabels.display = true` at module load (the `registerChartDataLabels_` IIFE in script.html does both). Chart.js v4 dropped script-tag auto-registration; the plugin defaults to display=false since v1.0.0. Per-chart `display: false` overrides still suppress labels (Missed Calls radar, Overview multi-line trend). Use the boolean form of `display` per chart — the function form returns false unpredictably on mixed bar+line charts in this plugin version. | Subsystem: Department Dashboard
INV-42 | `refreshChartTheme()` (script.html) resolves every CSS custom property via `colorToCanvasRgb_()` — paints onto a 1×1 canvas and reads back canonical `rgba(...)`. Required because chartjs-plugin-datalabels' `fillStyle` path can't parse `oklch(...)` strings → silently renders empty fills (invisible labels). Never pass raw `getComputedStyle(...).getPropertyValue('--token')` to chart options; always go through `THEME.*`. Hook is re-run on dark-mode toggle so newly-rendered charts pick up the inverted palette. | Subsystem: Department Dashboard
INV-43 | Default From/To on the My Department page snaps to the most-recent ISO date present in DQE Historical Data, via `Data.gs::getLatestDataDate()` (cached under `latestDate:v1`). Falls back to today on failure. Replaces the legacy "current-month-to-date" default so the table isn't empty when a manager opens the dashboard before today's ingest has run. | Subsystem: Department Dashboard
INV-44 | `Pipeline Health` sheet columns: `Timestamp \| Step \| Status \| Rows \| Duration (ms) \| Notes`. Schema pinned in `Config.gs::PIPELINE_HEALTH_HEADERS`; sheet is idempotently created by `setup()`. Append-only; never overwritten. Writers are `logPipelineHealth_` helpers in `apps-script/cdr-import/autoImport.js` and `apps-script/cdr-report/buildDQEHistoricalData.js` (cross-project; each owns its own copy of the helper). All writes are best-effort -- a logging failure must never block or fail the pipeline. Reader is `Alerts.gs::readPipelineHealth_(maxRows)`; UI surfaces the last 20 entries in the Alerts modal. Step values are free-form (currently `autoImport`, `buildDQE`); Status is `success` or `failure`. | Subsystem: Department Dashboard (+ CDR Import / CDR DQE Pipeline for the writers)
INV-45 | `Digest Config` sheet columns: `Email \| Department \| Cadence \| Active \| Notes`. Schema pinned in `Config.gs::DIGEST_CONFIG_HEADERS`; sheet is idempotently created by `setup()`. Cadence is `daily` (sends each weekday morning for the previous day's data; weekends skipped) or `weekly` (sends Monday 8 AM for the prior Mon-Fri window). `Digest.gs` is the engine; every public callable (`getDigestsInit`, `sendPreviewDigest`, `installDigestTriggers`, `uninstallDigestTriggers`) starts with `assertAdmin_`. Trigger entry points (`runDailyDigests_`, `runWeeklyDigests_`) end in `_` so `google.script.run` can't reach them but ScriptApp dispatch still calls them by name. Trigger lifecycle is managed via the Alerts modal's "Manager Digest Subscribers" section. | Subsystem: Department Dashboard
INV-46 | `Agent Alias Overrides` sheet columns: `Old Name \| Canonical Name \| Active \| Added By \| Added At \| Notes`. Schema pinned in `Config.gs::AGENT_ALIAS_OVERRIDES_HEADERS`; sheet is idempotently created by `setup()`. Soft-coupling across two Apps Script projects: the dashboard's `OrphanFix.gs` writes rows here; the CDR Report project's `buildDQEHistoricalData.js::loadRosterCanonicalNames_` reads them on every build and folds them into the canonicalization map. The pipeline-side check is best-effort (missing/empty sheet leaves the build's behavior unchanged) so an unsynced cdr-report deploy doesn't break the dashboard's UI. Aliases with `Active=FALSE` are skipped by the pipeline. | Subsystem: Department Dashboard + CDR DQE Pipeline
INV-47 | `Orphan Fix Log` sheet columns: `Timestamp \| Admin \| Action \| From Name \| To Name \| Affected Rows \| Notes`. Schema pinned in `Config.gs::ORPHAN_FIX_LOG_HEADERS`; sheet is idempotently created by `setup()`. Append-only; never overwritten. `OrphanFix.gs::appendOrphanFixLog_` writes one row per action. Action values: `alias-add`, `alias-remove`, `rename`, `rename+alias`. Affected Rows is the count of DQE Historical Data rows modified by a `rename` (0 for alias-only actions). | Subsystem: Department Dashboard
INV-48 | `dept.wow.driver` on the Overview payload ("what changed" insight) is attached only when `|dept.wow.deltaPct| >= WOW_DRIVER_THRESHOLD` (= 1.5 pts). The driver is the per-agent net answered/missed change that most explains the dept's WoW shift, picked by `computeWowDriver_` in CompanyOverview.gs. Requires at least 3 events in either week-window to avoid one-call outliers; positive WoW surfaces the biggest answered-delta, negative WoW surfaces the biggest missed-delta. `dept.wow.driver` may be null for low-activity / quiet-week depts; the client (`ovBuildWowDriver_`) renders nothing in that case. Per-dept (not admin-only) -- managers see drivers for their own dept; admins see them for all depts. | Subsystem: Department Dashboard
INV-49 | `getIndividualReport` accepts optional `priorFrom`/`priorTo` for same-agent vs-self comparison. When supplied, every `summaryData[i]` carries `priorStats` (formatted) + `priorRaw` (numeric); `priorDateLabel` is set at the top level. Absence = legacy shape (`priorStats: null`). The cache key (`individual:v6`) adds a `priorKey` segment (`priorFrom..priorTo` or `none`) so the prior window is part of the cache identity. Client form (`ir-compare-mode` select) supports None / Same window one year prior / Immediately-preceding period / Custom prior range; resolved via `irResolvePriorRange_`. The same prior dates are re-applied automatically when the user re-runs from the edit-popover. | Subsystem: Department Dashboard
INV-50 | `QCD Historical Data` columns (1-indexed): `Month Year \| Week \| Date \| Call Queue \| Call Source \| Total Calls \| Total Answered \| Abandoned \| Longest Wait \| Avg Answer \| Abandoned % \| Violations`. Pinned in `Config.gs::QCD_HISTORICAL_COLS`. Writer: `apps-script/cdr-import/autoImport.js::processIntegratedHistory` QCD block. Reader: `apps-script/department-dashboard/QCDReport.gs` (dept-scoped report) + `CompanyOverview.gs::computeQcdSnapshots_` (per-dept latest-day snapshot on the Overview tile grid) + `Data.gs::computeDeptQcdSnapshot_` (per-dept latest-day snapshot for My Department's "Yesterday's QCD" tiles). **`Call Queue` carries raw queue names like `A_Q_CSR` / `Backup CSR` -- NOT dashboard dept names.** To map a dept to its set of queue names, use `Config.gs::DEPT_QCD_QUEUES` (admin-curated). `Call Source` is one of `Total Calls` (daily roll-up; the only source the dashboard sums to avoid double-counting) plus sub-source breakdowns like `CSR` / `Ad-campaign` / `New Call Menu` / `Non-CSR (internal)` that the dashboard skips. `Violations` is the count of (source, day) tuples where Abandoned % > 5%. | Subsystem: Department Dashboard + CDR Import
INV-51 | `QCD Report` is per-dept gated like Individual / Performance / Compare Ranges -- managers see their own dept, admins pick any. `getQcdReport({ department, from, to })` returns `meta` (with `queues` + `unmapped` flags), `dateLabel`, `totals` (sum across the dept's mapped queues), `queueBreakdown` (per-queue rows, one entry per queue in `DEPT_QCD_QUEUES[dept]`), `trendData` (12-month monthly buckets rolled up across all dept queues, matching the IR/PR trend window logic). Cache prefix `qcd:v2`. **The Overview page's per-dept tile shows two QCD chips: an "Aban N (P%)" chip whenever QCD data exists (warn-tinted when P>=5%), and a "X viol MTD" chip when month-to-date violations > 0.** My Department page's agent table is followed by a "Yesterday's QCD" tile row (Total Calls / Answered / Abandoned / Abandoned % / Violations) sourced from `Data.gs::computeDeptQcdSnapshot_`. All QCD UI surfaces are visible to everyone (no admin gate); per-dept gating is on the dropdown only. | Subsystem: Department Dashboard
INV-52 | `CDR Historical Data` columns (1-indexed): `Month Year \| Week \| Date \| Dept \| Name \| C..W` (22 metric cols). `Q Path Historical Data` columns: `Month Year \| Week \| Date \| Dept \| Path \| Total \| VM \| NonVM \| Opt1 \| NonOpt1 \| Pct`. `CSR Transfer Historical Data` columns: `Month Year \| Week \| Date \| Agent \| Trans % \| Total Calls \| Transferred \| + 11 per-queue cols`. Writers: `apps-script/cdr-import/autoImport.js::processIntegratedHistory`; each block emits a separate `processIntegratedHistory:CDR` / `:QPath` / `:CSR` row to Pipeline Health (INV-44). NOT consumed by the dashboard today -- the read path lives in the legacy DQE Report Apps Script. | Subsystem: CDR Import (writer) / DQE Report Legacy (reader) |

### Policy Configuration
Policy threshold: 6/10
Consecutive cycles: 2

### Regression Scenarios
S1 | Manager loads own-dept dashboard | Subsystem: Department Dashboard
  Steps:
    - Manager opens the deployed web app URL.
    - Confirm the page lands on Overview ("Departments Snapshot" kicker + h1); the email + blue "manager" tag appear in the header.
    - Click "My Department" in the header nav.
    - Confirm header h1 swaps to the manager's dept name; From/To both default to the latest ISO date in DQE Historical Data; agent table populates within 3 seconds.
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

S17 | Compare Ranges is per-dept gated | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard as a manager (non-admin).
    - Confirm the "Compare Ranges" button is visible in the Reports menu.
    - Run a Compare Ranges report for the manager's own dept; confirm it loads.
    - Attempt to call `getCompareRanges` with a different dept name via the browser console.
  Expected: own-dept call succeeds; cross-dept call throws "Not authorized for this department." on the server. Admins can pick any dept that exists in the dept list.

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

S22 | setup() creates all dashboard-managed sheets idempotently | Subsystem: Department Dashboard
  Steps:
    - In a fresh spreadsheet without any of those sheets, run setup() once.
    - Run setup() again.
  Expected: first run creates Access Control + Alert Config + Alert Log + Pipeline Health + Digest Config + Agent Alias Overrides + Orphan Fix Log (each with their header row + frozen first row); second run logs "already exists, skipping" for all seven -- no data overwritten on either run. New columns added in a later code change to an existing sheet are NOT applied by setup() -- the sheet's existence short-circuits ensureSheet_.

S23 | Overview is the default landing + tile click routes admins | Subsystem: Department Dashboard
  Steps:
    - Open the deployed URL (admin or manager).
    - Confirm Overview page loads first; header h1 is "Departments Snapshot"; the Overview button has the inverted (active) styling.
    - As admin: click any dept tile in the grid.
  Expected: page swaps to My Department; header h1 becomes that dept's name; dept-selector reflects the clicked dept; agent table renders for the latest ISO date.

S24 | Sub-queue nests under parent hero on Overview | Subsystem: Department Dashboard
  Steps:
    - As admin: pick Sales from the dept-selector and return to Overview (or open Overview with Sales already selected).
    - Inspect the user-hero block.
  Expected: Sales renders as the big hero tile; PAP appears as an indented child tile directly underneath (accent-tinted background + ↳ glyph + "sub-queue · Sales" tag). PAP does NOT additionally appear as a standalone tile in the grid below. Same expectation for CSR (with Spanish nested) and Power (with PAK nested).

S25 | Company aggregate visibility is admin-only | Subsystem: Department Dashboard
  Steps:
    - Open Overview as a manager (non-admin).
    - Open Overview as an admin.
  Expected: manager sees the dept grid + 30-day trend chart but no "Company snapshot · admin only" hero; admin sees that hero at the top with rung/answered/missed/ATT/active counts + a 30-day company-wide sparkline.

S26 | Big-roster reports complete without cache-key error | Subsystem: Department Dashboard
  Steps:
    - As admin: open Individual Report for Sales (or any dept with > 12 agents).
    - Select all active agents; pick a 30-day range; Generate.
    - Repeat for Performance Report and Compare Ranges with the same selection.
  Expected: all three reports return data without "Argument too large" or similar cache errors. The MD5 hash in the cache key (`hashAgents_`) keeps the compound key bounded regardless of roster size; second Generate of the same selection comes back as a cache hit.

S27 | Compare Ranges is per-dept gated for managers | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard as a manager (non-admin).
    - Confirm the "Compare Ranges" button is visible in the Reports menu (no longer admin-only after INV-32 update).
    - Generate a Compare Ranges report for the manager's own dept; confirm it loads.
    - In the browser console, attempt `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.error).getCompareRanges({ department: 'SomeOtherDept', ...})`.
  Expected: own-dept Generate succeeds; cross-dept console call throws "Not authorized for this department.". Admin users can request any dept that exists in the dept list (same gate as Individual / Performance).

S28 | Pipeline Health logs autoImport + buildDQE outcomes | Subsystem: Department Dashboard + CDR Import + CDR DQE Pipeline
  Steps:
    - Trigger a successful daily import (or run processNewImport manually).
    - Trigger a successful DQE build (or run testDQEBuild / runDailyDQEBuild_).
    - Open the dashboard as admin -> Alerts modal -> Pipeline Health section.
  Expected: most recent rows show a `success` entry for `autoImport` (with the imported sheet name in Notes and a row count) followed by `buildDQE` (with `callDate=YYYY-MM-DD` in Notes). For a forced failure (rename "Raw Data" sheet temporarily), the entry shows status `failure` with the exception message in Notes. Logging is best-effort -- a missing Pipeline Health sheet must not break the pipeline.

S29 | Manager Digest install + preview flow | Subsystem: Department Dashboard
  Steps:
    - As admin: open Alerts modal -> Manager Digest Subscribers section.
    - Confirm Digest Config rows render (or "no subscribers yet" empty state).
    - Click Install digest triggers; trigger status caption switches to "Daily + weekly triggers are installed."
    - In the Apps Script editor's Triggers panel, confirm both `runDailyDigests_` and `runWeeklyDigests_` are present.
    - From the browser console: `google.script.run.withSuccessHandler(console.log).sendPreviewDigest({ department: 'CSR', cadence: 'daily', email: 'someone@universalmedsupply.com' })`.
    - Click Uninstall digest triggers; confirm both triggers removed.
  Expected: install/uninstall succeed; preview digest arrives in the admin's inbox (not the supplied `email`, which is shown only as "what would the subscriber see"); preview email body has a yellow "Preview only" banner.

S30 | Header freshness pill renders and goes stale | Subsystem: Department Dashboard
  Steps:
    - Open the dashboard fresh (any role). The freshness pill in `.header-meta` is hidden initially.
    - After `getLatestDataDate` returns, the pill renders "Data through <weekday short> · <Nh ago>".
    - If the latest date is more than 36h old (e.g. nothing ingested Friday + today is Sunday), the pill picks up the `.is-stale` class and tints warm orange.
    - Hover the pill; the title attribute explains what it represents.
  Expected: pill is hidden on fetch failure or empty data; visible and color-coded otherwise. Updates only on page load -- not live.

S31 | Orphan Fix end-to-end (admin) | Subsystem: Department Dashboard + CDR DQE Pipeline
  Steps:
    - As admin, open the dashboard. Admin menu -> Orphan Fix.
    - Confirm the modal lists orphan agent names from DQE Historical Data (or "no orphans" if everyone canonicalizes cleanly).
    - For one orphan, pick a canonical roster name from the dropdown; click Apply; confirm the prompt.
    - Server returns the rename count; the orphan row disappears from the list on refresh; "Current aliases" gains a new row with Active=Yes; "Recent fix log" gains a `rename+alias` entry.
    - Open the CDR Report spreadsheet -> DQE Historical Data; confirm the Agent Name column for the affected rows now shows the canonical name.
    - As a non-admin manager, in the browser console: `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.error).applyOrphanRename({fromName:'X', toName:'Y'})`.
    - Expected: non-admin call throws "Alerts are admin-only." (the assertAdmin_ guard); admin Apply succeeds; renamed rows appear in subsequent dashboard reports after the 5-min cache TTL; the next daily DQE build does not re-introduce the orphan because the alias is honored by loadRosterCanonicalNames_.
    - Negative test: try renaming to a name not on any dept's roster (e.g. "Garbage Name"); expected: "X is not on any dept roster..." error.
    - Negative test: try renaming a queue-sentinel ("A_Q_CSR") as fromName or toName; expected: "Queue-sentinel names cannot be renamed..." error.

S32 | QCD Report end-to-end | Subsystem: Department Dashboard + CDR Import
  Steps:
    - Open dashboard as a manager. Reports → QCD Report.
    - Pick a date range with known QCD activity for the manager's dept; Generate.
    - Confirm KPI tiles render Total Calls / Answered / Abandoned / Abandoned % / Longest Wait / Avg Answer / Violations (Violations tile is warn-soft when >0).
    - Confirm per-queue breakdown table shows one row per queue in `DEPT_QCD_QUEUES[dept]` with a "Department total" row in the tfoot.
    - Switch the chart-tab metric (Total Calls / Abandoned % / Violations); chart re-renders with appropriate axis formatting.
    - Re-open the dashboard fresh and check the Overview tile for a dept with violations or elevated abandoned %; a small QCD flag caption appears next to the WoW chip (red if violations > 0, muted if just elevated %). Visible to managers + admins.
    - As a manager, in the browser console: `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.error).getQcdReport({ department: 'SomeOtherDept', from: '2026-05-01', to: '2026-05-19' })`.
  Expected: own-dept Generate succeeds; cross-dept console call throws "Not authorized for this department.". Admin users can request any dept that exists in the dept list. Cache prefix `qcd:v2` keys are bounded (no agent-list dimension, so no MD5 hashing needed). The breakdown table shows one row per queue in `DEPT_QCD_QUEUES[dept]` plus a "Department total" row in the tfoot. The dept tile on Overview shows "Aban N (P%)" always (warn-tinted when P>=5%) plus "X viol MTD" when month-to-date violations > 0. My Department page renders a "Yesterday's QCD" tile row below the agent table.

S33 | Pipeline Health per-output rows | Subsystem: CDR Import + Department Dashboard
  Steps:
    - Trigger a successful daily import via `processNewImport` (manual run or onChange).
    - Open the dashboard as admin → Alerts modal → Pipeline Health section.
  Expected: most recent rows include separate entries for `processIntegratedHistory:CDR`, `:QPath`, `:QCD`, `:CSR` (one per output type that produced > 0 rows), each with status `success`, a row count, and the dateObj.toDateString() in Notes. If any output block fails mid-`processIntegratedHistory`, the outer `autoImport` row will still log a `failure` (and the per-output rows for steps that already succeeded remain). Best-effort: a missing Pipeline Health sheet does not block any output.

### Frozen Subsystems
- DQE Report Legacy — manager-facing reports in `apps-script/dqe-report/`. Frozen because migration to Department Dashboard is complete: Individual Report, Performance Report, Compare Ranges, Missed Calls Report, and Low Answer Rate Alerts all live in the dashboard. Replacement: Department Dashboard. Awaiting decommission of the legacy spreadsheet. Unfreeze only if a bug is found in legacy that affects production decisions before the spreadsheet is retired.

### Deploy Command
Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy
CDR DQE Pipeline: `cd apps-script/cdr-report && clasp push -f`
CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (same Apps Script project as CDR DQE Pipeline)
CDR Import: `cd apps-script/cdr-import && clasp push -f`
DQE Report Legacy: `cd apps-script/dqe-report && clasp push -f` (frozen — cleanup deploys only)
