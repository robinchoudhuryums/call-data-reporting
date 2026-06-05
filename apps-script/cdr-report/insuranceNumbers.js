// ============================================================================
// insuranceNumbers.js — label phone-number aggregations by insurer
// ----------------------------------------------------------------------------
// WHY: call_history_phones stores only the HMAC HASH of each phone number
// (PHI protection — raw numbers never reach Neon). But HMAC is deterministic,
// so the SAME number always produces the SAME hash, and you can already
// aggregate calls by number via GROUP BY phone_hash. What's missing is a
// LABEL for the numbers you care about.
//
// Insurance company numbers are NOT PHI (published business lines), so we can
// keep them in cleartext in the sheet, hash each one with the SAME secret the
// import uses, and store a small {phone_hash -> insurance_name} reference
// table in Neon. Joining that against call_history_phones gives labeled call
// counts — with zero raw customer PHI stored anywhere.
//
// SOURCE: the insurance block in the "DO NOT EDIT!" sheet — one COLUMN per
// insurer (header row = insurer name, rows below = that insurer's known
// numbers in +1XXXXXXXXXX form). Adjust the column range below if it moves.
//
// SCOPE / ACCURACY CAVEAT: call_history_phones holds the OUTBOUND-external
// lists (ob_ext_list_total / _answered / _missed = phonesX/Y/Z). So labeling
// works for OUTBOUND calls to these numbers (e.g. "how often we called
// Aetna"). Inbound external numbers are stored as caller-ID display text in
// the call_history_dept JSONB fields, not as hashes in the child table, so
// they are NOT labeled here. Surfacing inbound-by-number would be a separate
// pipeline change (hash inbound external numbers into a child table too).
//
// Reuses (same cdr-report project): getNeonConn() + getHmacSecret() +
// hashPhone() from dbHistorical.js. hashPhone() is byte-identical to the
// import's cdrHashPhone_ (neonWrite.js), so the hashes match.
// ============================================================================

// Insurance reference block in "DO NOT EDIT!" (1-indexed columns).
// Currently cols X (24) .. AG (33): header row = insurer name, rows below =
// that insurer's phone numbers. Set END < START to disable the reader.
var INSURANCE_BLOCK_START_COL = 24;   // column X
var INSURANCE_BLOCK_END_COL   = 33;   // column AG
var INSURANCE_HEADER_ROW      = 1;
var INSURANCE_DATA_START_ROW  = 2;

/**
 * Reads the insurance block and returns [{ insurance, number }] where
 * `number` is normalized to "+<digits>" (the same contiguous E.164-ish form
 * the CDR phone parser hashes, so the hashes line up). Numbers are
 * normalized by stripping everything but digits and re-adding a single
 * leading "+", so "+1 (800) 633-4227", "18006334227", and "+18006334227"
 * all canonicalize to "+18006334227". Numbers must include the country code
 * (the 1) to match the call-side hashes. Reads DISPLAY values so a cell
 * Sheets parsed as a number (dropping the +) is still recovered.
 */
function readInsuranceNumberRows_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DO NOT EDIT!');
  if (!sheet) { Logger.log('readInsuranceNumberRows_: "DO NOT EDIT!" not found.'); return []; }
  var startCol = INSURANCE_BLOCK_START_COL, endCol = INSURANCE_BLOCK_END_COL;
  if (endCol < startCol) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < INSURANCE_DATA_START_ROW) return [];
  var numCols = endCol - startCol + 1;

  var headers = sheet.getRange(INSURANCE_HEADER_ROW, startCol, 1, numCols).getDisplayValues()[0];
  var data = sheet.getRange(INSURANCE_DATA_START_ROW, startCol,
                            lastRow - INSURANCE_DATA_START_ROW + 1, numCols).getDisplayValues();

  var out = [];
  for (var c = 0; c < numCols; c++) {
    var name = String(headers[c] || '').trim();
    if (!name) continue;                       // empty column = no insurer
    for (var r = 0; r < data.length; r++) {
      var raw = String(data[r][c] || '').trim();
      if (!raw) continue;
      var digits = raw.replace(/\D/g, '');      // strip +, spaces, dashes, parens
      if (digits.length < 10) continue;         // too short to be a real number
      out.push({ insurance: name, number: '+' + digits });
    }
  }
  return out;
}

/**
 * EDITOR-RUN. Hashes every insurance number from the sheet and (re)builds the
 * Neon `insurance_numbers` reference table {phone_hash -> insurance_name}.
 * Full replace each run (the table is tiny + curated), so removals in the
 * sheet propagate. Stores ONLY the hash + label — never the raw number.
 *
 * Run from the Apps Script editor after editing the insurance block; the
 * dashboard's labeled aggregation picks it up immediately.
 */
function syncInsuranceNumbersToNeon() {
  var secret = getHmacSecret();
  if (!secret) { Logger.log('syncInsuranceNumbersToNeon: HMAC_SECRET not set — aborting.'); return; }

  var rows = readInsuranceNumberRows_();
  if (!rows.length) {
    Logger.log('syncInsuranceNumbersToNeon: no insurance numbers found in DO NOT EDIT! cols %s..%s.',
               INSURANCE_BLOCK_START_COL, INSURANCE_BLOCK_END_COL);
    return;
  }

  // Hash + dedupe by hash. If the same number is listed under two insurers,
  // last one wins (and we log the collision so it can be cleaned up).
  var byHash = {};
  var collisions = 0;
  rows.forEach(function (r) {
    var h = hashPhone(r.number);                // dbHistorical.js — matches the import's hash
    if (!h) return;
    if (byHash[h] && byHash[h] !== r.insurance) collisions++;
    byHash[h] = r.insurance;
  });
  var hashes = Object.keys(byHash);

  var conn = getNeonConn();
  conn.setAutoCommit(false);
  try {
    var ddl = conn.createStatement();
    ddl.execute(
      'CREATE TABLE IF NOT EXISTS insurance_numbers (' +
      'phone_hash text PRIMARY KEY, ' +
      'insurance_name text NOT NULL, ' +
      'updated_at timestamptz NOT NULL DEFAULT now())');
    ddl.execute('DELETE FROM insurance_numbers');   // full curated replace
    ddl.close();

    // insurance_name is admin-entered free text -> parameterized (the hash
    // is hex, but the name must be bound, not inlined).
    var ins = conn.prepareStatement(
      'INSERT INTO insurance_numbers (phone_hash, insurance_name) VALUES (?, ?)');
    for (var i = 0; i < hashes.length; i++) {
      ins.setString(1, hashes[i]);
      ins.setString(2, byHash[hashes[i]]);
      ins.execute();
    }
    ins.close();
    conn.commit();
    Logger.log('syncInsuranceNumbersToNeon: synced %s distinct insurance numbers (%s sheet entries, %s hash collisions).',
               hashes.length, rows.length, collisions);
  } catch (e) {
    try { conn.rollback(); } catch (re) {}
    Logger.log('syncInsuranceNumbersToNeon failed: %s', e && e.message ? e.message : e);
    throw e;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

/**
 * EDITOR-RUN convenience: logs labeled OUTBOUND-external call counts so you
 * can verify the join works. The canonical aggregation query (use this in
 * any Neon client / future dashboard report):
 *
 *   SELECT COALESCE(i.insurance_name, '(unlabeled)') AS source,
 *          SUM(p.occurrences)                        AS calls,
 *          COUNT(DISTINCT p.phone_hash)              AS distinct_numbers
 *   FROM   call_history_phones p
 *   LEFT JOIN insurance_numbers i ON i.phone_hash = p.phone_hash
 *   WHERE  p.list_type = 'ob_ext_list_total'   -- avoid triple-counting the
 *                                              -- total/answered/missed lists
 *   GROUP BY 1
 *   ORDER BY calls DESC;
 *
 * Filter to insurance_name IS NOT NULL for just the labeled insurers; drop
 * the list_type filter + GROUP BY phone_hash for raw per-number counts.
 */
function logInsuranceCallCounts_() {
  var conn = getNeonConn();
  try {
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery(
      "SELECT COALESCE(i.insurance_name, '(unlabeled)') AS source, " +
      "SUM(p.occurrences) AS calls, COUNT(DISTINCT p.phone_hash) AS nums " +
      "FROM call_history_phones p " +
      "LEFT JOIN insurance_numbers i ON i.phone_hash = p.phone_hash " +
      "WHERE p.list_type = 'ob_ext_list_total' " +
      "GROUP BY 1 ORDER BY calls DESC");
    Logger.log('=== Outbound-external call counts by source ===');
    var n = 0;
    while (rs.next() && n < 100) {
      Logger.log('  %s: %s calls (%s distinct numbers)',
                 rs.getString('source'), rs.getString('calls'), rs.getString('nums'));
      n++;
    }
    rs.close(); stmt.close();
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}
