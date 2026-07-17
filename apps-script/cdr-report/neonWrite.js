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

// Per-run memo for phone-number HMAC hashes (A2). Reset at the top of
// writeCDRRowsToNeon so it never accumulates across separate import runs
// on a warm instance. Avoids re-hashing the same recurring number
// thousands of times in one CDR mirror -- computeHmacSha256Signature is
// slow in Apps Script and the same outbound numbers recur heavily.
var CDR_HMAC_CACHE_ = {};

function getNeonConn_write() {
  var p   = PropertiesService.getScriptProperties();
  var host = p.getProperty('NEON_HOST');
  if (!host) { Logger.log('Neon: NEON_HOST not configured — skipping.'); return null; }
  var url = 'jdbc:postgresql://' + host + '/' + p.getProperty('NEON_DB');
  return Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS'));
}

// Opens ONE write connection and probes it with a 5s SELECT 1, returning
// the SAME connection for the caller to write on (or null if Neon is
// unconfigured / unreachable). Replaces the old isNeonReachable_(), which
// opened a throwaway probe connection and THEN a second write connection
// -- two TLS+auth handshakes per writer (six per import run) against a
// free-tier instance that may be cold. Reusing the probed connection
// halves the handshake cost. Callers own closing the returned connection.
function getReachableNeonConn_() {
  var conn;
  try {
    conn = getNeonConn_write();
    if (!conn) return null;
    var stmt = conn.createStatement();
    stmt.setQueryTimeout(5);
    stmt.execute('SELECT 1');
    stmt.close();
    return conn;
  } catch (e) {
    Logger.log('Neon unreachable: ' + (e.message || e));
    if (conn) { try { conn.close(); } catch (ce) {} }
    return null;
  }
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

// -- Helpers (inlined so they travel with INV-16 duplication) -----------------
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

function normalizeDuration(val) {
  if (val === null || val === undefined || val === '') return null;
  var s = String(val).trim();
  if (!s) return null;
  if (s.indexOf(':') !== -1) return s;
  var num = parseFloat(s);
  if (isNaN(num)) return null;
  var totalSec = Math.round(num * 86400);
  var h = Math.floor(totalSec / 3600);
  var mn = Math.floor((totalSec % 3600) / 60);
  var sec = totalSec % 60;
  return h + ':' + String(mn).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

// IMP-6: Postgres rejects a multi-row INSERT ... ON CONFLICT DO UPDATE whose
// VALUES carry two rows with the same conflict key ("ON CONFLICT DO UPDATE
// command cannot affect row a second time"). Fresh daily builds emit unique
// keys, but SHEET-DERIVED callers -- the deferred Neon mirror
// (NeonMirror.js), re-mirrors of hand-pasted/duplicated history -- can pass
// duplicate rows, and ONE poison-pill date then throws on every retry
// (wedging the mirror queue with a failure email per 15-min run). Dedupe
// LAST-write-wins: the later row overwrites the earlier, matching both
// upsert intuition and the sheet's append order (a re-appended correction
// sits below the stale copy). Returns the input array untouched when no
// duplicates exist.
function neonDedupeByKey_(rows, label, keyFn) {
  var byKey = {};
  var order = [];
  for (var i = 0; i < rows.length; i++) {
    var k = keyFn(rows[i]);
    if (!(k in byKey)) order.push(k);
    byKey[k] = rows[i];
  }
  if (order.length === rows.length) return rows;
  Logger.log('%s: dropped %s duplicate-conflict-key row(s) (last-write-wins) '
    + 'so the multi-row upsert cannot throw "cannot affect row a second time".',
    label, rows.length - order.length);
  return order.map(function (k) { return byKey[k]; });
}

// IMP-5: authoritative per-date REPLACE support. The mirrors were
// upsert-only, so a force re-import whose rebuilt set is a SUBSET of the
// old one (agent renamed via alias, a corrected extra row removed) left
// PHANTOM rows in Neon forever -- with DQE_READ_SOURCE=neon the dashboard
// would show a split agent + double-counted totals for that date. Callers
// whose payload is provably the COMPLETE set for its date(s) -- the daily
// builds, the dup-guard re-mirror, the deferred per-date mirror -- pass
// { authoritative: true } and the writer DELETEs those dates inside the
// SAME transaction before inserting (rollback undoes both). Partial-set
// callers (bulk archive after dedupeAlreadyArchived_, the row-batched
// backfills) must NOT pass it.
function neonDistinctIsoDates_(rows, dateFn) {
  var seen = {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var iso = dateFn(rows[i]);
    if (iso && !seen[iso]) { seen[iso] = true; out.push(iso); }
  }
  return out;
}

function neonAuthoritativeDateDelete_(conn, table, isoDates) {
  if (!isoDates || !isoDates.length) return;
  var stmt = conn.prepareStatement('DELETE FROM ' + table + ' WHERE call_date IN ('
    + isoDates.map(function () { return '?::date'; }).join(',') + ')');
  for (var i = 0; i < isoDates.length; i++) stmt.setString(i + 1, isoDates[i]);
  stmt.execute();
  stmt.close();
  Logger.log('%s: authoritative replace for %s date(s): %s', table, isoDates.length, isoDates.join(', '));
}

// -- DQE writer --------------------------------------------------------------
function writeDQERowsToNeon(rows, opts) {
  if (!rows || !rows.length) return { inserted: 0, skipped: 0 };
  // IMP-6: uq_dqe_history is (call_date, agent_name). Key on the SAME
  // normalized date the bind below sends so duplicates collide as the DB
  // would see them.
  rows = neonDedupeByKey_(rows, 'writeDQERowsToNeon', function (r) {
    return parseDateForNeon(r.callDate) + '\u0001' + r.agentName;
  });
  var conn = getReachableNeonConn_();
  if (!conn) {
    Logger.log('writeDQERowsToNeon: Neon unreachable — skipping %s rows.', rows.length);
    return { inserted: 0, skipped: rows.length };
  }
  conn.setAutoCommit(false);

  try {
    // IMP-5: authoritative per-date replace (see neonAuthoritativeDateDelete_).
    if (opts && opts.authoritative) {
      neonAuthoritativeDateDelete_(conn, 'dqe_history',
        neonDistinctIsoDates_(rows, function (r) { return parseDateForNeon(r.callDate); }));
    }
    // F-21: chunk the multi-row INSERT. One statement for the whole batch
    // was fine on the daily path (~250 rows) but the bulk-archive path can
    // pass many dates at once -- past ~35 dates the SQL string blows the
    // Apps Script JDBC statement cap ("Argument too large: sql", the same
    // failure inbound hit), and ~1.9k rows breach Postgres's 65,535
    // bind-param cap (34 params/row). 400 rows/chunk stays comfortably
    // under both. Still ONE commit after all chunks (Neon write
    // discipline: batch inserts, commit once).
    var DQE_CHUNK_ROWS = 400;
    var placeholderRow  = '(' + new Array(34).fill('?').join(',') + ')';
    for (var off = 0; off < rows.length; off += DQE_CHUNK_ROWS) {
    var chunk = rows.slice(off, off + DQE_CHUNK_ROWS);
    var allPlaceholders = chunk.map(function() { return placeholderRow; }).join(',');

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
      ' ON CONFLICT ON CONSTRAINT uq_dqe_history DO UPDATE SET ' +
      'month_year = EXCLUDED.month_year, ' +
      'queue_extensions = EXCLUDED.queue_extensions, ' +
      'total_unique = EXCLUDED.total_unique, ' +
      'total_rung = EXCLUDED.total_rung, ' +
      'total_missed = EXCLUDED.total_missed, ' +
      'total_answered = EXCLUDED.total_answered, ' +
      'ttt = EXCLUDED.ttt, att = EXCLUDED.att, ' +
      'slot_0800_0830 = EXCLUDED.slot_0800_0830, slot_0830_0900 = EXCLUDED.slot_0830_0900, ' +
      'slot_0900_0930 = EXCLUDED.slot_0900_0930, slot_0930_1000 = EXCLUDED.slot_0930_1000, ' +
      'slot_1000_1030 = EXCLUDED.slot_1000_1030, slot_1030_1100 = EXCLUDED.slot_1030_1100, ' +
      'slot_1100_1130 = EXCLUDED.slot_1100_1130, slot_1130_1200 = EXCLUDED.slot_1130_1200, ' +
      'slot_1200_1230 = EXCLUDED.slot_1200_1230, slot_1230_1300 = EXCLUDED.slot_1230_1300, ' +
      'slot_1300_1330 = EXCLUDED.slot_1300_1330, slot_1330_1400 = EXCLUDED.slot_1330_1400, ' +
      'slot_1400_1430 = EXCLUDED.slot_1400_1430, slot_1430_1500 = EXCLUDED.slot_1430_1500, ' +
      'slot_1500_1530 = EXCLUDED.slot_1500_1530, slot_1530_1600 = EXCLUDED.slot_1530_1600, ' +
      'slot_1600_1630 = EXCLUDED.slot_1600_1630, slot_1630_1700 = EXCLUDED.slot_1630_1700, ' +
      'slot_1700_1730 = EXCLUDED.slot_1700_1730, ' +
      'abandoned_parent_ids = EXCLUDED.abandoned_parent_ids, ' +
      'abandoned_missed_ids = EXCLUDED.abandoned_missed_ids, ' +
      'abandoned_missed_times = EXCLUDED.abandoned_missed_times, ' +
      'avg_abd_wait = EXCLUDED.avg_abd_wait, ' +
      'csr_avg_abd_wait = EXCLUDED.csr_avg_abd_wait';

    var stmt = conn.prepareStatement(sql);
    var p = 1;
    for (var b = 0; b < chunk.length; b++) {
      var row = chunk[b];
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
      stmt.setString(p++, normalizeDuration(row.avgAbdWait));
      stmt.setString(p++, normalizeDuration(row.csrAvgAbdWait));
    }

    stmt.execute();
    stmt.close();
    }
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
function writeQCDRowsToNeon(rows, opts) {
  if (!rows || !rows.length) return { inserted: 0 };
  // IMP-6: uq_qcd_history is (call_date, call_queue, call_source).
  rows = neonDedupeByKey_(rows, 'writeQCDRowsToNeon', function (r) {
    return parseDateForNeon(r.callDate) + '\u0001' + r.callQueue + '\u0001' + r.callSource;
  });
  var conn = getReachableNeonConn_();
  if (!conn) {
    Logger.log('writeQCDRowsToNeon: Neon unreachable — skipping %s rows.', rows.length);
    return { inserted: 0, skipped: rows.length };
  }
  conn.setAutoCommit(false);

  try {
    // IMP-5: authoritative per-date replace (see neonAuthoritativeDateDelete_).
    if (opts && opts.authoritative) {
      neonAuthoritativeDateDelete_(conn, 'qcd_history',
        neonDistinctIsoDates_(rows, function (r) { return parseDateForNeon(r.callDate); }));
    }
    // F-21: chunked like the DQE writer (12 params/row; the bulk-archive
    // path mirrors the whole accumulated Pending Archive in one call).
    // ONE commit after all chunks.
    var QCD_CHUNK_ROWS = 1000;
    var placeholderRow  = '(' + new Array(12).fill('?').join(',') + ')';
    for (var off = 0; off < rows.length; off += QCD_CHUNK_ROWS) {
    var chunk = rows.slice(off, off + QCD_CHUNK_ROWS);
    var allPlaceholders = chunk.map(function() { return placeholderRow; }).join(',');

    var sql = 'INSERT INTO qcd_history (' +
      'month_year, week, call_date, call_queue, call_source, ' +
      'total_calls, total_answered, abandoned, longest_wait, avg_answer, ' +
      'abandoned_pct, violations' +
      ') VALUES ' + allPlaceholders +
      ' ON CONFLICT ON CONSTRAINT uq_qcd_history DO UPDATE SET ' +
      'month_year = EXCLUDED.month_year, ' +
      'week = EXCLUDED.week, ' +
      'total_calls = EXCLUDED.total_calls, ' +
      'total_answered = EXCLUDED.total_answered, ' +
      'abandoned = EXCLUDED.abandoned, ' +
      'longest_wait = EXCLUDED.longest_wait, ' +
      'avg_answer = EXCLUDED.avg_answer, ' +
      'abandoned_pct = EXCLUDED.abandoned_pct, ' +
      'violations = EXCLUDED.violations';

    var stmt = conn.prepareStatement(sql);
    var p = 1;
    for (var b = 0; b < chunk.length; b++) {
      var row = chunk[b];
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
    }
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


// -- CDR writer (call_history_dept + call_history_phones) --------------------
// Mirrors CDR Historical Data rows to Neon. Handles the JSONB name-list
// fields and phone child-table inserts when HMAC_SECRET is available.
// Without HMAC_SECRET, writes the main metric columns but skips
// name-list JSONB and phone child rows (logs a warning).

function writeCDRRowsToNeon(rows, opts) {
  if (!rows || !rows.length) return { inserted: 0, skipped: 0, phones: 0 };
  // IMP-6: uq_call_hist is (call_date, department, agent_name). callDate is
  // bound raw below, so key on the raw value.
  rows = neonDedupeByKey_(rows, 'writeCDRRowsToNeon', function (r) {
    return r.callDate + '\u0001' + r.dept + '\u0001' + r.agentName;
  });
  // A2: reset the per-run phone-hash memo at the entry of the only
  // call tree that hashes phones, so it's bounded to this mirror call.
  CDR_HMAC_CACHE_ = {};

  var conn = getReachableNeonConn_();
  if (!conn) {
    Logger.log('writeCDRRowsToNeon: Neon unreachable — skipping %s rows.', rows.length);
    return { inserted: 0, skipped: rows.length, phones: 0 };
  }

  var hmacSecret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  var hasHmac = !!hmacSecret;
  if (!hasHmac) {
    Logger.log('writeCDRRowsToNeon: HMAC_SECRET not set — name-list JSONB and phone child rows will be skipped.');
  }

  conn.setAutoCommit(false);

  try {
    // F-21: chunked like the DQE/QCD writers (21 params/row; the F-18 bulk
    // CDR mirror can pass many dates at once). ONE commit after all chunks,
    // BEFORE the phone child rows (unchanged ordering -- the children look
    // up committed parent ids).
    // IMP-3: 300 rows/chunk, down from 500. A FULL 500-row chunk measured
    // ~44.2KB of SQL (85-char placeholder x 500 + column list + the ON
    // CONFLICT tail) -- at/over the empirically observed ~44KB Apps Script
    // JDBC cap ("Argument too large: sql"), so every exactly-full chunk on
    // a multi-date bulk mirror was a coin-flip. 300 rows ~= 27KB: safe
    // margin, and the daily path (~250 rows) still fits one statement.
    var CDR_CHUNK_ROWS = 300;
    var placeholderRow = '(?,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?,?,?,?)';
    for (var off = 0; off < rows.length; off += CDR_CHUNK_ROWS) {
    var chunk = rows.slice(off, off + CDR_CHUNK_ROWS);
    var allPlaceholders = chunk.map(function() { return placeholderRow; }).join(',');

    var sql = 'INSERT INTO call_history_dept (' +
      'call_date, department, agent_name, ' +
      'ob_total, ob_answered, ob_missed, ' +
      'ob_list_total_entries, ob_list_answered_entries, ob_list_missed_entries, ' +
      'ib_total, ib_answered, ib_missed, ' +
      'ib_answered_internal, ib_answered_external, ' +
      'ib_list_total_entries, ib_list_answered_entries, ib_list_missed_entries, ' +
      'ob_ext_total, ob_ext_answered, ob_ext_ttt_sec, ob_ext_att_sec' +
      ') VALUES ' + allPlaceholders +
      ' ON CONFLICT ON CONSTRAINT uq_call_hist DO UPDATE SET ' +
      'ob_total = EXCLUDED.ob_total, ob_answered = EXCLUDED.ob_answered, ob_missed = EXCLUDED.ob_missed, ' +
      'ob_list_total_entries = EXCLUDED.ob_list_total_entries, ' +
      'ob_list_answered_entries = EXCLUDED.ob_list_answered_entries, ' +
      'ob_list_missed_entries = EXCLUDED.ob_list_missed_entries, ' +
      'ib_total = EXCLUDED.ib_total, ib_answered = EXCLUDED.ib_answered, ib_missed = EXCLUDED.ib_missed, ' +
      'ib_answered_internal = EXCLUDED.ib_answered_internal, ib_answered_external = EXCLUDED.ib_answered_external, ' +
      'ib_list_total_entries = EXCLUDED.ib_list_total_entries, ' +
      'ib_list_answered_entries = EXCLUDED.ib_list_answered_entries, ' +
      'ib_list_missed_entries = EXCLUDED.ib_list_missed_entries, ' +
      'ob_ext_total = EXCLUDED.ob_ext_total, ob_ext_answered = EXCLUDED.ob_ext_answered, ' +
      'ob_ext_ttt_sec = EXCLUDED.ob_ext_ttt_sec, ob_ext_att_sec = EXCLUDED.ob_ext_att_sec';

    var stmt = conn.prepareStatement(sql);
    var p = 1;
    for (var i = 0; i < chunk.length; i++) {
      var row = chunk[i];
      stmt.setString(p++, row.callDate);
      stmt.setString(p++, row.dept);
      stmt.setString(p++, row.agentName);
      stmt.setInt(p++,    parseInt(row.obTotal)   || 0);
      stmt.setInt(p++,    parseInt(row.obAns)     || 0);
      stmt.setInt(p++,    parseInt(row.obMiss)    || 0);
      stmt.setString(p++, hasHmac ? cdrParseNameFieldJson_(row.obListTot,  false, hmacSecret) : null);
      stmt.setString(p++, hasHmac ? cdrParseNameFieldJson_(row.obListAns,  false, hmacSecret) : null);
      stmt.setString(p++, hasHmac ? cdrParseNameFieldJson_(row.obListMiss, false, hmacSecret) : null);
      stmt.setInt(p++,    parseInt(row.ibTotal)   || 0);
      stmt.setInt(p++,    parseInt(row.ibAns)     || 0);
      stmt.setInt(p++,    parseInt(row.ibMiss)    || 0);
      stmt.setInt(p++,    parseInt(row.ibAnsInt)  || 0);
      stmt.setInt(p++,    parseInt(row.ibAnsExt)  || 0);
      stmt.setString(p++, hasHmac ? cdrParseNameFieldJson_(row.ibListTot,  false, hmacSecret) : null);
      stmt.setString(p++, hasHmac ? cdrParseNameFieldJson_(row.ibListAns,  false, hmacSecret) : null);
      stmt.setString(p++, hasHmac ? cdrParseNameFieldJson_(row.ibListMiss, false, hmacSecret) : null);
      stmt.setInt(p++,    parseInt(row.obExtTotal) || 0);
      stmt.setInt(p++,    parseInt(row.obExtAns)   || 0);
      stmt.setInt(p++,    cdrTimeToSeconds_(row.obExtTTT));
      stmt.setInt(p++,    cdrTimeToSeconds_(row.obExtATT));
    }

    stmt.execute();
    stmt.close();
    }
    conn.commit();
    Logger.log('writeCDRRowsToNeon: wrote ' + rows.length + ' main rows.');

    // Phone child-table inserts (requires HMAC_SECRET + parent row IDs).
    // Skipped when opts.skipPhones -- the deferred off-path mirror (#1)
    // writes them via mirrorCdrPhonesToNeon on its own connection AFTER
    // this main write has committed. Otherwise written inline here on the
    // same connection (preserves the standalone / cdr-report behavior).
    var phoneCount = 0;
    if (!(opts && opts.skipPhones) && hasHmac) {
      var hasAnyPhones = rows.some(function(r) {
        return (r.phonesX && String(r.phonesX).trim()) ||
               (r.phonesY && String(r.phonesY).trim()) ||
               (r.phonesZ && String(r.phonesZ).trim());
      });
      if (hasAnyPhones) phoneCount = cdrInsertPhoneChildRows_(conn, rows, hmacSecret);
    }

    return { inserted: rows.length, skipped: 0, phones: phoneCount,
             phonesDeferred: !!(opts && opts.skipPhones) };

  } catch (e) {
    try { conn.rollback(); } catch (re) {}
    throw e;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

/**
 * Inserts call_history_phones child rows for `rows` on the given (already
 * open, autoCommit=false) connection, and commits once. Shared by the
 * inline path (writeCDRRowsToNeon) and the deferred off-path mirror
 * (mirrorCdrPhonesToNeon). The parent call_history_dept rows must already
 * be committed -- this looks up their IDs, then parses + HMAC-hashes the
 * phone fields and bulk-inserts.
 *
 * #2 (INLINE literal VALUES, not bound params): the phone child row carries
 * NO untrusted text -- parentId is a DB-generated int, list_type is one of
 * 3 code constants, phone_hash is a 64-char hex HMAC digest, duration /
 * occurrences are ints. All are coerced + validated below, so inlining is
 * injection-safe AND removes the ~5 JDBC bind-bridge calls PER ROW (the
 * dominant per-row Apps Script cost). The main call_history_dept + DQE
 * inserts stay parameterized -- they carry agent names + JSONB.
 *
 * (a) Emits a timing line splitting build(+HMAC) vs insert + the unique-
 * hash count, so the HMAC-vs-insert cost is measurable from the logs.
 */
function cdrInsertPhoneChildRows_(conn, rows, hmacSecret) {
  if (!rows || !rows.length) return 0;
  // F3: normalize null/undefined key parts so the JS-side lookup key
  // matches the DB-readback key (getString returns JS null for a SQL NULL).
  var cdrKeyPart_ = function (x) { return x == null ? '<null>' : String(x); };

  // REP-2: the parent-id lookup is CHUNKED like the inserts (F-21). One
  // (?::date, ?, ?) tuple per input row over the ENTIRE rows array crossed
  // the ~44KB JDBC statement cap around ~2,900 rows -- reachable on the
  // F-18 bulk-archive mirror (whole Pending Archive in one call), which
  // then lost the phone-child mirror for the whole run.
  var CDR_ID_LOOKUP_CHUNK_ROWS = 400;
  var idMap = {};
  for (var lk = 0; lk < rows.length; lk += CDR_ID_LOOKUP_CHUNK_ROWS) {
    var lkChunk = rows.slice(lk, lk + CDR_ID_LOOKUP_CHUNK_ROWS);
    var joinPlaceholders = lkChunk.map(function() { return '(?::date, ?, ?)'; }).join(',');
    var idSql = 'SELECT d.id, d.call_date::text, d.department, d.agent_name ' +
      'FROM call_history_dept d ' +
      'JOIN (VALUES ' + joinPlaceholders + ') AS v(cd, dept, agent) ' +
      'ON d.call_date = v.cd AND d.department IS NOT DISTINCT FROM v.dept ' +
      'AND d.agent_name IS NOT DISTINCT FROM v.agent';
    var idStmt = conn.prepareStatement(idSql);
    var q = 1;
    for (var j = 0; j < lkChunk.length; j++) {
      idStmt.setString(q++, lkChunk[j].callDate);
      idStmt.setString(q++, lkChunk[j].dept);
      idStmt.setString(q++, lkChunk[j].agentName);
    }
    var idRs = idStmt.executeQuery();
    while (idRs.next()) {
      idMap[cdrKeyPart_(idRs.getString(2)) + '|' + cdrKeyPart_(idRs.getString(3)) + '|' + cdrKeyPart_(idRs.getString(4))] = idRs.getInt(1);
    }
    idRs.close(); idStmt.close();
  }

  // IMP-4: per-parent DELETE-then-insert. The old upsert was
  // `ON CONFLICT ON CONSTRAINT uq_phone_entry DO NOTHING`, so a force
  // re-import's CORRECTED entries never propagated (stale duration_sec /
  // occurrences kept forever) and entries that DISAPPEARED from the
  // re-exported source lingered as phantoms. Each payload row carries the
  // COMPLETE entry set for its parent (built from that row's own
  // phonesX/Y/Z cells), so deleting the looked-up parents' children first
  // makes the write authoritative PER PARENT -- safe on EVERY caller,
  // including partial-DATE bulk batches (per-parent completeness is what
  // matters, unlike the IMP-5 date-level replace). Same transaction as
  // the inserts: a failed insert rolls the delete back. The ON CONFLICT
  // DO NOTHING below is kept as an intra-payload duplicate guard.
  // (Edge, documented: if NO payload row has phones at all, the caller's
  // hasAnyPhones gate skips this helper entirely, so an
  // every-list-emptied re-import day would keep stale children --
  // practically unreachable.)
  var parentIds = [];
  for (var pidKey in idMap) {
    var pv = parseInt(idMap[pidKey], 10);
    if (isFinite(pv)) parentIds.push(pv);
  }
  if (parentIds.length) {
    var DEL_CHUNK = 500;   // ints, ~10 chars each -- ~5KB per statement
    var delStmt = conn.createStatement();
    for (var doff = 0; doff < parentIds.length; doff += DEL_CHUNK) {
      delStmt.execute('DELETE FROM call_history_phones WHERE call_history_id IN ('
        + parentIds.slice(doff, doff + DEL_CHUNK).join(',') + ')');
    }
    delStmt.close();
  }

  // ---- build + hash (timed) ----
  var tBuild = Date.now();
  var TYPE_LITERAL_ = {
    ob_ext_list_total:    "'ob_ext_list_total'",
    ob_ext_list_answered: "'ob_ext_list_answered'",
    ob_ext_list_missed:   "'ob_ext_list_missed'"
  };
  var phoneValues = [];   // pre-rendered injection-safe inline "(...)" tuples
  for (var k = 0; k < rows.length; k++) {
    var key = cdrKeyPart_(rows[k].callDate) + '|' + cdrKeyPart_(rows[k].dept) + '|' + cdrKeyPart_(rows[k].agentName);
    var pid = parseInt(idMap[key], 10);
    if (!isFinite(pid)) continue;   // no parent row -> skip (idempotent)
    var phoneSets = [
      { raw: rows[k].phonesX, type: 'ob_ext_list_total' },
      { raw: rows[k].phonesY, type: 'ob_ext_list_answered' },
      { raw: rows[k].phonesZ, type: 'ob_ext_list_missed' }
    ];
    for (var ps = 0; ps < phoneSets.length; ps++) {
      var typeLit = TYPE_LITERAL_[phoneSets[ps].type];
      if (!typeLit) continue;       // only the 3 known list types
      var parsed = cdrParsePhoneField_(phoneSets[ps].raw, hmacSecret);
      for (var ph = 0; ph < parsed.length; ph++) {
        // phone_hash is a 64-char hex digest (or null) -> inline-safe.
        var h = parsed[ph].phone_hash;
        var hashLit = (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) ? "'" + h + "'" : 'NULL';
        var dur = parseInt(parsed[ph].duration_sec, 10); if (!isFinite(dur)) dur = 0;
        var occ = parseInt(parsed[ph].occurrences, 10);  if (!isFinite(occ)) occ = 0;
        phoneValues.push('(' + pid + ',' + typeLit + ',' + hashLit + ',' + dur + ',' + occ + ')');
      }
    }
  }
  var buildMs = Date.now() - tBuild;
  var uniqueHashes = Object.keys(CDR_HMAC_CACHE_).length;

  if (!phoneValues.length) {
    // IMP-4: commit the per-parent delete above -- when a re-import removed
    // every entry for these parents, the delete alone IS the correction
    // (returning uncommitted would roll it back on close).
    if (parentIds.length) conn.commit();
    Logger.log('cdrInsertPhoneChildRows_: 0 phone rows | build+hash ' + buildMs + 'ms (' + uniqueHashes + ' unique hashes).');
    return 0;
  }

  // ---- insert (timed) ----
  // Inline VALUES means the only limit is the SQL-string size (Apps Script
  // throws "Argument too large: sql" near ~44KB). Each tuple is ~100 chars,
  // so 200 rows is ~20KB -- safely under, and far fewer round-trips than the
  // old 500-row bound-param chunks. ONE commit after all chunks
  // (all-or-nothing with the IMP-4 per-parent delete above; ON CONFLICT
  // DO NOTHING guards intra-payload duplicates only).
  var tInsert = Date.now();
  var INSERT_CHUNK = 200;
  var stmt = conn.createStatement();
  var chunks = 0, off = 0;
  while (off < phoneValues.length) {
    var sql = 'INSERT INTO call_history_phones ' +
      '(call_history_id, list_type, phone_hash, duration_sec, occurrences) VALUES ' +
      phoneValues.slice(off, off + INSERT_CHUNK).join(',') +
      ' ON CONFLICT ON CONSTRAINT uq_phone_entry DO NOTHING';
    stmt.execute(sql);
    off += INSERT_CHUNK;
    chunks++;
  }
  stmt.close();
  conn.commit();
  var insertMs = Date.now() - tInsert;

  Logger.log('cdrInsertPhoneChildRows_: wrote ' + phoneValues.length + ' phone child rows | '
    + 'build+hash ' + buildMs + 'ms (' + uniqueHashes + ' unique hashes) | '
    + 'insert ' + insertMs + 'ms (' + chunks + ' chunks).');
  return phoneValues.length;
}

/**
 * Deferred off-path CDR phone-child mirror (#1). Invoked from a one-shot
 * trigger AFTER the synchronous import has written the parent
 * call_history_dept rows (so the parent-ID lookup resolves). `rows` need
 * carry only { callDate, dept, agentName, phonesX, phonesY, phonesZ } --
 * the same keys the synchronous main write used. Opens its OWN connection
 * (the import's is long closed). Idempotent (ON CONFLICT DO NOTHING), so
 * re-running / overlap is harmless. Returns { phones, skipped }.
 */
function mirrorCdrPhonesToNeon(rows) {
  if (!rows || !rows.length) return { phones: 0, skipped: 0 };
  CDR_HMAC_CACHE_ = {};   // reset the per-run phone-hash memo
  var hmacSecret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!hmacSecret) {
    Logger.log('mirrorCdrPhonesToNeon: HMAC_SECRET not set — skipping phone mirror.');
    return { phones: 0, skipped: rows.length };
  }
  var conn = getReachableNeonConn_();
  if (!conn) {
    Logger.log('mirrorCdrPhonesToNeon: Neon unreachable — skipping ' + rows.length + ' rows.');
    return { phones: 0, skipped: rows.length };
  }
  conn.setAutoCommit(false);
  try {
    var n = cdrInsertPhoneChildRows_(conn, rows, hmacSecret);
    return { phones: n, skipped: 0 };
  } catch (e) {
    try { conn.rollback(); } catch (re) {}
    throw e;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// -- CDR field-parsing helpers (inlined for INV-16 portability) ---------------

function cdrTimeToSeconds_(val) {
  if (!val) return 0;
  var s = String(val).trim();
  var parts = s.split(':');
  if (parts.length !== 3) return 0;
  return (parseInt(parts[0]) || 0) * 3600 + (parseInt(parts[1]) || 0) * 60 + (parseInt(parts[2]) || 0);
}

function cdrHashPhone_(raw, secret) {
  if (!raw || !secret) return null;
  var cleaned = String(raw).trim();
  if (!cleaned) return null;
  // A2: memoize within a run. secret is constant per run, so keying on
  // the cleaned number is safe; the cache is reset at the top of
  // writeCDRRowsToNeon. Hash is deterministic, so a stale-cache read can
  // only ever return the correct value.
  var cached = CDR_HMAC_CACHE_[cleaned];
  if (cached !== undefined) return cached;
  var bytes = Utilities.computeHmacSha256Signature(cleaned, secret);
  var hex = bytes.map(function(b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  CDR_HMAC_CACHE_[cleaned] = hex;
  return hex;
}

function cdrLooksLikePhone_(str) {
  return /^\+?[\d\s\-().]{7,}$/.test(String(str).trim());
}

function cdrParseNameFieldJson_(val, isUnused, secret) {
  if (!val) return null;
  var raw = String(val).trim();
  if (!raw) return null;

  var pipeIndex = raw.indexOf('|');
  var internalRaw = pipeIndex >= 0 ? raw.substring(0, pipeIndex).trim() : raw;
  var externalRaw = pipeIndex >= 0 ? raw.substring(pipeIndex + 1).trim() : '';

  function parseEntries(str, isExt) {
    if (!str) return [];
    // Split on an entry-separator comma: one followed by the start of a
    // new "Name (count)" entry. The lookahead character class must cover
    // every plausible first character of a name so entries that begin
    // with a lowercase letter ("de la Cruz"), an accented capital
    // ("Ángel"), or a digit ("311 Service") aren't silently glued onto
    // the previous entry's name/count. (Was [A-Z+'], which dropped those
    // -- a quiet data-fidelity bug in the Neon JSONB name-list fields.)
    var entries = str.split(/,\s*(?=[A-Za-zÀ-ÿ0-9+'])/);
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i].trim();
      if (!entry) continue;
      var countMatch = entry.match(/\((\d+)\)\s*$/);
      var count = countMatch ? parseInt(countMatch[1]) : 1;
      var nameRaw = countMatch ? entry.replace(countMatch[0], '').trim() : entry;
      if (cdrLooksLikePhone_(nameRaw)) {
        // P-2 hardening: a phone-shaped entry is a raw number regardless of
        // which side of the "|" it sits on -- a pre-fix external-only cell
        // (see autoImport.js::join) parses as internal, and no employee name
        // is phone-shaped, so hashing here can never mask a legitimate
        // internal display name. Hash-only shape on BOTH sides.
        out.push({ display: null, phone_hash: cdrHashPhone_(nameRaw, secret), count: count });
      } else if (isExt) {
        // IMP-12 (owner ruling): an external non-phone CNAM string is often
        // a PERSONAL name (patients, at a med-supply company) -- store
        // INITIALS ONLY in Neon, never the raw name. The same pipeline
        // HMACs every phone number for PHI; the sheet-side raw name is
        // accepted policy, but the Neon mirror must not carry it. Rows
        // written before this change keep their raw values until the date
        // is re-imported.
        out.push({ display: cdrMaskExternalName_(nameRaw), phone_hash: null, count: count });
      } else {
        out.push({ display: nameRaw, phone_hash: null, count: count });
      }
    }
    return out;
  }

  var result = { internal: parseEntries(internalRaw, false), external: parseEntries(externalRaw, true) };
  return JSON.stringify(result);
}

// IMP-12: reduce an external CNAM display name to initials ("SMITH JOHN"
// -> "S.J.") so no raw personal name lands in Neon JSONB. Null when the
// string has no word characters to take initials from.
function cdrMaskExternalName_(name) {
  var parts = String(name == null ? '' : name).trim().split(/\s+/).filter(function (p) { return p; });
  var initials = [];
  for (var i = 0; i < parts.length; i++) {
    var ch = parts[i].charAt(0);
    if (/[A-Za-zÀ-ÿ0-9]/.test(ch)) initials.push(ch.toUpperCase());
  }
  return initials.length ? initials.join('.') + '.' : null;
}

function cdrParsePhoneField_(val, secret) {
  if (!val) return [];
  var raw = String(val).trim().replace(/^'/, '');
  if (!raw) return [];
  var results = [];
  // The leading "+" is OPTIONAL: the CDR feed usually emits "+<digits>"
  // but occasionally a bare "<digits>" -- requiring "+" silently dropped
  // those entries from the phone child mirror (data loss). cdrLooksLikePhone_
  // already treats "+" as optional, so match it here too. Normalize the
  // captured number to the canonical "+<digits>" form BEFORE hashing so a
  // bare number hashes identically to its "+"-prefixed twin (otherwise the
  // same physical number would split into two hashes in call_history_phones).
  var entryRegex = /(\+?[\d]+)\s+([\d:]+)(?:\s+\((\d+)\))?/g;
  var match;
  while ((match = entryRegex.exec(raw)) !== null) {
    var phone = match[1].charAt(0) === '+' ? match[1] : '+' + match[1];
    results.push({
      phone_hash:   cdrHashPhone_(phone, secret),
      duration_sec: cdrTimeToSeconds_(match[2]),
      occurrences:  match[3] ? parseInt(match[3]) : 1
    });
  }
  return results;
}