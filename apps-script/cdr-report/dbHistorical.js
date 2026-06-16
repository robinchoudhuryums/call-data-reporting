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
  const url = `jdbc:postgresql://${p.getProperty('NEON_HOST')}/${p.getProperty('NEON_DB')}`;
  return Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS'));
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
