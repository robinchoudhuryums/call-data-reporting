/**
 * Caller Lookup -- "explain the full call path for this caller on this day."
 *
 * Admin enters a phone number + date range; the server normalizes the
 * number to the pipeline's canonical "+<digits>" form, HMAC-SHA256 hashes
 * it (HMAC_SECRET -- the SAME secret + normalization the import pipeline
 * and insurance sync use, so the hash matches `inbound_calls.caller_hash`),
 * and returns that caller's inbound calls with per-call outcome, wait/hold,
 * queue path, and -- for calls captured since the journey extension in
 * cdr-import/inboundCalls.js -- the full ordered leg-by-leg journey
 * (IVR -> queue -> agent rings -> answer -> hold), stored in the `journey`
 * column. Pre-extension rows render the entry->final queue summary only.
 *
 * Public entry (callable via google.script.run):
 *   getCallerLookup({ phone, from, to })
 *     -> { meta: { from, to, available, configured, matches }, calls: [...] }
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
