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
│  (now invoked inline by cdr-import's         │
│   processIntegratedHistory as the 5th block, │
│   so DQE refreshes alongside CDR/QPath/QCD/  │
│   CSR in one run; cdr-report keeps a daily   │
│   trigger copy as a safety net -- INV-16)    │
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
| Manager dashboard | Department Dashboard (standalone) | `Code.gs`, `Auth.gs`, `Data.gs`, `Config.gs`, `Setup.gs`, `Diagnostics.gs`, `MissedCallsReport.gs`, `IndividualReport.gs`, `PerformanceReport.gs`, `CompareRangesReport.gs`, `CompanyOverview.gs`, `QCDReport.gs`, `Alerts.gs`, `Digest.gs`, `OrphanFix.gs`, `dashboard.html`, `styles.html`, `script.html`, `access_denied.html`, `appsscript.json` | `apps-script/department-dashboard/` |
| Postgres mirror | shared lib used by both CDR Import and CDR Report | `neonWrite.js` (duplicated across both projects, currently identical) | see [known-issues.md](known-issues.md) |
| Per-agent DQE build (duplicated) | both CDR Import and CDR Report | `buildDQEHistoricalData.js` (duplicated across both projects, currently identical -- INV-16). cdr-import invokes inline inside `processIntegratedHistory`; cdr-report keeps a daily trigger copy as a safety net. | `apps-script/cdr-import/` + `apps-script/cdr-report/` |
| Legacy reports (being migrated into the dashboard) | DQE Report (spreadsheet) | `DQEdashboard.js`, `syncHistoricalData.js`, 4 report pairs (`SingleRangeReport`, `IndividualReport`, `MissedCallsReport`, `MultiComparisonTool` + their `.html` modals), `sendManualAlert.js`, `checkLowAnswerRate.js`, `showFAQ.js` + `FAQGuide.html`, `setDateRange.js`, `autoDropdown.js`, `menu DQE Tools.js`, `appsscript.json` | `apps-script/dqe-report/` |

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
5. **Agent-name matching at the dashboard layer is exact** between
   `DQE Historical Data`'s Agent column and the names in `DO NOT EDIT!`
   cells (after stripping extensions). The pipeline canonicalizes
   paren-variant names against the roster before writing (see "Pipeline
   reads roster" below), so the downstream exact-match remains reliable
   even when the CDR feed varies. Genuinely-mismatched names (not just
   paren differences) still disappear silently — diagnose via the
   dashboard's Diagnostics panel.
6. **Spreadsheet timezone** is currently set to Mexico City; script
   timezone (in `appsscript.json`) is `America/Chicago`. These don't match
   but the dashboard works around it. See `known-issues.md` if you ever
   touch this.

## Pipeline reads the roster for name canonicalization

`buildDQEHistoricalData` (CDR Report project) reads the dashboard's
`DO NOT EDIT!` roster sheet at the start of every build. The roster is
the source of truth for canonical agent names; any incoming CDR row
whose `calleeName`, paren-stripped, matches exactly one roster entry
is rewritten to that roster name before per-agent aggregation.

It's documented in `loadRosterCanonicalNames_` and called out as
INV-24 in `CLAUDE.md`. If the roster sheet's layout ever changes
(column F start, name-comma-extensions cell format), update
`loadRosterCanonicalNames_` in the pipeline at the same time as
`Data.gs`'s `parseRosterCell_` in the dashboard.

The same `loadRosterCanonicalNames_` also reads the
`Agent Alias Overrides` sheet (created in the dashboard's
`setup()`, written by the dashboard's `OrphanFix.gs` admin modal).
Each active row -- `Old Name | Canonical Name | Active=TRUE` --
becomes a higher-priority lookup in the canonicalization map (alias
> roster-exact > paren-strip). The read is best-effort: missing or
empty sheet leaves the build's behavior byte-identical to
pre-OrphanFix. See INV-46 in `CLAUDE.md` for the full contract.

## QCD: dept ↔ queue coupling lives in the dashboard

`QCD Historical Data` is written daily by the import pipeline
(`autoImport.js::processIntegratedHistory`) with `Call Queue`
populated from the `QCDR Output` sheet's column A labels --
raw queue names like `A_Q_CSR` / `A_Q_PowerChairs`, not
dashboard dept names. The dashboard reads from three sites
(`QCDReport.gs`, `CompanyOverview.gs::computeQcdSnapshots_`,
`Data.gs::computeDeptQcdSnapshot_`), and all three route the
queue ↔ dept mapping through `Config.gs::DEPT_QCD_QUEUES`.

That mapping is **dashboard-side only** -- the pipeline doesn't
know about dashboard depts and the QCDR Output labels don't know
about which dashboard dept owns which queue. Two consequences:

1. **Renaming a queue upstream silently breaks the dashboard
   until `DEPT_QCD_QUEUES` is updated.** If the CSR queue gets
   renamed from `A_Q_CSR` to `A_Q_CustomerService` in QCDR
   Output, QCD Historical Data starts emitting the new name on
   the next ingest. The dashboard's CSR dept loses its QCD chips
   + modal until `Config.gs::DEPT_QCD_QUEUES['CSR']` is updated.
2. **New depts producing QCD rows don't surface in the
   dashboard until they're added to the map.** The dashboard
   doesn't auto-discover dept-name-like values in col D because
   they aren't there to begin with.

See INV-50 / INV-51 in `CLAUDE.md` for the full contract;
`known-issues.md` → "QCD Report engine" covers the operator
onboarding flow.

## Cross-project writes from the dashboard

Until OrphanFix.gs shipped, the dashboard had ZERO write paths into
shared sheets -- everything in `apps-script/department-dashboard/`
was read-only via the trailing-underscore convention (INV-01). The
Orphan Fix engine introduced the first three admin-only public
writes:

| Function | Writes to | Notes |
|---|---|---|
| `addAgentAlias`, `removeAgentAlias` | `Agent Alias Overrides` (in CDR Report spreadsheet) | Forward-fix only; future builds honor the alias. |
| `applyOrphanRename` | `DQE Historical Data` Agent Name column (in CDR Report spreadsheet) | Backfills past rows. Also typically writes to `Agent Alias Overrides` (`alsoAddAlias=true`) so the next build keeps the mapping. |

All three are admin-only at the server boundary
(`assertAdmin_()`), input-validated (no queue sentinels,
length-capped, canonical destination must be on some roster),
serialized via `LockService`, and audited to the `Orphan Fix Log`
sheet (also in the CDR Report spreadsheet) before returning.
INV-01's text was widened to spell out this carve-out; do not add
more public writes outside `OrphanFix.gs` without the same four
mitigations.

## Report server entry points (Department Dashboard)

The dashboard serves the reports below plus three admin-only
operations engines (Alerts, Digest, Orphan Fix). Each is backed by
its own `.gs` file with public entry points callable via
`google.script.run`. All public functions follow the read-only
safety rule (INV-01) EXCEPT `OrphanFix.gs`'s three admin write
callables, which have the documented carve-out. Helpers that touch
spreadsheet state end in `_`. Alerts, Digest, and Orphan Fix
enforce admin role checks at the server boundary (INV-32).

Cache prefix versions below are reference-only; CLAUDE.md INV-30 is
canonical and reflects current code.

| Report | File | Public entries | Cache prefix | Admin-only |
|---|---|---|---|---|
| Main per-agent table | `Data.gs` | `getDepartmentSummary` | `summary:v6:` | no |
| Missed Calls Report | `MissedCallsReport.gs` | `getMissedCallsReport` | `missed:v10:` | no |
| Individual / Peer Comparison | `IndividualReport.gs` | `getIndividualReportInit`, `getIndividualReport`, `sendIndividualReportEmail` | `individual:v6:`, `individual_active:v1:` | no |
| Performance Report (current vs prior) | `PerformanceReport.gs` | `getPerformanceReportInit` (delegates to Individual's init), `getPerformanceReport`, `sendPerformanceReportEmail` | `performance:v3:` | no |
| Compare Ranges (two arbitrary ranges) | `CompareRangesReport.gs` | `getCompareRangesInit`, `getCompareRanges`, `sendCompareRangesEmail` | `compareRanges:v3:` | no |
| Company Overview | `CompanyOverview.gs` | `getCompanyOverview` | `companyOverview:v12` | partial (admin-only `companyAggregate` field) |
| QCD Report | `QCDReport.gs` | `getQcdReportInit`, `getQcdReport`, `sendQcdReportEmail` | `qcd:v5:` | no (per-dept gate like IR/PR/CR) |
| Low Answer Rate Alerts | `Alerts.gs` | `getAlertsInit`, `previewAlerts`, `sendAlerts`, `installAlertTrigger`, `uninstallAlertTrigger` (+ `runDailyAlerts_` time trigger) | (no cache) | yes |
| Manager Digest engine | `Digest.gs` | `getDigestsInit`, `sendPreviewDigest`, `installDigestTriggers`, `uninstallDigestTriggers` (+ `runDailyDigests_`, `runWeeklyDigests_` time triggers) | (no cache) | yes |
| Orphan Fix engine (admin write path) | `OrphanFix.gs` | `getOrphanFixInit`, `addAgentAlias`, `removeAgentAlias`, `applyOrphanRename` | (no cache; busts `companyOverview:v12` on write) | yes |

All reports use the same auth resolution (`resolveUser_(email)`), the
same roster reader (`getRosterForDepartment_`), and — for the picker —
the same active-in-range subset cache (`individual_active:v1:`). The
Individual / Performance / Compare Ranges "Email image" exports AND
the Alerts engine all require the `script.send_mail` OAuth scope
declared in `appsscript.json`.

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
  - `Config.gs::getAdminEmails_()` — reads the `ADMIN_EMAILS` Script Property
    (comma-separated) at request time, falls back to `ADMIN_EMAILS_FALLBACK`
    constant if unset; bypasses dept check
  - `Access Control` sheet (Email | Department | Notes) for managers
- **Execute-as: deployer.** The script runs with Robin's permissions, so
  managers don't need direct access to CDR Report. Read-only safety relies
  on every public function (`google.script.run`-callable) being read-only.
  See [known-issues.md](known-issues.md) for the design rule.
