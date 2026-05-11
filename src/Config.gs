/**
 * Department Dashboard - configuration constants.
 *
 * SPREADSHEET_ID is read from Script Properties so the same code can
 * point at dev/prod copies without edits. Set it once via:
 *   Project Settings > Script Properties > Add property
 *     name:  SPREADSHEET_ID
 *     value: <id from the CDR Report sheet URL>
 */

// Admins bypass the manager mapping and can pick any department.
// Add more emails here as needed; redeploys are required for changes.
const ADMIN_EMAILS = Object.freeze([
  'robin.choudhury@universalmedsupply.com',
]);

// Sheet names. Roster sheet is the existing "DO NOT EDIT!" tab; the
// other two are auto-created by setup_() on first run if missing.
const SHEETS = Object.freeze({
  HISTORICAL: 'DQE Historical Data',
  ROSTER: 'DO NOT EDIT!',
  ACCESS_CONTROL: 'Access Control',
  DEPT_QUEUES: 'Department Queues',
});

const ACCESS_CONTROL_HEADERS = Object.freeze(['Email', 'Department', 'Notes']);
const DEPT_QUEUES_HEADERS = Object.freeze(['Department', 'Queue Extensions']);

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
