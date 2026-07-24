/**
 * Caller Lookup -- "explain the full communication history with this number."
 *
 * Admin enters a phone number + date range; the server normalizes the
 * number to the pipeline's canonical "+<digits>" form, HMAC-SHA256 hashes
 * it (HMAC_SECRET -- the SAME secret + normalization the import pipeline
 * and insurance sync use, so the hash matches `inbound_calls.caller_hash`,
 * `outbound_calls.callee_hash`, AND `call_history_phones.phone_hash`),
 * and returns THREE sections over one connection:
 *   - calls: the number's INBOUND calls with per-call outcome, wait/hold,
 *     queue path, and -- for calls captured since the journey extension in
 *     cdr-import/inboundCalls.js -- the full ordered leg-by-leg journey.
 *     Pre-extension rows render the entry->final queue summary only.
 *   - outboundCalls (Option B, cdr-import/outboundCalls.js): per-call
 *     OUTBOUND records -- dialing agent + dept, connected/no-answer, talk /
 *     ring seconds, call_start, journey. Only covers dates since the
 *     outbound capture deployed (+ its ~14-day Call_Legs backfill window).
 *   - outboundHistory: day-level outbound aggregates from
 *     call_history_phones (the CDR sheet's per-agent-day dialed-number
 *     lists) -- the outbound record for dates BEFORE the per-call capture;
 *     per-call detail was never stored for those, so day-level is the
 *     ceiling there. Each section is independently best-effort: a missing
 *     outbound_calls table (dashboard deployed ahead of cdr-import) just
 *     flags meta.outboundAvailable=false without touching the inbound
 *     results.
 *
 * Public entry (callable via google.script.run):
 *   getCallerLookup({ phone, from, to })
 *     -> { meta: { from, to, available, configured, matches,
 *                  outboundAvailable, outboundMatches, historyAvailable },
 *          calls: [...], outboundCalls: [...], outboundHistory: [...] }
 *
 * PRIVACY MODEL (do not relax):
 *   - Admin-only (assertAdmin_): this is a caller-targeted lookup.
 *   - The raw number is normalized + hashed IN MEMORY and never stored,
 *     never logged, never returned, and never inlined into SQL -- the hash
 *     is bound as a prepared-statement parameter.
 *   - Responses are intentionally NOT cached: no caller-keyed data sits in
 *     the shared script cache, and the query is a cheap PK-adjacent read.
 *
 * Reads Neon via getDashboardNeonConn_ (NeonRead.gs; same NEON_* props +
 * script.external_request scope as the F1 read-back). NEW operator
 * prerequisite: HMAC_SECRET must ALSO be set on the DASHBOARD project's
 * Script Properties (same value as CDR Import / CDR Report) -- without it
 * the lookup returns meta.configured=false and the modal explains the
 * missing property. Index note: the `inbound_calls` PK is
 * (call_date, call_id); for fast hash lookups create
 *   CREATE INDEX IF NOT EXISTS idx_inbound_calls_caller_hash
 *     ON inbound_calls (caller_hash, call_date);
 * (one-time, in the Neon console -- trivial at current volume either way).
 */

const CALLER_LOOKUP_MAX_RANGE_DAYS = 366;
const CALLER_LOOKUP_MAX_CALLS = 200;

function getCallerLookup(req) {
  assertAdmin_();
  const user = resolveUser_(Session.getActiveUser().getEmail());

  const digits = String((req && req.phone) || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw new Error('Enter a phone number with 10-15 digits.');
  }
  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');
  const rangeDays = Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
  if (rangeDays > CALLER_LOOKUP_MAX_RANGE_DAYS) {
    throw new Error('Range is capped at ' + CALLER_LOOKUP_MAX_RANGE_DAYS + ' days.');
  }

  const out = {
    meta: {
      from: from, to: to, available: true, configured: true,
      matches: 0, truncated: false, generatedAt: new Date().toISOString(),
    },
    calls: [],
  };

  const secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!secret) {
    out.meta.available = false;
    out.meta.configured = false;
    return out;
  }
  // Canonical normalization: "+<digits>" -- must stay byte-identical to
  // cdr-import's icExternalNumber_ + cdrHashPhone_ (parity-pinned by
  // tests/unit/caller-lookup.test.js). The CDR delivers US numbers with
  // the country code ("+1XXXXXXXXXX"), so a 10-digit entry ALSO tries the
  // "+1"-prefixed form -- both candidate hashes go into one IN (...) query
  // (a user typing the local number shouldn't get silent zero matches).
  const candidates = callerLookupHashCandidates_(digits);
  const hashes = candidates.map(function (c) { return callerLookupHashPhone_(c, secret); });

  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { out.meta.available = false; return out; }

    // to_jsonb(c) serializes whatever columns exist, so the reader is
    // compatible with rows written BEFORE the journey extension (they
    // simply lack call_start/journey keys) AND with a not-yet-redeployed
    // cdr-import (no column at all). ONE query, ONE getString.
    const inList = hashes.map(function () { return '?'; }).join(', ');
    // NEO-4: the inner LIMIT is ordered (newest first) so truncation keeps
    // the MOST RECENT calls -- an unordered LIMIT let the planner return an
    // arbitrary (run-to-run unstable) subset for >cap callers. The outer
    // json_agg re-sorts ascending for chronological display, matching the
    // ordered-subquery pattern every sibling capped query uses.
    const sql =
      "SELECT COALESCE(json_agg(t.j ORDER BY t.j->>'call_date', COALESCE(t.j->>'call_start','')), '[]')::text AS j " +
      "FROM (SELECT to_jsonb(c) || jsonb_build_object('insurer', i.insurance_name) AS j " +
        "FROM inbound_calls c LEFT JOIN insurance_numbers i ON i.phone_hash = c.caller_hash " +
        "WHERE c.caller_hash IN (" + inList + ") AND c.call_date BETWEEN ?::date AND ?::date " +
        "ORDER BY c.call_date DESC, c.call_start DESC NULLS LAST " +
        "LIMIT " + (CALLER_LOOKUP_MAX_CALLS + 1) + ") t";
    const stmt = conn.prepareStatement(sql);
    let p = 0;
    hashes.forEach(function (h) { stmt.setString(++p, h); });
    stmt.setString(++p, from);
    stmt.setString(++p, to);
    const rs = stmt.executeQuery();
    const json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();

    let rows = JSON.parse(json || '[]');
    if (!Array.isArray(rows)) rows = [];
    if (rows.length > CALLER_LOOKUP_MAX_CALLS) {
      // R-2: the inner LIMIT kept the newest rows, but json_agg re-sorted
      // them ASCENDING -- so slice(0, MAX) dropped the caller's MOST RECENT
      // call (exactly the one an admin is usually investigating) instead of
      // the oldest of the fetched window. Keep the tail of the ascending list.
      rows = rows.slice(rows.length - CALLER_LOOKUP_MAX_CALLS);
      out.meta.truncated = true;
    }
    out.calls = rows.map(callerLookupShapeCall_);
    out.meta.matches = out.calls.length;

    // ── Outbound (Option B): per-call records from `outbound_calls` -- the
    // SAME hash space (canonical "+<digits>" + HMAC_SECRET), so the candidate
    // hashes match callee_hash directly. Each section is independently
    // best-effort: a missing table (capture not yet deployed) or a per-query
    // error degrades that section to unavailable WITHOUT killing the inbound
    // results the admin already gets today.
    out.meta.outboundAvailable = true;
    out.outboundCalls = [];
    try {
      const obSql =
        "SELECT COALESCE(json_agg(t.j ORDER BY t.j->>'call_date', COALESCE(t.j->>'call_start','')), '[]')::text AS j " +
        "FROM (SELECT to_jsonb(o) AS j FROM outbound_calls o " +
          "WHERE o.callee_hash IN (" + inList + ") AND o.call_date BETWEEN ?::date AND ?::date " +
          "ORDER BY o.call_date DESC, o.call_start DESC NULLS LAST " +
          "LIMIT " + (CALLER_LOOKUP_MAX_CALLS + 1) + ") t";
      const obStmt = conn.prepareStatement(obSql);
      let op = 0;
      hashes.forEach(function (h) { obStmt.setString(++op, h); });
      obStmt.setString(++op, from);
      obStmt.setString(++op, to);
      const obRs = obStmt.executeQuery();
      const obJson = obRs.next() ? obRs.getString('j') : '[]';
      obRs.close(); obStmt.close();
      let obRows = JSON.parse(obJson || '[]');
      if (!Array.isArray(obRows)) obRows = [];
      if (obRows.length > CALLER_LOOKUP_MAX_CALLS) {
        obRows = obRows.slice(obRows.length - CALLER_LOOKUP_MAX_CALLS);   // keep the newest (R-2)
        out.meta.outboundTruncated = true;
      }
      out.outboundCalls = obRows.map(callerLookupShapeOutbound_);
    } catch (obErr) {
      // Undefined-table before the cdr-import deploy lands here too.
      Logger.log('getCallerLookup outbound section unavailable (best-effort): '
        + (obErr && obErr.message ? obErr.message : obErr));
      out.meta.outboundAvailable = false;
    }
    out.meta.outboundMatches = out.outboundCalls.length;

    // ── Historical outbound (day-level): `call_history_phones` aggregates --
    // the CDR sheet's per-agent-day dialed-number lists, mirrored since long
    // before the per-call capture. Fills the outbound story for dates
    // outbound_calls doesn't cover (no time-of-day / per-call rows exist for
    // them -- the data was only ever day-level). Same hash space again.
    out.meta.historyAvailable = true;
    out.outboundHistory = [];
    try {
      const hSql =
        "SELECT COALESCE(json_agg(t.j ORDER BY t.j->>'call_date', t.j->>'agent_name'), '[]')::text AS j " +
        "FROM (SELECT jsonb_build_object('call_date', d.call_date::text, " +
            "'department', d.department, 'agent_name', d.agent_name, " +
            "'list_type', p.list_type, 'duration_sec', p.duration_sec, " +
            "'occurrences', p.occurrences) AS j " +
          "FROM call_history_phones p JOIN call_history_dept d ON d.id = p.call_history_id " +
          "WHERE p.phone_hash IN (" + inList + ") AND d.call_date BETWEEN ?::date AND ?::date " +
          "ORDER BY d.call_date DESC LIMIT 1000) t";
      const hStmt = conn.prepareStatement(hSql);
      let hp = 0;
      hashes.forEach(function (h) { hStmt.setString(++hp, h); });
      hStmt.setString(++hp, from);
      hStmt.setString(++hp, to);
      const hRs = hStmt.executeQuery();
      const hJson = hRs.next() ? hRs.getString('j') : '[]';
      hRs.close(); hStmt.close();
      let hRows = JSON.parse(hJson || '[]');
      if (!Array.isArray(hRows)) hRows = [];
      out.outboundHistory = callerLookupShapeHistory_(hRows);
    } catch (hErr) {
      Logger.log('getCallerLookup history section unavailable (best-effort): '
        + (hErr && hErr.message ? hErr.message : hErr));
      out.meta.historyAvailable = false;
    }

    logReportUsage_('caller-lookup', '(admin)', user, false);
    return out;
  } catch (e) {
    Logger.log('getCallerLookup failed (best-effort): ' + (e && e.message ? e.message : e));
    out.meta.available = false;
    return out;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

/**
 * Normalizes one to_jsonb row for the client: drops the hash + write
 * timestamp (the client has no use for either), parses the journey JSON
 * string to an array (null when absent / unparseable -- the client then
 * falls back to the entry->final summary).
 */
function callerLookupShapeCall_(r) {
  let journey = null;
  if (r.journey) {
    try {
      const arr = JSON.parse(r.journey);
      if (Array.isArray(arr) && arr.length) journey = arr;
    } catch (e) { /* summary fallback */ }
  }
  return {
    callDate:        r.call_date || null,
    callStart:       r.call_start || null,
    callId:          r.call_id || null,
    disposition:     r.disposition || null,
    abandonStage:    r.abandon_stage || null,
    abandonedOnHold: !!r.abandoned_on_hold,
    holdSeconds:     Number(r.hold_seconds) || 0,
    waitSeconds:     r.wait_seconds == null ? null : (Number(r.wait_seconds) || 0),
    entryQueue:      r.entry_queue || null,
    finalQueue:      r.final_queue || null,
    finalDept:       r.final_dept || null,
    numQueues:       Number(r.num_queues) || 0,
    numTransfers:    Number(r.num_transfers) || 0,
    dialIn:          r.dial_in_number || null,
    insurer:         r.insurer || null,
    journey:         journey,
  };
}

/**
 * Normalizes one outbound_calls to_jsonb row for the client (drops the hash
 * + write timestamp; journey JSON string -> array or null).
 */
function callerLookupShapeOutbound_(r) {
  let journey = null;
  if (r.journey) {
    try {
      const arr = JSON.parse(r.journey);
      if (Array.isArray(arr) && arr.length) journey = arr;
    } catch (e) { /* no journey */ }
  }
  return {
    callDate:    r.call_date || null,
    callStart:   r.call_start || null,
    callId:      r.call_id || null,
    agentName:   r.agent_name || null,
    agentExt:    r.agent_ext || null,
    department:  r.department || null,
    connected:   !!r.connected,
    talkSeconds: Number(r.talk_seconds) || 0,
    ringSeconds: r.ring_seconds == null ? null : (Number(r.ring_seconds) || 0),
    attempts:    Number(r.attempts) || 1,
    journey:     journey,
  };
}

/**
 * PURE. Folds the raw call_history_phones rows (one per (date, agent,
 * list_type)) into one entry per (date, agent): dialed count from the TOTAL
 * list, answered/missed split from the other two (total is a superset --
 * never summed), talk seconds from the answered list's duration. Ascending
 * date order (matches the call lists).
 */
function callerLookupShapeHistory_(rows) {
  const byKey = {};
  (rows || []).forEach(function (r) {
    const key = (r.call_date || '') + '|' + (r.agent_name || '');
    const e = byKey[key] || (byKey[key] = {
      callDate: r.call_date || null, department: r.department || null,
      agentName: r.agent_name || null, dialed: 0, answered: 0, missed: 0, talkSeconds: 0,
    });
    const occ = Number(r.occurrences) || 0;
    const dur = Number(r.duration_sec) || 0;
    if (r.list_type === 'ob_ext_list_total') { e.dialed += occ; }
    else if (r.list_type === 'ob_ext_list_answered') { e.answered += occ; e.talkSeconds += dur; }
    else if (r.list_type === 'ob_ext_list_missed') { e.missed += occ; }
  });
  return Object.keys(byKey).sort().map(function (k) { return byKey[k]; });
}

/**
 * PURE. Candidate normalized forms for an entered number. The pipeline
 * stores numbers as delivered by the CDR -- US numbers carry the leading
 * country code -- so a 10-digit local entry also tries "+1"-prefixed.
 */
function callerLookupHashCandidates_(digits) {
  const out = ['+' + digits];
  if (digits.length === 10) out.push('+1' + digits);
  return out;
}

/**
 * HMAC-SHA256 hex of the normalized number. Must stay byte-identical to
 * cdr-import's cdrHashPhone_ (neonWrite.js) -- same signed-byte-to-hex
 * rebuild -- so the lookup hash matches what the pipeline wrote.
 */
function callerLookupHashPhone_(normalized, secret) {
  const bytes = Utilities.computeHmacSha256Signature(normalized, secret);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
