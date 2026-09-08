// ============================================================================
// neonBackfill.gs — Phase 2 of DQE/QCD Neon migration
// ----------------------------------------------------------------------------
// One-time backfill scripts that read existing rows from "DQE Historical Data"
// and "QCD Historical Data" sheets and write them to Neon Postgres.
//
// Idempotent: the *History() backfills use ON CONFLICT DO NOTHING (safe to
// re-run if interrupted); the *Upsert variants DO UPDATE so rebuilt values win.
// Resumable: tracks progress in Script Properties so timeouts don't lose work.
//
// Usage:
//   1. Add NEON_HOST, NEON_DB, NEON_USER, NEON_PASS to Script Properties
//      (same credentials as your existing CDR archive)
//   2. Run backfillDQEHistory() — repeat until "complete"
//   3. Run backfillQCDHistory() — repeat until "complete"
//
// CDR cleanup (separate, on demand):
//   backfillCDRHistory() — re-mirrors "CDR Historical Data" to
//   call_history_dept + call_history_phones. Unlike the DQE/QCD backfills
//   it uses ON CONFLICT DO UPDATE on the main row so it REPAIRS the JSONB
//   name columns corrupted before the F2 splitter fix, and fills any
//   partially-written phone children. Requires HMAC_SECRET (aborts without
//   it to avoid nulling the JSONB). Resumable via CDR_BACKFILL_RESUME.
//   (T-8: every *_RESUME pointer is a fingerprinted JSON {index,rowCount,key};
//   a sheet change since the last run restarts from 0 -- see nbResumeRead_.)
// ============================================================================


// -- Connection helper -------------------------------------------------------

function getNeonConn_backfill() {
  var p   = PropertiesService.getScriptProperties();
  // NO connect/socket/login timeout params here: Apps Script's JDBC service
  // REJECTS them outright -- "The following connection properties are
  // unsupported: connectTimeout,socketTimeout,loginTimeout" -- so adding them
  // made EVERY Neon connection fail instantly across all three projects
  // (shipped 2026-08-24, caught in production the next day). The hanging-connect
  // problem they were meant to bound is real but NOT solvable this way; bound
  // STATEMENTS with stmt.setQueryTimeout(seconds) instead, which the platform
  // does support. cross-file-pins.test.js fails if the params come back.
  var url = 'jdbc:postgresql://' + p.getProperty('NEON_HOST') + '/' + p.getProperty('NEON_DB');
  return Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS'));
}


// -- T-8: fingerprinted resume pointers ----------------------------------------
//
// The four `*_RESUME` Script Properties used to hold a bare row INDEX into the
// getDisplayValues() grid. That is positional: any row deleted or inserted
// above the pointer between runs (the duplicate-merge repair, a force
// re-import that shrank a date, a manual clean-up) shifts every later row, so
// the resumed run silently SKIPPED rows for good (or re-did some). The pointer
// now carries a fingerprint -- the grid's row count and the key of the row it
// would resume AT -- and a mismatch restarts from 0 with a log line saying
// why. Restarting is always safe: every backfill here is ON CONFLICT
// idempotent. A legacy bare-integer value has no fingerprint to verify, so it
// restarts too (logged). Operators still clear the property to force a
// from-the-top run, exactly as before.
var NB_DQE_KEY_COLS_ = [1, 2];      // DQE Historical Data: B date, C agent
var NB_CDR_KEY_COLS_ = [2, 3, 4];   // CDR Historical Data: C date, D dept, E name
var NB_QCD_KEY_COLS_ = [2, 3, 4];   // QCD Historical Data: C date, D queue, E source

function nbResumeKey_(row, keyCols) {
  return keyCols.map(function (c) {
    return String(row && row[c] != null ? row[c] : '').trim();
  }).join('\u0001');
}

function nbResumeRead_(props, prop, data, keyCols) {
  var raw = props.getProperty(prop);
  if (!raw) return 0;
  var st = null;
  try { st = JSON.parse(raw); } catch (e) { st = null; }
  if (!st || typeof st !== 'object') {
    Logger.log(prop + ' = "' + raw + '" is a legacy positional pointer with no row '
      + 'fingerprint -- restarting from 0 so no row can be skipped (T-8). Clear the '
      + 'property to silence this.');
    return 0;
  }
  var idx = parseInt(st.index, 10);
  if (isNaN(idx) || idx < 0) idx = 0;
  var why = null;
  if (st.rowCount !== data.length) {
    why = 'row count changed (' + st.rowCount + ' -> ' + data.length + ')';
  } else if (idx < data.length && nbResumeKey_(data[idx], keyCols) !== st.key) {
    why = 'the row at index ' + idx + ' changed ("' + st.key + '" -> "'
      + nbResumeKey_(data[idx], keyCols) + '")';
  }
  if (why) {
    Logger.log(prop + ': the sheet changed since the last run -- ' + why
      + '. Restarting from 0 so no row is skipped (T-8).');
    return 0;
  }
  return idx;
}

function nbResumeWrite_(props, prop, idx, data, keyCols) {
  props.setProperty(prop, JSON.stringify({
    index: idx,
    rowCount: data.length,
    key: idx < data.length ? nbResumeKey_(data[idx], keyCols) : '',
  }));
}

// -- T-7: sanitizer loss tally -------------------------------------------------
//
// The DQE backfills route AD/AE through sanitizeAbandonedCellForNeon_ and the
// K-AC slots + AF through sanitizeSlotCellForNeon_, which EXCLUDE (null) or
// SENTINEL (#REBUILD) cells they cannot recover. Correct -- but it used to be
// silent: a run could null hundreds of coerced cells and log only its row
// counts. The tally is printed in the completion / time-limit log lines and
// stored in `DQE_BACKFILL_LAST` / `DQE_UPSERT_LAST`, so "how much did this run
// lose?" has an answer, and a non-zero figure is the cue to run the
// sheetRepairs before re-running.
function nbNewSanTally_() { return { nulled: 0, sentineled: 0, rowsAffected: 0 }; }

function nbSanitizeDqeCells_(r, tally) {
  var lostBefore = tally.nulled + tally.sentineled;
  var slots = r.slice(10, 29).map(function (cell) {
    var out = sanitizeSlotCellForNeon_(cell);   // F-51
    if (out === null && String(cell == null ? '' : cell).trim()) tally.nulled++;
    return out;
  });
  var abId = function (cell) {
    var raw = String(cell == null ? '' : cell).trim();
    var out = sanitizeAbandonedCellForNeon_(cell);
    if (out === DQE_ABANDONED_LOST_SENTINEL && raw !== DQE_ABANDONED_LOST_SENTINEL) tally.sentineled++;
    return out;
  };
  var abParentIds = abId(r[29]);
  var abMissedIds = abId(r[30]);
  // M3: AF is a comma-joined H:MM:SS TIMES column that coerces IDENTICALLY to
  // the K-AC slots (a "12/30/1899 10:23:33" date-render or a bare serial), NOT
  // like the numeric AD/AE IDs. Route it through the slot sanitizer (F-51) so
  // a coerced date-render is RECOVERED to "10:23:33" instead of mirrored
  // verbatim as garbage by the ID sanitizer. `|| null` preserves the
  // empty-cell -> NULL contract the ID sanitizer gave (the slot sanitizer
  // returns '' for empty).
  var afOut = sanitizeSlotCellForNeon_(r[31]);
  if (afOut === null && String(r[31] == null ? '' : r[31]).trim()) tally.nulled++;
  if (tally.nulled + tally.sentineled > lostBefore) tally.rowsAffected++;
  return { slots: slots, abParentIds: abParentIds, abMissedIds: abMissedIds,
           abMissedTimes: afOut || null };
}

// Batch 2 follow-on: the tally also lands as a Pipeline Health row (the
// cross-project channel the dashboard's Health page reads -- `*_LAST` Script
// Properties live in THIS project and the page cannot see them). `success`
// on a clean run; `failure` when cells were excluded (the cue to run the
// sheetRepairs) or a batch threw. logPipelineHealth_ is defined in this
// project's buildDQEHistoricalData.js; typeof-guarded for the unit harness.
function nbPipelineRow_(ss, step, status, rows, t0, notes) {
  try {
    if (typeof logPipelineHealth_ !== 'function') return;
    logPipelineHealth_(ss, { step: step, status: status, rows: rows,
                             durationMs: Date.now() - t0, notes: notes });
  } catch (e) { /* best-effort */ }
}

function nbSanTallyText_(t) {
  return 'cells nulled=' + t.nulled + ' sentineled=' + t.sentineled
    + ' rows-with-loss=' + t.rowsAffected;
}

function nbSanTallyLog_(label, t) {
  if (t.nulled + t.sentineled === 0) {
    Logger.log(label + ': sanitizer loss -- none (no coerced cells excluded).');
    return;
  }
  Logger.log(label + ': sanitizer loss -- ' + nbSanTallyText_(t)
    + '. Those cells are coerced beyond recovery on the SHEET; run the '
    + 'sheetRepairs (repairDqeSlotTimestamps / repairDqeAbandonedIds) and, for '
    + 'the #REBUILD rows, rebuild those dates from Raw Data, then re-run.');
}


// Sanitizes an abandoned-ID/time cell (cols AD/AE/AF) read via getDisplayValues
// BEFORE it's mirrored to Neon, so a backfill run can't push garbage even before
// the sheet itself is repaired (sheetRepairs.js::repairDqeAbandonedIds).
//
// These cells hold comma-joined big integers (abandoned parent IDs / missed-leg
// IDs / epoch-ms times). Rows that predate the build's plain-text protection were
// coerced by Sheets into a Number (the comma read as a thousands group);
// getDisplayValues then returns the coerced display -- thousand-separated
// ("17,622,...,000,000"), scientific ("1.76E+24"), or a long bare-digit run --
// which, written as-is, mis-splits on the separator commas downstream.
//
// Recovers LOSSLESS single-value coercions and NULLs genuinely-lossy multi-value
// ones (precision past 2^53 is gone; those dates can only be restored by
// rebuilding from Raw Data). 15 digits is the safe-integer ceiling (2^53 ~
// 9.0e15); a real abandoned ID / epoch-ms timestamp is 13 digits, so a correct
// single value always survives and a correct multi-value (whose long-ID tokens
// never look like 3-digit thousands groups) is never touched.
// Sentinel written when a multi-value cell's original IDs are genuinely lost, so
// "corrupted -- rebuild" is distinguishable from a genuinely-empty "0 abandoned"
// (NULL). The dashboard's classifyAbandonedCell_ (Util.gs) recognizes it and
// excludes it from counts; both literals must match.
var DQE_ABANDONED_LOST_SENTINEL = '#REBUILD';

function sanitizeAbandonedCellForNeon_(raw) {
  var s = (raw == null ? '' : String(raw)).trim();
  if (!s) return null;                                   // genuinely empty (0 abandoned)
  if (s === DQE_ABANDONED_LOST_SENTINEL) return DQE_ABANDONED_LOST_SENTINEL;  // already marked
  // Coerced + re-rendered as a float: scientific notation or a decimal point.
  if (/[eE][+\-]?\d/.test(s) || s.indexOf('.') !== -1) return DQE_ABANDONED_LOST_SENTINEL;
  // Thousands-separated number: 1-3 leading digits then only 3-digit groups.
  if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    var digits = s.replace(/,/g, '');
    // single value (<=15 digits) is recoverable; multi-value lost past 2^53.
    return digits.length <= 15 ? digits : DQE_ABANDONED_LOST_SENTINEL;
  }
  // Bare digit run, no separators, too long to be one real ID -> coerced + lost.
  if (/^\d+$/.test(s) && s.length > 15) return DQE_ABANDONED_LOST_SENTINEL;
  // Otherwise: a correct single long ID, or a comma-list of long IDs. Keep.
  return s;
}


// F-51: the 19 slot columns (K-AC) hold comma-joined H:MM:SS times and
// coerce like AF -- but the sheet->Neon paths mirrored them VERBATIM, so a
// still-coerced cell (a "12/30/1899 10:23:33" date render, or a bare serial
// decimal) landed in slot_* as an unparseable token. Pass clean cells
// through, recover the lossless single-value date-render coercion (keep the
// time part), and EXCLUDE (null) anything else rather than mirror garbage --
// the run-order discipline ("run repairDqeSlotTimestamps first") is now a
// safety net instead of the only protection. KEEP THIS COPY IDENTICAL in
// cdr-report/neonbackfill.js and cdr-import/NeonMirror.js -- enforced by
// scripts/check-duplicated-files.sh's function-level check.
function sanitizeSlotCellForNeon_(raw) {
  var s = (raw == null ? '' : String(raw)).trim();
  if (!s) return '';
  var tokens = s.split(',').map(function (t) { return t.trim(); }).filter(function (t) { return !!t; });
  var timeRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
  var ok = tokens.length > 0;
  for (var i = 0; i < tokens.length; i++) {
    if (!timeRe.test(tokens[i])) { ok = false; break; }
  }
  if (ok) return tokens.join(',');
  var m = s.match(/^\d{1,2}\/\d{1,2}\/\d{4}\s+(\d{1,2}:\d{2}:\d{2})/);
  if (m) return m[1];
  return null;
}


// -- DQE backfill ------------------------------------------------------------

function backfillDQEHistory() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet) { Logger.log('DQE: Sheet not found.'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('DQE: Sheet is empty.'); return; }

  // Read up to 35 columns (A..AI) as display values for consistent string handling.
  // REP-10: reading a FIXED width threw on sheets trimmed to exactly the data
  // width, so take what the sheet actually has. 35 cols since sub-queue Phase 1
  // (AI Queue Split); a sheet still 34 wide yields undefined for r[34], which the
  // row builder maps to null -- byte-identical to pre-Phase-1 behavior.
  var dqeWidth = Math.min(35, sheet.getMaxColumns());
  var data = sheet.getRange(2, 1, lastRow - 1, dqeWidth).getDisplayValues();

  var props      = PropertiesService.getScriptProperties();
  var sanTally   = nbNewSanTally_();   // T-7
  var startIndex = nbResumeRead_(props, 'DQE_BACKFILL_RESUME', data, NB_DQE_KEY_COLS_);   // T-8

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
        nbResumeWrite_(props, 'DQE_BACKFILL_RESUME', i, data, NB_DQE_KEY_COLS_);
        Logger.log('Time limit reached. Resume saved at index ' + i +
          '. Inserted: ' + totalInserted + '. Run again to continue.');
        nbSanTallyLog_('DQE backfill', sanTally);
        props.setProperty('DQE_BACKFILL_LAST', 'PARTIAL ' + new Date().toISOString()
          + ' resume=' + i + ' inserted=' + totalInserted + ' ' + nbSanTallyText_(sanTally));
        return;
      }

      // Resume at the batch START on failure (see catch): the inner loop skips
      // blank rows (i++ without pushing), so i - batch.length under-counts the
      // start and would re-scan already-skipped rows. Mirrors the upsert path.
      var batchStartIdx = i;
      var batch = [];
      var batchEnd = Math.min(i + BATCH_SIZE, data.length);
      while (i < batchEnd) {
        var r = data[i];
        if (!r[1] || !r[2]) { i++; continue; }
        var cd0 = parseDateForNeon(r[1]);
        if (!cd0) { i++; continue; }   // unparseable date -> skip, don't poison the batch with a null call_date

        var san = nbSanitizeDqeCells_(r, sanTally);   // T-7
        batch.push({
          monthYear:        r[0]  || null,
          callDate:         cd0,
          agentName:        r[2],
          queueExtensions:  r[3]  || null,
          totalUnique:      parseInt(r[4]) || 0,
          totalRung:        parseInt(r[5]) || 0,
          totalMissed:      parseInt(r[6]) || 0,
          totalAnswered:    parseInt(r[7]) || 0,
          ttt:              r[8]  || null,
          att:              r[9]  || null,
          slots:            san.slots,          // F-51 (tallied, T-7)
          abParentIds:      san.abParentIds,
          abMissedIds:      san.abMissedIds,
          abMissedTimes:    san.abMissedTimes,   // M3: AF via the slot sanitizer
          // Durations via normalizeDuration so the "No abd calls" sentinel
          // (12 chars, written when a row has 0 abandoned calls) and any
          // other non-H:MM:SS value normalize to null instead of
          // overflowing the varchar(10) avg_abd_wait / csr_avg_abd_wait
          // columns. parseHmsDisplay_(null) reads back as 0 on the
          // dashboard side -- same semantics as before.
          avgAbdWait:       normalizeDuration(r[32]),
          csrAvgAbdWait:    normalizeDuration(r[33]),
          // Sub-queue Phase 1. Carried so the DO-UPDATE backfill -- the
          // documented post-bulk-rebuild step -- cannot blank an existing
          // queue_split back to NULL. undefined on a pre-Phase-1 sheet.
          queueSplit:       r[34] || null
        });
        i++;
      }

      if (batch.length === 0) continue;

      var conn = getNeonConn_backfill();
      conn.setAutoCommit(false);

      try {
        var placeholderRow  = '(' + new Array(35).fill('?').join(',') + ')';   // +queue_split (Phase 1)
        var allPlaceholders = batch.map(function() { return placeholderRow; }).join(',');

        var sql = 'INSERT INTO dqe_history (' +
          'month_year, call_date, agent_name, queue_extensions, ' +
          'total_unique, total_rung, total_missed, total_answered, ttt, att, ' +
          'slot_0800_0830, slot_0830_0900, slot_0900_0930, slot_0930_1000, slot_1000_1030, ' +
          'slot_1030_1100, slot_1100_1130, slot_1130_1200, slot_1200_1230, slot_1230_1300, ' +
          'slot_1300_1330, slot_1330_1400, slot_1400_1430, slot_1430_1500, slot_1500_1530, ' +
          'slot_1530_1600, slot_1600_1630, slot_1630_1700, slot_1700_1730, ' +
          'abandoned_parent_ids, abandoned_missed_ids, abandoned_missed_times, ' +
          'avg_abd_wait, csr_avg_abd_wait, queue_split' +
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
          stmt.setString(p++, row.queueSplit ? String(row.queueSplit) : null);
        }

        stmt.execute();
        // getUpdateCount() reports rows ACTUALLY inserted; ON CONFLICT
        // DO NOTHING skips aren't counted. Fall back to batch.length only
        // if the driver returns -1 (no update count available).
        var dqeAffected = stmt.getUpdateCount();
        stmt.close();
        conn.commit();

        var dqeInserted = (dqeAffected >= 0 ? dqeAffected : batch.length);
        totalInserted += dqeInserted;
        Logger.log('Committed batch ending at index ' + i + ' (' + batch.length
          + ' attempted, ' + dqeInserted + ' newly inserted). Cumulative inserted: ' + totalInserted);

      } catch (e) {
        conn.rollback();
        nbResumeWrite_(props, 'DQE_BACKFILL_RESUME', batchStartIdx, data, NB_DQE_KEY_COLS_);
        Logger.log('Batch failed, rolled back. Resume at ' + batchStartIdx + '. Error: ' + e.message);
        throw e;
      } finally {
        conn.close();
      }
    }

    props.deleteProperty('DQE_BACKFILL_RESUME');
    Logger.log('DQE backfill complete. Total processed: ' + (i - startIndex) +
      '. Total inserted into Neon: ' + totalInserted);
    nbSanTallyLog_('DQE backfill', sanTally);
    props.setProperty('DQE_BACKFILL_LAST', 'OK ' + new Date().toISOString()
      + ' inserted=' + totalInserted + ' ' + nbSanTallyText_(sanTally));
    var bfLoss = sanTally.nulled + sanTally.sentineled;
    nbPipelineRow_(ss, 'dqeBackfill', bfLoss ? 'failure' : 'success', totalInserted, startTime,
      nbSanTallyText_(sanTally) + (bfLoss ? ' -- coerced cells EXCLUDED from the mirror; run the sheetRepairs, then re-run' : ''));

  } catch (e) {
    Logger.log('DQE backfill stopped. Error: ' + e.message);
    throw e;
  }
}


// -- DQE upsert backfill (for the skipNeon bulk-rebuild workflow) -------------
//
// After a force-rebuild (bulkHistoricalUpdate) leaves freshly RE-CALCULATED
// rows in the DQE Historical Data sheet with the per-date Neon mirror skipped
// (buildDQEHistoricalData opts.skipNeon=true), run THIS once to mirror them
// all to dqe_history with ON CONFLICT DO UPDATE -- so the new values OVERWRITE
// any stale rows. (backfillDQEHistory uses DO NOTHING and would SKIP dates
// already in Neon, leaving the old methodology's values in place.)
//
// Resumable via DQE_UPSERT_RESUME (clear to re-run from the top). Opens ONE
// connection per invocation (vs the per-batch connection in backfillDQEHistory)
// so the slow JDBC handshake is paid once -- the main reason this single
// end-pass beats the 60 per-date mirrors it replaces.
//
// Optional date floor: set the DQE_UPSERT_SINCE Script Property to a
// YYYY-MM-DD date to upsert ONLY rows on/after it (e.g. after a bulk rebuild
// of just a few recent days, so you don't redo the whole sheet). Unset =
// whole-sheet. Clear it to return to whole-sheet behavior.
function backfillDQEHistoryUpsert() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet) { Logger.log('DQE upsert: Sheet not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('DQE upsert: Sheet is empty.'); return; }

  // REP-10: reading a FIXED width threw on sheets trimmed to exactly the data
  // width, so take what the sheet actually has. 35 cols since sub-queue Phase 1
  // (AI Queue Split); a sheet still 34 wide yields undefined for r[34], which the
  // row builder maps to null -- byte-identical to pre-Phase-1 behavior.
  var dqeWidth = Math.min(35, sheet.getMaxColumns());
  var data = sheet.getRange(2, 1, lastRow - 1, dqeWidth).getDisplayValues();

  var props      = PropertiesService.getScriptProperties();
  var sanTally   = nbNewSanTally_();   // T-7
  var startIndex = nbResumeRead_(props, 'DQE_UPSERT_RESUME', data, NB_DQE_KEY_COLS_);   // T-8
  // Optional date floor: when DQE_UPSERT_SINCE (YYYY-MM-DD) is set, only
  // rows with call_date >= it are upserted -- so after a bulk rebuild of
  // just a few recent days you can mirror only those instead of the whole
  // sheet. Unset / malformed = whole-sheet (default). The run still
  // iterates every row (cheap in-memory skip); only the Neon upserts are
  // limited. Clear DQE_UPSERT_SINCE to return to whole-sheet behavior.
  var sinceFloor = props.getProperty('DQE_UPSERT_SINCE');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sinceFloor || ''))) sinceFloor = null;
  Logger.log('DQE upsert: starting at index ' + startIndex + ' of ' + data.length
    + (sinceFloor ? ' (date floor >= ' + sinceFloor + ')' : ''));
  if (startIndex >= data.length) {
    Logger.log('DQE upsert complete. Clear DQE_UPSERT_RESUME to re-run.');
    return;
  }

  var BATCH_SIZE    = 50;   // 50 rows * 34 cols keeps the SQL string + the
                            // DO UPDATE SET clause well under Apps Script's
                            // Jdbc statement-size limit (see neonWrite A3).
  var TIME_LIMIT_MS = 240000;
  var startTime     = Date.now();
  var totalUpserted = 0;
  var i = startIndex;

  var conn = getNeonConn_backfill();
  if (!conn) { Logger.log('DQE upsert: no Neon connection (NEON_* Script Properties set?).'); return; }
  conn.setAutoCommit(false);

  try {
    while (i < data.length) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        nbResumeWrite_(props, 'DQE_UPSERT_RESUME', i, data, NB_DQE_KEY_COLS_);
        Logger.log('Time limit reached. Resume saved at index ' + i +
          '. Upserted: ' + totalUpserted + '. Run again to continue.');
        nbSanTallyLog_('DQE upsert', sanTally);
        props.setProperty('DQE_UPSERT_LAST', 'PARTIAL ' + new Date().toISOString()
          + ' resume=' + i + ' upserted=' + totalUpserted + ' ' + nbSanTallyText_(sanTally));
        return;   // finally closes conn
      }

      var batchStartIdx = i;
      var batch = [];
      var batchEnd = Math.min(i + BATCH_SIZE, data.length);
      while (i < batchEnd) {
        var r = data[i];
        if (!r[1] || !r[2]) { i++; continue; }
        var cd = parseDateForNeon(r[1]);
        // A truthy-but-unparseable date yields cd=null. Skip it: pushing a null
        // call_date violates NOT NULL / uq_dqe_history and throws for the WHOLE
        // batch, then DQE_UPSERT_RESUME re-runs into the same poison row every
        // time. (The sinceFloor `cd &&` below already short-circuited on null,
        // letting the null row through -- this guard closes that.)
        if (!cd) { i++; continue; }
        // Date floor (DQE_UPSERT_SINCE): skip rows older than the floor.
        if (sinceFloor && cd < sinceFloor) { i++; continue; }
        var san = nbSanitizeDqeCells_(r, sanTally);   // T-7
        batch.push({
          monthYear:        r[0]  || null,
          callDate:         cd,
          agentName:        r[2],
          queueExtensions:  r[3]  || null,
          totalUnique:      parseInt(r[4]) || 0,
          totalRung:        parseInt(r[5]) || 0,
          totalMissed:      parseInt(r[6]) || 0,
          totalAnswered:    parseInt(r[7]) || 0,
          ttt:              r[8]  || null,
          att:              r[9]  || null,
          slots:            san.slots,          // F-51 (tallied, T-7)
          abParentIds:      san.abParentIds,
          abMissedIds:      san.abMissedIds,
          abMissedTimes:    san.abMissedTimes,   // M3: AF via the slot sanitizer
          // See backfillDQEHistory: normalizeDuration nulls the "No abd
          // calls" sentinel + any non-H:MM:SS so it can't overflow the
          // varchar(10) abd-wait columns.
          avgAbdWait:       normalizeDuration(r[32]),
          csrAvgAbdWait:    normalizeDuration(r[33]),
          // Sub-queue Phase 1. Carried so the DO-UPDATE backfill -- the
          // documented post-bulk-rebuild step -- cannot blank an existing
          // queue_split back to NULL. undefined on a pre-Phase-1 sheet.
          queueSplit:       r[34] || null
        });
        i++;
      }
      // IMP-6: a single INSERT ... ON CONFLICT DO UPDATE cannot touch the same
      // conflict key twice ("ON CONFLICT DO UPDATE command cannot affect row a
      // second time"). The DQE sheet can hold two rows for the same
      // (call_date, agent_name) -- e.g. a pre-canonicalization duplicate of an
      // agent on a day -- and if both fall in one 50-row batch the whole
      // statement throws. Collapse the batch to one row per key, LAST-write-
      // wins (keeping position), mirroring the inline writers' dedup. Dupes
      // split across batch boundaries are already safe (separate statements;
      // the second batch's DO UPDATE just refreshes the row).
      if (batch.length > 1) {
        var seenKey_ = {};
        var deduped_ = [];
        for (var d = 0; d < batch.length; d++) {
          var key_ = batch[d].callDate + '\u0000' + batch[d].agentName;
          if (seenKey_[key_] !== undefined) {
            deduped_[seenKey_[key_]] = batch[d];   // last-write-wins, same slot
          } else {
            seenKey_[key_] = deduped_.length;
            deduped_.push(batch[d]);
          }
        }
        batch = deduped_;
      }
      if (batch.length === 0) continue;

      try {
        var placeholderRow  = '(' + new Array(35).fill('?').join(',') + ')';   // +queue_split (Phase 1)
        var allPlaceholders = batch.map(function() { return placeholderRow; }).join(',');
        var sql = 'INSERT INTO dqe_history (' +
          'month_year, call_date, agent_name, queue_extensions, ' +
          'total_unique, total_rung, total_missed, total_answered, ttt, att, ' +
          'slot_0800_0830, slot_0830_0900, slot_0900_0930, slot_0930_1000, slot_1000_1030, ' +
          'slot_1030_1100, slot_1100_1130, slot_1130_1200, slot_1200_1230, slot_1230_1300, ' +
          'slot_1300_1330, slot_1330_1400, slot_1400_1430, slot_1430_1500, slot_1500_1530, ' +
          'slot_1530_1600, slot_1600_1630, slot_1630_1700, slot_1700_1730, ' +
          'abandoned_parent_ids, abandoned_missed_ids, abandoned_missed_times, ' +
          'avg_abd_wait, csr_avg_abd_wait, queue_split' +
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
          'csr_avg_abd_wait = EXCLUDED.csr_avg_abd_wait, ' +
          // Phase 1: COALESCE, not a plain overwrite. This backfill re-reads the
          // SHEET, so a pre-Phase-1 sheet row would send NULL and erase a
          // queue_split that a later build had already mirrored. Keep the stored
          // value whenever the incoming one is NULL.
          'queue_split = COALESCE(EXCLUDED.queue_split, dqe_history.queue_split)';

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
          stmt.setString(p++, row.queueSplit ? String(row.queueSplit) : null);
        }
        stmt.execute();
        stmt.close();
        conn.commit();
        totalUpserted += batch.length;
        Logger.log('Upserted batch ending at index ' + i + ' (' + batch.length +
          ' rows). Cumulative: ' + totalUpserted);
      } catch (e) {
        try { conn.rollback(); } catch (re) {}
        nbResumeWrite_(props, 'DQE_UPSERT_RESUME', batchStartIdx, data, NB_DQE_KEY_COLS_);
        Logger.log('Batch failed, rolled back. Resume at ' + batchStartIdx + '. Error: ' + e.message);
        nbPipelineRow_(ss, 'dqeUpsert', 'failure', totalUpserted, startTime,
          'batch starting at index ' + batchStartIdx + ' threw: ' + e.message + ' -- resume pointer saved');
        throw e;
      }
    }

    props.deleteProperty('DQE_UPSERT_RESUME');
    Logger.log('DQE upsert complete. Total processed: ' + (i - startIndex) +
      '. Total upserted into Neon: ' + totalUpserted);
    nbSanTallyLog_('DQE upsert', sanTally);
    props.setProperty('DQE_UPSERT_LAST', 'OK ' + new Date().toISOString()
      + ' upserted=' + totalUpserted + ' ' + nbSanTallyText_(sanTally));
    var upLoss = sanTally.nulled + sanTally.sentineled;
    nbPipelineRow_(ss, 'dqeUpsert', upLoss ? 'failure' : 'success', totalUpserted, startTime,
      nbSanTallyText_(sanTally) + (upLoss ? ' -- coerced cells EXCLUDED from the mirror; run the sheetRepairs, then re-run' : ''));
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}


// ── Editor-run diagnostic: duplicate (call_date, agent_name) rows ───────────
//
// The DQE Historical Data -> Neon mirror keys on uq_dqe_history
// (call_date, agent_name). Two sheet rows sharing that key (a) collide inside
// one ON CONFLICT batch -- the "cannot affect row a second time" error
// backfillDQEHistoryUpsert now dedups past -- and (b) DOUBLE-COUNT that agent
// on that day in the SHEET-based dashboard reads (DQE_READ_SOURCE unset/sheet).
// This READ-ONLY scan lists every duplicate key so the source rows can be
// reconciled. It uses the SAME display-value read + parseDateForNeon date
// normalization as the upsert, so the report is EXACTLY the set of rows that
// would collide. It writes a "DQE Duplicate Rows" report sheet (created +
// cleared each run) and logs a summary; it NEVER modifies DQE Historical Data.
//
// Run from the Apps Script editor (cdr-report project) via the Run picker
// (non-underscore name, so it's listed).
function findDqeDuplicateRows() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet) { Logger.log('DQE dup scan: "DQE Historical Data" not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('DQE dup scan: sheet is empty.'); return; }

  // Same read as backfillDQEHistoryUpsert (getDisplayValues, 34 cols, INV-10):
  // col B (index 1) = call_date, col C (index 2) = agent_name.
  var data = sheet.getRange(2, 1, lastRow - 1, 34).getDisplayValues();

  var groups = {};   // key -> [{ row, date, agent, unique, rung, missed, answered, ttt, att }]
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[1] || !r[2]) continue;               // same skip as the upsert
    var cd = parseDateForNeon(r[1]);
    if (!cd) continue;                           // unparseable date -> not a key
    var agent = String(r[2]);
    var key = cd + '\u0000' + agent;
    (groups[key] = groups[key] || []).push({
      row:    i + 2,                             // 1-based sheet row (data starts at row 2)
      date:   cd, agent: agent,
      unique: r[4], rung: r[5], missed: r[6], answered: r[7], ttt: r[8], att: r[9]
    });
  }

  var dupKeys = Object.keys(groups).filter(function (k) { return groups[k].length > 1; });
  dupKeys.sort();   // key = 'YYYY-MM-DD\u0000agent' -> chronological, then agent
  var totalDupRows = 0;
  dupKeys.forEach(function (k) { totalDupRows += groups[k].length; });

  Logger.log('DQE dup scan: ' + dupKeys.length + ' duplicate (date, agent) key(s) spanning '
    + totalDupRows + ' rows (of ' + data.length + ' scanned).');

  // Write / refresh the report sheet (non-destructive to the source).
  var REPORT = 'DQE Duplicate Rows';
  var out = ss.getSheetByName(REPORT) || ss.insertSheet(REPORT);
  out.clear();
  var headers = ['Group', 'Sheet Row', 'Date', 'Agent', 'Unique', 'Rung', 'Missed', 'Answered', 'TTT', 'ATT'];
  var rows = [headers];
  var g = 0;
  dupKeys.forEach(function (k) {
    g++;
    groups[k].forEach(function (e) {
      rows.push([g, e.row, e.date, e.agent, e.unique, e.rung, e.missed, e.answered, e.ttt, e.att]);
    });
  });
  if (rows.length === 1) {
    rows.push(['—', '', '', 'No duplicate (date, agent) rows found', '', '', '', '', '', '']);
  }
  out.getRange(1, 1, rows.length, headers.length).setValues(rows);
  out.setFrozenRows(1);
  out.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  try { out.autoResizeColumns(1, headers.length); } catch (rz) {}

  // Log the first groups inline for a quick glance without opening the sheet.
  dupKeys.slice(0, 20).forEach(function (k) {
    var e = groups[k];
    Logger.log('  ' + e[0].date + ' / ' + e[0].agent + '  ->  rows '
      + e.map(function (x) { return x.row; }).join(', '));
  });
  if (dupKeys.length > 20) {
    Logger.log('  ...and ' + (dupKeys.length - 20) + ' more (see the "' + REPORT + '" sheet).');
  }
  Logger.log('DQE dup scan: full report written to the "' + REPORT + '" sheet.');
}


// -- CDR backfill ------------------------------------------------------------
//
// Re-mirrors "CDR Historical Data" sheet rows to Neon
// (call_history_dept + call_history_phones). Two cleanup jobs in one:
//
//   1. Overwrites the JSONB name-list columns via ON CONFLICT DO UPDATE.
//      This is the ONLY way to repair rows mirrored before the F2 fix to
//      cdrParseNameFieldJson_'s entry splitter (which silently merged
//      name entries beginning with a lowercase letter / accented capital /
//      digit). The live writeCDRRowsToNeon uses DO NOTHING, so a plain
//      re-run does NOT repair them -- this DO UPDATE does.
//   2. Fills any partially-written call_history_phones rows left by an
//      old per-chunk-commit timeout. Phone children are NOT affected by
//      F2 (cdrParsePhoneField_ uses a separate regex), so DO NOTHING on
//      uq_phone_entry just adds the missing rows without duplicating.
//
// Requires HMAC_SECRET (same as the live CDR writer). We ABORT if it's
// unset: a DO UPDATE without it would write null into the JSONB name
// columns, destroying data -- the opposite of cleanup.
//
// Resumable via CDR_BACKFILL_RESUME (clear it to re-run from the top).
// Idempotent + safe to re-run. Column mapping mirrors
// autoImport.js::processIntegratedHistory's neonCdrRows builder; the
// sheet layout is [Month, Week, Date, Dept, Name, ...21 metric cols]
// (26 cols), so metric r[k] lives at sheet column index (4 + k).
function backfillCDRHistory() {
  var hmacSecret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!hmacSecret) {
    Logger.log('CDR backfill ABORTED: HMAC_SECRET is not set. Running DO UPDATE '
      + 'without it would null out the JSONB name columns. Set HMAC_SECRET '
      + '(same value as the import project) and re-run.');
    return;
  }

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CDR Historical Data');
  if (!sheet) { Logger.log('CDR: Sheet not found.'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('CDR: Sheet is empty.'); return; }

  // 26 cols: Month | Week | Date | Dept | Name | C..W (21 metric cols).
  var data = sheet.getRange(2, 1, lastRow - 1, 26).getDisplayValues();

  var props      = PropertiesService.getScriptProperties();
  var startIndex = nbResumeRead_(props, 'CDR_BACKFILL_RESUME', data, NB_CDR_KEY_COLS_);   // T-8
  // R27: optional ISO ceiling -- rows dated ON/AFTER it are skipped, so the
  // Operator State #57 refill (TRUNCATE call_history_phones, then rebuild the
  // pre-capture block) cannot re-create the post-2026-07-10 phone rows the
  // outbound_calls capture superseded. Unset = no ceiling (the old behavior).
  // NB this function ALWAYS writes phone children regardless of the
  // CDR_PHONES_MIRROR gate: it is the tool that refills the archive.
  var ceilingIso = String(props.getProperty('CDR_BACKFILL_BEFORE') || '').trim();
  if (ceilingIso && !/^\d{4}-\d{2}-\d{2}$/.test(ceilingIso)) {
    Logger.log('CDR backfill ABORTED: CDR_BACKFILL_BEFORE must be an ISO date (yyyy-mm-dd), got "' + ceilingIso + '".');
    return;
  }
  var skippedByCeiling = 0;

  Logger.log('CDR backfill: starting at index ' + startIndex + ' of ' + data.length);
  if (startIndex >= data.length) {
    Logger.log('CDR backfill complete. Clear CDR_BACKFILL_RESUME to re-run.');
    return;
  }

  // Reset the shared per-run phone-hash memo (defined in neonWrite.js,
  // same project scope) so recurring numbers hash once across this run.
  CDR_HMAC_CACHE_ = {};

  var BATCH_SIZE    = 50;
  var TIME_LIMIT_MS = 240000;
  var startTime     = Date.now();

  var totalUpserted = 0;
  var totalPhones   = 0;
  var i = startIndex;

  try {
    while (i < data.length) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        nbResumeWrite_(props, 'CDR_BACKFILL_RESUME', i, data, NB_CDR_KEY_COLS_);
        Logger.log('Time limit reached. Resume saved at index ' + i +
          '. Upserted: ' + totalUpserted + ', phones: ' + totalPhones +
          '. Run again to continue.');
        return;
      }

      // Resume at the batch START on failure (see catch): the inner loop skips
      // blank rows (i++ without pushing), so i - batch.length under-counts.
      var batchStartIdx = i;
      var batch = [];
      var batchEnd = Math.min(i + BATCH_SIZE, data.length);
      while (i < batchEnd) {
        var r = data[i];
        // Skip rows with no date (col 3 -> idx 2) or no agent (col 5 -> idx 4).
        if (!r[2] || !r[4]) { i++; continue; }
        // T-2 (the DQE paths' poison-row guard, previously missing here): a
        // truthy-but-unparseable date nulls call_date, the whole batch throws
        // on the NOT NULL constraint, and the resume index re-hits the same
        // row forever -- the backfill could never complete past that batch.
        var cdrCallDate = parseDateForNeon(r[2]);
        if (!cdrCallDate) {
          Logger.log('CDR backfill: skipping row ' + (i + 2) + ' -- unparseable date "' + r[2] + '".');
          i++; continue;
        }
        if (ceilingIso && cdrCallDate >= ceilingIso) { skippedByCeiling++; i++; continue; }
        batch.push({
          callDate:   cdrCallDate,
          dept:       r[3] || 'Unassigned',
          agentName:  r[4],
          obTotal:    r[5],  obAns:     r[6],  obMiss:     r[7],
          obListTot:  r[8],  obListAns: r[9],  obListMiss: r[10],
          ibTotal:    r[11], ibAns:     r[12], ibMiss:     r[13],
          ibAnsInt:   r[14], ibAnsExt:  r[15],
          ibListTot:  r[16], ibListAns: r[17], ibListMiss: r[18],
          obExtTotal: r[19], obExtAns:  r[20],
          obExtTTT:   r[21], obExtATT:  r[22],
          phonesX:    r[23], phonesY:   r[24], phonesZ:    r[25]
        });
        i++;
      }
      if (batch.length === 0) continue;

      // P10 (the IMP-6 rule, missed here): a multi-row ON CONFLICT DO UPDATE
      // throws "cannot affect row a second time" on intra-batch conflict-key
      // (call_date, department, agent_name) duplicates -- and because the
      // resume pointer stays at batchStartIdx, every re-run rethrew on the
      // same batch: one hand-pasted duplicate sheet row wedged the backfill
      // permanently (the T-2/T-3 poison class). Last-write-wins, matching
      // backfillDQEHistoryUpsert's IMP-6 dedup.
      var seenCk = {};
      var dedupedBatch = [];
      for (var db = batch.length - 1; db >= 0; db--) {
        var ck = String(batch[db].callDate) + '\u0000' + String(batch[db].dept)
               + '\u0000' + String(batch[db].agentName);
        if (seenCk[ck]) continue;
        seenCk[ck] = true;
        dedupedBatch.push(batch[db]);
      }
      if (dedupedBatch.length !== batch.length) {
        Logger.log('CDR backfill: deduped ' + (batch.length - dedupedBatch.length)
          + ' intra-batch conflict-key duplicate(s) (last write wins).');
      }
      dedupedBatch.reverse();
      batch = dedupedBatch;

      var conn = getNeonConn_backfill();
      conn.setAutoCommit(false);

      try {
        // --- 1. Main rows: INSERT ... ON CONFLICT DO UPDATE (repairs JSONB) ---
        totalUpserted += nbUpsertCdrParents_(conn, batch, hmacSecret);

        // --- 2. Phone children: the daily writer's path (R33) ---
        // This used to bind FIVE params per phone row -- ~5,600 JDBC bridge
        // calls for a 50-row batch, five minutes per batch on the 2026-09
        // refill. cdrInsertPhoneChildRows_ (neonWrite.js) renders the child
        // tuples as inline literals (every field is a DB int, a code
        // constant or a validated hex digest) and does the IMP-4 per-parent
        // replace; each payload row carries its parent's COMPLETE entry set,
        // so replace is safe here too. Committed inside the helper.
        var phoneRowsN = 0;
        var hasAnyPhones = batch.some(function (b0) {
          return (b0.phonesX && String(b0.phonesX).trim()) || (b0.phonesY && String(b0.phonesY).trim())
              || (b0.phonesZ && String(b0.phonesZ).trim());
        });
        if (hasAnyPhones) {
          phoneRowsN = cdrInsertPhoneChildRows_(conn, batch, hmacSecret);
          totalPhones += phoneRowsN;
        }
        var phoneRows = { length: phoneRowsN };   // keeps the log line below unchanged

        Logger.log('Committed CDR batch ending at index ' + i + ' (' + batch.length
          + ' rows upserted, ' + phoneRows.length + ' phone rows). Cumulative upserted: '
          + totalUpserted + ', phones: ' + totalPhones);

      } catch (e) {
        try { conn.rollback(); } catch (re) {}
        nbResumeWrite_(props, 'CDR_BACKFILL_RESUME', batchStartIdx, data, NB_CDR_KEY_COLS_);
        Logger.log('CDR batch failed, rolled back. Resume at ' + batchStartIdx + '. Error: ' + e.message);
        throw e;
      } finally {
        try { conn.close(); } catch (ce) {}
      }
    }

    props.deleteProperty('CDR_BACKFILL_RESUME');
    Logger.log('CDR backfill complete. Total processed: ' + (i - startIndex) +
      '. Upserted: ' + totalUpserted + ', phone rows: ' + totalPhones
      + (ceilingIso ? ' (' + skippedByCeiling + ' row(s) at/after CDR_BACKFILL_BEFORE=' + ceilingIso + ' skipped)' : ''));

  } catch (e) {
    Logger.log('CDR backfill stopped. Error: ' + e.message);
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
  var startIndex = nbResumeRead_(props, 'QCD_BACKFILL_RESUME', data, NB_QCD_KEY_COLS_);   // T-8

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
        nbResumeWrite_(props, 'QCD_BACKFILL_RESUME', i, data, NB_QCD_KEY_COLS_);
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
      // Resume at the batch START on failure (see catch): the inner loop skips
      // blank rows (i++ without pushing), so i - batch.length under-counts.
      var batchStartIdx = i;
      var batch = [];
      var batchEnd = Math.min(i + BATCH_SIZE, data.length);
      while (i < batchEnd) {
        var r = data[i];
        if (!r[2] || !r[3] || !r[4]) { i++; continue; }
        // T-3 (same poison-row guard as the DQE/CDR paths): an unparseable
        // date would null call_date and wedge the resumable backfill on the
        // same batch forever. The known blank-date QCD incident (known-issues
        // 2026-07) shows this column does drift.
        var qcdCallDate = parseDateForNeon(r[2]);
        if (!qcdCallDate) {
          Logger.log('QCD backfill: skipping row ' + (i + 2) + ' -- unparseable date "' + r[2] + '".');
          i++; continue;
        }

        // R8-B1 (corrects T-4, whose unit analysis was INVERTED): store
        // abandoned_pct as a FRACTION (0..1), matching the inline writer.
        // The daily importer computes abndPct = abnd/total -- a fraction
        // (autoImport.js; the violation gate is `> QCD_VIOLATION_ABANDON_RATE`), writes that to
        // the sheet, and writeQCDRowsToNeon mirrors it VERBATIM -- so for a
        // 5.26% day the inline writer stores 0.0526, not T-4's claimed
        // 5.26 (Config.gs ABANDONED_PCT pins the sheet convention:
        // "0..1 decimal, NOT percent"). T-4 made this column mixed-unit:
        // backfilled rows 100x the inline-written ones. Normalization to
        // fraction: '%'-suffixed display -> /100; bare > 1 -> a percent-
        // scale render without the sign -> /100 (a legitimate fraction
        // can never exceed 1); bare <= 1 -> already a fraction, keep.
        // NB rows written by the T-4-era backfill keep percent units --
        // this INSERT is DO NOTHING (fill-only), so they heal only via a
        // force re-import of their date (authoritative inline writer) or
        // a one-off SQL: UPDATE qcd_history SET abandoned_pct =
        // abandoned_pct/100 WHERE abandoned_pct > 1. No dashboard reader
        // consumes the column (pct is recomputed from abandoned/total),
        // so exposure is ad-hoc SQL + future consumers.
        var pctRaw = String(r[10] || '').trim();
        var hadPctSign = pctRaw.indexOf('%') !== -1;
        var pctVal = parseFloat(pctRaw.replace('%', ''));
        if (isNaN(pctVal)) pctVal = 0;
        else if (hadPctSign || pctVal > 1) pctVal = pctVal / 100;

        batch.push({
          monthYear:     r[0] || null,
          week:          r[1] || null,
          callDate:      qcdCallDate,
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
        // getUpdateCount() reports rows ACTUALLY inserted; ON CONFLICT
        // DO NOTHING skips aren't counted. Fall back to batch.length only
        // if the driver returns -1 (no update count available).
        var qcdAffected = stmt.getUpdateCount();
        stmt.close();
        conn.commit();

        var qcdInserted = (qcdAffected >= 0 ? qcdAffected : batch.length);
        totalInserted += qcdInserted;
        Logger.log('Committed batch ending at index ' + i + ' (' + batch.length
          + ' attempted, ' + qcdInserted + ' newly inserted). Cumulative inserted: ' + totalInserted);

      } catch (e) {
        try { conn.rollback(); } catch (re) {}
        nbResumeWrite_(props, 'QCD_BACKFILL_RESUME', batchStartIdx, data, NB_QCD_KEY_COLS_);
        Logger.log('Batch failed, rolled back. Resume at ' + batchStartIdx + '. Error: ' + e.message);
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

// parseDateForNeon + normalizeDuration are intentionally NOT defined
// here: this file used to carry byte-identical copies of both, but Apps
// Script's flat per-project global scope means a last-loaded duplicate
// silently shadows the original if they ever diverge -- the exact
// failure class that let dbHistorical.js's parseNameField drift from
// the F2-fixed splitter. The single definitions live in neonWrite.js
// (same project; INV-16-duplicated with cdr-import) and are reachable
// from here through the shared scope.

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


// Pinpoints the row/column behind a DQE backfill
// "value too long for type character varying(N)" failure. The four
// duration columns (ttt / att / avg_abd_wait / csr_avg_abd_wait) are the
// varchar(10) columns in dqe_history; a normal "H:MM:SS" is <= 8 chars,
// so anything over 10 is the offender (typically a coerced/corrupt cell).
// month_year / queue_extensions are reported too for completeness.
// Read-only -- no Neon write. Run from the cdr-report editor; check the
// execution log. `DQE_BACKFILL_RESUME` (the failing index) gives a hint
// where to look, but this scans the whole sheet so it finds every offender.
function diagnoseDQELongValues() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet) { Logger.log('DQE: Sheet not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('DQE: Sheet is empty.'); return; }

  var data = sheet.getRange(2, 1, lastRow - 1, 34).getDisplayValues();   // REP-10: DQE schema is 34 cols (A-AH, INV-10); 36 threw on sheets trimmed to exactly the data width

  // field label -> { idx, limit } for the size-constrained dqe_history columns.
  var COLS = [
    { name: 'ttt',            idx: 8,  limit: 10 },
    { name: 'att',            idx: 9,  limit: 10 },
    { name: 'avg_abd_wait',   idx: 32, limit: 10 },
    { name: 'csr_avg_abd_wait', idx: 33, limit: 10 },
    { name: 'month_year',     idx: 0,  limit: 20 },
    { name: 'queue_extensions', idx: 3, limit: 60 }
  ];

  var offenders = {};
  COLS.forEach(function(c) { offenders[c.name] = []; });

  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    COLS.forEach(function(c) {
      var v = String(r[c.idx] == null ? '' : r[c.idx]);
      if (v.length > c.limit) {
        offenders[c.name].push({ row: i + 2, idx: i, len: v.length, val: v });
      }
    });
  }

  Logger.log('=== DQE long-value scan (' + data.length + ' rows) ===');
  var resume = PropertiesService.getScriptProperties().getProperty('DQE_BACKFILL_RESUME');
  if (resume) Logger.log('DQE_BACKFILL_RESUME = ' + resume + ' (T-8 fingerprinted pointer; its index is where the failing batch starts)');
  COLS.forEach(function(c) {
    var o = offenders[c.name];
    Logger.log(c.name + ' (varchar/limit ' + c.limit + '): ' + o.length + ' offender(s)');
    o.slice(0, 10).forEach(function(x) {
      Logger.log('  Sheet row ' + x.row + ' / data idx ' + x.idx +
        ' (len ' + x.len + '): "' + x.val + '"');
    });
  });
}


/**
 * R34. The parent upsert (INSERT ... ON CONFLICT DO UPDATE on uq_call_hist)
 * for one batch of sheet-shaped rows, factored out of backfillCDRHistory so
 * the missing-parents pass can reuse it verbatim. Bound params (agent names
 * + JSONB name lists are untrusted text); commits; returns the row count.
 */
function nbUpsertCdrParents_(conn, batch, hmacSecret) {
  // IMP-3 (the daily writer's rule): 300 rows/statement. A full 500-row
  // statement measured ~44 KB -- the Apps Script JDBC "Argument too large:
  // sql" cap -- and the R34 missing-parents pass can hand over an entire
  // 800-row scan batch when a whole stretch of dates is absent from Neon
  // (2026-09-08: it did, at index 14400). One commit after all chunks.
  var CDR_UPSERT_CHUNK_ROWS = 300;
  var total = 0;
  for (var off = 0; off < batch.length; off += CDR_UPSERT_CHUNK_ROWS) {
    total += nbUpsertCdrParentsChunk_(conn, batch.slice(off, off + CDR_UPSERT_CHUNK_ROWS), hmacSecret);
  }
  conn.commit();   // commit main so the phone id-lookup SELECT sees the rows
  return total;
}

/** One <=300-row INSERT ... ON CONFLICT DO UPDATE statement; no commit. */
function nbUpsertCdrParentsChunk_(conn, batch, hmacSecret) {
  var placeholderRow = '(?,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?,?,?,?)';
  var allPlaceholders = batch.map(function() { return placeholderRow; }).join(',');
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
    'ob_total = EXCLUDED.ob_total, ' +
    'ob_answered = EXCLUDED.ob_answered, ' +
    'ob_missed = EXCLUDED.ob_missed, ' +
    'ob_list_total_entries = EXCLUDED.ob_list_total_entries, ' +
    'ob_list_answered_entries = EXCLUDED.ob_list_answered_entries, ' +
    'ob_list_missed_entries = EXCLUDED.ob_list_missed_entries, ' +
    'ib_total = EXCLUDED.ib_total, ' +
    'ib_answered = EXCLUDED.ib_answered, ' +
    'ib_missed = EXCLUDED.ib_missed, ' +
    'ib_answered_internal = EXCLUDED.ib_answered_internal, ' +
    'ib_answered_external = EXCLUDED.ib_answered_external, ' +
    'ib_list_total_entries = EXCLUDED.ib_list_total_entries, ' +
    'ib_list_answered_entries = EXCLUDED.ib_list_answered_entries, ' +
    'ib_list_missed_entries = EXCLUDED.ib_list_missed_entries, ' +
    'ob_ext_total = EXCLUDED.ob_ext_total, ' +
    'ob_ext_answered = EXCLUDED.ob_ext_answered, ' +
    'ob_ext_ttt_sec = EXCLUDED.ob_ext_ttt_sec, ' +
    'ob_ext_att_sec = EXCLUDED.ob_ext_att_sec';

  var stmt = conn.prepareStatement(sql);
  var p = 1;
  for (var b = 0; b < batch.length; b++) {
    var row = batch[b];
    stmt.setString(p++, row.callDate);
    stmt.setString(p++, row.dept);
    stmt.setString(p++, row.agentName);
    stmt.setInt(p++,    parseInt(row.obTotal) || 0);
    stmt.setInt(p++,    parseInt(row.obAns)   || 0);
    stmt.setInt(p++,    parseInt(row.obMiss)  || 0);
    stmt.setString(p++, cdrParseNameFieldJson_(row.obListTot,  false, hmacSecret));
    stmt.setString(p++, cdrParseNameFieldJson_(row.obListAns,  false, hmacSecret));
    stmt.setString(p++, cdrParseNameFieldJson_(row.obListMiss, false, hmacSecret));
    stmt.setInt(p++,    parseInt(row.ibTotal)  || 0);
    stmt.setInt(p++,    parseInt(row.ibAns)    || 0);
    stmt.setInt(p++,    parseInt(row.ibMiss)   || 0);
    stmt.setInt(p++,    parseInt(row.ibAnsInt) || 0);
    stmt.setInt(p++,    parseInt(row.ibAnsExt) || 0);
    stmt.setString(p++, cdrParseNameFieldJson_(row.ibListTot,  false, hmacSecret));
    stmt.setString(p++, cdrParseNameFieldJson_(row.ibListAns,  false, hmacSecret));
    stmt.setString(p++, cdrParseNameFieldJson_(row.ibListMiss, false, hmacSecret));
    stmt.setInt(p++,    parseInt(row.obExtTotal) || 0);
    stmt.setInt(p++,    parseInt(row.obExtAns)   || 0);
    stmt.setInt(p++,    cdrTimeToSeconds_(row.obExtTTT));
    stmt.setInt(p++,    cdrTimeToSeconds_(row.obExtATT));
  }
  stmt.execute();
  var affected = stmt.getUpdateCount();
  stmt.close();
  return (affected >= 0 ? affected : batch.length);
}

// ── R33: phones-only refill (Operator State #57 step B) ────────────────────
//
// After `TRUNCATE call_history_phones` the PARENT rows (call_history_dept)
// still exist, so the refill needs no main upsert at all: for each sheet row
// dated before CDR_BACKFILL_BEFORE, look the parent up and re-create its
// phone children. Two things make this fast where backfillCDRHistory was
// five minutes per 50 rows:
//   (1) parent ids come from ONE json_agg query per batch's dates (zero
//       binds; one rs.getString), not a 3-bind-per-row lookup;
//   (2) the children go in as inline literals via cdrInsertPhoneChildRows_
//       (zero binds per row).
// Resumable via CDR_PHONES_BACKFILL_RESUME (the T-8 fingerprinted pointer);
// honors CDR_BACKFILL_BEFORE; skips rows with no phone cells (nothing to
// re-create); a batch's idMap is filtered to the batch's own rows so the
// helper's per-parent delete never touches a parent this batch does not
// carry. Run from the cdr-report editor until it logs "complete".
var NB_PHONES_BATCH_ROWS_ = 400;

function backfillCDRPhonesOnly() {
  var hmacSecret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!hmacSecret) {
    Logger.log('CDR phones refill ABORTED: HMAC_SECRET is not set (same value as the import project).');
    return;
  }
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CDR Historical Data');
  if (!sheet) { Logger.log('CDR phones refill: sheet not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('CDR phones refill: sheet is empty.'); return; }
  var data = sheet.getRange(2, 1, lastRow - 1, 26).getDisplayValues();

  var props = PropertiesService.getScriptProperties();
  var RESUME_KEY = 'CDR_PHONES_BACKFILL_RESUME';
  var startIndex = nbResumeRead_(props, RESUME_KEY, data, NB_CDR_KEY_COLS_);
  var ceilingIso = String(props.getProperty('CDR_BACKFILL_BEFORE') || '').trim();
  if (ceilingIso && !/^\d{4}-\d{2}-\d{2}$/.test(ceilingIso)) {
    Logger.log('CDR phones refill ABORTED: CDR_BACKFILL_BEFORE must be yyyy-mm-dd, got "' + ceilingIso + '".');
    return;
  }
  Logger.log('CDR phones refill: starting at index ' + startIndex + ' of ' + data.length
    + (ceilingIso ? ' (ceiling ' + ceilingIso + ')' : ''));
  if (startIndex >= data.length) {
    Logger.log('CDR phones refill complete. Clear ' + RESUME_KEY + ' to re-run.');
    return;
  }
  CDR_HMAC_CACHE_ = {};
  var TIME_LIMIT_MS = 240000, startTime = Date.now();
  var totalPhones = 0, totalRows = 0, skippedCeiling = 0, skippedNoPhones = 0, i = startIndex;
  try {
    while (i < data.length) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        nbResumeWrite_(props, RESUME_KEY, i, data, NB_CDR_KEY_COLS_);
        Logger.log('Time limit reached. Resume saved at index ' + i + '. Phone rows so far this run: '
          + totalPhones + ' over ' + totalRows + ' parent rows. Run again to continue.');
        return;
      }
      var batchStartIdx = i;
      var batch = [];
      var batchEnd = Math.min(i + NB_PHONES_BATCH_ROWS_, data.length);
      while (i < batchEnd) {
        var r = data[i]; i++;
        if (!r[2] || !r[4]) continue;
        var iso = parseDateForNeon(r[2]);
        if (!iso) continue;
        if (ceilingIso && iso >= ceilingIso) { skippedCeiling++; continue; }
        var hasPhones = (r[23] && String(r[23]).trim()) || (r[24] && String(r[24]).trim()) || (r[25] && String(r[25]).trim());
        if (!hasPhones) { skippedNoPhones++; continue; }
        batch.push({ callDate: iso, dept: r[3] || 'Unassigned', agentName: r[4],
                     phonesX: r[23], phonesY: r[24], phonesZ: r[25] });
      }
      if (!batch.length) continue;

      var conn = getNeonConn_backfill();
      conn.setAutoCommit(false);
      try {
        var dates = {};
        batch.forEach(function (b0) { dates[b0.callDate] = true; });
        var fullMap = nbCdrParentIdMapForDates_(conn, Object.keys(dates));
        // Only this batch's parents: the helper deletes children for every
        // id in the map before re-inserting.
        var idMap = {};
        batch.forEach(function (b0) {
          var k = nbCdrKey_(b0.callDate, b0.dept, b0.agentName);
          if (fullMap[k] != null) idMap[k] = fullMap[k];
        });
        var n = cdrInsertPhoneChildRows_(conn, batch, hmacSecret, { idMap: idMap });
        totalPhones += n; totalRows += batch.length;
        Logger.log('CDR phones refill: batch ending at index ' + i + ' -> ' + n + ' phone rows for '
          + batch.length + ' parent rows (' + Object.keys(idMap).length + ' parents found). Cumulative: ' + totalPhones);
      } catch (e) {
        try { conn.rollback(); } catch (re) {}
        nbResumeWrite_(props, RESUME_KEY, batchStartIdx, data, NB_CDR_KEY_COLS_);
        Logger.log('CDR phones refill batch failed, rolled back. Resume at ' + batchStartIdx + '. Error: ' + e.message);
        throw e;
      } finally {
        try { conn.close(); } catch (ce) {}
      }
    }
    props.deleteProperty(RESUME_KEY);
    Logger.log('CDR phones refill complete. Phone rows: ' + totalPhones + ' over ' + totalRows
      + ' parent rows; skipped ' + skippedNoPhones + ' row(s) with no phone cells'
      + (ceilingIso ? ', ' + skippedCeiling + ' at/after ' + ceilingIso : '') + '.');
  } catch (e) {
    Logger.log('CDR phones refill stopped. Error: ' + e.message);
    throw e;
  }
}

/** R33. The cdrKeyPart_ convention (neonWrite.js): null -> '<null>'. */
function nbCdrKey_(d, dept, agent) {
  var part = function (x) { return x == null ? '<null>' : String(x); };
  return part(d) + '|' + part(dept) + '|' + part(agent);
}

/**
 * R33. Parent ids for whole dates in ONE zero-bind query: json_agg of
 * {id, d, dept, a} fetched with a single rs.getString (the F1 rule --
 * per-row rs.getXXX is the slow path). Dates are regex-validated ISO
 * literals, so inlining them is injection-safe.
 */
function nbCdrParentIdMapForDates_(conn, isoDates) {
  var lits = (isoDates || []).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d)); })
    .map(function (d) { return "'" + d + "'::date"; });
  var map = {};
  if (!lits.length) return map;
  var stmt = conn.createStatement();
  var rs = stmt.executeQuery(
    "SELECT COALESCE(json_agg(json_build_object('id', id, 'd', call_date::text, 'dept', department, 'a', agent_name)), '[]')::text AS j "
    + 'FROM call_history_dept WHERE call_date IN (' + lits.join(',') + ')');
  var json = rs.next() ? rs.getString(1) : '[]';
  rs.close(); stmt.close();
  var arr = [];
  try { arr = JSON.parse(json || '[]') || []; } catch (e) { arr = []; }
  for (var i = 0; i < arr.length; i++) {
    var pid = parseInt(arr[i].id, 10);
    if (isFinite(pid)) map[nbCdrKey_(arr[i].d, arr[i].dept, arr[i].a)] = pid;
  }
  return map;
}


// ── R34: fill the parent gap (rows in the sheet with NO call_history_dept row) ─
//
// The R33 refill found 62 sheet rows whose (date, dept, agent) parent did not
// exist in Neon -- a day the CDR mirror skipped. Neither the fingerprinted
// resume pointer nor the 30-day coverage window is a good way to reach such
// rows by hand, so this pass finds them itself: it walks the whole sheet in
// date-batches, fetches each batch's parents with the zero-bind json_agg
// lookup, collects the rows with no parent, upserts ONLY those parents
// (nbUpsertCdrParents_, 21 binds/row -- fine for a few dozen rows) and then
// re-creates their phone children, honoring CDR_BACKFILL_BEFORE for the
// children only (parents are wanted for every date; post-capture phone rows
// are retired). Read-mostly: a clean sheet writes nothing. Logs the dates it
// found gaps on. Resumable via CDR_MISSING_BACKFILL_RESUME.
var NB_MISSING_SCAN_ROWS_ = 800;

function backfillCDRMissingParents() {
  var hmacSecret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!hmacSecret) {
    Logger.log('CDR missing-parents pass ABORTED: HMAC_SECRET is not set (same value as the import project).');
    return;
  }
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CDR Historical Data');
  if (!sheet) { Logger.log('CDR missing-parents pass: sheet not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('CDR missing-parents pass: sheet is empty.'); return; }
  var data = sheet.getRange(2, 1, lastRow - 1, 26).getDisplayValues();

  var props = PropertiesService.getScriptProperties();
  var RESUME_KEY = 'CDR_MISSING_BACKFILL_RESUME';
  var startIndex = nbResumeRead_(props, RESUME_KEY, data, NB_CDR_KEY_COLS_);
  var ceilingIso = String(props.getProperty('CDR_BACKFILL_BEFORE') || '').trim();
  if (ceilingIso && !/^\d{4}-\d{2}-\d{2}$/.test(ceilingIso)) {
    Logger.log('CDR missing-parents pass ABORTED: CDR_BACKFILL_BEFORE must be yyyy-mm-dd, got "' + ceilingIso + '".');
    return;
  }
  Logger.log('CDR missing-parents pass: starting at index ' + startIndex + ' of ' + data.length
    + (ceilingIso ? ' (phone children only before ' + ceilingIso + ')' : ''));
  if (startIndex >= data.length) {
    Logger.log('CDR missing-parents pass complete. Clear ' + RESUME_KEY + ' to re-run.');
    return;
  }
  CDR_HMAC_CACHE_ = {};
  var TIME_LIMIT_MS = 240000, startTime = Date.now();
  var scanned = 0, filledParents = 0, filledPhones = 0, gapDates = {}, i = startIndex;
  try {
    while (i < data.length) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        nbResumeWrite_(props, RESUME_KEY, i, data, NB_CDR_KEY_COLS_);
        Logger.log('Time limit reached. Resume saved at index ' + i + '. So far: ' + filledParents
          + ' parent(s) filled, ' + filledPhones + ' phone rows, gap dates: '
          + (Object.keys(gapDates).sort().join(', ') || 'none') + '. Run again to continue.');
        return;
      }
      var batchStartIdx = i;
      var rows = [];
      var batchEnd = Math.min(i + NB_MISSING_SCAN_ROWS_, data.length);
      while (i < batchEnd) {
        var r = data[i]; i++;
        if (!r[2] || !r[4]) continue;
        var iso = parseDateForNeon(r[2]);
        if (!iso) continue;
        rows.push({
          callDate:   iso,
          dept:       r[3] || 'Unassigned',
          agentName:  r[4],
          obTotal:    r[5],  obAns:     r[6],  obMiss:     r[7],
          obListTot:  r[8],  obListAns: r[9],  obListMiss: r[10],
          ibTotal:    r[11], ibAns:     r[12], ibMiss:     r[13],
          ibAnsInt:   r[14], ibAnsExt:  r[15],
          ibListTot:  r[16], ibListAns: r[17], ibListMiss: r[18],
          obExtTotal: r[19], obExtAns:  r[20],
          obExtTTT:   r[21], obExtATT:  r[22],
          phonesX:    r[23], phonesY:   r[24], phonesZ:    r[25]
        });
      }
      scanned += rows.length;
      if (!rows.length) continue;

      var conn = getNeonConn_backfill();
      conn.setAutoCommit(false);
      try {
        var dates = {};
        rows.forEach(function (b0) { dates[b0.callDate] = true; });
        var have = nbCdrParentIdMapForDates_(conn, Object.keys(dates));
        // P10 dedup (last write wins) on the conflict key, then keep only
        // the rows with no parent.
        var seen = {}, missing = [];
        for (var d = rows.length - 1; d >= 0; d--) {
          var k = nbCdrKey_(rows[d].callDate, rows[d].dept, rows[d].agentName);
          if (seen[k]) continue;
          seen[k] = true;
          if (have[k] == null) missing.push(rows[d]);
        }
        missing.reverse();
        if (missing.length) {
          missing.forEach(function (m0) { gapDates[m0.callDate] = (gapDates[m0.callDate] || 0) + 1; });
          filledParents += nbUpsertCdrParents_(conn, missing, hmacSecret);
          var phoneRows = missing.filter(function (m0) {
            return (!ceilingIso || m0.callDate < ceilingIso)
              && ((m0.phonesX && String(m0.phonesX).trim()) || (m0.phonesY && String(m0.phonesY).trim())
                  || (m0.phonesZ && String(m0.phonesZ).trim()));
          });
          if (phoneRows.length) {
            // Re-fetch the ids the upsert just created (zero-bind) so the
            // helper skips its bound lookup, and scope them to these rows.
            var pdates = {};
            phoneRows.forEach(function (m0) { pdates[m0.callDate] = true; });
            var nowHave = nbCdrParentIdMapForDates_(conn, Object.keys(pdates));
            var idMap = {};
            phoneRows.forEach(function (m0) {
              var pk = nbCdrKey_(m0.callDate, m0.dept, m0.agentName);
              if (nowHave[pk] != null) idMap[pk] = nowHave[pk];
            });
            filledPhones += cdrInsertPhoneChildRows_(conn, phoneRows, hmacSecret, { idMap: idMap });
          }
          Logger.log('CDR missing-parents pass: batch ending at index ' + i + ' -> ' + missing.length
            + ' parent(s) filled on ' + Object.keys(dates).filter(function (dd) { return gapDates[dd]; }).sort().join(', '));
        }
      } catch (e) {
        try { conn.rollback(); } catch (re) {}
        nbResumeWrite_(props, RESUME_KEY, batchStartIdx, data, NB_CDR_KEY_COLS_);
        Logger.log('CDR missing-parents batch failed, rolled back. Resume at ' + batchStartIdx + '. Error: ' + e.message);
        throw e;
      } finally {
        try { conn.close(); } catch (ce) {}
      }
    }
    props.deleteProperty(RESUME_KEY);
    var gapList = Object.keys(gapDates).sort().map(function (dd) { return dd + ' (' + gapDates[dd] + ')'; });
    Logger.log('CDR missing-parents pass complete. Scanned ' + scanned + ' rows; filled ' + filledParents
      + ' parent(s) + ' + filledPhones + ' phone rows. Gap dates: ' + (gapList.join(', ') || 'none') + '.');
  } catch (e) {
    Logger.log('CDR missing-parents pass stopped. Error: ' + e.message);
    throw e;
  }
}
