// ============================================================================
// ringCentralAdapter.js -- RingCentral "Call Records" export -> the 8x8
// Raw Data leg layout every reader in this project already consumes.
//
// STATUS: SKELETON, NOT WIRED IN. Nothing calls this file yet. It exists so
// the RingCentral cutover (docs/ringcentral-migration-plan.md) starts from a
// tested, header-driven converter instead of a blank page. Do NOT call it
// from processNewImport until the plan's "before wiring" checklist is done:
// the rows it emits today are FLAT (every hop is its own parent), and the DQE
// build, the inbound capture and the queue report all read 8x8's leg TREE
// (a main call plus per-agent "CallForking" satellite rows pointing back at
// it with Parent Call ID). Fed flat rows they would count every hop as a
// separate call. Synthesizing that tree needs a real multi-hop RingCentral
// export (queue rings, abandons, transfers), which does not exist yet.
//
// Why a converter at all: ~13 files read the 8x8 grid by column POSITION
// (DQE_C / IC_COL / calculateMetricsInMemory's idx / calcQcdReport's row[N]).
// Converting at the one ingest point keeps all of them, and their test
// suites, unchanged.
//
// Design rules:
//   - RingCentral columns are found by HEADER NAME (case/space/punctuation
//     insensitive), never by position: an export setting that adds, drops or
//     reorders a column must not shift every field silently.
//   - Input is DISPLAY strings (getDisplayValues), the INV-02 rule: a Date or
//     number cell is reported as a problem, not guessed at.
//   - The export's Date-Time is CENTRAL wall time (owner, 2026-11-09). 8x8's
//     Raw Data is PACIFIC wall time and the pipeline adds DQE_PST_TO_CST
//     itself, so this file shifts Central -> Pacific (-2h) to keep that true.
//   - Every mapping that is a GUESS is tagged "ASSUMPTION A<n>" here and
//     listed under the same number in the plan doc, so a sample that
//     disproves one points at exactly one place to change.
//
// Everything here is PURE (no Apps Script globals) and unit-tested by
// tests/unit/ringcentral-adapter.test.js.
// ============================================================================

// The 8x8 Raw Data layout this converter writes (0-based). Must agree with
// IC_COL (inboundCalls.js) and DQE_C (buildDQEHistoricalData.js) -- pinned
// by the test suite, which loads all three.
var RC_OUT_COL = {
  CALL_ID: 0, LEG_ID: 1, START: 2, CONNECTED: 3, STOP: 4, DIRECTION: 5,
  TALK: 6, CALL_TIME: 7, CALLER: 8, CALLER_NAME: 9, CALLEE: 10, CALLEE_NAME: 11,
  CONTEXT: 13, PARENT_CALL_ID: 14, TRANSFER_TO: 15, DIAL_IN: 16, CALLER_ID: 22,
  MISSED: 23, ABANDONED: 24, ANSWERED: 25, CAUSE: 26,
  CALLEE_HOLD_DURATION: 32, CALLEE_DISC_ON_HOLD: 33, CALLER_DISC_ON_HOLD: 34,
  SIP_CALL_ID: 35, DEPARTMENTS: 36, PATH: 43
};

// autoImport.js's MAX_COLS: processNewImport slices every source row to it.
var RC_OUT_WIDTH = 44;

// Header labels for the converted grid. The pipeline reads by position, so
// these are for a human looking at Raw Data, not for any reader.
var RC_OUT_LABELS = (function () {
  var labels = new Array(RC_OUT_WIDTH).fill('');
  var names = {
    CALL_ID: 'Call ID', LEG_ID: 'Leg ID', START: 'Start Time', CONNECTED: 'Connected Time',
    STOP: 'Stop Time', DIRECTION: 'Direction', TALK: 'Talk Time', CALL_TIME: 'Call Time',
    CALLER: 'Caller', CALLER_NAME: 'Caller Name', CALLEE: 'Callee', CALLEE_NAME: 'Callee Name',
    CONTEXT: 'Context', PARENT_CALL_ID: 'Parent Call ID', TRANSFER_TO: 'Transfer To Call ID',
    DIAL_IN: 'Dial-in Number', CALLER_ID: 'Caller ID', MISSED: 'Missed', ABANDONED: 'Abandoned',
    ANSWERED: 'Answered', CAUSE: 'Cause', CALLEE_HOLD_DURATION: 'Callee Hold Duration',
    CALLEE_DISC_ON_HOLD: 'Callee Disconnected On Hold', CALLER_DISC_ON_HOLD: 'Caller Disconnected On Hold',
    SIP_CALL_ID: 'SIP Call ID', DEPARTMENTS: 'Departments', PATH: 'Path'
  };
  Object.keys(names).forEach(function (k) { labels[RC_OUT_COL[k]] = names[k]; });
  return labels;
})();

// RingCentral Analytics "Call Records" table columns, keyed by the
// normalized header text (rcNormHeader_). `required` = the converter cannot
// produce a usable row without it.
var RC_CR_FIELDS = {
  FROM_NAME:     { header: 'From Name',     required: true },
  FROM_NUMBER:   { header: 'From Number',   required: true },
  TO_NAME:       { header: 'To Name',       required: true },
  TO_NUMBER:     { header: 'To Number',     required: true },
  DATE_TIME:     { header: 'Date-Time',     required: true },
  LENGTH:        { header: 'Length',        required: true },
  DIRECTION:     { header: 'Direction',     required: true },
  CALL_TYPE:     { header: 'Call Type',     required: false },
  CALL_RESPONSE: { header: 'Call Response', required: true },
  RESULT:        { header: 'Result',        required: true },
  RINGING:       { header: 'Ringing',       required: false },
  IVR_PROMPT:    { header: 'IVR Prompt',    required: false },
  LIVE_TALK:     { header: 'Live Talk',     required: true },
  HOLD:          { header: 'Hold',          required: false },
  PARK:          { header: 'Park',          required: false },
  TRANSFER:      { header: 'Transfer',      required: false },
  VM_GREETING:   { header: 'VM Greeting',   required: false },
  VOICEMAIL:     { header: 'VoiceMail',     required: false },
  SETUP:         { header: 'Setup',         required: false },
  FORWARDING:    { header: 'Forwarding',    required: false },
  ORIGIN:        { header: 'Origin',        required: true },
  CALL_ID:       { header: 'Call Id',       required: true },
  HOP_ID:        { header: 'Hop Id',        required: true }
};

// The 8x8 Pacific <-> Central gap. Both zones observe DST on the same dates,
// so a fixed 2h shift of WALL time is exact outside the 2 AM changeover hour
// (no business calls). Same figure as DQE_PST_TO_CST, in hours.
var RC_CENTRAL_MINUS_PACIFIC_HOURS = 2;

// How far down the sheet to look for the header row (an Excel export can
// carry title / filter-description rows above it).
var RC_HEADER_SCAN_ROWS = 15;

// The labels an Analytics summary row can put in a text column (the
// aggregation is adjustable in the portal: Sum, Average, ...).
var RC_AGGREGATE_LABEL_RE = /^(sum|total|totals|average|avg|mean|count|min|max|median)$/i;

// ---- pure helpers -----------------------------------------------------------

function rcStr_(v) { return v == null ? '' : String(v).trim(); }

/** Header text -> comparison key: "Date-Time", "date time", "DATE_TIME" all -> "datetime". */
function rcNormHeader_(h) { return rcStr_(h).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** A cell the export left empty. "-" / "N/A" are accepted too (hand-edited samples). */
function rcIsBlank_(v) {
  var s = rcStr_(v);
  return s === '' || s === '-' || /^n\/?a$/i.test(s);
}

/**
 * Index of the Call Records header row in `grid`, or -1. A row counts when it
 * names Call Id, Hop Id and Date-Time -- the three columns no other
 * RingCentral export (e.g. the per-user "Users" summary) carries together.
 */
function rcFindHeaderRow_(grid) {
  var lim = Math.min((grid || []).length, RC_HEADER_SCAN_ROWS);
  for (var i = 0; i < lim; i++) {
    var keys = (grid[i] || []).map(rcNormHeader_);
    if (keys.indexOf('callid') >= 0 && keys.indexOf('hopid') >= 0 && keys.indexOf('datetime') >= 0) return i;
  }
  return -1;
}

/** True when `grid` looks like a RingCentral Call Records export. */
function rcIsCallRecordsGrid_(grid) { return rcFindHeaderRow_(grid) >= 0; }

/**
 * Map each RC_CR_FIELDS key to its column index in `headerRow`.
 * Returns { idx: {KEY: n|-1}, missingRequired: [header...], missingOptional: [...] }.
 */
function rcHeaderIndex_(headerRow) {
  var pos = {};
  (headerRow || []).forEach(function (h, i) {
    var k = rcNormHeader_(h);
    if (k && pos[k] == null) pos[k] = i;   // first occurrence wins
  });
  var idx = {}, missingRequired = [], missingOptional = [];
  Object.keys(RC_CR_FIELDS).forEach(function (key) {
    var f = RC_CR_FIELDS[key];
    var n = pos[rcNormHeader_(f.header)];
    idx[key] = n == null ? -1 : n;
    if (n == null) (f.required ? missingRequired : missingOptional).push(f.header);
  });
  return { idx: idx, missingRequired: missingRequired, missingOptional: missingOptional };
}

/**
 * "HH:MM:SS" / "H:MM:SS" / "MM:SS" -> whole seconds; blank -> 0; anything
 * else (a Date, a bare number, text) -> null so the caller can report it.
 */
function rcDurationToSec_(v) {
  if (rcIsBlank_(v)) return 0;
  if (typeof v !== 'string') return null;
  var m = v.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return m[3] != null
    ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
    : parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Seconds -> 8x8's "H:MM:SS" (unpadded hour, e.g. "0:03:00"). */
function rcSecToHms_(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

/**
 * The export's Date-Time display string -> WALL-clock milliseconds (a UTC
 * epoch used purely as a calendar counter -- no zone is applied). Accepts
 * "MM/DD/YYYY h:mm:ss AM/PM", "MM/DD/YYYY HH:mm[:ss]" and
 * "YYYY-MM-DD HH:mm[:ss]". Returns null for anything else.
 */
function rcParseWallMs_(v) {
  if (typeof v !== 'string') return null;
  var s = v.trim(), y, mo, d, rest;
  var us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(.+)$/);
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](.+)$/);
  if (us) { mo = +us[1]; d = +us[2]; y = +us[3]; rest = us[4]; }
  else if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; rest = iso[4]; }
  else return null;
  var t = rest.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!t) return null;
  var hh = +t[1], mm = +t[2], ss = t[3] != null ? +t[3] : 0, ap = t[4] ? t[4].toLowerCase() : '';
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  var ms = Date.UTC(y, mo - 1, d, hh, mm, ss);
  var chk = new Date(ms);
  if (chk.getUTCDate() !== d || chk.getUTCMonth() !== mo - 1) return null;   // e.g. 02/30
  return ms;
}

/** Wall-clock ms -> 8x8's Raw Data timestamp "MM/DD/YYYY HH:MM:SS" (24h). */
function rcFormatWall_(ms) {
  var t = new Date(ms);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(t.getUTCMonth() + 1) + '/' + p(t.getUTCDate()) + '/' + t.getUTCFullYear() + ' '
    + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds());
}

/** Central wall time -> Pacific wall time (what 8x8's Raw Data holds). */
function rcCentralToPacificMs_(ms) { return ms - RC_CENTRAL_MINUS_PACIFIC_HOURS * 3600 * 1000; }

/**
 * "+1 (770) 6793581" -> "17706793581": 8x8 stored bare digits, and every
 * reader normalizes through a digits-only helper (icDigits_ / icExternalNumber_).
 * Blank -> ''. A value with no digits (e.g. "Anonymous") passes through as-is.
 */
function rcNumber_(v) {
  if (rcIsBlank_(v)) return '';
  var s = rcStr_(v), d = s.replace(/\D/g, '');
  return d || s;
}

/**
 * The 8x8 disposition flags for one hop.
 * ASSUMPTION A5: Answered = Call Response "Answered" (inbound) or "Connected"
 *   (outbound). 8x8 readers also require talk > 0, which they check themselves.
 * ASSUMPTION A6: Missed = an INBOUND/INTERNAL hop that was not answered:
 *   Call Response "Not Answered", or Result "Missed ..." / "Answered elsewhere"
 *   (a queue ring another agent took -- 8x8 marks that agent's ring Missed)
 *   / "Abandoned" (8x8 marks an abandoned queue leg Missed AND Abandoned).
 *   An unconnected OUTBOUND hop is not marked Missed.
 * ASSUMPTION A7: Abandoned = Result "Abandoned".
 * ASSUMPTION A8: Cause "Transfer" = Result "Transferred" (QCD's transfer
 *   counts and the inbound capture key on Cause === 'Transfer').
 */
function rcDisposition_(response, result, outDirection) {
  var resp = rcStr_(response).toLowerCase(), res = rcStr_(result).toLowerCase();
  var answered = resp === 'answered' || resp === 'connected';
  var abandoned = res === 'abandoned';
  var missed = !answered && outDirection !== 'Outgoing'
    && (resp === 'not answered' || /^missed\b/.test(res) || res === 'answered elsewhere' || abandoned);
  return {
    missed: missed ? 'Missed' : '-',
    abandoned: abandoned ? 'Abandoned' : '-',
    answered: answered ? 'Answered' : '-',
    cause: res === 'transferred' ? 'Transfer' : ''
  };
}

/**
 * 8x8 Direction for one hop.
 * ASSUMPTION A3: Origin "Internal" -> 'Internal' (8x8's ext-to-ext value);
 *   otherwise Direction Inbound/Outbound -> 'Incoming'/'Outgoing'.
 * Returns '' for a value it does not recognize (reported by the caller).
 */
function rcDirection_(direction, origin) {
  if (rcStr_(origin).toLowerCase() === 'internal') return 'Internal';
  var d = rcStr_(direction).toLowerCase();
  if (d === 'inbound') return 'Incoming';
  if (d === 'outbound') return 'Outgoing';
  return '';
}

/**
 * Convert a RingCentral Call Records grid (display values, header row
 * somewhere in the first RC_HEADER_SCAN_ROWS rows) into 8x8 Raw Data rows.
 *
 * Returns {
 *   header:  RC_OUT_LABELS copy (prepend it to `rows` to get a full grid),
 *   rows:    [[...44 cells]],
 *   info:    one entry per row -- the RingCentral fields 8x8 has no column
 *            for (call type, raw result/response, segment seconds), kept for
 *            the parity work and the tree synthesis still to come,
 *   skipped: [{ row: <1-based sheet row>, reason }],  -- totals / blank rows
 *   problems:[{ row, field, value, message }],         -- bad cells, skipped too
 *   missingOptional: [header...]
 * }
 * Throws when the header row is absent or a REQUIRED column is missing: a
 * half-mapped day must never reach the historical sheets.
 */
function rcConvertCallRecords_(grid) {
  var hr = rcFindHeaderRow_(grid);
  if (hr < 0) {
    throw new Error('RingCentral export: no header row with "Call Id", "Hop Id" and "Date-Time" in the first '
      + RC_HEADER_SCAN_ROWS + ' rows. Is this the Call Records table export (not the per-user summary)?');
  }
  var hx = rcHeaderIndex_(grid[hr]);
  if (hx.missingRequired.length) {
    throw new Error('RingCentral export: missing required column(s): ' + hx.missingRequired.join(', ')
      + '. The export layout changed -- check the Call Records table\'s column settings.');
  }
  var idx = hx.idx;
  var cell = function (r, key) { return idx[key] < 0 ? '' : r[idx[key]]; };
  var secOf = function (r, key) { return idx[key] < 0 ? 0 : rcDurationToSec_(r[idx[key]]); };

  var rows = [], info = [], skipped = [], problems = [];
  for (var i = hr + 1; i < grid.length; i++) {
    var r = grid[i] || [], sheetRow = i + 1;
    var callId = rcStr_(cell(r, 'CALL_ID'));
    if (rcIsBlank_(callId) || RC_AGGREGATE_LABEL_RE.test(callId)) {
      // Blank lines, and the aggregate rows an Analytics export can carry
      // under its header (the per-user report's "Sum" row; the aggregation
      // is a portal setting, so the label can vary) -- no real Call Id.
      if (r.some(function (v) { return !rcIsBlank_(v); })) skipped.push({ row: sheetRow, reason: 'no Call Id (total or summary row?)' });
      continue;
    }
    var bad = function (field, value, message) {
      problems.push({ row: sheetRow, field: field, value: value == null ? '' : String(value), message: message });
    };

    var startCentral = rcParseWallMs_(cell(r, 'DATE_TIME'));
    if (startCentral == null) { bad('Date-Time', cell(r, 'DATE_TIME'), 'unparseable date-time (read the sheet with getDisplayValues)'); continue; }
    var hopRaw = rcStr_(cell(r, 'HOP_ID'));
    if (!/^\d+$/.test(hopRaw)) { bad('Hop Id', hopRaw, 'Hop Id is not a whole number'); continue; }

    var seg = {}, segBad = false;
    ['LENGTH', 'LIVE_TALK', 'RINGING', 'IVR_PROMPT', 'HOLD', 'PARK', 'TRANSFER',
     'VM_GREETING', 'VOICEMAIL', 'SETUP', 'FORWARDING'].forEach(function (k) {
      var s = secOf(r, k);
      if (s == null) { bad(RC_CR_FIELDS[k].header, cell(r, k), 'not an HH:MM:SS duration'); segBad = true; }
      seg[k] = s || 0;
    });
    if (segBad) continue;

    var dir = rcDirection_(cell(r, 'DIRECTION'), cell(r, 'ORIGIN'));
    if (!dir) { bad('Direction', cell(r, 'DIRECTION'), 'unrecognized direction (expected Inbound / Outbound)'); continue; }
    var disp = rcDisposition_(cell(r, 'CALL_RESPONSE'), cell(r, 'RESULT'), dir);

    var start = rcCentralToPacificMs_(startCentral);
    var out = new Array(RC_OUT_WIDTH).fill('');
    out[RC_OUT_COL.CALL_ID] = callId;
    // ASSUMPTION A1: Leg ID = Hop Id + 1. 8x8 numbers a call's legs from 1,
    // and calcQcdReport keys its per-queue figures on leg "1".
    out[RC_OUT_COL.LEG_ID] = String(parseInt(hopRaw, 10) + 1);
    out[RC_OUT_COL.START] = rcFormatWall_(start);
    // ASSUMPTION A4: the segments run Setup -> IVR -> Forwarding -> Ringing ->
    // Live Talk, so an answered hop connects after the first four. The one
    // sample (12s ring + 48s talk = 60s Length) is consistent with this.
    var preTalk = seg.SETUP + seg.IVR_PROMPT + seg.FORWARDING + seg.RINGING;
    out[RC_OUT_COL.CONNECTED] = disp.answered === 'Answered' ? rcFormatWall_(start + preTalk * 1000) : '';
    out[RC_OUT_COL.STOP] = rcFormatWall_(start + seg.LENGTH * 1000);
    out[RC_OUT_COL.DIRECTION] = dir;
    out[RC_OUT_COL.TALK] = rcSecToHms_(seg.LIVE_TALK);
    // ASSUMPTION A9: 8x8 Call Time = the leg's whole duration = Length.
    out[RC_OUT_COL.CALL_TIME] = rcSecToHms_(seg.LENGTH);
    out[RC_OUT_COL.CALLER] = rcNumber_(cell(r, 'FROM_NUMBER'));
    out[RC_OUT_COL.CALLER_NAME] = rcIsBlank_(cell(r, 'FROM_NAME')) ? '' : rcStr_(cell(r, 'FROM_NAME'));
    out[RC_OUT_COL.CALLEE] = rcNumber_(cell(r, 'TO_NUMBER'));
    out[RC_OUT_COL.CALLEE_NAME] = rcIsBlank_(cell(r, 'TO_NAME')) ? '' : rcStr_(cell(r, 'TO_NAME'));
    // ASSUMPTION A2 (the big one -- see the file header): no tree yet.
    out[RC_OUT_COL.PARENT_CALL_ID] = 'N/A';
    out[RC_OUT_COL.TRANSFER_TO] = 'N/A';      // no RingCentral equivalent found
    out[RC_OUT_COL.DIAL_IN] = 'N/A';          // filled per call below
    out[RC_OUT_COL.MISSED] = disp.missed;
    out[RC_OUT_COL.ABANDONED] = disp.abandoned;
    out[RC_OUT_COL.ANSWERED] = disp.answered;
    out[RC_OUT_COL.CAUSE] = disp.cause;
    out[RC_OUT_COL.CALLEE_HOLD_DURATION] = rcSecToHms_(seg.HOLD);
    out[RC_OUT_COL.CALLEE_DISC_ON_HOLD] = 'N/A';   // no equivalent: hold-hangup flags stay off
    out[RC_OUT_COL.CALLER_DISC_ON_HOLD] = 'N/A';
    out[RC_OUT_COL.DEPARTMENTS] = 'N/A';           // no equivalent
    out[RC_OUT_COL.PATH] = 'N/A';                  // no equivalent (the Sales IVR-path stats)
    rows.push(out);
    info.push({
      sheetRow: sheetRow,
      callType: rcStr_(cell(r, 'CALL_TYPE')),
      callResponse: rcStr_(cell(r, 'CALL_RESPONSE')),
      result: rcStr_(cell(r, 'RESULT')),
      origin: rcStr_(cell(r, 'ORIGIN')),
      hopId: parseInt(hopRaw, 10),
      seconds: seg
    });
  }

  // ASSUMPTION A10: an external inbound call's dial-in number is the To
  // Number of its FIRST incoming hop (the line the caller dialed); every
  // incoming hop of that call carries it, as 8x8's Dial-in column did.
  var firstIncoming = {};
  rows.forEach(function (out, k) {
    if (out[RC_OUT_COL.DIRECTION] !== 'Incoming') return;
    var id = out[RC_OUT_COL.CALL_ID], cur = firstIncoming[id];
    if (cur == null || info[k].hopId < info[cur].hopId) firstIncoming[id] = k;
  });
  rows.forEach(function (out) {
    var k = firstIncoming[out[RC_OUT_COL.CALL_ID]];
    if (k != null && out[RC_OUT_COL.DIRECTION] === 'Incoming' && rows[k][RC_OUT_COL.CALLEE]) {
      out[RC_OUT_COL.DIAL_IN] = rows[k][RC_OUT_COL.CALLEE];
    }
  });

  return {
    header: RC_OUT_LABELS.slice(),
    rows: rows,
    info: info,
    skipped: skipped,
    problems: problems,
    missingOptional: hx.missingOptional
  };
}
