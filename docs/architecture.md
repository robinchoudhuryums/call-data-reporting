# Architecture

How call data flows from the upstream telephony system to the manager-facing
dashboards. Useful when something is broken and you need to know which layer
to look at first.

## Data flow

```
External CDR system (telephony provider)
        │
        │  daily CSV export
        ▼
┌─────────────────────────────────────────────┐
│ CDR Import (Apps Script project)            │
│   autoImport.gs                              │
│   - Pulls the day's CSV                      │
│   - Writes rows into "Raw Data" sheet of     │
│     the CDR Report spreadsheet               │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ CDR Report spreadsheet                       │
│                                              │
│  ┌───────────────┐                           │
│  │ Raw Data      │  ← per-leg call rows      │
│  └──────┬────────┘                           │
│         │                                    │
│  buildDQEHistoricalData.gs                   │
│  - Aggregates per-agent per-date metrics     │
│  - Filters to the 6:30AM-3PM PST work window │
│  - Writes one row per agent per day          │
│         │                                    │
│         ▼                                    │
│  ┌─────────────────────────┐                 │
│  │ DQE Historical Data     │  ← canonical    │
│  └──────┬──────────────────┘    per-agent   │
│         │                       per-day      │
│         │                       metrics      │
│         │                                    │
│         │  neonWrite.gs mirrors rows         │
│         ▼                                    │
│  Neon Postgres (dqe_history table)           │
│                                              │
│  ┌─────────────────────────┐                 │
│  │ DO NOT EDIT!            │  ← roster +     │
│  │ (dept agents + queue    │    queue        │
│  │ extensions)             │    mapping      │
│  └─────────────────────────┘                 │
└─────────────────────────────────────────────┘
        │
        ├──────────────────────────────────────┐
        ▼                                       ▼
┌──────────────────────┐         ┌─────────────────────────┐
│ DQE Report (legacy   │         │ Department Dashboard    │
│ spreadsheet,         │         │ (this repo, web app at  │
│ being retired)       │         │ apps-script/department- │
│                      │         │ dashboard/)             │
│ - Per-dept tabs with │         │ - Reads DQE Historical  │
│   formulas filtering │         │   Data + DO NOT EDIT!   │
│   DQE Historical     │         │ - Caches in CacheService│
│   Data per dept      │         │   for 5 min             │
└──────────────────────┘         └────────────┬────────────┘
                                              │
                                              ▼
                                       Manager's browser
                                       (Google Workspace auth)
```

## Where each piece of code lives

| Layer | Apps Script project | Files (representative) | This repo path |
|---|---|---|---|
| CSV ingest | CDR Import | `autoImport.js`, `importBulkCSVsFromDrive.js` (pending Drive auth), `AbandonedFilter.js`, `CDR Tools.js`, `DeleteOldSheets.js`, `neonWrite.js`, `appsscript.json` | `apps-script/cdr-import/` |
| Per-agent aggregation + downstream tooling | CDR Report | `buildDQEHistoricalData.js`, `DQEdrilldown.js`, `DQEDrilldownSidebar.html`, `dashboardCDR.js`, `dataFilters.js` (extraction sidebar), `dbHistorical.js`, `dbReporting.js`, `emailDailyReport.js`, `neonWrite.js`, `neonbackfill.js`, `CDR Tools menu.js`, `appsscript.json` | `apps-script/cdr-report/` |
| Manager dashboard | Department Dashboard (standalone) | `Code.gs`, `Auth.gs`, `Data.gs`, `Config.gs`, `Setup.gs`, `Diagnostics.gs`, `dashboard.html`, `styles.html`, `script.html`, `access_denied.html`, `appsscript.json` | `apps-script/department-dashboard/` |
| Postgres mirror | shared lib used by both CDR Import and CDR Report | `neonWrite.js` (duplicated across both projects, currently identical) | see [known-issues.md](known-issues.md) |
| Legacy dashboard | DQE Report (spreadsheet, being retired) | Sheet formulas only — no code | n/a |

Each subdirectory under `apps-script/` has its own `.clasp.json` (gitignored,
per-developer) so each project deploys independently:

```bash
cd apps-script/department-dashboard && clasp push -f     # the web app
cd apps-script/cdr-report          && clasp push -f      # the data hub
cd apps-script/cdr-import          && clasp push -f      # the CSV ingester
```

A first-time checkout needs to populate each `.clasp.json` with the
corresponding scriptId (from the Apps Script project's Settings page).
The top-level `.clasp.json` controls the dashboard's push from the repo
root, as before.

## Key cross-project assumptions

These are easy to break inadvertently. Change one without the other and the
dashboard silently produces wrong numbers (we've already lived through
several of these — see [known-issues.md](known-issues.md)).

1. **Sheet names must stay literal.** The dashboard's `Config.gs` references
   `"DQE Historical Data"`, `"DO NOT EDIT!"`, and `"Access Control"` by
   string. Rename a sheet and the dashboard breaks.
2. **Column positions in `DQE Historical Data`** are pinned in
   `HISTORICAL_COLS` in the dashboard's `Config.gs`. Adding/removing
   columns in the source pipeline requires updating that constant.
3. **The 6:30 AM – 3:00 PM PST work window** (constants `DQE_WINDOW_START`,
   `DQE_WINDOW_END` in `buildDQEHistoricalData.gs`) bounds what counts as
   "in shift". TTT/ATT, missed-call slot totals, etc. all use it. Changing
   it shifts every metric. See [conventions.md](conventions.md).
4. **`DO NOT EDIT!` cell format** is `"Name, ext1, ext2"`. The dashboard
   parses this in `Data.gs` (`parseRosterCell_`). Whoever maintains the
   roster sheet must keep the format consistent or agents silently drop
   off the roster.
5. **Agent-name matching is exact** between `DQE Historical Data`'s Agent
   column and the names in `DO NOT EDIT!` cells (after stripping
   extensions). No alias normalization. A typo on either side means the
   agent disappears from their dept's view.
6. **Spreadsheet timezone** is currently set to Mexico City; script
   timezone (in `appsscript.json`) is `America/Chicago`. These don't match
   but the dashboard works around it. See `known-issues.md` if you ever
   touch this.

## Where Neon fits in

Neon Postgres is the long-term archive and the future query backend.

- `buildDQEHistoricalData.gs` writes to both the sheet AND `neonWrite.gs`.
  Sheet write is the primary; Neon write is best-effort with email
  notification on failure (`notifyNeonWriteFailure`).
- The dashboard does NOT read from Neon yet — it reads the sheet. Moving
  to Neon as the read path is a future phase (Phase 3 in the original
  product spec).
- `apps-script/cdr-report/neonBackfill.gs` is for one-off historical
  backfills from the sheet into Neon.

## Auth model (Department Dashboard)

- **Visitors** open the web app URL. Identity = `Session.getActiveUser().getEmail()`
  (Google Workspace domain only — the deployment is `access: DOMAIN`).
- **`Code.gs` → `Auth.gs`** resolves them via:
  - `ADMIN_EMAILS` constant in `Config.gs` (hardcoded; bypasses dept check)
  - `Access Control` sheet (Email | Department | Notes) for managers
- **Execute-as: deployer.** The script runs with Robin's permissions, so
  managers don't need direct access to CDR Report. Read-only safety relies
  on every public function (`google.script.run`-callable) being read-only.
  See [known-issues.md](known-issues.md) for the design rule.
