'use strict';

// OD-3 (broad-scan 2026-09-17): every Neon READ the dashboard performs is
// metered by `neonNoteEgress_` (NeonRead.gs) -- the Health page's egress gauge
// and its `top:` ranking are only honest when the largest reads are counted.
// In a backup month the ranking named `dqe` while the monthly backup (whole
// tables incl. journeys) was what tripped the transfer cap. This sweep pins
// that every `executeQuery(` in the dashboard project is followed by a
// `neonNoteEgress_(` within a short window, except the documented probes
// below (SELECT 1 / MIN / MAX: single scalar rows that cannot move the gauge).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const WINDOW_LINES = 26;
// file -> enclosing function names that are exempt, each a scalar probe.
const EXEMPT = {
  'NeonKeepWarm.gs':  ['keepNeonWarm_'],          // SELECT 1
  'NeonRead.gs':      ['neonGetMaxDqeDate_', 'neonGetMinDqeDate_'],
  'QCDReport.gs':     ['neonGetMaxQcdDate_', 'neonGetMinQcdDate_', 'neonQcdMaxDate_'],
  'NeonBackup.gs':    ['nbMinMonth_'],
  'NeonCoverage.gs':  ['ncNeonMinDate_'],
  'InboundReport.gs': ['computeInboundReport_'],   // the information_schema column probe (SELECT 1 …)
};

function enclosingFn(lines, i) {
  for (let j = i; j >= 0; j--) {
    const m = /^\s*function\s+([A-Za-z0-9_]+)/.exec(lines[j]);
    if (m) return m[1];
  }
  return '?';
}

test('OD-3: every dashboard Neon read is metered (executeQuery -> neonNoteEgress_ within the window) or is a listed scalar probe', function () {
  const unmetered = [];
  let seen = 0;
  fs.readdirSync(DIR).filter(function (n) { return n.endsWith('.gs'); }).forEach(function (f) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
    lines.forEach(function (ln, i) {
      if (ln.indexOf('executeQuery(') === -1) return;
      seen++;
      const win = lines.slice(i, i + WINDOW_LINES).join('\n');
      if (win.indexOf('neonNoteEgress_(') !== -1) return;
      const fn = enclosingFn(lines, i);
      if ((EXEMPT[f] || []).indexOf(fn) !== -1) return;
      unmetered.push(f + ':' + (i + 1) + ' (' + fn + ')');
    });
  });
  assert.ok(seen >= 40, 'the sweep sees the project (' + seen + ' reads)');
  assert.deepEqual(unmetered, [], 'meter these reads with neonNoteEgress_(bytes, <surface>) or list them as scalar probes: ' + unmetered.join('; '));
});

test('OD-3: the exemptions are still scalar probes (MIN / MAX / SELECT 1), not a loophole', function () {
  Object.keys(EXEMPT).forEach(function (f) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    EXEMPT[f].forEach(function (fn) {
      const i = src.indexOf('function ' + fn + '(');
      assert.ok(i >= 0, f + '::' + fn + ' still exists (retire the exemption otherwise)');
      const body = src.slice(i, src.indexOf('\n}', i));
      assert.ok(/SELECT\s+(1|MIN\(|MAX\(|to_char\(MIN\()/i.test(body), f + '::' + fn + ' is a scalar probe');
    });
  });
});
