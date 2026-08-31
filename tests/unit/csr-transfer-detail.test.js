'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
// Cross-realm: arrays built in the vm realm need the prototype-agnostic
// comparator (tests/README.md "Two gotchas the harness imposes").
const { deepEqual } = require('node:assert');
const { loadGas } = require('../harness/loadGas');

// R25: CSR transfer DETAIL (Data.gs::computeCsrTransferRange_).
//
// `CSR Transfer Historical Data` has always been per-AGENT per-DAY with 11
// per-QUEUE transfer-DESTINATION columns (INV-52), but the dashboard read
// only A..G and collapsed it to one dept percentage -- so "30% of calls get
// transferred, to WHERE and by WHOM?" was unanswerable from data already on
// the sheet. Pinned here:
//   (1) the HEADLINE fields are byte-identical to the old 7-column read --
//       the existing team-strip tile and its delta chip must not move;
//   (2) per-agent rows SUM to the headline (the reconciliation rule this
//       repo lives by), and are deliberately NOT roster-filtered;
//   (3) destination queues come from the sheet's own HEADER row (a renamed
//       queue follows automatically) and zero-transfer columns drop out;
//   (4) transfers not covered by the 11 fixed columns are DISCLOSED
//       (queueUnaccounted), never silently absorbed;
//   (5) the dept gate and the no-data contract are unchanged.

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Data.gs'] });

const HEADER = ['Month Year', 'Week', 'Date', 'Agent', 'Trans %', 'Total Calls',
                'Transferred', 'Sales', 'Service', 'Billing', 'Q4', 'Q5', 'Q6',
                'Q7', 'Q8', 'Q9', 'Q10', 'Q11'];

/** One sheet row: agent/day totals + a {queueLabel: n} destination map. */
function row(date, agent, totalCalls, transferred, dests) {
  const r = new Array(18).fill('');
  r[0] = 'Aug 2026'; r[1] = '33'; r[2] = date; r[3] = agent;
  r[4] = totalCalls ? ((transferred / totalCalls) * 100).toFixed(1) : '0';
  r[5] = String(totalCalls); r[6] = String(transferred);
  Object.keys(dests || {}).forEach(function (label) {
    const idx = HEADER.indexOf(label);
    if (idx >= 7) r[idx] = String(dests[label]);
  });
  return r;
}

const ROWS = [
  // Anna: 100 calls, 30 transferred (20 Sales, 10 Service)
  row('2026-08-10', 'Anna', 60, 20, { Sales: 15, Service: 5 }),
  row('2026-08-11', 'Anna', 40, 10, { Sales: 5, Service: 5 }),
  // Bob: 50 calls, 5 transferred (all Billing)
  row('2026-08-10', 'Bob', 50, 5, { Billing: 5 }),
  // Out of range -- must not count.
  row('2026-07-01', 'Anna', 999, 999, { Sales: 999 }),
];

function install(rows) {
  h.state.props = { SPREADSHEET_ID: 'fake' };
  const data = rows === undefined ? ROWS : rows;
  h.ctx.openSpreadsheet_ = function () {
    return {
      getSpreadsheetTimeZone: function () { return 'America/Chicago'; },
      getSheetByName: function (n) {
        if (n !== 'CSR Transfer Historical Data') return null;
        return {
          getLastRow: function () { return data.length + 1; },
          getLastColumn: function () { return 18; },
          getRange: function (r, c, nr, nc) {
            const src = r === 1 ? [HEADER] : data.slice(r - 2, r - 2 + nr);
            return { getDisplayValues: function () {
              return src.map(function (x) { return x.slice(c - 1, c - 1 + nc); });
            } };
          },
        };
      },
    };
  };
}

function run() { return h.call('computeCsrTransferRange_', 'CSR', '2026-08-01', '2026-08-31'); }

test('the HEADLINE figures are unchanged by the widened read', function () {
  install();
  const r = run();
  // 150 calls, 35 transferred -> 23.3%
  assert.equal(r.totalCalls, 150);
  assert.equal(r.transferred, 35);
  assert.equal(r.pct, 23.3);
  assert.equal(r.pctStr, '23.3%');
  assert.equal(r.days, 2, 'distinct dates in range');
});

test('per-agent rows SUM to the headline and sort busiest-transferrer first', function () {
  install();
  const r = run();
  assert.equal(r.agents.length, 2);
  assert.equal(r.agents[0].agent, 'Anna');
  assert.equal(r.agents[0].totalCalls, 100);
  assert.equal(r.agents[0].transferred, 30);
  assert.equal(r.agents[0].pct, 30);
  assert.equal(r.agents[1].agent, 'Bob');
  assert.equal(r.agents[1].pct, 10);
  // The reconciliation rule: the parts add up to the tile.
  const sumCalls = r.agents.reduce(function (a, x) { return a + x.totalCalls; }, 0);
  const sumTrans = r.agents.reduce(function (a, x) { return a + x.transferred; }, 0);
  assert.equal(sumCalls, r.totalCalls);
  assert.equal(sumTrans, r.transferred);
});

test('destination queues read their labels from the sheet header; empties drop out', function () {
  install();
  const r = run();
  deepEqual(r.queues.map(function (q) { return q.queue; }), ['Sales', 'Service', 'Billing']);
  assert.equal(r.queues[0].transferred, 20);
  assert.equal(r.queues[0].share, 57.1, 'share is of TRANSFERS, not of calls');
  assert.equal(r.queues[2].queue, 'Billing');
  assert.equal(r.queues[2].transferred, 5);
  assert.ok(r.queues.every(function (q) { return q.transferred > 0; }),
    'the 8 unused fixed columns must not render as zero rows');
});

test('a renamed queue column follows the sheet automatically', function () {
  install();
  const original = run().queues[0].queue;
  assert.equal(original, 'Sales');
  HEADER[7] = 'Inside Sales';
  try {
    install();
    assert.equal(run().queues[0].queue, 'Inside Sales', 'labels are read, never hardcoded');
  } finally {
    HEADER[7] = 'Sales';
  }
});

test('transfers outside the 11 fixed columns are DISCLOSED, never absorbed', function () {
  // 20 transferred but only 12 attributed to destination columns.
  install([row('2026-08-10', 'Cara', 100, 20, { Sales: 12 })]);
  const r = run();
  assert.equal(r.transferred, 20);
  assert.equal(r.queueSum, 12);
  assert.equal(r.queueUnaccounted, 8, 'the gap is reported so the client can caption it');
});

test('the daily series is chronological and per-day', function () {
  install();
  const r = run();
  deepEqual(r.daily.map(function (d) { return d.date; }), ['2026-08-10', '2026-08-11']);
  assert.equal(r.daily[0].totalCalls, 110);   // Anna 60 + Bob 50
  assert.equal(r.daily[0].transferred, 25);
  assert.equal(r.daily[1].pct, 25);           // Anna 10/40
});

test('the dept gate and the no-data contract are unchanged', function () {
  install();
  assert.equal(h.call('computeCsrTransferRange_', 'Sales', '2026-08-01', '2026-08-31'), null,
    'non-CSR depts get nothing (the sheet is CSR-only)');
  install([]);
  assert.equal(run(), null, 'no rows in range -> null, not a zero-filled shape');
});
