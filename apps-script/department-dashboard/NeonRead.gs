/**
 * Neon READ layer (Phase 3 / F1 read-back -- step 1).
 *
 * The dashboard has always read DQE metrics from the `DQE Historical Data`
 * sheet (re-scanning the whole sheet per request -- the F1 scaling cliff).
 * This file is the first, ADDITIVE, fully-reversible step toward reading
 * from Neon's `dqe_history` instead:
 *
 *   - `getDqeReadSource_()`  -- the cutover switch (Script Property
 *       `DQE_READ_SOURCE` = 'sheet' (default) | 'neon'). Every DQE reader is
 *       cut over (Operator State #19): 'neon' serves the dashboard from
 *       dqe_history with per-reader sheet fallback. Default 'sheet' keeps the
 *       legacy behavior.
 *
 *       B-2: this file claimed "ALL DQE readers are cut over" for a while
 *       BEFORE it was true -- `Alerts.gs::alertRowsForDate_`,
 *       `Digest.gs::computeDigestWowDriver_` and `OrphanFix.gs::computeOrphans_`
 *       still read the sheet directly, and the claim is the sort that justifies
 *       trimming the sheet. The alert one was the dangerous member: a
 *       present-but-aged sheet returns zero rows for yesterday, so every dept
 *       logs `no-data` and the low-answer-rate alerts stop firing with a
 *       plausible-looking Alert Log. All three now route through
 *       neonFetchDqeRows_ + neonDqeRowsUsable_ with the same sheet fallback.
 *       If you add a NEW DQE reader, cut it over in the same commit -- an
 *       uncut reader is invisible until the sheet ages out from under it.
 *   - `neonFetchDqeRows_(from, to)` / `sheetFetchDqeRows_(from, to)` --
 *       symmetric DAL primitives that return per-(date, agent) DQE rows in
 *       the SAME normalized shape from each source, so they can be diffed
 *       and (later) swapped behind the flag.
 *   - `compareDqeSources_()` -- editor-run parity diagnostic. Reads a date
 *       range from BOTH sources and reports row-count + value mismatches.
 *       This is the GATE for the read-back: when it shows 0 missing-in-Neon
 *       and 0 value mismatches over a representative range, `dqe_history`
 *       is trustworthy to read from.
 *
 * Requires (already set for orphan-rename-to-Neon): the dashboard project's
 * NEON_HOST/NEON_DB/NEON_USER/NEON_PASS Script Properties + the
 * `script.external_request` OAuth scope. Reads sidestep the INV-02 duration
 * TZ gotcha entirely: Neon stores ttt/att/abd-wait as the same H:MM:SS
 * strings the sheet DISPLAYS, so both sources parse via `parseHmsDisplay_`.
 */

/**
 * Cutover switch. 'neon' only when the Script Property is explicitly set;
 * anything else (incl. unset) => 'sheet'. Consumed by every cut-over DQE
 * reader (Operator State #19).
 */
function getDqeReadSource_() {
  var v = String(PropertiesService.getScriptProperties()
                   .getProperty('DQE_READ_SOURCE') || 'sheet').toLowerCase().trim();
  return v === 'neon' ? 'neon' : 'sheet';
}

/**
 * Opens a Neon connection from the dashboard project's NEON_* properties.
 * Returns null (logged) when unconfigured or unreachable -- callers treat
 * null as "fall back to the sheet". Caller owns closing it.
 */
function getDashboardNeonConn_(opts) {
  var p = PropertiesService.getScriptProperties();
  var host = p.getProperty('NEON_HOST');
  if (!host) { Logger.log('getDashboardNeonConn_: NEON_HOST not set.'); return null; }
  try {
    var url = 'jdbc:postgresql://' + host + '/' + p.getProperty('NEON_DB');
    return Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS'));
  } catch (e) {
    Logger.log('getDashboardNeonConn_ failed: ' + (e && e.message ? e.message : e));
    // F4/NEO-3: a hard connection failure (unreachable != unconfigured) is
    // recorded durably ONLY for the DQE read-back readers -- they opt in via
    // {recordReadHealth:true}. Recording used to be the DEFAULT (with F29
    // carving out just the keep-warm ping via skipReadHealth), so every
    // OTHER Neon surface (Inbound report/heatmap, Caller Lookup, escalation
    // writes, config readers) fed NEON_READ_LAST_ERROR too -- and since only
    // the DQE readers CLEAR it, one transient non-DQE blip pinned a sticky
    // false "read-back FAILING" line while reads were on the sheet. The
    // signal now reflects DQE reads only, as Operator State #20 documents.
    // ({skipReadHealth:true} is still accepted as a no-op for old callers.)
    if (opts && opts.recordReadHealth) recordNeonReadFailure_('getDashboardNeonConn_', e);
    return null;
  }
}

/**
 * MAX(call_date) from dqe_history as a 'yyyy-MM-dd' string, or null on
 * no data / unreachable / error. One indexed query vs a whole-column
 * sheet scan -- the F1 read-back's cheapest win. Best-effort: callers
 * treat null as "fall back to the sheet".
 */
function neonGetMaxDqeDate_(conn) {
  // Shared-connection support (SystemHealth single-conn): with a conn PASSED we
  // reuse it and DON'T touch the read-health signal -- a shared conn comes from
  // a health PROBE, not a real DQE read, so it must not feed/clear the DQE-only
  // NEON_READ_LAST_ERROR line (NEO-3). With NO conn (getLatestDataDate, the
  // Alerts mirror-health) we open + close our own AND record/clear as a real
  // DQE read-back reader does.
  var ownConn = !conn;
  if (ownConn) conn = getDashboardNeonConn_({ recordReadHealth: true });   // NEO-3: DQE reader
  if (!conn) return null;
  try {
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery('SELECT MAX(call_date)::text AS d FROM dqe_history');
    var d = rs.next() ? rs.getString('d') : null;
    rs.close(); stmt.close();
    if (ownConn) clearNeonReadFailure_();   // F4: reachable -> reset the failure streak
    return d ? String(d).trim() : null;
  } catch (e) {
    Logger.log('neonGetMaxDqeDate_ failed: ' + (e && e.message ? e.message : e));
    if (ownConn) recordNeonReadFailure_('neonGetMaxDqeDate_', e);
    return null;
  } finally {
    if (ownConn) { try { conn.close(); } catch (ce) {} }
  }
}

/** MIN(call_date) twin of neonGetMaxDqeDate_ -- the R12-26 coverage-start
 * signal for the latestDates blob. Own-connection only; same NEO-3
 * read-health recording as a real DQE read-back reader. */
function neonGetMinDqeDate_() {
  var conn = getDashboardNeonConn_({ recordReadHealth: true });
  if (!conn) return null;
  try {
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery('SELECT MIN(call_date)::text AS d FROM dqe_history');
    var d = rs.next() ? rs.getString('d') : null;
    rs.close(); stmt.close();
    clearNeonReadFailure_();
    return d ? String(d).trim() : null;
  } catch (e) {
    Logger.log('neonGetMinDqeDate_ failed: ' + (e && e.message ? e.message : e));
    recordNeonReadFailure_('neonGetMinDqeDate_', e);
    return null;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

/**
 * Normalized DQE row shape (both fetchers return this), keyed downstream
 * on (dateIso, agent):
 *   { dateIso, agent, monthYear, queueExt,
 *     totalUnique, totalRung, totalMissed, totalAnswered,
 *     tttSec, attSec, avgAbdWaitSec, csrAvgAbdWaitSec }
 * Durations are SECONDS (parsed via parseHmsDisplay_) so the two sources
 * compare regardless of string formatting. Scope: the core metric columns
 * used by computeSummary_ / IR / PR / CR; the Missed-report slot + abandoned
 * -ID columns are a follow-on (Phase 3.2) and intentionally not fetched here.
 */

/**
 * Distinct (agent_name, queue_extensions) pairs across ALL of dqe_history,
 * for the getDeptQueueExts_ DERIVED path. Replaces a whole-sheet cols-A..D
 * scan when DQE_READ_SOURCE=neon: Postgres collapses the ~16k+ rows to the
 * handful of distinct (agent, ext-string) pairs each agent has ever used,
 * aggregated to ONE json string (json_agg) so it's a single rs.getString
 * (same anti-per-row-JDBC discipline as neonFetchDqeRows_). Small result,
 * so it's cached REPORT_CACHE_TTL_SECONDS (changes only when the daily
 * ingest adds a new ext, or an orphan rename lands). Returns an array of
 * { agent_name, queue_extensions } or null on no-conn/error (caller falls
 * back to the cheap sheet read).
 */
function neonGetAgentExtPairs_() {
  var cache = CacheService.getScriptCache();
  var KEY = 'neonAgentExts:v1';
  var hit = cache.get(KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* recompute */ } }
  var conn = getDashboardNeonConn_({ recordReadHealth: true });   // NEO-3: DQE reader
  if (!conn) return null;
  try {
    var sql = "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
            + "SELECT DISTINCT agent_name, queue_extensions FROM dqe_history "
            + "WHERE queue_extensions IS NOT NULL AND queue_extensions <> '') t";
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery(sql);
    var json = rs.next() ? rs.getString('j') : '[]';
    neonNoteEgress_(json ? json.length : 0);   // F5: meter the read
    rs.close(); stmt.close();
    var arr = JSON.parse(json || '[]');
    try { cache.put(KEY, json, REPORT_CACHE_TTL_SECONDS); } catch (ce) { /* harmless */ }
    clearNeonReadFailure_();   // F4: a successful read (even empty) means Neon is healthy
    return arr;
  } catch (e) {
    // F4: record a hard error durably + distinctly so it isn't mistaken
    // for an unconfigured/empty result when the caller falls back to the sheet.
    Logger.log('neonGetAgentExtPairs_ failed: ' + (e && e.message ? e.message : e));
    recordNeonReadFailure_('neonGetAgentExtPairs_', e);
    return null;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// The 19 slot columns (sheet cols K..AC) in order, as written by
// cdr-import's writeDQERowsToNeon. Used by the includeMissedDetail
// fetch below; the order MUST mirror HISTORICAL_COLS.TIME_SLOTS_START..
// TIME_SLOTS_END so the Missed Calls grid adapter can map positionally.
var NEON_DQE_SLOT_COLS = [
  'slot_0800_0830', 'slot_0830_0900', 'slot_0900_0930', 'slot_0930_1000',
  'slot_1000_1030', 'slot_1030_1100', 'slot_1100_1130', 'slot_1130_1200',
  'slot_1200_1230', 'slot_1230_1300', 'slot_1300_1330', 'slot_1330_1400',
  'slot_1400_1430', 'slot_1430_1500', 'slot_1500_1530', 'slot_1530_1600',
  'slot_1600_1630', 'slot_1630_1700', 'slot_1700_1730',
];

/**
 * Reads dqe_history for [fromIso, toIso] (inclusive). Returns [] on no conn.
 * `opts.includeMissedDetail` additionally selects the 19 slot columns +
 * abandoned_parent_ids + abandoned_missed_times (the Missed Calls reader's
 * inputs); each row then carries `slots` (string[19], positional K..AC),
 * `abandonedParentIds`, and `abandonedMissedTimes`. With opts absent the
 * SQL and row shape are byte-identical to the pre-DAL-cutover behavior,
 * so the existing cut-over readers are untouched.
 *
 * R24 (owner: "the IR takes a long time to load"): `opts.agents` (string[])
 * adds `AND agent_name IN (?...)` so a single-dept reader over the 12-month
 * trend window fetches ONE dept's agents instead of every dept's rows
 * (~14x less JSON to build, ship, and parse -- the whole-window fetch was
 * the IR's dominant cost). Names bind as prepared-statement params (INV-04
 * exact-match semantics; the caller supplies roster + selection names).
 * An empty/oversized (>300) list skips the filter -- never a wrong result,
 * just the old full fetch.
 */
function neonFetchDqeRows_(fromIso, toIso, opts) {
  var includeMissedDetail = !!(opts && opts.includeMissedDetail);
  var agentFilter = (opts && Array.isArray(opts.agents) && opts.agents.length > 0
                     && opts.agents.length <= 300) ? opts.agents : null;
  var conn = getDashboardNeonConn_({ recordReadHealth: true });   // NEO-3: DQE reader
  if (!conn) return [];
  var out = [];
  try {
    // PERF: Apps Script JDBC iterates a ResultSet one CELL at a time, which
    // is catastrophically slow over the thousands of rows the IR/PR 12-month
    // trend window (and CR's year-over-year window) pull -- ~0.5s/row, so a
    // year of data is 20+ minutes. Aggregate the entire result set into ONE
    // json string server-side (json_agg) and fetch it with a SINGLE
    // rs.getString, instead of ~12 getXXX calls per row. Turns ~150k JDBC
    // round-trips into 1. Order is irrelevant -- downstream maps by
    // (date, agent). COALESCE so an empty range returns '[]' not null.
    // R24 egress (owner: Neon monthly transfer cap): POSITIONAL arrays, not
    // keyed objects -- json_agg(t) repeated every column NAME on every row
    // (~120B/row of pure key overhead, ~half the payload on the metric
    // columns). The array position protocol is fixed: base cols 0..12 in the
    // SELECT order below (queue_split ALWAYS occupies slot 12 -- when skipped
    // it selects '' so positions never shift), detail cols 13..33 when
    // requested. The parse loop below and the dal-cutover test fixture are
    // the two mirrors of this order.
    var detailCols = includeMissedDetail
      ? ', ' + NEON_DQE_SLOT_COLS.join(', ') + ', abandoned_parent_ids, abandoned_missed_times'
      : '';
    // R24 egress: the per-row queue_split JSON is dead weight while
    // QUEUE_SPLIT_SCOPE is off (applyQueueSplitToRows_ no-ops and every
    // consumer's cache key carries the scope suffix), so select '' instead
    // of the stored JSON unless the scope is 'dept' or the caller forces it
    // (compareDqeSources_ passes withQueueSplit so the parity gate always
    // certifies the real column). COALESCE so a pre-Phase-1 NULL reads as ''
    // and takes the fail-open path either way.
    var wantSplit = !!(opts && opts.withQueueSplit);
    try {
      if (!wantSplit && typeof getQueueSplitScope_ === 'function') {
        wantSplit = getQueueSplitScope_() === 'dept';
      }
    } catch (eQs) { wantSplit = true; }   // unreadable scope -> fetch it (never lose data)
    var splitExpr = wantSplit ? "COALESCE(queue_split, '')" : "''";
    var sql = "SELECT COALESCE(json_agg(json_build_array("
            + "month_year, call_date::text, agent_name, queue_extensions, "
            + "total_unique, total_rung, total_missed, total_answered, "
            + "ttt, att, avg_abd_wait, csr_avg_abd_wait, "
            + splitExpr + detailCols + ")), '[]')::text AS j "
            + "FROM dqe_history WHERE call_date BETWEEN ?::date AND ?::date"
            + (agentFilter
               ? ' AND agent_name IN (' + agentFilter.map(function () { return '?'; }).join(',') + ')'
               : '');
    var stmt = conn.prepareStatement(sql);
    stmt.setString(1, fromIso);
    stmt.setString(2, toIso);
    if (agentFilter) {
      for (var ai = 0; ai < agentFilter.length; ai++) {
        stmt.setString(3 + ai, String(agentFilter[ai]));
      }
    }
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    // F5: this single json_agg string IS the dominant DQE read cost (the whole
    // point of the R24 egress round), so metering it here covers most of what
    // the transfer cap actually counts. Best-effort, post-fetch, never gates
    // the parse below.
    neonNoteEgress_(json ? json.length : 0);
    var arr = JSON.parse(json || '[]');
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];   // positional array -- see the protocol comment above
      var agent = String(r[2] == null ? '' : r[2]).trim();
      if (!agent) continue;
      var row = {
        dateIso:          String(r[1] == null ? '' : r[1]).trim(),
        agent:            agent,
        monthYear:        String(r[0] == null ? '' : r[0]).trim(),
        queueExt:         String(r[3] == null ? '' : r[3]).trim(),
        totalUnique:      Number(r[4]) || 0,
        totalRung:        Number(r[5]) || 0,
        totalMissed:      Number(r[6]) || 0,
        totalAnswered:    Number(r[7]) || 0,
        tttSec:           parseHmsDisplay_(r[8]),
        attSec:           parseHmsDisplay_(r[9]),
        avgAbdWaitSec:    parseHmsDisplay_(r[10]),
        csrAvgAbdWaitSec: parseHmsDisplay_(r[11]),
        queueSplit:       String(r[12] == null ? '' : r[12]).trim(),
      };
      if (includeMissedDetail) {
        row.slots = NEON_DQE_SLOT_COLS.map(function (c, si) {
          var v = r[13 + si];
          return String(v == null ? '' : v).trim();
        });
        row.abandonedParentIds   = String(r[13 + NEON_DQE_SLOT_COLS.length]     == null ? '' : r[13 + NEON_DQE_SLOT_COLS.length]).trim();
        row.abandonedMissedTimes = String(r[13 + NEON_DQE_SLOT_COLS.length + 1] == null ? '' : r[13 + NEON_DQE_SLOT_COLS.length + 1]).trim();
      }
      out.push(row);
    }
    clearNeonReadFailure_();   // F4: a successful read (even empty) means Neon is healthy
    // LM2: mark the array REACHABLE so a consumer can tell a healthy-but-empty
    // read (trust it, serve empty) from an unreachable/errored one (fall back
    // to the sheet). Without this, both returned [] and every consumer ran a
    // redundant whole-sheet scan on a genuinely-empty window. Only the SUCCESS
    // path sets it; the !conn early return + the catch (out=[]) leave it unset,
    // so those still fall back. Aligns with the DQE_READ_SOURCE=neon contract
    // (trust a reachable Neon; the sheet is the ERROR fallback, not a second
    // guess of an empty result). Read in-process only -- consumers adapt these
    // rows into their payload, never serialize the array itself.
    out._neonReachable = true;
  } catch (e) {
    // F4: a hard error here (SQL / JSON-parse failure) is recorded
    // durably + distinctly so it isn't mistaken for a legitimately
    // empty range when the cut-over reader falls back to the sheet.
    Logger.log('neonFetchDqeRows_ failed: ' + (e && e.message ? e.message : e));
    recordNeonReadFailure_('neonFetchDqeRows_', e);
    // L11: if the failure came mid-loop (e.g. an unparseable duration on row i),
    // `out` holds a TRUNCATED set. Returning it would let a cut-over reader
    // treat partial data as authoritative and skip the sheet fallback (a
    // silently under-counted report). Discard the partial so callers see []
    // and fall back to the sheet, matching the connection/SQL/parse failure
    // paths (which return an empty out).
    out = [];
  } finally {
    try { conn.close(); } catch (ce) {}
  }
  return out;
}

/**
 * LM2: should a cut-over reader USE a neonFetchDqeRows_ result, or fall back to
 * the sheet? Use it when it has rows OR when it's a reachable-but-empty read
 * (`_neonReachable`, a genuinely-empty window -- serving empty is correct and
 * skips the redundant whole-sheet scan). Fall back only when it's `[]` WITHOUT
 * the marker (unreachable / errored / partial-discarded).
 */
function neonDqeRowsUsable_(rows) {
  return !!(rows && (rows.length || rows._neonReachable));
}

/**
 * Reads DQE Historical Data (the sheet) for [fromIso, toIso] into the same
 * normalized shape as neonFetchDqeRows_. Uses getDisplayValues() for the
 * duration columns (INV-02). Includes queue-sentinel rows (Neon mirrors
 * them too), so the parity comparison is faithful.
 *
 * F2: `opts.includeMissedDetail` additionally returns the 19 slot columns
 * (K..AC) + abandoned_parent_ids (AD) + abandoned_missed_times (AF) as DISPLAY
 * strings, mirroring neonFetchDqeRows_'s includeMissedDetail shape -- so the
 * parity gate can certify the Missed-Calls Neon reader's inputs (previously
 * uncovered). With opts absent the shape is byte-identical to before, so the
 * existing parity comparison + any other caller is unaffected.
 */
function sheetFetchDqeRows_(fromIso, toIso, opts) {
  var includeMissedDetail = !!(opts && opts.includeMissedDetail);
  var ss = openSpreadsheet_();
  var sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var ssTZ = ss.getSpreadsheetTimeZone();
  // Phase 2 widened this to col AI, clamped to the sheet's real width because a
  // getRange past getMaxColumns THROWS (REP-10) and the sheet is 34 wide until
  // the Phase 1 pipeline runs against it.
  var numCols = Math.min(HISTORICAL_COLS.QUEUE_SPLIT, sheet.getMaxColumns());
  var range = sheet.getRange(2, 1, lastRow - 1, numCols);
  var values = range.getValues();
  var displays = range.getDisplayValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i], rd = displays[i];
    var dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < fromIso || dateIso > toIso) continue;
    var agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;
    var row = {
      dateIso:          dateIso,
      agent:            agent,
      monthYear:        String(r[HISTORICAL_COLS.MONTH_YEAR - 1] || '').trim(),
      queueExt:         String(r[HISTORICAL_COLS.QUEUE_EXT - 1] || '').trim(),
      totalUnique:      Number(r[HISTORICAL_COLS.TOTAL_UNIQUE - 1])   || 0,
      totalRung:        Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0,
      totalMissed:      Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0,
      totalAnswered:    Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
      tttSec:           parseHmsDisplay_(rd[HISTORICAL_COLS.TTT - 1]),
      attSec:           parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]),
      avgAbdWaitSec:    parseHmsDisplay_(rd[HISTORICAL_COLS.AVG_ABD_WAIT - 1]),
      csrAvgAbdWaitSec: parseHmsDisplay_(rd[HISTORICAL_COLS.CSR_AVG_ABD_WAIT - 1]),
      // Sub-queue Phase 2: kept SYMMETRIC with neonFetchDqeRows_ so the two DAL
      // primitives return the same shape and compareDqeSources_ stays faithful.
      queueSplit:       String(rd[HISTORICAL_COLS.QUEUE_SPLIT - 1] || '').trim(),
    };
    if (includeMissedDetail) {
      // Slots K..AC + abandoned IDs/times as DISPLAY strings (TZ-safe per INV-02;
      // Neon stores the same display strings, so a string diff is faithful).
      var slots = [];
      for (var s = HISTORICAL_COLS.TIME_SLOTS_START; s <= HISTORICAL_COLS.TIME_SLOTS_END; s++) {
        slots.push(String(rd[s - 1] == null ? '' : rd[s - 1]).trim());
      }
      row.slots = slots;
      row.abandonedParentIds   = String(rd[HISTORICAL_COLS.ABANDONED_PARENT_IDS - 1]   == null ? '' : rd[HISTORICAL_COLS.ABANDONED_PARENT_IDS - 1]).trim();
      row.abandonedMissedTimes = String(rd[HISTORICAL_COLS.ABANDONED_MISSED_TIMES - 1] == null ? '' : rd[HISTORICAL_COLS.ABANDONED_MISSED_TIMES - 1]).trim();
    }
    out.push(row);
  }
  return out;
}

/**
 * Editor-run parity diagnostic for the F1 read-back gate. Set the
 * DQE_PARITY_FROM / DQE_PARITY_TO Script Properties to a representative
 * range (or edit the in-source defaults below; start with ~1 week to keep
 * the sheet read cheap), then Run this from the Apps Script editor and read
 * the Execution log.
 *
 * Reports, for [COMPARE_FROM, COMPARE_TO]:
 *   - row counts from each source
 *   - keys (date|agent) present in the sheet but MISSING in Neon
 *     (= a dqe_history backfill gap -- run backfillDQEHistory())
 *   - keys present in Neon but not the sheet (= stale / over-mirrored rows)
 *   - per-key VALUE mismatches across the compared fields (+ up to 10 samples)
 *
 * GATE: 0 missing-in-Neon and 0 value mismatches over a representative
 * range => dqe_history is trustworthy to read from, and the Phase 3.2
 * per-report cutover can begin.
 */
function compareDqeSources_() {
  // F2: the range is read from Script Properties DQE_PARITY_FROM / DQE_PARITY_TO
  // (falling back to the edit-in-source defaults) so the gate can run unattended
  // -- e.g. from a scheduled wrapper -- without editing source each time.
  var _props = PropertiesService.getScriptProperties();
  var COMPARE_FROM = _props.getProperty('DQE_PARITY_FROM') || '2026-05-23';   // <-- edit or set Script Property
  var COMPARE_TO   = _props.getProperty('DQE_PARITY_TO')   || '2026-05-29';   // <-- edit or set Script Property

  Logger.log('=== compareDqeSources_  %s .. %s ===', COMPARE_FROM, COMPARE_TO);
  Logger.log('DQE_READ_SOURCE = %s (neon = the cut-over readers are LIVE on dqe_history; sheet = default)',
             getDqeReadSource_());

  // F2: include the Missed-Calls detail columns (19 slots + abandoned IDs/times)
  // in the parity diff so a CLEAN result also certifies the Missed-Calls Neon
  // reader -- previously these were uncovered and required a manual spot-check.
  // Batch 6: STRUCTURED verdict on every exit (this returned `undefined`), so a
  // caller -- or a scripted flip-readiness check -- can read the result instead
  // of parsing log prose. Mirrors the CORE-5/F-5 contract the CONFIG gates use.
  var verdict = function (o) {
    var v = { from: COMPARE_FROM, to: COMPARE_TO, clean: false, compared: 0,
              missingInNeon: 0, extraInNeon: 0, mismatches: 0, error: '' };
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) v[k] = o[k];
    return v;
  };

  // withQueueSplit: the parity gate certifies the REAL stored column even
  // while QUEUE_SPLIT_SCOPE=off skips it on the egress-lean read path (R24).
  var detailOpts = { includeMissedDetail: true, withQueueSplit: true };
  var sheetRows = sheetFetchDqeRows_(COMPARE_FROM, COMPARE_TO, detailOpts);
  var neonRows  = neonFetchDqeRows_(COMPARE_FROM, COMPARE_TO, detailOpts);
  Logger.log('sheet rows: %s | neon rows: %s', sheetRows.length, neonRows.length);
  if (!neonRows.length) {
    Logger.log('No Neon rows -- check NEON_* Script Properties + the '
             + 'script.external_request scope on THIS project, or that '
             + 'dqe_history has data in range.');
    return verdict({ error: 'no Neon rows in range (unreachable / unconfigured / empty)' });
  }

  var keyOf = function (r) { return r.dateIso + '|' + r.agent; };
  // F2: 'slots' compares the 19-element array via String() (comma-join) -- both
  // sources return string[19], so equality holds iff every slot matches;
  // abandonedParentIds / abandonedMissedTimes are display strings.
  var FIELDS = ['totalUnique', 'totalRung', 'totalMissed', 'totalAnswered',
                'tttSec', 'attSec', 'avgAbdWaitSec', 'csrAvgAbdWaitSec', 'queueExt',
                'slots', 'abandonedParentIds', 'abandonedMissedTimes'];

  var sMap = {}, nMap = {};
  sheetRows.forEach(function (r) { sMap[keyOf(r)] = r; });
  neonRows.forEach(function (r)  { nMap[keyOf(r)] = r; });

  var missingInNeon = [], extraInNeon = [], mismatches = [];
  Object.keys(sMap).forEach(function (k) {
    if (!nMap[k]) { missingInNeon.push(k); return; }
    var s = sMap[k], n = nMap[k], diffs = [];
    FIELDS.forEach(function (f) {
      if (String(s[f]) !== String(n[f])) {
        diffs.push(f + ' sheet=' + s[f] + ' neon=' + n[f]);
      }
    });
    if (diffs.length) mismatches.push(k + ' :: ' + diffs.join(', '));
  });
  Object.keys(nMap).forEach(function (k) { if (!sMap[k]) extraInNeon.push(k); });

  Logger.log('--- missing in Neon (sheet rows not mirrored): %s', missingInNeon.length);
  missingInNeon.slice(0, 10).forEach(function (k) { Logger.log('   %s', k); });
  Logger.log('--- extra in Neon (not on sheet): %s', extraInNeon.length);
  extraInNeon.slice(0, 10).forEach(function (k) { Logger.log('   %s', k); });
  Logger.log('--- value mismatches on common keys: %s', mismatches.length);
  mismatches.slice(0, 10).forEach(function (m) { Logger.log('   %s', m); });

  // EXTRA-in-Neon rows count as NOT clean: with reads on neon they are the
  // phantom-row hazard (split agent / double-counted totals) IMP-5 exists
  // to prevent -- the old verdict ignored them entirely.
  // Batch 6: an EMPTY comparison must never read as a pass. Today the
  // extraInNeon check happens to catch the sheet-empty case (every Neon row is
  // "extra"), but that is incidental -- it would silently become a false CLEAN
  // if the verdict ever stopped counting extras, which is exactly what the QCD
  // gate did. Make the requirement explicit rather than emergent.
  var compared = Object.keys(sMap).length;
  if (!compared) {
    Logger.log('=== PARITY INCONCLUSIVE -- ZERO sheet rows in %s..%s, so nothing was '
      + 'compared. NOT a pass. Point DQE_PARITY_FROM / DQE_PARITY_TO at a range the '
      + 'DQE sheet actually covers (the in-source default is a fixed week and ages '
      + 'out), then re-run. Do NOT flip DQE_READ_SOURCE on this. ===',
      COMPARE_FROM, COMPARE_TO);
    return verdict({ error: 'no sheet rows in range -- nothing compared',
                     extraInNeon: extraInNeon.length });
  }

  var clean = (missingInNeon.length === 0 && extraInNeon.length === 0 && mismatches.length === 0);
  Logger.log('=== PARITY %s ===', clean
    ? 'CLEAN -- dqe_history matches the sheet for this range (' + compared
      + ' rows compared); read-back gate PASSED'
    : 'MISMATCH -- resolve before relying on the read-back. VALUE mismatches or '
      + 'MISSING-in-Neon rows -> run backfillDQEHistoryUpsert() (cdr-report editor; '
      + 'DO UPDATE re-mirror of the sheet, F-51-sanitized, resumable) -- NOT '
      + 'backfillDQEHistory(), whose DO NOTHING skips every existing row. '
      + 'EXTRA-in-Neon phantoms -> force re-import the date (authoritative '
      + 'replace, IMP-5) or delete those rows in SQL, then re-run this check.');
  return verdict({ clean: clean, compared: compared,
                   missingInNeon: missingInNeon.length, extraInNeon: extraInNeon.length,
                   mismatches: mismatches.length });
}

/**
 * Editor-run wrapper for compareDqeSources_.
 *
 * WHY THIS EXISTS: the Apps Script editor's "Run" function picker HIDES any
 * function whose name ends in `_` (the same trailing-underscore convention
 * that blocks google.script.run). So `compareDqeSources_` -- and every other
 * `_`-suffixed helper -- is NOT selectable from the dropdown ("No functions"
 * if it's the only thing you're looking at). This non-underscore wrapper is
 * selectable; pick `runDqeParityCheck` from the picker and Run it, then read
 * the Execution log. (Edit the COMPARE_FROM / COMPARE_TO range inside
 * compareDqeSources_ above first.) Same trick applies to any other
 * `_`-suffixed function you need to run by hand: add a one-line wrapper.
 */
function runDqeParityCheck() {
  assertAdmin_();   // F-28: editor-run wrapper, but the bare name is RPC-reachable
  return compareDqeSources_();
}

/**
 * Lightweight read-timing log for the F1 cutover readers. Emits one line
 * to the Execution log / Cloud Logging per DQE read so you can compare
 * sheet-vs-neon cost in the editor's Executions panel without guessing:
 *
 *   [dqe-read] <label> source=<neon|sheet> rows=<n> ms=<elapsed>
 *
 * `source` is the EFFECTIVE source that served the rows (so a neon read
 * that fell back to the sheet logs source=sheet). Best-effort; never throws.
 */
function logDqeReadTiming_(label, source, startMs, rowCount) {
  try {
    Logger.log('[dqe-read] %s source=%s rows=%s ms=%s',
      label, source,
      (rowCount === null || rowCount === undefined) ? '?' : rowCount,
      (Date.now() - startMs));
  } catch (e) { /* best-effort */ }
}

// ── Neon read-volume gauge (broad-scan F5) ─────────────────────────────────
//
// The owner exhausted Neon's monthly public-transfer allowance mid-month with
// managers live, and the Neon-only surfaces (Escalations, Inbound + heatmap,
// Direct, Caller Lookup, journey drills) went to their "unavailable" states
// until the month rolled over. Nothing in the app measured consumption, so the
// cliff arrived with no warning: System Health reported Neon REACHABILITY, and
// a reachable Neon that has spent its allowance looks perfectly healthy right
// up to the moment it stops.
//
// This accumulates the bytes we actually pull, month to date. It measures OUR
// SIDE of the wire, not Neon's billing meter -- the json_agg payloads are the
// dominant term (that is what the R24 egress round cut) but wire framing, TLS
// overhead and non-instrumented queries are not counted, so the number is a
// FLOOR. That matters for how it is read: a gauge under the budget is not
// proof of headroom, while a gauge over it is proof of a problem.
//
// Storage is one Script Property holding {m, bytes, reads}, reset on month
// rollover. Read-modify-write with no lock, deliberately: two concurrent
// executions can lose an increment, which is acceptable for a gauge and much
// cheaper than serializing every read (the presence-map discipline). It is
// INV-01-clean -- Script Property only, no spreadsheet write -- and every path
// is best-effort: instrumentation must never be able to fail a report.
var NEON_EGRESS_PROP_ = 'NEON_EGRESS_MTD';

/** Current UTC month key, 'YYYY-MM'. */
function neonEgressMonthKey_() {
  var d = new Date();
  var m = d.getUTCMonth() + 1;
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m;
}

/**
 * Adds one instrumented read to the month-to-date counters. `bytes` is the
 * length of the payload string we pulled. Never throws.
 */
function neonNoteEgress_(bytes) {
  try {
    var n = Number(bytes) || 0;
    if (n <= 0) return;
    var props = PropertiesService.getScriptProperties();
    var key = neonEgressMonthKey_();
    var cur = null;
    try { cur = JSON.parse(props.getProperty(NEON_EGRESS_PROP_) || 'null'); } catch (e) { cur = null; }
    if (!cur || cur.m !== key) cur = { m: key, bytes: 0, reads: 0 };
    cur.bytes += n;
    cur.reads += 1;
    props.setProperty(NEON_EGRESS_PROP_, JSON.stringify(cur));
  } catch (e) { /* best-effort -- a gauge must never break a read */ }
}

/**
 * { month, bytes, reads, budgetMb, pctOfBudget } for the Health page.
 * `budgetMb` comes from the NEON_EGRESS_BUDGET_MB Script Property and is 0
 * when unset -- the plan's real allowance is a billing fact this code cannot
 * discover, so the operator declares it and only then does the row acquire a
 * threshold. Unset = the row is informational, never a false alarm.
 */
function readNeonEgress_() {
  var out = { month: neonEgressMonthKey_(), bytes: 0, reads: 0, budgetMb: 0, pctOfBudget: null };
  try {
    var props = PropertiesService.getScriptProperties();
    var cur = null;
    try { cur = JSON.parse(props.getProperty(NEON_EGRESS_PROP_) || 'null'); } catch (e) { cur = null; }
    // A stale month reads as zero rather than as last month's total.
    if (cur && cur.m === out.month) {
      out.bytes = Number(cur.bytes) || 0;
      out.reads = Number(cur.reads) || 0;
    }
    var b = Number(props.getProperty('NEON_EGRESS_BUDGET_MB') || 0) || 0;
    if (b > 0) {
      out.budgetMb = b;
      out.pctOfBudget = Math.round((out.bytes / (b * 1024 * 1024)) * 1000) / 10;
    }
  } catch (e) { /* best-effort */ }
  return out;
}

/**
 * F4: durable, operator-inspectable record of Neon READ failures.
 *
 * The cut-over readers (computeSummary_, getCompanyOverview,
 * getLatestDataDate) fall back to the sheet on any Neon null/empty/error
 * -- correct as a safety net, but it makes a genuine Neon failure
 * (connection unreachable, SQL / JSON-parse error) indistinguishable
 * from a legitimately empty range, so the degradation was previously
 * only an ephemeral Logger.log. Once DQE_READ_SOURCE=neon and the sheet
 * is allowed to age, that means the dashboard can serve stale data with
 * no surfaced signal.
 *
 * This records the last error + a running streak count to the
 * NEON_READ_LAST_ERROR Script Property (queryable now; surfaceable in
 * the admin Overview pipeline banner as a follow-on) and emits a
 * distinctly-tagged log line. Best-effort: never throws -- observability
 * must not block a read. NEO-3: fed ONLY by the three DQE read-back
 * readers (non-DQE Neon surfaces neither record nor clear), so the
 * admin health line is strictly a DQE read-back signal again.
 */
function recordNeonReadFailure_(label, err) {
  try {
    var props = PropertiesService.getScriptProperties();
    var msg = (err && err.message) ? err.message : String(err);
    var prev = 0;
    try {
      prev = Number((JSON.parse(props.getProperty('NEON_READ_LAST_ERROR') || '{}') || {}).count) || 0;
    } catch (e) { prev = 0; }
    props.setProperty('NEON_READ_LAST_ERROR', JSON.stringify({
      at:      Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
      label:   String(label || ''),
      message: String(msg).slice(0, 300),
      count:   prev + 1,
    }));
    Logger.log('[dqe-read][error] %s neon read FAILED -- serving sheet fallback: %s', label, msg);
  } catch (e) { /* best-effort */ }
}

/**
 * Clears NEON_READ_LAST_ERROR on a successful read so the streak count
 * reflects only the CURRENT outage (a "repeated failures" signal) and a
 * transient blip self-heals once Neon recovers. Cheap on the healthy
 * path: a single getProperty returning null, no write.
 */
function clearNeonReadFailure_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('NEON_READ_LAST_ERROR') !== null) {
      props.deleteProperty('NEON_READ_LAST_ERROR');
    }
  } catch (e) { /* best-effort */ }
}

/**
 * F3: surfaces the durable Neon READ-failure signal (NEON_READ_LAST_ERROR,
 * written by recordNeonReadFailure_) so an admin can SEE that the read-back is
 * failing instead of having to inspect a Script Property by hand. Consumed by
 * getAlertsInit -> the Alerts modal, alongside the F2 mirror-health line.
 *
 * Why this matters: once DQE_READ_SOURCE=neon and the sheet is allowed to age,
 * a sustained Neon read outage degrades SILENTLY to the (possibly stale) sheet
 * -- the cut-over readers fall back correctly but emit only an ephemeral log.
 * This makes the streak visible.
 *
 * Returns { configured, source, status, at, label, message, count }:
 *   status 'ok'      - no recorded read failure (healthy, or never failed)
 *   status 'failing' - a failure is on record; `count` is the consecutive
 *                      streak, `at`/`label`/`message` describe the last one.
 * Best-effort: never throws; on any error returns a benign 'ok' shape.
 */
function computeNeonReadHealth_() {
  var out = { configured: false, source: 'sheet', status: 'ok',
              at: null, label: null, message: null, count: 0 };
  try {
    var props = PropertiesService.getScriptProperties();
    out.configured = !!props.getProperty('NEON_HOST');
    out.source = getDqeReadSource_();
    var raw = props.getProperty('NEON_READ_LAST_ERROR');
    if (!raw) return out;   // no failure on record
    var rec = JSON.parse(raw) || {};
    out.status  = 'failing';
    out.at      = rec.at || null;
    out.label   = rec.label || null;
    out.message = rec.message || null;
    out.count   = Number(rec.count) || 0;
    return out;
  } catch (e) {
    Logger.log('computeNeonReadHealth_ failed: ' + (e && e.message ? e.message : e));
    return out;
  }
}

/**
 * F2 divergence detector. The DQE pipeline writes the sheet first and mirrors
 * to dqe_history best-effort; a transient Neon outage during a build can leave
 * a date in the sheet but not in Neon. The dup-guard re-mirror (cdr-import
 * buildDQEHistoricalData) self-heals it on the next import of that date, but
 * until then a `DQE_READ_SOURCE=neon` deployment would serve data missing that
 * date with no surfaced signal. This compares the SHEET's MAX(call_date)
 * against dqe_history's MAX(call_date) so an admin can spot the divergence in
 * the Alerts modal.
 *
 * Returns { configured, status, sheetMax, neonMax, gapDays }:
 *   'unconfigured' - NEON_HOST not set (Neon mirror not used here) -> hidden
 *   'error'        - Neon configured but the MAX query failed/returned nothing
 *   'ok'           - neonMax >= sheetMax (mirror current, or ahead of a pruned
 *                    sheet) -> gapDays 0
 *   'behind'       - neonMax < sheetMax: the mirror is stale by gapDays.
 *                    Re-import the missing date(s) (the dup-guard re-mirror
 *                    heals it) or run backfillDQEHistoryUpsert().
 *
 * NOTE: this is a MAX-date proxy (the audit's lightweight check) -- it reliably
 * catches the common "most-recent date(s) un-mirrored" outage but not an
 * interior gap where both ends mirrored. Best-effort: never throws.
 */
function computeNeonMirrorHealth_(conn) {
  var out = { configured: false, status: 'unconfigured',
              sheetMax: null, neonMax: null, gapDays: null };
  try {
    if (!PropertiesService.getScriptProperties().getProperty('NEON_HOST')) return out;
    out.configured = true;
    // Source-INDEPENDENT sheet max (NOT getLatestDataDate, which reads Neon
    // when DQE_READ_SOURCE=neon -- that would compare Neon against itself).
    out.sheetMax = dqeSheetMaxDate_();
    // Shared-connection contract (SystemHealth single-conn): a conn arg PASSED
    // (even null) means the caller owns the lifecycle -- an explicit null is
    // "the shared open already failed", so report error without a second
    // handshake; with NO arg (the Alerts modal) open our own via
    // neonGetMaxDqeDate_() (which then records/clears read-health as before).
    var sharedConnProvided = (arguments.length >= 1);
    out.neonMax = sharedConnProvided ? (conn ? neonGetMaxDqeDate_(conn) : null)
                                     : neonGetMaxDqeDate_();
    if (!out.neonMax) { out.status = 'error'; return out; }
    if (!out.sheetMax) { out.status = 'ok'; return out; }   // nothing to compare
    if (out.neonMax >= out.sheetMax) { out.status = 'ok'; out.gapDays = 0; return out; }
    out.status = 'behind';
    out.gapDays = neonMirrorGapDays_(out.neonMax, out.sheetMax);
    return out;
  } catch (e) {
    Logger.log('computeNeonMirrorHealth_ failed: ' + (e && e.message ? e.message : e));
    out.status = 'error';
    return out;
  }
}

/**
 * Source-independent MAX(call_date) from the DQE Historical Data SHEET, as a
 * 'yyyy-MM-dd' string (or null). Scans only the date column. Used by the F2
 * divergence detector so it always reflects the sheet regardless of
 * DQE_READ_SOURCE. Best-effort: null on any error.
 */
function dqeSheetMaxDate_() {
  try {
    var ss = openSpreadsheet_();
    var sheet = ss.getSheetByName(SHEETS.HISTORICAL);
    if (!sheet) return null;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;
    var ssTZ = ss.getSpreadsheetTimeZone();
    var values = sheet.getRange(2, HISTORICAL_COLS.DATE, lastRow - 1, 1).getValues();
    var max = '';
    for (var i = 0; i < values.length; i++) {
      var iso = rowDateIso_(values[i][0], ssTZ);
      if (iso && iso > max) max = iso;
    }
    return max || null;
  } catch (e) {
    Logger.log('dqeSheetMaxDate_ failed: ' + (e && e.message ? e.message : e));
    return null;
  }
}

/** Calendar-day gap between two 'yyyy-MM-dd' strings (sheetMax - neonMax). */
function neonMirrorGapDays_(neonMax, sheetMax) {
  try {
    var a = new Date(neonMax  + 'T00:00:00Z').getTime();
    var b = new Date(sheetMax + 'T00:00:00Z').getTime();
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  } catch (e) { return null; }
}

/**
 * Editor-run drift check for the DQE history backfill (the "before you paste
 * older rows" gate). Reads the OLD spreadsheet's DQE sheet + the CURRENT
 * `DQE Historical Data`, finds the (date, agent) keys present in BOTH (the
 * overlap window), and reports how many match exactly vs differ on the core
 * metric columns -- so you can quantify any calculation drift before relying
 * on the older data for the trend charts.
 *
 * Durations are compared via getDisplayValues (TZ-agnostic strings, INV-02),
 * so a different spreadsheet timezone on the old workbook doesn't create false
 * mismatches. Read-only; never writes.
 *
 * Use the `runHistoricalBackfillCheck` wrapper (the Run picker hides
 * `_`-suffixed functions); edit OLD_SS_ID / OLD_SHEET there first.
 */
function validateHistoricalDqeBackfill_(oldSsId, oldSheetName) {
  var readDqe = function (ss, sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error('Sheet "' + sheetName + '" not found in ' + ss.getId());
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return {};
    var tz = ss.getSpreadsheetTimeZone();
    var numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
    var range = sheet.getRange(2, 1, lastRow - 1, numCols);
    var vals = range.getValues();
    var disp = range.getDisplayValues();
    var out = {};
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i], rd = disp[i];
      var iso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], tz);
      var agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
      if (!iso || !agent) continue;
      out[iso + '|' + agent] = {
        unique:   Number(r[HISTORICAL_COLS.TOTAL_UNIQUE - 1])   || 0,
        rung:     Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0,
        missed:   Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0,
        answered: Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
        tttSec:   parseHmsDisplay_(rd[HISTORICAL_COLS.TTT - 1]),
        attSec:   parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]),
      };
    }
    return out;
  };

  var oldRows = readDqe(SpreadsheetApp.openById(oldSsId), oldSheetName);
  var curRows = readDqe(openSpreadsheet_(), SHEETS.HISTORICAL);

  var FIELDS = ['unique', 'rung', 'missed', 'answered', 'tttSec', 'attSec'];
  var overlap = 0, matches = 0, mismatches = [];
  Object.keys(oldRows).forEach(function (k) {
    if (!curRows[k]) return;   // not in the overlap window
    overlap++;
    var o = oldRows[k], c = curRows[k], diffs = [];
    FIELDS.forEach(function (f) {
      if (String(o[f]) !== String(c[f])) diffs.push(f + ' old=' + o[f] + ' cur=' + c[f]);
    });
    if (diffs.length) mismatches.push(k + ' :: ' + diffs.join(', '));
    else matches++;
  });

  Logger.log('=== DQE backfill drift check ===');
  Logger.log('old rows: %s | current rows: %s', Object.keys(oldRows).length, Object.keys(curRows).length);
  Logger.log('overlapping (date|agent) keys: %s', overlap);
  Logger.log('exact matches: %s | mismatches: %s', matches, mismatches.length);
  mismatches.slice(0, 15).forEach(function (m) { Logger.log('   %s', m); });
  if (overlap === 0) {
    Logger.log('NOTE: no overlap -- the old sheet and current DQE Historical Data share no '
             + '(date, agent) keys, so drift can\'t be measured. Check the date ranges/sheet name.');
  } else {
    var pct = Math.round((matches / overlap) * 1000) / 10;
    Logger.log('=== %s%% of overlapping rows match exactly ===', pct);
    Logger.log(mismatches.length === 0
      ? 'CLEAN -- the older data was computed the same way; safe to paste the pre-overlap rows.'
      : 'DRIFT -- review the mismatches above to decide if the older data is close enough for trend context.');
  }
  return { overlap: overlap, matches: matches, mismatches: mismatches.length };
}

/**
 * Editor wrapper for validateHistoricalDqeBackfill_ (the Run picker hides
 * `_`-suffixed functions). Edit OLD_SS_ID + OLD_SHEET to point at the
 * spreadsheet holding your Nov-2024+ DQE history, then Run this and read the
 * Execution log.
 */
function runHistoricalBackfillCheck() {
  assertAdmin_();   // F-28: editor-run wrapper, but the bare name is RPC-reachable
  var OLD_SS_ID = 'PASTE_OLD_SPREADSHEET_ID_HERE';   // <-- edit
  var OLD_SHEET = 'DQE Historical Data';             // <-- edit if the old tab is named differently
  if (OLD_SS_ID === 'PASTE_OLD_SPREADSHEET_ID_HERE') {
    Logger.log('Edit OLD_SS_ID (and OLD_SHEET if needed) in runHistoricalBackfillCheck first.');
    return;
  }
  return validateHistoricalDqeBackfill_(OLD_SS_ID, OLD_SHEET);
}


