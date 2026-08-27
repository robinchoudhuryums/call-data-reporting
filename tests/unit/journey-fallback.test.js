'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Call-path drill SHEET FALLBACK (Neon-outage degradation): when
// getCallJourney cannot reach Neon, the INBOUND arm degrades to the
// 'Inbound Calls' export tab (cols 18-22 exist for this reader). Pinned:
//   (1) SOURCE PARITY -- the fallback shapes its payload through the SAME
//       callerLookupShapeCall_ as the Neon path, so equivalent rows produce
//       an identical `call` object;
//   (2) BOTH auth arms in the Neon-path order: the dept-scoped match
//       (entry/final queue in the inbound union, or final_dept === dept),
//       then the exact-id arm gated for managers by
//       callIdInDeptMissedReport_ -- and a gate-closed manager gets a
//       reason-LESS miss (learns nothing);
//   (3) the miss-reason vocabulary from the sheet's own coverage:
//       before-capture (+minDate) / date-gap / not-captured, plus the
//       fallback-only 'fallback-gap' for a date past the copy's ceiling;
//   (4) a blank Journey cell (past INBOUND_EXPORT_JOURNEY_DAYS) shapes to
//       journey:null -- the summary render -- rather than throwing;
//   (5) the mid-query CATCH degrades to the fallback too, and the OUTBOUND
//       arm does NOT fall back (no sheet primary);
//   (6) fallback payloads disclose themselves (fallbackSource/-Through).
// CallerLookup.gs joins the load for callerLookupShapeCall_;
// NeonCoverage.gs for ncCellDateIso_ (the display-date normalizer).

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs', 'CallerLookup.gs', 'InboundReport.gs'],
});

function install(opts) {
  opts = opts || {};
  h.state.cache.clear();
  h.ctx.resolveUser_ = function () {
    return opts.user || { role: 'admin', department: null, email: 'x@x.com' };
  };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.assertManagerOrAdmin_ = function () {};
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  h.ctx.queuesForDept_ = function (d) { return d === 'CSR' ? ['A_Q_CustomerSuccess'] : []; };
  h.ctx.getInboundQueueAliases_ = function (d) { return d === 'CSR' ? ['A_Q_CSR'] : []; };
  h.ctx.getDashboardNeonConn_ = opts.conn !== undefined
    ? function () { return opts.conn; } : function () { return null; };
  install.missedGateCalls = [];
  h.ctx.callIdInDeptMissedReport_ = function (dept, date, id) {
    install.missedGateCalls.push([dept, date, id]);
    return !!opts.missedGateOpen;
  };
  h.ctx.openSpreadsheet_ = function () {
    return { getSheetByName: function (n) { return n === 'Inbound Calls' ? (opts.sheet || null) : null; } };
  };
}

// Read-only fake of the export tab (data rows; header implied at row 1).
function fakeExportSheet(rows, opts) {
  opts = opts || {};
  const cols = opts.cols || 22;
  return {
    getLastRow: function () { return rows.length + 1; },
    getMaxColumns: function () { return cols; },
    getLastColumn: function () { return cols; },
    getRange: function (row, col, numRows, numCols) {
      if (col + numCols - 1 > cols) throw new Error('getRange past getMaxColumns');
      return {
        getDisplayValues: function () {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = rows[row - 2 + r] || [];
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = src[col - 1 + c];
              line.push(v == null ? '' : String(v));
            }
            out.push(line);
          }
          return out;
        },
      };
    },
  };
}

const JOURNEY = '[{"t":"10:00:00","name":"A_Q_CSR","kind":"queue"},{"t":"10:01:00","name":"Ray","kind":"answer","talk":120}]';

// 22-wide export row, positions per INBOUND_EXPORT_HEADERS.
function exRow(o) {
  const r = new Array(22).fill('');
  r[0] = o.date; r[1] = o.id;
  r[2] = o.insurer || ''; r[4] = o.dialIn || '';
  r[5] = o.disposition || 'abandoned'; r[6] = o.stage || 'queue';
  r[7] = o.onHold ? 'TRUE' : 'FALSE';
  r[8] = o.hold == null ? '0' : String(o.hold);
  r[9] = o.wait == null ? '' : String(o.wait);
  r[10] = o.entryQueue === undefined ? 'A_Q_CSR' : o.entryQueue;
  r[11] = o.finalQueue || ''; r[12] = o.finalDept || '';
  r[13] = '1'; r[14] = '0';
  r[15] = o.callStart === undefined ? '10:00:00' : o.callStart;
  r[16] = o.internal ? 'TRUE' : 'FALSE';
  r[17] = o.journey === undefined ? JOURNEY : o.journey;
  r[18] = o.originAgent || ''; r[19] = o.originDept || '';
  r[20] = o.relatedId || ''; r[21] = o.relatedKind || '';
  return r;
}

function drill(req) { return h.call('getCallJourney', req); }
const MANAGER = { role: 'manager', department: 'CSR', departments: ['CSR'], allDepts: false, email: 'm@x.com' };

test('Neon down: the drill serves the call from the sheet, shaped + disclosed', function () {
  install({ sheet: fakeExportSheet([
    exRow({ date: '2026-08-19', id: '111', wait: 45, originAgent: 'Margie Ingay',
            originDept: 'Customer Success', relatedId: '999', relatedKind: 'outbound', internal: true }),
    exRow({ date: '2026-08-20', id: '222' }),
  ]) });
  const res = drill({ callId: '111', date: '2026-08-19' });
  assert.equal(res.available, true);
  assert.equal(res.found, true);
  assert.equal(res.fallbackSource, 'sheet');
  assert.equal(res.fallbackThrough, '2026-08-20');
  const c = res.call;
  assert.equal(c.callId, '111');
  assert.equal(c.disposition, 'abandoned');
  assert.equal(c.waitSeconds, 45);
  assert.equal(c.isInternal, true);
  assert.equal(c.originAgent, 'Margie Ingay');
  assert.equal(c.relatedCallId, '999');
  assert.equal(c.relatedCallKind, 'outbound');
  assert.equal(c.journey.length, 2, 'journey JSON parsed into events');
  assert.equal(c.journey[1].name, 'Ray');
});

test('SOURCE PARITY: sheet row and Neon row shape to the identical call object', function () {
  // The Neon path hands callerLookupShapeCall_ the raw jsonb row; the
  // fallback hands it a sheet-derived equivalent. Same shaper in, same
  // object out -- the renderers cannot tell the sources apart.
  install({ sheet: fakeExportSheet([
    exRow({ date: '2026-08-19', id: '111', wait: 45, hold: 7, onHold: true,
            insurer: 'Acme', dialIn: '19722281820', finalQueue: 'A_Q_CSR', finalDept: 'CSR' }),
  ]) });
  const viaSheet = drill({ callId: '111', date: '2026-08-19' }).call;
  const viaNeon = h.call('callerLookupShapeCall_', {
    call_date: '2026-08-19', call_id: '111', insurer: 'Acme',
    dial_in_number: '19722281820', disposition: 'abandoned', abandon_stage: 'queue',
    abandoned_on_hold: true, hold_seconds: 7, wait_seconds: 45,
    entry_queue: 'A_Q_CSR', final_queue: 'A_Q_CSR', final_dept: 'CSR',
    num_queues: 1, num_transfers: 0, call_start: '10:00:00',
    is_internal: false, journey: JOURNEY,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(viaSheet)), JSON.parse(JSON.stringify(viaNeon)));
});

test('auth arm 1: a manager reaches a row scoped to their dept queues (no missed-report call)', function () {
  install({ user: MANAGER, sheet: fakeExportSheet([
    exRow({ date: '2026-08-19', id: '111', entryQueue: 'A_Q_CSR' }),
  ]) });
  const res = drill({ callId: '111', date: '2026-08-19', department: 'CSR' });
  assert.equal(res.found, true);
  assert.equal(install.missedGateCalls.length, 0, 'the scoped arm settled it');
});

test('auth arm 2 (F-4): an off-queue row falls to the missed-report gate; open -> served', function () {
  install({ user: MANAGER, missedGateOpen: true, sheet: fakeExportSheet([
    exRow({ date: '2026-08-19', id: '111', entryQueue: 'A_Q_Spanish' }),
  ]) });
  const res = drill({ callId: '111', date: '2026-08-19', department: 'CSR' });
  assert.equal(res.found, true);
  assert.deepEqual(JSON.parse(JSON.stringify(install.missedGateCalls)),
    [['CSR', '2026-08-19', '111']]);
});

test('auth: gate closed -> a reason-LESS miss (the manager learns nothing)', function () {
  install({ user: MANAGER, missedGateOpen: false, sheet: fakeExportSheet([
    exRow({ date: '2026-08-19', id: '111', entryQueue: 'A_Q_Spanish' }),
  ]) });
  const res = drill({ callId: '111', date: '2026-08-19', department: 'CSR' });
  assert.equal(res.found, false);
  assert.equal(res.reason, undefined, 'no reason probe for a gate-closed manager');
  assert.equal(res.fallbackThrough, undefined, 'no coverage hint either');
});

test('miss reasons from the sheet: before-capture (+minDate), date-gap, not-captured, fallback-gap', function () {
  const rows = [
    exRow({ date: '2026-08-18', id: 'a' }),
    exRow({ date: '2026-08-20', id: 'b' }),
  ];
  install({ sheet: fakeExportSheet(rows) });
  let r = drill({ callId: 'x', date: '2026-08-01' });
  assert.equal(r.reason, 'before-capture');
  assert.equal(r.minDate, '2026-08-18');
  r = drill({ callId: 'x', date: '2026-08-19' });
  assert.equal(r.reason, 'date-gap');
  r = drill({ callId: 'zzz', date: '2026-08-20' });
  assert.equal(r.reason, 'not-captured');
  r = drill({ callId: 'x', date: '2026-08-25' });
  assert.equal(r.reason, 'fallback-gap', 'past the copy\'s ceiling is its own reason');
  assert.equal(r.fallbackThrough, '2026-08-20');
});

test('blank Journey cell (past the retention window) -> journey:null, summary render', function () {
  install({ sheet: fakeExportSheet([
    exRow({ date: '2026-08-19', id: '111', journey: '' }),
  ]) });
  const res = drill({ callId: '111', date: '2026-08-19' });
  assert.equal(res.found, true);
  assert.equal(res.call.journey, null);
  assert.equal(res.call.entryQueue, 'A_Q_CSR', 'the summary fields still carry');
});

test('mid-query Neon failure degrades to the sheet too (not just no-conn)', function () {
  const throwingConn = {
    prepareStatement: function () { throw new Error('connection reset'); },
    close: function () {},
  };
  install({ conn: throwingConn, sheet: fakeExportSheet([
    exRow({ date: '2026-08-19', id: '111' }),
  ]) });
  const res = drill({ callId: '111', date: '2026-08-19' });
  assert.equal(res.found, true);
  assert.equal(res.fallbackSource, 'sheet');
});

test('missing / empty / pre-extension tab -> available:false (the old dead-end, disclosed as such)', function () {
  install({ sheet: null });
  assert.equal(drill({ callId: 'x', date: '2026-08-19' }).available, false);
  install({ sheet: fakeExportSheet([]) });
  assert.equal(drill({ callId: 'x', date: '2026-08-19' }).available, false);
  install({ sheet: fakeExportSheet([['2026-08-19', 'x']], { cols: 15 }) });
  assert.equal(drill({ callId: 'x', date: '2026-08-19' }).available, false);
});

test('a 17-col tab (heatmap-era, no journey cols) still serves the summary + auth', function () {
  const row = exRow({ date: '2026-08-19', id: '111' }).slice(0, 17);
  install({ sheet: fakeExportSheet([row], { cols: 17 }) });
  const res = drill({ callId: '111', date: '2026-08-19' });
  assert.equal(res.found, true);
  assert.equal(res.call.journey, null);
  assert.equal(res.call.originAgent, null);
});

test('OUTBOUND arm does NOT fall back -- no sheet primary exists for it', function () {
  install({ sheet: fakeExportSheet([
    exRow({ date: '2026-08-19', id: '111' }),
  ]) });
  const res = drill({ callId: '111', date: '2026-08-19', kind: 'outbound' });
  assert.equal(res.available, false, 'unavailable, never a sheet answer');
});
