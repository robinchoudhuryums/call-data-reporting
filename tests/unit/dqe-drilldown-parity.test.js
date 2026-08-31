'use strict';

// BEHAVIORAL parity between the DQE build and the DQE Drill-Down sidebar --
// the FOURTH hand-mirrored copy of the pipeline's rules in this repo, and
// until now the only one with no guard at all.
//
// cdr-report/DQEdrilldown.js answers "which Raw Data rows produced this DQE
// cell?" It does NOT call the build: it re-implements the parent-leg tree,
// INV-08 own-talk attribution (its own findAgentTalkOnParent), INV-24 agent
// canonicalization (its own canonicalize_), the INV-06 work window, and a
// TTT/ATT summary. Structurally different code from
// buildDQEHistoricalData.js, so check-duplicated-files.sh cannot diff it and
// cross-file-pins cannot tokenize it.
//
// It has already drifted three times, each time in the same direction -- the
// verification tool contradicting the build during exactly the investigation
// it exists to serve:
//   F24    the drill matched Raw Data's UN-canonicalized callee name, so
//          aliased/paren agents drilled to "no matching rows"
//   R8-D4  its canonicalize_ had only INV-24's STRIP key, not the strip+
//          flatten UNION, so FLATTEN-matched names still read as mismatches
//   F-13   it windowed only rung/missed/answered, so drilling Unique/TTT/ATT
//          included all-day legs and flagged false mismatches
//
// The guard: ONE shared synthetic Raw Data fixture drives BOTH the real build
// and the real drill. For every drillable column the drill's matched-row
// count (its "Found N", the number an operator compares to the dashboard)
// must reconcile with the DQE cell the build wrote. No expected values are
// hardcoded -- a rule edit in either file that is not mirrored in the other
// fails here regardless of which rule it was.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

// Both files load into ONE context, as in the real cdr-report project: the
// drill calls the build's loadRosterCanonicalNames_ for its roster map.
const h = loadGas({
  project: 'cdr-report',
  files: ['buildDQEHistoricalData.js', 'DQEdrilldown.js'],
});
h.ctx.writeDQERowsToNeon = function () { return { skipped: 0 }; };
h.ctx.notifyNeonWriteFailure = function () {};

// Raw Data columns both implementations read (0-indexed display grid).
function rawRow(o) {
  const r = new Array(26).fill('');
  r[0]  = o.callId || '';
  r[1]  = o.legId != null ? String(o.legId) : '';
  r[2]  = o.start || '';
  r[6]  = o.talk || '';
  r[7]  = o.callTime || '';
  r[8]  = o.caller || '';
  r[11] = o.calleeName || '';
  r[14] = o.parentCall || '';
  r[22] = o.callerId || '';
  r[23] = o.missed ? 'Missed' : '';
  r[24] = o.abandoned ? 'Abandoned' : '';
  r[25] = o.answered ? 'Answered' : '';
  return r;
}

const DATE = '03/09/2026';
const IN   = DATE + ' 7:00:00';    // 25200s PST -- inside [6:30, 15:00)
const OUT  = DATE + ' 5:00:00';    // before the window (INV-06 / F-13)

// The shared fixture. Shaped so the metrics are NOT interchangeable:
//   - P5 rings Anna TWICE, so rung (5) != unique (4)
//   - one ring on P5 is missed and one answered, so answered != rung
//   - Bob's 999s leg on P1 is the INV-08 decoy: attributing max-across-legs
//     instead of Anna's own leg changes TTT, so a regression there is visible
//   - Q4 sits outside the work window, so a drill that forgets to window
//     (the F-13 regression) over-counts every windowed metric
function fixtureRows(annaFeedName) {
  const anna = annaFeedName || 'Anna Smith';
  return [
    // Parent legs (PARENT_CALL='N/A') carry talk time.
    rawRow({ callId: 'P1', legId: 0, start: IN, talk: '0:03:00', calleeName: anna,  parentCall: 'N/A' }), // 180
    rawRow({ callId: 'P1', legId: 1, start: IN, talk: '0:16:39', calleeName: 'Bob', parentCall: 'N/A' }), // 999 decoy
    rawRow({ callId: 'P2', legId: 0, start: IN, talk: '0:05:00', calleeName: anna,  parentCall: 'N/A' }), // 300
    rawRow({ callId: 'P5', legId: 0, start: IN, talk: '0:02:00', calleeName: anna,  parentCall: 'N/A' }), // 120
    // Queue legs carry the ring / answer / miss events.
    rawRow({ callId: 'Q1',  legId: 0, start: IN,  caller: 'CallQueue(103)', calleeName: anna, parentCall: 'P1', callerId: 'A_Q_CSR', answered: true }),
    rawRow({ callId: 'Q2',  legId: 0, start: IN,  caller: 'CallQueue(103)', calleeName: anna, parentCall: 'P2', callerId: 'A_Q_CSR', answered: true }),
    rawRow({ callId: 'Q3',  legId: 0, start: IN,  caller: 'CallQueue(103)', calleeName: anna, parentCall: 'P3', callerId: 'A_Q_CSR', missed: true }),
    // P5: rang twice -- missed, then answered on the re-ring.
    rawRow({ callId: 'Q5a', legId: 0, start: IN,  caller: 'CallQueue(103)', calleeName: anna, parentCall: 'P5', callerId: 'A_Q_CSR', missed: true }),
    rawRow({ callId: 'Q5b', legId: 1, start: IN,  caller: 'CallQueue(103)', calleeName: anna, parentCall: 'P5', callerId: 'A_Q_CSR', answered: true }),
    // Out-of-window answered leg -- excluded from every windowed metric.
    rawRow({ callId: 'Q4',  legId: 0, start: OUT, caller: 'CallQueue(103)', calleeName: anna, parentCall: 'P4', callerId: 'A_Q_CSR', answered: true }),
  ];
}

// Runs the REAL build, then exposes the REAL drill over the same sheet.
function scenario(opts) {
  opts = opts || {};
  const rosterName = opts.rosterName || 'Anna Smith';
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': [new Array(26).fill('')].concat(fixtureRows(opts.feedName)),
      'DQE Historical Data': [new Array(34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: [rosterName + ', 103'] }),
    },
  });
  h.state.spreadsheet = ss;
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));

  const built = ss._sheet('DQE Historical Data')._data.slice(1)
    .filter(function (r) { return r[2] === rosterName; })[0];
  assert.ok(built, 'the build wrote no row for ' + rosterName
    + ' -- the fixture, not the parity rule, is broken');

  return {
    cell: { unique: built[4], rung: built[5], missed: built[6],
            answered: built[7], ttt: built[8], att: built[9] },
    // The sidebar's "Found N" -- the number an operator reconciles by hand.
    drill: function (column) {
      const out = h.fn('getDQEDrilldownRows')({
        dateStr: DATE, agentName: rosterName, column: column,
      });
      assert.ok(!out.error, 'drill col ' + column + ': ' + out.error);
      return out;
    },
  };
}

// ── The fixture must stay non-degenerate ──────────────────────────────────

test('fixture guard: the metrics are distinguishable from one another', function () {
  // Without this, a fixture edit that made rung == unique == answered would
  // leave every parity assertion below passing while testing nothing.
  const s = scenario();
  assert.notEqual(s.cell.rung, s.cell.unique,
    'rung must differ from unique (P5 rings twice) or the unique parity is vacuous');
  assert.notEqual(s.cell.answered, s.cell.rung,
    'answered must differ from rung or the answered parity is vacuous');
  assert.ok(s.cell.missed > 0 && s.cell.answered > 0);
  assert.notEqual(s.cell.ttt, '0:00:00', 'TTT must be non-zero');
});

// ── Count parity, column by column ────────────────────────────────────────

test('col 6 (Total Rung): the drill finds exactly the rows the build counted', function () {
  const s = scenario();
  assert.equal(s.drill(6).rowCount, s.cell.rung);
});

test('col 7 (Total Missed): drill count == cell', function () {
  const s = scenario();
  const out = s.drill(7);
  assert.equal(out.rowCount, s.cell.missed);
  assert.equal(out.summary.missedCount, s.cell.missed);
});

test('col 8 (Total Answered): drill count == cell', function () {
  const s = scenario();
  const out = s.drill(8);
  assert.equal(out.rowCount, s.cell.answered);
  assert.equal(out.summary.answeredCount, s.cell.answered);
});

test('col 5 (Unique): distinct matched PARENTS == cell, not matched legs', function () {
  // The distinction the fixture exists to expose: P5 contributes two legs
  // but one unique parent, so a drill that reported leg count here would
  // over-report against the build.
  const s = scenario();
  const out = s.drill(5);
  const parents = {};
  out.groups.forEach(function (g) {
    (g.legs || []).forEach(function () { parents[g.parentCallId] = true; });
  });
  assert.equal(out.rowCount, s.cell.unique,
    'the drill\'s Found-N for Unique must equal the stored unique-parent count');
});

// ── INV-08: TTT/ATT attribution ───────────────────────────────────────────

test('col 9 (TTT): the drill sums the agent\'s OWN leg talk, matching the cell', function () {
  // Bob's 999s leg shares parent P1. A max-across-legs regression in either
  // implementation moves TTT and breaks this equality.
  const s = scenario();
  assert.equal(s.drill(9).summary.totalTalkStr, s.cell.ttt);
});

test('INV-08 decoy is live: no group attributes Bob\'s talk to Anna', function () {
  // Guards the guard -- if the decoy stopped sharing a parent, the TTT
  // parity above would still pass but would no longer prove attribution.
  const s = scenario();
  const p1 = s.drill(9).groups.filter(function (g) { return g.parentCallId === 'P1'; })[0];
  assert.ok(p1, 'P1 missing from the TTT drill');
  assert.equal(p1.parentTalkSec, 999, 'the decoy leg must still be on P1');
  assert.equal(p1.agentTalkSec, 180, 'the drill attributed the max-across-legs '
    + 'talk instead of the agent\'s own leg (INV-08)');
});

test('col 10 (ATT): TTT / contributing parents reproduces the stored ATT', function () {
  const s = scenario();
  const out = s.drill(10);
  const contributing = out.groups.filter(function (g) { return g.agentTalkSec > 0; }).length;
  assert.ok(contributing > 0);
  const attSec = Math.round(out.summary.totalTalkSec / contributing);
  assert.equal(h.fn('secToHMSLocal')(attSec), s.cell.att);
});

// ── F-13: the work window applies to windowed metrics ─────────────────────

test('F-13: the out-of-window leg is EXCLUDED from every windowed metric', function () {
  // Q4 (05:00 PST) is answered but outside [6:30, 15:00). Before F-13 the
  // drill windowed only rung/missed/answered, so Unique/TTT/ATT over-counted
  // it and rendered a false mismatch against the very cell being checked.
  const s = scenario();
  [5, 6, 7, 8, 9, 10].forEach(function (col) {
    const out = s.drill(col);
    assert.equal(out.usesWindow, true, 'col ' + col + ' must apply the work window');
    const matched = [];
    out.groups.forEach(function (g) {
      (g.legs || []).forEach(function (l) { matched.push(l.callId); });
    });
    assert.ok(matched.indexOf('Q4') === -1 || out.nearMissCount > 0,
      'col ' + col + ': the out-of-window leg must be excluded from the matched '
      + 'set (it may still be reported as a near-miss)');
  });
});

test('F-13: the out-of-window leg surfaces as a NEAR MISS, not silently dropped', function () {
  // Showing why a row was excluded is the whole point of the sidebar; a
  // silent drop looks identical to a missing row to the operator.
  const s = scenario();
  assert.ok(s.drill(6).nearMissCount > 0,
    'the window-excluded leg should be reported as a near miss');
});

// ── INV-24: canonicalization parity (R8-D4) ───────────────────────────────

test('R8-D4: a FLATTEN-matched feed name drills under its canonical roster name', function () {
  // Roster: "Ana Maria Lopez". Feed: "Ana (Maria) Lopez" -- matched only by
  // INV-24's FLATTEN key, not by stripping the parenthetical. The build
  // rewrites it to the roster form, so the DQE cell is under the canonical
  // name; the drill must canonicalize the same way or report "no matching
  // rows" for precisely the agents most likely to be investigated.
  const s = scenario({ rosterName: 'Ana Maria Lopez', feedName: 'Ana (Maria) Lopez' });
  assert.equal(s.drill(6).rowCount, s.cell.rung);
  assert.equal(s.drill(8).rowCount, s.cell.answered);
  assert.equal(s.drill(9).summary.totalTalkStr, s.cell.ttt);
});

test('F24: a STRIP-matched feed name also drills under its canonical name', function () {
  // The other INV-24 normalization: roster "Roman (Robin) Paulose", feed
  // omits the nickname entirely.
  const s = scenario({ rosterName: 'Roman (Robin) Paulose', feedName: 'Roman Paulose' });
  assert.equal(s.drill(6).rowCount, s.cell.rung);
  assert.equal(s.drill(9).summary.totalTalkStr, s.cell.ttt);
});

// ── Drillability contract ─────────────────────────────────────────────────

test('every slot column maps to `missed`, and non-drillable columns refuse', function () {
  // Slot columns K..AC hold missed-ring times, so each must drill as missed;
  // a column the build does not derive from matchable rows must refuse
  // rather than return a number an operator would reconcile against.
  const toMetric = h.fn('columnToMetric');
  for (let c = 11; c <= 29; c++) assert.equal(toMetric(c), 'missed', 'col ' + c);
  [1, 2, 3, 33, 34, 35].forEach(function (c) {
    assert.equal(toMetric(c), null, 'col ' + c + ' must not be drillable');
  });
});
