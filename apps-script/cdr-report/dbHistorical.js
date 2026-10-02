// ── Credentials ─────────────────────────────────────────────────────────────
// Shared Neon connection + HMAC-secret accessors (and the hashPhone helper) for
// the cdr-report project. Used by inboundCallsExport.js, insuranceNumbers.js,
// and dbReporting.js.
// (The old manual `archiveCallHistoryDept` backfill that also lived here -- plus
// its private parsers parseDate/timeToSeconds/toInt/looksLikePhone/
// parseNameField/parsePhoneField and the testParsers/testSingleRow scaffolding --
// was removed: CDR rows are now mirrored to Neon inline by neonWrite.js's
// writeCDRRowsToNeon during processIntegratedHistory, which self-contains its
// own field-parsing helpers per INV-16.)
function getNeonConn() {
  const p   = PropertiesService.getScriptProperties();
  // NO connect/socket/login timeout params here: Apps Script's JDBC service
  // REJECTS them outright -- "The following connection properties are
  // unsupported: connectTimeout,socketTimeout,loginTimeout" -- so adding them
  // made EVERY Neon connection fail instantly across all three projects
  // (shipped 2026-08-24, caught in production the next day). The hanging-connect
  // problem they were meant to bound is real but NOT solvable this way; bound
  // STATEMENTS with stmt.setQueryTimeout(seconds) instead, which the platform
  // does support. cross-file-pins.test.js fails if the params come back.
  const url = `jdbc:postgresql://${p.getProperty('NEON_HOST')}/${p.getProperty('NEON_DB')}`;
  return cdrTimedConn_(Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS')),
    CDR_REPORT_QUERY_TIMEOUT_S_);
}

// CR-6 (broad-scan 2026-10-01): every STATEMENT a getNeonConn() connection
// prepares carries a query timeout. A statement that hangs -- a cold or
// overloaded Neon, a lock -- used to run until the execution ceiling killed the
// run, and that kill SKIPS catch blocks, so the 9 AM Inbound / Outbound exports
// and the insurer sync logged nothing at all. Bounded here, a hang becomes an
// ordinary thrown error their catch blocks already report. 240 s leaves the
// run time to report it inside the 6-minute ceiling. The wrapper forwards only
// the six Connection methods this project's getNeonConn() callers use;
// cdr-report-neon-timeout.test.js sweeps them and fails on a seventh.
// (The dashboard twin is NeonRead.gs::neonTimedConn_, DL-3 -- another project.)
var CDR_REPORT_QUERY_TIMEOUT_S_ = 240;
function cdrTimedConn_(conn, seconds) {
  if (!conn || conn.__cdrTimed) return conn;
  var bound = function (stmt) {
    try { if (stmt && typeof stmt.setQueryTimeout === 'function') stmt.setQueryTimeout(seconds); } catch (e) {}
    return stmt;
  };
  return {
    __cdrTimed: true,
    prepareStatement: function (sql) { return bound(conn.prepareStatement(sql)); },
    createStatement: function () { return bound(conn.createStatement()); },
    setAutoCommit: function (v) { return conn.setAutoCommit(v); },
    commit: function () { return conn.commit(); },
    rollback: function () { return conn.rollback(); },
    close: function () { return conn.close(); }
  };
}

function getHmacSecret() {
  return PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
}


// ── Helper: PHI hashing ──────────────────────────────────────────────────────
// HMAC-SHA256 of a phone number string → 64-char hex string. Kept because
// insuranceNumbers.js::syncInsuranceNumbersToNeon reuses it (and it's
// byte-identical to the import's cdrHashPhone_ in neonWrite.js, so the hashes
// match across the sync and the daily mirror).
function hashPhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim();
  if (!cleaned) return null;
  const secret = getHmacSecret();
  const bytes  = Utilities.computeHmacSha256Signature(cleaned, secret);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}


// ── Diagnostic: editor-run Neon connectivity smoke test ──────────────────────
function testConnection() {
  try {
    const conn = getNeonConn();
    const stmt = conn.createStatement();
    const rs   = stmt.executeQuery('SELECT current_database(), now()');
    if (rs.next()) {
      Logger.log(`Connected to: ${rs.getString(1)} at ${rs.getString(2)}`);
    }
    conn.close();
  } catch (e) {
    Logger.log(`Connection failed: ${e.message}`);
  }
}
