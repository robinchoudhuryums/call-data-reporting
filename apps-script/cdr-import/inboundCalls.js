// ============================================================================
// inboundCalls.js — per-call inbound capture (cdr-import project)
// ----------------------------------------------------------------------------
// Produces ONE record per distinct inbound call (grouped across all legs by
// root Call ID, stitching CallForking satellites via Parent Call ID), then
// mirrors them to Neon's `inbound_calls` table. Complements the per-AGENT
// outbound phone capture in neonWrite.js (call_history_phones); this is the
// CALL-level inbound view.
//
// Validated against real Raw Data scenarios:
//   - answered (single queue + multi-queue bounce / transfer)
//   - abandoned in IVR (never reached a queue)
//   - abandoned in queue (incl. re-ring same agent N times)
//   - answered-then-abandoned-on-hold (caller hung up while held)
//
// Captures: caller_hash (deterministic HMAC, matches insurance_numbers +
// call_history_phones; null for Anonymous), dial_in_number (DID / marketing
// line), disposition (answered|abandoned|missed) + abandon_stage (ivr|queue),
// abandoned_on_hold + hold_seconds, wait_seconds (time-to-answer / -abandon),
// and the queue journey (entry/final queue, num_queues, num_transfers).
//
// buildInboundCallRecords_(rawRows) is PURE (no Apps Script globals) so it's
// unit-tested directly. The Neon write reuses getReachableNeonConn_ +
// cdrHashPhone_ from neonWrite.js (same project, flat global scope).
// ============================================================================

// Raw Data column indices (0-based) — same layout the CDR export uses.
var IC_COL = {
  CALL_ID: 0, LEG_ID: 1, START: 2, CONNECTED: 3, STOP: 4, DIRECTION: 5,
  TALK: 6, CALL_TIME: 7, CALLER: 8, CALLER_NAME: 9, CALLEE: 10, CALLEE_NAME: 11,
  PARENT_CALL_ID: 14, DIAL_IN: 16, MISSED: 23, ABANDONED: 24, ANSWERED: 25,
  CALLEE_HOLD_DURATION: 32, CALLEE_DISC_ON_HOLD: 33, CALLER_DISC_ON_HOLD: 34,
  DEPARTMENTS: 36
};

// ---- pure helpers -----------------------------------------------------------

function icDigits_(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

// An external phone (>= 10 digits) normalized to "+<digits>" so it matches the
// outbound capture + insurance_numbers hashing. Internal exts ("183"),
// "CallQueue (103)", "Anonymous", blanks -> null.
function icExternalNumber_(s) {
  var d = icDigits_(s);
  return d.length >= 10 ? '+' + d : null;
}

function icIsAnonymous_(s) {
  var t = String(s == null ? '' : s).trim();
  return t === '' || /anon|restrict|private|unknown|withheld/i.test(t);
}

function icIsTrue_(s) { return String(s == null ? '' : s).trim().toUpperCase() === 'TRUE'; }

function icIsQueueName_(name) { return /^A_Q_/i.test(String(name == null ? '' : name).trim()); }

// "H:MM:SS" -> seconds (0 on blank/N/A).
function icTimeToSec_(s) {
  var str = String(s == null ? '' : s).trim();
  var p = str.split(':');
  if (p.length !== 3) return 0;
  return (parseInt(p[0], 10) || 0) * 3600 + (parseInt(p[1], 10) || 0) * 60 + (parseInt(p[2], 10) || 0);
}

// "MM/DD/YYYY HH:MM:SS" -> epoch ms (NaN on unparseable).
function icParseTs_(s) {
  var str = String(s == null ? '' : s).trim();
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(str);
  if (!m) return NaN;
  return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime();
}

function icIsoDate_(ms) {
  if (isNaN(ms)) return null;
  var d = new Date(ms);
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

/**
 * PURE. rawRows = array of Raw Data leg rows (each an array indexed per
 * IC_COL). Returns one record per distinct INBOUND call.
 */
function buildInboundCallRecords_(rawRows) {
  if (!rawRows || !rawRows.length) return [];

  // 1) Group legs by ROOT call id (Parent if present, else own) -- stitches
  //    CallForking satellites onto the main inbound call.
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
      return (icParseTs_(a[IC_COL.START]) || 0) - (icParseTs_(b[IC_COL.START]) || 0);
    });

    var incoming = legs.filter(function (l) {
      return String(l[IC_COL.DIRECTION] == null ? '' : l[IC_COL.DIRECTION]).trim() === 'Incoming';
    });
    if (!incoming.length) return;   // not an inbound call (outgoing / internal-only)

    // Caller number: first external number on an incoming leg; else anonymous
    // if the caller is blank/anon; else skip (internal-incoming noise).
    var callerNumber = null;
    for (var k = 0; k < incoming.length; k++) {
      var n = icExternalNumber_(incoming[k][IC_COL.CALLER]);
      if (n) { callerNumber = n; break; }
    }
    var firstCaller = incoming[0][IC_COL.CALLER];
    if (!callerNumber && !icIsAnonymous_(firstCaller)) return;   // not a real external inbound

    // Disposition. Answered = a real talk leg (Talk>0) marked Answered. The
    // zero-talk queue/IVR/recording legs (which also say "Answered") are
    // excluded by the Talk>0 gate.
    var answered = legs.some(function (l) {
      return icTimeToSec_(l[IC_COL.TALK]) > 0
          && String(l[IC_COL.ANSWERED] == null ? '' : l[IC_COL.ANSWERED]).trim() === 'Answered';
    });
    var abandonLeg = null;
    for (var a = 0; a < legs.length; a++) {
      if (String(legs[a][IC_COL.ABANDONED] == null ? '' : legs[a][IC_COL.ABANDONED]).trim() === 'Abandoned') {
        abandonLeg = legs[a]; break;
      }
    }
    var abandoned = !answered && !!abandonLeg;
    var disposition = answered ? 'answered' : (abandoned ? 'abandoned' : 'missed');
    var abandonStage = null;
    if (abandoned) {
      abandonStage = icIsQueueName_(abandonLeg[IC_COL.CALLEE_NAME]) ? 'queue' : 'ivr';
    }

    // Abandoned-on-hold: for inbound the customer is the CALLER, so the
    // signal is Caller Disconnect On Hold = TRUE on an incoming leg. This is
    // independent of `answered` (you can be answered THEN dropped on hold).
    var abandonedOnHold = incoming.some(function (l) { return icIsTrue_(l[IC_COL.CALLER_DISC_ON_HOLD]); });

    // Hold time the caller was parked (max across legs).
    var holdSeconds = 0;
    legs.forEach(function (l) { holdSeconds = Math.max(holdSeconds, icTimeToSec_(l[IC_COL.CALLEE_HOLD_DURATION])); });

    // Queue journey (ordered distinct A_Q_* legs).
    var queues = [];
    legs.forEach(function (l) {
      var cn = String(l[IC_COL.CALLEE_NAME] == null ? '' : l[IC_COL.CALLEE_NAME]).trim();
      if (icIsQueueName_(cn) && queues.indexOf(cn) === -1) queues.push(cn);
    });

    // Final dept = the answering talk leg's Departments (if answered).
    var finalDept = null;
    if (answered) {
      for (var d = 0; d < legs.length; d++) {
        if (icTimeToSec_(legs[d][IC_COL.TALK]) > 0
            && String(legs[d][IC_COL.ANSWERED]).trim() === 'Answered') {
          var dep = String(legs[d][IC_COL.DEPARTMENTS] == null ? '' : legs[d][IC_COL.DEPARTMENTS]).trim();
          if (dep && dep.toUpperCase() !== 'N/A') { finalDept = dep; break; }
        }
      }
    }

    // Dial-in (DID / marketing line) -- first non-N/A on an incoming leg.
    var dialIn = null;
    for (var q = 0; q < incoming.length; q++) {
      var di = icDigits_(incoming[q][IC_COL.DIAL_IN]);
      if (di) { dialIn = di; break; }
    }

    // Wait seconds: from first incoming Start to the first answer Connected,
    // or to the abandon Stop.
    var firstStart = icParseTs_(incoming[0][IC_COL.START]);
    var endMs = NaN;
    if (answered) {
      for (var w = 0; w < legs.length; w++) {
        if (icTimeToSec_(legs[w][IC_COL.TALK]) > 0
            && String(legs[w][IC_COL.ANSWERED]).trim() === 'Answered') {
          endMs = icParseTs_(legs[w][IC_COL.CONNECTED]); break;
        }
      }
    } else if (abandonLeg) {
      endMs = icParseTs_(abandonLeg[IC_COL.STOP]);
    }
    var waitSeconds = (!isNaN(firstStart) && !isNaN(endMs))
      ? Math.max(0, Math.round((endMs - firstStart) / 1000)) : null;

    var callDate = icIsoDate_(firstStart);

    records.push({
      callId:          root,
      callDate:        callDate,
      callerNumber:    callerNumber,           // null = anonymous (hashed later)
      dialIn:          dialIn,
      disposition:     disposition,
      abandonStage:    abandonStage,
      abandonedOnHold: abandonedOnHold,
      holdSeconds:     holdSeconds,
      waitSeconds:     waitSeconds,
      entryQueue:      queues.length ? queues[0] : null,
      finalQueue:      queues.length ? queues[queues.length - 1] : null,
      finalDept:       finalDept,
      numQueues:       queues.length,
      numTransfers:    Math.max(0, queues.length - 1)
    });
  });

  return records;
}

// ---- Neon mirror (best-effort; reuses neonWrite.js helpers) ------------------

/**
 * Builds inbound-call records from the Raw Data values and mirrors them to
 * Neon's `inbound_calls`. Best-effort: never throws into the import caller.
 * Idempotent via ON CONFLICT (call_date, call_id) DO UPDATE, so re-imports
 * refresh. caller_hash uses cdrHashPhone_ (matches insurance_numbers +
 * call_history_phones); null for anonymous callers.
 */
function writeInboundCallsToNeon(rawRows) {
  try {
    var records = buildInboundCallRecords_(rawRows).filter(function (r) { return r.callDate; });
    if (!records.length) return { inserted: 0, skipped: 0 };

    var secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
    var conn = getReachableNeonConn_();
    if (!conn) {
      Logger.log('writeInboundCallsToNeon: Neon unreachable — skipping %s records.', records.length);
      return { inserted: 0, skipped: records.length };
    }
    conn.setAutoCommit(false);
    try {
      var ddl = conn.createStatement();
      ddl.execute(
        'CREATE TABLE IF NOT EXISTS inbound_calls (' +
        'call_date date NOT NULL, call_id text NOT NULL, caller_hash text, ' +
        'dial_in_number text, disposition text, abandon_stage text, ' +
        'abandoned_on_hold boolean, hold_seconds integer, wait_seconds integer, ' +
        'entry_queue text, final_queue text, final_dept text, ' +
        'num_queues integer, num_transfers integer, ' +
        'updated_at timestamptz NOT NULL DEFAULT now(), ' +
        'PRIMARY KEY (call_date, call_id))');
      ddl.close();

      var cols = 'call_date, call_id, caller_hash, dial_in_number, disposition, ' +
        'abandon_stage, abandoned_on_hold, hold_seconds, wait_seconds, entry_queue, ' +
        'final_queue, final_dept, num_queues, num_transfers';
      var onConflict = ' ON CONFLICT (call_date, call_id) DO UPDATE SET ' +
        'caller_hash=EXCLUDED.caller_hash, dial_in_number=EXCLUDED.dial_in_number, ' +
        'disposition=EXCLUDED.disposition, abandon_stage=EXCLUDED.abandon_stage, ' +
        'abandoned_on_hold=EXCLUDED.abandoned_on_hold, hold_seconds=EXCLUDED.hold_seconds, ' +
        'wait_seconds=EXCLUDED.wait_seconds, entry_queue=EXCLUDED.entry_queue, ' +
        'final_queue=EXCLUDED.final_queue, final_dept=EXCLUDED.final_dept, ' +
        'num_queues=EXCLUDED.num_queues, num_transfers=EXCLUDED.num_transfers, updated_at=now()';

      // Batched multi-row upsert so the synchronous import isn't slowed by
      // one round-trip per call. 100 rows/chunk (14 params each, well under
      // the bind-param cap), single commit after all chunks.
      var CHUNK = 100;
      for (var off = 0; off < records.length; off += CHUNK) {
        var slice = records.slice(off, off + CHUNK);
        var placeholders = slice.map(function () { return '(?::date,?,?,?,?,?,?,?,?,?,?,?,?,?)'; }).join(',');
        var stmt = conn.prepareStatement('INSERT INTO inbound_calls (' + cols + ') VALUES ' + placeholders + onConflict);
        var p = 1;
        for (var i = 0; i < slice.length; i++) {
          var r = slice[i];
          var hash = (secret && r.callerNumber) ? cdrHashPhone_(r.callerNumber, secret) : null;
          stmt.setString(p++, r.callDate);
          stmt.setString(p++, r.callId);
          stmt.setString(p++, hash);
          stmt.setString(p++, r.dialIn);
          stmt.setString(p++, r.disposition);
          stmt.setString(p++, r.abandonStage);
          stmt.setBoolean(p++, !!r.abandonedOnHold);
          stmt.setInt(p++, r.holdSeconds || 0);
          if (r.waitSeconds == null) stmt.setString(p++, null); else stmt.setInt(p++, r.waitSeconds);
          stmt.setString(p++, r.entryQueue);
          stmt.setString(p++, r.finalQueue);
          stmt.setString(p++, r.finalDept);
          stmt.setInt(p++, r.numQueues || 0);
          stmt.setInt(p++, r.numTransfers || 0);
        }
        stmt.execute();
        stmt.close();
      }
      conn.commit();
      Logger.log('writeInboundCallsToNeon: wrote %s inbound-call records.', records.length);
      return { inserted: records.length, skipped: 0 };
    } catch (e) {
      try { conn.rollback(); } catch (re) {}
      throw e;
    } finally {
      try { conn.close(); } catch (ce) {}
    }
  } catch (e) {
    Logger.log('writeInboundCallsToNeon failed (best-effort): ' + (e && e.message ? e.message : e));
    return { inserted: 0, skipped: 0, error: true };
  }
}
