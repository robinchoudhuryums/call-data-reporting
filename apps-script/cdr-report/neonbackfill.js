// ============================================================================
// neonBackfill.gs — Phase 2 of DQE/QCD Neon migration
// ----------------------------------------------------------------------------
// One-time backfill scripts that read existing rows from "DQE Historical Data"
// and "QCD Historical Data" sheets and write them to Neon Postgres.
//
// Idempotent: ON CONFLICT DO NOTHING means safe to re-run if interrupted.
// Resumable: tracks progress in Script Properties so timeouts don't lose work.
//
// Usage:
//   1. Add NEON_HOST, NEON_DB, NEON_USER, NEON_PASS to Script Properties
//      (same credentials as your existing CDR archive)
//   2. Run backfillDQEHistory() — repeat until "complete"
//   3. Run backfillQCDHistory() — repeat until "complete"
// ============================================================================


// -- Connection helper -------------------------------------------------------

function getNeonConn_backfill() {
  var p   = PropertiesService.getScriptProperties();
  var url = 'jdbc:postgresql://' + p.getProperty('NEON_HOST') + '/' + p.getProperty('NEON_DB');
  return Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS'));
}


// -- DQE backfill ------------------------------------------------------------

function backfillDQEHistory() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet) { Logger.log('DQE: Sheet not found.'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('DQE: Sheet is empty.'); return; }

  // Read all 36 columns as display values for consistent string handling
  var data = sheet.getRange(2, 1, lastRow - 1, 36).getDisplayValues();

  var props      = PropertiesService.getScriptProperties();
  var startIndex = parseInt(props.getProperty('DQE_BACKFILL_RESUME') || '0');

  Logger.log('DQE backfill: starting at index ' + startIndex + ' of ' + data.length);

  if (startIndex >= data.length) {
    Logger.log('DQE backfill complete. Clear DQE_BACKFILL_RESUME to re-run.');
    return;
  }

  var BATCH_SIZE     = 50;
  var TIME_LIMIT_MS  = 240000;
  var startTime      = Date.now();

  var totalInserted = 0;
  var i = startIndex;

  try {
    while (i < data.length) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        props.setProperty('DQE_BACKFILL_RESUME', String(i));
        Logger.log('Time limit reached. Resume saved at index ' + i +
          '. Inserted: ' + totalInserted + '. Run again to continue.');
        return;
      }

      var batch = [];
      var batchEnd = Math.min(i + BATCH_SIZE, data.length);
      while (i < batchEnd) {
        var r = data[i];
        if (!r[1] || !r[2]) { i++; continue; }

        batch.push({
          monthYear:        r[0]  || null,
          callDate:         parseDateForNeon(r[1]),
          agentName:        r[2],
          queueExtensions:  r[3]  || null,
          totalUnique:      parseInt(r[4]) || 0,
          totalRung:        parseInt(r[5]) || 0,
          totalMissed:      parseInt(r[6]) || 0,
          totalAnswered:    parseInt(r[7]) || 0,
          ttt:              r[8]  || null,
          att:              r[9]  || null,
          slots:            r.slice(10, 29),
          abParentIds:      r[29] || null,
          abMissedIds:      r[30] || null,
          abMissedTimes:    r[31] || null,
          avgAbdWait:       r[32] || null,
          csrAvgAbdWait:    r[33] || null
        });
        i++;
      }

      if (batch.length === 0) continue;

      var conn = getNeonConn_backfill();
      conn.setAutoCommit(false);

      try {
        var placeholderRow  = '(' + new Array(34).fill('?').join(',') + ')';
        var allPlaceholders = batch.map(function() { return placeholderRow; }).join(',');

        var sql = 'INSERT INTO dqe_history (' +
          'month_year, call_date, agent_name, queue_extensions, ' +
          'total_unique, total_rung, total_missed, total_answered, ttt, att, ' +
          'slot_0800_0830, slot_0830_0900, slot_0900_0930, slot_0930_1000, slot_1000_1030, ' +
          'slot_1030_1100, slot_1100_1130, slot_1130_1200, slot_1200_1230, slot_1230_1300, ' +
          'slot_1300_1330, slot_1330_1400, slot_1400_1430, slot_1430_1500, slot_1500_1530, ' +
          'slot_1530_1600, slot_1600_1630, slot_1630_1700, slot_1700_1730, ' +
          'abandoned_parent_ids, abandoned_missed_ids, abandoned_missed_times, ' +
          'avg_abd_wait, csr_avg_abd_wait' +
          ') VALUES ' + allPlaceholders +
          ' ON CONFLICT ON CONSTRAINT uq_dqe_history DO NOTHING';

        var stmt = conn.prepareStatement(sql);
        var p = 1;
        for (var b = 0; b < batch.length; b++) {
          var row = batch[b];
          stmt.setString(p++, row.monthYear);
          stmt.setString(p++, row.callDate);
          stmt.setString(p++, row.agentName);
          stmt.setString(p++, row.queueExtensions);
          stmt.setInt(p++,    row.totalUnique);
          stmt.setInt(p++,    row.totalRung);
          stmt.setInt(p++,    row.totalMissed);
          stmt.setInt(p++,    row.totalAnswered);
          stmt.setString(p++, row.ttt);
          stmt.setString(p++, row.att);
          for (var s = 0; s < 19; s++) {
            stmt.setString(p++, row.slots[s] || null);
          }
          stmt.setString(p++, row.abParentIds);
          stmt.setString(p++, row.abMissedIds);
          stmt.setString(p++, row.abMissedTimes);
          stmt.setString(p++, row.avgAbdWait);
          stmt.setString(p++, row.csrAvgAbdWait);
        }

        stmt.execute();
        stmt.close();
        conn.commit();

        totalInserted += batch.length;
        Logger.log('Committed batch ending at index ' + i + '. Cumulative inserted: ' + totalInserted);

      } catch (e) {
        conn.rollback();
        i = i - batch.length;
        var safeIndex = Math.max(0, i);
        props.setProperty('DQE_BACKFILL_RESUME', String(safeIndex));
        Logger.log('Batch failed, rolled back. Resume at ' + safeIndex + '. Error: ' + e.message);
        throw e;
      } finally {
        conn.close();
      }
    }

    props.deleteProperty('DQE_BACKFILL_RESUME');
    Logger.log('DQE backfill complete. Total processed: ' + (i - startIndex) +
      '. Total inserted into Neon: ' + totalInserted);

  } catch (e) {
    Logger.log('DQE backfill stopped. Error: ' + e.message);
    throw e;
  }
}


// -- QCD backfill ------------------------------------------------------------

// -- QCD backfill ------------------------------------------------------------

function backfillQCDHistory() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('QCD Historical Data');
  if (!sheet) { Logger.log('QCD: Sheet not found.'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('QCD: Sheet is empty.'); return; }

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getDisplayValues();

  var props      = PropertiesService.getScriptProperties();
  var startIndex = parseInt(props.getProperty('QCD_BACKFILL_RESUME') || '0');

  Logger.log('QCD backfill: starting at index ' + startIndex + ' of ' + data.length);

  if (startIndex >= data.length) {
    Logger.log('QCD backfill complete. Clear QCD_BACKFILL_RESUME to re-run.');
    return;
  }

  var BATCH_SIZE       = 250;
  var TIME_LIMIT_MS    = 240000;       // 4 min — overall run cap
  var CONN_REFRESH_MS  = 120000;       // 2 min — refresh DB connection
  var startTime        = Date.now();

  var totalInserted = 0;
  var i = startIndex;

  // Open one connection up front, refresh periodically rather than per batch
  var conn = getNeonConn_backfill();
  conn.setAutoCommit(false);
  var connOpenedAt = Date.now();

  try {
    while (i < data.length) {

      // Hard time-limit check — commit, close, and save resume position
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        try { conn.commit(); } catch (ce) {}
        try { conn.close();  } catch (ce) {}
        props.setProperty('QCD_BACKFILL_RESUME', String(i));
        Logger.log('Time limit reached. Resume saved at ' + i +
          '. Cumulative inserted: ' + totalInserted + '.');
        return;
      }

      // Refresh connection if it's been open longer than CONN_REFRESH_MS
      if (Date.now() - connOpenedAt > CONN_REFRESH_MS) {
        try { conn.commit(); } catch (ce) {}
        try { conn.close();  } catch (ce) {}
        conn = getNeonConn_backfill();
        conn.setAutoCommit(false);
        connOpenedAt = Date.now();
      }

      // Build one batch of rows
      var batch = [];
      var batchEnd = Math.min(i + BATCH_SIZE, data.length);
      while (i < batchEnd) {
        var r = data[i];
        if (!r[2] || !r[3] || !r[4]) { i++; continue; }

        var pctStr = String(r[10] || '').trim().replace('%', '');
        var pctVal = parseFloat(pctStr);
        if (!isNaN(pctVal) && pctVal > 1) pctVal = pctVal / 100;
        if (isNaN(pctVal)) pctVal = 0;

        batch.push({
          monthYear:     r[0] || null,
          week:          r[1] || null,
          callDate:      parseDateForNeon(r[2]),
          callQueue:     r[3],
          callSource:    r[4],
          totalCalls:    parseInt(r[5]) || 0,
          totalAnswered: parseInt(r[6]) || 0,
          abandoned:     parseInt(r[7]) || 0,
          longestWait:   normalizeDuration(r[8]),
          avgAnswer:     normalizeDuration(r[9]),
          abandonedPct:  pctVal,
          violations:    parseInt(r[11]) || 0
        });
        i++;
      }

      if (batch.length === 0) continue;

      // Execute the batch on the persistent connection
      try {
        var placeholderRow  = '(' + new Array(12).fill('?').join(',') + ')';
        var allPlaceholders = batch.map(function() { return placeholderRow; }).join(',');

        var sql = 'INSERT INTO qcd_history (' +
          'month_year, week, call_date, call_queue, call_source, ' +
          'total_calls, total_answered, abandoned, longest_wait, avg_answer, ' +
          'abandoned_pct, violations' +
          ') VALUES ' + allPlaceholders +
          ' ON CONFLICT ON CONSTRAINT uq_qcd_history DO NOTHING';

        var stmt = conn.prepareStatement(sql);
        var p = 1;
        for (var b = 0; b < batch.length; b++) {
          var row = batch[b];
          stmt.setString(p++, row.monthYear);
          stmt.setString(p++, row.week);
          stmt.setString(p++, row.callDate);
          stmt.setString(p++, row.callQueue);
          stmt.setString(p++, row.callSource);
          stmt.setInt(p++,    row.totalCalls);
          stmt.setInt(p++,    row.totalAnswered);
          stmt.setInt(p++,    row.abandoned);
          stmt.setString(p++, row.longestWait);
          stmt.setString(p++, row.avgAnswer);
          stmt.setDouble(p++, row.abandonedPct);
          stmt.setInt(p++,    row.violations);
        }

        stmt.execute();
        stmt.close();
        conn.commit();

        totalInserted += batch.length;
        Logger.log('Committed batch ending at index ' + i + '. Cumulative inserted: ' + totalInserted);

      } catch (e) {
        try { conn.rollback(); } catch (re) {}
        i = i - batch.length;
        var safeIndex = Math.max(0, i);
        props.setProperty('QCD_BACKFILL_RESUME', String(safeIndex));
        Logger.log('Batch failed, rolled back. Resume at ' + safeIndex + '. Error: ' + e.message);
        try { conn.close(); } catch (ce) {}
        throw e;
      }
    }

    // Loop completed naturally — final commit and cleanup
    try { conn.commit(); } catch (ce) {}
    try { conn.close();  } catch (ce) {}
    props.deleteProperty('QCD_BACKFILL_RESUME');
    Logger.log('QCD backfill complete. Total processed: ' + (i - startIndex) +
      '. Total inserted into Neon: ' + totalInserted + '.');

  } catch (e) {
    try { conn.close(); } catch (ce) {}
    Logger.log('QCD backfill stopped. Error: ' + e.message);
    throw e;
  }
}


// -- Verification helper -----------------------------------------------------

function verifyNeonBackfillCounts() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var dqeSheet = ss.getSheetByName('DQE Historical Data');
  var qcdSheet = ss.getSheetByName('QCD Historical Data');

  var sheetDqeCount = dqeSheet ? Math.max(0, dqeSheet.getLastRow() - 1) : 0;
  var sheetQcdCount = qcdSheet ? Math.max(0, qcdSheet.getLastRow() - 1) : 0;

  var conn = getNeonConn_backfill();
  try {
    var stmt = conn.createStatement();

    var rs1 = stmt.executeQuery('SELECT COUNT(*) FROM dqe_history');
    rs1.next();
    var neonDqeCount = rs1.getInt(1);
    rs1.close();

    var rs2 = stmt.executeQuery('SELECT COUNT(*) FROM qcd_history');
    rs2.next();
    var neonQcdCount = rs2.getInt(1);
    rs2.close();

    stmt.close();

    Logger.log('=== Backfill verification ===');
    Logger.log('DQE — Sheet rows: ' + sheetDqeCount + ' | Neon rows: ' + neonDqeCount);
    Logger.log('QCD — Sheet rows: ' + sheetQcdCount + ' | Neon rows: ' + neonQcdCount);
  } finally {
    conn.close();
  }
}


// -- Helpers -----------------------------------------------------------------

function parseDateForNeon(str) {
  if (!str) return null;
  var s = String(str).trim();
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) {
    var d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var month = String(parseInt(m[1])).padStart(2, '0');
  var day   = String(parseInt(m[2])).padStart(2, '0');
  return m[3] + '-' + month + '-' + day;
}

// Convert either an "H:MM:SS" string or a decimal day-fraction to "H:MM:SS"
function normalizeDuration(val) {
  if (val === null || val === undefined || val === '') return null;
  var s = String(val).trim();
  if (!s) return null;

  // Already in time format
  if (s.indexOf(':') !== -1) return s;

  // Decimal day-fraction → seconds → H:MM:SS
  var num = parseFloat(s);
  if (isNaN(num)) return null;

  var totalSec = Math.round(num * 86400);
  var h = Math.floor(totalSec / 3600);
  var m = Math.floor((totalSec % 3600) / 60);
  var sec = totalSec % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function diagnoseQCDLongValues() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('QCD Historical Data');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('Empty.'); return; }

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getDisplayValues();

  var offenders = { monthYear: [], week: [], longestWait: [], avgAnswer: [] };

  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    var month = String(r[0] || '');
    var week  = String(r[1] || '');
    var lw    = String(r[8] || '');
    var aa    = String(r[9] || '');

    if (month.length > 20) offenders.monthYear.push({ row: i + 2, len: month.length, val: month });
    if (week.length > 20)  offenders.week.push({ row: i + 2, len: week.length, val: week });
    if (lw.length > 10)    offenders.longestWait.push({ row: i + 2, len: lw.length, val: lw });
    if (aa.length > 10)    offenders.avgAnswer.push({ row: i + 2, len: aa.length, val: aa });
  }

  Logger.log('=== Long-value scan ===');
  ['monthYear', 'week', 'longestWait', 'avgAnswer'].forEach(function(field) {
    var o = offenders[field];
    Logger.log(field + ': ' + o.length + ' offenders');
    o.slice(0, 5).forEach(function(x) {
      Logger.log('  Row ' + x.row + ' (len ' + x.len + '): "' + x.val + '"');
    });
  });
}