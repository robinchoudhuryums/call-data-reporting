// ============================================================================
// neonWrite.gs — Phase 3 of DQE/QCD Neon migration
// ----------------------------------------------------------------------------
// Reusable Neon write functions called from both the live and bulk pipelines.
// On failure: logs the error and emails the configured alert address.
// Sheet writes always succeed regardless of Neon outcome — Neon is a mirror.
// ============================================================================

var NEON_WRITE_CONFIG = {
  alertEmail: 'robin.choudhury@universalmedsupply.com'
};

function getNeonConn_write() {
  var p   = PropertiesService.getScriptProperties();
  var url = 'jdbc:postgresql://' + p.getProperty('NEON_HOST') + '/' + p.getProperty('NEON_DB');
  return Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS'));
}

function notifyNeonWriteFailure(context, errMsg) {
  Logger.log('Neon write failed [' + context + ']: ' + errMsg);
  try {
    MailApp.sendEmail(
      NEON_WRITE_CONFIG.alertEmail,
      'Neon write failure: ' + context,
      'A Neon write step failed in ' + context + '.\n\n' +
      'Sheet pipeline was unaffected — Neon mirror is now out of sync ' +
      'and will need to be re-synced via the backfill scripts.\n\n' +
      'Error: ' + errMsg + '\n\nTime: ' + new Date()
    );
  } catch (mailErr) {
    Logger.log('Also failed to send alert email: ' + mailErr.message);
  }
}

// -- DQE writer --------------------------------------------------------------
function writeDQERowsToNeon(rows) {
  if (!rows || !rows.length) return { inserted: 0, skipped: 0 };

  var conn = getNeonConn_write();
  conn.setAutoCommit(false);

  try {
    var placeholderRow  = '(' + new Array(34).fill('?').join(',') + ')';
    var allPlaceholders = rows.map(function() { return placeholderRow; }).join(',');

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
    for (var b = 0; b < rows.length; b++) {
      var row = rows[b];
      stmt.setString(p++, row.monthYear);
      stmt.setString(p++, parseDateForNeon(row.callDate));
      stmt.setString(p++, row.agentName);
      stmt.setString(p++, row.queueExtensions);
      stmt.setInt(p++,    row.totalUnique || 0);
      stmt.setInt(p++,    row.totalRung || 0);
      stmt.setInt(p++,    row.totalMissed || 0);
      stmt.setInt(p++,    row.totalAnswered || 0);
      stmt.setString(p++, row.ttt);
      stmt.setString(p++, row.att);
      for (var s = 0; s < 19; s++) {
        stmt.setString(p++, (row.slots && row.slots[s]) || null);
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

    Logger.log('writeDQERowsToNeon: wrote ' + rows.length + ' rows.');
    return { inserted: rows.length };

  } catch (e) {
    try { conn.rollback(); } catch (re) {}
    throw e;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// -- QCD writer --------------------------------------------------------------
function writeQCDRowsToNeon(rows) {
  if (!rows || !rows.length) return { inserted: 0 };

  var conn = getNeonConn_write();
  conn.setAutoCommit(false);

  try {
    var placeholderRow  = '(' + new Array(12).fill('?').join(',') + ')';
    var allPlaceholders = rows.map(function() { return placeholderRow; }).join(',');

    var sql = 'INSERT INTO qcd_history (' +
      'month_year, week, call_date, call_queue, call_source, ' +
      'total_calls, total_answered, abandoned, longest_wait, avg_answer, ' +
      'abandoned_pct, violations' +
      ') VALUES ' + allPlaceholders +
      ' ON CONFLICT ON CONSTRAINT uq_qcd_history DO NOTHING';

    var stmt = conn.prepareStatement(sql);
    var p = 1;
    for (var b = 0; b < rows.length; b++) {
      var row = rows[b];
      stmt.setString(p++, row.monthYear);
      stmt.setString(p++, row.week);
      stmt.setString(p++, parseDateForNeon(row.callDate));
      stmt.setString(p++, row.callQueue);
      stmt.setString(p++, row.callSource);
      stmt.setInt(p++,    row.totalCalls || 0);
      stmt.setInt(p++,    row.totalAnswered || 0);
      stmt.setInt(p++,    row.abandoned || 0);
      stmt.setString(p++, normalizeDuration(row.longestWait));
      stmt.setString(p++, normalizeDuration(row.avgAnswer));
      stmt.setDouble(p++, row.abandonedPct || 0);
      stmt.setInt(p++,    row.violations || 0);
    }

    stmt.execute();
    stmt.close();
    conn.commit();

    Logger.log('writeQCDRowsToNeon: wrote ' + rows.length + ' rows.');
    return { inserted: rows.length };

  } catch (e) {
    try { conn.rollback(); } catch (re) {}
    throw e;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}