'use strict';

// Unit coverage of the direct-extension call metrics engine
// (cdr-import/directCallMetrics.js) -- the busy/overlap carve-out, the
// internal/external split, the work-window filter, and dedup. The engine is a
// PURE function so it loads + runs in the vm with no Apps Script services.
// See docs/direct-extension-metrics-design.md for the approved definitions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ project: 'cdr-import', files: ['directCallMetrics.js'] });
const compute = h.fn('computeDirectCallMetrics');

// Roster: Anna ext 101 (CSR), Bob ext 102 (CSR). External callers are phones.
const MAPS = {
  extToAgent: { '101': { name: 'Anna', dept: 'CSR' }, '102': { name: 'Bob', dept: 'CSR' } },
  queueExtSet: new Set(['103']),
  exclusions: new Set(['103']),
};

// Raw Data row (>=26 cols). Indices match the engine's column map.
function row(o) {
  const r = new Array(26).fill('');
  r[0]  = o.cid || '';
  r[2]  = o.start || '';                 // "MM/DD/YYYY H:MM:SS"
  r[3]  = o.connected || '';             // CONNECTED (answer time) -- S2C-5
  r[4]  = o.stop || '';                  // STOP
  r[5]  = o.dir || '';                   // Incoming | Internal | Outgoing
  r[6]  = o.talk || '';                  // H:MM:SS
  r[7]  = o.callTime || '';              // H:MM:SS (ring/hold duration)
  r[8]  = o.caller || '';                // CALLER ext/number (col I)
  r[9]  = o.callerName || '';            // CALLER NAME (col J)
  r[10] = o.callee || '';               // CALLEE ext/number (col K)
  r[11] = o.calleeName || '';            // CALLEE NAME (col L) -- e.g. 'A_Q_CSR'
  r[13] = o.ctx || '';                   // CONTEXT ('CallQueue...' => queue leg)
  r[14] = o.parent || '';                // PARENT_CALL (col O)
  r[22] = o.callerId || '';              // CALLER_ID (col W) -- DQE queue marker
  r[23] = o.missed ? 'Missed' : '';
  r[25] = o.answered ? 'Answered' : '';
  return r;
}
function grid(rows) { return [new Array(26).fill('')].concat(rows); }
function rowFor(res, agent) { return res.rows.filter(function (r) { return r.agent === agent; })[0]; }

const D = '03/09/2026 ';   // date prefix; 10:00:00 -> 36000s (in 6:30-15:00 window)

test('inbound external answered -> ib_ext_answered + talk', function () {
  const res = compute(grid([
    row({ cid: 'A', start: D + '10:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:00', caller: '+15551234567', callee: '101', answered: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_answered, 1);
  assert.equal(a.ib_ext_talk_sec, 60);
  assert.equal(a.ib_ext_missed_free, 0);
  assert.equal(a.ib_ext_missed_busy, 0);
});

test('inbound missed with no overlap -> missed_free', function () {
  const res = compute(grid([
    row({ cid: 'A', start: D + '10:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_missed_free, 1);
  assert.equal(a.ib_ext_missed_busy, 0);
});

test('inbound missed while on another (outbound) call -> missed_busy', function () {
  const res = compute(grid([
    // Anna on an outbound call 10:00:00 -> 10:05:00 (300s talk).
    row({ cid: 'OUT', start: D + '10:00:00', dir: 'Outgoing', talk: '0:05:00', callTime: '0:05:00', caller: '101', callee: '+15559999999' }),
    // Inbound ring at 10:02:00 (mid-call) -> excused.
    row({ cid: 'IN', start: D + '10:02:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_missed_busy, 1);
  assert.equal(a.ib_ext_missed_free, 0);
});

test('miss within the 5s wrap-up tail -> busy; miss past the tail -> free', function () {
  // Anna on a call 10:00:00 -> 10:05:00. Tail extends busy to 10:05:05.
  const busyLeg = row({ cid: 'C1', start: D + '10:00:00', dir: 'Outgoing', talk: '0:05:00', callTime: '0:05:00', caller: '101', callee: '+15559999999' });

  const inTail = compute(grid([busyLeg,
    row({ cid: 'R', start: D + '10:05:03', dir: 'Incoming', callTime: '0:00:10', caller: '+15551112222', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(inTail, 'Anna').ib_ext_missed_busy, 1, 'ring 3s after hangup is within the 5s tail');

  const pastTail = compute(grid([busyLeg,
    row({ cid: 'R', start: D + '10:05:08', dir: 'Incoming', callTime: '0:00:10', caller: '+15551112222', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(pastTail, 'Anna').ib_ext_missed_free, 1, 'ring 8s after hangup is past the tail');
});

test('a ring whose CALLER is a queue extension is NOT a direct inbound (queue leak fix)', function () {
  // 103 is the CS-queue ext (in queueExtSet). A "ring" from 103 -> agent is the
  // queue distributing a call, not a direct inbound miss against the agent.
  const res = compute(grid([
    row({ cid: 'Q1', start: D + '11:07:45', dir: 'Internal', callTime: '0:00:20', caller: '103', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna'), undefined, 'ring from queue ext 103 is excluded from direct inbound');
});

test('answered queue call: the agent Outgoing talk leg is NOT a direct outbound (sibling-leg queue fix)', function () {
  // Leg 1 marks the whole call as a queue call (callee 103 / name A_Q_CSR);
  // Leg 4 (same call id) is the agent answering, shown as Outgoing with the
  // talk time -> must NOT count as a direct outbound.
  const res = compute(grid([
    row({ cid: 'QC', start: D + '10:00:00', dir: 'Incoming', caller: '+15551234567', callee: '103', calleeName: 'A_Q_CSR' }),
    row({ cid: 'QC', start: D + '10:00:15', dir: 'Outgoing', talk: '0:04:00', callTime: '0:04:00', caller: '101', callee: '+15551234567' }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.ok(!a || (a.ob_ext_total === 0 && a.ob_int_total === 0),
    'the answered-queue-call Outgoing leg is not counted as a direct outbound');
});

test('queue identified by CALLER_ID marker (A_Q_*) also excludes the call', function () {
  const res = compute(grid([
    row({ cid: 'QW', start: D + '10:30:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', callerId: 'A_Q_CSR', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna'), undefined, 'CALLER_ID A_Q_CSR marks it a queue call, not a direct miss');
});

test('a QUEUE call the agent was on makes them busy for a direct miss', function () {
  const res = compute(grid([
    // Queue leg (ctx CallQueue) Anna answered 10:00:00 -> 10:03:00.
    row({ cid: 'Q', start: D + '10:00:00', dir: 'Incoming', talk: '0:03:00', callTime: '0:03:00', caller: '103', callee: '101', ctx: 'CallQueue(103)', answered: true }),
    // Direct inbound ring at 10:01:30 -> excused (busy on the queue call).
    row({ cid: 'IN', start: D + '10:01:30', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_missed_busy, 1);
  // The queue call itself must NOT be counted as a direct inbound event.
  assert.equal(a.ib_ext_answered, 0);
  assert.equal(a.ib_int_answered, 0);
});

test('hold time extends the busy window', function () {
  const res = compute(grid([
    // Talk 60s + hold 240s (callTime 300) starting 10:00:00 -> busy until 10:05:00.
    row({ cid: 'H', start: D + '10:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:05:00', caller: '+15558888888', callee: '101', answered: true }),
    // Ring at 10:04:00 -- during the HOLD portion (past talk-end 10:01:00) -> busy.
    row({ cid: 'IN', start: D + '10:04:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna').ib_ext_missed_busy, 1);
});

test('S2C-5: busy runs from ANSWER -- a miss during the other call\'s RINGING is missed_free', function () {
  // Anna's other call rang 10:00:00-10:00:40 and was answered at 10:00:40,
  // ending 10:03:00. A direct ring at 10:00:10 came in while that call was
  // still RINGING -- she was free to pick it up, so it is her miss.
  const res = compute(grid([
    row({ cid: 'OTHER', start: D + '10:00:00', connected: D + '10:00:40', stop: D + '10:03:00',
          dir: 'Incoming', talk: '0:02:20', callTime: '0:03:00', caller: '+15550001111', callee: '101', answered: true }),
    row({ cid: 'MISS', start: D + '10:00:10', dir: 'Incoming', callTime: '0:00:15',
          caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_missed_free, 1, 'rang while the other call was still ringing, not answered');
  assert.equal(a.ib_ext_missed_busy, 0);
});

test('S2C-5: a ring AFTER the answer is still excused (busy on the answered call)', function () {
  const res = compute(grid([
    row({ cid: 'OTHER', start: D + '10:00:00', connected: D + '10:00:40', stop: D + '10:03:00',
          dir: 'Incoming', talk: '0:02:20', callTime: '0:03:00', caller: '+15550001111', callee: '101', answered: true }),
    row({ cid: 'MISS', start: D + '10:01:00', dir: 'Incoming', callTime: '0:00:15',
          caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_missed_busy, 1);
  assert.equal(a.ib_ext_missed_free, 0);
});

test('internal vs external split (Internal -> int, Incoming -> ext)', function () {
  const res = compute(grid([
    row({ cid: 'I1', start: D + '11:00:00', dir: 'Internal', callTime: '0:00:15', caller: '102', callee: '101', missed: true }),
    row({ cid: 'E1', start: D + '11:01:00', dir: 'Incoming', callTime: '0:00:15', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_int_missed_free, 1);
  assert.equal(a.ib_ext_missed_free, 1);
});

test('multi-leg inbound call is deduped to one event', function () {
  const res = compute(grid([
    row({ cid: 'M', start: D + '10:00:00', dir: 'Incoming', callTime: '0:00:10', caller: '+15551234567', callee: '101', missed: true }),
    row({ cid: 'M', start: D + '10:00:05', dir: 'Incoming', callTime: '0:00:12', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna').ib_ext_missed_free, 1);
});

test('outbound is activity only: total / connected / talk, int vs ext callee', function () {
  const res = compute(grid([
    // external connected
    row({ cid: 'O1', start: D + '09:00:00', dir: 'Outgoing', talk: '0:02:00', callTime: '0:02:00', caller: '101', callee: '+15559999999' }),
    // external no-answer (talk 0) -> total++ but not connected
    row({ cid: 'O2', start: D + '09:05:00', dir: 'Outgoing', callTime: '0:00:25', caller: '101', callee: '+15557777777' }),
    // internal connected (callee is a known ext)
    row({ cid: 'O3', start: D + '09:10:00', dir: 'Outgoing', talk: '0:00:30', callTime: '0:00:30', caller: '101', callee: '102' }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ob_ext_total, 2);
  assert.equal(a.ob_ext_connected, 1);
  assert.equal(a.ob_ext_talk_sec, 120);
  assert.equal(a.ob_int_total, 1);
  assert.equal(a.ob_int_connected, 1);
  assert.equal(a.ob_int_talk_sec, 30);
});

test('rings outside the 6:30-15:00 work window are NOT counted', function () {
  const res = compute(grid([
    row({ cid: 'EARLY', start: D + '05:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
    row({ cid: 'LATE',  start: D + '16:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a, undefined, 'no in-window direct events -> Anna has no row');
});

test('busy detection uses calls even when they START before the window', function () {
  const res = compute(grid([
    // Outbound call starts 6:25 (before window) and runs to 6:35.
    row({ cid: 'PRE', start: D + '06:25:00', dir: 'Outgoing', talk: '0:10:00', callTime: '0:10:00', caller: '101', callee: '+15559999999' }),
    // In-window ring at 6:32 -> excused (agent still on the pre-window call).
    row({ cid: 'IN', start: D + '06:32:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna').ib_ext_missed_busy, 1);
});

test('collectSamples: examples are gathered, and a missed_busy sample names its blocker', function () {
  const res = compute(grid([
    row({ cid: 'OUT', start: D + '10:00:00', dir: 'Outgoing', talk: '0:05:00', callTime: '0:05:00', caller: '101', callee: '+15559999999' }),
    row({ cid: 'IN',  start: D + '10:02:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
    row({ cid: 'FREE', start: D + '13:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15558887777', callee: '101', missed: true }),
  ]), MAPS, { collectSamples: true });
  const s = res.meta.samples;
  assert.ok(s, 'samples present when collectSamples=true');
  assert.equal(s.ib_missed_busy.length, 1);
  assert.equal(s.ib_missed_free.length, 1);
  assert.equal(s.ob_connected.length, 1);
  const busy = s.ib_missed_busy[0];
  assert.equal(busy.callId, 'IN');
  assert.equal(busy.blockedByCallId, 'OUT', 'missed_busy sample names the blocking call id for Raw Data verification');
  assert.equal(busy.caller, '+15551234567');
});

test('no samples collected by default (collectSamples off)', function () {
  const res = compute(grid([
    row({ cid: 'A', start: D + '10:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(res.meta.samples, undefined);
});

test('dcBuildExtMaps_ splits a comma-joined queue-ext cell (103,108) into individual exts', function () {
  // Minimal fake DO NOT EDIT! sheet: row 1 = headers, row 2 = a queue-map row
  // whose col B is the combined CSR queue exts "103,108".
  function fakeConfig(grid) {
    return {
      getLastRow: function () { return grid.length; },
      // F-19: dcBuildExtMaps_ now sizes the roster read from getLastColumn
      // (dept block truncated at the first blank header) instead of a
      // hard-coded 14 columns.
      getLastColumn: function () {
        return grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
      },
      getRange: function (r, c, nr, nc) {
        return { getValues: function () {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const rowArr = grid[r - 1 + i] || [];
            const slice = [];
            for (let j = 0; j < nc; j++) { const v = rowArr[c - 1 + j]; slice.push(v != null ? v : ''); }
            out.push(slice);
          }
          return out;
        } };
      },
    };
  }
  const maps = h.fn('dcBuildExtMaps_')(fakeConfig([
    ['Queue', 'Ext'],
    ['A_Q_CustomerSuccess', '103,108'],
  ]));
  assert.ok(maps.queueExtSet.has('103'), 'first ext split out');
  assert.ok(maps.queueExtSet.has('108'), 'second ext split out');
});

test('answer rate inputs: answered excluded-from-rate busy miss surfaced separately', function () {
  const res = compute(grid([
    row({ cid: 'A1', start: D + '12:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:00', caller: '+1551', callee: '101', answered: true }),
    row({ cid: 'A2', start: D + '12:10:00', dir: 'Incoming', callTime: '0:00:20', caller: '+1552', callee: '101', missed: true }),  // free
    // busy miss during A1's window-overlapping... use a separate busy source:
    row({ cid: 'B0', start: D + '12:20:00', dir: 'Outgoing', talk: '0:05:00', callTime: '0:05:00', caller: '101', callee: '+1559' }),
    row({ cid: 'A3', start: D + '12:22:00', dir: 'Incoming', callTime: '0:00:20', caller: '+1553', callee: '101', missed: true }),  // busy
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  // answered=1, missed_free=1, missed_busy=1.
  assert.equal(a.ib_ext_answered, 1);
  assert.equal(a.ib_ext_missed_free, 1);
  assert.equal(a.ib_ext_missed_busy, 1);
  // The dashboard rate (Phase 2) = answered/(answered+missed_free) = 1/2 = 50%,
  // with the 1 busy miss surfaced but excluded -- pinned here as the contract.
  const denom = a.ib_ext_answered + a.ib_ext_missed_free;
  assert.equal(a.ib_ext_answered / denom, 0.5);
});

// -- F-3: refresh-in-window delete must survive Sheets date coercion ---------
// Col B is written as an "M/D/YYYY" string, but Sheets coerces it to a Date
// value; the old getValues()+String() compare never matched, so the delete
// was a silent no-op and every re-import appended a duplicate row set.

const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

test('F-3: dcDateIso_ normalizes padded/unpadded M/D/YYYY to ISO', function () {
  const iso = h.fn('dcDateIso_');
  assert.equal(iso('6/22/2026'), '2026-06-22');
  assert.equal(iso('06/22/2026'), '2026-06-22');
  assert.equal(iso(''), '');
});

test('F-3: dcWriteSheet_ deletes the date\'s existing rows even when Sheets coerced col B to Dates', function () {
  // Existing sheet: two rows for 06/22 (coerced -> Date values whose
  // DISPLAY is the unpadded "6/22/2026") + one row for 06/21 (kept).
  const HEADERS = new Array(18).fill('h');
  const dOld = new Date(2026, 5, 22);   // what a coerced "06/22/2026" reads back as
  const mk = function (dateVal, agent) {
    const r = new Array(18).fill(0);
    r[0] = 'June 2026'; r[1] = dateVal; r[2] = 'CSR'; r[3] = agent;
    return r;
  };
  const values   = [HEADERS, mk(dOld, 'Anna'), mk(dOld, 'Bob'), mk(new Date(2026, 5, 21), 'Cara')];
  const displays = [HEADERS.slice(),
    ['June 2026', '6/22/2026', 'CSR', 'Anna'].concat(new Array(14).fill('0')),
    ['June 2026', '6/22/2026', 'CSR', 'Bob'].concat(new Array(14).fill('0')),
    ['June 2026', '6/21/2026', 'CSR', 'Cara'].concat(new Array(14).fill('0'))];
  const ss = makeFakeSpreadsheet({
    sheets: { 'Direct Call History': { values: values, displays: displays } },
  });
  const res = h.fn('dcWriteSheet_')(ss, [
    { dept: 'CSR', agent: 'Anna',
      ib_int_answered: 1, ib_int_missed_free: 0, ib_int_missed_busy: 0, ib_int_talk_sec: 5,
      ib_ext_answered: 2, ib_ext_missed_free: 1, ib_ext_missed_busy: 0, ib_ext_talk_sec: 60,
      ob_int_total: 0, ob_int_connected: 0, ob_int_talk_sec: 0,
      ob_ext_total: 1, ob_ext_connected: 1, ob_ext_talk_sec: 30 },
  ], 'June 2026', '06/22/2026');
  assert.equal(res.written, 1);
  assert.equal(res.deleted, 2, 'C-5: the refresh reports how many existing rows it removed');
  const data = ss.getSheetByName('Direct Call History')._data;
  // header + Cara's 06/21 row + the ONE fresh 06/22 row (both stale
  // 06/22 rows deleted -- pre-fix this would be 5 rows, dupes kept).
  assert.equal(data.length, 3);
  const agents = data.slice(1).map(function (r) { return r[3]; }).sort();
  assert.equal(JSON.stringify(agents), JSON.stringify(['Anna', 'Cara']));
});

test('R39: dcWriteSheet_ deletes the date as contiguous BLOCKS bottom-up, never one row at a time', function () {
  const HEADERS = new Array(18).fill('h');
  const mk = function (date, agent) {
    const r = new Array(18).fill(0);
    r[0] = 'June 2026'; r[1] = date; r[2] = 'CSR'; r[3] = agent;
    return r;
  };
  // rows 2..8: T T O T O O T  -> blocks [2,2] [5,1] [8,1]
  const grid = [HEADERS, mk('6/22/2026', 'a'), mk('6/22/2026', 'b'), mk('6/21/2026', 'c'),
                mk('6/22/2026', 'd'), mk('6/21/2026', 'e'), mk('6/23/2026', 'f'), mk('6/22/2026', 'g')];
  const ss = makeFakeSpreadsheet({ sheets: { 'Direct Call History': grid } });
  const sh = ss.getSheetByName('Direct Call History');
  const calls = [];
  const inner = sh.deleteRows;
  sh.deleteRows = function (r, n) { calls.push([r, n]); return inner.call(this, r, n); };
  sh.deleteRow = function () { throw new Error('per-row deleteRow must not be used (R39)'); };
  const res = h.fn('dcWriteSheet_')(ss, [], 'June 2026', '06/22/2026');
  assert.equal(res.deleted, 4, 'the removed count keeps its C-5 meaning');
  assert.equal(res.written, 0);
  assert.deepEqual(calls, [[8, 1], [5, 1], [2, 2]], 'contiguous blocks, deleted bottom-up');
  assert.deepEqual(sh._data.slice(1).map(function (r) { return r[3]; }), ['c', 'e', 'f'], 'the other dates survive in order');
});

test('F-19: dcBuildExtMaps_ reads past 14 dept columns and stops at the first blank header', function () {
  // 16 dept columns (F..U) with agents in cols 14-16 -- the old hard-coded
  // 14-col read silently dropped everything past col S. A blank header ends
  // the dept block (conventions.md), so the reference block beyond it (the
  // insurance columns) must NOT be parsed even though its header is set.
  const header = ['Queue', 'Ext', '', '', ''];       // cols A-E
  const agentsRow = ['A_Q_X', '900', '', '', ''];
  for (let d = 1; d <= 16; d++) {
    header.push('Dept' + d);
    agentsRow.push('Agent' + d + ', ' + (200 + d));
  }
  header.push('');                                    // the block-ending blank (col V+16)
  agentsRow.push('');
  header.push('SomeInsurer');                         // unrelated reference block
  agentsRow.push('+15559998888, 42');                 // must NOT become an agent
  function fakeConfig(grid) {
    return {
      getLastRow: function () { return grid.length; },
      getLastColumn: function () {
        return grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
      },
      getRange: function (r, c, nr, nc) {
        return { getValues: function () {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const rowArr = grid[r - 1 + i] || [];
            const slice = [];
            for (let j = 0; j < nc; j++) { const v = rowArr[c - 1 + j]; slice.push(v != null ? v : ''); }
            out.push(slice);
          }
          return out;
        } };
      },
    };
  }
  const maps = h.fn('dcBuildExtMaps_')(fakeConfig([header, agentsRow]));
  // Agents 15 and 16 (beyond the old 14-col cap) are now mapped.
  assert.equal(maps.extToAgent['215'].name, 'Agent15');
  assert.equal(maps.extToAgent['216'].name, 'Agent16');
  assert.equal(maps.extToAgent['216'].dept, 'Dept16');
  // Nothing past the blank header leaked in (the insurer cell has a comma
  // and would have parsed as name/ext under a naive full-width read).
  assert.equal(maps.extToAgent['42'], undefined);
});

test('F-26: phone masks keep extensions but reduce full numbers to last-4', function () {
  const mask = h.fn('dcMaskPhone_');
  assert.equal(mask('+15551234567'), '…4567');
  assert.equal(mask('101'), '101');                  // ext passes through
  assert.equal(mask(''), '');
  const maskText = h.fn('dcMaskPhonesInText_');
  const out = maskText('busy 12:00-12:05 +15551234567->101');
  assert.ok(out.indexOf('+15551234567') === -1, 'raw number removed');
  assert.ok(out.indexOf('…4567') !== -1, 'last-4 kept');
  assert.ok(out.indexOf('101') !== -1, 'extension kept');
});

// ── PC-4 (broad-scan 2026-10-01): direction by call group, answered needs talk ──
// outboundCalls.js's rule: a group with ANY Incoming leg is inbound, because an
// answered inbound call carries the agent's own Outgoing talk leg. The Direct
// engine guarded that for QUEUE calls only.

test('PC-4: a NON-queue inbound call\'s Outgoing talk leg is not a fake outbound, and its talk counts once', function () {
  const res = compute(grid([
    row({ cid: 'DC', start: D + '10:00:00', dir: 'Incoming', talk: '0:04:00', callTime: '0:04:00',
          caller: '+15551234567', callee: '101', answered: true }),
    row({ cid: 'DC', start: D + '10:00:02', dir: 'Outgoing', talk: '0:04:00', callTime: '0:04:00',
          caller: '101', callee: '+15551234567' }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_answered, 1);
  assert.equal(a.ib_ext_talk_sec, 240);
  assert.equal(a.ob_ext_total, 0, 'pre-PC-4: ob_ext_total=1, connected, talk 240 counted again');
  assert.equal(a.ob_ext_talk_sec, 0);
});

test('PC-4: the S2C-1 shape -- talk ONLY on the agent\'s Outgoing leg -- is an ANSWERED inbound, not a miss', function () {
  const res = compute(grid([
    row({ cid: 'DC2', start: D + '10:10:00', dir: 'Incoming', callTime: '0:00:12',
          caller: '+15551234567', callee: '101' }),
    row({ cid: 'DC2', start: D + '10:10:12', dir: 'Outgoing', talk: '0:03:00', callTime: '0:03:00',
          caller: '101', callee: '+15551234567' }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_answered, 1, 'pre-PC-4: ib missed_free=1 plus ob connected=1');
  assert.equal(a.ib_ext_missed_free, 0);
  assert.equal(a.ib_ext_talk_sec, 180);
  assert.equal(a.ob_ext_total, 0);
});

test('PC-4: an "Answered" leg with ZERO talk is not answered (the inbound capture\'s Talk>0 gate)', function () {
  const res = compute(grid([
    row({ cid: 'Z', start: D + '11:00:00', dir: 'Incoming', callTime: '0:00:08',
          caller: '+15551234567', callee: '101', answered: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_answered, 0, 'pre-PC-4: answered with 0 talk, dragging ATT down');
  assert.equal(a.ib_ext_missed_free, 1);
});

test('PC-4: a genuine outbound call (no Incoming leg in its group) still counts', function () {
  const res = compute(grid([
    row({ cid: 'OB', start: D + '12:00:00', dir: 'Outgoing', talk: '0:02:00', callTime: '0:02:00',
          caller: '101', callee: '+15559990000' }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ob_ext_total, 1);
  assert.equal(a.ob_ext_connected, 1);
});

// ── D2 (owner 2026-10-21): the capture fixes ────────────────────────────────
// Every roster extension maps (a first extension beats a later one); a
// coworker dial logged Internal is the caller's internal outbound; one event
// per ROOT call; an anonymous inbound ring is kept (external); a dial to an
// unrostered extension-length number is internal.
const D2MAPS = {
  extToAgent: { '101': { name: 'Anna', dept: 'CSR' }, '111': { name: 'Anna', dept: 'CSR' }, '102': { name: 'Bob', dept: 'CSR' } },
  firstExtToAgent: { '101': { name: 'Anna', dept: 'CSR' }, '102': { name: 'Bob', dept: 'CSR' } },
  queueExtSet: new Set(['103']),
  exclusions: new Set(['103']),
};

test('D2: a coworker dial logged Internal counts for BOTH sides -- the callee\'s inbound and the caller\'s internal outbound', function () {
  const res = compute(grid([
    row({ cid: 'INT1', start: D + '09:00:00', dir: 'Internal', talk: '0:00:40', callTime: '0:00:40', caller: '101', callee: '102', answered: true }),
  ]), D2MAPS, {});
  assert.equal(rowFor(res, 'Bob').ib_int_answered, 1);
  const a = rowFor(res, 'Anna');
  assert.equal(a.ob_int_total, 1);
  assert.equal(a.ob_int_connected, 1);
  assert.equal(a.ob_int_talk_sec, 40);
  assert.equal(a.ob_ext_total, 0);
});

test('D2: an Outgoing leg and an Internal leg of ONE dial stay one outbound call', function () {
  const res = compute(grid([
    row({ cid: 'X', start: D + '09:00:00', dir: 'Outgoing', callTime: '0:00:05', caller: '101', callee: '102' }),
    row({ cid: 'Y', parent: 'X', start: D + '09:00:02', dir: 'Internal', talk: '0:01:00', callTime: '0:01:00', caller: '101', callee: '102', answered: true }),
  ]), D2MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ob_int_total, 1, 'one root call');
  assert.equal(a.ob_int_connected, 1);
  assert.equal(a.ob_int_talk_sec, 60);
});

test('D2: a ring on an agent\'s SECOND extension counts for her', function () {
  const res = compute(grid([
    row({ cid: 'S1', start: D + '09:10:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:00', caller: '+15551230000', callee: '111', answered: true }),
  ]), D2MAPS, {});
  assert.equal(rowFor(res, 'Anna').ib_ext_answered, 1);
});

test('D2: an anonymous / blank inbound ring is kept as external; a queue-named caller still is not', function () {
  const res = compute(grid([
    row({ cid: 'AN1', start: D + '09:20:00', dir: 'Incoming', callTime: '0:00:20', caller: 'Anonymous', callee: '101', missed: true }),
    row({ cid: 'AN2', start: D + '09:25:00', dir: 'Incoming', talk: '0:00:30', callTime: '0:00:30', caller: '', callee: '101', answered: true }),
    row({ cid: 'QN', start: D + '09:26:00', dir: 'Incoming', callTime: '0:00:20', caller: 'A_Q_CSR', callee: '102', missed: true }),
  ]), D2MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_missed_free, 1);
  assert.equal(a.ib_ext_answered, 1);
  assert.equal(rowFor(res, 'Bob'), undefined, 'a caller field naming a queue is never a direct call');
});

test('D2: two legs of ONE call to the agent are one event -- answered if either leg was, talk added per leg', function () {
  const res = compute(grid([
    row({ cid: 'L1', parent: 'P1', start: D + '09:30:00', dir: 'Incoming', talk: '0:00:40', callTime: '0:00:40', caller: '+15551231111', callee: '101', answered: true }),
    row({ cid: 'L2', parent: 'P1', start: D + '09:35:00', dir: 'Incoming', talk: '0:01:20', callTime: '0:01:20', caller: '+15551231111', callee: '101', answered: true }),
    row({ cid: 'M1', parent: 'P2', start: D + '10:00:00', dir: 'Incoming', callTime: '0:00:15', caller: '+15551232222', callee: '101', missed: true }),
    row({ cid: 'M2', parent: 'P2', start: D + '10:00:30', dir: 'Incoming', callTime: '0:00:15', caller: '+15551232222', callee: '101', missed: true }),
  ]), D2MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_answered, 1, 'P1 once');
  assert.equal(a.ib_ext_talk_sec, 120, '40 + 80 s, both legs talked');
  assert.equal(a.ib_ext_missed_free, 1, 'P2 rang twice, one missed call');
});

test('D2: an outside call keeps its side when a later leg transfers it internally', function () {
  const res = compute(grid([
    row({ cid: 'X', start: D + '11:00:00', dir: 'Outgoing', talk: '0:01:00', callTime: '0:01:00', caller: '101', callee: '+15559990000' }),
    row({ cid: 'Y', parent: 'X', start: D + '11:01:00', dir: 'Internal', talk: '0:00:30', callTime: '0:00:30', caller: '101', callee: '102', answered: true }),
  ]), D2MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ob_ext_total, 1, 'one outside call');
  assert.equal(a.ob_int_total, 0);
  assert.equal(rowFor(res, 'Bob').ib_int_answered, 1, 'the coworker it reached still has it');
});

test('D2: a dial to an extension-length number no roster names is INTERNAL; a phone number stays external', function () {
  const res = compute(grid([
    row({ cid: 'U1', start: D + '09:40:00', dir: 'Outgoing', talk: '0:00:30', callTime: '0:00:30', caller: '101', callee: '555' }),
    row({ cid: 'U2', start: D + '09:45:00', dir: 'Outgoing', talk: '0:00:30', callTime: '0:00:30', caller: '101', callee: '+15559990000' }),
  ]), D2MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ob_int_total, 1);
  assert.equal(a.ob_ext_total, 1);
  assert.equal(h.call('dcOutboundSide_', 'Outgoing', '5551234', {}), 'ext', '7 digits is a phone number');
  assert.equal(h.call('dcOutboundSide_', 'Internal', '+15551234567', {}), 'int', 'the CDR said Internal');
});

test('D2: dcBuildExtMaps_ maps every extension, a FIRST extension beating a later one; the pre-D2 map is kept for the diagnosis', function () {
  const cfg = {
    getLastRow: () => 3, getLastColumn: () => 7,
    getRange: function (r, c, nr, nc) {
      const g = [['', '', '', '', '', 'CSR', 'Sales'], ['A_Q_CSR', '103', '', '', '', 'Anna, 101, 111', 'Cal, 201, 101'], ['', '', '', '', '', 'Bob, 102', '']];
      return { getValues: () => g.slice(r - 1, r - 1 + nr).map((row2) => row2.slice(c - 1, c - 1 + nc)) };
    },
  };
  const m = h.call('dcBuildExtMaps_', cfg);
  assert.deepEqual(Object.keys(m.extToAgent).sort(), ['101', '102', '111', '201']);
  assert.equal(m.extToAgent['111'].name, 'Anna');
  assert.equal(m.extToAgent['101'].name, 'Anna', 'Cal\'s spare 101 never takes over Anna\'s main line');
  assert.deepEqual(Object.keys(m.firstExtToAgent).sort(), ['101', '102', '201']);
});

// ── D0: the opt-in DIAGNOSE mode -- since D2, "what re-importing a pre-D2
// date changes": read-only counters from the SAME pass; rows never move.
const DIAG_GRID = grid([
  row({ cid: 'INT1', start: D + '09:00:00', dir: 'Internal', talk: '0:00:40', callTime: '0:00:40', caller: '101', callee: '102', answered: true }),
  row({ cid: 'SEC1', start: D + '09:10:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551230000', callee: '111', missed: true }),
  row({ cid: 'ANON', start: D + '09:20:00', dir: 'Incoming', callTime: '0:00:20', caller: 'Anonymous', callee: '101', missed: true }),
  row({ cid: 'L1', parent: 'P1', start: D + '09:30:00', dir: 'Incoming', callTime: '0:00:15', caller: '+15551231111', callee: '101', missed: true }),
  row({ cid: 'L2', parent: 'P1', start: D + '09:31:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:00', caller: '+15551231111', callee: '101', answered: true }),
  row({ cid: 'UNR', start: D + '09:40:00', dir: 'Outgoing', talk: '0:00:30', callTime: '0:00:30', caller: '101', callee: '555' }),
  row({ cid: 'LATE', start: D + '16:00:00', dir: 'Internal', callTime: '0:00:10', caller: '101', callee: '102' }),
]);

test('D0 diagnose: each counter catches what D2 counts differently, in window only, with sample ids', function () {
  const res = compute(DIAG_GRID, D2MAPS, { diagnose: true });
  const d = JSON.parse(JSON.stringify(res.meta.diag));
  assert.deepEqual(d.internalDial.agents[0], { agent: 'Anna', n: 1, samples: ['INT1'] });
  assert.equal(d.secondExtIn.total, 1);
  assert.equal(d.secondExtIn.agents[0].agent, 'Anna');
  assert.equal(d.anonymousIn.total, 1);
  assert.deepEqual(d.sameRootIn.agents[0], { agent: 'Anna', n: 1, samples: ['L2'] }, 'the second leg of P1 is the repeat');
  assert.equal(d.unrosteredOut.total, 1);
  assert.equal(d.scale.ibEvents, 4, 'Anna: SEC1, ANON, P1; Bob: INT1');
});

test('D0 diagnose: OFF by default, and ON never moves a row', function () {
  const off = compute(DIAG_GRID, D2MAPS, {});
  const on = compute(DIAG_GRID, D2MAPS, { diagnose: true });
  assert.equal(off.meta.diag, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(on.rows)), JSON.parse(JSON.stringify(off.rows)));
});

// The first live run (2026-10-20) put 90% of a day's outbound in internalDial
// -- far more than coworker dials -- so the counter says what those Internal
// legs REACH before anyone acts on the D2 rule (Operator State #80).
test('D0 diagnose: internalDial says what each Internal leg reaches, masked, with its context', function () {
  const res = compute(grid([
    row({ cid: 'R1', start: D + '09:00:00', dir: 'Internal', talk: '0:00:40', callTime: '0:00:40', caller: '101', callee: '102', calleeName: 'Bob', answered: true }),
    row({ cid: 'S1', start: D + '09:01:00', dir: 'Internal', callTime: '0:00:05', caller: '101', callee: '111' }),
    row({ cid: 'V1', start: D + '09:02:00', dir: 'Internal', callTime: '0:00:05', caller: '101', callee: '777', calleeName: 'Voicemail', ctx: 'VM' }),
    row({ cid: 'V2', start: D + '09:03:00', dir: 'Internal', callTime: '0:00:05', caller: '102', callee: '777', calleeName: 'Voicemail', ctx: 'VM' }),
    row({ cid: 'X1', start: D + '09:04:00', dir: 'Internal', talk: '0:00:10', callTime: '0:00:10', caller: '101', callee: '+15559990000', calleeName: 'Jane Customer', answered: true }),
    row({ cid: 'B1', start: D + '09:05:00', dir: 'Internal', callTime: '0:00:05', caller: '101', callee: '', calleeName: 'Park' }),
  ]), D2MAPS, { diagnose: true });
  const sh = JSON.parse(JSON.stringify(res.meta.diag.internalDialShape));
  assert.equal(res.meta.diag.internalDial.total, 4, 'DC-D2b: only the four legs to an extension are dials');
  assert.deepEqual([sh.legs, sh.dials], [6, 4], 'every Internal leg tallied; the dials named');
  assert.deepEqual([sh.rosterAgent, sh.self, sh.unrosteredExt, sh.outsideNumber, sh.other, sh.talked], [1, 1, 2, 1, 1, 2]);
  assert.deepEqual(sh.topCallees[0], { v: '777 "Voicemail"', n: 2 }, 'the busiest callee first, with its name');
  const labels = sh.topCallees.map((t) => t.v);
  assert.ok(labels.includes('(a roster agent)') && labels.includes('(own extension)'), 'roster callees by kind, not name');
  assert.ok(labels.includes('…0000'), 'an outside number is masked to its last 4');
  assert.ok(!labels.some((l) => /Jane/.test(l)), 'an outside number\'s name never reaches the log');
  assert.deepEqual(sh.topContexts, [{ v: '(blank)', n: 4 }, { v: 'VM', n: 2 }], 'contexts tallied, busiest first');
  const off = compute(grid([row({ cid: 'R1', start: D + '09:00:00', dir: 'Internal', caller: '101', callee: '102' })]), D2MAPS, {});
  assert.equal(off.meta.diag, undefined, 'still nothing without diagnose');
});

// DC-D2b (owner 2026-10-22): the live CDR logs a Call Recording leg for
// nearly every call -- and Voicemail / CallForking legs -- as Internal. The
// first D2 build counted each as the caller's outbound call (3694 legs, 90% of
// 2026-10-20's outbound; 92.5% recording legs). Only a DIAL to an extension is.
test('D2b: an Internal leg is the caller\'s outbound only when it dials an extension -- never a recording, voicemail or forked leg', function () {
  const res = compute(grid([
    row({ cid: 'REC1', start: D + '09:00:00', dir: 'Internal', callTime: '0:03:00', caller: '101', callee: 'CallRecording', calleeName: 'N/A', ctx: 'N/A' }),
    row({ cid: 'REC2', start: D + '09:05:00', dir: 'Internal', callTime: '0:03:00', caller: '101', callee: 'CallRecording (595)', calleeName: 'N/A', ctx: 'N/A' }),
    row({ cid: 'VM1', start: D + '09:10:00', dir: 'Internal', talk: '0:00:20', callTime: '0:00:20', caller: '101', callee: 'Voicemail (143)', calleeName: 'Anna', ctx: '143', answered: true }),
    row({ cid: 'FK1', start: D + '09:15:00', dir: 'Internal', callTime: '0:00:10', caller: '101', callee: '239', calleeName: 'Sam', ctx: 'CallForking' }),
    row({ cid: 'EXT1', start: D + '09:20:00', dir: 'Internal', talk: '0:00:30', callTime: '0:00:30', caller: '101', callee: '239', calleeName: 'Sam', ctx: 'N/A', answered: true }),
    row({ cid: 'CO1', start: D + '09:25:00', dir: 'Internal', talk: '0:00:40', callTime: '0:00:40', caller: '101', callee: '102', answered: true }),
  ]), D2MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ob_int_total, 2, 'the unrostered extension and the coworker -- nothing else');
  assert.equal(a.ob_int_talk_sec, 70);
  assert.equal(a.ob_ext_total, 0);
  assert.equal(rowFor(res, 'Bob').ib_int_answered, 1, 'the coworker still has it as inbound');
  assert.equal(h.call('dcIsInternalDial_', ' 614 ', 'N/A'), true);
  assert.equal(h.call('dcIsInternalDial_', '5551234', ''), false, 'seven digits is no extension');
  assert.equal(h.call('dcIsInternalDial_', '', ''), false);
});

// Log hygiene (owner 2026-10-22): Apps Script formats a numeric %s argument as
// a Java double ("150.0 rows", "talk 182.0s"), and the outbound sample line
// printed the agent's NAME where its extension belonged.
function captureLogs(fn) {
  const logs = [];
  const real = h.ctx.Logger.log;
  h.ctx.Logger.log = function () { logs.push(Array.prototype.slice.call(arguments)); };
  try { fn(); } finally { h.ctx.Logger.log = real; }
  return logs;
}

test('logs: dcLog_ fills %s in JS -- Logger.log gets one finished string, numbers without ".0"', function () {
  const logs = captureLogs(() => h.call('dcLog_', 'runDirectCallBuild: %s rows for %s in %sms', 150, '10/20/2026', 13263));
  assert.deepEqual(logs, [['runDirectCallBuild: 150 rows for 10/20/2026 in 13263ms']]);
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../apps-script/cdr-import/directCallMetrics.js'), 'utf8');
  assert.equal((src.match(/Logger\.log\(/g) || []).length, 1, 'every log in the file goes through dcLog_ (its own call is the only one)');
});

test('logs: an outbound sample names the agent\'s extension, not the agent again', function () {
  const res = compute(grid([
    row({ cid: 'OB1', start: D + '10:00:00', dir: 'Outgoing', talk: '0:02:00', callTime: '0:02:00', caller: '101', callee: '+15559990000' }),
    row({ cid: 'OB2', start: D + '10:05:00', dir: 'Internal', callTime: '0:00:10', caller: '101', callee: '102' }),
  ]), D2MAPS, { collectSamples: true });
  const lines = captureLogs(() => h.call('dcLogSamples_', res.meta.samples)).map((a) => a.join(' '));
  assert.ok(lines.some((l) => /call OB1 \| Anna \(ext\) \| 10:00:00 ext 101 -> …0000 \| talk 120s$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /call OB2 \| Anna \(int\) \| 10:05:00 ext 101 -> 102$/.test(l)), lines.join('\n'));
});

// The live CDR writes a call's CallRecording row under the SAME call id as the
// call it records. The diagnosis tallied one row per call id, so a recording
// row that came first hid the dial behind it (2026-10-20: "dials 60" next to
// internalDial 282). The build was never affected -- it keys events by root.
test('D0 diagnose: a recording row sharing the dial\'s call id hides nothing -- one tally per leg', function () {
  const res = compute(grid([
    row({ cid: 'C1', start: D + '09:00:00', dir: 'Internal', callTime: '0:01:00', caller: '101', callee: 'CallRecording', calleeName: 'N/A', ctx: 'N/A' }),
    row({ cid: 'C1', start: D + '09:00:00', dir: 'Internal', talk: '0:01:00', callTime: '0:01:00', caller: '101', callee: '239', calleeName: 'Sam', ctx: 'N/A', answered: true }),
    row({ cid: 'C2', start: D + '09:10:00', dir: 'Outgoing', talk: '0:02:00', callTime: '0:02:00', caller: '101', callee: '+15559990000' }),
    row({ cid: 'C2', start: D + '09:10:00', dir: 'Internal', callTime: '0:02:00', caller: '101', callee: 'CallRecording', calleeName: 'N/A', ctx: 'N/A' }),
  ]), D2MAPS, { diagnose: true });
  const d = JSON.parse(JSON.stringify(res.meta.diag));
  assert.equal(d.internalDial.total, 1);
  assert.deepEqual([d.internalDialShape.legs, d.internalDialShape.dials], [3, 1], 'the dial behind C1\'s recording row is tallied');
  const a = rowFor(res, 'Anna');
  assert.deepEqual([a.ob_int_total, a.ob_ext_total], [1, 1], 'the build: one internal dial, one outside call -- the recording rows add nothing');
  assert.equal(d.sameRootOut.total, 0, 'a shared call id is one event, never an extra leg');
});

// ── DCA-1 (owner 2026-10-27): an extension AND the name 8x8 puts on the leg ──
// Former employees stay on DO NOT EDIT! with their old extension; 8x8 gives
// the extension to someone else. Anna (CSR) left; ext 101 now rings Nina.
const J = (x) => JSON.parse(JSON.stringify(x));

test('DCA-1: a call to a former employee\'s extension, named for the new owner, is credited to NO ONE (not the former employee)', function () {
  const res = compute(grid([
    row({ cid: 'N1', start: D + '10:00:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:10', caller: '+15551230000', callee: '101', calleeName: 'Nina New', answered: true }),
    row({ cid: 'N2', start: D + '10:10:00', dir: 'Outgoing', talk: '0:01:00', callTime: '0:01:05', caller: '101', callerName: 'Nina New', callee: '+15551230001' }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna'), undefined, 'Anna left -- none of Nina\'s calls are hers');
  const at = J(res.meta.attribution);
  assert.equal(at.mismatch, 2);
  assert.deepEqual(at.mismatches.map((m) => [m.ext, m.rosterName, m.legName, m.n]), [['101', 'Anna', 'Nina New', 2]]);
  assert.ok(!JSON.stringify(at).includes('5551230'), 'no phone number in the tally');
});

test('DCA-1: when the new owner is ALSO on the roster with that extension, the call goes to them', function () {
  const maps = { extToAgent: { '101': { name: 'Anna', dept: 'CSR' } }, queueExtSet: new Set(), exclusions: new Set(),
    extCands: { '101': [{ name: 'Anna', dept: 'CSR' }, { name: 'Nina', dept: 'Sales' }] } };
  const res = compute(grid([
    row({ cid: 'M1', start: D + '10:00:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:10', caller: '+15551230000', callee: '101', calleeName: 'Nina', answered: true }),
  ]), maps, {});
  assert.equal(rowFor(res, 'Anna'), undefined);
  const n = rowFor(res, 'Nina');
  assert.equal(n.dept, 'Sales');
  assert.equal(n.ib_ext_answered, 1);
  assert.equal(res.meta.attribution.otherCell, 1);
});

test('DCA-1: a blank or non-person name keeps the extension-only rule unchanged (owner decides after step 0)', function () {
  const res = compute(grid([
    row({ cid: 'B1', start: D + '10:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:10', caller: '+15551230000', callee: '101', answered: true }),
    row({ cid: 'B2', start: D + '10:05:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:10', caller: '+15551230001', callee: '101', calleeName: 'N/A', answered: true }),
    row({ cid: 'B3', start: D + '10:10:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:10', caller: '+15551230002', callee: '101', calleeName: 'Voicemail', answered: true }),
    row({ cid: 'B4', start: D + '10:15:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:10', caller: '+15551230003', callee: '101', calleeName: '+15551239999', answered: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna').ib_ext_answered, 4);
  assert.equal(res.meta.attribution.blank, 4);
  assert.equal(res.meta.attribution.mismatch, 0);
  assert.equal(h.call('dcPersonName_', 'A_Q_CSR'), '');
  assert.equal(h.call('dcPersonName_', 'CallRecording (595)'), '');
  assert.equal(h.call('dcPersonName_', 'Nina New'), 'Nina New');
});

test('DCA-1: the roster canonicalizer still matches a nickname variant (no false "somebody else")', function () {
  const maps = Object.assign({}, MAPS, { canon: (n) => (n === 'Anna Annie Lee' ? 'Anna' : n) });
  const res = compute(grid([
    row({ cid: 'K1', start: D + '10:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:10', caller: '+15551230000', callee: '101', calleeName: 'Anna Annie Lee', answered: true }),
    row({ cid: 'K2', start: D + '10:05:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:10', caller: '+15551230001', callee: '101', calleeName: 'Anna', answered: true }),
  ]), maps, {});
  assert.equal(rowFor(res, 'Anna').ib_ext_answered, 2);
  assert.equal(res.meta.attribution.match, 2);
});

test('DCA-1: a named leg no longer makes the former employee BUSY (occupancy follows the person too)', function () {
  // Anna is still here on 101 in this fixture; a leg on 102 named for someone
  // who is not Bob must not count as Bob's busy time for Bob's missed ring.
  const res = compute(grid([
    row({ cid: 'O1', start: D + '10:00:00', connected: D + '10:00:00', stop: D + '10:05:00', dir: 'Outgoing', talk: '0:05:00', callTime: '0:05:00', caller: '102', callerName: 'Zed Other', callee: '+15551230000' }),
    row({ cid: 'O2', start: D + '10:01:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551230001', callee: '102', missed: true }),
  ]), MAPS, {});
  const b = rowFor(res, 'Bob');
  assert.equal(b.ib_ext_missed_free, 1, 'Zed\'s call on 102 is not Bob\'s, so the miss is not excused as busy');
  assert.equal(b.ob_ext_total, 0);
});

test('DCA-1: opts.extOnly is the pre-DCA-1 rule (what the diagnostic compares against)', function () {
  const g = grid([
    row({ cid: 'E1', start: D + '10:00:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:10', caller: '+15551230000', callee: '101', calleeName: 'Nina New', answered: true }),
  ]);
  assert.equal(rowFor(compute(g, MAPS, { extOnly: true }), 'Anna').ib_ext_answered, 1);
  assert.equal(compute(g, MAPS, { extOnly: true }).meta.attribution, undefined);
});

test('DCA-1: dcBuildExtMaps_ lists EVERY roster cell on an extension (the old map still picks one)', function () {
  const cfg = {
    getLastRow: () => 3, getLastColumn: () => 7,
    getRange: function (r, c, nr, nc) {
      const g = [['', '', '', '', '', 'CSR', 'Sales'], ['A_Q_CSR', '103', '', '', '', 'Anna, 101', 'Nina, 101'], ['', '', '', '', '', 'Bob, 102, 111', '']];
      return { getValues: () => g.slice(r - 1, r - 1 + nr).map((row2) => row2.slice(c - 1, c - 1 + nc)) };
    },
  };
  const m = h.call('dcBuildExtMaps_', cfg);
  assert.deepEqual(J(m.extCands['101']), [{ name: 'Anna', dept: 'CSR' }, { name: 'Nina', dept: 'Sales' }]);
  assert.deepEqual(J(m.extCands['111']), [{ name: 'Bob', dept: 'CSR' }]);
  assert.equal(m.extToAgent['101'].name, 'Nina', 'the extension-only map is unchanged: the later column wins');
  assert.equal(typeof m.canon, 'function');
  assert.equal(m.canon('X Y'), 'X Y', 'no roster workbook -> identity');
});

test('DCA-1 step 0: the diagnostic folds days, lists shared extensions, the contested blank legs and the rows that change -- no numbers', function () {
  const maps = { extToAgent: { '101': { name: 'Anna', dept: 'CSR' }, '102': { name: 'Bob', dept: 'CSR' } }, queueExtSet: new Set(), exclusions: new Set(),
    extCands: { '101': [{ name: 'Anna', dept: 'CSR' }, { name: 'Ann Old', dept: 'Sales' }], '102': [{ name: 'Bob', dept: 'CSR' }] } };
  const day = (iso, rows) => ({ iso: iso, grid: grid(rows) });
  const t = J(h.call('dcAttributionAcrossDays_', [
    day('2026-03-09', [
      row({ cid: 'A1', start: D + '10:00:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:10', caller: '+15551230000', callee: '101', calleeName: 'Nina New', answered: true }),
      row({ cid: 'A2', start: D + '10:05:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:10', caller: '+15551230001', callee: '101', answered: true }),
      row({ cid: 'A3', start: D + '10:10:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:10', caller: '+15551230002', callee: '102', calleeName: 'Bob', answered: true }),
    ]),
    day('2026-03-10', [
      row({ cid: 'A4', start: '03/10/2026 10:00:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:10', caller: '+15551230003', callee: '101', calleeName: 'Nina New', answered: true }),
      row({ cid: 'X9', start: D + '10:00:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:10', caller: '+15551230004', callee: '101', calleeName: 'Nina New', answered: true }),   // a 03/09 leg on the 03/10 tab: dropped
    ]),
  ], maps));
  assert.deepEqual(t.days.map((d) => [d.iso, d.match, d.blank, d.mismatch]), [['2026-03-09', 1, 1, 1], ['2026-03-10', 0, 0, 1]]);
  assert.deepEqual(t.mismatches.map((m) => [m.ext, m.rosterName, m.legName, m.n, m.samples]), [['101', 'Anna', 'Nina New', 2, ['A1', 'A4']]]);
  assert.deepEqual(t.shared.map((x) => x.ext), ['101']);
  assert.deepEqual(t.blankOnContested, [{ ext: '101', n: 1 }]);
  assert.deepEqual(t.changes, [{ agent: 'Anna (CSR)', was: 3, now: 1 }]);
  assert.ok(!JSON.stringify(t).includes('555123'), 'no phone number anywhere in the result');
});

test('DCA-1 step 0: the log prints whole numbers and masks anything number-shaped', function () {
  const lines = [];
  const real = h.ctx.dcLog_;
  h.ctx.dcLog_ = function () { lines.push(Array.prototype.slice.call(arguments).join(' | ')); };
  try {
    h.call('dcLogAttribution_', { days: [{ iso: '2026-03-09', match: 1, blank: 2, otherCell: 0, mismatch: 3 }], match: 1, blank: 2, otherCell: 0, mismatch: 3,
      mismatches: [{ ext: '101', rosterName: 'Anna', legName: 'Nina New', n: 3, samples: ['A1'] }], moved: [], shared: [], blankOnContested: [], changes: [{ agent: 'Anna (CSR)', was: 4, now: 1 }] });
  } finally { h.ctx.dcLog_ = real; }
  const text = lines.join('\n');
  assert.match(text, /\| 101 \| Anna \| Nina New \| 3 \| A1/);
  assert.match(text, /rows that change.*\| 1 row\(s\)/);
  assert.match(text, /Anna \(CSR\) \| 4 \| 1/);
  assert.ok(!/\d\.0\b/.test(text), 'no ".0" counts: ' + text);
});
