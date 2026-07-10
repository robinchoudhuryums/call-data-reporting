'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// computeDigestWowDriver_ reuses CompanyOverview's computeWowDelta_ /
// computeWowDriver_ (INV-48) over a stats shape it builds from DQE.
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'Data.gs', 'Digest.gs'],
});

const ROSTER = rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202'] });

function install(rows) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(rows) },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.state.cache.clear();
}

// Anchor 2026-03-14: current week = 03-08..03-14, prior week = 03-01..03-07.
// Put each week's activity on one in-window date.
function row(date, agent, o) {
  return dqeRow(Object.assign({ date: date, agent: agent, ext: '501' }, o));
}

test('computeDigestWowDriver_ surfaces the agent driving an answer-rate GAIN', function () {
  install([
    // prior week (50% dept answer rate)
    row('2026-03-04', 'Anna', { rung: 10, missed: 5, answered: 5 }),
    row('2026-03-04', 'Ben',  { rung: 10, missed: 5, answered: 5 }),
    // current week: Anna jumps to 9/10, Ben flat -> dept 70%
    row('2026-03-11', 'Anna', { rung: 10, missed: 1, answered: 9 }),
    row('2026-03-11', 'Ben',  { rung: 10, missed: 5, answered: 5 }),
  ]);
  const wow = h.call('computeDigestWowDriver_', 'Alpha', '2026-03-14');
  assert.ok(wow, 'expected a wow result');
  assert.equal(wow.deltaPct, 20);          // 70% - 50%
  assert.ok(wow.driver, 'expected a driver');
  assert.equal(wow.driver.agent, 'Anna');
  assert.equal(wow.driver.metric, 'answered');
  assert.equal(wow.driver.delta, 4);       // 9 - 5
  assert.equal(wow.driver.cur, 9);
  assert.equal(wow.driver.prev, 5);
  assert.equal(wow.driver.positive, true);
});

test('computeDigestWowDriver_ surfaces a missed-call driver on an answer-rate DROP', function () {
  // Anna's missed-delta (+5) must STRICTLY exceed her answered-delta
  // magnitude (|-4|) for computeWowDriver_ to pick the missed
  // narrative (the tie falls back to 'answered').
  install([
    // prior week: dept 70% (Anna 9/10 with 0 missed)
    row('2026-03-04', 'Anna', { rung: 10, missed: 0, answered: 9 }),
    row('2026-03-04', 'Ben',  { rung: 10, missed: 5, answered: 5 }),
    // current week: Anna 5/10 with 5 missed -> dept 50%
    row('2026-03-11', 'Anna', { rung: 10, missed: 5, answered: 5 }),
    row('2026-03-11', 'Ben',  { rung: 10, missed: 5, answered: 5 }),
  ]);
  const wow = h.call('computeDigestWowDriver_', 'Alpha', '2026-03-14');
  assert.equal(wow.deltaPct, -20);
  assert.ok(wow.driver);
  assert.equal(wow.driver.agent, 'Anna');
  assert.equal(wow.driver.metric, 'missed');   // missed-delta dominates on a drop
  assert.equal(wow.driver.delta, 5);           // 5 - 0
  assert.equal(wow.driver.cur, 5);
  assert.equal(wow.driver.prev, 0);
  assert.equal(wow.driver.positive, false);
});

test('computeDigestWowDriver_: below-threshold shift attaches no driver', function () {
  install([
    row('2026-03-04', 'Anna', { rung: 100, missed: 50, answered: 50 }),
    row('2026-03-11', 'Anna', { rung: 100, missed: 49, answered: 51 }),  // +1 pt < 1.5
  ]);
  const wow = h.call('computeDigestWowDriver_', 'Alpha', '2026-03-14');
  assert.ok(wow, 'delta still computed');
  assert.equal(wow.driver, undefined);    // no driver below WOW_DRIVER_THRESHOLD
});

test('computeDigestWowDriver_: a quiet/empty prior week returns null', function () {
  install([
    row('2026-03-11', 'Anna', { rung: 10, missed: 1, answered: 9 }),  // only current week
  ]);
  // prev.rung === 0 -> computeWowDelta_ returns null
  assert.equal(h.call('computeDigestWowDriver_', 'Alpha', '2026-03-14'), null);
});

test('digestWowNarrative_ renders sage gain copy and is empty when no driver', function () {
  // Direct render (no spreadsheet) of a positive driver.
  const html = h.call('digestWowNarrative_', {
    deltaPct: 20, driver: { agent: 'Anna', metric: 'answered', delta: 4, cur: 9, prev: 5, positive: true },
  });
  assert.match(html, /Anna/);
  assert.match(html, /answered 4 more calls/);
  assert.match(html, /9 vs 5/);
  assert.match(html, /answer-rate gain/);
  assert.match(html, /\+20\.0 pts week-over-week/);
  assert.match(html, /#ECFDF5/);   // sage background

  // No driver / null -> empty string (digest renders without the callout).
  assert.equal(h.call('digestWowNarrative_', { deltaPct: 0.4 }), '');
  assert.equal(h.call('digestWowNarrative_', null), '');
});

test('digestWowNarrative_ escapes the agent name (no HTML injection)', function () {
  const html = h.call('digestWowNarrative_', {
    deltaPct: -5, driver: { agent: '<b>x</b>', metric: 'missed', delta: 3, cur: 8, prev: 5, positive: false },
  });
  assert.ok(html.indexOf('<b>x</b>') === -1, 'raw tag must not appear');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /answer-rate drop/);
  assert.match(html, /#FFFBEB/);   // amber background
});

test('RPT-7: a GAIN driven by a missed-call DROP narrates via missed, not "answered +0/+1"', function () {
  install([
    // prior week: Anna 5/13 with 8 missed
    row('2026-03-04', 'Anna', { rung: 13, missed: 8, answered: 5 }),
    // current week: Anna 6/6, 0 missed -> big rate gain, answered only +1
    row('2026-03-11', 'Anna', { rung: 6, missed: 0, answered: 6 }),
  ]);
  const wow = h.call('computeDigestWowDriver_', 'Alpha', '2026-03-14');
  assert.ok(wow && wow.driver, 'expected a driver');
  assert.equal(wow.driver.positive, true);
  // |missedDelta| = 8 dominates |answeredDelta| = 1 AND is a drop ->
  // the narrative surfaces the missed improvement ("8 fewer"), not the
  // near-zero answered delta.
  assert.equal(wow.driver.metric, 'missed');
  assert.equal(wow.driver.delta, -8);
  assert.equal(wow.driver.cur, 0);
  assert.equal(wow.driver.prev, 8);
});
