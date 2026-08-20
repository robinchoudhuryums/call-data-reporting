'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// The C1 fixture treatment for dashboardCDR.js's generateCustomReportCore_
// (owner go-ahead 2026-08-20) — the ~480-line end-to-end path (dashboard
// inputs → CDR Historical Data aggregation → rendered grid + totals + top-5s
// + charts + diagnostics) that dashboard-cdr-helpers.test.js's pure-helper
// tests could not reach. The fixture drives the REAL core against a local
// recording fake and asserts the WRITTEN grid.
//
// The fake is deliberately LOCAL to this suite (the qcd-sidebar-parity
// precedent), not an extension of tests/harness/fakeSheet.js: the report
// surface is ~40 chainable cosmetic methods that would loosen the shared
// strict harness for everyone. Real behavior is modeled (cell reads/writes,
// A1 ranges, display-vs-value grids, getLastRow/Column, chart insertion
// counts); cosmetics chain as no-ops via a Proxy default.

const h = loadGas({ project: 'cdr-report', files: ['dashboardCDR.js'] });

// ── The recording fake ──────────────────────────────────────────────────────

function colLettersToNum_(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

function makeRecordingSheet_(opts) {
  opts = opts || {};
  const cells = {};              // 'r,c' -> value
  const displays = opts.displays || {};   // 'r,c' -> display string
  const sheet = {
    _cells: cells,
    _charts: [],
    _maxCols: opts.maxCols || 60,
    get: function (r, c) { const v = cells[r + ',' + c]; return v === undefined ? '' : v; },
    set: function (r, c, v) { cells[r + ',' + c] = v; },
  };
  function makeRange(r0, c0, nr, nc) {
    nr = nr || 1; nc = nc || 1;
    const real = {
      getValues: function () {
        const out = [];
        for (let r = 0; r < nr; r++) {
          const line = [];
          for (let c = 0; c < nc; c++) line.push(sheet.get(r0 + r, c0 + c));
          out.push(line);
        }
        return out;
      },
      getValue: function () { return sheet.get(r0, c0); },
      getDisplayValues: function () {
        const out = [];
        for (let r = 0; r < nr; r++) {
          const line = [];
          for (let c = 0; c < nc; c++) {
            const key = (r0 + r) + ',' + (c0 + c);
            line.push(displays[key] !== undefined ? displays[key] : String(sheet.get(r0 + r, c0 + c)));
          }
          out.push(line);
        }
        return out;
      },
      setValue: function (v) { sheet.set(r0, c0, v); return proxy; },
      setValues: function (vals) {
        for (let r = 0; r < vals.length; r++) {
          for (let c = 0; c < vals[r].length; c++) sheet.set(r0 + r, c0 + c, vals[r][c]);
        }
        return proxy;
      },
      clearContent: function () {
        for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) delete cells[(r0 + r) + ',' + (c0 + c)];
        return proxy;
      },
      getCell: function (r, c) { return makeRange(r0 + r - 1, c0 + c - 1, 1, 1); },
      getBandings: function () { return []; },
      // setFontColors READS the grid in the Diff-coloring pass — accept it.
      setFontColors: function () { return proxy; },
    };
    // Everything else (setFontWeight/setBackground/merge/…): chainable no-op.
    const proxy = new Proxy(real, {
      get: function (t, name) {
        if (name in t) return t[name];
        if (typeof name !== 'string') return undefined;
        return function () { return proxy; };
      },
    });
    return proxy;
  }
  sheet.getRange = function (a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a);
      if (!m) throw new Error('fake getRange: unsupported A1 ' + a);
      const r0 = Number(m[2]), c0 = colLettersToNum_(m[1]);
      const r1 = m[4] ? Number(m[4]) : r0, c1 = m[3] ? colLettersToNum_(m[3]) : c0;
      return makeRange(r0, c0, r1 - r0 + 1, c1 - c0 + 1);
    }
    return makeRange(a, b, c, d);
  };
  sheet.getDataRange = function () {
    return makeRange(1, 1, sheet.getLastRow(), sheet.getLastColumn());
  };
  sheet.getLastRow = function () {
    let m = 0; Object.keys(cells).forEach(function (k) { m = Math.max(m, Number(k.split(',')[0])); });
    return m;
  };
  sheet.getLastColumn = function () {
    let m = 0; Object.keys(cells).forEach(function (k) { m = Math.max(m, Number(k.split(',')[1])); });
    return m;
  };
  sheet.getMaxColumns = function () { return sheet._maxCols; };
  sheet.insertColumnsAfter = function (after, howMany) {
    sheet._maxCols = Math.max(sheet._maxCols, after + (howMany || 1)); return sheet;
  };
  sheet.getCharts = function () { return []; };
  sheet.removeChart = function () {};
  sheet.insertChart = function (c) { sheet._charts.push(c); };
  sheet.newChart = function () {
    const b = new Proxy({ build: function () { return {}; } }, {
      get: function (t, name) {
        if (name in t) return t[name];
        return function () { return b; };
      },
    });
    return b;
  };
  // Sheet-level cosmetics.
  ['setColumnWidth', 'setFrozenRows', 'autoResizeColumn'].forEach(function (n) {
    sheet[n] = function () { return sheet; };
  });
  return sheet;
}

// ── The fixture ─────────────────────────────────────────────────────────────

const HIST_HEADERS = ['A', 'B', 'Date', 'Dept', 'AgentName',
  'OB External Total', 'OB External List (Answered)', 'OB External List (Missed)',
  'OB External Total Duration',
  'OB List Total (Internal Direct)', 'OB List Answered (Internal Direct)',
  'IB Answered List (Internal & External)', 'IB Missed List (Internal & External)'];
const DUR_COL = HIST_HEADERS.indexOf('OB External Total Duration') + 1;   // 1-based

function histRow_(date, dept, name, o) {
  o = o || {};
  return ['', '', date, dept, name,
    o.obTot || 0, o.obAns || '', o.obMis || '', o.durJunk !== undefined ? o.durJunk : '',
    o.obIntTot || '', o.obIntAns || '', o.ibAns || '', o.ibMis || ''];
}

/**
 * Installs the two sheets + inputs and runs the core once.
 * inputs: { dept, start, end, compStart?, agent?, cats: {OB_EXT,...} }
 */
function runCore_(histRows, durDisplays, inputs) {
  const dash = makeRecordingSheet_();
  // Inputs (the createCustomReportDashboard cell contract).
  dash.set(2, 2, inputs.dept);                       // B2
  dash.set(3, 2, inputs.start);                      // B3
  dash.set(4, 2, inputs.end);                        // B4
  if (inputs.compStart) dash.set(5, 2, inputs.compStart);   // B5
  if (inputs.agent) dash.set(7, 2, inputs.agent);    // B7
  const cats = inputs.cats || {};
  dash.set(2, 4, !!cats.OB_EXT);                     // D2:E5 col D checkboxes
  dash.set(3, 4, !!cats.IB_EXT);
  dash.set(4, 4, !!cats.OB_INT);
  dash.set(5, 4, !!cats.IB_INT);

  // Historical sheet: values grid + a DISPLAY override for the duration
  // column (the F-11 pin: values hold junk, displays hold H:MM:SS).
  const displays = {};
  (durDisplays || []).forEach(function (d, i) {
    if (d != null) displays[(i + 2) + ',' + DUR_COL] = d;   // data starts row 2
  });
  const hist = makeRecordingSheet_({ displays: displays });
  hist.getRange(1, 1, 1, HIST_HEADERS.length).setValues([HIST_HEADERS]);
  if (histRows.length) hist.getRange(2, 1, histRows.length, HIST_HEADERS.length).setValues(histRows);

  h.state.props = {};
  if (inputs.prevDiagCol) h.state.props.CRB_DIAG_COL = String(inputs.prevDiagCol);
  if (inputs.preSeed) inputs.preSeed(dash);
  h.state.spreadsheet = {
    getSheetByName: function (n) {
      if (n === 'Custom Report Builder') return dash;
      if (n === 'CDR Historical Data') return hist;
      return null;
    },
    getSpreadsheetTimeZone: function () { return 'America/Chicago'; },
  };
  h.ctx.Charts = { ChartType: { PIE: 'PIE' } };
  h.ctx.SpreadsheetApp.BandingTheme = { LIGHT_GREY: 'LIGHT_GREY' };   // applyRowBanding arg
  // The validation branches call SpreadsheetApp.getUi().alert — record them.
  const alerts = [];
  h.ctx.SpreadsheetApp.getUi = function () {
    return { alert: function (m) { alerts.push(String(m)); } };
  };
  h.call('generateCustomReportCore_');
  return { dash: dash, hist: hist, alerts: alerts };
}

const D = function (y, m, d) { return new Date(y, m - 1, d); };
const HEADER_ROW = 13;   // REPORT_ANCHOR_ROW (12) + 1
const DAY = 86400;

// The standard two-agent fixture: Alice (two rows in window), Bob (zero
// activity — must be dropped), Sub (dept 'Sales X' — the substring trap),
// plus one Alice row OUTSIDE the window and one in the comparison window.
function standardRows_() {
  return {
    rows: [
      histRow_(D(2026, 6, 2), 'Sales', 'Alice', {
        obTot: 10, obAns: 'Cust A(3), Cust B', obMis: '=BAD(9)', durJunk: new Date(1899, 11, 30, 12, 36),
        obIntTot: 'Bob X(2)', obIntAns: 'Bob X',
        ibAns: 'Ann I|Ext P(2)', ibMis: '|Ext Q' }),
      histRow_(D(2026, 6, 3), 'Sales', 'Alice', {
        obTot: 5, obAns: 'Cust A', durJunk: new Date(1899, 11, 30, 1, 1) }),
      histRow_(D(2026, 6, 2), 'Sales', 'Bob', {}),
      histRow_(D(2026, 6, 2), 'Sales X', 'Sub', { obTot: 99, obAns: 'Cust Z(99)' }),
      histRow_(D(2026, 5, 1), 'Sales', 'Alice', { obTot: 77, obAns: 'Old(77)' }),   // out of window
      histRow_(D(2026, 5, 12), 'Sales', 'Alice', { obTot: 4, obAns: 'Prev A(2)', durJunk: '' }),  // comp window
    ],
    // Display strings for the duration column, row-aligned (F-11: junk Dates
    // above must NOT be read).
    durDisplays: ['0:30:00', '0:10:00', null, '9:99:99', null, '0:08:00'],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('core: non-comparison OB Ext + IB Ext — headers, aggregation, rates, and the F-11 display-read TTT', function () {
  const f = standardRows_();
  const r = runCore_(f.rows, f.durDisplays, {
    dept: 'Sales', start: D(2026, 6, 1), end: D(2026, 6, 30),
    cats: { OB_EXT: true, IB_EXT: true },
  });
  assert.deepEqual(r.alerts, []);
  assert.deepEqual(r.dash.getRange(HEADER_ROW, 1, 1, 11).getValues()[0], [
    'AGENT NAME', 'OB Ext Total', 'OB Ext Ans', 'OB Ext Rate', 'TTT', 'ATT', 'OB Ext Contacts',
    'IB Ext Total', 'IB Ext Ans', 'IB Ext Rate', 'IB Ext Contacts']);

  const alice = r.dash.getRange(HEADER_ROW + 1, 1, 1, 11).getValues()[0];
  assert.equal(alice[0], 'Alice');
  assert.equal(alice[1], 15, 'OB totals summed across her two in-window rows');
  assert.equal(alice[2], 5, 'answered from the ANSWERED list (N) multipliers: 3+1 +1; missed never counts');
  assert.ok(Math.abs(alice[3] - 5 / 15) < 1e-9);
  // TTT from the DISPLAY strings (0:30:00 + 0:10:00 = 2400s), never the junk
  // 1899-epoch Date values the fixture plants in the values grid (F-11).
  assert.ok(Math.abs(alice[4] - 2400 / DAY) < 1e-9, 'TTT read via getDisplayValues');
  assert.ok(Math.abs(alice[5] - (2400 / 5) / DAY) < 1e-9, 'ATT = TTT / answered');
  // IB mixed list splits on the pipe: ext = 2 answered + 1 missed.
  assert.equal(alice[7], 3);
  assert.equal(alice[8], 2);
  // Contacts cell merges answered+missed; the missed '=BAD(9)' sorts first
  // (count desc), so the cell is formula-leading and D-3 must neutralize it.
  assert.match(String(alice[6]), /^'=BAD/);

  // Bob (zero activity) and Sub ('Sales X' — the exact-dept-match trap) get
  // no TABLE row: Alice is the only agent row, so TOTALS sits right under
  // her. (Bob legitimately appears in the diagnostics agent subtotals —
  // that panel iterates the raw agents dict by design.)
  assert.match(String(r.dash.get(HEADER_ROW + 2, 1)), /TOTALS/, 'exactly one agent row');
  const rendered = JSON.stringify(r.dash._cells);
  assert.ok(!rendered.includes('"Sub"'), 'substring dept excluded everywhere');
  assert.ok(!rendered.includes(':77'), 'out-of-window row excluded');

  // Totals row directly under the single agent row.
  const totals = r.dash.getRange(HEADER_ROW + 2, 1, 1, 6).getValues()[0];
  assert.match(String(totals[0]), /TOTALS/);
  assert.equal(totals[1], 15);
  assert.equal(totals[2], 5);
  assert.ok(Math.abs(totals[3] - 5 / 15) < 1e-9, 'totals Rate recomputed, not summed');

  // One pie chart per active category with data.
  assert.equal(r.dash._charts.length, 2);
  // Diagnostics panel floated right + remembered (T-7/REP-1).
  assert.ok(Number(h.state.props.CRB_DIAG_COL) >= 12);
});

test('core: comparison mode — (C)/(P)/Diff header shape, prev-bucket values, and the derived B6 end date', function () {
  const f = standardRows_();
  const r = runCore_(f.rows, f.durDisplays, {
    dept: 'Sales', start: D(2026, 6, 1), end: D(2026, 6, 30),
    compStart: D(2026, 5, 2),   // 30-day window → comp end June 1 (covers May 12)
    cats: { OB_EXT: true },
  });
  assert.deepEqual(r.dash.getRange(HEADER_ROW, 1, 1, 15).getValues()[0], [
    'AGENT NAME',
    'OB Ext Total (C)', 'OB Ext Total (P)', 'Diff',
    'OB Ext Ans (C)', 'OB Ext Ans (P)', 'Diff',
    'OB Ext Rate (C)', 'OB Ext Rate (P)', 'Rate Diff',
    'TTT (C)', 'TTT (P)', 'ATT (C)', 'ATT (P)', 'OB Ext Contacts']);
  const alice = r.dash.getRange(HEADER_ROW + 1, 1, 1, 15).getValues()[0];
  assert.equal(alice[1], 15);
  assert.equal(alice[2], 4, 'prev bucket from the comparison window row');
  assert.equal(alice[3], 11, 'Diff = C - P');
  assert.equal(alice[5], 2, 'prev answered');
  assert.ok(Math.abs(alice[11] - 480 / DAY) < 1e-9, 'TTT (P) from the display string too');
  // B6 (derived comp end) = compStart + (end1 - start1), end-of-day:
  // May 2 + (Jun 1 00:00 .. Jun 30 23:59) = May 31 23:59.
  const b6 = r.dash.get(6, 2);
  assert.ok(b6 instanceof Date);
  assert.equal(b6.getMonth(), 4);
  assert.equal(b6.getDate(), 31);
});

test('core: the specificAgent filter narrows to one agent', function () {
  const f = standardRows_();
  const rows = f.rows.concat([
    histRow_(D(2026, 6, 2), 'Sales', 'Carol', { obTot: 3, obAns: 'C1' })]);
  const r = runCore_(rows, f.durDisplays.concat([null]), {
    dept: 'Sales', start: D(2026, 6, 1), end: D(2026, 6, 30),
    agent: 'Carol', cats: { OB_EXT: true },
  });
  assert.equal(r.dash.get(HEADER_ROW + 1, 1), 'Carol');
  assert.match(String(r.dash.get(HEADER_ROW + 2, 1)), /TOTALS/, 'exactly one agent row before the totals');
});

test('core: rows sort by the first Total column, descending', function () {
  const rows = [
    histRow_(D(2026, 6, 2), 'Sales', 'Small', { obTot: 2, obAns: 'X' }),
    histRow_(D(2026, 6, 2), 'Sales', 'Big', { obTot: 30, obAns: 'Y(9)' }),
  ];
  const r = runCore_(rows, [], {
    dept: 'Sales', start: D(2026, 6, 1), end: D(2026, 6, 30), cats: { OB_EXT: true },
  });
  assert.equal(r.dash.get(HEADER_ROW + 1, 1), 'Big');
  assert.equal(r.dash.get(HEADER_ROW + 2, 1), 'Small');
});

test('core: no matching rows renders the explicit empty message and restores the button (D-6 class)', function () {
  const f = standardRows_();
  const r = runCore_(f.rows, f.durDisplays, {
    dept: 'Nowhere', start: D(2026, 6, 1), end: D(2026, 6, 30), cats: { OB_EXT: true },
  });
  assert.equal(r.dash.get(HEADER_ROW + 1, 1), 'No data found for the selected criteria.');
  assert.equal(r.dash.get(8, 2), '▶  GENERATE REPORT', 'B8 button restored');
});

test('core: blank/invalid inputs alert instead of silently rendering empty (the D-6 fix)', function () {
  const r = runCore_([], [], {
    dept: 'Sales', start: new Date(''), end: D(2026, 6, 30), cats: { OB_EXT: true },
  });
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0], /Department and Current date range/);

  const r2 = runCore_([], [], {
    dept: 'Sales', start: D(2026, 6, 1), end: D(2026, 6, 30), cats: {},
  });
  assert.match(r2.alerts[0], /at least one Data Category/);
  assert.equal(r2.dash.get(8, 2), '▶  GENERATE REPORT', 'button restored after the category alert');
});

test('core: REGRESSION (found by this suite) — a report WIDER than the remembered panel column keeps ALL its columns', function () {
  // The T-7 full-height panel clear ran after the fresh render and wiped
  // report cells at prevCol..prevCol+2 whenever the new report was wider
  // than the previous run\'s panel column: a narrow run (panel remembered at
  // col 13) followed by a 15-col comparison run lost TTT (P)/ATT (C)/ATT (P).
  const f = standardRows_();
  const r = runCore_(f.rows, f.durDisplays, {
    dept: 'Sales', start: D(2026, 6, 1), end: D(2026, 6, 30),
    compStart: D(2026, 5, 2), cats: { OB_EXT: true },
    prevDiagCol: 13,   // the previous, narrower run's panel column
  });
  const hdr = r.dash.getRange(HEADER_ROW, 1, 1, 15).getValues()[0];
  assert.deepEqual(hdr.slice(10), ['TTT (C)', 'TTT (P)', 'ATT (C)', 'ATT (P)', 'OB Ext Contacts'],
    'the fresh report\'s cols 11-15 must survive the old-panel clear');
  const alice = r.dash.getRange(HEADER_ROW + 1, 1, 1, 15).getValues()[0];
  assert.ok(Math.abs(alice[11] - 480 / DAY) < 1e-9, 'TTT (P) data cell survives too');
});

test('core: the T-7 case still holds — a stale panel BEYOND the render clear is fully wiped', function () {
  const f = standardRows_();
  const r = runCore_(f.rows, f.durDisplays, {
    dept: 'Sales', start: D(2026, 6, 1), end: D(2026, 6, 30),
    cats: { OB_EXT: true },
    prevDiagCol: 47,   // a previous WIDE run parked the panel past col 45
    preSeed: function (dash) {
      for (let row = 1; row <= 30; row++) dash.set(row, 47, 'stale-panel');
    },
  });
  for (let row = 1; row <= 30; row++) {
    assert.notEqual(r.dash.get(row, 47), 'stale-panel', 'stale panel row ' + row + ' cleared');
  }
});

test('core: diagnostics panel summary counts reconcile with the parsed lists', function () {
  const f = standardRows_();
  const r = runCore_(f.rows, f.durDisplays, {
    dept: 'Sales', start: D(2026, 6, 1), end: D(2026, 6, 30),
    cats: { OB_EXT: true },
  });
  const col = Number(h.state.props.CRB_DIAG_COL);
  // Row 3 headers CATEGORY/UNIQUE/TOTAL COUNT; row 4 = OB Ext Answered.
  assert.equal(r.dash.get(3, col), 'CATEGORY');
  assert.equal(r.dash.get(4, col), 'OB Ext Answered');
  assert.equal(r.dash.get(4, col + 1), 2, 'unique answered contacts: Cust A, Cust B');
  assert.equal(r.dash.get(4, col + 2), 5, 'total = 3 + 1 + 1 ((N) multipliers)');
});
