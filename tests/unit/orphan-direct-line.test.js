'use strict';

// DCA-6 (owner 2026-11-11): the orphan check finds a NEW employee who is on an
// extension the roster lists for a FORMER employee.
//
// Former employees stay on DO NOT EDIT! with their old extension, and 8x8
// gives that extension to someone new. Since DCA-1 the Direct build credits
// the new person's calls to NO ONE rather than to the person who left -- and
// said so only in the execution log. The orphan check (the Outlier Fix list
// and the Overview nag) reads DQE Historical Data, which holds QUEUE calls, so
// a new hire who takes no queue calls was never listed and nobody was told.
//
// Two halves in two projects, one contract between them:
//   - cdr-import: the Direct build names those people at the END of its
//     Pipeline Health note (directCallMetrics.js::dcUnrosteredNote_);
//   - dashboard: computeOrphans_ folds them in (OrphanFix.gs).
// The first test drives the REAL build's output through the REAL parser, so a
// change to either side's format fails here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid, dqeRow, dqeSheet } = require('../harness/fixtures');

const imp = loadGas({ project: 'cdr-import', files: ['directCallMetrics.js'] });
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'OrphanFix.gs'], capture: ['ORPHAN_DIRECT_TAG_'] });
const J = function (x) { return JSON.parse(JSON.stringify(x)); };

// ── cdr-import: the note ─────────────────────────────────────────────────────

// Anna (CSR) left; the roster still lists ext 101 for her. 8x8 now shows
// "Nina New" on 101. Bob keeps 102.
const MAPS = {
  extToAgent: { '101': { name: 'Anna', dept: 'CSR' }, '102': { name: 'Bob', dept: 'CSR' } },
  queueExtSet: new Set(['103']),
  exclusions: new Set(['103']),
};
function row(o) {
  const r = new Array(26).fill('');
  r[0] = o.cid; r[2] = o.start; r[5] = o.dir; r[6] = o.talk || ''; r[7] = o.callTime || '';
  r[8] = o.caller || ''; r[9] = o.callerName || ''; r[10] = o.callee || ''; r[11] = o.calleeName || '';
  r[23] = o.missed ? 'Missed' : ''; r[25] = o.answered ? 'Answered' : '';
  return r;
}
const D = '11/09/2026 ';
function buildMeta() {
  const res = imp.fn('computeDirectCallMetrics')([new Array(26).fill('')].concat([
    row({ cid: 'N1', start: D + '10:00:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:10',
          caller: '+15551230000', callee: '101', calleeName: 'Nina New', answered: true }),
    row({ cid: 'N2', start: D + '10:10:00', dir: 'Outgoing', talk: '0:01:00', callTime: '0:01:05',
          caller: '101', callerName: 'Nina New', callee: '+15551230001' }),
    row({ cid: 'B1', start: D + '11:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:05',
          caller: '+15551230002', callee: '102', calleeName: 'Bob', answered: true }),
  ]), MAPS, {});
  return res.meta;
}

test('DCA-6: the Direct build names a person on a former employee\'s extension, and the dashboard reads it back', function () {
  const note = imp.call('dcUnrosteredNote_', buildMeta());
  assert.equal(note, ' | unrostered=[["Nina New","101","Anna",2]]');
  assert.ok(!/5551230/.test(note), 'no phone number in the note');
  // The whole Pipeline Health note, as the daily import writes it.
  const full = 'Mon Nov 09 2026 | agents=1 missedBusy=0 missedFree=0 neon=ok' + note;
  const got = J(h.call('orphanDirectFromHealthRows_',
    [{ step: 'processIntegratedHistory:Direct', status: 'success', notes: full }], '2026-05-01'));
  assert.deepEqual(got, [{ name: 'Nina New', ext: '101', listedFor: 'Anna', calls: 2, dateIso: '2026-11-09' }]);
  // The two sides agree on the tag.
  assert.equal(imp.ctx.DC_UNROSTERED_TAG_, h.consts.ORPHAN_DIRECT_TAG_);
  assert.equal(h.consts.ORPHAN_DIRECT_TAG_, 'unrostered=');
});

test('DCA-6: no note when 8x8 names nobody off the roster; the busiest come first and the list is capped', function () {
  assert.equal(imp.call('dcUnrosteredNote_', { attribution: { mismatches: [] } }), '');
  assert.equal(imp.call('dcUnrosteredNote_', {}), '');
  assert.equal(imp.call('dcUnrosteredNote_', null), '');
  const many = [];
  for (let i = 0; i < 30; i++) many.push({ ext: String(200 + i), rosterName: 'Old ' + i, legName: 'New ' + i, n: 30 - i });
  const note = imp.call('dcUnrosteredNote_', { attribution: { mismatches: many } });
  const list = JSON.parse(note.slice(note.indexOf('[')));
  assert.equal(list.length, imp.ctx.DC_UNROSTERED_MAX_);
  assert.deepEqual(list[0], ['New 0', '200', 'Old 0', 30]);
});

test('DCA-6: every Direct success row carries the note as its LAST segment', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-import', 'autoImport.js'), 'utf8');
  // The daily block, the bulk queue and the F7 catch-up: three success rows.
  const tails = src.match(/\+ directUnrosteredNote_\(dres\),\s+\/\/ DCA-6: must stay the LAST segment\s*\n\s*\}\);/g) || [];
  assert.equal(tails.length, 3, 'each Direct success row ends with the note');
  assert.match(src, /step: 'processIntegratedHistory:Direct',\s*\n\s*status: 'success',[\s\S]{0,400}directUnrosteredNote_\(dres\)/);
  assert.match(src, /step:\s+'bulkBackfill:Direct',\s*\n\s*status:\s+'success',[\s\S]{0,400}directUnrosteredNote_\(dres\)/);
});

// ── dashboard: the parser ────────────────────────────────────────────────────

const OK = 'processIntegratedHistory:Direct';
const noteFor = function (day, list) {
  return day + ' | agents=3 missedBusy=0 missedFree=1 neon=ok' + (list ? ' | unrostered=' + JSON.stringify(list) : '');
};

test('DCA-6: the NEWEST Direct row for a date speaks for it -- a re-import after the fix clears the date', function () {
  const rows = [   // newest first
    { step: OK, status: 'success', notes: noteFor('Tue Nov 10 2026', [['Nina New', '101', 'Anna', 4]]) },
    { step: OK, status: 'success', notes: noteFor('Mon Nov 09 2026', null) },                      // re-imported after she was rostered
    { step: 'bulkBackfill:Direct', status: 'success', notes: noteFor('Mon Nov 09 2026', [['Nina New', '101', 'Anna', 9]]) },
    { step: OK, status: 'success', notes: noteFor('Fri Nov 06 2026', [['Nina New', '101', 'Anna', 3], ['Raj New', '140', 'Old Raj', 1]]) },
  ];
  const got = J(h.call('orphanDirectFromHealthRows_', rows, '2026-05-01'));
  assert.deepEqual(got.map(function (d) { return [d.dateIso, d.name, d.calls]; }),
    [['2026-11-10', 'Nina New', 4], ['2026-11-06', 'Nina New', 3], ['2026-11-06', 'Raj New', 1]]);
});

test('DCA-6: other steps, failures, old dates and unreadable tails are skipped', function () {
  const rows = [
    { step: 'processIntegratedHistory:DQE', status: 'success', notes: noteFor('Tue Nov 10 2026', [['X', '101', 'Anna', 1]]) },
    { step: OK, status: 'failure', notes: noteFor('Mon Nov 09 2026', [['X', '101', 'Anna', 1]]) },
    { step: OK, status: 'success', notes: 'Fri Nov 06 2026 | agents=1 | unrostered=[["broken"' },
    { step: OK, status: 'success', notes: noteFor('Thu Nov 05 2026', [['', '101', 'Anna', 1], ['No Ext', 'abc', 'Anna', 1], 'junk']) },
    { step: OK, status: 'success', notes: noteFor('Mon Jan 05 2026', [['Too Old', '101', 'Anna', 1]]) },
    { step: OK, status: 'success', notes: 'no date here | unrostered=[["X","101","Anna",1]]' },
  ];
  assert.deepEqual(J(h.call('orphanDirectFromHealthRows_', rows, '2026-05-01')), []);
  assert.deepEqual(J(h.call('orphanDirectFromHealthRows_', null, '2026-05-01')), []);
});

// ── dashboard: computeOrphans_ ───────────────────────────────────────────────

const PH_HEADER = ['Timestamp', 'Step', 'Status', 'Rows', 'Duration (ms)', 'Notes'];
function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dayNote(iso, list) {
  const p = iso.split('-');
  return noteFor(new Date(+p[0], +p[1] - 1, +p[2], 12).toDateString(), list);
}
function install(opts) {
  opts = opts || {};
  h.state.userEmail = 'admin@x.com';
  h.state.props = { ADMIN_EMAILS: 'admin@x.com', SPREADSHEET_ID: 'fake' };
  const sheets = {
    'DO NOT EDIT!': rosterGrid(opts.roster || { CSR: ['Anna, 101', 'Bob, 102'], Sales: ['Cara, 301'] }),
    'Pipeline Health': [PH_HEADER].concat(opts.health || []),
  };
  if (opts.dqe) sheets['DQE Historical Data'] = dqeSheet(opts.dqe);
  if (opts.aliases) {
    sheets['Agent Alias Overrides'] = [['Old Name', 'Canonical Name', 'Active', 'Added By', 'Added At', 'Notes']].concat(opts.aliases);
  }
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  h.state.cache.clear();
  ['DQE_DATE_BOUNDS_MEMO_', 'DQE_SHEET_ROWS_MEMO_', 'DQE_DATE_COL_MEMO_', 'DQE_EXT_GRID_MEMO_'].forEach(function (m) {
    if (m in h.ctx) h.ctx[m] = null;
  });
}
const d2 = isoDaysAgo(2), d3 = isoDaysAgo(3);

test('DCA-6: a new hire who takes NO queue calls is on the orphan list, with her own extension and who it is listed for', function () {
  install({ health: [   // oldest first, as the sheet holds them
    [new Date(), OK, 'success', 5, 100, dayNote(d3, [['Nina New', '101', 'Anna', 3]])],
    [new Date(), OK, 'success', 5, 100, dayNote(d2, [['Nina New', '101', 'Anna', 4]])],
  ] });
  const got = J(h.call('computeOrphans_'));
  assert.deepEqual(got, [{ name: 'Nina New', rows: 0, lastSeen: d2, sampleExts: [],
    directExt: '101', directListedFor: 'Anna', directCalls: 7 }]);
});

test('DCA-6: she drops off once she is on a roster, or once the name is mapped to a roster name', function () {
  const health = [[new Date(), OK, 'success', 5, 100, dayNote(d2, [['Nina New', '101', 'Anna', 4]])]];
  install({ health: health, roster: { CSR: ['Anna, 101', 'Bob, 102', 'Nina New, 101'] } });
  assert.deepEqual(J(h.call('computeOrphans_')), [], 'rostered: nothing left to fix');
  install({ health: health, aliases: [['Nina New', 'Bob', true, 'admin@x.com', '', '']] });
  assert.deepEqual(J(h.call('computeOrphans_')), [], 'an active alias already routes the name');
  install({ health: health, aliases: [['Nina New', 'Bob', false, 'admin@x.com', '', '']] });
  assert.equal(J(h.call('computeOrphans_')).length, 1, 'a DEACTIVATED alias does not');
});

test('DCA-6: someone who is also a queue orphan gets ONE entry carrying both, and plain queue orphans are unchanged', function () {
  install({
    dqe: [
      dqeRow({ date: new Date(isoDaysAgo(2) + 'T12:00:00'), agent: 'Nina New', ext: '103', rung: 5, answered: 5 }),
      dqeRow({ date: new Date(isoDaysAgo(4) + 'T12:00:00'), agent: 'Typo Bobb', ext: '103', rung: 2, answered: 2 }),
      dqeRow({ date: new Date(isoDaysAgo(2) + 'T12:00:00'), agent: 'Bob', ext: '103', rung: 9, answered: 9 }),
    ],
    health: [[new Date(), OK, 'success', 5, 100, dayNote(d2, [['Nina New', '101', 'Anna', 4]])]],
  });
  const got = J(h.call('computeOrphans_'));
  assert.deepEqual(got.map(function (o) { return o.name; }), ['Nina New', 'Typo Bobb']);
  const nina = got[0], typo = got[1];
  assert.equal(nina.rows, 1, 'her DQE row count is still the queue rows');
  assert.deepEqual(nina.sampleExts, ['103'], 'the queue extension stays in its own field');
  assert.equal(nina.directExt, '101');
  assert.equal(nina.directCalls, 4);
  assert.equal(typo.directExt, undefined, 'a queue-only orphan has no direct fields');
  assert.deepEqual(Object.keys(typo).sort(), ['lastSeen', 'name', 'rows', 'sampleExts']);
});

test('DCA-6: an empty DQE window or a missing Pipeline Health sheet costs nothing else', function () {
  // No DQE sheet at all: the direct-line people are still found (this path used to return early).
  install({ health: [[new Date(), OK, 'success', 5, 100, dayNote(d2, [['Nina New', '101', 'Anna', 4]])]] });
  assert.equal(J(h.call('computeOrphans_')).length, 1);
  // No Pipeline Health sheet: the queue orphans are still found.
  install({ dqe: [dqeRow({ date: new Date(isoDaysAgo(2) + 'T12:00:00'), agent: 'Typo Bobb', ext: '103', rung: 2 })] });
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 101', 'Bob, 102'] }),
    'DQE Historical Data': dqeSheet([dqeRow({ date: new Date(isoDaysAgo(2) + 'T12:00:00'), agent: 'Typo Bobb', ext: '103', rung: 2 })]),
  } });
  assert.deepEqual(J(h.call('computeOrphans_')).map(function (o) { return o.name; }), ['Typo Bobb']);
});

// ── client + nag ─────────────────────────────────────────────────────────────

test('DCA-6: the Outlier Fix row says whose extension it is and pre-fills the person\'s OWN extension; the nag ranks by both counts', function () {
  const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'script-7-admin.html'), 'utf8');
  assert.match(admin, /const direct = o\.directExt\s*\n\s*\? '<div class="of-direct-note">Direct line ' \+ escapeHtml\(o\.directExt\)/);
  assert.match(admin, /the roster lists it for ' \+ escapeHtml\(o\.directListedFor\)/);
  assert.match(admin, /const addExts = o\.directExt \? escapeHtml\(o\.directExt\) : \(o\.sampleExts \|\| \[\]\)\.map\(escapeHtml\)\.join\(', '\);/);
  assert.match(admin, /'value="' \+ addExts \+ '">'/);
  const ov = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'CompanyOverview.gs'), 'utf8');
  assert.match(ov, /\(b\.rows \+ \(b\.directCalls \|\| 0\)\) - \(a\.rows \+ \(a\.directCalls \|\| 0\)\)/);
});
