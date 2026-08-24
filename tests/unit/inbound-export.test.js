'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// The 'Inbound Calls' export tab (cdr-report/inboundCallsExport.js) -- the
// fallback COPY of Neon inbound_calls, and since the heatmap-sheet-fallback
// work ALSO the data source the dashboard's abandon heatmap degrades to
// during a Neon outage. Pinned here:
//   (1) the schema contract the dashboard reads BY POSITION: 17 headers with
//       Call Start / Is Internal at cols 16-17, and the export SQL fetching
//       both fields in that order;
//   (2) the coercion protections on Call Start (a time-shaped string, the
//       K-AC class): '@' format over the current height AND the exact write
//       range, with the grid pre-expanded so an append can never spill past
//       getMaxRows unformatted (the buildDQE recurrence vector);
//   (3) the pre-extension upgrade path: a 15-col tab is widened + reheadered
//       before any col-16+ range is touched (REP-10);
//   (4) is_internal boolean -> 'TRUE'/'FALSE' normalization;
//   (5) the scheduled runner: prune drops only the pre-cutoff head block
//       (INBOUND_EXPORT_KEEP_DAYS honored), and a Neon-down run logs ONE
//       log-only `inboundExport` failure row -- never an email, never a throw.

const h = loadGas({
  project: 'cdr-report',
  files: ['inboundCallsExport.js'],
});

// Mutable fake sheet: a dense grid of display strings, header at row 1.
function fakeSheet(dataRows, opts) {
  opts = opts || {};
  const self = {
    _rows: [(opts.header || []).slice()].concat(dataRows.map(function (r) { return r.slice(); })),
    _maxCols: opts.maxCols || 17,
    _maxRows: opts.maxRows || 200,
    _formats: [],
    _deleted: [],
    getLastRow: function () {
      for (let i = self._rows.length - 1; i >= 0; i--) {
        if (self._rows[i] && self._rows[i].some(function (v) { return v !== '' && v != null; })) return i + 1;
      }
      return 0;
    },
    getMaxColumns: function () { return self._maxCols; },
    getMaxRows: function () { return self._maxRows; },
    getLastColumn: function () { return self._maxCols; },
    insertColumnsAfter: function (after, n) { self._maxCols += n; },
    insertRowsAfter: function (after, n) { self._maxRows += n; },
    deleteRows: function (start, n) { self._deleted.push([start, n]); self._rows.splice(start - 1, n); },
    setFrozenRows: function () {},
    getRange: function (row, col, numRows, numCols) {
      numRows = numRows || 1; numCols = numCols || 1;
      if (col + numCols - 1 > self._maxCols) throw new Error('getRange past getMaxColumns (REP-10)');
      const rng = {
        setValues: function (vals) {
          for (let r = 0; r < numRows; r++) {
            const tr = row - 1 + r;
            while (self._rows.length <= tr) self._rows.push(new Array(self._maxCols).fill(''));
            for (let c = 0; c < numCols; c++) self._rows[tr][col - 1 + c] = vals[r][c];
          }
          return rng;
        },
        getValues: function () { return rng.getDisplayValues(); },
        getDisplayValues: function () {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = self._rows[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = src[col - 1 + c];
              line.push(v == null ? '' : String(v));
            }
            out.push(line);
          }
          return out;
        },
        setNumberFormat: function (fmt) {
          self._formats.push({ row: row, col: col, numRows: numRows, numCols: numCols, fmt: fmt });
          return rng;
        },
        setFontWeight: function () { return rng; },
        setBackground: function () { return rng; },
        sort: function () { return rng; },   // order is not under test here
      };
      return rng;
    },
  };
  return self;
}

function fakeSS(sheet) {
  return {
    getSheetByName: function (name) { return name === 'Inbound Calls' ? sheet : null; },
    insertSheet: function () { throw new Error('unexpected insertSheet -- fixture provides the tab'); },
  };
}

function neonConnReturning(rows, capture) {
  return {
    prepareStatement: function (sql) {
      if (capture) capture.sql = sql;
      return {
        setString: function () {},
        executeQuery: function () {
          let done = false;
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function () { return JSON.stringify(rows); },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

// One Neon-shaped record (json_build_array order = the 17 header positions).
function neonRow(o) {
  return [o.date, o.id || 'c1', '', '', '', o.disposition || 'abandoned',
          '', false, 0, 0, o.entryQueue || 'A_Q_CSR', '', '', 1, 0,
          o.callStart === undefined ? '10:23:33' : o.callStart,
          o.internal === undefined ? false : o.internal];
}

const HEADERS = function () { return h.ctx.INBOUND_EXPORT_HEADERS; };

test('schema contract: 17 headers, Call Start / Is Internal at cols 16-17, SQL fetches both', function () {
  assert.equal(HEADERS().length, 17);
  assert.equal(HEADERS()[15], 'Call Start');
  assert.equal(HEADERS()[16], 'Is Internal');
  assert.equal(h.ctx.INBOUND_EXPORT_CALL_START_COL, 16);

  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  const cap = {};
  h.ctx.getNeonConn = function () { return neonConnReturning([neonRow({ date: '2026-08-19' })], cap); };
  h.call('exportInboundCalls', '2026-08-19', '2026-08-19');
  assert.match(cap.sql, /c\.num_transfers, COALESCE\(c\.call_start,''\),\s*COALESCE\(c\.is_internal, FALSE\)\)/);
});

test('export writes the two new columns; is_internal booleans normalize to TRUE/FALSE strings', function () {
  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  h.ctx.getNeonConn = function () {
    return neonConnReturning([
      neonRow({ date: '2026-08-19', id: 'a', callStart: '10:23:33', internal: false }),
      neonRow({ date: '2026-08-19', id: 'b', callStart: '', internal: true }),
    ]);
  };
  const res = h.call('exportInboundCalls', '2026-08-19', '2026-08-19');
  assert.equal(res.written, 2);
  assert.equal(sheet._rows[1][15], '10:23:33');
  assert.equal(sheet._rows[1][16], 'FALSE');
  assert.equal(sheet._rows[2][15], '');
  assert.equal(sheet._rows[2][16], 'TRUE');
});

test('coercion protection: Call Start is @-formatted over current height AND the exact write range, grid pre-expanded', function () {
  const sheet = fakeSheet([], { header: HEADERS(), maxRows: 2 });   // 1 header + 1 spare row
  h.state.spreadsheet = fakeSS(sheet);
  h.ctx.getNeonConn = function () {
    return neonConnReturning([
      neonRow({ date: '2026-08-19', id: 'a' }),
      neonRow({ date: '2026-08-19', id: 'b' }),
      neonRow({ date: '2026-08-19', id: 'c' }),
    ]);
  };
  h.call('exportInboundCalls', '2026-08-19', '2026-08-19');
  const atFmts = sheet._formats.filter(function (f) { return f.fmt === '@' && f.col === 16; });
  assert.ok(atFmts.length >= 2, 'expected height + exact-range @ formats on col 16');
  // The exact write range (rows 2..4) is covered by an @ format...
  assert.ok(atFmts.some(function (f) { return f.row === 2 && f.numRows === 3; }),
    'the exact write range must carry the @ format');
  // ...which requires the grid to have been pre-expanded past the old max.
  assert.ok(sheet._maxRows >= 4, 'grid must be pre-expanded so the append cannot spill unformatted');
});

test('pre-extension tab (15 cols) is widened and reheadered before any col-16 range is touched', function () {
  const oldHeader = HEADERS().slice(0, 15);
  const oldRow = new Array(15).fill(''); oldRow[0] = '2026-08-18';
  const sheet = fakeSheet([oldRow], { header: oldHeader, maxCols: 15 });
  h.state.spreadsheet = fakeSS(sheet);
  h.ctx.getNeonConn = function () { return neonConnReturning([neonRow({ date: '2026-08-19' })]); };
  h.call('exportInboundCalls', '2026-08-19', '2026-08-19');   // would throw REP-10 without the widen
  assert.equal(sheet._maxCols, 17);
  assert.equal(sheet._rows[0][15], 'Call Start');
  assert.equal(sheet._rows[0][16], 'Is Internal');
});

test('prune: drops only the contiguous pre-cutoff head block; INBOUND_EXPORT_KEEP_DAYS honored', function () {
  const mk = function (iso) { const r = new Array(17).fill(''); r[0] = iso; return r; };
  // ic_isoDaysAgo_(2) is the cutoff when KEEP_DAYS=2; build one clearly-old
  // pair, then recent rows.
  const today = h.call('ic_isoToday_');
  const sheet = fakeSheet([mk('2020-01-01'), mk('2020-01-02'), mk(today)], { header: HEADERS() });
  h.state.props.INBOUND_EXPORT_KEEP_DAYS = '2';
  const pruned = h.call('ic_pruneOldRows_', sheet);
  delete h.state.props.INBOUND_EXPORT_KEEP_DAYS;
  assert.equal(pruned, 2);
  assert.deepEqual(sheet._deleted, [[2, 2]]);
  assert.equal(sheet._rows[1][0], today);
});

test('scheduled runner: Neon-down logs ONE log-only inboundExport failure row -- no email, no throw', function () {
  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  h.state.sentEmails.length = 0;
  h.ctx.getNeonConn = function () { throw new Error('The database connection failed'); };
  const logged = [];
  h.ctx.logPipelineHealth_ = function (ss, ev) { logged.push(JSON.parse(JSON.stringify(ev))); };
  h.call('runInboundCallsExport_');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].step, 'inboundExport');
  assert.equal(logged[0].status, 'failure');
  assert.equal(h.state.sentEmails.length, 0);
});

test('scheduled runner: success logs written rows + replaced/pruned note', function () {
  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  h.ctx.getNeonConn = function () { return neonConnReturning([neonRow({ date: '2026-08-19' })]); };
  const logged = [];
  h.ctx.logPipelineHealth_ = function (ss, ev) { logged.push(JSON.parse(JSON.stringify(ev))); };
  h.call('runInboundCallsExport_');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].step, 'inboundExport');
  assert.equal(logged[0].status, 'success');
  assert.equal(logged[0].rows, 1);
});
