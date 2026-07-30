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
function diagnoseDate_() {
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
function whyNoMatches_() {
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
function diagnoseTimes_() {
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
function dumpCell_() {
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
 *   - The dept's allExtensions (set of phone/queue extensions on the
 *     dept's DO NOT EDIT! roster cells).
 *   - Every queue-sentinel row in range: queue name, col D contents,
 *     whether its col-D extensions overlap allExtensions, and the
 *     parent-call IDs in col AD.
 *   - Every per-agent row in range whose agent IS on the roster:
 *     same info plus the parent IDs from col AD.
 *   - Final tallies: distinct abandoned parent IDs from agent rows,
 *     from sentinel rows, and the union (what abandonedCallCount
 *     should equal).
 *
 * Edit DEPT, FROM, TO below before running.
 */
function diagnoseAbandoned_() {
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
  if (!sheet) { Logger.log('Historical sheet not found.'); return; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No data rows.'); return; }

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
  Logger.log('Dept queue exts (source=%s): %s',
             dqr.source, JSON.stringify(Object.keys(deptQueueExts).sort()));

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
    // Both sentinel and agent rows match against deptQueueExts (col D
    // is always the shared-queue extension).
    let extMatch = false;
    const matchedExt = [];
    for (let j = 0; j < rowExts.length; j++) {
      if (deptQueueExts[rowExts[j]]) {
        extMatch = true;
        matchedExt.push(rowExts[j]);
      }
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
      if (extMatch) {
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
  Logger.log('--- Sentinel rows (queue-only abandoned) MATCHED to %s by extension overlap: %s', DEPT, sentinelHits.length);
  sentinelHits.forEach(function (s) {
    Logger.log('  %s  %s  colD="%s"  matched=%s  parentIDs=%s',
               s.date, s.queue, s.colD, JSON.stringify(s.matchedExts),
               JSON.stringify(s.adIds));
  });

  Logger.log('');
  Logger.log('--- Sentinel rows in date range REJECTED (col-D had no overlap with dept allExtensions): %s', sentinelMiss.length);
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
    Object.keys(split).forEach(function (q) {
      const e = split[q] || {};
      const b = perQueue[q] = perQueue[q] || { rung: 0, answered: 0, agents: {} };
      b.rung     += Number(e.r) || 0;
      b.answered += Number(e.a) || 0;
      b.agents[agent] = true;
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
      Logger.log('  ?? %s rung=%s answered=%s  claimed by %s -- DOUBLE-COUNTED',
        pad(q, 28), pad(b.rung, 6), pad(b.answered, 6), owners.join(' + '));
    } else {
      Logger.log('     %s rung=%s answered=%s  -> %s',
        pad(q, 28), pad(b.rung, 6), pad(b.answered, 6), owners[0]);
    }
  });

  Logger.log('');
  Logger.log('--- Per-dept narrowed totals (what My Department will show) ---');
  depts.forEach(function (d) {
    let rung = 0, ans = 0;
    const mine = [];
    Object.keys(perQueue).forEach(function (q) {
      if (!setByDept[d][q.trim().toLowerCase()]) return;
      rung += perQueue[q].rung; ans += perQueue[q].answered; mine.push(q);
    });
    if (!listByDept[d].length) {
      Logger.log('  %s NO QUEUES MAPPED -- keeps its ALL-QUEUE rollup (fails open)',
        pad(d, 22));
      return;
    }
    if (!mine.length) {
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
    Logger.log('  %s rung=%s answered=%s  from [%s]',
      pad(d, 22), pad(rung, 6), pad(ans, 6), mine.join(', '));
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
  } else {
    Logger.log('');
    Logger.log('>> Every queue in the split is claimed by exactly one dept, so no '
      + 'volume was dropped: a dept whose total FELL simply stopped counting '
      + 'another dept\'s calls, which is the fix working.');
  }
}
