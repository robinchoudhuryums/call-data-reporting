/**
 * Department Dashboard - configuration constants.
 *
 * SPREADSHEET_ID is read from Script Properties so the same code can
 * point at dev/prod copies without edits. Set it once via:
 *   Project Settings > Script Properties > Add property
 *     name:  SPREADSHEET_ID
 *     value: <id from the CDR Report sheet URL>
 */

// Admin emails. Read from the ADMIN_EMAILS Script Property at request
// time (so add-an-admin is a one-click editor change, no redeploy),
// and fall back to ADMIN_EMAILS_FALLBACK if the property is unset --
// guarantees the original deployer keeps access even on a fresh
// project where Script Properties haven't been populated yet.
//
// Script Property format: comma-separated emails, e.g.
//   "robin.choudhury@universalmedsupply.com,other@universalmedsupply.com"
// Whitespace around commas is trimmed; case is folded by callers
// (isAdmin_ in Auth.gs).
const ADMIN_EMAILS_FALLBACK = Object.freeze([
  'robin.choudhury@universalmedsupply.com',
]);

// Public read accessor used by Auth.gs / Alerts.gs / CompanyOverview.gs.
// Returns a fresh array each call so callers can mutate safely.
function getAdminEmails_() {
  const raw = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS');
  if (!raw) return ADMIN_EMAILS_FALLBACK.slice();
  const out = raw.split(',')
    .map(function (s) { return String(s || '').trim(); })
    .filter(function (s) { return !!s; });
  return out.length ? out : ADMIN_EMAILS_FALLBACK.slice();
}

// Sheet names. Roster sheet is the existing "DO NOT EDIT!" tab; the
// Access Control sheet is auto-created by setup_() on first run if
// missing. Queue extensions are parsed inline from the roster cells
// (e.g. "Robin Choudhury, 139"), so no separate Department Queues
// sheet is needed.
const SHEETS = Object.freeze({
  HISTORICAL: 'DQE Historical Data',
  ROSTER: 'DO NOT EDIT!',
  ACCESS_CONTROL: 'Access Control',
  ALERT_CONFIG: 'Alert Config',
  ALERT_LOG: 'Alert Log',
  PIPELINE_HEALTH: 'Pipeline Health',
  DIGEST_CONFIG: 'Digest Config',
  AGENT_ALIAS_OVERRIDES: 'Agent Alias Overrides',
  ORPHAN_FIX_LOG: 'Orphan Fix Log',
  DEPT_CONFIG: 'Dept Config',
  REPORT_USAGE: 'Report Usage',
  QUEUE_REPORT_SUBSCRIBERS: 'Queue Report Subscribers',
});

const ACCESS_CONTROL_HEADERS = Object.freeze(['Email', 'Department', 'Notes']);
const ALERT_CONFIG_HEADERS   = Object.freeze(['Department', 'Threshold %', 'Extra Recipients', 'Active', 'Notes', 'Skip Dates']);
const ALERT_LOG_HEADERS      = Object.freeze([
  'Timestamp', 'Department', 'Date Checked', 'Threshold %', 'Answer Rate %',
  'Sent', 'Recipients', 'Triggered By', 'Notes', 'Status',
]);
// Pipeline Health: append-only telemetry of daily-pipeline steps.
// Step is free-form; current writers emit 'autoImport', 'buildDQE',
// 'processIntegratedHistory:CDR' / ':QPath' / ':QCD' / ':CSR' / ':DQE'
// / ':Inbound', 'bulkBackfill:DQE', and 'inboundBackfill' (see
// INV-44). New steps don't require a schema bump. Status is 'success' or
// 'failure'. Rows is the count of rows the step touched (e.g. CSV
// rows imported, DQE rows written); empty when not meaningful.
// Duration is in milliseconds; Notes is free-form (typically an
// error message on failure or a brief summary on success).
const PIPELINE_HEALTH_HEADERS = Object.freeze([
  'Timestamp', 'Step', 'Status', 'Rows', 'Duration (ms)', 'Notes',
]);
// Digest Config: per-recipient subscription rows. Cadence is one of
// 'daily' (sends each weekday morning for the previous day's data),
// 'weekly' (sends Monday morning for the prior Mon-Fri window), or
// 'monthly' (sends on the 1st for the prior calendar month).
// Format (col F, appended non-destructively like Alert Config's Skip
// Dates -- pre-existing sheets keep their 5-col header and read as
// 'summary'): 'summary' = the KPI-tile digest (default); 'insights' =
// the Insights-report digest (team rollup deltas + a per-agent delta
// table vs the cadence-appropriate prior window).
// Active=FALSE pauses without deleting. Edited by admins by hand;
// no in-app form.
const DIGEST_CONFIG_HEADERS = Object.freeze([
  'Email', 'Department', 'Cadence', 'Active', 'Notes', 'Format',
]);
// Queue Report Subscribers: opt-in recipient list for the automated
// "Daily Call Queue Report" email (the all-departments QCD snapshot for the
// previous workday). One row per email; Active=FALSE pauses without deleting.
// Managed by admins via the Alerts modal's "Daily Call Queue Report" section
// (QueueReportEmail.gs); the report is company-wide, so there is no per-dept
// column -- every subscriber receives the full all-departments report.
const QUEUE_REPORT_SUBSCRIBERS_HEADERS = Object.freeze([
  'Email', 'Active', 'Notes',
]);
// Agent Alias Overrides: persistent rename map used by the CDR
// pipeline's loadRosterCanonicalNames_ on every build. Each row
// says "if you see this raw name from the CDR feed, write it under
// this canonical roster name." Maintained by admins via the Orphan
// Fix modal; manual edits via the sheet are also fine.
//   Old Name      = the raw name we keep seeing as an orphan
//   Canonical Name = the roster name to consolidate it under
//   Active         = TRUE/FALSE (pause without deleting)
const AGENT_ALIAS_OVERRIDES_HEADERS = Object.freeze([
  'Old Name', 'Canonical Name', 'Active', 'Added By', 'Added At', 'Notes',
]);
// Orphan Fix Log: append-only audit trail of admin-driven orphan
// fixes (alias adds + backfill renames). Affected Rows is the
// number of DQE Historical Data rows changed by a backfill rename,
// 0 for alias-only additions.
const ORPHAN_FIX_LOG_HEADERS = Object.freeze([
  'Timestamp', 'Admin', 'Action', 'From Name', 'To Name',
  'Affected Rows', 'Notes',
]);
// Dept Config: admin-authored, no-redeploy overrides for the per-dept
// maps that used to be hardcoded constants below (DEPT_QCD_QUEUES,
// OVERVIEW_PARENT_OF, TEAM_AVG_EXCLUDES). Written ONLY by the admin
// Dept Config modal (DeptConfig.gs) -- a config write path, so it is
// admin-gated (assertAdmin_) per INV-01 but does NOT mutate DQE
// Historical Data. Read by the accessors getDeptQcdQueues_ /
// getOverviewParentMap_ / getTeamAvgExcludes_ in DeptConfig.gs, which
// layer the sheet OVER the frozen constants: a non-empty field in an
// Active row overrides the constant for that dept; an empty field
// falls back to the constant. Missing/absent sheet => pure constant
// behavior (so pre-setup installs are unaffected). See INV-54.
//   Department        = dept name; must match a DO NOT EDIT! header
//   QCD Queues        = comma-separated A_Q_* queue names (overrides DEPT_QCD_QUEUES[dept])
//   Overview Parent   = parent dept name (overrides OVERVIEW_PARENT_OF[dept]); blank = no nesting override
//   Team Avg Excludes = comma-separated roster names (overrides TEAM_AVG_EXCLUDES[dept])
//   Queue Ext Overrides = comma-separated digit extensions (overrides DEPT_QUEUE_EXT_OVERRIDES[dept]); REPLACES the data-derived queue-ext set for scope/sentinel matching
//   Active            = TRUE/FALSE (pause without deleting)
//   Inbound Queue Aliases = comma-separated RAW inbound queue names (the
//     A_Q_* / "Backup CSR" spellings the phone system emits into
//     inbound_calls.entry_queue/final_queue) that belong to this dept but
//     differ from its QCD-canonical names. Unioned with queuesForDept_ ONLY
//     for the per-dept Inbound report + per-call journey attribution, to
//     bridge the two queue-name spaces (e.g. CSR's raw "A_Q_CSR" vs QCD
//     "A_Q_CustomerSuccess"). Appended at the END (non-destructive: pre-
//     existing 9-col prod sheets keep working; readDeptConfigRows_ reads it
//     positionally, empty until an admin fills it). See INV-54.
const DEPT_CONFIG_HEADERS = Object.freeze([
  'Department', 'QCD Queues', 'Overview Parent', 'Team Avg Excludes',
  'Queue Ext Overrides', 'Active', 'Updated By', 'Updated At', 'Notes',
  'Inbound Queue Aliases',
]);
// Report Usage: append-only telemetry of report opens, written by
// Util.gs::logReportUsage_ from the public report endpoints. This is
// the documented INV-01 TELEMETRY CARVE-OUT: append-only, fixed
// schema, no user-controlled free text (Report is a code constant;
// Department is validated against real depts before logging), and
// best-effort (a missing sheet or a write failure silently no-ops --
// telemetry must never block or fail a report). Exists to give the
// report-consolidation decisions (PR/CR retirement) real usage
// evidence. Readers: SystemHealth.gs::computeReportUsageSummary_
// (the Health page's "Report usage (last 30 days)" section -- runs /
// unique users / manager runs / cache-hit rate per report), or the
// operator directly in the sheet (pivot by Report / Email).
const REPORT_USAGE_HEADERS = Object.freeze([
  'Timestamp', 'Report', 'Department', 'Role', 'Email', 'Cache Hit',
]);

// Layout of the "DO NOT EDIT!" roster sheet. Centralized so a future
// row/column shift is a one-line edit. The right-block (departments +
// agents) starts at column F. The dept block ends at the first blank
// cell in the header row -- columns past that gap (currently X-AG)
// hold unrelated reference data that should be ignored.
const ROSTER = Object.freeze({
  HEADER_ROW: 1,         // dept names + left-block "Call Queue" headers
  DATA_START_ROW: 2,     // agent names + queue/extension rows begin here
  DEPT_FIRST_COL: 6,     // column F
  QUEUE_NAME_COL: 1,     // column A: queue name
  QUEUE_EXT_COL: 2,      // column B: comma-separated extensions
});

// Column positions in the "DQE Historical Data" sheet (1-indexed).
// Centralized so a column shift is a one-line edit. Row 1 is headers;
// data starts in row 2.
const HISTORICAL_COLS = Object.freeze({
  MONTH_YEAR: 1,         // A
  DATE: 2,               // B
  AGENT: 3,              // C
  QUEUE_EXT: 4,          // D - comma-separated extensions
  TOTAL_UNIQUE: 5,       // E
  TOTAL_RUNG: 6,         // F
  TOTAL_MISSED: 7,       // G
  TOTAL_ANSWERED: 8,     // H
  TTT: 9,                // I - H:MM:SS
  ATT: 10,               // J - H:MM:SS
  TIME_SLOTS_START: 11,  // K - first half-hour time-slot column
  TIME_SLOTS_END: 29,    // AC - last half-hour time-slot column
  ABANDONED_PARENT_IDS: 30,   // AD
  ABANDONED_MISSED_TIMES: 32, // AF
  AVG_ABD_WAIT: 33,      // AG - H:MM:SS
  CSR_AVG_ABD_WAIT: 34,  // AH - H:MM:SS
});

// Sentinel written into abandoned-ID/time cells (AD/AE/AF) whose original
// comma-joined values were LOST to the Sheets number-coercion bug (multi-value
// strings coerced past 2^53; see sheetRepairs.js / neonbackfill.js in cdr-report
// + the read-side classifyAbandonedCell_ in Util.gs). Distinguishes "data was
// corrupted, rebuild from Raw Data" from a genuinely-empty "0 abandoned" cell,
// and is NEVER split-and-counted as a real call ID. Must match the literal used
// by the cdr-report sanitizer/repair.
const DQE_ABANDONED_LOST_SENTINEL = '#REBUILD';

// Column positions in the "QCD Historical Data" sheet (1-indexed).
// Sheet is written by apps-script/cdr-import/autoImport.js
// (processIntegratedHistory's QCD block); schema is one row per
// (dept, callSource, date) tuple. Total Calls source carries the
// daily totals; other sources break down by call origin.
const QCD_HISTORICAL_COLS = Object.freeze({
  MONTH_YEAR:     1,     // A
  WEEK:           2,     // B
  DATE:           3,     // C
  CALL_QUEUE:     4,     // D - raw queue names (A_Q_CustomerSuccess, A_Q_Sales, Backup CSR, etc.)
  CALL_SOURCE:    5,     // E - "Total Calls" | "CSR" | "Ad-campaign" | "New Call Menu" | "Non-CSR (internal)"
  TOTAL_CALLS:    6,     // F
  TOTAL_ANSWERED: 7,     // G
  ABANDONED:      8,     // H
  LONGEST_WAIT:   9,     // I - H:MM:SS
  AVG_ANSWER:    10,     // J - H:MM:SS
  ABANDONED_PCT: 11,     // K - 0..1 (decimal, NOT percent)
  VIOLATIONS:    12,     // L - count of days/sources where abandonedPct > 5%
});

// Fallback timezone for formatting Date objects from spreadsheet
// cells when the spreadsheet's own TZ isn't passed explicitly.
// Production reads in computeSummary_ pass the spreadsheet's TZ
// (via getSpreadsheetTimeZone) so this fallback is rarely used.
// Set to America/Chicago to match appsscript.json runtime TZ.
const TZ = 'America/Chicago';

// CacheService TTL for aggregated department results.
// Kept at 5 min for freshness-sensitive lookups (latest-data date + the
// header freshness pill) so today's morning ingest surfaces promptly.
const CACHE_TTL_SECONDS = 5 * 60;

// Longer TTL for the heavy per-(dept,range) report aggregations
// (My Department summary, Overview, Individual / Performance / Compare /
// QCD / Missed, active-agents picker). DQE data updates once daily, so a
// 30-min cache is safe for historical windows and cuts how often a reader
// does a fresh read -- which in turn reduces how often the Neon read-back
// (when DQE_READ_SOURCE=neon) hits a cold free-tier instance. Tradeoff:
// ad-hoc admin corrections (orphan renames, DQE rebuilds) can take up to
// this long to appear in cached views that aren't explicitly busted on
// write. Orphan Fix already busts the relevant caches; a Dept Config save
// busts COMPANY_OVERVIEW_CACHE_KEY.
const REPORT_CACHE_TTL_SECONDS = 30 * 60;

// Shorter TTL for identity/access lookups so new managers don't have to
// wait 5 minutes after being added to the Access Control sheet.
const AUTH_CACHE_TTL_SECONDS = 60;

// Override: which queue extensions count as belonging to a given dept,
// for the Missed Calls Report's queue-only (no-agent-rang) sentinel
// matching. Use when a dept's agents ring across queues that belong to
// OTHER depts -- without an override, the data-derived fallback would
// pull those other queues' abandons into this dept's chart.
//
// Most depts have a single queue, so the data-derived fallback (queue
// extensions observed on this dept's roster agents' col D) is fine and
// no entry is needed here. Add an entry only when a dept's agents cover
// queues that should NOT count toward this dept.
//
// Entries here REPLACE the derived set entirely for that dept.
const DEPT_QUEUE_EXT_OVERRIDES = Object.freeze({
  // CSR's CSR agents also ring on A_Q_Spanish (ext 138), but Spanish
  // metrics are tracked separately and should not be folded into CSR.
  'CSR': ['103', '108', '1003'],   // A_Q_CSR, A_Q_Intake, Backup CSR
});

// Per-dept QCD queue mapping. `QCD Historical Data`'s `Call Queue`
// column (col D) carries raw queue names like "A_Q_CSR" / "Backup CSR",
// NOT dashboard dept names like "CSR" -- the legacy `buildTable4` in
// dqe-report/DQEdashboard.js had a misleading filter that suggested
// otherwise. To filter QCD rows for a dashboard dept, look up the
// list of queue names here.
//
// Used by:
//   - QCDReport.gs (per-dept ranged report)
//   - CompanyOverview.gs::computeQcdSnapshots_ (per-dept tile snapshot)
//   - Data.gs::computeSummary_ (My Department's daily QCD snapshot)
//
// Values are exact strings from the QCDR Output sheet's column A,
// which the import pipeline writes to `QCD Historical Data` col D.
// Verify against the actual sheet after a fresh ingest; add or edit
// rows here as new depts come online.
const DEPT_QCD_QUEUES = Object.freeze({
  'CSR':       ['A_Q_CustomerSuccess', 'A_Q_Intake', 'Backup CSR'],
  'Sales':     ['A_Q_Sales'],
  'PAP':       ['A_Q_PAP'],
  'Power':     ['A_Q_PowerChairs'],
  'PAK':       ['A_Q_PAK'],
  'Resupply':  ['A_Q_Resupply'],
  'Spanish':   ['A_Q_Spanish'],
  'Billing':   ['A_Q_Billing'],
  'Denials':   ['A_Q_Denials'],
  'Service':   ['A_Q_Service'],
  'FieldOps':  ['A_Q_FieldOps', 'A_Q_BackUp_FieldOps', 'A_Q_FieldOps_Power'],
  // Sub-queue rollup: viewing a PARENT dept (per OVERVIEW_PARENT_OF
  // in CompanyOverview.gs) automatically expands to include its
  // children's queues -- so Sales picks up PAP's queues, Power
  // picks up PAK's, CSR picks up Spanish's. Each child dept still
  // gets its own listing here so the child's own modal works.
  // Implemented in queuesForDept_ (QCDReport.gs); CompanyOverview
  // and Data.gs go through the same helper so all three QCD
  // readers stay consistent.
});

// Per-dept agent names excluded from the Individual Report's team
// average (numerator AND denominator). Used for managers who are on
// the roster but only take a token number of calls -- including them
// drags the team-avg unrealistically low.
//
// Match must be EXACT (case + whitespace) against the agent's roster
// name. To exclude the same person from multiple depts, list them
// under each dept.
const TEAM_AVG_EXCLUDES = Object.freeze({
  // CSR's manager is on the roster but takes only a token number of
  // calls; including in the average drags it artificially low.
  'CSR': ['Robin Choudhury'],
});

/**
 * Human-readable work-window strings surfaced as a pill on the My
 * Department page so managers see at a glance what time-of-day the
 * Rung / Missed / Answered / TTT / ATT columns are scoped to. The
 * pipeline's source-of-truth lives in cdr-import's buildDQEHistoricalData.js
 * (DQE_WINDOW_START / DQE_WINDOW_END, per INV-06). If those upstream
 * constants ever change, sync these strings too -- the dashboard
 * doesn't read the constants directly because they're in a sibling
 * Apps Script project, but they need to agree.
 */
const DASHBOARD_WORK_WINDOW = Object.freeze({
  pst: '6:30 AM – 3:00 PM PST',
  cst: '8:30 AM – 5:00 PM CST',
});

/**
 * Returns the SPREADSHEET_ID Script Property. Throws a clear error if
 * unset so first-run misconfiguration is obvious in the execution log.
 */
function getSpreadsheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error(
      "Script Property 'SPREADSHEET_ID' is not set. " +
      "Open Project Settings > Script Properties, add SPREADSHEET_ID with " +
      "the CDR Report spreadsheet ID, then re-run."
    );
  }
  return id;
}

function openSpreadsheet_() {
  return SpreadsheetApp.openById(getSpreadsheetId_());
}

/**
 * R7 (G-3): admin UI-surface toggles. An admin lists keys in the `UI_FLAGS`
 * Script Property (comma-separated; managed from the Health page's
 * "UI surface toggles" editor) to HIDE a client surface for ALL viewers while
 * something is being fixed or investigated. Presentation-only by design: no
 * server compute, cache, or auth gate changes — the flags ride into the page
 * as `window.__UI_FLAGS__` (renderDashboard_) and apply via
 * `body[data-ui-flags~="key"]` CSS rules in styles.html (plus a couple of
 * fetch gates in script.html so hidden sections don't still fetch). Viewers
 * pick up a change on their next page load — no redeploy.
 *
 * CURATED registry: unknown keys in the property are silently dropped
 * (uiFlagsSanitize_, the Skip Dates tolerant-grammar discipline). Adding a
 * surface = a key here + a CSS rule (styles.html) + an optional fetch gate.
 */
const UI_FLAG_SURFACES = Object.freeze({
  'dept-team-strip':     'My Department — team summary strip',
  'dept-queue-tiles':    'My Department — Queue calls / Abandoned % tiles',
  'dept-missed-section': 'My Department — Missed Calls section',
  'dept-qcd-side':       'My Department — Queue Call Data side card',
  'ov-user-table':       'Overview — dept agent mini-table',
  'ins-heatmap':         'Insights — abandon heatmap (admin panel)',
  'ins-queue-health':    'Insights — Queue health section',
  'report-headlines':    'Reports — answer-first summary banners (On track / Watch)',
});

/**
 * Answer-rate standards (admin-tunable DISPLAY thresholds).
 *
 * The company answer-% target drives the display/tone layer only --
 * benchmark tints (benchValueCls_), the "On track / Watch" headline tones,
 * the Overview chart baseline, the Insights calendar coloring, the Direct /
 * Inbound tone rails, and the digest verdict pill. Admin-tunable WITHOUT a
 * redeploy via the `ANSWER_TARGETS` Script Property (edited from the Alerts
 * modal's "Answer-rate standards" section), parsed as tolerant `key=value`
 * pairs (the DIAL_IN_LABELS grammar): `global=92, direct=80`. Each surface
 * falls back to `global`; `global` falls back to the seed default below.
 *
 * CURATED registry (the UI_FLAG_SURFACES discipline): unknown keys are
 * silently dropped. `direct` / `inbound` exist because those reports'
 * answer rates are DIFFERENT POPULATIONS (direct-extension calls with the
 * busy carve-out; share-of-inbound-calls) than the queue-call rate the
 * 92% standard was set for.
 *
 * Deliberately NOT covered: the 5% abandon threshold (baked into the QCD
 * Violations history written at import time, INV-50 -- making it tunable
 * would desync tints from recorded violation counts) and the per-dept
 * ALERT thresholds (Alert Config rows, INV-34 -- already admin-editable).
 */
const ANSWER_TARGET_DEFAULT = 92;
const ANSWER_TARGET_SURFACES = Object.freeze({
  global:  'All answer-% surfaces (tints, headlines, chart baseline, digest verdict)',
  direct:  'Direct Call report — direct-extension answer rate (busy-excluded)',
  inbound: 'Inbound report — share of inbound calls answered',
});
