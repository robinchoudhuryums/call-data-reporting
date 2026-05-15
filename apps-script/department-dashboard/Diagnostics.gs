/**
 * Editor-only diagnostics. Run from the Apps Script "Run" dropdown
 * to introspect the sheet shapes and verify the parsing assumptions.
 * Output goes to the Execution log (View > Logs / Executions).
 */

/**
 * Dumps the first few rows of DQE Historical Data showing how each
 * date cell parses, and checks whether the first row's agent name
 * appears in any department roster. Use this to diagnose date-filter
 * or roster-match bugs.
 */
function diagnoseDate() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) {
    Logger.log('Historical sheet "%s" not found.', SHEETS.HISTORICAL);
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('Historical sheet has no data rows.');
    return;
  }

  const ssTZ = ss.getSpreadsheetTimeZone();
  Logger.log('Spreadsheet TZ: %s | Script TZ: %s',
             ssTZ, Session.getScriptTimeZone());
  Logger.log('');
  Logger.log('=== Historical Data sample (first 5 rows) ===');
  const numToShow = Math.min(5, lastRow - 1);
  const values = sheet.getRange(2, 1, numToShow, HISTORICAL_COLS.AGENT).getValues();

  for (let i = 0; i < values.length; i++) {
    const dateCell = values[i][HISTORICAL_COLS.DATE - 1];
    const agentCell = values[i][HISTORICAL_COLS.AGENT - 1];
    const dateType = (dateCell instanceof Date) ? 'Date' : typeof dateCell;
    const dateRaw = (dateCell instanceof Date)
      ? dateCell.toISOString()
      : JSON.stringify(dateCell);
    Logger.log('Row %s: dateType=%s dateRaw=%s parsedIso="%s" agent="%s"',
               i + 2, dateType, dateRaw,
               rowDateIso_(dateCell, ssTZ),
               String(agentCell));
  }

  Logger.log('');
  Logger.log('=== Roster sample ===');
  const depts = getAllDepartments_();
  Logger.log('Departments found: %s -> %s',
             depts.length, JSON.stringify(depts));
  if (depts.length) {
    const first = depts[0];
    const agents = getAgentsForDepartment_(first);
    Logger.log('Roster for "%s": %s agent(s)', first, agents.length);
    Logger.log('Sample agents (first 5): %s',
               JSON.stringify(agents.slice(0, 5)));
  }

  Logger.log('');
  Logger.log('=== Agent match check (row 2 of historical) ===');
  if (values.length) {
    const histAgent = String(values[0][HISTORICAL_COLS.AGENT - 1] || '').trim();
    Logger.log('Historical row 2 agent: "%s" (len=%s)',
               histAgent, histAgent.length);
    // Char codes can reveal hidden whitespace (NBSP, ZWSP, etc.)
    const codes = [];
    for (let i = 0; i < histAgent.length; i++) {
      codes.push(histAgent.charCodeAt(i));
    }
    Logger.log('Agent char codes: %s', JSON.stringify(codes));

    const foundIn = [];
    for (let i = 0; i < depts.length; i++) {
      const roster = getAgentsForDepartment_(depts[i]);
      if (roster.indexOf(histAgent) !== -1) foundIn.push(depts[i]);
    }
    Logger.log('Found in rosters: %s',
               foundIn.length ? JSON.stringify(foundIn) : '(none)');
  }
}

/**
 * Surveys all departments for a given date. Shows how many roster
 * agents have at least one row in the historical sheet on TEST_DATE,
 * and lists any historical agents on that date who aren't in any
 * roster (orphans -- usually a typo or alias mismatch).
 *
 * Edit TEST_DATE below before running.
 */
function whyNoMatches() {
  const TEST_DATE = '2026-03-09';  // YYYY-MM-DD

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) { Logger.log('Historical sheet not found.'); return; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No data rows.'); return; }

  const ssTZ = ss.getSpreadsheetTimeZone();
  const values = sheet
    .getRange(2, 1, lastRow - 1, HISTORICAL_COLS.AGENT)
    .getValues();

  const onDateAgents = {};
  let onDateRows = 0;
  for (let i = 0; i < values.length; i++) {
    const dateIso = rowDateIso_(values[i][HISTORICAL_COLS.DATE - 1], ssTZ);
    if (dateIso !== TEST_DATE) continue;
    onDateRows++;
    const agent = String(values[i][HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;
    // Skip queue-sentinel rows (queue-only abandoned data); these aren't
    // real agents and would noisily appear as orphans here.
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;
    onDateAgents[agent] = true;
  }

  Logger.log('=== whyNoMatches: %s ===', TEST_DATE);
  Logger.log('Rows on %s: %s', TEST_DATE, onDateRows);
  Logger.log('Unique agents on %s: %s',
             TEST_DATE, Object.keys(onDateAgents).length);

  const depts = getAllDepartments_();
  const allRosterAgents = {};
  Logger.log('');
  Logger.log('Per-dept match counts:');
  for (let i = 0; i < depts.length; i++) {
    const roster = getAgentsForDepartment_(depts[i]);
    let matched = 0;
    for (let j = 0; j < roster.length; j++) {
      allRosterAgents[roster[j]] = true;
      if (onDateAgents[roster[j]]) matched++;
    }
    Logger.log('  %s: %s of %s roster agents have data on %s',
               depts[i], matched, roster.length, TEST_DATE);
  }

  const orphans = [];
  for (const a in onDateAgents) {
    if (!allRosterAgents[a]) orphans.push(a);
  }
  Logger.log('');
  if (orphans.length) {
    Logger.log('Agents in historical NOT in ANY roster (%s): %s',
               orphans.length, JSON.stringify(orphans));
  } else {
    Logger.log('All historical agents on this date are in some roster.');
  }
}

/**
 * Dumps the raw cell values and types for TTT, ATT, and the
 * abandoned-wait columns on the first 5 historical rows, alongside
 * what toSeconds_ parses them to and what the dashboard would
 * reformat them as. Use to diagnose H:MM:SS mismatches between the
 * dashboard and the source sheet.
 */
function diagnoseTimes() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) { Logger.log('Historical sheet not found.'); return; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No data rows.'); return; }

  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;

  // Print the header row first so we can verify columns match what
  // HISTORICAL_COLS expects.
  const headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  Logger.log('=== Header row (first %s columns) ===', numCols);
  const expected = {
    1: 'MONTH_YEAR', 2: 'DATE', 3: 'AGENT', 4: 'QUEUE_EXT',
    5: 'TOTAL_UNIQUE', 6: 'TOTAL_RUNG', 7: 'TOTAL_MISSED',
    8: 'TOTAL_ANSWERED', 9: 'TTT', 10: 'ATT',
    33: 'AVG_ABD_WAIT', 34: 'CSR_AVG_ABD_WAIT',
  };
  for (let c = 1; c <= numCols; c++) {
    const tag = expected[c] ? '  <- ' + expected[c] : '';
    Logger.log('  Col %s (%s): "%s"%s',
               c, columnLetter_(c), headers[c - 1], tag);
  }
  Logger.log('');

  const numToShow = Math.min(5, lastRow - 1);
  const values = sheet.getRange(2, 1, numToShow, numCols).getValues();

  Logger.log('=== Time-column sample (first 5 rows) ===');
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const agent = r[HISTORICAL_COLS.AGENT - 1];
    const answered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    const ttt = r[HISTORICAL_COLS.TTT - 1];
    const att = r[HISTORICAL_COLS.ATT - 1];
    const aaw = r[HISTORICAL_COLS.AVG_ABD_WAIT - 1];
    const caw = r[HISTORICAL_COLS.CSR_AVG_ABD_WAIT - 1];

    Logger.log('Row %s | agent="%s" | answered=%s', i + 2, agent, answered);
    Logger.log('  TTT  -> type=%s raw=%s parsed=%s sec reformatted=%s',
               typeOfCell_(ttt), JSON.stringify(ttt),
               toSeconds_(ttt), formatHms_(toSeconds_(ttt)));
    Logger.log('  ATT  -> type=%s raw=%s parsed=%s sec reformatted=%s',
               typeOfCell_(att), JSON.stringify(att),
               toSeconds_(att), formatHms_(toSeconds_(att)));
    Logger.log('  AvgAbdWait    -> type=%s raw=%s parsed=%s sec',
               typeOfCell_(aaw), JSON.stringify(aaw), toSeconds_(aaw));
    Logger.log('  CSRAvgAbdWait -> type=%s raw=%s parsed=%s sec',
               typeOfCell_(caw), JSON.stringify(caw), toSeconds_(caw));

    const tttSec = toSeconds_(ttt);
    const computedAtt = answered ? Math.round(tttSec / answered) : 0;
    Logger.log('  Dashboard ATT for this row alone = TTT/Answered = %s sec = %s',
               computedAtt, formatHms_(computedAtt));
    Logger.log('');
  }
}

function typeOfCell_(v) {
  if (v instanceof Date) return 'Date';
  if (v === null) return 'null';
  return typeof v;
}

function formatHms_(seconds) {
  seconds = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return h + ':' + pad(m) + ':' + pad(s);
}

function columnLetter_(col) {
  let s = '';
  let n = col;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Reads a single cell from DQE Historical Data and prints both the
 * underlying value (what getValue() returns -- what the dashboard
 * sees) and the display value (the formatted string the user sees).
 * Disagreement between the two means a formula, custom number format,
 * or some other display vs. storage divergence.
 *
 * Edit ADDRESS below before running. A1 notation, e.g. "I6", "J6",
 * "AG6", "AH6".
 */
function dumpCell() {
  const ADDRESS = 'I6';  // edit this to inspect a different cell

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) { Logger.log('Historical sheet not found.'); return; }

  const range = sheet.getRange(ADDRESS);
  const value = range.getValue();
  const display = range.getDisplayValue();
  const formula = range.getFormula();
  const numberFormat = range.getNumberFormat();

  Logger.log('=== Cell %s in "%s" ===', ADDRESS, SHEETS.HISTORICAL);
  Logger.log('Display value (what you see):  "%s"', display);
  Logger.log('Raw value (what code reads):    type=%s value=%s',
             (value instanceof Date) ? 'Date'
               : (value === null ? 'null' : typeof value),
             JSON.stringify(value));
  Logger.log('Formula (if any):               "%s"', formula);
  Logger.log('Number format:                  "%s"', numberFormat);
  Logger.log('toSeconds_(value):              %s', toSeconds_(value));
  Logger.log('reformatted by dashboard:       %s',
             formatHms_(toSeconds_(value)));
}
