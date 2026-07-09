'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
// Legacy (non-strict) deepEqual for values built inside the vm realm --
// strict deepEqual fails on cross-realm prototypes (established pattern).
const legacy = require('node:assert');
const { loadGas } = require('../harness/loadGas');

// Heatmap cell drill (getInboundHeatmapCell): the per-cell call list behind
// the weekday x hour abandon heatmap. The load-bearing contracts pinned here:
// (1) it inherits the inbound report's auth gate (admin-only while vetted) +
// dept scoping via inboundResolveRequest_; (2) its SQL uses the SAME TZ shift
// + window + slot math and the SAME disposition='abandoned' definition as
// getInboundHeatmap, so the list always reconciles with the cell's count;
// (3) rows are capped at INBOUND_HEATMAP_CELL_MAX (=200) with meta.truncated;
// (4) Neon-down degrades to meta.available=false, never a throw.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'InboundReport.gs'],
});

function install(role, queuesByDept) {
  h.ctx.resolveUser_ = function () {
    return { role: role, department: role === 'manager' ? 'CSR' : null, email: 'x@x.com' };
  };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  // isIsoDate_ lives in Data.gs (not loaded); stub the same contract.
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  h.ctx.queuesForDept_ = function (d) { return (queuesByDept && queuesByDept[d]) || []; };
  h.ctx.getInboundQueueAliases_ = function () { return []; };
  install.connCalls = 0;
  h.ctx.getDashboardNeonConn_ = function () { install.connCalls++; return null; };
}

function fakeConn(json, capture) {
  return {
    createStatement: function () {
      return {
        executeQuery: function (sql) {
          if (capture) capture.sql = sql;
          let done = false;
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function () { return json; },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

const REQ = { department: 'CSR', from: '2026-06-01', to: '2026-06-30', dow: 2, slot: 1 };

test('heatmap cell drill: inherits the inbound admin-only vetting gate', function () {
  install('manager', { CSR: ['A_Q_CSR'] });
  assert.throws(function () { h.call('getInboundHeatmapCell', REQ); }, /admin-only/);
});

test('heatmap cell drill: dow/slot validation', function () {
  install('admin', { CSR: ['A_Q_CSR'] });
  assert.throws(function () {
    h.call('getInboundHeatmapCell', Object.assign({}, REQ, { dow: 0 }));
  }, /dow must be 1-5/);
  assert.throws(function () {
    h.call('getInboundHeatmapCell', Object.assign({}, REQ, { dow: 6 }));
  }, /dow must be 1-5/);
  // Hourly slots over the 8a-5p window -> 9 slots, valid 0..8.
  assert.throws(function () {
    h.call('getInboundHeatmapCell', Object.assign({}, REQ, { slot: -1 }));
  }, /slot must be 0-8/);
  assert.throws(function () {
    h.call('getInboundHeatmapCell', Object.assign({}, REQ, { slot: 9 }));
  }, /slot must be 0-8/);
});

test('heatmap cell drill: unmapped dept -> meta.unmapped, no Neon call', function () {
  install('admin', { CSR: [] });   // dept view, no effective queues
  const out = h.call('getInboundHeatmapCell', REQ);
  assert.equal(out.meta.unmapped, true);
  assert.equal(out.calls.length, 0);
  assert.equal(install.connCalls, 0, 'must not open a connection for an unmapped dept');
});

test('heatmap cell drill: SQL mirrors the heatmap cell definition; rows mapped', function () {
  install('admin', { CSR: ['A_Q_CSR'] });
  const capture = {};
  const rows = [
    { call_date: '2026-06-23', call_id: 'CID-2', cst_start: '10:41:09',
      entry_queue: 'A_Q_CSR', final_queue: 'A_Q_CSR', abandon_stage: 'queue',
      abandoned_on_hold: false, wait_seconds: 95, hold_seconds: null },
    { call_date: '2026-06-16', call_id: 'CID-1', cst_start: '10:05:00',
      entry_queue: 'A_Q_CSR', final_queue: 'Backup CSR', abandon_stage: null,
      abandoned_on_hold: true, wait_seconds: null, hold_seconds: 30 },
  ];
  h.ctx.getDashboardNeonConn_ = function () { return fakeConn(JSON.stringify(rows), capture); };
  const out = h.call('getInboundHeatmapCell', REQ);

  // Cell-definition parity with getInboundHeatmap (INV-18 window + PST->CST shift).
  assert.match(capture.sql, /disposition='abandoned'/);
  assert.match(capture.sql, /interval '2 hours'/);
  assert.match(capture.sql, /EXTRACT\(ISODOW FROM c\.call_date\) = 2/);
  assert.match(capture.sql, /\/ 3600\)::int = 1/);          // hourly slot bucket = requested slot
  assert.match(capture.sql, /'A_Q_CSR'/);                   // dept predicate applied
  assert.match(capture.sql, /BETWEEN '2026-06-01'::date AND '2026-06-30'::date/);

  assert.equal(out.meta.available, true);
  assert.equal(out.meta.truncated, false);
  assert.equal(out.calls.length, 2);
  legacy.deepEqual(out.calls[0], {
    callDate: '2026-06-23', callId: 'CID-2', cstStart: '10:41:09',
    entryQueue: 'A_Q_CSR', finalQueue: 'A_Q_CSR', abandonStage: 'queue',
    abandonedOnHold: false, waitSeconds: 95, holdSeconds: null,
  });
  assert.equal(out.calls[1].abandonedOnHold, true);
  assert.equal(out.calls[1].holdSeconds, 30);
});

test('heatmap cell drill: caps at 200 rows and flags truncation', function () {
  install('admin', { CSR: ['A_Q_CSR'] });
  const many = [];
  for (let i = 0; i < 201; i++) {
    many.push({ call_date: '2026-06-23', call_id: 'C' + i, cst_start: '10:00:00' });
  }
  h.ctx.getDashboardNeonConn_ = function () { return fakeConn(JSON.stringify(many)); };
  const out = h.call('getInboundHeatmapCell', REQ);
  assert.equal(out.meta.truncated, true);
  assert.equal(out.calls.length, 200);
});

test('heatmap cell drill: Neon unreachable -> available=false, no throw', function () {
  install('admin', { CSR: ['A_Q_CSR'] });   // conn stub returns null
  const out = h.call('getInboundHeatmapCell', REQ);
  assert.equal(out.meta.available, false);
  assert.equal(out.calls.length, 0);
});
