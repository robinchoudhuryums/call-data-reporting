'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Heatmap SHEET FALLBACK (Neon-outage degradation): when getInboundHeatmap's
// Neon read fails, it degrades to the 'Inbound Calls' export tab
// (cdr-report/inboundCallsExport.js cols 16-17 exist for this reader). The
// load-bearing contracts pinned here:
//   (1) the JS bucketing MIRRORS the SQL -- same +2h CST shift, 8-5 window
//       (boundary fixtures on both edges), hourly slots, weekday filter,
//       call_start regex guard, is_internal exclusion;
//   (2) the two-arm dept attribution mirrors inboundDeptPredicate_ exactly:
//       on-hold-answered by Final Dept label, everything else (plus
//       unmapped-label on-hold calls, the union fallback) by entry queue;
//   (3) fallback payloads are NEVER cached (a recovered Neon must not be
//       masked for the TTL) and disclose themselves (meta.fallbackSource /
//       fallbackThrough);
//   (4) the healthy Neon path never touches the sheet and still caches;
//   (5) a missing / pre-extension (15-col) tab keeps the old behavior
//       (available=false -> the panel hides);
//   (6) the CELL DRILL does not fall back (its journey drill is Neon-only).
// NeonCoverage.gs joins the load for ncCellDateIso_ (the display-date
// normalizer the fallback reuses).

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs', 'InboundReport.gs'],
});

function install(opts) {
  opts = opts || {};
  h.state.cache.clear();
  h.ctx.resolveUser_ = function () {
    return { role: 'admin', department: null, email: 'x@x.com' };
  };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  h.ctx.queuesForDept_ = function (d) { return d === 'CSR' ? ['A_Q_CustomerSuccess'] : []; };
  h.ctx.getInboundQueueAliases_ = function (d) { return d === 'CSR' ? ['A_Q_CSR'] : []; };
  h.ctx.reportFreshnessTag_ = function () { return 'tag'; };
  h.ctx.getFinalDeptLabels_ = opts.finalDeptLabels
    ? function (d) { return opts.finalDeptLabels[d] || [String(d).toLowerCase()]; }
    : function (d) { return [String(d).toLowerCase()]; };
  h.ctx.getAllFinalDeptLabels_ = function () { return opts.allLabels || []; };
  install.connCalls = 0;
  h.ctx.getDashboardNeonConn_ = opts.conn !== undefined
    ? function () { install.connCalls++; return opts.conn; }
    : function () { install.connCalls++; return null; };
  install.ssOpened = 0;
  h.ctx.openSpreadsheet_ = function () {
    install.ssOpened++;
    return {
      getSheetByName: function (name) {
        if (name !== 'Inbound Calls') return null;
        return opts.sheet || null;
      },
    };
  };
}

// A minimal read-only fake of the export tab: `rows` are 17-wide display
// arrays (data rows; the header row is implied at row 1).
function fakeExportSheet(rows, opts) {
  opts = opts || {};
  const cols = opts.cols || 17;
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

// Row builder: positions mirror INBOUND_EXPORT_HEADERS (1-based cols 1 Date,
// 6 Disposition, 8 Abandoned On Hold, 11 Entry Queue, 13 Final Dept,
// 16 Call Start, 17 Is Internal).
function icRow(o) {
  const r = new Array(17).fill('');
  r[0] = o.date;
  r[5] = o.disposition || 'abandoned';
  r[7] = o.onHold ? 'TRUE' : 'FALSE';
  r[10] = o.entryQueue === undefined ? 'A_Q_CSR' : o.entryQueue;
  r[12] = o.finalDept || '';
  r[15] = o.callStart === undefined ? '10:00:00' : o.callStart;
  r[16] = o.internal ? 'TRUE' : 'FALSE';
  return r;
}

function cellsOf(payload) {
  return JSON.parse(JSON.stringify(payload.cells)).sort(function (a, b) {
    return (a.dow - b.dow) || (a.slot - b.slot);
  });
}

const REQ = { department: 'CSR', from: '2026-08-17', to: '2026-08-21' };

// 2026-08-19 is a Wednesday (ISODOW 3); 2026-08-22 a Saturday.

test('fallback: Neon down -> sheet-bucketed cells with the SQL semantics (shift, window edges, guards)', function () {
  const rows = [
    // slot 0 edge: 06:00:00 PST -> 08:00:00 CST (included, first slot)
    icRow({ date: '2026-08-19', callStart: '06:00:00', disposition: 'abandoned' }),
    // below-window edge: 05:59:59 PST -> 07:59:59 CST (excluded)
    icRow({ date: '2026-08-19', callStart: '05:59:59' }),
    // interior: 08:30:00 PST -> 10:30 CST -> slot 2; answered counts calls only
    icRow({ date: '2026-08-19', callStart: '08:30:00', disposition: 'answered' }),
    // top edge: 14:59:59 PST -> 16:59:59 CST -> slot 8 (included)
    icRow({ date: '2026-08-19', callStart: '14:59:59' }),
    // past-window edge: 15:00:00 PST -> 17:00:00 CST (excluded)
    icRow({ date: '2026-08-19', callStart: '15:00:00' }),
    // pre-extension row shape: blank call_start (excluded, the null-row rule)
    icRow({ date: '2026-08-19', callStart: '' }),
    // internal-origin row (excluded, the is_internal rule)
    icRow({ date: '2026-08-19', internal: true }),
    // weekend row (excluded, ISODOW 1-5)
    icRow({ date: '2026-08-22' }),
    // outside the request window (excluded), but still the newest date ->
    // it is what fallbackThrough discloses
    icRow({ date: '2026-08-23' }),
  ];
  install({ sheet: fakeExportSheet(rows) });
  const out = h.call('getInboundHeatmap', REQ);
  assert.equal(out.meta.available, true);
  assert.equal(out.meta.fallbackSource, 'sheet');
  assert.equal(out.meta.fallbackThrough, '2026-08-23');
  assert.deepEqual(cellsOf(out), [
    { dow: 3, slot: 0, calls: 1, abandoned: 1 },
    { dow: 3, slot: 2, calls: 1, abandoned: 0 },
    { dow: 3, slot: 8, calls: 1, abandoned: 1 },
  ]);
  assert.equal(out.meta.rows, 3);
  // NEVER cached: a recovered Neon must not be masked for the TTL.
  assert.equal(h.state.cache.size, 0);
});

test('fallback: two-arm dept attribution mirrors inboundDeptPredicate_', function () {
  const rows = [
    // Arm 1: answered abandoned-ON-HOLD attributes by Final Dept label even
    // though its entry queue belongs to another dept.
    icRow({ date: '2026-08-19', callStart: '09:00:00', disposition: 'answered',
            onHold: true, finalDept: 'Customer Success', entryQueue: 'A_Q_Sales' }),
    // Mutually-exclusive arms: an on-hold call whose label is mapped in
    // ANOTHER dept's list must NOT fall back to its CSR entry queue.
    icRow({ date: '2026-08-19', callStart: '09:05:00', disposition: 'answered',
            onHold: true, finalDept: 'Inside Sales', entryQueue: 'A_Q_CSR' }),
    // Union fallback: an on-hold call whose label is in NO dept's list falls
    // back to the entry queue (counts for CSR).
    icRow({ date: '2026-08-19', callStart: '09:10:00', disposition: 'answered',
            onHold: true, finalDept: 'Some Unmapped Label', entryQueue: 'A_Q_CSR' }),
    // Plain abandon on a CSR queue (entry-queue arm; case-insensitive match).
    icRow({ date: '2026-08-19', callStart: '09:15:00', entryQueue: 'a_q_customersuccess' }),
    // Another dept's abandon (excluded).
    icRow({ date: '2026-08-19', callStart: '09:20:00', entryQueue: 'A_Q_Sales' }),
  ];
  install({
    sheet: fakeExportSheet(rows),
    finalDeptLabels: { CSR: ['csr', 'customer success'] },
    allLabels: ['csr', 'customer success', 'inside sales'],
  });
  const out = h.call('getInboundHeatmap', REQ);
  assert.equal(out.meta.fallbackSource, 'sheet');
  // 09:00-09:15 PST all land in the 11a CST hour (slot 3): arm-1 label match
  // + union fallback + plain queue abandon = 3 calls, 2 abandoned (the two
  // answered ones count calls only... note the on-hold calls are 'answered').
  assert.deepEqual(cellsOf(out), [{ dow: 3, slot: 3, calls: 3, abandoned: 1 }]);
});

test('fallback: company view (no dept) counts every row, no attribution filter', function () {
  const rows = [
    icRow({ date: '2026-08-19', callStart: '09:00:00', entryQueue: 'A_Q_Sales' }),
    icRow({ date: '2026-08-19', callStart: '09:05:00', entryQueue: 'Totally Unmapped Queue' }),
  ];
  install({ sheet: fakeExportSheet(rows) });
  const out = h.call('getInboundHeatmap', { department: '', from: REQ.from, to: REQ.to });
  assert.equal(out.meta.fallbackSource, 'sheet');
  assert.deepEqual(cellsOf(out), [{ dow: 3, slot: 3, calls: 2, abandoned: 2 }]);
});

test('fallback: a Neon QUERY failure (not just conn-null) degrades to the sheet', function () {
  const throwingConn = {
    createStatement: function () { throw new Error('connection reset'); },
    close: function () {},
  };
  install({
    conn: throwingConn,
    sheet: fakeExportSheet([icRow({ date: '2026-08-19', callStart: '09:00:00' })]),
  });
  const out = h.call('getInboundHeatmap', REQ);
  assert.equal(out.meta.fallbackSource, 'sheet');
  assert.equal(out.cells.length, 1);
  assert.equal(h.state.cache.size, 0);
});

test('fallback: missing tab and pre-extension (15-col) tab keep the old hide behavior', function () {
  install({ sheet: null });
  let out = h.call('getInboundHeatmap', REQ);
  assert.equal(out.meta.available, false);
  assert.equal(out.meta.fallbackSource, undefined);

  install({ sheet: fakeExportSheet([icRow({ date: '2026-08-19' })], { cols: 15 }) });
  out = h.call('getInboundHeatmap', REQ);
  assert.equal(out.meta.available, false);
});

test('healthy Neon path: sheet never touched, payload still cached, no fallback fields', function () {
  const json = JSON.stringify([{ dow: 2, slot: 1, calls: 5, abandoned: 2 }]);
  const conn = {
    createStatement: function () {
      return {
        executeQuery: function () {
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
  install({ conn: conn, sheet: fakeExportSheet([icRow({ date: '2026-08-19' })]) });
  const out = h.call('getInboundHeatmap', REQ);
  assert.equal(out.meta.fallbackSource, undefined);
  assert.equal(install.ssOpened, 0);
  assert.deepEqual(cellsOf(out), [{ dow: 2, slot: 1, calls: 5, abandoned: 2 }]);
  assert.equal(h.state.cache.size, 1);
});

test('cell drill does NOT fall back to the sheet (journey is Neon-only)', function () {
  install({ sheet: fakeExportSheet([icRow({ date: '2026-08-19', callStart: '09:00:00' })]) });
  const out = h.call('getInboundHeatmapCell',
    { department: 'CSR', from: REQ.from, to: REQ.to, dow: 3, slot: 3 });
  assert.equal(out.meta.available, false);
  assert.equal(install.ssOpened, 0);
});

test('fallback constants are the SAME globals the SQL is built from (no fork knob)', function () {
  // The JS path reads INBOUND_HEATMAP_* directly; pin the values the boundary
  // fixtures above assume, so a constant change re-derives both sides.
  const c = loadGas({
    files: ['InboundReport.gs'],
    capture: ['INBOUND_HEATMAP_CST_SHIFT_HOURS', 'INBOUND_HEATMAP_WINDOW_START_HOUR',
              'INBOUND_HEATMAP_WINDOW_END_HOUR', 'INBOUND_HEATMAP_SLOT_MINUTES'],
  }).consts;
  assert.equal(c.INBOUND_HEATMAP_CST_SHIFT_HOURS, 2);
  assert.equal(c.INBOUND_HEATMAP_WINDOW_START_HOUR, 8);
  assert.equal(c.INBOUND_HEATMAP_WINDOW_END_HOUR, 17);
  assert.equal(c.INBOUND_HEATMAP_SLOT_MINUTES, 60);
});
