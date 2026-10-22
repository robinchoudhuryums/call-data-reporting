/**
 * Editor-only diagnostics. Run from the Apps Script "Run" dropdown
 * to introspect the sheet shapes and verify the parsing assumptions.
 * Output goes to the Execution log (View > Logs / Executions).
 *
 * CH-1 (broad-scan 2026-10-01): the five tools are NOT `_`-suffixed. The
 * editor's Run dropdown hides private (`_`) functions, so the names the docs
 * told operators to run (whyNoMatches_ above all -- INV-23, conventions,
 * known-issues) could not be picked at all. Un-suffixed means RPC-reachable
 * too, so each one starts with assertAdmin_() (the auditQueueSplitAttribution
 * pattern); they only read and Logger.log, so INV-01 is untouched. The
 * helpers below them (typeOfCell_, formatHms_, columnLetter_) stay private.
 */

/**
 * Dumps the first few rows of DQE Historical Data showing how each
 * date cell parses, and checks whether the first row's agent name
 * appears in any department roster. Use this to diagnose date-filter
 * or roster-match bugs.
 */
function diagnoseDate() {
  assertAdmin_();   // CH-1: un-suffixed for the Run dropdown, so RPC-reachable
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
  assertAdmin_();   // CH-1: un-suffixed for the Run dropdown, so RPC-reachable
  // CORE-9: defaults to the most recent DQE date so this editor-run
  // diagnostic works out of the box months later; hardcode a YYYY-MM-DD
  // here when investigating a specific historical date.
  const TEST_DATE = getLatestDataDate() || '2026-03-09';

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
  assertAdmin_();   // CH-1: un-suffixed for the Run dropdown, so RPC-reachable
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
  const dataRange = sheet.getRange(2, 1, numToShow, numCols);
  const values   = dataRange.getValues();
  const displays = dataRange.getDisplayValues();

  Logger.log('=== Time-column sample (first 5 rows) ===');
  Logger.log('(display = TZ-safe string the dashboard uses; raw = getValue which has the +36:36 TZ bug)');
  Logger.log('');
  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];
    const agent = r[HISTORICAL_COLS.AGENT - 1];
    const answered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;

    const tttDisplay = rd[HISTORICAL_COLS.TTT - 1];
    const attDisplay = rd[HISTORICAL_COLS.ATT - 1];
    const aawDisplay = rd[HISTORICAL_COLS.AVG_ABD_WAIT - 1];
    const cawDisplay = rd[HISTORICAL_COLS.CSR_AVG_ABD_WAIT - 1];

    const tttRaw = r[HISTORICAL_COLS.TTT - 1];
    const attRaw = r[HISTORICAL_COLS.ATT - 1];

    Logger.log('Row %s | agent="%s" | answered=%s', i + 2, agent, answered);
    Logger.log('  TTT  -> display="%s" (%s sec)  raw=%s (%s sec, may include +36:36 offset)',
               tttDisplay, parseHmsDisplay_(tttDisplay),
               JSON.stringify(tttRaw), toSeconds_(tttRaw));
    Logger.log('  ATT  -> display="%s" (%s sec)  raw=%s (%s sec)',
               attDisplay, parseHmsDisplay_(attDisplay),
               JSON.stringify(attRaw), toSeconds_(attRaw));
    Logger.log('  AvgAbdWait    -> display="%s" (%s sec)',
               aawDisplay, parseHmsDisplay_(aawDisplay));
    Logger.log('  CSRAvgAbdWait -> display="%s" (%s sec)',
               cawDisplay, parseHmsDisplay_(cawDisplay));

    const tttSec = parseHmsDisplay_(tttDisplay);
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
  assertAdmin_();   // CH-1: un-suffixed for the Run dropdown, so RPC-reachable
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

/**
 * Traces the Missed Calls Report's abandoned-call calculation for a
 * single department + date range. Logs:
 *   - The dept's queue-NAME set (missedSentinelQueueNameSet_, the report's
 *     own R6 / R8-1 attribution -- ENG-14: this tool used to match sentinels
 *     by col-D EXTENSION overlap, which the report stopped doing, so its
 *     "== what the report will show" tally disagreed with the report).
 *   - Every queue-sentinel row in range: queue name, whether that NAME is
 *     in the dept's set, col D (informational) and the parent-call IDs in
 *     col AD.
 *   - Every per-agent row in range whose agent IS on the roster:
 *     same info plus the parent IDs from col AD.
 *   - Final tallies: distinct abandoned parent IDs from agent rows,
 *     from sentinel rows, and the union (what abandonedCallCount
 *     should equal).
 *
 * Edit DEPT, FROM, TO below before running.
 */
function diagnoseAbandoned() {
  assertAdmin_();   // CH-1: un-suffixed for the Run dropdown, so RPC-reachable
  // CORE-9: defaults to the most recent DQE date (single-day window) so
  // the editor-run diagnostic works out of the box; hardcode FROM/TO when
  // investigating a specific historical range. NOTE: the
  // HISTORICAL_ABANDONED_PARENT_IDS constant used below lives in
  // MissedCallsReport.gs (Apps Script global scope resolves it) -- this
  // function breaks with a ReferenceError if that file is ever removed.
  const DEPT = 'CSR';
  const LATEST_ = getLatestDataDate() || '2026-05-18';
  const FROM = LATEST_;
  const TO   = LATEST_;

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  // ENG-14 follow-on: this tool reads the SHEET only (DQE_SHEET_ONLY_ALLOWED --
  // it exists to trace cells). On a Neon-read install whose sheet is retired or
  // trimmed, say that, so an empty trace is never read as "no abandons".
  const neonReads = (typeof getDqeReadSource_ === 'function') && getDqeReadSource_() === 'neon';
  const sheetGone = function (why) {
    Logger.log('diagnoseAbandoned: %s.%s', why, neonReads
      ? ' DQE_READ_SOURCE=neon, so the report reads Neon -- this sheet-only trace cannot reproduce it; '
        + 'compare against the Missed report itself (or restore the sheet range) instead.'
      : '');
    return { sheetUnavailable: true, neonReads: !!neonReads };
  };
  if (!sheet) return sheetGone('Historical sheet not found');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return sheetGone('No data rows on the Historical sheet');

  const roster = getRosterForDepartment_(DEPT);
  const rosterSet = {};
  roster.names.forEach(function (n) { rosterSet[n] = true; });

  Logger.log('=== diagnoseAbandoned: %s  %s..%s ===', DEPT, FROM, TO);
  Logger.log('Roster agents (%s): %s',
             roster.names.length, JSON.stringify(roster.names));

  const ssTZ = ss.getSpreadsheetTimeZone();
  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  const values   = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  const displays = sheet.getRange(2, 1, lastRow - 1, numCols).getDisplayValues();

  const dqr = getDeptQueueExts_(DEPT, rosterSet, values);
  const deptQueueExts = dqr.exts;
  Logger.log('Dept queue exts (source=%s; informational -- sentinels are attributed by NAME): %s',
             dqr.source, JSON.stringify(Object.keys(deptQueueExts).sort()));
  // ENG-14: the report's sentinel attribution, from the report's own helper.
  const deptQueueNames = missedSentinelQueueNameSet_(DEPT);
  Logger.log('Dept queue NAMES (the report\'s sentinel match, case-insensitive): %s',
             JSON.stringify(Object.keys(deptQueueNames).sort()));
  // Narrowing: the report narrows slot timelines under QUEUE_SPLIT_SCOPE=dept,
  // but never the AD-derived abandoned counts (ids carry no queue identity),
  // so the tallies below hold under either scope.
  Logger.log('QUEUE_SPLIT_SCOPE=%s (abandoned-call counts are not narrowed in either mode)',
             (typeof getQueueSplitScope_ === 'function') ? getQueueSplitScope_() : 'off');

  const sentinelHits = [];   // matched sentinel rows
  const sentinelMiss = [];   // sentinel rows whose col D didn't overlap
  const agentHits    = [];   // matched agent rows that had any abandoned IDs
  const parentsAgent = {};
  const parentsSentinel = {};

  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];
    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < FROM || dateIso > TO) continue;
    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;

    const isSentinel = /^A_Q_/.test(agent) || agent === 'Backup CSR';
    const colDRaw = String(rd[HISTORICAL_COLS.QUEUE_EXT - 1] || '');
    const rowExts = parseExtensions_(r[HISTORICAL_COLS.QUEUE_EXT - 1]);
    // Col-D extension overlap, logged for context only (ENG-14: no longer
    // the sentinel test -- the report attributes sentinels by queue NAME).
    const matchedExt = [];
    for (let j = 0; j < rowExts.length; j++) {
      if (deptQueueExts[rowExts[j]]) matchedExt.push(rowExts[j]);
    }
    // Guard against coerced/lost abandoned cells so a corrupted value isn't
    // counted as fake parent IDs (mirrors the Missed report's read-side guard).
    const adClass = classifyAbandonedCell_(rd[HISTORICAL_ABANDONED_PARENT_IDS - 1]);
    const adIds = (adClass.lost || !adClass.value) ? []
                : adClass.value.split(',').map(function (s) { return s.trim(); })
                               .filter(function (s) { return !!s; });

    if (isSentinel) {
      const rec = {
        date: dateIso, queue: agent, colD: colDRaw,
        parsedExts: rowExts, matchedExts: matchedExt,
        adIds: adIds,
      };
      if (deptQueueNames[agent.toLowerCase()]) {   // ENG-14: by NAME, as the report does
        sentinelHits.push(rec);
        adIds.forEach(function (id) { parentsSentinel[id] = true; });
      } else {
        sentinelMiss.push(rec);
      }
    } else {
      const onRoster = !!rosterSet[agent];
      if (!onRoster) continue;
      if (!adIds.length) continue;
      agentHits.push({
        date: dateIso, agent: agent, colD: colDRaw, adIds: adIds,
      });
      adIds.forEach(function (id) { parentsAgent[id] = true; });
    }
  }

  Logger.log('');
  Logger.log('--- Sentinel rows (queue-only abandoned) MATCHED to %s by queue NAME: %s', DEPT, sentinelHits.length);
  sentinelHits.forEach(function (s) {
    Logger.log('  %s  %s  colD="%s"  matched=%s  parentIDs=%s',
               s.date, s.queue, s.colD, JSON.stringify(s.matchedExts),
               JSON.stringify(s.adIds));
  });

  Logger.log('');
  Logger.log('--- Sentinel rows in date range REJECTED (queue name not in the dept\'s set): %s', sentinelMiss.length);
  sentinelMiss.forEach(function (s) {
    Logger.log('  %s  %s  colD="%s"  parsedExts=%s  parentIDs=%s',
               s.date, s.queue, s.colD, JSON.stringify(s.parsedExts),
               JSON.stringify(s.adIds));
  });

  Logger.log('');
  Logger.log('--- Roster agent rows in range with non-empty col AD: %s', agentHits.length);
  agentHits.forEach(function (a) {
    Logger.log('  %s  %s  colD="%s"  parentIDs=%s',
               a.date, a.agent, a.colD, JSON.stringify(a.adIds));
  });

  const union = {};
  Object.keys(parentsAgent).forEach(function (k)    { union[k] = true; });
  Object.keys(parentsSentinel).forEach(function (k) { union[k] = true; });

  Logger.log('');
  Logger.log('=== Tallies ===');
  Logger.log('Distinct abandoned parent IDs from agent rows:    %s',
             Object.keys(parentsAgent).length);
  Logger.log('Distinct abandoned parent IDs from sentinel rows: %s',
             Object.keys(parentsSentinel).length);
  Logger.log('Union (== abandonedCallCount the report will show): %s',
             Object.keys(union).length);
  Logger.log('No-ring subset (noRingAbandonCount):              %s',
             Object.keys(parentsSentinel).length);
  return {   // ENG-14: the tallies, for a caller (and the parity test)
    agentParents: Object.keys(parentsAgent).length,
    sentinelParents: Object.keys(parentsSentinel).length,
    union: Object.keys(union).length,
    sentinelHits: sentinelHits.length,
    sentinelMiss: sentinelMiss.length,
  };
}


/**
 * Sub-queue Phase 2: WHERE DID THE CALLS GO? Read-only, admin-gated, editor-run.
 *
 * Reconciles a date's per-queue split (col AI) against every department's
 * narrowing set, and answers the only question that matters after the numbers
 * move: for each dept, did the calls it lost move to ANOTHER dept, or did they
 * fall out of the report entirely because no dept claims their queue?
 *
 * Phase 2 fails OPEN on an unmapped DEPT (it keeps the all-queue rollup), but
 * NOT on an unmapped QUEUE inside an otherwise-mapped dept -- those calls are
 * silently dropped from that dept's totals. That gap is invisible from the
 * dashboard, which is exactly why this exists: it is the difference between
 * "the de-duplication worked" and "a Dept Config row is missing a queue".
 *
 * Set QUEUE_SPLIT_AUDIT_DATE (YYYY-MM-DD) to pick the date; defaults to the
 * most recent date in DQE Historical Data. Writes nothing.
 */
function auditQueueSplitAttribution() {
  assertAdmin_();
  const props = PropertiesService.getScriptProperties();
  const wanted = String(props.getProperty('QUEUE_SPLIT_AUDIT_DATE') || '').trim();

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) { Logger.log('No DQE Historical Data sheet.'); return; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('DQE Historical Data is empty.'); return; }
  const ssTZ = ss.getSpreadsheetTimeZone();

  const width = Math.min(HISTORICAL_COLS.QUEUE_SPLIT, sheet.getMaxColumns());
  if (width < HISTORICAL_COLS.QUEUE_SPLIT) {
    Logger.log('!! The sheet is %s columns wide -- col AI (Queue Split) does not '
      + 'exist yet, so NO date is split. Deploy the Phase 1 pipeline and '
      + 're-import.', width);
    return;
  }
  const rows = sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues();

  // Resolve the target date.
  let date = wanted;
  if (!date) {
    let max = '';
    rows.forEach(function (r) {
      const d = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
      if (d && d > max) max = d;
    });
    date = max;
  }
  if (!date) { Logger.log('Could not resolve a date to audit.'); return; }

  // Every dept's OWN-queue narrowing set, exactly as computeSummary_ builds it.
  const depts = getAllDepartments_();
  const setByDept = {}, listByDept = {};
  depts.forEach(function (d) {
    let qs = [];
    try { qs = inboundQueuesForDept_(d, { includeChildren: false }) || []; } catch (e) {}
    listByDept[d] = qs;
    const set = {};
    qs.forEach(function (q) {
      const v = String(q || '').trim().toLowerCase();
      if (v) set[v] = true;
    });
    setByDept[d] = set;
  });

  // Roster membership, so a queue's calls can be tied back to the depts whose
  // agents actually worked them.
  const rosterOf = {};
  depts.forEach(function (d) {
    try {
      (getRosterForDepartment_(d).names || []).forEach(function (n) {
        (rosterOf[n] = rosterOf[n] || []).push(d);
      });
    } catch (e) {}
  });

  let agentRows = 0, splitRows = 0, blankRows = 0, badJson = 0;
  const perQueue = {};        // raw queue name -> { rung, answered, agents:{} }
  const byAgent = {};         // agent -> queue -> { rung, answered }
  let rollupRung = 0, rollupAns = 0;

  rows.forEach(function (r) {
    if (rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ) !== date) return;
    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) return;
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') return;   // INV-23 sentinel
    agentRows++;
    rollupRung += Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1]) || 0;
    rollupAns  += Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;

    const raw = String(r[HISTORICAL_COLS.QUEUE_SPLIT - 1] || '').trim();
    if (!raw) { blankRows++; return; }
    let split;
    try { split = JSON.parse(raw); } catch (e) { badJson++; return; }
    if (!split || typeof split !== 'object') { badJson++; return; }
    splitRows++;
    const mine = byAgent[agent] = byAgent[agent] || {};
    Object.keys(split).forEach(function (q) {
      const e = split[q] || {};
      const b = perQueue[q] = perQueue[q] || { rung: 0, answered: 0, agents: {} };
      const r = Number(e.r) || 0, a = Number(e.a) || 0;
      b.rung += r; b.answered += a; b.agents[agent] = true;
      const m = mine[q] = mine[q] || { rung: 0, answered: 0 };
      m.rung += r; m.answered += a;
    });
  });

  Logger.log('=== Queue-split attribution audit -- %s ===', date);
  Logger.log('Agent rows: %s   with a split: %s   blank (pre-Phase-1): %s   unparseable: %s',
             agentRows, splitRows, blankRows, badJson);
  if (!splitRows) {
    Logger.log('');
    Logger.log('NO row for this date carries a split, so every dept is showing '
      + 'ALL-QUEUE figures (Phase 2 fails open). Re-import this date while its '
      + 'Call_Legs sheet still exists.');
    return;
  }
  if (blankRows) {
    Logger.log('NOTE: %s row(s) have no split and keep their all-queue rollup, so '
      + 'this date is only PARTLY narrowed.', blankRows);
  }

  // Logger.log substitutes %s but does NOT honour printf padding (%-28s): the
  // width forms print literally AND swallow the argument list, which is how the
  // first run of this audit emitted rows reading "%-28s rung=%-5s ... -> A_Q_CSR"
  // with every number missing. Pad by hand and pass only plain %s.
  const pad = function (v, n) {
    let out = String(v == null ? '' : v);
    while (out.length < n) out += ' ';
    return out;
  };

  Logger.log('');
  Logger.log('--- Every queue in the split, and which dept claims it ---');
  const orphanRung = { v: 0 }, orphanAns = { v: 0 };
  const doubled = [];   // F46: queues more than one dept claims
  const claimedBy = {};
  Object.keys(perQueue).sort().forEach(function (q) {
    const key = q.trim().toLowerCase();
    const owners = depts.filter(function (d) { return setByDept[d][key]; });
    claimedBy[q] = owners;
    const b = perQueue[q];
    const who = Object.keys(b.agents).sort();
    if (!owners.length) {
      orphanRung.v += b.rung; orphanAns.v += b.answered;
      // Name the depts whose roster agents worked it -- that is almost always
      // the dept whose Dept Config row is missing the queue.
      const homes = {};
      who.forEach(function (a) { (rosterOf[a] || []).forEach(function (d) { homes[d] = true; }); });
      Logger.log('  !! %s rung=%s answered=%s  CLAIMED BY NO DEPT '
        + '-- worked by agents rostered in: %s',
        pad(q, 28), pad(b.rung, 6), pad(b.answered, 6),
        Object.keys(homes).sort().join(', ') || '(none)');
    } else if (owners.length > 1) {
      doubled.push(q + ' (' + owners.join(' + ') + ', rung=' + b.rung + ')');
      Logger.log('  ?? %s rung=%s answered=%s  claimed by %s -- DOUBLE-COUNTED',
        pad(q, 28), pad(b.rung, 6), pad(b.answered, 6), owners.join(' + '));
    } else {
      Logger.log('     %s rung=%s answered=%s  -> %s',
        pad(q, 28), pad(b.rung, 6), pad(b.answered, 6), owners[0]);
    }
  });

  Logger.log('');
  Logger.log('--- Per-dept narrowed totals (what My Department will show) ---');
  // ROSTER-SCOPED, which the first version of this audit was not. computeSummary_
  // runs at scope='roster': a row is included only when the agent is on THAT
  // dept's roster, and Phase 2 then narrows it to that dept's queues. Summing a
  // queue's whole volume instead counts calls that a NON-roster agent handled on
  // that queue -- which the dashboard excludes -- so the old line could not be
  // reconciled against the screen, while being labelled as exactly that. The
  // non-roster remainder is reported separately below, since it is real
  // cross-dept help rather than an error.
  depts.forEach(function (d) {
    let rung = 0, ans = 0, offRung = 0, offAns = 0;
    const mine = {};
    Object.keys(byAgent).forEach(function (agent) {
      const onRoster = (rosterOf[agent] || []).indexOf(d) !== -1;
      Object.keys(byAgent[agent]).forEach(function (q) {
        if (!setByDept[d][q.trim().toLowerCase()]) return;
        const m = byAgent[agent][q];
        mine[q] = true;
        if (onRoster) { rung += m.rung; ans += m.answered; }
        else { offRung += m.rung; offAns += m.answered; }
      });
    });
    if (!listByDept[d].length) {
      Logger.log('  %s NO QUEUES MAPPED -- keeps its ALL-QUEUE rollup (fails open)',
        pad(d, 22));
      return;
    }
    if (!Object.keys(mine).length) {
      // TWO very different causes, and the audit cannot tell them apart on its
      // own -- say so rather than asserting the scarier one. A queue with no
      // agent RINGS on this date is absent from the split entirely and is
      // completely normal for a low-volume queue; a name that never matches on
      // ANY date is the real mismatch. Re-run for a busier date to decide.
      Logger.log('  %s rung=0 answered=0   mapped=[%s] -- none of those names are '
        + 'in this date\'s split. Either the queue had NO agent rings today '
        + '(normal for a low-volume queue -- QCD can still show calls that never '
        + 'rang anyone), or the mapped name never matches the raw one. Re-run for '
        + 'a date the queue was busy: if it is still empty, add the RAW name to '
        + 'Inbound queue aliases.', pad(d, 22), listByDept[d].join(', '));
      return;
    }
    Logger.log('  %s rung=%s answered=%s  from [%s]%s',
      pad(d, 22), pad(rung, 6), pad(ans, 6), Object.keys(mine).sort().join(', '),
      (offRung || offAns)
        ? ('   (+ rung=' + offRung + ' answered=' + offAns
           + ' on these queues by NON-roster agents -- excluded from the dept '
           + 'table by INV-53/scope=roster)')
        : '');
    // A mapped queue that was simply QUIET today is invisible above, because
    // `mine` lists only queues that actually appear in the split. That hides
    // the thing most worth checking: whether a queue you BELIEVE is mapped
    // still is. A Dept Config row REPLACES the seed constant wholesale, so a
    // row listing two queues silently drops a third the constant had --
    // `Backup CSR` in CSR's seed list is exactly that shape. Naming the idle
    // ones lets the mapping be verified on any date, not only a busy one.
    const idle = listByDept[d].filter(function (q) {
      return !mine[q] && !Object.keys(mine).some(function (k) {
        return k.trim().toLowerCase() === String(q).trim().toLowerCase();
      });
    });
    if (idle.length) {
      Logger.log('  %s   mapped but NO calls today: [%s]', pad('', 22), idle.join(', '));
    }
  });

  // Roll-call of every queue name any dept maps, so one that is mapped NOWHERE
  // is visible on a quiet day too -- the orphan check above can only see queues
  // that had calls, which means a mapping gap stays hidden until the day it
  // costs you volume.
  const mappedSomewhere = {};
  depts.forEach(function (d) {
    listByDept[d].forEach(function (q) {
      const k = String(q).trim().toLowerCase();
      (mappedSomewhere[k] = mappedSomewhere[k] || []).push(d);
    });
  });
  const seenInSplit = {};
  Object.keys(perQueue).forEach(function (q) { seenInSplit[q.trim().toLowerCase()] = true; });
  const neverMapped = Object.keys(perQueue).filter(function (q) {
    return !mappedSomewhere[q.trim().toLowerCase()];
  });
  Logger.log('');
  Logger.log('--- Queue mapping roll-call ---');
  Logger.log('Queue names mapped by some dept: %s   of those with calls today: %s',
    Object.keys(mappedSomewhere).length,
    Object.keys(mappedSomewhere).filter(function (k) { return seenInSplit[k]; }).length);
  if (neverMapped.length) {
    Logger.log('!! In the split but mapped by NO dept: %s', neverMapped.join(', '));
  }
  Object.keys(mappedSomewhere).sort().forEach(function (k) {
    if (mappedSomewhere[k].length > 1) {
      Logger.log('?? %s is mapped by %s -- its calls count for BOTH',
        k, mappedSomewhere[k].join(' + '));
    }
  });

  Logger.log('');
  Logger.log('=== Reconciliation ===');
  Logger.log('Rollup across agent rows (cols F/H, all queues): rung=%s answered=%s',
             rollupRung, rollupAns);
  let splitRung = 0, splitAns = 0;
  Object.keys(perQueue).forEach(function (q) {
    splitRung += perQueue[q].rung; splitAns += perQueue[q].answered;
  });
  Logger.log('Sum across the split (all queues):              rung=%s answered=%s',
             splitRung, splitAns);
  Logger.log('Of that, claimed by NO dept (DROPPED):          rung=%s answered=%s',
             orphanRung.v, orphanAns.v);
  if (orphanRung.v || orphanAns.v) {
    Logger.log('');
    Logger.log('>> THIS IS YOUR MISSING VOLUME. Those calls belong to a queue that no '
      + 'department maps, so Phase 2 narrows them out of every dept total. Add the '
      + 'RAW queue name (exactly as printed above) to the owning dept\'s '
      + '"Inbound queue aliases" in Dept Config -- no redeploy, effective on the '
      + 'next request.');
  }
  if (doubled.length) {
    // F46 (broad-scan 2026-10-14): the verdict used to key on dropped volume
    // alone, so a run that had just printed DOUBLE-COUNTED lines closed with
    // "claimed by exactly one dept ... the fix working".
    Logger.log('');
    Logger.log('>> DOUBLE-COUNTED: %s queue(s) are claimed by more than one dept, so their calls '
      + 'count in EACH claiming dept\'s total: %s. Keep each RAW queue name on ONE dept\'s Dept '
      + 'Config row (QCD Queues / Inbound queue aliases).', doubled.length, doubled.join('; '));
  }
  if (!(orphanRung.v || orphanAns.v) && !doubled.length) {
    Logger.log('');
    Logger.log('>> Every queue in the split is claimed by exactly one dept, so no '
      + 'volume was dropped: a dept whose total FELL simply stopped counting '
      + 'another dept\'s calls, which is the fix working.');
  }
}


// ── DD-2: the answer-rate formula probe ──────────────────────────────────────
//
// Editor-run, admin-gated, READ-ONLY. Two Answer % formulas were live (see
// Config.gs::getAnswerRateFormula_): answered / rung on IR, Insights, the
// Overview, Alerts and the Digest; answered / (answered + missed) on the My
// Department table, the agent app and team-tools (the H2 standard). This
// prints BOTH per department over a window -- the totals, the legs that are
// neither Answered nor Missed (the difference), the two rates, the gap in
// points, the worst per-agent gap, and whether the dept's display standard
// verdict would change -- so the owner can flip ANSWER_RATE_FORMULA (Operator
// State #69) knowing what moves. Window: ANSWER_RATE_PROBE_FROM/_TO (ISO), or
// the 30 days ending yesterday. Writes nothing; the params are not cleared.

/** Pure row (tests/unit/answer-rate-formula.test.js). */
function answerRateProbeRow_(dept, totals, rows, target) {
  var rung = Number(totals && totals.totalRung) || 0;
  var answered = Number(totals && totals.totalAnswered) || 0;
  var missed = Number(totals && totals.totalMissed) || 0;
  var rateRung = rung > 0 ? (answered / rung) * 100 : 0;
  var rateAns = (answered + missed) > 0 ? (answered / (answered + missed)) * 100 : 0;
  var worst = null;
  (rows || []).forEach(function (r) {
    var aR = Number(r.totalRung) || 0, aA = Number(r.totalAnswered) || 0, aM = Number(r.totalMissed) || 0;
    if (aR <= 0 || (aA + aM) <= 0) return;
    var d = ((aA / (aA + aM)) - (aA / aR)) * 100;
    if (!worst || Math.abs(d) > Math.abs(worst.deltaPts)) worst = { agent: r.agent, deltaPts: Math.round(d * 10) / 10 };
  });
  var tgt = (target == null) ? null : Number(target);
  return {
    dept: dept, rung: rung, answered: answered, missed: missed,
    neither: Math.max(0, rung - answered - missed),
    rateRung: Math.round(rateRung * 10) / 10,
    rateAnswerable: Math.round(rateAns * 10) / 10,
    deltaPts: Math.round((rateAns - rateRung) * 10) / 10,
    worstAgent: worst,
    target: tgt,
    meetsTargetRung: tgt == null ? null : rateRung >= tgt,
    meetsTargetAnswerable: tgt == null ? null : rateAns >= tgt,
    verdictChanges: tgt != null && ((rateRung >= tgt) !== (rateAns >= tgt)),
  };
}

function probeAnswerRateFormulas() {
  assertAdmin_();
  var props = PropertiesService.getScriptProperties();
  var to = String(props.getProperty('ANSWER_RATE_PROBE_TO') || '').trim();
  var from = String(props.getProperty('ANSWER_RATE_PROBE_FROM') || '').trim();
  if (!isIsoDate_(to)) to = Utilities.formatDate(new Date(Date.now() - 86400000), TZ, 'yyyy-MM-dd');
  if (!isIsoDate_(from) || from > to) {
    var p = to.split('-');
    var f = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - 29, 12);
    from = Utilities.formatDate(f, TZ, 'yyyy-MM-dd');
  }
  var out = { from: from, to: to, active: getAnswerRateFormula_(), depts: [], verdictChanges: [], maxDeltaPts: 0 };
  getAllDepartments_().forEach(function (dept) {
    var summary;
    try { summary = computeSummary_(dept, from, to, 'roster'); }
    catch (e) { out.depts.push({ dept: dept, error: String(e && e.message || e) }); return; }
    var target = null;
    try { target = getAnswerStandardFor_(dept).target; } catch (e) { target = null; }
    var row = answerRateProbeRow_(dept, summary.totals || {}, summary.rows || [], target);
    out.depts.push(row);
    if (Math.abs(row.deltaPts) > Math.abs(out.maxDeltaPts)) out.maxDeltaPts = row.deltaPts;
    if (row.verdictChanges) out.verdictChanges.push(dept);
  });
  Logger.log('probeAnswerRateFormulas %s..%s (active formula: %s)', from, to, out.active);
  Logger.log('dept | rung | answered | missed | neither | %%(rung) | %%(answerable) | delta pts | worst agent | target | verdict changes?');
  out.depts.forEach(function (r) {
    if (r.error) { Logger.log('%s | ERROR %s', r.dept, r.error); return; }
    Logger.log('%s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s',
      r.dept, r.rung, r.answered, r.missed, r.neither, r.rateRung, r.rateAnswerable, r.deltaPts,
      r.worstAgent ? (r.worstAgent.agent + ' ' + r.worstAgent.deltaPts) : '-',
      r.target == null ? '-' : r.target, r.verdictChanges ? 'YES' : 'no');
  });
  Logger.log('Largest dept gap: %s pts. Depts whose standard verdict flips: %s. '
    + 'To adopt the H2 formula set ANSWER_RATE_FORMULA=answerable (Operator State #69); '
    + 'if a gap here is bigger than the alert band, re-tune that dept\'s threshold first.',
    out.maxDeltaPts, out.verdictChanges.length ? out.verdictChanges.join(', ') : 'none');
  return logStatusReturn_(out);
}


// ── UX-2 follow-on: the brief-threshold probe ────────────────────────────────
//
// Editor-run, admin-gated, READ-ONLY. UX-2's ruling (docs/next-steps.md) colours
// an Insights brief row only where a standard exists; three rows still have
// none, and the owner wanted to see what NORMAL looks like before picking one.
// Per department, over a window of whole months, this logs:
//   1. SHARE OF ANSWERED -- per month, each roster agent's share of the team's
//      answered calls (managers excluded, INV-26), its spread in points, and
//      the fairer per-day-worked view (answered per day the agent took calls):
//      mean, standard deviation, coefficient of variation, and how many agents
//      sit beyond 1 and 2 standard deviations. Months with fewer than
//      BRIEF_PROBE_MIN_AGENTS_ qualifying agents are skipped (too few to judge).
//   2. QUEUE WAIT -- per mapped queue ("Total Calls" rows only, INV-50): calls,
//      volume-weighted avg answer, longest wait, the queue against the company
//      average, against its OWN trailing 3-month median, and how jumpy its
//      daily avg answer is -- plus rank correlations of volume against those,
//      which is the "does a company-wide comparison penalise small queues"
//      question answered from the data.
//   3. MONTHLY ANSWER RATE -- per dept per month (every roster agent, the
//      answerRatePct_ formula), the change vs the month before and vs the
//      average of the 3 months before, and how often each reaches 2 / 3 / 5
//      points; pooled percentiles suggest where a colour scale would saturate.
// Window: BRIEF_PROBE_FROM / _TO (ISO), else the 12 whole months ending last
// month. DQE rows come through the DAL (Neon when DQE_READ_SOURCE=neon, sheet
// otherwise); queue rows through readQcdGrid_. Writes nothing; params kept.

var BRIEF_PROBE_MIN_DAYS_ = 5;     // days worked in the month to count in the share stats
var BRIEF_PROBE_MIN_RUNG_ = 5;     // the Insights INS_MIN_VOL gate
var BRIEF_PROBE_MIN_AGENTS_ = 5;   // fewer qualifying agents -> month not assessed

/** Pure: population mean / standard deviation / coefficient of variation. */
function briefStats_(xs) {
  var n = xs.length;
  if (!n) return { n: 0, mean: 0, sd: 0, cv: 0 };
  var sum = 0;
  for (var i = 0; i < n; i++) sum += xs[i];
  var mean = sum / n, ss = 0;
  for (var j = 0; j < n; j++) ss += (xs[j] - mean) * (xs[j] - mean);
  var sd = Math.sqrt(ss / n);
  return { n: n, mean: mean, sd: sd, cv: mean > 0 ? sd / mean : 0 };
}

/** Pure: nearest-rank percentile (p in 0..1) of a numeric array; null when empty. */
function briefPercentile_(xs, p) {
  if (!xs.length) return null;
  var s = xs.slice().sort(function (a, b) { return a - b; });
  var k = Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1));
  return s[k];
}

function briefR1_(x) { return x == null || !isFinite(x) ? null : Math.round(x * 10) / 10; }

/** Pure: Spearman rank correlation (ties share their average rank); null under 4 pairs. */
function briefSpearman_(xs, ys) {
  var n = Math.min(xs.length, ys.length);
  if (n < 4) return null;
  var rank = function (arr) {
    var idx = arr.map(function (v, i) { return { v: v, i: i }; }).sort(function (a, b) { return a.v - b.v; });
    var r = new Array(arr.length);
    for (var i = 0; i < idx.length;) {
      var j = i;
      while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
      for (var k = i; k <= j; k++) r[idx[k].i] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  var rx = rank(xs.slice(0, n)), ry = rank(ys.slice(0, n));
  var sx = briefStats_(rx), sy = briefStats_(ry);
  if (!sx.sd || !sy.sd) return null;
  var cov = 0;
  for (var i = 0; i < n; i++) cov += (rx[i] - sx.mean) * (ry[i] - sy.mean);
  return Math.round((cov / n) / (sx.sd * sy.sd) * 100) / 100;
}

/**
 * Pure: one dept-month of the share view. `agents` = [{agent, answered, rung,
 * days}] for the roster minus the team-average excludes. Returns null when too
 * few agents qualify.
 */
function briefShareMonth_(agents) {
  var q = (agents || []).filter(function (a) {
    return (Number(a.days) || 0) >= BRIEF_PROBE_MIN_DAYS_ && (Number(a.rung) || 0) >= BRIEF_PROBE_MIN_RUNG_;
  });
  if (q.length < BRIEF_PROBE_MIN_AGENTS_) return null;
  var total = 0;
  q.forEach(function (a) { total += Number(a.answered) || 0; });
  if (total <= 0) return null;
  var shares = q.map(function (a) { return (Number(a.answered) || 0) / total * 100; });
  var perDay = q.map(function (a) { return (Number(a.answered) || 0) / Number(a.days); });
  var sS = briefStats_(shares), sD = briefStats_(perDay);
  var maxGap = 0, maxZ = 0, maxZAgent = null, b1 = 0, b2 = 0;
  for (var i = 0; i < q.length; i++) {
    var gap = Math.abs(shares[i] - sS.mean);
    if (gap > maxGap) maxGap = gap;
    var z = sD.sd > 0 ? (perDay[i] - sD.mean) / sD.sd : 0;
    if (Math.abs(z) > 1) b1++;
    if (Math.abs(z) > 2) b2++;
    if (Math.abs(z) > Math.abs(maxZ)) { maxZ = z; maxZAgent = q[i].agent; }
  }
  return {
    agents: q.length,
    equalSharePts: briefR1_(100 / q.length),
    shareSdPts: briefR1_(sS.sd),
    maxShareGapPts: briefR1_(maxGap),
    perDayMean: briefR1_(sD.mean),
    perDaySd: briefR1_(sD.sd),
    perDayCvPct: briefR1_(sD.cv * 100),
    beyond1Sd: b1,
    beyond2Sd: b2,
    maxZ: briefR1_(maxZ),
    maxZAgent: maxZAgent,
  };
}

/**
 * Pure: monthly answer-rate swings. `months` = [{month, rate}] in order (rate
 * null for a month with no calls). Each month gets momPts (vs the month before)
 * and vs3Pts (vs the mean of the 3 months before, needing all 3).
 */
function briefRateSwings_(months) {
  var rows = (months || []).map(function (m, i) {
    var prev = i > 0 ? months[i - 1].rate : null;
    var p3 = (i >= 3) ? [months[i - 1].rate, months[i - 2].rate, months[i - 3].rate] : null;
    var p3ok = p3 && p3.every(function (v) { return v != null; });
    return {
      month: m.month,
      rate: m.rate == null ? null : briefR1_(m.rate),
      momPts: (m.rate != null && prev != null) ? briefR1_(m.rate - prev) : null,
      vs3Pts: (m.rate != null && p3ok) ? briefR1_(m.rate - (p3[0] + p3[1] + p3[2]) / 3) : null,
    };
  });
  var summarize = function (key) {
    var abs = rows.filter(function (r) { return r[key] != null; }).map(function (r) { return Math.abs(r[key]); });
    var count = function (t) { return abs.filter(function (v) { return v >= t; }).length; };
    var worst = null;
    rows.forEach(function (r) { if (r[key] != null && (!worst || Math.abs(r[key]) > Math.abs(worst.pts))) worst = { month: r.month, pts: r[key] }; });
    return { n: abs.length, medianAbs: briefPercentile_(abs, 0.5), p90Abs: briefPercentile_(abs, 0.9),
             atLeast2: count(2), atLeast3: count(3), atLeast5: count(5), worst: worst };
  };
  return { rows: rows, mom: summarize('momPts'), vs3: summarize('vs3Pts') };
}

/**
 * Pure: one queue's wait view from its per-day rows [{iso, calls, answered,
 * longestSec, avgAnswerSec}]. `months` = the window's month keys in order.
 */
function briefQueueWait_(days, months) {
  var byMonth = {};
  months.forEach(function (m) { byMonth[m] = { calls: 0, wsum: 0, wn: 0, longest: 0 }; });
  var calls = 0, wsum = 0, wn = 0, longest = 0, dailyAvg = [], dailyCalls = [];
  (days || []).forEach(function (d) {
    var b = byMonth[d.iso.slice(0, 7)];
    if (!b) return;
    var c = Number(d.calls) || 0, a = Number(d.answered) || 0;
    var avg = Number(d.avgAnswerSec) || 0, lw = Number(d.longestSec) || 0;
    calls += c; b.calls += c;
    dailyCalls.push(c);
    if (avg > 0 && a > 0) { wsum += avg * a; wn += a; b.wsum += avg * a; b.wn += a; dailyAvg.push(avg); }
    if (lw > longest) longest = lw;
    if (lw > b.longest) b.longest = lw;
  });
  var mAvg = months.map(function (m) { return byMonth[m].wn ? byMonth[m].wsum / byMonth[m].wn : null; });
  var mLong = months.map(function (m) { return byMonth[m].longest || null; });
  // Own history: each month against the median of the 3 months before it.
  var ownRatios = function (series) {
    var out = [];
    for (var i = 3; i < series.length; i++) {
      var prior = [series[i - 1], series[i - 2], series[i - 3]].filter(function (v) { return v != null; });
      if (series[i] == null || prior.length < 3) continue;
      var med = briefPercentile_(prior, 0.5);
      if (med > 0) out.push(series[i] / med);
    }
    return out;
  };
  var ra = ownRatios(mAvg), rl = ownRatios(mLong);
  var cnt = function (arr, t) { return arr.filter(function (v) { return v >= t; }).length; };
  return {
    calls: calls,
    medianDailyCalls: briefPercentile_(dailyCalls, 0.5),
    avgAnswerSec: wn ? Math.round(wsum / wn) : null,
    longestSec: longest || null,
    medianMonthlyLongestSec: briefPercentile_(mLong.filter(function (v) { return v != null; }), 0.5),
    dailyAvgCvPct: dailyAvg.length >= 5 ? briefR1_(briefStats_(dailyAvg).cv * 100) : null,
    ownAvg: { months: ra.length, maxRatio: briefR1_(ra.length ? Math.max.apply(null, ra) : null), atLeast125: cnt(ra, 1.25), atLeast150: cnt(ra, 1.5) },
    ownLongest: { months: rl.length, maxRatio: briefR1_(rl.length ? Math.max.apply(null, rl) : null), atLeast125: cnt(rl, 1.25), atLeast150: cnt(rl, 1.5) },
    answeredForWeight: wn,
    wsum: wsum,
  };
}

/** Window helper: BRIEF_PROBE_FROM/_TO or the 12 whole months ending last month. */
function briefProbeWindow_(props, todayIso) {
  var to = String(props.getProperty('BRIEF_PROBE_TO') || '').trim();
  var from = String(props.getProperty('BRIEF_PROBE_FROM') || '').trim();
  var t = todayIso.split('-').map(Number);
  if (!isIsoDate_(to)) {
    var lastOfPrev = new Date(t[0], t[1] - 1, 0, 12);   // day 0 = last day of the previous month
    to = Utilities.formatDate(lastOfPrev, TZ, 'yyyy-MM-dd');
  }
  if (!isIsoDate_(from) || from > to) {
    var e = to.split('-').map(Number);
    from = Utilities.formatDate(new Date(e[0], e[1] - 12, 1, 12), TZ, 'yyyy-MM-dd');
  }
  var months = [];
  var f = from.split('-').map(Number), cur = new Date(f[0], f[1] - 1, 1, 12);
  while (true) {
    var key = Utilities.formatDate(cur, TZ, 'yyyy-MM');
    if (key > to.slice(0, 7)) break;
    months.push(key);
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1, 12);
  }
  return { from: from, to: to, months: months };
}

function probeBriefThresholds() {
  assertAdmin_();
  var props = PropertiesService.getScriptProperties();
  var todayIso = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var w = briefProbeWindow_(props, todayIso);
  var out = { from: w.from, to: w.to, months: w.months, source: 'sheet',
              queueSplit: getQueueSplitScope_(), share: [], queues: [], rates: [], notes: [] };
  if (w.from.slice(8) !== '01' || w.months.length < 4) {
    out.notes.push('Window is not whole months or under 4 months -- the 3-month comparisons need at least 4.');
  }

  // DQE rows, once, through the DAL (Neon when flagged on, sheet otherwise).
  var rows;
  if (getDqeReadSource_() === 'neon') {
    rows = neonFetchDqeRows_(w.from, w.to, { withQueueSplit: out.queueSplit === 'dept' });
    if (neonDqeRowsUsable_(rows)) out.source = 'neon';
    else rows = null;
  }
  if (!rows) rows = sheetFetchDqeRows_(w.from, w.to);

  var depts = getAllDepartments_();
  depts.forEach(function (dept) {
    try {
      var roster = getRosterForDepartment_(dept);
      var inRoster = {};
      roster.names.forEach(function (n) { inRoster[n] = true; });
      var mine = rows.filter(function (r) { return inRoster[r.agent]; });
      if (out.queueSplit === 'dept') {
        mine = dqeRowsShallowCopy_(mine);
        applyQueueSplitToRows_(mine, dept, { assessAgents: roster.names });
      }
      var excl = {};
      (getTeamAvgExcludes_(dept) || []).forEach(function (n) { excl[n] = true; });
      var perMonth = {};   // month -> { a, m, r, agents: {name: {answered, rung, days: {iso:1}}} }
      w.months.forEach(function (k) { perMonth[k] = { a: 0, m: 0, r: 0, agents: {} }; });
      mine.forEach(function (r) {
        var pm = perMonth[r.dateIso.slice(0, 7)];
        if (!pm) return;
        var a = Number(r.totalAnswered) || 0, m = Number(r.totalMissed) || 0, g = Number(r.totalRung) || 0;
        pm.a += a; pm.m += m; pm.r += g;
        if (excl[r.agent]) return;
        var ag = pm.agents[r.agent] || (pm.agents[r.agent] = { agent: r.agent, answered: 0, rung: 0, dayset: {} });
        ag.answered += a; ag.rung += g;
        if (a + m + g > 0) ag.dayset[r.dateIso] = true;
      });
      // 1. share
      var shareMonths = [];
      w.months.forEach(function (k) {
        var list = Object.keys(perMonth[k].agents).map(function (n) {
          var x = perMonth[k].agents[n];
          return { agent: x.agent, answered: x.answered, rung: x.rung, days: Object.keys(x.dayset).length };
        });
        var s = briefShareMonth_(list);
        if (s) { s.month = k; shareMonths.push(s); }
      });
      var pick = function (key) { return shareMonths.map(function (s) { return s[key]; }); };
      var worstZ = null;
      shareMonths.forEach(function (s) { if (!worstZ || Math.abs(s.maxZ) > Math.abs(worstZ.z)) worstZ = { z: s.maxZ, agent: s.maxZAgent, month: s.month }; });
      out.share.push({
        dept: dept, monthsAssessed: shareMonths.length,
        typicalAgents: briefPercentile_(pick('agents'), 0.5),
        equalSharePts: briefPercentile_(pick('equalSharePts'), 0.5),
        shareSdPts: briefPercentile_(pick('shareSdPts'), 0.5),
        maxShareGapPts: briefPercentile_(pick('maxShareGapPts'), 0.5),
        perDayCvPct: briefPercentile_(pick('perDayCvPct'), 0.5),
        beyond1SdPerMonth: briefPercentile_(pick('beyond1Sd'), 0.5),
        beyond2SdPerMonth: briefPercentile_(pick('beyond2Sd'), 0.5),
        monthsWithAnyBeyond2Sd: shareMonths.filter(function (s) { return s.beyond2Sd > 0; }).length,
        worstZ: worstZ,
      });
      // 3. monthly answer rate
      var sw = briefRateSwings_(w.months.map(function (k) {
        var pm = perMonth[k];
        return { month: k, rate: pm.r > 0 || (pm.a + pm.m) > 0 ? answerRatePct_(pm.a, pm.m, pm.r) : null };
      }));
      var band = null;
      try { band = getAnswerStandardFor_(dept).band; } catch (e) { band = null; }
      out.rates.push({ dept: dept, band: band, monthly: sw.rows.map(function (r) { return r.rate; }),
                       mom: sw.mom, vs3: sw.vs3 });
    } catch (e) {
      out.share.push({ dept: dept, error: String(e && e.message || e) });
    }
  });

  // 2. queue wait
  try {
    var grid = readQcdGrid_(w.from, w.to, { raw: true });   // #81: diagnostics see what happened
    var queueDept = {};
    depts.forEach(function (d) {
      (getDeptQcdQueues_(d) || []).forEach(function (q) { (queueDept[q] = queueDept[q] || []).push(d); });
    });
    var byQueue = {}, unmapped = {};
    if (grid && grid.values) {
      for (var i = 0; i < grid.values.length; i++) {
        var v = grid.values[i], dsp = grid.displays[i];
        if (String(v[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim() !== QCD_TOTAL_CALLS_SOURCE) continue;
        var iso = (grid.dates && grid.dates[i]) || rowDateIso_(v[QCD_HISTORICAL_COLS.DATE - 1], grid.ssTZ);
        if (!iso || iso < w.from || iso > w.to) continue;
        var q = String(v[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim();
        if (!queueDept[q]) { unmapped[q] = true; continue; }
        (byQueue[q] = byQueue[q] || []).push({
          iso: iso,
          calls: Number(v[QCD_HISTORICAL_COLS.TOTAL_CALLS - 1]) || 0,
          answered: Number(v[QCD_HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
          longestSec: parseHmsDisplay_(dsp[QCD_HISTORICAL_COLS.LONGEST_WAIT - 1]),
          avgAnswerSec: parseHmsDisplay_(dsp[QCD_HISTORICAL_COLS.AVG_ANSWER - 1]),
        });
      }
    }
    var compW = 0, compN = 0;
    Object.keys(byQueue).sort().forEach(function (q) {
      var r = briefQueueWait_(byQueue[q], w.months);
      r.queue = q; r.depts = queueDept[q];
      compW += r.wsum; compN += r.answeredForWeight;
      out.queues.push(r);
    });
    var compAvg = compN ? compW / compN : null;
    out.companyAvgAnswerSec = compAvg == null ? null : Math.round(compAvg);
    out.queues.forEach(function (r) {
      r.vsCompany = (compAvg && r.avgAnswerSec != null) ? briefR1_(r.avgAnswerSec / compAvg) : null;
      delete r.wsum; delete r.answeredForWeight;
    });
    var withAvg = out.queues.filter(function (r) { return r.avgAnswerSec != null; });
    var withCv = out.queues.filter(function (r) { return r.dailyAvgCvPct != null; });
    out.volumeCorrelation = {
      callsVsAvgAnswer: briefSpearman_(withAvg.map(function (r) { return r.calls; }), withAvg.map(function (r) { return r.avgAnswerSec; })),
      callsVsLongest: briefSpearman_(out.queues.map(function (r) { return r.calls; }), out.queues.map(function (r) { return r.longestSec || 0; })),
      dailyCallsVsDailyJumpiness: briefSpearman_(withCv.map(function (r) { return r.medianDailyCalls; }), withCv.map(function (r) { return r.dailyAvgCvPct; })),
    };
    out.unmappedQueuesSkipped = Object.keys(unmapped).length;
  } catch (e) {
    out.notes.push('Queue section failed: ' + String(e && e.message || e));
  }

  // Pooled rate-swing percentiles (where a colour scale could saturate).
  var pooledMom = [], pooledVs3 = [];
  out.rates.forEach(function (r) {
    // re-derive from the monthly series so the pool holds every month, not the summaries
    var sw = briefRateSwings_(w.months.map(function (k, i) { return { month: k, rate: r.monthly[i] }; }));
    sw.rows.forEach(function (x) {
      if (x.momPts != null) pooledMom.push(Math.abs(x.momPts));
      if (x.vs3Pts != null) pooledVs3.push(Math.abs(x.vs3Pts));
    });
  });
  out.pooledRateSwings = {
    mom: { p50: briefPercentile_(pooledMom, 0.5), p90: briefPercentile_(pooledMom, 0.9), p95: briefPercentile_(pooledMom, 0.95), n: pooledMom.length },
    vs3: { p50: briefPercentile_(pooledVs3, 0.5), p90: briefPercentile_(pooledVs3, 0.9), p95: briefPercentile_(pooledVs3, 0.95), n: pooledVs3.length },
  };

  briefProbeLog_(out);
  return logStatusReturn_(out);
}

/** Prints the readable tables (the return value carries the same data as JSON). */
function briefProbeLog_(out) {
  var hms = function (s) { return s == null ? '-' : formatSecondsHms_(s); };
  var d = function (v) { return v == null ? '-' : v; };
  Logger.log('probeBriefThresholds %s..%s (%s months, DQE source %s, queue split %s)',
    out.from, out.to, out.months.length, out.source, out.queueSplit);
  out.notes.forEach(function (n) { Logger.log('NOTE: ' + n); });

  Logger.log('== 1. SHARE OF ANSWERED (per month, managers excluded; agents with %s+ days and %s+ rung; months with %s+ such agents). Values are the MEDIAN month.',
    BRIEF_PROBE_MIN_DAYS_, BRIEF_PROBE_MIN_RUNG_, BRIEF_PROBE_MIN_AGENTS_);
  Logger.log('dept | months | agents | equal share % | share SD pts | widest gap pts | per-day CV % | agents >1 SD | agents >2 SD | months with any >2 SD | most extreme (z, agent, month)');
  out.share.forEach(function (s) {
    if (s.error) { Logger.log('%s | ERROR %s', s.dept, s.error); return; }
    if (!s.monthsAssessed) { Logger.log('%s | 0 | too few qualifying agents in every month', s.dept); return; }
    Logger.log('%s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s',
      s.dept, s.monthsAssessed, d(s.typicalAgents), d(s.equalSharePts), d(s.shareSdPts), d(s.maxShareGapPts),
      d(s.perDayCvPct), d(s.beyond1SdPerMonth), d(s.beyond2SdPerMonth), s.monthsWithAnyBeyond2Sd,
      s.worstZ ? (s.worstZ.z + ', ' + s.worstZ.agent + ', ' + s.worstZ.month) : '-');
  });

  Logger.log('== 2. QUEUE WAIT ("Total Calls" rows; company avg answer %s). Own-history = each month vs the median of its 3 prior months.',
    hms(out.companyAvgAnswerSec));
  Logger.log('queue | dept(s) | calls | median calls/day | avg answer | x company | longest | median monthly longest | daily avg-answer CV % | avg: months >=1.25x own / >=1.5x own / max x | longest: >=1.25x / >=1.5x / max x');
  out.queues.forEach(function (q) {
    Logger.log('%s | %s | %s | %s | %s | %s | %s | %s | %s | %s / %s / %s | %s / %s / %s',
      q.queue, q.depts.join(','), q.calls, d(q.medianDailyCalls), hms(q.avgAnswerSec), d(q.vsCompany),
      hms(q.longestSec), hms(q.medianMonthlyLongestSec), d(q.dailyAvgCvPct),
      q.ownAvg.atLeast125, q.ownAvg.atLeast150, d(q.ownAvg.maxRatio),
      q.ownLongest.atLeast125, q.ownLongest.atLeast150, d(q.ownLongest.maxRatio));
  });
  if (out.volumeCorrelation) {
    Logger.log('Volume vs wait (Spearman, -1..1; |r| under ~0.3 = little relationship): calls vs avg answer %s; calls vs longest wait %s; daily calls vs daily jumpiness %s. '
      + 'A strong positive calls-vs-longest means big queues look worse on longest wait; a strong negative daily-calls-vs-jumpiness means small queues are noisier.',
      d(out.volumeCorrelation.callsVsAvgAnswer), d(out.volumeCorrelation.callsVsLongest), d(out.volumeCorrelation.dailyCallsVsDailyJumpiness));
  }
  if (out.unmappedQueuesSkipped) Logger.log('%s queue name(s) not mapped to any dept were skipped.', out.unmappedQueuesSkipped);

  Logger.log('== 3. MONTHLY ANSWER RATE (every roster agent; formula %s). MoM = vs the month before; vs3 = vs the average of the 3 months before.',
    getAnswerRateFormula_());
  Logger.log('dept | amber band | monthly rates | MoM median / p90 / >=2 / >=3 / >=5 / worst | vs3 median / p90 / >=2 / >=3 / >=5 / worst');
  out.rates.forEach(function (r) {
    var f = function (s) {
      return d(s.medianAbs) + ' / ' + d(s.p90Abs) + ' / ' + s.atLeast2 + ' / ' + s.atLeast3 + ' / ' + s.atLeast5 + ' of ' + s.n
        + ' / ' + (s.worst ? (s.worst.pts + ' ' + s.worst.month) : '-');
    };
    Logger.log('%s | %s | %s | %s | %s', r.dept, d(r.band),
      r.monthly.map(function (v) { return v == null ? '-' : v; }).join(' '), f(r.mom), f(r.vs3));
  });
  var p = out.pooledRateSwings;
  Logger.log('All depts pooled |change| in points -- MoM p50 %s, p90 %s, p95 %s (n %s); vs3 p50 %s, p90 %s, p95 %s (n %s). '
    + 'A colour scale that saturates near p90-p95 keeps full colour for the rare months.',
    d(p.mom.p50), d(p.mom.p90), d(p.mom.p95), p.mom.n, d(p.vs3.p50), d(p.vs3.p90), d(p.vs3.p95), p.vs3.n);
}
