'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { assertSetValuesShape } = require('../harness/fakeSheet');

// The 'Inbound Calls' export tab (cdr-report/inboundCallsExport.js) -- the
// fallback COPY of Neon inbound_calls, and since the heatmap-sheet-fallback
// work ALSO the data source the dashboard's abandon heatmap degrades to
// during a Neon outage. Pinned here:
//   (1) the schema contract the dashboard reads BY POSITION: 24 headers with
//       Call Start / Is Internal at cols 16-17, the journey-fallback
//       columns at 18-22 and the direct-line fallback's First Agent / First
//       Ring Sec at 23-24 (FO-2), and the export SQL fetching
//       each field in that order;
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
  // neonEgress.js provides cdrNoteEgress_, which the export calls after its
  // payload fetch (one global scope in production; explicit here).
  files: ['neonEgress.js', 'inboundCallsExport.js', 'outboundCallsExport.js'],   // CRT-1 pins both removers
});

// Mutable fake sheet: a dense grid of display strings, header at row 1.
function fakeSheet(dataRows, opts) {
  opts = opts || {};
  const self = {
    _rows: [(opts.header || []).slice()].concat(dataRows.map(function (r) { return r.slice(); })),
    _maxCols: opts.maxCols || 24,
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
          assertSetValuesShape(vals, numRows, numCols);   // HT-2: the real API's shape rule
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
        setString: function (i, v) { if (capture) (capture.params = capture.params || {})[i] = v; },
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

// One Neon-shaped record (json_build_array order = the 24 header positions).
function neonRow(o) {
  return [o.date, o.id || 'c1', '', '', '', o.disposition || 'abandoned',
          '', false, 0, 0, o.entryQueue || 'A_Q_CSR', '', '', 1, 0,
          o.callStart === undefined ? '10:23:33' : o.callStart,
          o.internal === undefined ? false : o.internal,
          o.journey === undefined ? '' : o.journey,
          o.originAgent || '', o.originDept || '',
          o.relatedId || '', o.relatedKind || '',
          o.firstAgent || '', o.firstRing === undefined ? null : o.firstRing];
}

const HEADERS = function () { return h.ctx.INBOUND_EXPORT_HEADERS; };

test('schema contract: 24 headers, Call Start / Is Internal at 16-17, journey-fallback cols at 18-22, direct-line cols at 23-24, SQL fetches all', function () {
  assert.equal(HEADERS().length, 24);
  assert.equal(HEADERS()[15], 'Call Start');
  assert.equal(HEADERS()[16], 'Is Internal');
  assert.deepEqual(JSON.parse(JSON.stringify(HEADERS().slice(17))),
    ['Journey', 'Origin Agent', 'Origin Dept', 'Related Call Id', 'Related Call Kind',
     'First Agent', 'First Ring Sec']);
  assert.equal(h.ctx.INBOUND_EXPORT_CALL_START_COL, 16);

  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  const cap = {};
  h.ctx.getNeonConn = function () { return neonConnReturning([neonRow({ date: '2026-08-19' })], cap); };
  h.call('exportInboundCalls', '2026-08-19', '2026-08-19');
  assert.match(cap.sql, /COALESCE\(c\.is_internal, FALSE\)/);
  // Journey is WINDOWED (blank past INBOUND_EXPORT_JOURNEY_DAYS); the small
  // origin/related columns are unconditional.
  assert.match(cap.sql, /CASE WHEN c\.call_date >= \?::date THEN COALESCE\(c\.journey,''\) ELSE '' END/);
  assert.match(cap.sql, /COALESCE\(c\.origin_agent,''\), COALESCE\(c\.origin_dept,''\)/);
  assert.match(cap.sql, /COALESCE\(c\.related_call_id,''\), COALESCE\(c\.related_call_kind,''\)/);
  // FO-2: the ring is read through to_jsonb, so an export that runs before
  // cdr-import has added the column reads NULL instead of failing the query.
  assert.match(cap.sql, /COALESCE\(c\.first_agent,''\), \(to_jsonb\(c\) ->> 'first_ring_seconds'\)::int/);
  assert.doesNotMatch(cap.sql, /c\.first_ring_seconds/);
  // Param order: 1 = the journey cutoff, 2-3 = the BETWEEN range. A swapped
  // order here silently exports every journey blank.
  assert.equal(cap.params[2], '2026-08-19');
  assert.equal(cap.params[3], '2026-08-19');
  const cutoff = cap.params[1];
  assert.match(cutoff, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(cutoff < '2026-08-19' || cutoff <= new Date().toISOString().slice(0, 10),
    'cutoff is a real ISO date (default 90 days back)');
});

test('journey window: the cutoff honors INBOUND_EXPORT_JOURNEY_DAYS and defaults to 90', function () {
  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  const cap = {};
  h.ctx.getNeonConn = function () { return neonConnReturning([neonRow({ date: '2026-08-19' })], cap); };
  h.state.props.INBOUND_EXPORT_JOURNEY_DAYS = '10';
  try {
    h.call('exportInboundCalls', '2026-08-19', '2026-08-19');
    assert.equal(cap.params[1], h.call('ic_isoDaysAgo_', 10));
  } finally {
    delete h.state.props.INBOUND_EXPORT_JOURNEY_DAYS;
  }
  assert.equal(h.call('ic_journeyDays_'), 90, 'unset -> the 90-day default');
});

test('journey cells write verbatim (JSON starts with [, not formula-leading -- no quote prefix)', function () {
  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  const j = '[{"t":"10:00:00","name":"A_Q_CSR","kind":"queue"}]';
  h.ctx.getNeonConn = function () {
    return neonConnReturning([neonRow({ date: '2026-08-19', journey: j,
      originAgent: 'Margie Ingay', originDept: 'Customer Success',
      relatedId: '999', relatedKind: 'outbound' })]);
  };
  h.call('exportInboundCalls', '2026-08-19', '2026-08-19');
  assert.equal(sheet._rows[1][17], j, 'journey JSON lands byte-identical');
  assert.equal(sheet._rows[1][18], 'Margie Ingay');
  assert.equal(sheet._rows[1][19], 'Customer Success');
  assert.equal(sheet._rows[1][20], '999');
  assert.equal(sheet._rows[1][21], 'outbound');
});

test('FO-2: First Agent + First Ring Sec land at cols 23-24; an unknown ring is a BLANK cell, never 0', function () {
  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  h.ctx.getNeonConn = function () {
    return neonConnReturning([
      neonRow({ date: '2026-08-19', id: 'a', firstAgent: 'Anna Smith', firstRing: 5 }),
      neonRow({ date: '2026-08-19', id: 'b', firstAgent: 'Anna Smith', firstRing: 0 }),
      neonRow({ date: '2026-08-19', id: 'c' }),
    ]);
  };
  h.call('exportInboundCalls', '2026-08-19', '2026-08-19');
  assert.equal(sheet._rows[1][22], 'Anna Smith');
  assert.equal(sheet._rows[1][23], 5);
  assert.equal(sheet._rows[2][23], 0, 'a real 0 s ring stays 0');
  assert.equal(sheet._rows[3][22], '');
  assert.equal(sheet._rows[3][23], '', 'NULL ring -> blank');
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
  assert.equal(sheet._maxCols, 24);
  assert.equal(sheet._rows[0][15], 'Call Start');
  assert.equal(sheet._rows[0][16], 'Is Internal');
});

test('prune: drops only the contiguous pre-cutoff head block; INBOUND_EXPORT_KEEP_DAYS honored', function () {
  const mk = function (iso) { const r = new Array(24).fill(''); r[0] = iso; return r; };
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

// CRT-1 (broad-scan 2026-09-23): the per-date replace used to getValues the
// whole tab and setValues the KEPT rows back. A cell neutralized with a
// leading apostrophe reads back WITHOUT it, so every re-export re-armed it as
// a live formula. Both removers now delete matching rows as blocks and never
// write a kept row.
test('CRT-1: ic_/oc_removeRowsInRange_ delete matched rows as blocks and never rewrite a kept row', function () {
  ['ic_removeRowsInRange_', 'oc_removeRowsInRange_'].forEach(function (fn) {
    const rows = [
      ['2026-09-01', 'keep-a', "'=HYPERLINK(\"x\")"],
      ['2026-09-02', 'drop-1'], ['2026-09-02', 'drop-2'],
      ['2026-09-03', 'keep-b'],
      ['2026-09-04', 'drop-3'],
    ];
    const sheet = fakeSheet(rows, { header: ['Date'], maxRows: 6 });   // no spare rows: a full delete would be refused
    let writes = 0;
    const realGetRange = sheet.getRange;
    sheet.getRange = function () {
      const r = realGetRange.apply(sheet, arguments);
      const sv = r.setValues;
      r.setValues = function (v) { writes++; return sv.call(r, v); };
      r.getValues = function () { throw new Error('the whole-row read is the re-arm vector'); };
      return r;
    };
    const removed = h.call(fn, sheet, '2026-09-02', '2026-09-04', { '2026-09-02': true, '2026-09-04': true });
    assert.equal(removed, 3, fn);
    assert.equal(writes, 0, fn + ': kept rows are never rewritten');
    assert.deepEqual(JSON.parse(JSON.stringify(sheet._deleted)), [[6, 1], [3, 2]], fn + ': bottom-up blocks');
    assert.deepEqual(sheet._rows.slice(1).map(function (r) { return r[1]; }), ['keep-a', 'keep-b']);
    assert.equal(sheet._rows[1][2], "'=HYPERLINK(\"x\")", fn + ': the neutralized cell is untouched');
    assert.equal(sheet._maxRows, 9, fn + ': padded before the delete (the fake does not shrink on delete)');
  });
});

// ---------------------------------------------------------------------------
// Broad scan 2026-10-12, Batch 4.
// A Neon fake that answers the TOOL-1 changed-dates query separately from the
// windowed json_agg fetch (which honors its BETWEEN range), and records both.
function routedConn(byDate, changed, log) {
  return {
    prepareStatement: function (sql) {
      const p = {};
      return {
        setString: function (i, v) { p[i] = v; },
        executeQuery: function () {
          let out;
          if (/SELECT DISTINCT [co]\.call_date::text AS d FROM/.test(sql)) {
            log.push({ kind: 'changed', since: p[1], before: p[2], floor: p[3] });
            out = changed;
          } else {
            log.push({ kind: 'fetch', from: p[2], to: p[3] });
            out = [];
            Object.keys(byDate).sort().forEach(function (d) {
              if (d >= p[2] && d <= p[3]) out = out.concat(byDate[d]);
            });
          }
          let done = false;
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function () { return JSON.stringify(out); },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    createStatement: function () {
      return { executeQuery: function () {
        let done = false;
        return { next: function () { if (done) return false; done = true; return true; },
                 getString: function () { return 'true'; }, close: function () {} };
      }, close: function () {} };
    },
    close: function () {},
  };
}
function sheetRow(iso, id) { const r = new Array(24).fill(''); r[0] = iso; r[1] = id; return r; }
function idsOn(sheet, iso) {
  return sheet._rows.slice(1).filter(function (r) { return r[0] === iso; }).map(function (r) { return r[1]; });
}

test('TOOL-1: an incremental run also refreshes OLDER dates whose Neon rows changed since the watermark', function () {
  const today = h.call('ic_isoToday_');
  const d5 = h.call('ic_isoDaysAgo_', 5), d9 = h.call('ic_isoDaysAgo_', 9);
  const sheet = fakeSheet([sheetRow(d9, 'old-9'), sheetRow(d5, 'old-5'), sheetRow(today, 'old-t')], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  h.state.props.INBOUND_EXPORT_WATERMARK = '2026-01-01T00:00:00.000Z';
  delete h.state.props.INBOUND_EXPORT_PENDING;
  const log = [];
  h.ctx.getNeonConn = function () {
    return routedConn({
      [d9]: [neonRow({ date: d9, id: 'new-9' })],
      [d5]: [neonRow({ date: d5, id: 'new-5a' }), neonRow({ date: d5, id: 'new-5b' })],
      [today]: [neonRow({ date: today, id: 'new-t' })],
    }, [d9, d5], log);
  };
  const before = Date.now();
  const res = h.call('exportInboundCalls');
  assert.deepEqual(JSON.parse(JSON.stringify(res.changedDates)), [d5, d9], 'newest first');
  assert.deepEqual(idsOn(sheet, d5), ['new-5a', 'new-5b'], 'a changed older date is replaced, not duplicated');
  assert.deepEqual(idsOn(sheet, d9), ['new-9']);
  assert.deepEqual(idsOn(sheet, today), ['new-t'], 'the newest date still refreshes as before');
  const ch = log.filter(function (e) { return e.kind === 'changed'; })[0];
  assert.equal(ch.since, '2026-01-01T00:00:00.000Z', 'asks for rows changed since the stored watermark');
  assert.equal(ch.before, today, 'only dates OLDER than the main window');
  assert.ok(Date.parse(h.state.props.INBOUND_EXPORT_WATERMARK) <= before - 3500000,
    'the new watermark is the run START minus the skew margin');
  assert.equal(h.state.props.INBOUND_EXPORT_PENDING, '[]');
});

test('TOOL-1: at most IC_EXPORT_MAX_CHANGED_DATES_ a run, newest first; the rest wait in PENDING and run next time', function () {
  const today = h.call('ic_isoToday_');
  const changed = [], byDate = { [today]: [neonRow({ date: today, id: 't' })] };
  for (let i = 2; i <= 13; i++) {
    const d = h.call('ic_isoDaysAgo_', i);
    changed.push(d); byDate[d] = [neonRow({ date: d, id: 'n' + i })];
  }
  const sheet = fakeSheet([sheetRow(today, 'old-t')], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  h.state.props.INBOUND_EXPORT_WATERMARK = '2026-01-01T00:00:00.000Z';
  delete h.state.props.INBOUND_EXPORT_PENDING;
  h.ctx.getNeonConn = function () { return routedConn(byDate, changed, []); };
  const r1 = h.call('exportInboundCalls');
  assert.equal(r1.changedDates.length, h.ctx.IC_EXPORT_MAX_CHANGED_DATES_);
  assert.equal(r1.changedDates[0], h.call('ic_isoDaysAgo_', 2), 'newest first');
  const pending = JSON.parse(h.state.props.INBOUND_EXPORT_PENDING);
  assert.deepEqual(pending, [h.call('ic_isoDaysAgo_', 12), h.call('ic_isoDaysAgo_', 13)]);
  // Next run: nothing NEW changed, but the pending pair is still refreshed.
  h.ctx.getNeonConn = function () { return routedConn(byDate, [], []); };
  const r2 = h.call('exportInboundCalls');
  assert.deepEqual(JSON.parse(JSON.stringify(r2.changedDates)), pending);
  assert.equal(h.state.props.INBOUND_EXPORT_PENDING, '[]');
});

test('TOOL-1: the first run sets a watermark without asking; an explicit range never reads or moves it', function () {
  const today = h.call('ic_isoToday_');
  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  delete h.state.props.INBOUND_EXPORT_WATERMARK;
  delete h.state.props.INBOUND_EXPORT_PENDING;
  let log = [];
  h.ctx.getNeonConn = function () { return routedConn({ [today]: [neonRow({ date: today })] }, ['2026-01-01'], log); };
  h.call('exportInboundCalls');
  assert.equal(log.filter(function (e) { return e.kind === 'changed'; }).length, 0, 'no baseline query');
  assert.ok(h.state.props.INBOUND_EXPORT_WATERMARK, 'baseline watermark stored');
  const wm = h.state.props.INBOUND_EXPORT_WATERMARK;
  log = [];
  h.call('exportInboundCalls', today, today);
  assert.equal(log.filter(function (e) { return e.kind === 'changed'; }).length, 0);
  assert.equal(h.state.props.INBOUND_EXPORT_WATERMARK, wm, 'an explicit range leaves the watermark alone');
});

test('TOOL-1: the outbound twin queries outbound_calls with the same plan and properties', function () {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'apps-script', 'cdr-report', 'outboundCallsExport.js'), 'utf8');
  assert.match(src, /SELECT DISTINCT o\.call_date::text AS d FROM outbound_calls o "/);
  assert.match(src, /"WHERE o\.updated_at > \?::timestamptz AND o\.call_date < \?::date AND o\.call_date >= \?::date\) x"/);
  assert.match(src, /props\.setProperty\('OUTBOUND_EXPORT_WATERMARK', runStartIso\);/);
  assert.match(src, /props\.setProperty\('OUTBOUND_EXPORT_PENDING', JSON\.stringify\(changedLater\)\);/);
  assert.match(src, /ic_planChangedDates_\(changed, pending\.filter/);
});

test('TOOL-3: a failed append (the cell cap) leaves the previous copy of the date in place', function () {
  const sheet = fakeSheet([sheetRow('2026-08-19', 'old-a'), sheetRow('2026-08-19', 'old-b')], { header: HEADERS(), maxRows: 3 });
  sheet.insertRowsAfter = function () { throw new Error('This action would increase the number of cells beyond the limit'); };
  h.state.spreadsheet = fakeSS(sheet);
  h.ctx.getNeonConn = function () {
    return neonConnReturning([neonRow({ date: '2026-08-19', id: 'n1' }), neonRow({ date: '2026-08-19', id: 'n2' }), neonRow({ date: '2026-08-19', id: 'n3' })]);
  };
  assert.throws(function () { h.call('exportInboundCalls', '2026-08-19', '2026-08-19'); }, /cells beyond the limit/);
  assert.deepEqual(idsOn(sheet, '2026-08-19'), ['old-a', 'old-b'], 'the old copy survives -- it used to be deleted first');
});

test('TOOL-3: a successful run appends first, then removes ONLY the rows above the append', function () {
  const sheet = fakeSheet([sheetRow('2026-08-18', 'keep'), sheetRow('2026-08-19', 'old')], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  h.ctx.getNeonConn = function () { return neonConnReturning([neonRow({ date: '2026-08-19', id: 'fresh' })]); };
  const res = h.call('exportInboundCalls', '2026-08-19', '2026-08-19');
  assert.equal(res.replaced, 1);
  assert.deepEqual(idsOn(sheet, '2026-08-19'), ['fresh']);
  assert.deepEqual(idsOn(sheet, '2026-08-18'), ['keep']);
});

test('TOOL-3: a removal failure rolls the append back, so a run never leaves both copies', function () {
  const sheet = fakeSheet([sheetRow('2026-08-19', 'old')], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  const realDelete = sheet.deleteRows;
  let calls = 0;
  sheet.deleteRows = function (start, n) {
    if (calls++ === 0) throw new Error('Service error: Spreadsheets');   // the old-row removal fails
    return realDelete(start, n);                                          // the rollback succeeds
  };
  h.ctx.getNeonConn = function () { return neonConnReturning([neonRow({ date: '2026-08-19', id: 'fresh' })]); };
  assert.throws(function () { h.call('exportInboundCalls', '2026-08-19', '2026-08-19'); }, /Service error/);
  assert.deepEqual(idsOn(sheet, '2026-08-19'), ['old'], 'back to the previous copy only');
});

test('TOOL-2: a Neon-down run tags its failure row; any other failure is untagged (and so still emails)', function () {
  const sheet = fakeSheet([], { header: HEADERS() });
  h.state.spreadsheet = fakeSS(sheet);
  const logged = [];
  h.ctx.logPipelineHealth_ = function (ss, ev) { logged.push(JSON.parse(JSON.stringify(ev))); };
  h.ctx.getNeonConn = function () { throw new Error('The database connection failed'); };
  h.call('runInboundCallsExport_');
  assert.equal(logged[0].notes, h.ctx.EXPORT_NEON_UNREACHABLE_TAG_ + 'The database connection failed');
  logged.length = 0;
  h.ctx.getNeonConn = function () {
    return { prepareStatement: function () { throw new Error('ERROR: column "first_agent" does not exist'); }, close: function () {} };
  };
  h.call('runInboundCallsExport_');
  assert.equal(logged[0].status, 'failure');
  assert.equal(logged[0].notes.indexOf(h.ctx.EXPORT_NEON_UNREACHABLE_TAG_), -1, 'a SQL error is not the expected outage');
  // The outbound runner tags the same way.
  const ob = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'apps-script', 'cdr-report', 'outboundCallsExport.js'), 'utf8');
  assert.match(ob, /notes: \(\(e && e\.neonUnreachable\) \? EXPORT_NEON_UNREACHABLE_TAG_ : ''\) \+ String/);
  assert.match(ob, /try \{ conn = getNeonConn\(\); \} catch \(eConn\) \{/);
});

test('TOOL-1 / TOOL-3: the outbound twin refreshes a changed older date and replaces (not duplicates) it', function () {
  const W = h.ctx.OUTBOUND_EXPORT_HEADERS.length;
  const obRow = function (iso, id) { const r = [iso, id, '', 'Ann', '101', 'CSR', true, 30, '', 1, '10:00:00', '']; return r.slice(0, W); };
  const shRow = function (iso, id) { const r = new Array(W).fill(''); r[0] = iso; r[1] = id; return r; };
  const today = h.call('oc_isoToday_');
  const d4 = h.call('oc_isoDaysAgo_', 4);
  const sheet = fakeSheet([shRow(d4, 'old-4'), shRow(today, 'old-t')], { header: h.ctx.OUTBOUND_EXPORT_HEADERS, maxCols: W });
  h.state.spreadsheet = { getSheetByName: function (n) { return n === 'Outbound Calls' ? sheet : null; } };
  h.state.props.OUTBOUND_EXPORT_WATERMARK = '2026-01-01T00:00:00.000Z';
  delete h.state.props.OUTBOUND_EXPORT_PENDING;
  const log = [];
  h.ctx.getNeonConn = function () {
    return routedConn({ [d4]: [obRow(d4, 'new-4')], [today]: [obRow(today, 'new-t')] }, [d4], log);
  };
  const res = h.call('exportOutboundCalls');
  assert.deepEqual(JSON.parse(JSON.stringify(res.changedDates)), [d4]);
  assert.deepEqual(idsOn(sheet, d4), ['new-4']);
  assert.deepEqual(idsOn(sheet, today), ['new-t']);
  assert.equal(h.state.props.OUTBOUND_EXPORT_PENDING, '[]');
  assert.ok(h.state.props.OUTBOUND_EXPORT_WATERMARK > '2026-01-01');
});
