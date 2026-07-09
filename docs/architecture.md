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
│   Data per dept      │         │   for 5–30 min          │
└──────────────────────┘         └────────────┬────────────┘
                                              │
                                              ▼
                                       Manager's browser
                                       (Google Workspace auth)
```

## Where each piece of code lives

| Layer | Apps Script project | Files (representative) | This repo path |
|---|---|---|---|
| CSV ingest | CDR Import | `autoImport.js`, `importBulkCSVsFromDrive.js` (pending Drive auth), `AbandonedFilter.js`, `CDR Tools.js`, `DeleteOldSheets.js`, `neonWrite.js`, `inboundCalls.js` (per-call inbound capture -> Neon `inbound_calls` + `backfillInboundCalls`), `appsscript.json` | `apps-script/cdr-import/` |
| Per-agent aggregation + downstream tooling | CDR Report | `buildDQEHistoricalData.js`, `DQEdrilldown.js`, `DQEDrilldownSidebar.html`, `dashboardCDR.js`, `dataFilters.js` (extraction sidebar), `dbHistorical.js`, `dbReporting.js`, `emailDailyReport.js`, `neonWrite.js`, `neonbackfill.js`, `inboundCallsExport.js` (Neon `inbound_calls` -> "Inbound Calls" fallback tab), `insuranceNumbers.js` (insurer-number hashing -> Neon `insurance_numbers`), `CDR Tools menu.js`, `appsscript.json` | `apps-script/cdr-report/` |
| Manager dashboard | Department Dashboard (standalone) | `Code.gs`, `Auth.gs`, `Data.gs`, `Config.gs`, `Setup.gs`, `Util.gs`, `Diagnostics.gs`, `MissedCallsReport.gs`, `IndividualReport.gs`, `PerformanceReport.gs`, `CompareRangesReport.gs`, `InsightsReport.gs`, `InboundReport.gs`, `CompanyOverview.gs`, `QCDReport.gs`, `Alerts.gs`, `Digest.gs`, `OrphanFix.gs`, `DeptConfig.gs`, `Escalations.gs`, `NeonRead.gs`, `NeonKeepWarm.gs`, `CacheWarm.gs`, `dashboard.html`, `styles.html`, `script.html`, `access_denied.html`, `appsscript.json` | `apps-script/department-dashboard/` |
| Postgres mirror | shared lib used by both CDR Import and CDR Report | `neonWrite.js` (duplicated across both projects, currently identical) | see [known-issues.md](known-issues.md) |
| Per-agent DQE build (duplicated) | both CDR Import and CDR Report | `buildDQEHistoricalData.js` (duplicated across both projects, currently identical -- INV-16). cdr-import invokes inline inside `processIntegratedHistory`; cdr-report keeps a daily trigger copy as a safety net. | `apps-script/cdr-import/` + `apps-script/cdr-report/` |
| Legacy reports (being migrated into the dashboard) | DQE Report (spreadsheet) | `DQEdashboard.js`, 4 report pairs (`SingleRangeReport`, `IndividualReport`, `MissedCallsReport`, `MultiComparisonTool` + their `.html` modals), `sendManualAlert.js`, `showFAQ.js` + `FAQGuide.html`, `menu DQE Tools.js`, `appsscript.json` | `apps-script/dqe-report/` |

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

**Dashboard → Neon write (orphan-rename-to-Neon).** `applyOrphanRename`
also best-effort mirrors the rename into Neon's `dqe_history`
(`renameAgentInNeon_` in `OrphanFix.gs`) so the change isn't lost once
aged rows are dropped from the sheet (forward-looking for the Neon
read-back). This is the dashboard's ONLY Neon write and the first
non-sheet write path; it needs the `script.external_request` OAuth
scope plus `NEON_HOST/NEON_DB/NEON_USER/NEON_PASS` Script Properties on
the dashboard project. It is conflict-safe: `uq_dqe_history` is
`UNIQUE (call_date, agent_name)`, so rows whose `(call_date, toName)`
slot is already taken are LEFT under `fromName` (returned + logged as
`neonSkipped`) rather than violating the constraint — those few are
reconciled later. Never throws: a missing config / unreachable Neon /
SQL error returns null and the authoritative sheet rename still
succeeds. INV-01 is unaffected (it governs spreadsheet writes; this is
a Postgres write).

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
| Main per-agent table | `Data.gs` | `getDepartmentSummary` | `summary:v11:` | no |
| Missed Calls Report | `MissedCallsReport.gs` | `getMissedCallsReport` | `missed:v13:` | no |
| Individual / Peer Comparison | `IndividualReport.gs` | `getIndividualReportInit`, `getIndividualReport`, `sendIndividualReportEmail` | `individual:v11:`, `individual_active:v2:` | no |
| Performance Report (current vs prior) | `PerformanceReport.gs` | `getPerformanceReportInit` (delegates to Individual's init), `getPerformanceReport`, `sendPerformanceReportEmail` | `performance:v5:` | no |
| Compare Ranges (two arbitrary ranges) | `CompareRangesReport.gs` | `getCompareRangesInit`, `getCompareRanges`, `sendCompareRangesEmail` | `compareRanges:v6:` | no |
| Company Overview | `CompanyOverview.gs` | `getCompanyOverview` | `companyOverview:v18` | partial (admin-only `companyAggregate`, `pipelineFreshness`, `orphanNag`, `unmappedQcd` fields) |
| QCD Report | `QCDReport.gs` | `getQcdReportInit`, `getQcdReport`, `sendQcdReportEmail`, `getQcdAllDepartments` (all-departments daily report, open to all signed-in users) | `qcd:v10:`, `qcdAll:v3:` | no (per-dept gate like IR/PR/CR; all-dept report is company-wide read-only) |
| Insights Report (period comparison: team rollup + per-agent cards) | `InsightsReport.gs` | `getInsightsReportInit`, `getInsightsReport`, `sendInsightsReportEmail` | `insights:v17:` | no (per-dept gate like IR/PR/CR) |
| Inbound Report (per-call inbound view from Neon `inbound_calls`) | `InboundReport.gs` | `getInboundReport`, `getInboundInsurerDaily`, `getInboundHeatmap` (weekday×hour abandon heatmap), `getCallJourney` (per-call path drill; manager fallback entitlement-gated via the dept's own Missed report, F-4) | `inbound:v3:`, `inboundHeatmap:v1:` | TEMPORARILY admin-only while vetted (per-dept manager path kept intact); `getCallJourney` is manager-reachable for own dept |
| Direct Call Report (per-agent direct-extension metrics from Neon `direct_call_history`) | `DirectCallReport.gs` | `getDirectCallReport` | `directCall:v1:` | TEMPORARILY admin-only while the busy carve-out is vetted (per-dept manager path kept intact) |
| Caller Lookup (per-caller timeline from Neon `inbound_calls`) | `CallerLookup.gs` | `getCallerLookup` | (intentionally uncached) | yes |
| Escalations worklist (Neon `escalations` + `escalation_activity`) | `Escalations.gs` | `getEscalationsInit`, `getEscalations`, `getEscalationActivity` (read), `createEscalation`, `updateEscalation` (admin write), `resolveEscalation`, `updateEscalationComment`, `reopenEscalation` (per-dept write, INV-55) | (no cache) | no (per-dept; create/edit admin-only) |
| Low Answer Rate Alerts | `Alerts.gs` | `getAlertsInit`, `previewAlerts`, `sendAlerts`, `installAlertTrigger`, `uninstallAlertTrigger` (+ `runDailyAlerts_` time trigger) | (no cache) | yes |
| Manager Digest engine | `Digest.gs` | `getDigestsInit`, `sendPreviewDigest`, `installDigestTriggers`, `uninstallDigestTriggers` (+ `runDailyDigests_`, `runWeeklyDigests_` time triggers) | (no cache) | yes |
| Orphan Fix engine (admin write path) | `OrphanFix.gs` | `getOrphanFixInit`, `addAgentAlias`, `removeAgentAlias`, `applyOrphanRename` | (no cache; busts `COMPANY_OVERVIEW_CACHE_KEY` -- currently `companyOverview:v18` -- on write) | yes |

All reports use the same auth resolution (`resolveUser_(email)`), the
same roster reader (`getRosterForDepartment_`), and — for the picker —
the same active-in-range subset cache (`individual_active:v2:`). The
Individual / Performance / Compare Ranges "Email image" exports AND
the Alerts engine all require the `script.send_mail` OAuth scope
declared in `appsscript.json`.

## Where Neon fits in

Neon Postgres is the long-term archive and the future query backend.

- `buildDQEHistoricalData.gs` writes to both the sheet AND `neonWrite.gs`.
  Sheet write is the primary; Neon write is best-effort with email
  notification on failure (`notifyNeonWriteFailure`). The three live
  writers (`writeDQE/QCD/CDRRowsToNeon`) use `ON CONFLICT DO UPDATE`
  (the phone child rows stay `DO NOTHING`), so a re-import / force-rebuild
  propagates corrected values to Neon instead of skipping the existing
  row — the mechanism that lets corrections (e.g. the F2 name-splitter
  fix) actually reach Neon, and a prerequisite for the read-back.
- `processIntegratedHistory` in cdr-import also mirrors CDR Historical
  Data rows to `call_history_dept` + `call_history_phones` via
  `writeCDRRowsToNeon`. Phone numbers are HMAC-SHA256 hashed
  (`HMAC_SECRET` Script Property) for PHI protection; JSONB name-list
  fields parse the complex caller-name columns. Same best-effort
  pattern: Neon failure doesn't block the sheet write.
- The dashboard's DQE reads are sheet-first with a **flag-gated Neon
  read-back** (`NeonRead.gs`, the F1 phase): when the `DQE_READ_SOURCE`
  Script Property is `neon`, the cut-over readers (`getLatestDataDate`,
  `getCompanyOverview`, `computeSummary_`, the IR / PR / CR / Insights
  builders) read `dqe_history` and fall back to the sheet on any
  null/empty/error. Default (unset) is byte-identical to sheet-only.
  Gate the flip on `runDqeParityCheck` (see README). The admin-only
  **Inbound report** (`InboundReport.gs`) is the one Neon-ONLY reader —
  it has no sheet equivalent and renders an "unavailable" state when
  Neon is unreachable.
- **Per-call inbound capture** (`cdr-import/inboundCalls.js`):
  `processIntegratedHistory` builds one record per distinct inbound
  call from Raw Data (caller HMAC hash, dial-in line, disposition +
  abandon stage, abandoned-on-hold + hold/wait seconds, queue journey)
  and upserts them to Neon's `inbound_calls` (PK `(call_date,
  call_id)`, `ON CONFLICT DO UPDATE`). Historical gaps are filled by
  the editor-run `backfillInboundCalls` (same file; iterates surviving
  `Call_Legs_*` sheets, skips already-mirrored dates, time-budgeted).
  `cdr-report/inboundCallsExport.js::exportInboundCalls` mirrors
  `inbound_calls` into the "Inbound Calls" tab as a durable,
  pivot-friendly fallback copy (refresh-in-window semantics).
- **Insurer labeling** (`cdr-report/insuranceNumbers.js`): the
  insurance block in `DO NOT EDIT!` (cols X–AG: header = insurer name,
  rows = that insurer's published numbers) is hashed with the same
  `HMAC_SECRET` the import uses and synced to Neon's
  `insurance_numbers` `{phone_hash -> insurance_name}` reference table
  via the editor-run `syncInsuranceNumbersToNeon` (full replace per
  run). Joining it against `call_history_phones` (outbound) or
  `inbound_calls.caller_hash` (inbound) yields labeled per-insurer
  call counts with zero raw customer PHI stored anywhere. Re-run the
  sync after editing the insurance block.
- `apps-script/cdr-report/neonBackfill.gs` is for one-off historical
  backfills from the sheet into Neon: `backfillDQEHistory()` /
  `backfillQCDHistory()` (idempotent `DO NOTHING`), plus
  `backfillCDRHistory()` — a repair tool that re-mirrors `CDR Historical
  Data` with `DO UPDATE` to fix the JSONB name columns corrupted before
  the F2 splitter fix and fill partially-written phone children
  (requires `HMAC_SECRET`; resumable via `CDR_BACKFILL_RESUME`); and
  `backfillDQEHistoryUpsert()` — the `DO UPDATE` DQE mirror to run after a
  bulk rebuild (which defers the per-date DQE→Neon mirror via `skipNeon`),
  so re-calculated rows overwrite stale `dqe_history` rows (resumable via
  `DQE_UPSERT_RESUME`; one connection per invocation).

## Future improvements

- **Client-orchestrated bulk-import sidebar.** The bulk rebuild
  (`bulkHistoricalUpdate` → `processBulkQueue`) is a single long server
  loop with toast + execution-log feedback and a 15-min pause/Resume
  cycle. A live progress sidebar/dialog is *not* possible on top of that
  design (Apps Script has no server→client push, and the running loop
  blocks the sidebar's callbacks). The long-term superior UX is to invert
  control: a **sidebar drives the loop**, calling a `processOneBulkDate()`
  -style endpoint one date/batch at a time and updating its own HTML
  between calls. That gives a live progress bar + a Stop button, and as a
  bonus **eliminates the pause/Resume clicks and the blocking `ui.alert`
  hangs** (each server call is short, well under the execution ceiling).
  It's a real re-architecture of the bulk orchestration, deferred until
  the bulk UX is worth that investment.

### Cross-project reader: team-tools

The `team-tools` repo's Metrics module reads DQE Historical Data
directly via `SpreadsheetApp.openById(CDR_SS_ID)` — a separate
Google Apps Script project that opens this spreadsheet as a read-only
consumer (Option A). It replicates the `HISTORICAL_COLS` mapping,
uses `getDisplayValues()` for duration columns (matching this
dashboard's `parseHmsDisplay_` pattern), and skips queue-sentinel
rows. The deployer of team-tools must have Viewer access on the
CDR Report spreadsheet. This is a soft coupling: column-position
changes to DQE Historical Data must be reflected in team-tools'
`CDR` constant in `Code.js`. A future Neon read-back (Phase 3)
would replace both this dashboard's sheet reads AND team-tools'
`getCdrAgentMetrics_()` / `getCdrDailyBreakdown_()` helpers.

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
