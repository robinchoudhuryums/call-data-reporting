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

// Raw Data col P, "Transfer To Call ID" -- the only column that links one
// call to the next (Parent Call ID only joins a call's own queue legs).
var OC_TRANSFER_TO_COL_ = 15;

/**
 * PURE (OBX-1). target root -> the first SOURCE root whose leg names it in
 * Transfer To Call ID. `rootOf` maps every call id to its root (the
 * capture's grouping); a leg naming its own root (a queue leg) is skipped.
 */
function ocTransferSources_(rawRows, rootOf) {
  var out = {};
  var cell = function (v) { var t = String(v == null ? '' : v).trim(); return (!t || t.toUpperCase() === 'N/A') ? '' : t; };
  for (var i = 0; i < (rawRows || []).length; i++) {
    var r = rawRows[i];
    var own = cell(r[IC_COL.CALL_ID]);
    var to = cell(r[OC_TRANSFER_TO_COL_]);
    if (!own || !to) continue;
    var fromRoot = rootOf[own] || own;
    var toRoot = rootOf[to] || to;
    if (toRoot === fromRoot) continue;
    if (!out[toRoot]) out[toRoot] = fromRoot;
  }
  return out;
}

/**
 * PURE. rawRows = Raw Data leg rows (arrays indexed per IC_COL). Returns one
 * record per distinct OUTBOUND external call. When a group dials more than
 * one distinct external number (rare -- conference / sequential consult), the
 * FIRST external callee identifies the call; the journey still shows every
 * leg (masked).
 */
function buildOutboundCallRecords_(rawRows, opts) {
  if (!rawRows || !rawRows.length) return [];
  var keepTransferTargets = !!(opts && opts.keepTransferTargets);

  // Group legs by ROOT call id (Parent if present, else own) -- identical to
  // the inbound stitching so a call can never land in both tables.
  var groups = {};
  var rootOf = {};
  for (var i = 0; i < rawRows.length; i++) {
    var r = rawRows[i];
    var parent = String(r[IC_COL.PARENT_CALL_ID] == null ? '' : r[IC_COL.PARENT_CALL_ID]).trim();
    var own = String(r[IC_COL.CALL_ID] == null ? '' : r[IC_COL.CALL_ID]).trim();
    if (!own) continue;
    var root = (parent && parent.toUpperCase() !== 'N/A') ? parent : own;
    rootOf[own] = root;
    (groups[root] = groups[root] || []).push(r);
  }
  // OBX-1 (owner 2026-10-26): a call another call names in "Transfer To Call
  // ID" is the CONTINUATION of a transfer, not a dial -- 8x8 writes a warm
  // transfer as a new call in which the customer reappears as an Outgoing leg
  // from the receiving rep. Measured over 9 days: 4.1% of captured outbound
  // calls, 99.7% of them also the customer's number live on the source call
  // (Operator State #82). A call's own queue leg names its own call (Parent
  // and Transfer To both = its root) and is ignored. An outbound call handed
  // to a colleague keeps the ORIGINAL agent's call; only the continuation goes.
  var transferFrom = ocTransferSources_(rawRows, rootOf);

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

    // Gate 1b (OBX-1): a transfer's continuation is not a new outbound call.
    if (transferFrom[root] && !keepTransferTargets) {
      records._transferDropped = (records._transferDropped || 0) + 1;
      return;
    }

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

    // Connected = SOMETHING on the far end answered: Talk>0 on an Answered
    // external leg. That is a person OR voicemail OR an IVR OR a call-screening
    // service -- the CDR reports all four identically (verified against
    // labelled calls, 2026-09-22; docs/outbound-callback-dept-plan.md).
    // (zero-talk legs that say "Answered" are ringback/system noise, the
    // same gate the inbound disposition uses).
    var connected = false, talkSeconds = 0, connLeg = null;
    extLegs.forEach(function (l) {
      var t = icTimeToSec_(l[IC_COL.TALK]);
      if (t > 0 && String(l[IC_COL.ANSWERED] == null ? '' : l[IC_COL.ANSWERED]).trim() === 'Answered') {
        connected = true;
        talkSeconds = Math.max(talkSeconds, t);
        if (!connLeg) connLeg = l;   // PIPE-12: the first attempt that connected
      }
    });

    // Ring seconds. Connected: the CONNECTING attempt's own start -> its
    // connected time (PIPE-12, broad-scan 2026-10-12: this used attempt 1's
    // CONNECTED even when a later attempt connected -- a timestamp FO-1 found
    // untrustworthy on a leg that never connected). Not connected: attempt 1's
    // start -> stop, how long it rang before giving up.
    var startMs = icParseTs_(first[IC_COL.START]);
    var ringFrom = connected ? icParseTs_(connLeg[IC_COL.START]) : startMs;
    var edgeMs = connected ? icParseTs_(connLeg[IC_COL.CONNECTED]) : icParseTs_(first[IC_COL.STOP]);
    var ringSeconds = (!isNaN(ringFrom) && !isNaN(edgeMs))
      ? Math.max(0, Math.round((edgeMs - ringFrom) / 1000)) : null;

    var callDate = icIsoDate_(startMs);
    // C-6: a date-less group (unparseable first-leg timestamp) is DROPPED
    // here, before the writer's filter can see it -- count it so the drop is
    // surfaced (array property, the NeonRead `_neonReachable` precedent;
    // keeps the return shape an array for every existing caller).
    if (!callDate) { records._unparsedDropped = (records._unparsedDropped || 0) + 1; return; }

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
      journey:      icBuildJourney_(legs),
      transferFrom: transferFrom[root] || null   // only ever set with opts.keepTransferTargets
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
    // F1: the journey builder classifies leg kind via icIsQueueName_, so load
    // the configured queue names here too (additive; no-op without a sheet).
    if (typeof icResetConfigMemos_ === 'function') icResetConfigMemos_();
    if (typeof icLoadConfiguredQueueNames_ === 'function') icLoadConfiguredQueueNames_();
    // C-6: count date-less records (unparseable first-leg timestamp) -- the
    // outbound BUILDER drops them itself (see buildOutboundCallRecords_), so
    // read its counter; the filter below is a belt-and-suspenders second net.
    var built = buildOutboundCallRecords_(rawRows);
    var unparsedDropped = built._unparsedDropped || 0;
    // OBX-1: transfer continuations the builder left out (not an error).
    if (built._transferDropped) {
      Logger.log('writeOutboundCallsToNeon: left out %s transfer continuation(s) -- a customer handed '
        + 'over by a warm transfer, not a dial (OBX-1, Operator State #82).', String(built._transferDropped));
    }
    var records = built.filter(function (r) {
      if (r.callDate) return true;
      unparsedDropped++;
      return false;
    });
    // PC-1: roster-canonical agent names (inboundCalls.js), so the Outbound
    // report's roster attribution and Agent Day match nickname agents.
    if (typeof icCanonicalizeRecordAgents_ === 'function') icCanonicalizeRecordAgents_(records);
    if (unparsedDropped) {
      Logger.log('writeOutboundCallsToNeon: dropped %s record(s) with no parseable call date '
        + '(unparseable first-leg timestamp?) -- these calls are NOT captured.', unparsedDropped);
    }
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
    if (!records.length) {
      // F2: same zero-record authoritative cleanup as the inbound writer --
      // `outbound_calls` has no sheet primary either, so a date whose
      // legitimate count is zero must still be able to shed stale rows.
      // Gated on a non-empty source so an unreadable grid can't delete data,
      // AND (C-1, mirroring the inbound writer) on zero strays: an all-stray
      // yield is a wrong-day grid, not a zero-call day -- deleting on it
      // would wipe the expected date unrecoverably.
      if (authoritative && expectedDateIso && rawRows && rawRows.length) {
        if (strayCount) {
          Logger.log('writeOutboundCallsToNeon: REFUSING zero-record cleanup for %s -- the source '
            + 'grid yielded %s record(s), ALL dated elsewhere (wrong-day grid?). Stale rows (if '
            + 'any) left in place.', expectedDateIso, strayCount);
          return { inserted: 0, skipped: 0, allStray: true, strayCount: strayCount };
        }
        if (unparsedDropped) {
          // C-6 (the C-1 sibling): all-unparsed = format drift, not a
          // zero-call day; refuse the delete like the inbound writer.
          Logger.log('writeOutboundCallsToNeon: REFUSING zero-record cleanup for %s -- the source '
            + 'grid yielded %s record(s), ALL with unparseable dates (timestamp format drift?). '
            + 'Stale rows (if any) left in place.', expectedDateIso, unparsedDropped);
          return { inserted: 0, skipped: 0, allUnparsed: true, unparsedDropped: unparsedDropped };
        }
        return icDeleteDateOnly_('outbound_calls', expectedDateIso, 'writeOutboundCallsToNeon');
      }
      return { inserted: 0, skipped: 0, unparsedDropped: unparsedDropped };
    }

    var secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
    if (!secret) {
      Logger.log('writeOutboundCallsToNeon: HMAC_SECRET not set — writing with NULL callee_hash '
        + '(rows heal on re-import once set).');
    }
    // C-9: reset the per-run phone-hash memo (the A2 discipline; see the
    // inbound writer for the rotation rationale).
    if (typeof CDR_HMAC_CACHE_ !== 'undefined') CDR_HMAC_CACHE_ = {};
    var conn = getReachableNeonConn_();
    if (!conn) {
      Logger.log('writeOutboundCallsToNeon: Neon unreachable — skipping %s records.', records.length);
      return { inserted: 0, skipped: records.length };
    }
    try {
      // P-9: DDL in AUTOCOMMIT before the transaction opens (see the inbound
      // writer) -- the CREATE INDEX / CREATE TABLE locks release immediately
      // instead of riding to the write's COMMIT.
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
      conn.setAutoCommit(false);   // P-9: the transaction opens AFTER the DDL

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
      return { inserted: records.length, skipped: 0, unparsedDropped: unparsedDropped, hashless: !secret };   // PC-10
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
 * (step 'outboundBackfill'). Dates whose Call_Legs sheet was pruned are gone
 * FROM THE SPREADSHEET -- but the sheet is not necessarily the last copy:
 * `importBulkCSVsFromDrive` rebuilds a `Call_Legs_YYYY-MM-DD` sheet from the
 * source CSV archive in Drive, after which this backfill works normally.
 * Recovery is therefore bounded by that ARCHIVE's retention, not by the
 * 14-day sheet prune. Re-import in small batches -- restoring a wide window
 * at once can push the workbook toward the 10M-cell ceiling.
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
  // PIPE-15 (broad-scan 2026-10-12): without HMAC_SECRET the writer stores a
  // NULL callee_hash, and a FORCE run's authoritative replace would put that
  // NULL over the good hashes an already-mirrored date holds -- callbacks,
  // repeat-caller tracking and insurer labels go blind for those dates, and
  // past the ~14-day Call_Legs window nothing can re-derive them. So a force
  // run with no secret REFUSES each already-mirrored date (a FAILED entry,
  // which keeps a deferred-mirror date queued and loud) and still writes a
  // date Neon has never seen, exactly as the PC-10 daily path does.
  var hashlessGuard = {};
  if (force && !PropertiesService.getScriptProperties().getProperty('HMAC_SECRET')) {
    hashlessGuard = ocFetchMirroredDates_();
    Logger.log('backfillOutboundCalls: HMAC_SECRET not set -- force will NOT rewrite already-mirrored dates '
      + '(their stored callee hashes would become NULL). Set HMAC_SECRET (Operator State #17) and re-run.');
  }

  var processed = 0, skippedDone = 0, skippedEmpty = 0, totalRecords = 0;
  var failures = [];
  // F8 (broad-scan 2026-10-14): dates WRITTEN without phone hashes (no
  // HMAC_SECRET). PC-10 made that a failure on the inline daily path only, so
  // every path that drains through here -- the deferred mirror, the PIPE-7
  // catch-up, an editor run -- logged a plain success while callbacks and
  // insurer labels went blind for those dates.
  var hashlessDates = [];
  var stoppedEarly = null;
  var unreachable = false;

  for (var i = 0; i < candidates.length; i++) {
    // ING-6 (broad-scan 2026-09-23): the TUNABLE budget (P-3, Operator State
    // #70), as the inbound backfill reads it -- the raw constant ignored the
    // IC_BACKFILL_TIME_LIMIT_MS Script Property the probe tells operators to set.
    if (Date.now() - startMs > icBackfillTimeLimitMs_()) {
      stoppedEarly = 'time budget reached at ' + candidates[i].iso
        + ' (' + (candidates.length - i) + ' sheets left) — run again to continue';
      break;
    }
    var c = candidates[i];
    if (doneDates[c.iso]) { skippedDone++; continue; }
    if (hashlessGuard[c.iso]) {   // PIPE-15
      failures.push(c.iso + ' (already mirrored; refused without HMAC_SECRET -- it would NULL the stored callee hashes)');
      continue;
    }

    try {
      var legs = c.sheet.getDataRange().getDisplayValues();
      legs.shift();   // header row
      if (!legs.length) { skippedEmpty++; continue; }
      var res = writeOutboundCallsToNeon(legs, { authoritative: true, expectedDateIso: c.iso });
      if (res && res.error) {
        failures.push(c.iso);
      } else if (res && (res.allStray || res.allUnparsed)) {
        // C-1/C-6: mislabeled/wrong-day sheet or all-unparseable dates --
        // the writer refused; count as a failure.
        failures.push(c.iso + (res.allStray
          ? ' (all ' + res.strayCount + ' record(s) dated outside the sheet\'s date)'
          : ' (all ' + res.unparsedDropped + ' record(s) with unparseable dates)'));
      } else if (res && ((res.skipped && !res.inserted) || res.unreachable)) {
        // res.unreachable also covers the F2 zero-record cleanup arm (no
        // `skipped` count, but the date still needs retrying).
        unreachable = true;
        stoppedEarly = 'Neon unreachable at ' + c.iso + ' — re-run once Neon is up';
        break;
      } else {
        processed++;
        totalRecords += (res && res.inserted) || 0;
        if (res && res.hashless) hashlessDates.push(c.iso);   // F8
      }
    } catch (e) {
      failures.push(c.iso + ' (' + ((e && e.message) ? e.message : e) + ')');
    }
  }

  var summary = 'backfillOutboundCalls: ' + processed + ' date(s) written ('
    + totalRecords + ' records), ' + skippedDone + ' already mirrored, '
    + skippedEmpty + ' empty'
    + (hashlessDates.length ? ', WRITTEN WITHOUT phone hashes: ' + hashlessDates.join(', ')
       + ' (HMAC_SECRET is not set in cdr-import -- callbacks and insurer labels are blind; set it, Operator State #17, then re-run with force)' : '')
    + (failures.length ? ', FAILED: ' + failures.join(', ') : '')
    + (stoppedEarly ? ' | STOPPED: ' + stoppedEarly : ' | complete')
    + ' | ' + Math.round((Date.now() - startMs) / 1000) + 's';
  Logger.log(summary);

  try {
    if (typeof logPipelineHealthWithFallback_ === 'function') {
      logPipelineHealthWithFallback_(null, {
        step:       'outboundBackfill',
        status:     (failures.length || hashlessDates.length) ? 'failure' : 'success',   // F8
        rows:       totalRecords,
        durationMs: Date.now() - startMs,
        notes:      summary.slice(0, 480),
      });
    }
  } catch (e) { /* best-effort */ }

  return { inserted: totalRecords, processed: processed, skippedDone: skippedDone,
           skippedEmpty: skippedEmpty, failures: failures.length,
           unreachable: unreachable, stoppedEarly: stoppedEarly,
           sheetsFound: candidates.length,
           hashless: hashlessDates.length };   // F8: dates written without phone hashes
}

// ---- Transfer hand-overs counted as outbound (read-only diagnostic) ---------
//
// Owner report 2026-10-23: a CSR rep showed an "outbound call" that was really
// a customer handed to them. 8x8 writes a warm transfer as a NEW call: the
// employee who has the customer dials a queue / a colleague (Internal legs),
// talks to them, then merges and drops off -- and the customer reappears in
// that new call as an `Outgoing` leg from the receiving rep. Two signals:
//   (A) TRANSFER TARGET -- another call names this one in Transfer To Call ID.
//       Since OBX-1 the capture LEAVES THESE OUT (buildOutboundCallRecords_);
//       the diagnostic re-includes them (opts.keepTransferTargets) to say how
//       many the rule removes.
//   (B) NUMBER LIVE -- the dialled number was on a live leg of another call
//       within the concurrent slack when this leg began. The first run
//       (2026-10-23, 9 days) found 797 B-only calls (2.2%); the owner's
//       samples were redials after a dropped call -- genuine dials -- so B is
//       NOT a rule. OBX-1 sorts every B-only call by shape:
//         untracked hand-over -- this call holds an Internal leg between this
//             agent and an employee on the other call (the consult signature
//             of a merge 8x8 did not record as a transfer)
//         redial              -- the same agent was on the other call, which
//             had ended by the time this leg began (a dropped call, re-dialled)
//         duplicate dial      -- the other call is also this agent's outbound
//             call to the number and was still live (one dial, two call ids)
//         colleague on the same number -- a DIFFERENT employee's outbound
//             call to the number was still live (OBX-2: the owner's "other"
//             samples were two departments independently calling the same
//             insurer / facility, one of them on hold)
//         crossing call       -- the customer was calling IN (another
//             employee, or no one yet) as the agent dialled out
//         other               -- none of these; samples to look up
// OBX-2 (owner-checked 2026-10-26): every B-only shape is a call someone
// really placed, so the number-live test must NEVER become a capture rule --
// a shared business line (an insurer) overlaps with itself by chance. Each
// B-only call is also flagged when its number is in the insurer reference
// table (Neon insurance_numbers, matched by hash; Operator State #55 keeps
// the sheet block single-reader).
// READ-ONLY: writes nothing; logs call ids + agent names, never a number.
var OC_HANDOFF_SAMPLES_ = 5;
var OC_BONLY_KINDS_ = ['untracked hand-over', 'redial', 'duplicate dial', 'colleague on the same number',
                       'crossing call', 'other'];

/** Digits of an employee extension (1-6 digits), else ''. */
function ocExtDigits_(v) {
  var d = String(v == null ? '' : v).replace(/\D/g, '');
  return (d.length >= 1 && d.length <= 6) ? d : '';
}

/**
 * PURE. Per-call hand-over classification of one day's legs.
 * opts.isInsurer(number) -> boolean flags B-only calls to an insurer's line;
 * the number itself never leaves this function.
 */
function ocTransferHandoffs_(rawRows, opts) {
  var rows = rawRows || [];
  var isInsurer = (opts && typeof opts.isInsurer === 'function') ? opts.isInsurer : null;
  var records = buildOutboundCallRecords_(rows, { keepTransferTargets: true }) || [];
  var slack = (typeof IC_CONCURRENT_SLACK_MS_ === 'number') ? IC_CONCURRENT_SLACK_MS_ : 5000;
  var dirOf = function (l) { return String(l[IC_COL.DIRECTION] == null ? '' : l[IC_COL.DIRECTION]).trim(); };
  var cell = function (v) { var s = String(v == null ? '' : v).trim(); return (!s || s.toUpperCase() === 'N/A') ? '' : s; };

  // Root of every call id (the capture's grouping: Parent if present, else own).
  var rootOf = {}, groups = {};
  rows.forEach(function (r) {
    var own = cell(r[IC_COL.CALL_ID]);
    if (!own) return;
    var root = cell(r[IC_COL.PARENT_CALL_ID]) || own;
    rootOf[own] = root;
    (groups[root] = groups[root] || []).push(r);
  });
  var hasIncoming = {}, extsOf = {};
  Object.keys(groups).forEach(function (g) {
    hasIncoming[g] = groups[g].some(function (l) { return dirOf(l) === 'Incoming'; });
    var ex = {};
    groups[g].forEach(function (l) {
      var a = ocExtDigits_(l[IC_COL.CALLER]), b = ocExtDigits_(l[IC_COL.CALLEE]);
      if (a) ex[a] = true;
      if (b) ex[b] = true;
    });
    extsOf[g] = ex;
  });
  var sourceOf = ocTransferSources_(rows, rootOf);
  // Did the chain that led here start as a customer's INBOUND call?
  function chainStartsInbound(root) {
    for (var hop = 0, r = root; hop < 6 && sourceOf[r]; hop++) {
      r = sourceOf[r];
      if (hasIncoming[r]) return true;
    }
    return false;
  }
  var isOutboundRec = {};
  records.forEach(function (rec) { isOutboundRec[rec.callId] = true; });

  // (B) live legs per external number: [start, stop] of talk > 0 legs.
  var live = {};
  rows.forEach(function (r) {
    if (icTimeToSec_(r[IC_COL.TALK]) <= 0) return;
    var s = icParseTs_(r[IC_COL.START]), e = icParseTs_(r[IC_COL.STOP]);
    if (isNaN(s) || isNaN(e)) return;
    var own = cell(r[IC_COL.CALL_ID]);
    var root = rootOf[own] || own;
    [icExternalNumber_(r[IC_COL.CALLER]), icExternalNumber_(r[IC_COL.CALLEE])].forEach(function (n) {
      if (n) (live[n] = live[n] || []).push({ root: root, s: s, e: e });
    });
  });

  return records.map(function (rec) {
    var legs = groups[rec.callId] || [];
    var first = null;
    for (var i = 0; i < legs.length; i++) {
      if (dirOf(legs[i]) === 'Outgoing' && icExternalNumber_(legs[i][IC_COL.CALLEE])) {
        var t = icParseTs_(legs[i][IC_COL.START]);
        if (!first || t < first.t) first = { leg: legs[i], t: t };
      }
    }
    var match = null, n = null;
    if (first && !isNaN(first.t)) {
      n = icExternalNumber_(first.leg[IC_COL.CALLEE]);
      (live[n] || []).some(function (x) {
        if (x.root === rec.callId) return false;
        if (x.s <= first.t + slack && x.e >= first.t - slack) { match = x; return true; }
        return false;
      });
    }
    var transferFrom = rec.transferFrom || null;
    var out = {
      callId: rec.callId, callDate: rec.callDate, callStart: rec.callStart, agent: rec.agentName || '(unnamed)',
      connected: rec.connected, transferFrom: transferFrom, handoverFrom: match ? match.root : null,
      inboundChain: !!(transferFrom && chainStartsInbound(rec.callId)),
      kind: null, gapSec: null, insurer: false,
    };
    if (!match || transferFrom) return out;

    // B only: what shape is it?
    var me = ocExtDigits_(rec.agentExt) || ocExtDigits_(first.leg[IC_COL.CALLER]);
    var other = extsOf[match.root] || {};
    var sameAgent = !!(me && other[me]);
    var ended = match.e <= first.t + 1000;   // the other leg had stopped as this one began
    out.gapSec = ended ? Math.max(0, Math.round((first.t - match.e) / 1000)) : null;
    var consult = legs.some(function (l) {
      if (dirOf(l) !== 'Internal') return false;
      var a = ocExtDigits_(l[IC_COL.CALLER]), b = ocExtDigits_(l[IC_COL.CALLEE]);
      if (!me || !a || !b) return false;
      var peer = a === me ? b : (b === me ? a : '');
      return !!(peer && peer !== me && other[peer]);
    });
    if (consult) out.kind = 'untracked hand-over';
    else if (sameAgent && ended) out.kind = 'redial';
    else if (sameAgent && isOutboundRec[match.root]) out.kind = 'duplicate dial';
    else if (!sameAgent && isOutboundRec[match.root] && !ended) out.kind = 'colleague on the same number';
    else if (hasIncoming[match.root] && !ended) out.kind = 'crossing call';
    else out.kind = 'other';
    if (isInsurer) { try { out.insurer = !!isInsurer(n); } catch (eIns) { out.insurer = false; } }
    return out;
  });
}

/** PURE. Counts + per-agent tallies + samples over ocTransferHandoffs_ rows. */
function ocSummarizeHandoffs_(rows) {
  var out = { outbound: 0, transferTarget: 0, handover: 0, both: 0, transferOnly: 0, handoverOnly: 0,
              inboundChain: 0, outboundChain: 0, agents: {}, kinds: {}, gaps: { s0to1: 0, s2to5: 0, live: 0 },
              samples: { both: [], transferOnly: [] }, kindSamples: {}, kindsInsurer: {}, insurer: 0 };
  OC_BONLY_KINDS_.forEach(function (k) { out.kinds[k] = 0; out.kindSamples[k] = []; out.kindsInsurer[k] = 0; });
  (rows || []).forEach(function (r) {
    out.outbound++;
    var a = !!r.transferFrom, b = !!r.handoverFrom;
    if (a) {
      out.transferTarget++;
      if (r.inboundChain) out.inboundChain++; else out.outboundChain++;
      out.agents[r.agent] = (out.agents[r.agent] || 0) + 1;
    }
    if (b) out.handover++;
    var cls = a && b ? 'both' : (a ? 'transferOnly' : (b ? 'handoverOnly' : null));
    if (!cls) return;
    out[cls]++;
    var line = r.callId + ' (' + r.agent + ', ' + r.callStart + ') <- ' + (r.transferFrom || r.handoverFrom)
      + (r.inboundChain ? ' [inbound chain]' : '') + (r.gapSec != null ? ' [' + r.gapSec + ' s after]' : '');
    if (cls !== 'handoverOnly') {
      if (out.samples[cls].length < OC_HANDOFF_SAMPLES_) out.samples[cls].push(line);
      return;
    }
    var k = r.kind || 'other';
    out.kinds[k] = (out.kinds[k] || 0) + 1;
    if (r.insurer) { out.insurer++; out.kindsInsurer[k] = (out.kindsInsurer[k] || 0) + 1; }
    if (r.gapSec == null) out.gaps.live++;
    else if (r.gapSec <= 1) out.gaps.s0to1++;
    else out.gaps.s2to5++;
    if ((out.kindSamples[k] = out.kindSamples[k] || []).length < OC_HANDOFF_SAMPLES_) out.kindSamples[k].push(line);
  });
  return out;
}

/**
 * OBX-2: a number -> is-insurer test from Neon's insurance_numbers (hashes
 * only), or { fn: null, why } when it cannot be built. Read-only.
 */
function ocInsurerLookup_() {
  var secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!secret) return { fn: null, why: 'HMAC_SECRET is not set (Operator State #17)' };
  var conn = (typeof getReachableNeonConn_ === 'function') ? getReachableNeonConn_() : null;
  if (!conn) return { fn: null, why: 'Neon unreachable' };
  var hashes = {}, count = 0;
  try {
    var st = conn.createStatement();
    st.setQueryTimeout(20);
    var rs = st.executeQuery('SELECT phone_hash FROM insurance_numbers');
    while (rs.next()) { hashes[rs.getString(1)] = true; count++; }
    rs.close(); st.close();
  } catch (e) {
    return { fn: null, why: 'insurance_numbers unreadable: ' + (e.message || e) };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
  if (!count) return { fn: null, why: 'insurance_numbers is empty (run syncInsuranceNumbersToNeon in cdr-report)' };
  return {
    count: count,
    fn: function (num) { var h = num ? cdrHashPhone_(num, secret) : null; return !!(h && hashes[h]); },
  };
}

/** Whole numbers for the log (Logger prints a JS number as "12.0"). */
function ocN_(n) { return String(Math.round(Number(n) || 0)); }

/**
 * Editor-run, READ-ONLY. `dateIso` = one Call_Legs date, 'all' = every
 * surviving date, blank = the latest. Logs, per date and in total, how many
 * captured outbound calls the transfer rule (A) now leaves out, and what
 * shape the number-live-only (B) calls are.
 */
function diagnoseOutboundTransfers(dateIso) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = [];
  ss.getSheets().forEach(function (s) {
    var m = s.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
    if (m) sheets.push({ iso: m[1], sheet: s });
  });
  sheets.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });
  if (dateIso && dateIso !== 'all') sheets = sheets.filter(function (x) { return x.iso === dateIso; });
  else if (!dateIso) sheets = sheets.slice(-1);
  if (!sheets.length) { Logger.log('[ob-transfer] no Call_Legs sheet for %s.', dateIso || '(latest)'); return null; }
  try { if (typeof icResetConfigMemos_ === 'function') icResetConfigMemos_(); } catch (e0) {}
  try { if (typeof icLoadConfiguredQueueNames_ === 'function') icLoadConfiguredQueueNames_(); } catch (e1) {}
  var ins = ocInsurerLookup_();
  Logger.log('[ob-transfer] insurer flag: %s', ins.fn ? 'on (' + ocN_(ins.count) + ' insurer numbers)' : 'OFF -- ' + ins.why);

  var all = [], t0 = Date.now(), done = 0;
  for (var i = 0; i < sheets.length; i++) {
    if (Date.now() - t0 > 4 * 60 * 1000) { Logger.log('[ob-transfer] stopped at the 4-minute budget before %s.', sheets[i].iso); break; }
    var grid = sheets[i].sheet.getDataRange().getDisplayValues();
    grid.shift();
    var rows = ocTransferHandoffs_(grid, { isInsurer: ins.fn });
    var d = ocSummarizeHandoffs_(rows);
    Logger.log('[ob-transfer] %s: %s outbound calls before the rule; transfer target (A, now left out) %s; number live only (B) %s -- %s',
      sheets[i].iso, ocN_(d.outbound), ocN_(d.transferTarget), ocN_(d.handoverOnly),
      OC_BONLY_KINDS_.map(function (k) { return k + ' ' + ocN_(d.kinds[k]); }).join(', '));
    all = all.concat(rows);
    done++;
  }
  var s = ocSummarizeHandoffs_(all);
  var pct = function (n) { return s.outbound ? (Math.round(n / s.outbound * 1000) / 10) + '%' : '0%'; };
  Logger.log('[ob-transfer] TOTAL %s outbound calls over %s date(s), before the transfer rule.', ocN_(s.outbound), ocN_(done));
  Logger.log('[ob-transfer]   (A) transfer continuations, LEFT OUT of the capture since OBX-1: %s (%s) -- %s from a customer\'s inbound call, %s from an outbound call (the original agent\'s call is kept); %s of them also had the number live (B)',
    ocN_(s.transferTarget), pct(s.transferTarget), ocN_(s.inboundChain), ocN_(s.outboundChain), ocN_(s.both));
  var top = Object.keys(s.agents).sort(function (x, y) { return s.agents[y] - s.agents[x]; }).slice(0, 10);
  if (top.length) Logger.log('[ob-transfer]   left out, by agent: %s', top.map(function (a) { return a + ' ' + ocN_(s.agents[a]); }).join(', '));
  ['both', 'transferOnly'].forEach(function (k) {
    if (s.samples[k].length) Logger.log('[ob-transfer]   %s e.g. (call <- the call it came from): %s', k, s.samples[k].join('; '));
  });
  Logger.log('[ob-transfer]   (B) number live on another call, NO transfer link -- still counted: %s (%s); the other call ended 0-1 s before %s, 2-5 s before %s, was still live %s',
    ocN_(s.handoverOnly), pct(s.handoverOnly), ocN_(s.gaps.s0to1), ocN_(s.gaps.s2to5), ocN_(s.gaps.live));
  if (ins.fn) Logger.log('[ob-transfer]   of those, to an insurer\'s number: %s', ocN_(s.insurer));
  OC_BONLY_KINDS_.forEach(function (k) {
    Logger.log('[ob-transfer]     %s: %s (%s)%s%s', k, ocN_(s.kinds[k]), pct(s.kinds[k]),
      ins.fn ? ', insurer ' + ocN_(s.kindsInsurer[k]) : '',
      s.kindSamples[k].length ? ' e.g. ' + s.kindSamples[k].join('; ') : '');
  });
  return s;
}
/** Every surviving Call_Legs date. */
function diagnoseOutboundTransfersAllDates() { return diagnoseOutboundTransfers('all'); }
