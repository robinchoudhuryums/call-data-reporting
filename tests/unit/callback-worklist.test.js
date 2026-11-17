'use strict';

// P11 (owner decision 2026-11-17; Operator State #95): the callback worklist,
// the ONE page a caller's phone number can be shown on. The owner approved it
// on five terms, and each is enforced on the server -- this suite pins them:
//   1. WHO   -- admins; a manager only while CALLBACK_NUMBERS_MANAGERS is
//               exactly `true`, only for their own department, and only once
//               the outbound vetting gate is released;
//   2. WHERE -- the list never carries a number; nothing is cached or stored;
//   3. HOW MUCH -- one call per request, under a per-user hourly cap;
//   4. AUDIT -- a row is appended BEFORE the reply, without the number, and an
//               unlogged number is never returned;
//   5. SCOPE -- only a call that is still on the worklist, only while its raw
//               tab exists.
// And the number shown is PROVEN: only the candidate whose HMAC equals the
// call's stored caller_hash is ever returned.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas, DASHBOARD_DIR } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const J = (x) => JSON.parse(JSON.stringify(x));
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'DeptConfig.gs', 'Setup.gs', 'CallerLookup.gs',
          'QCDReport.gs', 'OutboundReport.gs', 'CallbackWorklist.gs'],
  capture: ['SHEETS', 'CALLBACK_NUMBER_LOG_HEADERS', 'ACCESS_CONTROL_HEADERS'],
});
const imp = loadGas({ project: 'cdr-import', files: ['buildDQEHistoricalData.js', 'neonWrite.js', 'inboundCalls.js'] });
const SHEETS = h.consts.SHEETS;
const SECRET = 'test-secret';
const IMPORT_ID = 'import-workbook-id';

// Dates relative to "now" (the worklist window is the last 14 days).
const dayIso = (n) => { const d = new Date(Date.now() - n * 86400000); return d.toISOString().slice(0, 10); };
const D1 = dayIso(2), D2 = dayIso(3), OLD = dayIso(13);
const mdY = (iso) => iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4);

function leg(o) {
  const r = new Array(44).fill('');
  r[0] = o.callId; r[1] = o.legId; r[2] = o.start; r[4] = o.stop || '';
  r[5] = o.direction; r[6] = o.talk || '0:00:00'; r[7] = o.callTime || '0:00:00';
  r[8] = o.caller; r[10] = o.callee; r[11] = o.calleeName || '';
  r[14] = o.parent || 'N/A'; r[15] = 'N/A'; r[16] = o.dialIn || 'N/A';
  r[23] = o.missed || '-'; r[24] = o.abandoned || '-'; r[25] = o.answered || '-';
  r[32] = '0:00:00'; r[33] = 'N/A'; r[34] = 'N/A'; r[36] = 'N/A';
  return r;
}
// One day's raw tab: a queue abandon (call 9001), a call with a satellite leg
// under a parent id (9002), an outbound call whose recording leg is marked
// Incoming (9003, NX-2) and an anonymous caller (9004).
function rawRows(iso) {
  const t = (hms) => mdY(iso) + ' ' + hms;
  return [
    leg({ callId: '9001', legId: 1, start: t('10:00:00'), stop: t('10:00:20'), direction: 'Incoming', caller: '12145550101', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
    leg({ callId: '9001', legId: 2, start: t('10:00:20'), stop: t('10:02:00'), direction: 'Incoming', caller: '12145550101', callee: '103', calleeName: 'A_Q_CSR', missed: 'Missed', abandoned: 'Abandoned' }),
    leg({ callId: '9002', legId: 1, start: t('11:00:00'), stop: t('11:01:00'), direction: 'Incoming', caller: '+1 (469) 555-0202', callee: '103', calleeName: 'A_Q_CSR', missed: 'Missed', abandoned: 'Abandoned' }),
    leg({ callId: '9002b', parent: '9002', legId: 2, start: t('11:00:05'), stop: t('11:00:30'), direction: 'Internal', caller: '103', callee: '352', calleeName: 'Dan Agent', missed: 'Missed' }),
    leg({ callId: '9003', legId: 1, start: t('12:00:00'), stop: t('12:00:30'), direction: 'Outgoing', caller: '352', callee: '18175550303', talk: '0:00:20', answered: 'Answered' }),
    leg({ callId: '9003', legId: 2, start: t('12:00:00'), stop: t('12:00:30'), direction: 'Incoming', caller: '18175550303', callee: 'CallRecording (352)' }),
    leg({ callId: '9004', legId: 1, start: t('13:00:00'), stop: t('13:01:00'), direction: 'Incoming', caller: 'Anonymous', callee: '103', calleeName: 'A_Q_CSR', missed: 'Missed', abandoned: 'Abandoned' }),
  ];
}
const HEADER = new Array(44).fill('h');
const hashOf = (num) => h.call('callerLookupHashPhone_', num, SECRET);

// The Not-called-back payload getOutboundUncalled returns (stubbed: its own
// engine is pinned in outbound-report.test.js).
function uncalled(over) {
  return Object.assign({
    meta: { available: true, truncated: false, callbackWindowDays: 3 },
    episodes: [
      { firstIso: D2, status: 'missed', daysLeft: null, attempts: [{ callDate: D2, callId: '9002' }, { callDate: D1, callId: '9001' }], late: { calledBack: null, gotThrough: null } },
      { firstIso: D1, status: 'pending', daysLeft: 1, attempts: [{ callDate: D1, callId: '9002' }], late: { calledBack: null, gotThrough: null } },
      { firstIso: OLD, status: 'missed', daysLeft: null, attempts: [{ callDate: OLD, callId: '8001' }], late: { calledBack: null, gotThrough: null } },
      // Called back late / got through later: no longer owed a call.
      { firstIso: D2, status: 'missed', attempts: [{ callDate: D2, callId: '9004' }], late: { calledBack: { daysAfter: 5, team: 'own' }, gotThrough: null } },
      { firstIso: D2, status: 'missed', attempts: [{ callDate: D2, callId: '9005' }], late: { calledBack: null, gotThrough: { daysAfter: 6 } } },
    ],
    calls: [
      { callDate: D1, callId: '9001', cstStart: '12:00:00', entryQueue: 'A_Q_CSR', dialIn: 'Main line', waitSeconds: 100 },
      { callDate: D1, callId: '9002', cstStart: '13:00:00', entryQueue: 'A_Q_CSR', dialIn: null, waitSeconds: 60 },
    ],
  }, over || {});
}

let stored = {};      // 'date|id' -> the call's stored caller_hash
let uncalledCalls = [];
function install(email, opts) {
  opts = opts || {};
  h.state.userEmail = email;
  h.state.props = { ADMIN_EMAILS: 'admin@x.com', SPREADSHEET_ID: 'fake', HMAC_SECRET: SECRET, CDR_IMPORT_SS_ID: IMPORT_ID };
  Object.assign(h.state.props, opts.props || {});
  (opts.unset || []).forEach((k) => { delete h.state.props[k]; });
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: Object.assign({
    'DO NOT EDIT!': rosterGrid({ CSR: ['Dan Agent, 352'], Power: ['Rhea Power, 401'] }),
    [SHEETS.ACCESS_CONTROL]: [h.consts.ACCESS_CONTROL_HEADERS.slice(), ['manager@x.com', 'CSR'], ['power@x.com', 'Power']],
    [SHEETS.CALLBACK_NUMBER_LOG]: [h.consts.CALLBACK_NUMBER_LOG_HEADERS.slice()],
  }, opts.sheets || {}) });
  const tabs = {};
  tabs['Call_Legs_' + D1] = [HEADER].concat(rawRows(D1));
  tabs['Call_Legs_' + D2] = [HEADER].concat(rawRows(D2));
  tabs['Notes'] = [['x']];
  h.state.spreadsheetsById = {};
  h.state.spreadsheetsById[IMPORT_ID] = makeFakeSpreadsheet({ sheets: tabs });
  h.state.strictOpenById = false;
  h.state.cache.clear();
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.OUTBOUND_VETTING_GATE_ = opts.released ? false : true;
  stored = {};
  stored[D1 + '|9001'] = hashOf('+12145550101');
  stored[D1 + '|9002'] = hashOf('+14695550202');
  stored[D2 + '|9002'] = hashOf('+14695550202');
  uncalledCalls = [];
  h.ctx.getOutboundUncalled = function (req) { uncalledCalls.push(J(req)); return (opts.uncalled || uncalled)(); };
  h.ctx.getDashboardNeonConn_ = function () {
    return { prepareStatement: function (sql) { const p = [];
      return { setString: function (i, v) { p[i - 1] = v; },
        executeQuery: function () { let used = false; const v = stored[p[0] + '|' + p[1]];
          return { next: () => { if (used || v == null) return false; used = true; return true; }, getString: () => v, close: () => {} }; },
        close: () => {} }; }, close: () => {} };
  };
}
const logRows = () => h.state.spreadsheet.getSheetByName(SHEETS.CALLBACK_NUMBER_LOG).getDataRange().getValues().slice(1).map((r) => r.slice(1).map(String));

test('P11: the worklist lists only callers still owed a call, pending first, and never carries a number', function () {
  install('admin@x.com');
  const out = J(h.call('getCallbackWorklist', { department: '' }));
  assert.equal(out.meta.available, true);
  assert.deepEqual(uncalledCalls.length, 1);
  assert.equal(uncalledCalls[0].department, 'ALL');
  const span = Math.round((Date.parse(uncalledCalls[0].to) - Date.parse(uncalledCalls[0].from)) / 86400000);
  assert.equal(span, 13, 'the last 14 days, ending yesterday');
  // The pending caller first; then the missed ones, newest latest-try first.
  // The two episodes handled late (called back, got through) are not owed a call.
  assert.deepEqual(out.rows.map((r) => [r.status, r.callDate, r.callId, r.attempts, r.held]),
    [['pending', D1, '9002', 1, true], ['missed', D1, '9001', 2, true], ['missed', OLD, '8001', 1, false]]);
  assert.equal(out.rows[1].entryQueue, 'A_Q_CSR');
  assert.equal(out.rows[1].calls.length, 2, 'every try of the episode is the same caller');
  assert.deepEqual([out.meta.canReveal, out.meta.numbersConfigured, out.meta.managersMayReveal, out.meta.revealCap], [true, true, false, 40]);
  assert.ok(!/\d{10}/.test(JSON.stringify(out).replace(/"(from|to|firstIso|callDate|dataThrough)":"[\d-]+"/g, '')), 'no phone-number-shaped value in the list');
  // Without the import workbook the list still loads; it just cannot show numbers.
  install('admin@x.com', { unset: ['CDR_IMPORT_SS_ID'] });
  const bare = J(h.call('getCallbackWorklist', {}));
  assert.equal(bare.meta.numbersConfigured, false);
  assert.equal(bare.rows[0].held, null);
  // Neon unreachable: unavailable, no rows.
  install('admin@x.com', { uncalled: () => ({ meta: { available: false }, episodes: [], calls: [] }) });
  assert.equal(h.call('getCallbackWorklist', {}).meta.available, false);
});

test('P11: a number is shown for one listed call, proven against the stored hash, and logged first', function () {
  install('admin@x.com');
  const out = J(h.call('revealCallbackNumber', { department: '', callDate: D1, callId: '9001' }));
  assert.deepEqual(out, { ok: true, state: 'found', number: '(214) 555-0101' });
  assert.deepEqual(logRows(), [['admin@x.com', 'admin', '(all departments)', D1, '9001', 'shown']]);
  assert.ok(!/5550101/.test(JSON.stringify(logRows())), 'the log never holds the number');
  // A call whose legs sit under a PARENT id, and a formatted caller cell.
  assert.equal(h.call('revealCallbackNumber', { department: 'CSR', callDate: D1, callId: '9002' }).number, '(469) 555-0202');
  assert.equal(logRows()[1][2], 'CSR');
  // Any try of the episode may be asked for (they are the same caller).
  assert.equal(h.call('revealCallbackNumber', { department: '', callDate: D2, callId: '9002' }).ok, true);
  // Nothing was cached but the per-user counter (timestamps only).
  const cached = JSON.stringify(Array.from(h.state.cache.entries()));
  assert.match(cached, /cbwReveal:v1:admin@x\.com/);
  assert.ok(!/555-?0[12]0[12]|5550101|5550202/.test(cached), 'no number in the cache');
});

test('P11: a number that cannot be proven is not shown -- wrong hash, no secret, no stored hash', function () {
  install('admin@x.com');
  stored[D1 + '|9001'] = hashOf('+19999999999');
  assert.deepEqual(J(h.call('revealCallbackNumber', { callDate: D1, callId: '9001' })), { ok: false, state: 'unconfirmed' });
  delete stored[D1 + '|9001'];
  assert.equal(h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }).state, 'unconfirmed');
  install('admin@x.com', { unset: ['HMAC_SECRET'] });
  assert.equal(h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }).state, 'unconfirmed');
  assert.deepEqual(logRows().map((r) => r[5]), ['not shown: unconfirmed']);
});

test('P11: outside the scope nothing is shown -- not on the worklist, the raw tab gone, the call not in its tab, not set up', function () {
  install('admin@x.com');
  // 9003 is a real call in the tab (an outbound call), but not owed a call back.
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9003' }), /not on the callback worklist/);
  // 9004 was called back late: it left the worklist.
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D2, callId: '9004' }), /not on the callback worklist/);
  assert.deepEqual(logRows().map((r) => r[5]), ['refused: not on the worklist', 'refused: not on the worklist']);
  // On the worklist, but its day is no longer held.
  assert.deepEqual(J(h.call('revealCallbackNumber', { callDate: OLD, callId: '8001' })), { ok: false, state: 'noTab' });
  // On the worklist, tab held, call id not in it.
  install('admin@x.com', { uncalled: () => uncalled({ episodes: [{ firstIso: D1, status: 'missed', attempts: [{ callDate: D1, callId: '7777' }], late: {} }] }) });
  assert.equal(h.call('revealCallbackNumber', { callDate: D1, callId: '7777' }).state, 'notFound');
  // The anonymous caller's legs carry no outside number.
  install('admin@x.com', { uncalled: () => uncalled({ episodes: [{ firstIso: D1, status: 'missed', attempts: [{ callDate: D1, callId: '9004' }], late: {} }] }) });
  assert.equal(h.call('revealCallbackNumber', { callDate: D1, callId: '9004' }).state, 'noNumber');
  install('admin@x.com', { unset: ['CDR_IMPORT_SS_ID'] });
  assert.equal(h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }).state, 'notConfigured');
  // Bad input never reaches the lookup.
  install('admin@x.com');
  assert.throws(() => h.call('revealCallbackNumber', { callDate: 'x', callId: '9001' }), /YYYY-MM-DD/);
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: "9001' OR 1=1" }), /not valid/);
  assert.equal(logRows().length, 0);
});

test('P11: an unlogged number is never returned, and the Neon list being down shows nothing', function () {
  install('admin@x.com');
  const sheet = h.state.spreadsheet.getSheetByName(SHEETS.CALLBACK_NUMBER_LOG);
  sheet.appendRow = function () { throw new Error('Service Spreadsheets timed out'); };
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }), /could not be logged, so the number is not shown/);
  install('admin@x.com', { uncalled: () => ({ meta: { available: false }, episodes: [], calls: [] }) });
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }), /could not be read/);
  assert.equal(logRows().length, 0);
  // A missing log sheet is created on first use (setup() not re-run yet), text-pinned.
  install('admin@x.com');
  h.state.spreadsheet.deleteSheet(h.state.spreadsheet.getSheetByName(SHEETS.CALLBACK_NUMBER_LOG));
  assert.equal(h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }).ok, true);
  const made = h.state.spreadsheet.getSheetByName(SHEETS.CALLBACK_NUMBER_LOG);
  assert.equal(made.getDataRange().getValues()[0].join('|'), h.consts.CALLBACK_NUMBER_LOG_HEADERS.join('|'));
  assert.equal(made.getDataRange().getValues().length, 2);
});

test('P11: who may ask -- admins; managers only once released AND switched on, and only for their own department', function () {
  // While the outbound vetting gate stands, a manager reaches neither endpoint.
  install('manager@x.com', { props: { CALLBACK_NUMBERS_MANAGERS: 'true' } });
  assert.throws(() => h.call('getCallbackWorklist', {}), /admin-only/);
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }), /admin-only/);
  // Released, switch off (the default): the list loads without the ability, and a number is refused.
  install('manager@x.com', { released: true });
  const list = J(h.call('getCallbackWorklist', {}));
  assert.deepEqual([list.meta.canReveal, list.meta.department, list.meta.managersMayReveal], [false, 'CSR', undefined]);
  assert.deepEqual(list.meta.departments, ['CSR']);
  assert.equal(uncalledCalls[0].department, 'CSR', 'pinned to their own department');
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }), /not turned on for managers/);
  assert.equal(logRows().length, 0);
  // Anything but exactly `true` is off.
  install('manager@x.com', { released: true, props: { CALLBACK_NUMBERS_MANAGERS: 'TRUE' } });
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }), /not turned on for managers/);
  // Released and on: their own department's caller, logged under their name.
  install('manager@x.com', { released: true, props: { CALLBACK_NUMBERS_MANAGERS: 'true' } });
  assert.equal(h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }).number, '(214) 555-0101');
  assert.deepEqual(logRows(), [['manager@x.com', 'manager', 'CSR', D1, '9001', 'shown']]);
  // Another department is refused before anything is read.
  assert.throws(() => h.call('revealCallbackNumber', { department: 'Power', callDate: D1, callId: '9001' }), /Not authorized/);
  // Someone with no access at all.
  install('nobody@x.com', { released: true, props: { CALLBACK_NUMBERS_MANAGERS: 'true' } });
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }));
  assert.throws(() => h.call('getCallbackWorklist', {}));
  // The switch itself is admin-only.
  install('manager@x.com', { released: true });
  assert.throws(() => h.call('setCallbackNumbersForManagers', true), /admin/i);
  install('admin@x.com');
  assert.equal(h.call('setCallbackNumbersForManagers', true).managersMayReveal, true);
  assert.equal(h.state.props.CALLBACK_NUMBERS_MANAGERS, 'true');
  assert.equal(h.call('setCallbackNumbersForManagers', false).managersMayReveal, false);
  assert.equal(h.state.props.CALLBACK_NUMBERS_MANAGERS, undefined);
  assert.equal(h.call('setCallbackNumbersForManagers', 'true').managersMayReveal, false, 'only the boolean true turns it on');
});

test('P11: forty numbers an hour per person, failed tries included; a count that cannot be kept shows nothing', function () {
  install('admin@x.com');
  for (let i = 0; i < 39; i++) h.call('revealCallbackNumber', { callDate: D1, callId: '9001' });
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9003' }), /not on the callback worklist/);   // the 40th, refused, still counted
  assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }), /in the last hour, which is the limit/);
  assert.equal(logRows().length, 40, 'the capped request reached neither the lookup nor the log');
  // Another person has their own count.
  h.state.userEmail = 'admin2@x.com'; h.state.props.ADMIN_EMAILS = 'admin@x.com,admin2@x.com';
  assert.equal(h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }).ok, true);
  // The counter failing closes the door (the email throttle fails open; this must not).
  install('admin@x.com');
  const realGet = h.ctx.CacheService.getScriptCache;
  h.ctx.CacheService.getScriptCache = function () { const c = realGet(); c.put = function () { throw new Error('cache down'); }; return c; };
  try {
    assert.throws(() => h.call('revealCallbackNumber', { callDate: D1, callId: '9001' }), /could not be recorded just now, so no number is shown/);
  } finally { h.ctx.CacheService.getScriptCache = realGet; }
  assert.equal(logRows().length, 0);
});

test('P11: the candidates are the incoming legs\' outside numbers -- never a recording leg, an extension or the dialled line', function () {
  const rows = rawRows(D1);
  const of = (id) => J(h.call('cbwCandidateNumbers_', rows.filter((r) => r[0] === id || r[14] === id)));
  assert.deepEqual(of('9001'), ['+12145550101'], 'one number, however many legs carry it');
  assert.deepEqual(of('9002'), ['+14695550202'], 'a formatted cell is read by its digits');
  assert.deepEqual(of('9003'), [], 'an outbound call: its recording leg is marked Incoming but is no caller (NX-2)');
  assert.deepEqual(of('9004'), [], 'anonymous');
  assert.equal(h.call('cbwFormatNumber_', '+12145550101'), '(214) 555-0101');
  assert.equal(h.call('cbwFormatNumber_', '+442071234567'), '+442071234567');
});

test('P11: PARITY -- the number the import hashed for a call is always among the dashboard\'s candidates, and the column map matches', function () {
  const rows = rawRows(D1);
  const recs = J(imp.call('buildInboundCallRecords_', rows));
  const withNumber = recs.filter((r) => r.callerNumber);
  assert.ok(withNumber.length >= 2, 'the fixture holds calls with a number');
  const sheet = makeFakeSpreadsheet({ sheets: { T: [HEADER].concat(rows) } }).getSheetByName('T');
  withNumber.forEach(function (r) {
    const legs = h.call('cbwLegsOfCall_', sheet, r.callId);
    assert.ok(legs.length >= 1, 'the call is found by id: ' + r.callId);
    assert.ok(J(h.call('cbwCandidateNumbers_', legs)).indexOf(r.callerNumber) !== -1, 'the hashed number is a candidate: ' + r.callId);
  });
  // The satellite leg under a parent id is part of its call.
  assert.equal(h.call('cbwLegsOfCall_', sheet, '9002').length, 2);
  assert.equal(h.call('cbwLegsOfCall_', sheet, 'nope').length, 0);
  const IC = imp.ctx.IC_COL, CB = h.ctx.CBW_COL_;
  Object.keys(CB).forEach((k) => assert.equal(CB[k], IC[k], 'column ' + k + ' is where the import reads it'));
  // And the hash rule is the import's: the same number, the same digest.
  assert.equal(hashOf('+12145550101'), imp.call('cdrHashPhone_', '+12145550101', SECRET));
});

test('P11: the feasibility check logs counts only, writes nothing, and reads its verdict from confirmed numbers', function () {
  install('manager@x.com', { released: true });
  assert.throws(() => h.call('probeCallbackNumberLookup'), /admin/i);
  // Twelve callers on a held day, all provable.
  const many = () => uncalled({ episodes: Array.from({ length: 12 }, (_, i) => ({ firstIso: D1, status: 'missed', attempts: [{ callDate: D1, callId: i % 2 ? '9001' : '9002' }], late: {} }))
    .concat([{ firstIso: OLD, status: 'missed', attempts: [{ callDate: OLD, callId: '8001' }], late: {} }]) });
  install('admin@x.com', { uncalled: many });
  const logs = [];
  const realLog = h.ctx.Logger.log;
  h.ctx.Logger.log = function (m) { logs.push(String(m)); };
  let out;
  try { out = J(h.call('probeCallbackNumberLookup')); } finally { h.ctx.Logger.log = realLog; }
  assert.equal(out.verdict, 'GOOD');
  assert.deepEqual([out.rows, out.held, out.counts.found, out.counts.noTab, out.ratePct], [13, 12, 12, 1, 100]);
  assert.ok(!/555-?0[12]0[12]|5550101|5550202/.test(logs.join('\n') + JSON.stringify(out)), 'no number in the log or the return');
  assert.equal(logRows().length, 0, 'the check shows nothing to anyone, so it writes no audit row');
  assert.equal(uncalledCalls[0].department, 'ALL');
  // Nothing provable (a wrong secret): POOR, with the hint.
  install('admin@x.com', { uncalled: many, props: { HMAC_SECRET: 'other' } });
  assert.equal(h.call('probeCallbackNumberLookup').verdict, 'POOR');
  install('admin@x.com');
  assert.equal(h.call('probeCallbackNumberLookup').verdict, 'INCONCLUSIVE', 'under ten held calls');
  install('admin@x.com', { unset: ['CDR_IMPORT_SS_ID'] });
  assert.equal(h.call('probeCallbackNumberLookup').verdict, 'NOT CONFIGURED');
});

test('P11: setup() creates the audit sheet; the client keeps a number out of storage, exports and print', function () {
  install('admin@x.com');
  h.state.spreadsheet.deleteSheet(h.state.spreadsheet.getSheetByName(SHEETS.CALLBACK_NUMBER_LOG));
  h.call('setup');
  const sh = h.state.spreadsheet.getSheetByName(SHEETS.CALLBACK_NUMBER_LOG);
  assert.equal(sh.getDataRange().getValues()[0].join('|'), 'Timestamp|User|Role|Department|Call Date|Call ID|Result');
  const admin = fs.readFileSync(path.join(DASHBOARD_DIR, 'script-7-admin.html'), 'utf8');
  const at = admin.indexOf('// ── Callback worklist (P11');
  const block = admin.slice(at, admin.indexOf('// ── Exception days editor', at));
  assert.ok(at > 0 && block.length > 500);
  assert.ok(!/localStorage|sessionStorage|csvSafeCell_|Blob\(|clipboard\.writeText|reportClientIssue_|title=/.test(block),
    'the worklist block stores, exports, copies and beacons nothing, and puts no number in a title');
  assert.match(block, /function closeModal\(\) \{[^}]*cbwClear_\(\);/, 'closing the window empties the table');
  assert.match(block, /function cbwLoad_\(\) \{\s*cbwClear_\(\);/, 'a reload empties it first');
  assert.equal((block.match(/\.revealCallbackNumber\(/g) || []).length, 1, 'one lookup call site: one call per click');
  const css = fs.readFileSync(path.join(DASHBOARD_DIR, 'styles.html'), 'utf8');
  assert.match(css, /@media print \{ \.cbw-num \{ display: none !important; \}/, 'a shown number never reaches paper');
  // The server file never logs or caches a number: every Logger line is a fixed
  // message or an error text, and the only cache key is the per-user counter.
  const srv = fs.readFileSync(path.join(DASHBOARD_DIR, 'CallbackWorklist.gs'), 'utf8');
  assert.ok(!/Logger\.log\([^)]*(number|cands|res\.number)/.test(srv), 'no number reaches a log line');
  assert.deepEqual((srv.match(/cache\.put\(/g) || []).length, 1);
  assert.ok(!/setProperty\([^)]*number/i.test(srv.replace(/CALLBACK_NUMBERS_MANAGERS/g, '')), 'no number reaches a property');
});
