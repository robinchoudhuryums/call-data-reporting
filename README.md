# call-data-reporting

Source of truth for the call-data reporting stack:

- **Department Dashboard** — a Google Apps Script web app that serves
  per-department managers a polished view of their team's DQE call metrics.
  Replaces the legacy `DQE Report` spreadsheet. Two-page UI: the
  **Overview** page (cross-department snapshot, the default landing) and
  the **My Department** page (per-agent detail table with date-range
  controls), toggled via header buttons.
- **Reference copies** of related Apps Script code from sibling projects
  (CDR Report, CDR Import) that the dashboard depends on. Pulled in
  gradually so changes across projects can be reviewed in one place.
- **Architecture docs** describing how data flows from the upstream CDR
  system through Raw Data, DQE Historical Data, and Neon Postgres, into
  the dashboard.

## Read first

If you're new to this codebase or chasing a bug, start with the docs:

- [`docs/architecture.md`](docs/architecture.md) — data flow across all
  the moving pieces. Look here first to figure out which layer a problem
  belongs to.
- [`docs/known-issues.md`](docs/known-issues.md) — institutional memory.
  Bugs we've fixed, quirks to respect, design rules to preserve. Read
  before changing anything in the source pipeline or the dashboard's
  data layer.
- [`docs/conventions.md`](docs/conventions.md) — naming, time windows,
  aggregation rules, scope semantics. The "why are TTT and ATT computed
  this way?" reference.

## Repository layout

```
call-data-reporting/
├── README.md                       ← this file
├── docs/                           ← architecture / known issues / conventions
├── apps-script/                    ← all Apps Script project sources
│   ├── department-dashboard/       ← the web app this repo deploys (top-level clasp pushes from here)
│   ├── cdr-report/                 ← the CDR Report project (data hub spreadsheet)
│   │   └── (cd in, then `clasp push -f` to deploy that project)
│   └── cdr-import/                 ← the CDR Import project (CSV ingester)
│       └── (cd in, then `clasp push -f` to deploy that project)
├── .clasp.example.json             ← template; copy to .clasp.json on first checkout
├── .clasp.json                     ← per-developer, gitignored (scriptId varies per checkout)
├── .claspignore
└── .gitignore
```

Each subdirectory under `apps-script/` has its own gitignored
`.clasp.json` so per-project deploys are independent. The legacy DQE
Report spreadsheet is being retired and isn't pulled in.

## Deploying the Department Dashboard

The web app is deployed from the standalone "Department Dashboard" Apps
Script project (not container-bound to any spreadsheet). Source is pushed
via clasp from this repo.

**One-time setup (from Cloud Shell or any machine with Node):**

```bash
npm install -g @google/clasp
clasp login --no-localhost   # --no-localhost if you're in Cloud Shell

# Create your local .clasp.json from the template. It's gitignored so
# your scriptId stays per-checkout and doesn't conflict on pulls.
cp .clasp.example.json .clasp.json
# Edit .clasp.json -> set scriptId to your Apps Script project's ID
# (Project Settings -> IDs -> Script ID)
```

**Each push:**

```bash
git pull
clasp push -f
# Then in the Apps Script editor: Deploy -> Manage deployments
# -> pencil -> Version: New version -> Deploy
```

**One-time, in the Apps Script project:**

- Project Settings -> Script Properties -> add `SPREADSHEET_ID`
  pointing at the CDR Report spreadsheet's ID (from its URL).
- Run the `setup` function once to create the dashboard-managed
  sheets: `Access Control`, `Alert Config`, `Alert Log`,
  `Pipeline Health`, `Digest Config`, `Agent Alias Overrides`,
  and `Orphan Fix Log` (seven total; created only if missing).
  Requires admin auth — run from the Apps Script editor while
  logged in as an admin listed in `ADMIN_EMAILS` Script Property
  (or `ADMIN_EMAILS_FALLBACK`).
  Safe to re-run later (idempotent; existing data untouched) —
  re-run after pulling new code that introduces additional
  sheets so downstream writers (Pipeline Health appends, Digest
  reads, Orphan Fix log) don't silently no-op against missing
  sheets.
- Populate the `Access Control` sheet with one row per manager
  (Email | Department | Notes).
- Add yourself to the admin list. Two options:
  - **Preferred:** Project Settings → Script Properties → add
    `ADMIN_EMAILS` set to a comma-separated list of admin emails.
    Read at request time via `Config.gs::getAdminEmails_()`; adding
    a new admin is a one-click edit, no redeploy.
  - **Fallback:** edit `ADMIN_EMAILS_FALLBACK` in
    `apps-script/department-dashboard/Config.gs` and redeploy.
    Used only when the Script Property is unset.
- Deploy as Web app: **Execute as: Me**, **Who has access: Anyone within
  [your domain]**.
- After any push that adds a new OAuth scope to `appsscript.json` (e.g.
  `script.scriptapp` for the alerts trigger, `script.send_mail` for
  email exports), open the Apps Script editor and Run → any function
  once to trigger the re-auth consent prompt. Scope-gated calls
  otherwise throw permission errors at runtime even though the
  dashboard page loads fine.

**Optional (manager digest emails):**

- Populate the `Digest Config` sheet (created by `setup()`) with one
  row per subscriber:
  Email | Department | Cadence (`daily` or `weekly`) | Active
  (TRUE/FALSE) | Notes.
- In the deployed dashboard, open Alerts (admin-only) → **Manager
  Digest Subscribers** → **Install digest triggers**. Daily fires
  weekday mornings for the previous day; weekly fires Monday morning
  for the prior Mon&ndash;Fri window.

**Optional (orphan fix):**

- When the CDR feed produces an agent name that doesn't match any
  roster entry (typos, marriages, hyphenations, exotic spellings),
  the row appears in `DQE Historical Data` but doesn't show up
  under any dept. Surface these via the dashboard's
  **Outlier Fix** tab in the top header nav (admin-only).
- For each orphan, pick a canonical name from the roster dropdown
  and click Apply. The action: (1) bulk-renames every row in
  `DQE Historical Data` where Agent Name == orphan, (2) adds the
  mapping to the `Agent Alias Overrides` sheet so the next CDR
  build keeps the mapping, (3) appends a row to `Orphan Fix Log`.
- The modal requires the `Agent Alias Overrides` and `Orphan Fix
  Log` sheets to exist — created by `setup()`. Run `setup()` after
  pulling this code if those sheets are missing in your
  spreadsheet.
- Admin-only at the server boundary. See CLAUDE.md INV-01 for the
  full security model around the carve-out.

**Optional (QCD Report):**

- The **QCD Report** modal (click the **QCD** tab in the header nav) reads from
  `QCD Historical Data`, written daily by the import pipeline.
  Visible to all managers + admins; per-dept gated.
- **`Config.gs::DEPT_QCD_QUEUES` is the dept ↔ queue mapping.**
  Each dashboard dept maps to one or more raw queue names
  (e.g. `A_Q_CustomerSuccess`, `A_Q_Sales`) — the values in
  `QCD Historical Data` col D. Canonical spellings vary per
  install (this one's CSR queue is `A_Q_CustomerSuccess`); open
  the sheet and look at col D for recent rows to find the names
  for your install, then edit this map and redeploy.
- A dept not listed in `DEPT_QCD_QUEUES` renders an empty modal
  with a "No queues mapped" hint and no Overview QCD chips. New
  depts producing QCD rows won't show up in the dashboard until
  added to the map.
- **Sub-queue rollup** is automatic via `OVERVIEW_PARENT_OF`
  (CompanyOverview.gs): viewing a parent dept's QCD report
  auto-includes its children's queues. Current parents are
  Sales (rolls up PAP), Power (rolls up PAK), and CSR (rolls
  up Spanish). Each child dept still has its own
  `DEPT_QCD_QUEUES` entry so the child's own modal works.
- After QCD data flows, the Overview page's per-dept tiles gain
  an "Aban N (P%)" chip (warn-tinted when ≥ 5%) and a
  "X viol MTD" badge when month-to-date violations are > 0. The
  My Department page shows a "Yesterday's QCD" tile row below
  the agent table.

**Optional (alerts):**

- Populate the `Alert Config` sheet with one row per dept that should
  receive low-answer-rate alerts:
  Department | Threshold % | Extra Recipients (comma-separated) |
  Active (TRUE/FALSE) | Notes | Skip Dates.
- **Skip Dates (col F, optional)** accepts comma-separated
  `YYYY-MM-DD` dates and inclusive ranges via `..` (e.g.
  `2026-12-25, 2026-12-31..2026-01-01`). Honored by the daily
  trigger only -- manual sends from the dashboard's Alerts modal
  always fire, so an admin can still force-send after a holiday
  review. Malformed tokens are silently dropped (parser is
  intentionally tolerant). Pre-E8 sheets keep their 5-col header
  row; data still flows because the reader indexes col F by
  position. To add the header label `Skip Dates` to F1 on an
  existing sheet, paste it in manually -- `setup()` won't add
  columns to existing sheets (per CLAUDE.md INV-22).
- Project Settings -> Script Properties -> add `DASHBOARD_URL`
  pointing at the deployed web app's URL. **Strongly recommended
  since Phase C** — two consumers depend on it: (a) the "Open
  Dashboard" link in alert emails (without it, emails still send
  but omit the link), and (b) the `↗ Open in new tab` buttons on
  every report modal (without it, the buttons silently hide and
  the side-by-side-comparison flow doesn't work). The deep-link
  hash routes (see below) only work when this is set.
- Install the daily trigger: open the dashboard as an admin, click
  Alerts → Install daily trigger (8 AM). The trigger calls
  `runDailyAlerts_` for the previous day, skipping Saturdays and
  Sundays automatically.
- Once the trigger has been running for ~10 weekdays, the Alerts
  modal's config table gains a **Last 30 days** chip per dept
  summarizing recent trigger outcomes (E10). Warn-tinted chip =
  threshold firing chronically (alert fatigue likely); muted =
  threshold sits well below actual performance and may be too
  loose; sage = healthy mix. Hover for the specific fired-count +
  mean answer rate. Tunable in `Alerts.gs` (`DRIFT_*` constants).

## Deep links

Phase C (commit ce4220a) added URL hash routing so any report
modal can be linked to directly. Append one of these fragments to
the deployed web-app URL to land on that view:

- `#/overview` — Overview page (default landing)
- `#/dept` — My Department page
- `#/report/missed` — Missed Calls report
- `#/report/individual` — Individual Report
- `#/report/performance` — Performance Report
- `#/report/compare` — Compare Ranges
- `#/report/qcd` — QCD Report
- `#/admin/alerts` — Low Answer Rate Alerts (admin-only)
- `#/admin/orphan-fix` — Outlier Fix (admin-only)

Each report modal also carries a small `↗` button next to its
close X — clicking it opens the same view in a new browser tab so
you can OS-tile two windows side-by-side for comparison. Requires
the `DASHBOARD_URL` Script Property to be set (see Alerts setup
above); the button silently hides when unset.

Form state (date range, agent selection, etc.) is not yet
serialized into the URL — each modal restores its own last-used
state from localStorage when opened, which fills the gap for the
common case. Richer state-in-URL is a future enhancement.

## DQE Historical Data freshness

The dashboard reads from `DQE Historical Data`; three paths
keep it fresh, in order of preference:

1. **Integrated daily path (primary)** — cdr-import's
   `processIntegratedHistory` now builds DQE inline as the 5th
   historical sheet write, alongside CDR / Q Path / QCD / CSR.
   Every successful daily import (whether triggered by onChange
   or `runManualExport`) refreshes DQE in one run. Telemetry
   row: `processIntegratedHistory:DQE` in Pipeline Health.
2. **Bulk historical backfill path** — `bulkHistoricalUpdate`
   in cdr-import builds DQE per-date for the requested range,
   writing Raw Data per-date only when DQE actually needs
   rebuilding. Telemetry row: `bulkBackfill:DQE`.
3. **Standalone safety-net trigger (transitional)** — the
   cdr-report project's `runDailyDQEBuild_` time trigger
   (originally the only DQE refresh mechanism) is preserved
   while the integrated path stabilizes. Telemetry row:
   `buildDQE`. Install via CDR Report spreadsheet's **CDR
   Tools** menu → **⏰ Daily DQE Build Trigger** →
   **Install (runs at 7 AM)**, or run `installDQEBuildTrigger`
   from the editor. The Run dropdown will prompt for the
   `script.scriptapp` and `script.send_mail` permissions if
   they haven't been granted yet. Skips Saturdays/Sundays;
   emails `NEON_WRITE_CONFIG.alertEmail` on failure. Uninstall
   via the same menu (or `uninstallDQEBuildTrigger`) once a
   week's worth of `processIntegratedHistory:DQE` rows appear
   consistently in Pipeline Health.

INV-16 keeps the two `buildDQEHistoricalData.js` copies
(cdr-import + cdr-report) byte-identical -- any edit to one is
a two-file edit.

## Working on sibling Apps Script projects

`apps-script/cdr-report/` and `apps-script/cdr-import/` are full clasp
projects pulled from their live Apps Script counterparts (Phase R3
complete). Each has its own gitignored `.clasp.json`. To deploy a fix
to one of them:

```bash
cd apps-script/cdr-report          # or cdr-import
clasp pull                          # if you suspect the live project drifted
# ... edit files ...
clasp push -f
```

The `cd` matters: clasp looks at the nearest `.clasp.json` walking up
from the current directory. Running `clasp push` from the repo root
pushes the dashboard project, not the sibling.

**First-time setup for a sibling project** (e.g., after a fresh clone of
this repo): each subfolder needs a `.clasp.json` with the project's
scriptId. The file is gitignored on purpose. Either ask the maintainer
for the scriptId, or look it up in the live project's Apps Script
**Project Settings → IDs → Script ID** and write your own:

```bash
cd apps-script/cdr-report
cat > .clasp.json <<'EOF'
{ "scriptId": "<paste-scriptId-here>" }
EOF
clasp pull
```
