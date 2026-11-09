'use strict';

// RingCentral cutover, step 1 (docs/ringcentral-migration-plan.md): the
// Call Records export -> 8x8 Raw Data converter in
// apps-script/cdr-import/ringCentralAdapter.js. The converter is NOT wired
// into the import yet; these pins hold what IS settled (header-driven column
// lookup, the Central -> Pacific shift, the 8x8 cell formats, the layout the
// readers expect) so the tree synthesis can be added on top without moving
// any of it. The one real row is the owner's 2026-11-04 sample, with the
// phone numbers swapped for 555 equivalents.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({
  project: 'cdr-import',
  files: ['ringCentralAdapter.js', 'inboundCalls.js', 'buildDQEHistoricalData.js'],
  capture: ['DQE_C']
});
const plain = (v) => JSON.parse(JSON.stringify(v));
const convert = (grid) => plain(h.call('rcConvertCallRecords_', grid));
const COL = plain(h.ctx.RC_OUT_COL);

const HEADER = ['From Name', 'From Number', 'To Name', 'To Number', 'Date-Time', 'Length', 'Direction',
  'Call Type', 'Call Response', 'Result', 'Ringing', 'IVR Prompt', 'Live Talk', 'Hold', 'Park', 'Transfer',
  'VM Greeting', 'VoiceMail', 'Setup', 'Forwarding', 'Origin', 'Call Id', 'Hop Id'];

// Build one export row from named fields (blank = what the export leaves empty).
function rcRow(o) {
  const v = Object.assign({
    'From Name': '', 'From Number': '', 'To Name': '', 'To Number': '', 'Date-Time': '', 'Length': '00:00:00',
    'Direction': 'Inbound', 'Call Type': '', 'Call Response': '', 'Result': '', 'Ringing': '', 'IVR Prompt': '',
    'Live Talk': '', 'Hold': '', 'Park': '', 'Transfer': '', 'VM Greeting': '', 'VoiceMail': '', 'Setup': '',
    'Forwarding': '', 'Origin': 'External', 'Call Id': '', 'Hop Id': '0'
  }, o);
  return HEADER.map((k) => v[k]);
}

const SAMPLE = rcRow({
  'From Name': 'OTR SOLUTIONS', 'From Number': '+1 (770) 5550101', 'To Name': 'Robin Choudhury',
  'To Number': '+1 (737) 5550199', 'Date-Time': '11/04/2026 2:44:18 PM', 'Length': '00:01:00',
  'Direction': 'Inbound', 'Call Type': 'Inbound Direct', 'Call Response': 'Answered', 'Result': 'Completed',
  'Ringing': '00:00:12', 'Live Talk': '00:00:48', 'Setup': '00:00:00', 'Origin': 'External',
  'Call Id': 's-a7860201b44e4z1a1a84e2e54zd186a930000', 'Hop Id': '0'
});

test('layout: RC_OUT_COL agrees with every IC_COL and DQE_C index it shares', function () {
  const ic = plain(h.ctx.IC_COL);
  Object.keys(ic).forEach(function (k) {
    const mine = k === 'START' ? COL.START : COL[k];
    assert.equal(mine, ic[k], 'IC_COL.' + k);
  });
  const dqe = plain(h.consts.DQE_C);
  const alias = { START_TIME: 'START', TALK_TIME: 'TALK', PARENT_CALL: 'PARENT_CALL_ID' };
  Object.keys(dqe).forEach(function (k) {
    assert.equal(COL[alias[k] || k], dqe[k], 'DQE_C.' + k);
  });
});

test('layout: rows are MAX_COLS wide (processNewImport slices to it)', function () {
  const src = fs.readFileSync(path.join(__dirname, '../../apps-script/cdr-import/autoImport.js'), 'utf8');
  const maxCols = Number(src.match(/const MAX_COLS = (\d+);/)[1]);
  assert.equal(h.ctx.RC_OUT_WIDTH, maxCols);
  const out = convert([HEADER, SAMPLE]);
  assert.equal(out.rows[0].length, maxCols);
  assert.equal(out.header.length, maxCols);
  // The calculateMetricsInMemory PATH column is the last one.
  assert.ok(COL.PATH < maxCols);
});

test('the owner sample converts to 8x8 cell formats, Central -> Pacific', function () {
  const out = convert([HEADER, SAMPLE]);
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.problems, []);
  const r = out.rows[0];
  assert.equal(r[COL.CALL_ID], 's-a7860201b44e4z1a1a84e2e54zd186a930000');
  assert.equal(r[COL.LEG_ID], '1');                          // A1: Hop 0 -> leg 1
  assert.equal(r[COL.START], '11/04/2026 12:44:18');         // 2:44:18 PM CST -> 12:44:18 PST
  assert.equal(r[COL.CONNECTED], '11/04/2026 12:44:30');     // A4: after 12s ringing
  assert.equal(r[COL.STOP], '11/04/2026 12:45:18');          // + Length 1:00
  assert.equal(r[COL.DIRECTION], 'Incoming');
  assert.equal(r[COL.TALK], '0:00:48');
  assert.equal(r[COL.CALL_TIME], '0:01:00');
  assert.equal(r[COL.CALLER], '17705550101');
  assert.equal(r[COL.CALLER_NAME], 'OTR SOLUTIONS');
  assert.equal(r[COL.CALLEE], '17375550199');
  assert.equal(r[COL.CALLEE_NAME], 'Robin Choudhury');
  assert.equal(r[COL.PARENT_CALL_ID], 'N/A');
  assert.equal(r[COL.DIAL_IN], '17375550199');               // A10
  assert.equal(r[COL.ANSWERED], 'Answered');
  assert.equal(r[COL.MISSED], '-');
  assert.equal(r[COL.ABANDONED], '-');
  assert.equal(r[COL.CALLEE_HOLD_DURATION], '0:00:00');
  assert.equal(out.info[0].callType, 'Inbound Direct');
  assert.equal(out.info[0].seconds.RINGING, 12);
});

test('converted timestamps parse with the pipeline\'s own readers', function () {
  const r = convert([HEADER, SAMPLE]).rows[0];
  const loaded = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
  // simulateSplitCol2 -> day fraction of the PACIFIC wall time (QCD's window test).
  assert.equal(Math.round(loaded.call('simulateSplitCol2', r[COL.START]) * 86400), 12 * 3600 + 44 * 60 + 18);
  assert.equal(Math.round(loaded.call('parseDurationDecimal', r[COL.TALK]) * 86400), 48);
});

test('columns are found by header NAME: reordered and re-spelled headers still map', function () {
  const order = HEADER.map((_, i) => i).reverse();
  const shuffled = (row) => order.map((i) => row[i]);
  const header = shuffled(HEADER).map((x) => x.toUpperCase().replace('-', ' '));   // "DATE TIME", "CALL ID"
  const a = convert([HEADER, SAMPLE]).rows[0];
  const b = convert([header, shuffled(SAMPLE)]).rows[0];
  assert.deepEqual(b, a);
});

test('header row is found below title rows; the summary ("Sum") row is skipped, not converted', function () {
  const sumRow = HEADER.map((x, i) => (i < 4 ? '' : 'Sum'));
  const out = convert([['Call Records'], ['Filters: All users'], HEADER, sumRow, SAMPLE, []]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].row, 4);
});

test('refuses the per-user summary export and a layout missing a required column', function () {
  const usersHeader = ['Name', 'Ext', 'Total Calls', 'Direction- Inbound', 'Call Segment- Live Talk'];
  assert.throws(() => h.call('rcConvertCallRecords_', [usersHeader, ['Robin', '103', '1', '1', '00:00:45']]),
    /no header row with "Call Id", "Hop Id" and "Date-Time"/);
  const noTalk = HEADER.filter((x) => x !== 'Live Talk');
  assert.throws(() => h.call('rcConvertCallRecords_', [noTalk]), /missing required column\(s\): Live Talk/);
  // A missing OPTIONAL column is reported, not fatal.
  const noPark = HEADER.filter((x) => x !== 'Park');
  const out = convert([noPark, SAMPLE.filter((_, i) => HEADER[i] !== 'Park')]);
  assert.deepEqual(out.missingOptional, ['Park']);
  assert.equal(out.rows.length, 1);
});

test('bad cells become problems (and that row is skipped), never guesses', function () {
  const out = convert([HEADER,
    rcRow({ 'Call Id': 'a', 'Date-Time': 'yesterday' }),
    rcRow({ 'Call Id': 'b', 'Date-Time': '11/04/2026 9:00:00 AM', 'Live Talk': '48 sec' }),
    rcRow({ 'Call Id': 'c', 'Date-Time': '11/04/2026 9:00:00 AM', 'Hop Id': 'first' }),
    rcRow({ 'Call Id': 'd', 'Date-Time': '02/30/2026 9:00:00 AM' }),
    rcRow({ 'Call Id': 'e', 'Date-Time': '11/04/2026 9:00:00 AM', 'Direction': 'Sideways' }),
  ]);
  assert.equal(out.rows.length, 0);
  assert.deepEqual(out.problems.map((p) => p.field), ['Date-Time', 'Live Talk', 'Hop Id', 'Date-Time', 'Direction']);
  // A Date object (getValues instead of getDisplayValues) is refused too.
  const dateCell = HEADER.map((k, i) => (k === 'Date-Time' ? new Date() : SAMPLE[i]));
  assert.equal(convert([HEADER, dateCell]).problems[0].field, 'Date-Time');
});

test('Central -> Pacific crosses midnight and handles 12 AM / 12 PM', function () {
  const at = (s) => convert([HEADER, rcRow({ 'Call Id': 'x', 'Date-Time': s })]).rows[0][COL.START];
  assert.equal(at('11/04/2026 1:15:00 AM'), '11/03/2026 23:15:00');
  assert.equal(at('03/01/2026 12:05:00 AM'), '02/28/2026 22:05:00');
  assert.equal(at('11/04/2026 12:00:00 PM'), '11/04/2026 10:00:00');
  assert.equal(at('2026-07-15 16:30:05'), '07/15/2026 14:30:05');
});

test('dispositions: missed / abandoned / answered elsewhere / outbound / transfer (A5-A8)', function () {
  const base = { 'Date-Time': '11/04/2026 9:00:00 AM' };
  const out = convert([HEADER,
    rcRow(Object.assign({ 'Call Id': 'm', 'Call Response': 'Not Answered', 'Result': 'Missed with VM' }, base)),
    rcRow(Object.assign({ 'Call Id': 'ab', 'Call Response': 'Not Answered', 'Result': 'Abandoned' }, base)),
    rcRow(Object.assign({ 'Call Id': 'ae', 'Call Response': 'Not Answered', 'Result': 'Answered elsewhere' }, base)),
    rcRow(Object.assign({ 'Call Id': 'ob', 'Direction': 'Outbound', 'Call Response': 'Not Connected', 'Result': 'Other' }, base)),
    rcRow(Object.assign({ 'Call Id': 'oc', 'Direction': 'Outbound', 'Call Response': 'Connected', 'Result': 'Completed', 'Live Talk': '00:02:00' }, base)),
    rcRow(Object.assign({ 'Call Id': 'tr', 'Call Response': 'Answered', 'Result': 'Transferred', 'Live Talk': '00:00:30' }, base)),
    rcRow(Object.assign({ 'Call Id': 'in', 'Origin': 'Internal', 'Call Response': 'Answered', 'Result': 'Completed', 'Live Talk': '00:00:05' }, base)),
  ]);
  const by = {};
  out.rows.forEach((r) => { by[r[COL.CALL_ID]] = r; });
  const flags = (id) => [by[id][COL.MISSED], by[id][COL.ABANDONED], by[id][COL.ANSWERED]].join('|');
  assert.equal(flags('m'), 'Missed|-|-');
  assert.equal(flags('ab'), 'Missed|Abandoned|-');
  assert.equal(flags('ae'), 'Missed|-|-');
  assert.equal(flags('ob'), '-|-|-');
  assert.equal(flags('oc'), '-|-|Answered');
  assert.equal(by.ob[COL.DIRECTION], 'Outgoing');
  assert.equal(by.ob[COL.CONNECTED], '');                    // never connected
  assert.equal(by.tr[COL.CAUSE], 'Transfer');
  assert.equal(by.in[COL.DIRECTION], 'Internal');
  assert.equal(by.ob[COL.DIAL_IN], 'N/A');                   // dial-in is inbound-only
});

test('dial-in comes from the call\'s FIRST incoming hop and is shared by its hops (A10)', function () {
  const t = '11/04/2026 9:00:00 AM';
  const out = convert([HEADER,
    rcRow({ 'Call Id': 'c1', 'Hop Id': '1', 'Date-Time': t, 'To Number': '+1 (214) 5550002', 'To Name': 'Agent' }),
    rcRow({ 'Call Id': 'c1', 'Hop Id': '0', 'Date-Time': t, 'To Number': '+1 (972) 5550001', 'To Name': 'Main Line' }),
  ]);
  assert.deepEqual(out.rows.map((r) => r[COL.DIAL_IN]), ['19725550001', '19725550001']);
  assert.deepEqual(out.rows.map((r) => r[COL.LEG_ID]), ['2', '1']);
});
