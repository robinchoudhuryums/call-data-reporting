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
               rowDateIso_(dateCell),
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

  const values = sheet
    .getRange(2, 1, lastRow - 1, HISTORICAL_COLS.AGENT)
    .getValues();

  const onDateAgents = {};
  let onDateRows = 0;
  for (let i = 0; i < values.length; i++) {
    const dateIso = rowDateIso_(values[i][HISTORICAL_COLS.DATE - 1]);
    if (dateIso !== TEST_DATE) continue;
    onDateRows++;
    const agent = String(values[i][HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (agent) onDateAgents[agent] = true;
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
