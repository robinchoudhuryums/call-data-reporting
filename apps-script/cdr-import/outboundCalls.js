// ============================================================================
// outboundCalls.js — per-call OUTBOUND capture (cdr-import project)
// ----------------------------------------------------------------------------
// The Option-B twin of inboundCalls.js: produces ONE record per distinct
// OUTBOUND external call (grouped across legs by root Call ID, same
// stitching), then mirrors them to Neon's `outbound_calls` table. Together
// with `inbound_calls` this gives the dashboard's Caller Lookup a PER-CALL
// communication history in both directions (the day-level
// `call_history_phones` aggregates remain the outbound record for dates
// before this capture existed).
//
// A leg group is an OUTBOUND call when it contains NO Incoming leg (an
// answered inbound queue call carries the agent's own 'Outgoing' talk leg,
// so direction alone is not enough -- the no-Incoming gate excludes those)
// AND at least one Direction='Outgoing' leg whose CALLEE is an external
// number (>= 10 digits). Internal-only groups (ext-to-ext, queue transfers)
// have no external callee and fall out naturally.
//
// Captures: callee_hash (deterministic HMAC of the canonical "+<digits>"
// form via cdrHashPhone_ -- the SAME hash space as inbound_calls.caller_hash
// / call_history_phones / insurance_numbers, so Caller Lookup's candidate
// hashes match all of them), the dialing agent (name + ext + Departments
// label), connected (a Talk>0 Answered external leg -- the CDR cannot
// distinguish no-answer / voicemail / busy on the unconnected side, matching
// directCallMetrics' activity-only outbound semantics), talk/ring seconds,
// attempts (external Outgoing legs in the group), call_start ('HH:MM:SS',
// CDR-native raw PST -- clients shift +2h to CST for display, the INV-18
// convention shared with inbound), and the leg-by-leg journey (masked by
// icBuildJourney_: a phone-shaped callee name renders '(external number)',
// so no raw number ever lands in Neon).
//
// PHI: the raw dialed number is normalized + hashed IN MEMORY and never
// stored; without HMAC_SECRET rows still write with NULL callee_hash (the
// call_history_dept convention) and heal on a re-import once the property
// is set.
//
// buildOutboundCallRecords_(rawRows) is PURE (no Apps Script globals) so
// it's unit-tested directly (tests/unit/outbound-calls.test.js). All ic*
// helpers + cdrHashPhone_ + getReachableNeonConn_ come from inboundCalls.js
// / neonWrite.js via the project's flat global scope.
// ============================================================================

/**
 * PURE. rawRows = Raw Data leg rows (arrays indexed per IC_COL). Returns one
 * record per distinct OUTBOUND external call. When a group dials more than
 * one distinct external number (rare -- conference / sequential consult), the
 * FIRST external callee identifies the call; the journey still shows every
 * leg (masked).
 */
function buildOutboundCallRecords_(rawRows) {
  if (!rawRows || !rawRows.length) return [];

  // Group legs by ROOT call id (Parent if present, else own) -- identical to
  // the inbound stitching so a call can never land in both tables.
  var groups = {};
  for (var i = 0; i < rawRows.length; i++) {
    var r = rawRows[i];
    var parent = String(r[IC_COL.PARENT_CALL_ID] == null ? '' : r[IC_COL.PARENT_CALL_ID]).trim();
    var own = String(r[IC_COL.CALL_ID] == null ? '' : r[IC_COL.CALL_ID]).trim();
    if (!own) continue;
    var root = (parent && parent.toUpperCase() !== 'N/A') ? parent : own;
    (groups[root] = groups[root] || []).push(r);
  }

  var records = [];
  Object.keys(groups).forEach(function (root) {
    var legs = groups[root].slice().sort(function (a, b) {
      var d = (icParseTs_(a[IC_COL.START]) || 0) - (icParseTs_(b[IC_COL.START]) || 0);
      if (d) return d;
      return (Number(a[IC_COL.LEG_ID]) || 0) - (Number(b[IC_COL.LEG_ID]) || 0);
    });

    // Gate 1: any Incoming leg -> this is an inbound call's group (its agent
    // 'Outgoing' talk legs belong to the inbound journey, not here).
    var hasIncoming = legs.some(function (l) {
      return String(l[IC_COL.DIRECTION] == null ? '' : l[IC_COL.DIRECTION]).trim() === 'Incoming';
    });
    if (hasIncoming) return;

    // Gate 2: external Outgoing legs (agent dialing out to a real number).
    var extLegs = legs.filter(function (l) {
      return String(l[IC_COL.DIRECTION] == null ? '' : l[IC_COL.DIRECTION]).trim() === 'Outgoing'
        && icExternalNumber_(l[IC_COL.CALLEE]);
    });
    if (!extLegs.length) return;

    var first = extLegs[0];
    var calleeNumber = icExternalNumber_(first[IC_COL.CALLEE]);

    // The dialing agent -- caller side of the outbound leg. The name cell is
    // the agent's CNAM; a phone-shaped or N/A value is dropped (ext suffices).
    var agentExt = icDigits_(first[IC_COL.CALLER]) || null;
    var agentName = String(first[IC_COL.CALLER_NAME] == null ? '' : first[IC_COL.CALLER_NAME]).trim();
    if (!agentName || agentName.toUpperCase() === 'N/A'
        || /^\+?[\d\s\-().]{7,}$/.test(agentName)) agentName = null;
    if (agentName) agentName = agentName.slice(0, IC_JOURNEY_NAME_MAX);
    var dept = String(first[IC_COL.DEPARTMENTS] == null ? '' : first[IC_COL.DEPARTMENTS]).trim();
    if (!dept || dept.toUpperCase() === 'N/A') dept = null;

    // Connected = the callee picked up: Talk>0 on an Answered external leg
    // (zero-talk legs that say "Answered" are ringback/system noise, the
    // same gate the inbound disposition uses).
    var connected = false, talkSeconds = 0;
    extLegs.forEach(function (l) {
      var t = icTimeToSec_(l[IC_COL.TALK]);
      if (t > 0 && String(l[IC_COL.ANSWERED] == null ? '' : l[IC_COL.ANSWERED]).trim() === 'Answered') {
        connected = true;
        talkSeconds = Math.max(talkSeconds, t);
      }
    });

    // Ring seconds on the first attempt: start -> connected when it was
    // picked up, else start -> stop (how long it rang before giving up).
    var startMs = icParseTs_(first[IC_COL.START]);
    var edgeMs = connected ? icParseTs_(first[IC_COL.CONNECTED]) : icParseTs_(first[IC_COL.STOP]);
    var ringSeconds = (!isNaN(startMs) && !isNaN(edgeMs))
      ? Math.max(0, Math.round((edgeMs - startMs) / 1000)) : null;

    var callDate = icIsoDate_(startMs);
    if (!callDate) return;

    records.push({
      callId:       root,
      callDate:     callDate,
      callStart:    icIsoTime_(startMs),
      calleeNumber: calleeNumber,          // hashed at write; never stored raw
      agentName:    agentName,
      agentExt:     agentExt,
      department:   dept,
      connected:    connected,
      talkSeconds:  talkSeconds,
      ringSeconds:  ringSeconds,
      attempts:     extLegs.length,
      journey:      icBuildJourney_(legs)
    });
  });

  return records;
}

// ---- Neon mirror (best-effort; mirrors writeInboundCallsToNeon) -------------

/**
 * Builds outbound-call records from Raw Data values and mirrors them to
 * Neon's `outbound_calls`. Best-effort: never throws into the import caller.
 * Idempotent via ON CONFLICT (call_date, call_id) DO UPDATE.
 *
 * `opts.authoritative` = per-date REPLACE (DELETE the payload's dates in the
 * same txn before the upsert) -- outbound_calls has NO sheet primary, so a
 * shrinking re-import would otherwise leave phantoms (the L2/IMP-5 rule).
 * `opts.expectedDateIso` = the P-1/F2-class guard: records are dated from
 * their own first leg, so a stray carry-over leg must be DROPPED (its home
 * date's import owns it) and the authoritative DELETE pinned to the expected
 * date. Every caller passes both (daily import, backfill, deferred mirror).
 */
function writeOutboundCallsToNeon(rawRows, opts) {
  var authoritative = !!(opts && opts.authoritative);
  var expectedDateIso = (opts && opts.expectedDateIso) ? String(opts.expectedDateIso) : '';
  try {
    var records = buildOutboundCallRecords_(rawRows).filter(function (r) { return r.callDate; });
    if (expectedDateIso) {
      var strayCount = 0;
      records = records.filter(function (r) {
        if (r.callDate === expectedDateIso) return true;
        strayCount++;
        return false;
      });
      if (strayCount) {
        Logger.log('writeOutboundCallsToNeon: dropped %s stray record(s) dated outside %s '
          + '(carry-over legs; their home date owns them -- P-1 guard).',
          strayCount, expectedDateIso);
      }
    }
    if (!records.length) return { inserted: 0, skipped: 0 };

    var secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
    if (!secret) {
      Logger.log('writeOutboundCallsToNeon: HMAC_SECRET not set — writing with NULL callee_hash '
        + '(rows heal on re-import once set).');
    }
    var conn = getReachableNeonConn_();
    if (!conn) {
      Logger.log('writeOutboundCallsToNeon: Neon unreachable — skipping %s records.', records.length);
      return { inserted: 0, skipped: records.length };
    }
    conn.setAutoCommit(false);
    try {
      var ddl = conn.createStatement();
      ddl.execute(
        'CREATE TABLE IF NOT EXISTS outbound_calls (' +
        'call_date date NOT NULL, call_id text NOT NULL, callee_hash text, ' +
        'agent_name text, agent_ext text, department text, ' +
        'connected boolean, talk_seconds integer, ring_seconds integer, ' +
        'attempts integer, call_start text, journey text, ' +
        'updated_at timestamptz NOT NULL DEFAULT now(), ' +
        'PRIMARY KEY (call_date, call_id))');
      // The Caller Lookup access path is by hash -- create the index here so
      // no operator console step is needed (idempotent, tiny table at first).
      ddl.execute('CREATE INDEX IF NOT EXISTS idx_outbound_calls_callee_hash '
        + 'ON outbound_calls (callee_hash, call_date)');
      ddl.close();

      if (authoritative) {
        var dateSet = {};
        records.forEach(function (r) { if (r.callDate) dateSet[r.callDate] = true; });
        var authDates = Object.keys(dateSet);
        if (authDates.length) {
          var delStmt = conn.createStatement();
          delStmt.execute('DELETE FROM outbound_calls WHERE call_date IN ('
            + authDates.map(function (d) { return icSqlStr_(d) + '::date'; }).join(',') + ')');
          delStmt.close();
        }
      }

      var cols = 'call_date, call_id, callee_hash, agent_name, agent_ext, department, ' +
        'connected, talk_seconds, ring_seconds, attempts, call_start, journey';
      var onConflict = ' ON CONFLICT (call_date, call_id) DO UPDATE SET ' +
        'callee_hash=EXCLUDED.callee_hash, agent_name=EXCLUDED.agent_name, ' +
        'agent_ext=EXCLUDED.agent_ext, department=EXCLUDED.department, ' +
        'connected=EXCLUDED.connected, talk_seconds=EXCLUDED.talk_seconds, ' +
        'ring_seconds=EXCLUDED.ring_seconds, attempts=EXCLUDED.attempts, ' +
        'call_start=EXCLUDED.call_start, journey=EXCLUDED.journey, updated_at=now()';

      // Same inline-tuple + size-aware chunking discipline as the inbound
      // writer (journey rows vary widely; fixed row counts overran the JDBC
      // statement cap on heavy days).
      var tuples = records.map(function (r) {
        var hash = (secret && r.calleeNumber) ? cdrHashPhone_(r.calleeNumber, secret) : null;
        return '(' + icSqlStr_(r.callDate) + '::date,' + icSqlStr_(r.callId) + ',' + icSqlHash_(hash)
          + ',' + icSqlStr_(r.agentName) + ',' + icSqlStr_(r.agentExt) + ',' + icSqlStr_(r.department)
          + ',' + (r.connected ? 'TRUE' : 'FALSE') + ',' + icSqlInt_(r.talkSeconds)
          + ',' + icSqlInt_(r.ringSeconds) + ',' + icSqlInt_(r.attempts)
          + ',' + icSqlStr_(r.callStart)
          + ',' + icSqlStr_(r.journey && r.journey.length ? JSON.stringify(r.journey) : null) + ')';
      });

      var stmt = conn.createStatement();
      var batches = icChunkTuplesByChars_(tuples, IC_SQL_CHUNK_BUDGET_CHARS);
      for (var bi = 0; bi < batches.length; bi++) {
        stmt.execute('INSERT INTO outbound_calls (' + cols + ') VALUES '
          + batches[bi].join(',') + onConflict);
      }
      stmt.close();
      conn.commit();
      Logger.log('writeOutboundCallsToNeon: wrote ' + records.length + ' outbound-call records ('
        + batches.length + ' chunks).');
      return { inserted: records.length, skipped: 0 };
    } catch (e) {
      try { conn.rollback(); } catch (re) {}
      throw e;
    } finally {
      try { conn.close(); } catch (ce) {}
    }
  } catch (e) {
    Logger.log('writeOutboundCallsToNeon failed (best-effort): ' + (e && e.message ? e.message : e));
    return { inserted: 0, skipped: 0, error: true };
  }
}

// ---- Historical backfill (editor-run; mirrors backfillInboundCalls) ---------

function ocFetchMirroredDates_() {
  var out = {};
  var conn = null;
  try {
    conn = getReachableNeonConn_();
    if (!conn) return out;
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery(
      "SELECT COALESCE(json_agg(DISTINCT call_date::text), '[]')::text AS j FROM outbound_calls");
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    JSON.parse(json || '[]').forEach(function (d) { out[String(d)] = true; });
  } catch (e) {
    Logger.log('ocFetchMirroredDates_: ' + (e && e.message ? e.message : e)
      + ' — treating no dates as mirrored.');
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
  return out;
}

/** Editor-run FORCE variant (the Run picker can't pass arguments). */
function backfillOutboundCallsForce() {
  return backfillOutboundCalls(null, null, true);
}

/**
 * EDITOR-RUN. Backfills Neon's `outbound_calls` from the surviving
 * `Call_Legs_YYYY-MM-DD` sheets -- run once right after deploying this
 * capture to grab the ~14-day retention window; the daily integrated path
 * covers everything after. Same contract as backfillInboundCalls: date-range
 * args optional, already-mirrored dates skipped unless force, time-budgeted
 * (re-run to resume), stops on Neon-unreachable, Pipeline Health summary row
 * (step 'outboundBackfill'). Dates whose Call_Legs sheet was pruned are gone.
 */
function backfillOutboundCalls(fromIso, toIso, force) {
  var startMs = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var candidates = [];
  ss.getSheets().forEach(function (s) {
    var m = s.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
    if (!m) return;
    var iso = m[1];
    if (fromIso && iso < fromIso) return;
    if (toIso && iso > toIso) return;
    candidates.push({ iso: iso, sheet: s });
  });
  candidates.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });
  if (!candidates.length) {
    Logger.log('backfillOutboundCalls: no Call_Legs_* sheets found'
      + (fromIso || toIso ? ' in range ' + (fromIso || '...') + '..' + (toIso || '...') : '') + '.');
    return { inserted: 0, processed: 0, skippedDone: 0, skippedEmpty: 0,
             failures: 0, unreachable: false, stoppedEarly: null,
             sheetsFound: 0 };   // IMP-11 shape: lets the deferred mirror detect a pruned source
  }

  var doneDates = force ? {} : ocFetchMirroredDates_();

  var processed = 0, skippedDone = 0, skippedEmpty = 0, totalRecords = 0;
  var failures = [];
  var stoppedEarly = null;
  var unreachable = false;

  for (var i = 0; i < candidates.length; i++) {
    if (Date.now() - startMs > IC_BACKFILL_TIME_LIMIT_MS) {
      stoppedEarly = 'time budget reached at ' + candidates[i].iso
        + ' (' + (candidates.length - i) + ' sheets left) — run again to continue';
      break;
    }
    var c = candidates[i];
    if (doneDates[c.iso]) { skippedDone++; continue; }

    try {
      var legs = c.sheet.getDataRange().getDisplayValues();
      legs.shift();   // header row
      if (!legs.length) { skippedEmpty++; continue; }
      var res = writeOutboundCallsToNeon(legs, { authoritative: true, expectedDateIso: c.iso });
      if (res && res.error) {
        failures.push(c.iso);
      } else if (res && res.skipped && !res.inserted) {
        unreachable = true;
        stoppedEarly = 'Neon unreachable at ' + c.iso + ' — re-run once Neon is up';
        break;
      } else {
        processed++;
        totalRecords += (res && res.inserted) || 0;
      }
    } catch (e) {
      failures.push(c.iso + ' (' + ((e && e.message) ? e.message : e) + ')');
    }
  }

  var summary = 'backfillOutboundCalls: ' + processed + ' date(s) written ('
    + totalRecords + ' records), ' + skippedDone + ' already mirrored, '
    + skippedEmpty + ' empty'
    + (failures.length ? ', FAILED: ' + failures.join(', ') : '')
    + (stoppedEarly ? ' | STOPPED: ' + stoppedEarly : ' | complete')
    + ' | ' + Math.round((Date.now() - startMs) / 1000) + 's';
  Logger.log(summary);

  try {
    if (typeof logPipelineHealthWithFallback_ === 'function') {
      logPipelineHealthWithFallback_(null, {
        step:       'outboundBackfill',
        status:     failures.length ? 'failure' : 'success',
        rows:       totalRecords,
        durationMs: Date.now() - startMs,
        notes:      summary.slice(0, 480),
      });
    }
  } catch (e) { /* best-effort */ }

  return { inserted: totalRecords, processed: processed, skippedDone: skippedDone,
           skippedEmpty: skippedEmpty, failures: failures.length,
           unreachable: unreachable, stoppedEarly: stoppedEarly,
           sheetsFound: candidates.length };
}
