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
// the queue journey (entry/final queue, num_queues, num_transfers), the call
// start time (call_start, 'HH:MM:SS' in the CDR's native timezone), and the
// full leg-by-leg JOURNEY (ordered events: IVR/queue/agent legs with
// timestamps, durations, talk/hold seconds, and missed/abandoned flags) --
// the raw legs are pruned at 14 days (DeleteOldSheets), so the journey
// column is the only durable record of the per-call path. Consumed by the
// dashboard's Caller Lookup (CallerLookup.gs).
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

// 'HH:MM:SS' (zero-padded -> lexicographically sortable within a day).
function icIsoTime_(ms) {
  if (isNaN(ms)) return null;
  var d = new Date(ms);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// Journey size caps. 40 events covers every real call shape we've seen
// (a pathological re-ring loop gets truncated, not dropped); 80 chars
// bounds a runaway callee-name cell.
var IC_JOURNEY_MAX_EVENTS = 40;
var IC_JOURNEY_NAME_MAX = 80;

/**
 * PURE. Ordered leg-by-leg journey for one call (legs pre-sorted by
 * start). Each event: { t: 'HH:MM:SS', name, kind: queue|answer|leg,
 * secs?, talk?, hold?, missed?, abandoned? }. 'leg' covers both IVR
 * legs and missed agent rings -- the CDR doesn't distinguish them
 * reliably, and the name makes it obvious to a human reader.
 *
 * PHI guard: a callee NAME that looks like a phone number (external
 * forward) is masked -- `inbound_calls` carries hashes only, never raw
 * numbers. Caller-side fields (number, CNAM name) are never included.
 */
function icBuildJourney_(legs) {
  var events = [];
  for (var i = 0; i < legs.length && events.length < IC_JOURNEY_MAX_EVENTS; i++) {
    var l = legs[i];
    var rawName = String(l[IC_COL.CALLEE_NAME] == null ? '' : l[IC_COL.CALLEE_NAME]).trim();
    var isQueue = icIsQueueName_(rawName);
    var name = rawName;
    if (/^\+?[\d\s\-().]{7,}$/.test(name)) name = '(external number)';
    if (!name || name.toUpperCase() === 'N/A') name = '(unknown)';
    var talk = icTimeToSec_(l[IC_COL.TALK]);
    var hold = icTimeToSec_(l[IC_COL.CALLEE_HOLD_DURATION]);
    var answered = talk > 0
      && String(l[IC_COL.ANSWERED] == null ? '' : l[IC_COL.ANSWERED]).trim() === 'Answered';
    var startMs = icParseTs_(l[IC_COL.START]);
    var stopMs  = icParseTs_(l[IC_COL.STOP]);
    var ev = {
      t: icIsoTime_(startMs),
      name: name.slice(0, IC_JOURNEY_NAME_MAX),
      kind: isQueue ? 'queue' : (answered ? 'answer' : 'leg'),
    };
    if (!isNaN(startMs) && !isNaN(stopMs)) ev.secs = Math.max(0, Math.round((stopMs - startMs) / 1000));
    if (talk > 0) ev.talk = talk;
    if (hold > 0) ev.hold = hold;
    if (String(l[IC_COL.ABANDONED] == null ? '' : l[IC_COL.ABANDONED]).trim() === 'Abandoned') {
      ev.abandoned = true;
    } else if (!answered
        && String(l[IC_COL.MISSED] == null ? '' : l[IC_COL.MISSED]).trim() === 'Missed') {
      ev.missed = true;
    }
    events.push(ev);
  }
  return events;
}

// SQL literal builders for the INLINE inbound insert (mirrors the phone-child
// inline approach: eliminates ~14 JDBC bind-bridge calls per row, the
// dominant per-row Apps Script cost). Free-text fields are single-quote
// escaped; ints/bools/hash are inherently safe.
function icSqlStr_(s) { return (s == null || s === '') ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'"; }
function icSqlInt_(n) { var v = parseInt(n, 10); return isFinite(v) ? String(v) : 'NULL'; }
function icSqlHash_(h) { return (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) ? "'" + h + "'" : 'NULL'; }

// Per-statement budget for the VALUES payload. Apps Script's JDBC bridge
// rejects oversized SQL strings with "Argument too large: sql" (observed
// on the 2026-06-08 import); 30K chars leaves generous headroom under
// the cap while keeping round-trips low (~10-150 rows per statement
// depending on journey weight).
var IC_SQL_CHUNK_BUDGET_CHARS = 30000;

/**
 * PURE. Splits SQL VALUES tuples into batches whose joined length stays
 * within `budgetChars`. Size-aware because journey rows vary ~30x in
 * size -- a fixed row count can't be both safe and efficient. A single
 * tuple larger than the budget still gets its own batch (journeys are
 * capped at IC_JOURNEY_MAX_EVENTS, so a lone tuple can't approach the
 * actual JDBC cap).
 */
function icChunkTuplesByChars_(tuples, budgetChars) {
  var batches = [];
  var cur = [], len = 0;
  for (var i = 0; i < tuples.length; i++) {
    var t = String(tuples[i]);
    if (cur.length && len + t.length + 1 > budgetChars) {
      batches.push(cur);
      cur = []; len = 0;
    }
    cur.push(t);
    len += t.length + 1;   // +1 for the joining comma
  }
  if (cur.length) batches.push(cur);
  return batches;
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
      callStart:       icIsoTime_(firstStart),
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
      numTransfers:    Math.max(0, queues.length - 1),
      journey:         icBuildJourney_(legs)
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
        'call_start text, journey text, ' +
        'updated_at timestamptz NOT NULL DEFAULT now(), ' +
        'PRIMARY KEY (call_date, call_id))');
      // Idempotent column adds for tables created before the journey
      // capture (the CREATE above only fires on a fresh database).
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS call_start text');
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS journey text');
      ddl.close();

      var cols = 'call_date, call_id, caller_hash, dial_in_number, disposition, ' +
        'abandon_stage, abandoned_on_hold, hold_seconds, wait_seconds, entry_queue, ' +
        'final_queue, final_dept, num_queues, num_transfers, call_start, journey';
      var onConflict = ' ON CONFLICT (call_date, call_id) DO UPDATE SET ' +
        'caller_hash=EXCLUDED.caller_hash, dial_in_number=EXCLUDED.dial_in_number, ' +
        'disposition=EXCLUDED.disposition, abandon_stage=EXCLUDED.abandon_stage, ' +
        'abandoned_on_hold=EXCLUDED.abandoned_on_hold, hold_seconds=EXCLUDED.hold_seconds, ' +
        'wait_seconds=EXCLUDED.wait_seconds, entry_queue=EXCLUDED.entry_queue, ' +
        'final_queue=EXCLUDED.final_queue, final_dept=EXCLUDED.final_dept, ' +
        'num_queues=EXCLUDED.num_queues, num_transfers=EXCLUDED.num_transfers, ' +
        'call_start=EXCLUDED.call_start, journey=EXCLUDED.journey, updated_at=now()';

      // INLINE multi-row upsert (no bound params) -- removes ~16 JDBC
      // bind-bridge calls PER ROW (the dominant cost; ~40ms each in Apps
      // Script). caller_hash is hex, dates/ints/bools are safe, and the
      // free-text fields (incl. the journey JSON string) are escaped via
      // icSqlStr_, so inlining is injection-safe. Chunking is SIZE-AWARE
      // (icChunkTuplesByChars_): journey rows vary ~0.2-6KB each, so a
      // fixed row count either wastes round-trips or -- as the 2026-06-08
      // import proved when a heavy-journey chunk threw "Argument too
      // large: sql" -- overruns Apps Script's JDBC statement-size cap.
      var tBuild = Date.now();
      var tuples = records.map(function (r) {
        var hash = (secret && r.callerNumber) ? cdrHashPhone_(r.callerNumber, secret) : null;
        return '(' + icSqlStr_(r.callDate) + '::date,' + icSqlStr_(r.callId) + ',' + icSqlHash_(hash)
          + ',' + icSqlStr_(r.dialIn) + ',' + icSqlStr_(r.disposition) + ',' + icSqlStr_(r.abandonStage)
          + ',' + (r.abandonedOnHold ? 'TRUE' : 'FALSE') + ',' + icSqlInt_(r.holdSeconds)
          + ',' + icSqlInt_(r.waitSeconds) + ',' + icSqlStr_(r.entryQueue) + ',' + icSqlStr_(r.finalQueue)
          + ',' + icSqlStr_(r.finalDept) + ',' + icSqlInt_(r.numQueues) + ',' + icSqlInt_(r.numTransfers)
          + ',' + icSqlStr_(r.callStart)
          + ',' + icSqlStr_(r.journey && r.journey.length ? JSON.stringify(r.journey) : null) + ')';
      });
      var buildMs = Date.now() - tBuild;

      var tInsert = Date.now();
      var stmt = conn.createStatement();
      var batches = icChunkTuplesByChars_(tuples, IC_SQL_CHUNK_BUDGET_CHARS);
      for (var bi = 0; bi < batches.length; bi++) {
        stmt.execute('INSERT INTO inbound_calls (' + cols + ') VALUES '
          + batches[bi].join(',') + onConflict);
      }
      var chunks = batches.length;
      stmt.close();
      conn.commit();
      var insertMs = Date.now() - tInsert;
      Logger.log('writeInboundCallsToNeon: wrote ' + records.length + ' inbound-call records | '
        + 'build ' + buildMs + 'ms | insert ' + insertMs + 'ms (' + chunks + ' chunks).');
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

// ---- Historical backfill (editor-run) ----------------------------------------

// Per-invocation wall-clock budget before pausing. Dates already mirrored
// are skipped on the next run (date-level skip is safe: each date's write
// is one transaction -- single commit in writeInboundCallsToNeon -- so a
// timeout can't leave a half-written date behind). 15 min mirrors the
// bulk-rebuild budget, leaving margin under the 30-min execution ceiling.
var IC_BACKFILL_TIME_LIMIT_MS = 15 * 60 * 1000;

/**
 * EDITOR-RUN. Backfills Neon's `inbound_calls` from the per-day
 * `Call_Legs_YYYY-MM-DD` sheets still present in THIS (source)
 * spreadsheet. The daily integrated path only captures inbound calls
 * going forward; this fills in history for dates imported before the
 * inbound capture shipped (or after an outage).
 *
 * Behavior:
 *   - No args: processes EVERY Call_Legs_* sheet, oldest first.
 *   - Optional fromIso / toIso ('YYYY-MM-DD') bound the date range.
 *   - Dates already present in `inbound_calls` are SKIPPED (one
 *     json_agg'd SELECT DISTINCT up front -- per-row JDBC iteration is
 *     ~0.5s/row, so the result is fetched as a single string). Pass
 *     force=true to re-process them (idempotent via ON CONFLICT
 *     DO UPDATE, so a force re-run refreshes rather than duplicates).
 *   - Time-budgeted (IC_BACKFILL_TIME_LIMIT_MS): on hitting the budget
 *     it logs progress and returns; just run it again -- completed
 *     dates are skipped, so each run resumes where the last stopped.
 *   - Stops early if Neon reports unreachable for a date (no point
 *     hammering a suspended instance; re-run later).
 *   - Best-effort Pipeline Health summary row (step 'inboundBackfill')
 *     per run via logPipelineHealthWithFallback_ (autoImport.js, same
 *     project), so the run is visible in the dashboard's Alerts modal.
 *
 * Coverage note: this can only backfill dates whose Call_Legs_* sheet
 * still exists -- days pruned by DeleteOldSheets are gone from the
 * sheet side and cannot be reconstructed.
 */
function backfillInboundCalls(fromIso, toIso, force) {
  var startMs = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Enumerate Call_Legs_* sheets in range, oldest first.
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
    Logger.log('backfillInboundCalls: no Call_Legs_* sheets found'
      + (fromIso || toIso ? ' in range ' + (fromIso || '...') + '..' + (toIso || '...') : '') + '.');
    // F1: return a status object (was a bare `return;` -> undefined) so callers
    // -- notably NeonMirror.js::mirrorInboundForDate_ -- can distinguish
    // "nothing to mirror" from "Neon unreachable" and report a real row count.
    return { inserted: 0, processed: 0, skippedDone: 0, skippedEmpty: 0,
             failures: 0, unreachable: false, stoppedEarly: null };
  }

  // Dates already mirrored (skipped unless force). Missing table /
  // unreachable Neon -> empty set; the per-date writer creates the
  // table and handles unreachability itself.
  var doneDates = force ? {} : icFetchMirroredDates_();

  var processed = 0, skippedDone = 0, skippedEmpty = 0, totalRecords = 0;
  var failures = [];
  var stoppedEarly = null;
  var unreachable = false;   // F1: set when a per-date write reports Neon unreachable

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
      var res = writeInboundCallsToNeon(legs);
      if (res && res.error) {
        failures.push(c.iso);
      } else if (res && res.skipped && !res.inserted) {
        // Neon unreachable for this date -- abort the run; re-run later.
        unreachable = true;   // F1: signal the caller so the date stays queued
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

  var summary = 'backfillInboundCalls: ' + processed + ' date(s) written ('
    + totalRecords + ' records), ' + skippedDone + ' already mirrored, '
    + skippedEmpty + ' empty'
    + (failures.length ? ', FAILED: ' + failures.join(', ') : '')
    + (stoppedEarly ? ' | STOPPED: ' + stoppedEarly : ' | complete')
    + ' | ' + Math.round((Date.now() - startMs) / 1000) + 's';
  Logger.log(summary);

  // Best-effort run telemetry (Pipeline Health lives in the target SS).
  try {
    if (typeof logPipelineHealthWithFallback_ === 'function') {
      logPipelineHealthWithFallback_(null, {
        step:       'inboundBackfill',
        status:     failures.length ? 'failure' : 'success',
        rows:       totalRecords,
        durationMs: Date.now() - startMs,
        notes:      summary.slice('backfillInboundCalls: '.length, 500),
      });
    }
  } catch (logErr) { /* best-effort */ }

  // F1: structured outcome for programmatic callers (mirrorInboundForDate_).
  // `inserted` = records written this run; `unreachable` = Neon was down for a
  // date (caller should keep it queued); `failures` = count of hard per-date
  // write errors. Editor-run callers ignore the return and read the log.
  return {
    inserted:    totalRecords,
    processed:   processed,
    skippedDone: skippedDone,
    skippedEmpty: skippedEmpty,
    failures:    failures.length,
    unreachable: unreachable,
    stoppedEarly: stoppedEarly,
  };
}

/**
 * Distinct call_date values already in `inbound_calls`, as { iso: true }.
 * One json_agg'd query + one getString (per-row JDBC is ~0.5s/row).
 * Best-effort: missing table / unreachable Neon / any error -> {} so the
 * backfill simply attempts every date (idempotent either way).
 */
function icFetchMirroredDates_() {
  var out = {};
  var conn = null;
  try {
    conn = getReachableNeonConn_();
    if (!conn) return out;
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery(
      "SELECT COALESCE(json_agg(DISTINCT call_date::text), '[]')::text AS j FROM inbound_calls");
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    JSON.parse(json || '[]').forEach(function (d) { out[String(d)] = true; });
  } catch (e) {
    Logger.log('icFetchMirroredDates_: ' + (e && e.message ? e.message : e)
      + ' — treating no dates as mirrored.');
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
  return out;
}
