// ── Credentials ─────────────────────────────────────────────────────────────
function getNeonConn() {
  const p   = PropertiesService.getScriptProperties();
  const url = `jdbc:postgresql://${p.getProperty('NEON_HOST')}/${p.getProperty('NEON_DB')}`;
  return Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS'));
}

function getHmacSecret() {
  return PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
}


// ── Helpers: data type conversion ────────────────────────────────────────────

// Parses MM/D/YYYY or a Date object → "YYYY-MM-DD" string for Postgres
function parseDate(val) {
  if (!val) return null;
  const d = (val instanceof Date) ? val : new Date(val);
  if (isNaN(d)) return null;
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// Converts "HH:MM:SS" string → integer seconds
// Returns 0 for blank/null values
function timeToSeconds(val) {
  if (!val) return 0;
  const s = String(val).trim();
  const parts = s.split(':');
  if (parts.length !== 3) return 0;
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  const sec = parseInt(parts[2]) || 0;
  return (h * 3600) + (m * 60) + sec;
}

// Safe integer parse — blanks and non-numeric cells return 0
function toInt(val) {
  if (val === '' || val === null || val === undefined) return 0;
  const n = parseInt(val);
  return isNaN(n) ? 0 : n;
}


// ── Helpers: PHI hashing ─────────────────────────────────────────────────────

// HMAC-SHA256 of a phone number string → 64-char hex string
function hashPhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim();
  if (!cleaned) return null;
  const secret = getHmacSecret();
  const bytes  = Utilities.computeHmacSha256Signature(cleaned, secret);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// Returns true if a string looks like a phone number (E.164 or similar)
function looksLikePhone(str) {
  return /^\+?[\d\s\-().]{7,}$/.test(str.trim());
}


// ── Helpers: complex name/phone field parser (cols I,J,K,Q,R,S) ─────────────
//
// Input example:
//   "William Echauz, Jake (Jingo) Inaanuran\n|\nSAN ANTONIO TX (3), WIRELESS CALLER"
//
// Returns JSONB-ready object:
// {
//   internal: [ { name: "William Echauz", count: 1 }, ... ],
//   external: [
//     { display: "SAN ANTONIO TX", count: 3, phone_hash: null },
//     { display: null, count: 2, phone_hash: "abc123..." }   ← phone detected
//   ]
// }
function parseNameField(val) {
  if (!val) return null;
  const raw = String(val).trim();
  if (!raw) return null;

  // Split on the pipe divider (handles \n|\n or just |)
  const pipeIndex = raw.indexOf('|');
  const internalRaw = pipeIndex >= 0 ? raw.substring(0, pipeIndex).trim() : raw;
  const externalRaw = pipeIndex >= 0 ? raw.substring(pipeIndex + 1).trim() : '';

  // Parse a comma-separated list of entries, each optionally ending in "(N)"
  function parseEntries(str, isExternal) {
    if (!str) return [];
    // Split by comma, but NOT commas inside parentheses
    // Strategy: split on ", " where next char is uppercase or + (start of new entry)
    const entries = str.split(/,\s*(?=[A-Z+'])/);
    return entries.map(entry => {
      entry = entry.trim();
      if (!entry) return null;

      // Extract trailing count like "(3)"
      const countMatch = entry.match(/\((\d+)\)\s*$/);
      const count = countMatch ? parseInt(countMatch[1]) : 1;
      const nameRaw = countMatch ? entry.replace(countMatch[0], '').trim() : entry;

      if (isExternal && looksLikePhone(nameRaw)) {
        return { display: null, phone_hash: hashPhone(nameRaw), count };
      }
      return { display: nameRaw, phone_hash: null, count };
    }).filter(Boolean);
  }

  return {
    internal: parseEntries(internalRaw, false),
    external: parseEntries(externalRaw, true)
  };
}


// ── Helpers: phone list field parser (cols X, Y, Z) ─────────────────────────
//
// Input example:
//   "'+18503757112 0:00:59 (3), +13054917876 0:07:43 (2), +18502182330 0:00:00"
//
// Returns array of objects (to be inserted into call_history_phones):
//   [ { phone_hash: "...", duration_sec: 59, occurrences: 3 }, ... ]
function parsePhoneField(val) {
  if (!val) return [];
  // Strip leading apostrophe Google Sheets prepends to force text format
  let raw = String(val).trim().replace(/^'/, '');
  if (!raw) return [];

  const results = [];
  // Each entry is: +phone HH:MM:SS (N)  or  +phone HH:MM:SS
  const entryRegex = /(\+[\d]+)\s+([\d:]+)(?:\s+\((\d+)\))?/g;
  let match;

  while ((match = entryRegex.exec(raw)) !== null) {
    const phone      = match[1];
    const duration   = timeToSeconds(match[2]);
    const count      = match[3] ? parseInt(match[3]) : 1;
    results.push({
      phone_hash:   hashPhone(phone),
      duration_sec: duration,
      occurrences:  count
    });
  }

  return results;
}


// ── Main archive function ────────────────────────────────────────────────────
function archiveCallHistoryDept() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('CDR Historical Data'); // ← your sheet name
  const data  = sheet.getDataRange().getValues();
  const rows  = data.slice(1).filter(r => r[2] !== '');

  const props      = PropertiesService.getScriptProperties();
  const startIndex = parseInt(props.getProperty('ARCHIVE_RESUME_INDEX') || '0');

  Logger.log(`Starting from row index ${startIndex} of ${rows.length} total rows.`);

  if (startIndex >= rows.length) {
    Logger.log('Nothing to archive — already complete. Clear ARCHIVE_RESUME_INDEX to re-run.');
    return;
  }

  const BATCH_SIZE    = 50;  // smaller batch = shorter connection time per cycle
  const TIME_LIMIT_MS = 240000; // 4 min — gives buffer for phone inserts within 6 min cap
  const startTime     = Date.now();

  let i            = startIndex;
  let rowsInserted = 0;
  let rowsSkipped  = 0;

  try {
    while (i < rows.length) {

      if (Date.now() - startTime > TIME_LIMIT_MS) {
        props.setProperty('ARCHIVE_RESUME_INDEX', String(i));
        Logger.log(`Time limit reached. Saved resume position: ${i}. Run again to continue.`);
        return;
      }

      // ── Parse one batch into memory first (no DB connection yet) ─────────
      const batch     = []; // parsed row objects ready to insert
      const batchEnd  = Math.min(i + BATCH_SIZE, rows.length);

      while (i < batchEnd) {
        const r        = rows[i];
        const callDate = parseDate(r[2]);
        if (!callDate) { i++; continue; }

        batch.push({
          callDate,
          dept:       r[3]  || null,
          agentName:  r[4]  || null,
          obTotal:    toInt(r[5]),
          obAns:      toInt(r[6]),
          obMiss:     toInt(r[7]),
          obListTot:  parseNameField(r[8]),
          obListAns:  parseNameField(r[9]),
          obListMiss: parseNameField(r[10]),
          ibTotal:    toInt(r[11]),
          ibAns:      toInt(r[12]),
          ibMiss:     toInt(r[13]),
          ibAnsInt:   toInt(r[14]),
          ibAnsExt:   toInt(r[15]),
          ibListTot:  parseNameField(r[16]),
          ibListAns:  parseNameField(r[17]),
          ibListMiss: parseNameField(r[18]),
          obExtTotal: toInt(r[19]),
          obExtAns:   toInt(r[20]),
          obExtTTT:   timeToSeconds(r[21]),
          obExtATT:   timeToSeconds(r[22]),
          phonesX:    parsePhoneField(r[23]),
          phonesY:    parsePhoneField(r[24]),
          phonesZ:    parsePhoneField(r[25])
        });
        i++;
      }

      if (batch.length === 0) continue;

      // ── Open a fresh connection for each batch ────────────────────────────
      // This avoids Neon's idle connection timeout killing long-running jobs
      const conn = getNeonConn();
      conn.setAutoCommit(false);

      try {
        // ── Step 1: True multi-row INSERT (one round trip for whole batch) ──
        // Build: INSERT INTO ... VALUES (?,?,...), (?,?,...), ...
        const valuePlaceholders = batch.map(() =>
          `(?,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?,?,?,?)`
        ).join(',');

        const mainSql = `
          INSERT INTO call_history_dept (
            call_date, department, agent_name,
            ob_total, ob_answered, ob_missed,
            ob_list_total_entries, ob_list_answered_entries, ob_list_missed_entries,
            ib_total, ib_answered, ib_missed,
            ib_answered_internal, ib_answered_external,
            ib_list_total_entries, ib_list_answered_entries, ib_list_missed_entries,
            ob_ext_total, ob_ext_answered, ob_ext_ttt_sec, ob_ext_att_sec
          ) VALUES ${valuePlaceholders}
          ON CONFLICT ON CONSTRAINT uq_call_hist DO NOTHING
        `;

        const mainStmt = conn.prepareStatement(mainSql);
        let p = 1;
        for (const b of batch) {
          mainStmt.setString(p++, b.callDate);
          mainStmt.setString(p++, b.dept);
          mainStmt.setString(p++, b.agentName);
          mainStmt.setInt   (p++, b.obTotal);
          mainStmt.setInt   (p++, b.obAns);
          mainStmt.setInt   (p++, b.obMiss);
          mainStmt.setString(p++, b.obListTot  ? JSON.stringify(b.obListTot)  : null);
          mainStmt.setString(p++, b.obListAns  ? JSON.stringify(b.obListAns)  : null);
          mainStmt.setString(p++, b.obListMiss ? JSON.stringify(b.obListMiss) : null);
          mainStmt.setInt   (p++, b.ibTotal);
          mainStmt.setInt   (p++, b.ibAns);
          mainStmt.setInt   (p++, b.ibMiss);
          mainStmt.setInt   (p++, b.ibAnsInt);
          mainStmt.setInt   (p++, b.ibAnsExt);
          mainStmt.setString(p++, b.ibListTot  ? JSON.stringify(b.ibListTot)  : null);
          mainStmt.setString(p++, b.ibListAns  ? JSON.stringify(b.ibListAns)  : null);
          mainStmt.setString(p++, b.ibListMiss ? JSON.stringify(b.ibListMiss) : null);
          mainStmt.setInt   (p++, b.obExtTotal);
          mainStmt.setInt   (p++, b.obExtAns);
          mainStmt.setInt   (p++, b.obExtTTT);
          mainStmt.setInt   (p++, b.obExtATT);
        }
        mainStmt.execute();
        mainStmt.close();

        conn.commit();
        Logger.log(`Main insert committed for batch ending at index ${i}.`);

        // ── Step 2: Look up IDs with a single VALUES JOIN (one round trip) ──
        const hasAnyPhones = batch.some(
          b => b.phonesX.length + b.phonesY.length + b.phonesZ.length > 0
        );

        if (hasAnyPhones) {
          const joinPlaceholders = batch.map(() => `(?::date, ?, ?)`).join(',');
          const idSql = `
            SELECT d.id, d.call_date::text, d.department, d.agent_name
            FROM call_history_dept d
            JOIN (VALUES ${joinPlaceholders}) AS v(cd, dept, agent)
              ON d.call_date = v.cd
             AND d.department IS NOT DISTINCT FROM v.dept
             AND d.agent_name IS NOT DISTINCT FROM v.agent
          `;

          const idStmt = conn.prepareStatement(idSql);
          let q = 1;
          for (const b of batch) {
            idStmt.setString(q++, b.callDate);
            idStmt.setString(q++, b.dept);
            idStmt.setString(q++, b.agentName);
          }

          const idRs  = idStmt.executeQuery();
          const idMap = {};
          while (idRs.next()) {
            const key    = `${idRs.getString(2)}|${idRs.getString(3)}|${idRs.getString(4)}`;
            idMap[key]   = idRs.getInt(1);
          }
          idRs.close();
          idStmt.close();

          // ── Step 3: Batch insert all phone rows (one round trip) ──────────
          const phoneRows = [];
          for (const b of batch) {
            const key      = `${b.callDate}|${b.dept}|${b.agentName}`;
            const parentId = idMap[key];
            if (!parentId) continue;

            const phoneSets = [
              { phones: b.phonesX, type: 'ob_ext_list_total'    },
              { phones: b.phonesY, type: 'ob_ext_list_answered' },
              { phones: b.phonesZ, type: 'ob_ext_list_missed'   }
            ];
            for (const { phones, type } of phoneSets) {
              for (const ph of phones) {
                phoneRows.push({ parentId, type, ...ph });
              }
            }
          }

if (phoneRows.length > 0) {
  const PHONE_CHUNK = 200; // max phone rows per insert statement
  let phoneOffset   = 0;

  while (phoneOffset < phoneRows.length) {
    const chunk = phoneRows.slice(phoneOffset, phoneOffset + PHONE_CHUNK);

    const phonePlaceholders = chunk.map(() => `(?,?,?,?,?)`).join(',');
    const phoneSql = `
      INSERT INTO call_history_phones
        (call_history_id, list_type, phone_hash, duration_sec, occurrences)
      VALUES ${phonePlaceholders}
      ON CONFLICT ON CONSTRAINT uq_phone_entry DO NOTHING
    `;

    const phoneStmt = conn.prepareStatement(phoneSql);
    let s = 1;
    for (const ph of chunk) {
      phoneStmt.setInt   (s++, ph.parentId);
      phoneStmt.setString(s++, ph.type);
      phoneStmt.setString(s++, ph.phone_hash);
      phoneStmt.setInt   (s++, ph.duration_sec);
      phoneStmt.setInt   (s++, ph.occurrences);
    }
    phoneStmt.execute();
    phoneStmt.close();
    conn.commit();

    phoneOffset += PHONE_CHUNK;
    Logger.log(`Phone chunk committed: ${phoneOffset} of ${phoneRows.length} phone rows.`);
  }
}
        }

        // Count inserted vs skipped by querying how many of this batch exist
        rowsInserted += batch.length;

      } catch (e) {
        conn.rollback();
        // Rewind to start of this batch
        i = i - batch.length;
        const safeIndex = Math.max(0, i);
        props.setProperty('ARCHIVE_RESUME_INDEX', String(safeIndex));
        Logger.log(`Batch failed, rolled back. Resume saved at ${safeIndex}. Error: ${e.message}`);
        throw e;

      } finally {
        conn.close(); // always close — fresh connection next batch
      }

      Logger.log(`Progress: ${i} / ${rows.length} rows. Inserted so far: ${rowsInserted}.`);
    }

    props.deleteProperty('ARCHIVE_RESUME_INDEX');
    Logger.log(`Archive complete. Total rows processed: ${rowsInserted}.`);

  } catch (e) {
    Logger.log(`Archive stopped. Error: ${e.message}`);
    throw e;
  }
}

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

function testParsers() {
  // Paste a real value from col I, J, K, Q, R, or S
  const nameTest = 'William Echauz, Jake (Jingo) Inaanuran\n|\nSAN ANTONIO  TX (3), WIRELESS CALLER';
  Logger.log(JSON.stringify(parseNameField(nameTest)));

  // Paste a real value from col X, Y, or Z
  const phoneTest = "'+18503757112 0:00:59 (3), +13054917876 0:07:43 (2), +18502182330 0:00:00";
  Logger.log(JSON.stringify(parsePhoneField(phoneTest)));

  // Test time conversion
  Logger.log(timeToSeconds('0:07:43')); // should log 463
  Logger.log(timeToSeconds('1:00:00')); // should log 3600

  // Test date parsing
  Logger.log(parseDate('04/5/2024')); // should log 2024-04-05
}

function testSingleRow() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('CDR Historical Data'); // your sheet name
  const data  = sheet.getDataRange().getValues();
  const r     = data[1]; // row index 1 = first data row (skip header)

  Logger.log('Date:      ' + parseDate(r[2]));
  Logger.log('Dept:      ' + r[3]);
  Logger.log('Agent:     ' + r[4]);
  Logger.log('OB Total:  ' + toInt(r[5]));
  Logger.log('Col I:     ' + JSON.stringify(parseNameField(r[8])));
  Logger.log('Col X:     ' + JSON.stringify(parsePhoneField(r[23])));
}