// ============================================================================
// dqeDashboard.gs
// ----------------------------------------------------------------------------
// Apps Script translation of the per-department DQE dashboard formulas.
// Replaces the formula-driven dashboards in DQE Report with on-demand /
// on-edit script execution that reads directly from CDR Report ss.
//
// Behavior:
//   - On sheet open: set B1 to the most recent date in DQE Historical Data,
//     then refresh all four data tables.
//   - On B1 edit: refresh all four data tables for the new date.
//   - On Z2 or AB2 edit: refresh date-range-dependent tables (3 + 4).
//   - "DQE Tools -> Refresh dashboard" menu item for manual refresh.
//
// Data sources (all in CDR Report ss):
//   - DQE Historical Data: per-agent metrics (tables 1-3)
//   - QCD Historical Data: per-queue/source aggregates (table 4)
//   - DO NOT EDIT! sheet (in this DQE Report ss): assigned-agent list per dept
//
// Cells the dashboard depends on (already in the dept sheet):
//   - B1: selected date (single-date tables)
//   - B4: call queue name (e.g. "A_Q_Sales")
//   - B5: comma-separated queue extensions (e.g. "165")
//   - Z2: range start date    AB2: range end date
//
// Output cells:
//   - A8:H?    Table 1 (per-agent metrics for B1)
//   - A22:?22  Table 2 (transposed agent names + missed-call CST times)
//   - Y6:AF?   Table 3 (per-agent metrics across Z2-AB2 range)
//   - AH42:AQ? Table 4 (chart feed: monthly aggregates from QCD)
// ============================================================================


// -- Configuration -----------------------------------------------------------

var DQE_DASH_CONFIG = {
  // CDR Report ss ID (where DQE Historical Data and QCD Historical Data live)
  cdrReportSsId:    '182KMgvrBefTv4vjqgrr2RwarNyOgooXOkbVJkY9hO5g',
  dqeSheetName:     'DQE Historical Data',
  qcdSheetName:     'QCD Historical Data',

  // Local DQE Report sheet (assigned agents per department)
  doNotEditSheetName: 'DO NOT EDIT!',

  // Cache TTL in seconds (CacheService) — how long to retain fetched data
  // between dashboard refreshes. 5 min is a reasonable balance.
  cacheTtlSec: 300
};


// -- Menu and triggers -------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('DQE Tools')
    .addItem('Refresh dashboard', 'refreshDashboard')
    .addToUi();

  // On open, set B1 to most recent date and refresh
  try {
    setB1ToMostRecentDate();
    refreshDashboard();
  } catch (e) {
    Logger.log('onOpen refresh skipped: ' + e.message);
  }
}

// Installable trigger for edits (must be set up via Triggers panel)
function onEditTrigger(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();

  // Only run if user is on a department dashboard sheet (not Historical, not DO NOT EDIT, etc.)
  if (!isDeptDashboardSheet(sheet)) return;

  var row = e.range.getRow();
  var col = e.range.getColumn();

  // B1 = single date (col 2, row 1) — refresh all tables
  if (col === 2 && row === 1) {
    refreshDashboardForSheet(sheet);
    return;
  }

  // Z2 (col 26) or AB2 (col 28) = range bounds — refresh tables 3 + 4 only
  if (row === 2 && (col === 26 || col === 28)) {
    refreshDashboardForSheet(sheet);
    return;
  }
}

function isDeptDashboardSheet(sheet) {
  // Skip system sheets — adjust list as needed
  var skipList = ['DO NOT EDIT!', 'DQE Historical Data', 'Raw Data'];
  return skipList.indexOf(sheet.getName()) === -1;
}


// -- Top-level refresh entry points ------------------------------------------

function refreshDashboard() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (!isDeptDashboardSheet(sheet)) {
    SpreadsheetApp.getUi().alert(
      'Please run this from a department dashboard sheet.'
    );
    return;
  }
  refreshDashboardForSheet(sheet);
}

function refreshDashboardForSheet(sheet) {
  var startTime = Date.now();
  var t = startTime;
  function lap(label) {
    var now = Date.now();
    Logger.log('[' + label + '] ' + (now - t) + 'ms');
    t = now;
  }

  var ctx = readDashboardContext(sheet);
  if (!ctx) return;
  lap('readContext');

  // Fetch data sources once, reuse across all four tables
  var dqeRows = fetchDQEHistoricalRows();
  lap('fetchDQE (' + dqeRows.length + ' rows)');

  var qcdRows = fetchQCDHistoricalRows();
  lap('fetchQCD (' + qcdRows.length + ' rows)');

  var assignedAgents = fetchAssignedAgents(ctx.deptName);
  lap('fetchAgents');

  // Build outputs in memory
  var t1 = buildTable1(dqeRows, assignedAgents, ctx);
  lap('buildT1');
  var t2 = buildTable2(dqeRows, t1.agentNames, ctx);
  lap('buildT2');
  var t3 = buildTable3(dqeRows, assignedAgents, ctx);
  lap('buildT3');
  var t4 = buildTable4(qcdRows, ctx);
  lap('buildT4');

  // Write outputs
  writeTable1(sheet, t1);
  lap('writeT1');
  writeTable2(sheet, t2);
  lap('writeT2');
  writeTable3(sheet, t3);
  lap('writeT3');
  writeTable4(sheet, t4);
  lap('writeT4');

  Logger.log('Dashboard refreshed in ' + (Date.now() - startTime) + 'ms total.');
}

function setB1ToMostRecentDate() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (!isDeptDashboardSheet(sheet)) return;

  var dqeRows = fetchDQEHistoricalRows();
  if (!dqeRows.length) return;

  // Find latest date string
  var maxDate = null;
  for (var i = 0; i < dqeRows.length; i++) {
    var d = parseDateMDY(dqeRows[i].date);
    if (d && (!maxDate || d.getTime() > maxDate.getTime())) maxDate = d;
  }
  if (!maxDate) return;

  // Write the same MM/dd/yyyy string format the sheet uses
  var dateStr = formatDateMDY(maxDate);
  sheet.getRange('B1').setValue(dateStr);
}


// -- Read context from the dashboard sheet -----------------------------------

function readDashboardContext(sheet) {
  var b1  = sheet.getRange('B1').getDisplayValue();   // selected date
  var b4  = sheet.getRange('B4').getDisplayValue();   // call queue name
  var b5  = sheet.getRange('B5').getDisplayValue();   // queue extensions CSV
  var z2  = sheet.getRange('Z2').getDisplayValue();   // range start
  var ab2 = sheet.getRange('AB2').getDisplayValue();  // range end

  if (!b1 || !b4 || !b5) {
    Logger.log('Dashboard context missing required cells (B1, B4, B5).');
    return null;
  }

  return {
    deptName:     b4,
    queueExts:    b5.split(',').map(function(s) { return s.trim(); }).filter(Boolean),
    selectedDate: parseDateMDY(b1),
    rangeStart:   z2  ? parseDateMDY(z2)  : null,
    rangeEnd:     ab2 ? parseDateMDY(ab2) : null
  };
}


// -- Data fetchers (with caching) --------------------------------------------

function fetchDQEHistoricalRows() {
  var cache = CacheService.getDocumentCache();
  var cached = cache.get('dqeRows');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }

  var ss    = SpreadsheetApp.openById(DQE_DASH_CONFIG.cdrReportSsId);
  var sheet = ss.getSheetByName(DQE_DASH_CONFIG.dqeSheetName);
  if (!sheet) throw new Error('Sheet "' + DQE_DASH_CONFIG.dqeSheetName + '" not found in CDR Report.');

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // Cols A-AH = 34 cols. Use display values for consistent string handling.
  var data = sheet.getRange(2, 1, lastRow - 1, 34).getDisplayValues();

  // Schema: A=monthYr, B=date, C=agent, D=queueExts, E=unique, F=rung,
  // G=missed, H=answered, I=ttt, J=att, K-AC=slots(19), AD=abParentIds,
  // AE=abMissedIds, AF=abMissedTimes, AG=avgAbdWait, AH=csrAvgAbdWait
  var rows = data.map(function(r) {
    return {
      monthYear: r[0],
      date:      r[1],
      agent:     r[2],
      queueExts: r[3],
      unique:    parseInt(r[4]) || 0,
      rung:      parseInt(r[5]) || 0,
      missed:    parseInt(r[6]) || 0,
      answered:  parseInt(r[7]) || 0,
      ttt:       r[8],
      att:       r[9],
      slots:     r.slice(10, 29),       // K-AC, 19 entries
      abMissedTimes: r[31]              // AF
    };
  }).filter(function(r) { return r.date && r.agent; });

  try {
    cache.put('dqeRows', JSON.stringify(rows), DQE_DASH_CONFIG.cacheTtlSec);
  } catch (e) { /* cache too big — skip */ }

  return rows;
}

function fetchQCDHistoricalRows() {
  var cache = CacheService.getDocumentCache();
  var cached = cache.get('qcdRows');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }

  var ss    = SpreadsheetApp.openById(DQE_DASH_CONFIG.cdrReportSsId);
  var sheet = ss.getSheetByName(DQE_DASH_CONFIG.qcdSheetName);
  if (!sheet) throw new Error('Sheet "' + DQE_DASH_CONFIG.qcdSheetName + '" not found in CDR Report.');

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getDisplayValues();

  // Schema: A=monthYr, B=week, C=date, D=callQueue, E=callSource,
  // F=totalCalls, G=totalAnswered, H=abandoned, I=longestWait,
  // J=avgAnswer, K=abandonedPct, L=violations
  var rows = data.map(function(r) {
    return {
      date:         r[2],
      callQueue:    r[3],
      callSource:   r[4],
      totalCalls:   parseInt(r[5]) || 0,
      totalAnswered: parseInt(r[6]) || 0,
      abandoned:    parseInt(r[7]) || 0,
      longestWait:  hmsToSec(r[8]),
      avgAnswer:    hmsToSec(r[9]),
      violations:   parseInt(r[11]) || 0
    };
  }).filter(function(r) { return r.date; });

  try {
    cache.put('qcdRows', JSON.stringify(rows), DQE_DASH_CONFIG.cacheTtlSec);
  } catch (e) { /* skip */ }

  return rows;
}

function fetchAssignedAgents(deptName) {
  // Reads from local "DO NOT EDIT!" sheet
  // Headers are department short names (e.g. "Sales") while B4 contains
  // the call queue name (e.g. "A_Q_Sales") — strip the "A_Q_" prefix
  // and try multiple normalization variants.
  var sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(DQE_DASH_CONFIG.doNotEditSheetName);
  if (!sheet) {
    Logger.log('fetchAssignedAgents: "DO NOT EDIT!" sheet not found.');
    return [];
  }

  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Generate candidate header names to match against
  // B4 values like "A_Q_Sales" / "A_Q_FieldOps" / "A_Q_FieldOps_Power" need
  // to map to headers like "Sales" / "Field Ops" / "Field Ops Power"
  var stripped = deptName.replace(/^A_Q_/, '').trim();
  var candidates = [
    deptName.trim(),
    stripped,
    stripped.replace(/_/g, ' '),                          // "Field_Ops" -> "Field Ops"
    stripped.replace(/([a-z])([A-Z])/g, '$1 $2'),         // "FieldOps" -> "Field Ops"
    stripped.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
  ];

  var deptCol = -1;
  for (var c = 0; c < headers.length; c++) {
    var h = String(headers[c]).trim();
    if (!h) continue;
    for (var ci = 0; ci < candidates.length; ci++) {
      if (h.toLowerCase() === candidates[ci].toLowerCase()) {
        deptCol = c + 1;
        break;
      }
    }
    if (deptCol !== -1) break;
  }

  if (deptCol === -1) {
    Logger.log('fetchAssignedAgents: no matching header for "' + deptName +
      '". Tried: ' + candidates.join(', ') + '. Headers found: ' + headers.join(', '));
    return [];
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, deptCol, lastRow - 1, 1).getValues();
  var agents = values
    .map(function(r) { return String(r[0]).trim(); })
    .filter(Boolean);

  Logger.log('fetchAssignedAgents: dept "' + deptName + '" matched header "' +
    headers[deptCol - 1] + '", found ' + agents.length + ' agents.');

  return agents;
}


// -- Table 1: per-agent metrics for selected date ----------------------------

function buildTable1(dqeRows, assignedAgents, ctx) {
  var dateStr = formatDateMDY(ctx.selectedDate);

  // Diagnostic: count matches at each filter stage
  var afterDate  = dqeRows.filter(function(r) { return r.date === dateStr; });
  var afterAgent = afterDate.filter(function(r) { return assignedAgents.indexOf(r.agent) !== -1; });
  var matched    = afterAgent.filter(function(r) { return queueExtsOverlap(r.queueExts, ctx.queueExts); });

  Logger.log('Table1 filter chain:'
    + ' total rows=' + dqeRows.length
    + ', after date "' + dateStr + '"=' + afterDate.length
    + ', after agent filter=' + afterAgent.length
    + ', after queue ext overlap=' + matched.length);

  if (afterDate.length === 0 && dqeRows.length > 0) {
    var sampleDates = dqeRows.slice(0, 3).map(function(r) { return r.date; });
    Logger.log('Date format check — looking for "' + dateStr + '", sample DQE dates: ' + sampleDates.join(', '));
  }
  if (afterAgent.length === 0 && afterDate.length > 0) {
    var sampleAgents = afterDate.slice(0, 5).map(function(r) { return r.agent; });
    Logger.log('Agent name mismatch — assigned: ' + assignedAgents.slice(0, 5).join(', ') +
      '... DQE agents on this date: ' + sampleAgents.join(', '));
  }
  if (matched.length === 0 && afterAgent.length > 0) {
    var sampleExts = afterAgent.slice(0, 5).map(function(r) { return r.queueExts; });
    Logger.log('Queue ext mismatch — looking for: ' + ctx.queueExts.join(',') +
      '. Agent extensions: ' + sampleExts.join(' | '));
  }

  // Build one row per unique agent (date+agent already unique in source)
  var agentNames = [];
  var output = matched.map(function(r) {
    agentNames.push(r.agent);
    var pctAnswered = r.rung > 0 ? (r.answered / r.rung) : 0;
    return [
      r.agent,
      r.unique,
      r.rung,
      r.missed,
      r.answered,
      pctAnswered,
      r.ttt,
      r.att
    ];
  });

  return { rows: output, agentNames: agentNames };
}

function writeTable1(sheet, t1) {
  // Clear A8:H to wipe stale data, then write
  var clearRange = sheet.getRange(8, 1, Math.max(sheet.getMaxRows() - 7, 1), 8);
  clearRange.clearContent();

  if (t1.rows.length > 0) {
    sheet.getRange(8, 1, t1.rows.length, 8).setValues(t1.rows);
    // Format col F as percentage
    sheet.getRange(8, 6, t1.rows.length, 1).setNumberFormat('0.00%');
  }
}


// -- Table 2: transposed agent names + missed-call CST times -----------------

function buildTable2(dqeRows, agentNames, ctx) {
  var dateStr = formatDateMDY(ctx.selectedDate);

  // For each agent, gather slot times + abandoned times for date
  var perAgent = agentNames.map(function(name) {
    var row = dqeRows.find(function(r) {
      return r.date === dateStr && r.agent === name;
    });
    if (!row) return { agent: name, missedTimes: [], abandonedTimes: [] };

    // Combine all 19 slot strings -> array of CST timestamps
    var allTimes = [];
    row.slots.forEach(function(slotStr) {
      if (!slotStr) return;
      slotStr.split(',').forEach(function(t) {
        var trimmed = t.trim();
        if (trimmed) allTimes.push(trimmed);
      });
    });

    var abandonedTimes = String(row.abMissedTimes || '')
      .split(',')
      .map(function(s) { return s.trim(); })
      .filter(Boolean);

    return {
      agent:          name,
      missedTimes:    allTimes,
      abandonedTimes: abandonedTimes
    };
  });

  // Determine grid size: max missed-times count across agents
  var maxRows = perAgent.reduce(function(max, a) {
    return Math.max(max, a.missedTimes.length);
  }, 0);

  // Build 2D grid: row 22 = agent names (transposed list)
  // Rows 23..(22+maxRows) = each agent's missed times in column position
  var grid = [];
  // Row 22: agent names
  grid.push(perAgent.map(function(a) { return a.agent; }));
  // Rows 23+: timestamps
  for (var i = 0; i < maxRows; i++) {
    var rowArr = perAgent.map(function(a) {
      var t = a.missedTimes[i];
      if (!t) return '';
      var label = formatTimeAMPM(t);
      // Mark with siren if also in abandoned list
      if (a.abandonedTimes.indexOf(t) !== -1) {
        return label + ' \uD83D\uDEA8'; // 🚨
      }
      return label;
    });
    grid.push(rowArr);
  }

  // If no agents had any missed calls, replace each cell with "No Missed Calls"
  if (maxRows === 0) {
    grid.push(perAgent.map(function() { return 'No Missed Calls'; }));
  }

  return { grid: grid };
}

function writeTable2(sheet, t2) {
  // Clear A22:? down to bottom of usable range
  var clearRange = sheet.getRange(22, 1, Math.max(sheet.getMaxRows() - 21, 1), Math.max(t2.grid[0].length, 1));
  clearRange.clearContent();

  if (t2.grid.length === 0 || t2.grid[0].length === 0) return;

  sheet.getRange(22, 1, t2.grid.length, t2.grid[0].length).setValues(t2.grid);
}


// -- Table 3: per-agent metrics across date range ----------------------------

function buildTable3(dqeRows, assignedAgents, ctx) {
  if (!ctx.rangeStart || !ctx.rangeEnd) return { rows: [] };

  var startTime = ctx.rangeStart.getTime();
  var endTime   = ctx.rangeEnd.getTime();

  // Filter to date range AND assigned agents AND queue overlap
  var matched = dqeRows.filter(function(r) {
    var d = parseDateMDY(r.date);
    if (!d) return false;
    var t = d.getTime();
    if (t < startTime || t > endTime) return false;
    if (assignedAgents.indexOf(r.agent) === -1) return false;
    return queueExtsOverlap(r.queueExts, ctx.queueExts);
  });

  // Aggregate per agent
  var agg = {};
  matched.forEach(function(r) {
    if (!agg[r.agent]) {
      agg[r.agent] = {
        unique: 0, rung: 0, missed: 0, answered: 0,
        tttSec: 0, attSecs: []
      };
    }
    agg[r.agent].unique   += r.unique;
    agg[r.agent].rung     += r.rung;
    agg[r.agent].missed   += r.missed;
    agg[r.agent].answered += r.answered;
    agg[r.agent].tttSec   += hmsToSec(r.ttt);
    var attS = hmsToSec(r.att);
    if (attS > 0) agg[r.agent].attSecs.push(attS);
  });

  // Format output rows
  var rows = Object.keys(agg).map(function(agent) {
    var a = agg[agent];
    var pctAnswered = a.rung > 0 ? (a.answered / a.rung) : 0;
    var attAvg = a.attSecs.length > 0
      ? a.attSecs.reduce(function(s, v) { return s + v; }, 0) / a.attSecs.length
      : 0;
    return [
      agent,
      a.unique,
      a.rung,
      a.missed,
      a.answered,
      pctAnswered,
      secToHMS(a.tttSec),
      secToHMS(Math.round(attAvg))
    ];
  });

  return { rows: rows };
}

function writeTable3(sheet, t3) {
  // Clear Y6:AF down
  var clearRange = sheet.getRange(6, 25, Math.max(sheet.getMaxRows() - 5, 1), 8);
  clearRange.clearContent();

  if (t3.rows.length === 0) return;

  sheet.getRange(6, 25, t3.rows.length, 8).setValues(t3.rows);
  sheet.getRange(6, 30, t3.rows.length, 1).setNumberFormat('0.00%'); // col AD = % Answered
}


// -- Table 4: monthly chart feed from QCD Historical Data --------------------

function buildTable4(qcdRows, ctx) {
  if (!ctx.rangeStart || !ctx.rangeEnd) return { rows: [] };

  // Generate one row per month between rangeStart and rangeEnd (inclusive)
  var months = [];
  var cursor = new Date(ctx.rangeStart.getFullYear(), ctx.rangeStart.getMonth(), 1);
  var stop   = new Date(ctx.rangeEnd.getFullYear(),   ctx.rangeEnd.getMonth(),   1);
  while (cursor.getTime() <= stop.getTime()) {
    months.push(new Date(cursor.getTime()));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  // Sources to fetch counts for (cols AI-AM in original)
  var sources = ['Total Calls', 'CSR', 'Ad-campaign', 'New Call Menu', 'Non-CSR (internal)'];

  var rows = months.map(function(monthStart) {
    var monthEndExclusive = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
    var startT = monthStart.getTime();
    var endT   = monthEndExclusive.getTime();

    // Filter QCD rows: dept matches B4, date in month
    var monthRows = qcdRows.filter(function(r) {
      if (r.callQueue !== ctx.deptName) return false;
      var d = parseDateMDY(r.date);
      if (!d) return false;
      var t = d.getTime();
      return t >= startT && t < endT;
    });

    // Per-source counts (avg of totalCalls for matching source)
    var sourceCounts = sources.map(function(src) {
      var srcRows = monthRows.filter(function(r) { return r.callSource === src; });
      if (srcRows.length === 0) return 0;
      var sum = srcRows.reduce(function(s, r) { return s + r.totalCalls; }, 0);
      return sum / srcRows.length;
    });

    // Aggregate metrics across all "Total Calls" rows for this month
    var totalCallsRows = monthRows.filter(function(r) { return r.callSource === 'Total Calls'; });
    var longestWaitAvgSec = totalCallsRows.length === 0 ? 0
      : totalCallsRows.reduce(function(s, r) { return s + r.longestWait; }, 0) / totalCallsRows.length;
    var avgAnswerAvgSec = totalCallsRows.length === 0 ? 0
      : totalCallsRows.reduce(function(s, r) { return s + r.avgAnswer; }, 0) / totalCallsRows.length;

    var sumAban  = totalCallsRows.reduce(function(s, r) { return s + r.abandoned;  }, 0);
    var sumTotal = totalCallsRows.reduce(function(s, r) { return s + r.totalCalls; }, 0);
    var abandonedPct = sumTotal > 0 ? (sumAban / sumTotal) : 0;

    var violations = totalCallsRows.reduce(function(s, r) { return s + r.violations; }, 0);

    return [
      monthStart,           // AH (Date — formatted later)
      sourceCounts[0],      // AI Total Calls
      sourceCounts[1],      // AJ CSR
      sourceCounts[2],      // AK Ad-campaign
      sourceCounts[3],      // AL New Call Menu
      sourceCounts[4],      // AM Non-CSR (internal)
      secToHMS(Math.round(longestWaitAvgSec)),  // AN Longest Wait
      secToHMS(Math.round(avgAnswerAvgSec)),    // AO Avg Answer
      abandonedPct,         // AP Abandoned %
      violations            // AQ Violations
    ];
  });

  return { rows: rows };
}

function writeTable4(sheet, t4) {
  // Clear AH42:AQ down
  var clearRange = sheet.getRange(42, 34, Math.max(sheet.getMaxRows() - 41, 1), 10);
  clearRange.clearContent();

  if (t4.rows.length === 0) return;

  sheet.getRange(42, 34, t4.rows.length, 10).setValues(t4.rows);
  sheet.getRange(42, 34, t4.rows.length, 1).setNumberFormat('mmm yyyy');     // AH
  sheet.getRange(42, 42, t4.rows.length, 1).setNumberFormat('0.00%');         // AP
}


// -- Helpers -----------------------------------------------------------------

// "MM/DD/YYYY" -> Date (local, midnight)
function parseDateMDY(str) {
  if (!str) return null;
  var s = String(str).trim();
  // Allow either MM/DD/YYYY or M/D/YYYY
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) {
    // Try parsing as Date (covers ISO-like)
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  return new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
}

function formatDateMDY(d) {
  if (!d) return '';
  // Zero-padded MM/DD/YYYY to match DQE Historical Data storage format
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return mm + '/' + dd + '/' + d.getFullYear();
}

// "H:MM:SS" or "HH:MM:SS" -> seconds
function hmsToSec(val) {
  if (!val) return 0;
  var s = String(val).trim();
  if (!s) return 0;
  var p = s.split(':');
  if (p.length < 2) return 0;
  return (parseInt(p[0]) || 0) * 3600 + (parseInt(p[1]) || 0) * 60 + (parseInt(p[2]) || 0);
}

function secToHMS(sec) {
  var s = Math.max(0, Math.round(sec));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var r = s % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

// Format CST time string "H:MM:SS" -> "H:MM:SS AM/PM" (matches old formula output)
function formatTimeAMPM(timeStr) {
  if (!timeStr) return '';
  var p = String(timeStr).trim().split(':');
  if (p.length < 2) return timeStr;
  var h = parseInt(p[0]) || 0;
  var m = parseInt(p[1]) || 0;
  var s = parseInt(p[2]) || 0;
  var ampm = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ' ' + ampm;
}

// Check if any extension in agentExts (CSV string) appears in deptExts (array)
function queueExtsOverlap(agentExts, deptExts) {
  if (!agentExts || !deptExts || !deptExts.length) return false;
  var agentList = String(agentExts).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  for (var i = 0; i < agentList.length; i++) {
    if (deptExts.indexOf(agentList[i]) !== -1) return true;
  }
  return false;
}