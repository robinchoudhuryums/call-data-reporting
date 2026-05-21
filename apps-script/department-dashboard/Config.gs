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

// Backwards-compatible: existing code reads `ADMIN_EMAILS[0]` and
// `ADMIN_EMAILS.join(',')` directly. Defining ADMIN_EMAILS as a getter
// at module-load time would freeze the value at script start (Script
// Properties read once), and Apps Script can't redefine the binding
// for callers reading the symbol on each request. Instead, leave
// ADMIN_EMAILS as a frozen reference to the fallback (for the
// access_denied template's mailto link, which doesn't need to be
// dynamic) and point all auth/alert paths at getAdminEmails_().
const ADMIN_EMAILS = ADMIN_EMAILS_FALLBACK;

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
});

const ACCESS_CONTROL_HEADERS = Object.freeze(['Email', 'Department', 'Notes']);
const ALERT_CONFIG_HEADERS   = Object.freeze(['Department', 'Threshold %', 'Extra Recipients', 'Active', 'Notes']);
const ALERT_LOG_HEADERS      = Object.freeze([
  'Timestamp', 'Department', 'Date Checked', 'Threshold %', 'Answer Rate %',
  'Sent', 'Recipients', 'Triggered By', 'Notes', 'Status',
]);
// Pipeline Health: append-only telemetry of daily-pipeline steps.
// Step is one of: 'autoImport', 'buildDQE', 'neonWrite' (free-form;
// new steps don't require a schema bump). Status is 'success' or
// 'failure'. Rows is the count of rows the step touched (e.g. CSV
// rows imported, DQE rows written); empty when not meaningful.
// Duration is in milliseconds; Notes is free-form (typically an
// error message on failure or a brief summary on success).
const PIPELINE_HEALTH_HEADERS = Object.freeze([
  'Timestamp', 'Step', 'Status', 'Rows', 'Duration (ms)', 'Notes',
]);
// Digest Config: per-recipient subscription rows. Cadence is one of
// 'daily' (sends each weekday morning for the previous day's data)
// or 'weekly' (sends Monday morning for the prior Mon-Fri window).
// Active=FALSE pauses without deleting. Edited by admins by hand;
// no in-app form.
const DIGEST_CONFIG_HEADERS = Object.freeze([
  'Email', 'Department', 'Cadence', 'Active', 'Notes',
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
  AVG_ABD_WAIT: 33,      // AG - H:MM:SS
  CSR_AVG_ABD_WAIT: 34,  // AH - H:MM:SS
});

// Column positions in the "QCD Historical Data" sheet (1-indexed).
// Sheet is written by apps-script/cdr-import/autoImport.js
// (processIntegratedHistory's QCD block); schema is one row per
// (dept, callSource, date) tuple. Total Calls source carries the
// daily totals; other sources break down by call origin.
const QCD_HISTORICAL_COLS = Object.freeze({
  MONTH_YEAR:     1,     // A
  WEEK:           2,     // B
  DATE:           3,     // C
  CALL_QUEUE:     4,     // D - dept-name-like ("CSR", "Sales", "Power", etc.)
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
const CACHE_TTL_SECONDS = 5 * 60;

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
