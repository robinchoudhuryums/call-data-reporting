'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// System Health page (SystemHealth.gs) + the Neon-backup pure helpers
// (NeonBackup.gs). getSystemHealth is a read/assembly surface -- every
// sub-probe is stubbed here; the point is the admin gate, the row shape,
// and that a failing probe degrades to its own warn row.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'SystemHealth.gs', 'NeonBackup.gs'],
});

// -- NeonBackup pure helpers --------------------------------------------------

test('backup: nbNextMonth_ / nbMonthsBetween_ handle year rollover', function () {
  assert.equal(h.call('nbNextMonth_', '2026-12'), '2027-01');
  assert.equal(h.call('nbNextMonth_', '2026-01'), '2026-02');
  deepEqual(h.call('nbMonthsBetween_', '2026-11', '2027-02'),
    ['2026-11', '2026-12', '2027-01', '2027-02']);
  deepEqual(h.call('nbMonthsBetween_', '2026-05', '2026-05'), ['2026-05']);
  deepEqual(h.call('nbMonthsBetween_', 'junk', '2026-05'), []);
});

test('backup: nbSnapshotTrimList_ keeps the newest N snapshots, ignores other files', function () {
  const names = [
    'escalations-2026-06-06.jsonl', 'escalations-2026-06-13.jsonl',
    'escalations-2026-06-20.jsonl', 'escalations-2026-06-27.jsonl',
    'inbound_calls-2026-06.jsonl',            // different table: never trimmed
    'escalation_activity-2026-06.jsonl',
  ];
  deepEqual(h.call('nbSnapshotTrimList_', names, 2),
    ['escalations-2026-06-13.jsonl', 'escalations-2026-06-06.jsonl']);
  deepEqual(h.call('nbSnapshotTrimList_', names, 10), []);
});

// -- getSystemHealth ----------------------------------------------------------

function installHealth(opts) {
  opts = opts || {};
  h.state.userEmail = opts.email || 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  if (opts.props) Object.keys(opts.props).forEach(function (k) { h.state.props[k] = opts.props[k]; });
  // Sub-probes stubbed to healthy defaults; individual tests override.
  h.ctx.computeOverviewPipelineFreshness_ = function () {
    return { latestTimestamp: '2026-07-09 07:10', hoursSinceFresh: 2.5, isStale: false };
  };
  h.ctx.getDqeReadSource_ = function () { return 'sheet'; };
  h.ctx.getConfigSource_ = function () { return 'sheet'; };
  h.ctx.computeNeonReadHealth_ = function () {
    return { configured: true, source: 'sheet', status: 'ok', count: 0 };
  };
  h.ctx.computeNeonMirrorHealth_ = function () {
    return { configured: true, status: 'ok', sheetMax: '2026-07-08', neonMax: '2026-07-08', gapDays: 0 };
  };
  h.ctx.getQcdReadSource_ = function () { return 'sheet'; };
  h.ctx.computeQcdMirrorHealth_ = function () {
    return { configured: true, status: 'ok', sheetMax: '2026-07-08', neonMax: '2026-07-08', gapDays: 0 };
  };
  const sheets = {};
  ['Access Control', 'Alert Config', 'Alert Log', 'Pipeline Health', 'Digest Config',
   'Agent Alias Overrides', 'Orphan Fix Log', 'Dept Config', 'Report Usage',
   'Queue Report Subscribers']   // O-5: the tenth setup() sheet
    .forEach(function (n) { if (!(opts.missingSheets || []).length || (opts.missingSheets || []).indexOf(n) === -1) sheets[n] = [['h']]; });
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
}

function rowByKey(data, key) {
  return data.rows.filter(function (r) { return r.key === key; })[0];
}

test('health: admin-gated at the server boundary', function () {
  installHealth({ email: 'stranger@x.com' });
  assert.throws(function () { h.call('getSystemHealth'); }, /admin/i);
});

test('health: healthy install -> ok/muted rows, required-trigger warns, warnCount consistent', function () {
  installHealth({ props: { NEON_HOST: 'h', DASHBOARD_URL: 'u', HMAC_SECRET: 's' } });
  const data = h.call('getSystemHealth');
  assert.equal(rowByKey(data, 'dqe-fresh').status, 'ok');
  assert.equal(rowByKey(data, 'neon-conf').status, 'ok');
  assert.equal(rowByKey(data, 'dqe-source').status, 'muted');
  assert.equal(rowByKey(data, 'qcd-source').status, 'muted');
  assert.equal(rowByKey(data, 'mirror-health').status, 'ok');
  assert.equal(rowByKey(data, 'qcd-mirror-health').status, 'ok');
  // Shimmed ScriptApp has NO triggers installed -> the two required
  // services warn (with remediation hints); optional ones stay muted.
  assert.equal(rowByKey(data, 'trg-alerts').status, 'warn');
  assert.ok(rowByKey(data, 'trg-alerts').hint.length > 0, 'warn rows carry a hint');
  assert.equal(rowByKey(data, 'trg-warm').status, 'muted');
  assert.equal(rowByKey(data, 'trg-backup').status, 'muted');
  // Optional property unset -> muted, required property set -> ok.
  assert.equal(rowByKey(data, 'prop-COMPANY_HOLIDAYS').status, 'muted');
  assert.equal(rowByKey(data, 'prop-DASHBOARD_URL').status, 'ok');
  assert.equal(rowByKey(data, 'setup-sheets').status, 'ok');
  const warns = data.rows.filter(function (r) { return r.status === 'warn'; }).length;
  assert.equal(data.warnCount, warns);
});

test('M1/OPS-8: a successful backup (leads with ok, detail says "skipped") is OK, a FAILED one warns', function () {
  // The backup outcome string now LEADS with a status token (ok/FAILED) so the
  // OPS-8 classifier -- healthy iff the result STARTS WITH `ok` -- is correct
  // even though every per-table detail contains the designed-normal word
  // "skipped". Before M1 the string started with a table name + always
  // contained "skipped", so the backup Health row was amber on every run,
  // masking a real outage of the no-sheet-fallback tables.
  installHealth({ props: {
    NEON_HOST: 'h',
    NEON_BACKUP_LAST: '2026-07-12T06:00:00Z',
    NEON_BACKUP_LAST_RESULT: 'ok | escalations ok (12KB) | escalation_activity ok '
      + '(1 month file(s) written, 4 closed skipped) | inbound_calls ok '
      + '(2 month file(s) written, 3 closed skipped) | 1234ms',
  }});
  assert.equal(rowByKey(h.call('getSystemHealth'), 'out-backup').status, 'ok',
    'a fully-successful backup is not amber');

  installHealth({ props: {
    NEON_HOST: 'h',
    NEON_BACKUP_LAST: '2026-07-12T06:00:00Z',
    NEON_BACKUP_LAST_RESULT: 'FAILED | escalations ok (12KB) | '
      + 'inbound_calls FAILED: connection timeout | 1234ms',
  }});
  assert.equal(rowByKey(h.call('getSystemHealth'), 'out-backup').status, 'warn',
    'a failed backup surfaces as warn');
});

test('health: stale pipeline / behind mirror / missing sheets surface as warn rows', function () {
  installHealth({ props: { NEON_HOST: 'h' }, missingSheets: ['Report Usage'] });
  h.ctx.computeOverviewPipelineFreshness_ = function () {
    return { latestTimestamp: '2026-07-05 07:10', hoursSinceFresh: 90, isStale: true };
  };
  h.ctx.OVERVIEW_PIPELINE_STALE_HOURS = 36;   // referenced by the stale branch's hint
  h.ctx.computeNeonMirrorHealth_ = function () {
    return { configured: true, status: 'behind', sheetMax: '2026-07-08', neonMax: '2026-07-05', gapDays: 3 };
  };
  const data = h.call('getSystemHealth');
  assert.equal(rowByKey(data, 'dqe-fresh').status, 'warn');
  assert.equal(rowByKey(data, 'mirror-health').status, 'warn');
  assert.ok(rowByKey(data, 'mirror-health').value.indexOf('3 day') !== -1);
  const sheetsRow = rowByKey(data, 'setup-sheets');
  assert.equal(sheetsRow.status, 'warn');
  assert.ok(sheetsRow.value.indexOf('Report Usage') !== -1);
});

test('health: a throwing probe degrades to its own warn row (page never fails whole)', function () {
  installHealth({});
  h.ctx.computeNeonReadHealth_ = function () { throw new Error('boom'); };
  const data = h.call('getSystemHealth');
  const row = rowByKey(data, 'read-health');
  assert.equal(row.status, 'warn');
  assert.ok(row.value.indexOf('probe failed') !== -1);
  assert.ok(data.rows.length > 10, 'other sections still render');
});

// readPipelineHealth_ lives in Alerts.gs (not loaded here) -- stub it the same
// way the other sub-probes are stubbed; the point is getSystemHealth's
// latest-outcome-per-step classification, not the sheet read. The stub returns
// NEWEST-first (readPipelineHealth_'s contract).
test('single-signal: pipe-failures flags a step whose LATEST outcome is failure, not a recovered one', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.readPipelineHealth_ = function () {
    return [   // newest-first
      { timestamp: '2026-07-14 07:06', step: 'neonMirror:Inbound', status: 'failure', notes: 'unreachable' },
      { timestamp: '2026-07-14 07:05', step: 'processIntegratedHistory:QCD:neon', status: 'success', notes: '' },
      { timestamp: '2026-07-14 07:01', step: 'processIntegratedHistory:QCD:neon', status: 'failure', notes: 'timeout' },
      { timestamp: '2026-07-14 07:00', step: 'processIntegratedHistory:CDR', status: 'success', notes: '' },
    ];
  };
  const row = rowByKey(h.call('getSystemHealth'), 'pipe-failures');
  assert.equal(row.status, 'warn', 'a currently-failing step warns');
  assert.match(row.value, /neonMirror:Inbound/, 'names the currently-failing step');
  assert.doesNotMatch(row.value, /QCD:neon/, 'a recovered step is NOT flagged (no wolf-crying)');
});

test('single-signal: pipe-failures is OK when every step recovered', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.readPipelineHealth_ = function () {
    return [   // newest-first: DQE recovered
      { timestamp: '2026-07-14 07:05', step: 'processIntegratedHistory:DQE', status: 'success', notes: '' },
      { timestamp: '2026-07-14 07:01', step: 'processIntegratedHistory:DQE', status: 'failure', notes: 'x' },
    ];
  };
  assert.equal(rowByKey(h.call('getSystemHealth'), 'pipe-failures').status, 'ok');
});

test('O-5: queue-report trigger + MISSED outcome are covered by the Health page', function () {
  installHealth({ props: {
    NEON_HOST: 'h',
    QUEUE_REPORT_LAST_RESULT: 'MISSED 2026-07-09 — QCD data was not ready before the window closed (12:00).',
  } });
  const data = h.call('getSystemHealth');
  assert.equal(rowByKey(data, 'trg-queuereport').status, 'muted', 'optional trigger, not installed -> muted');
  assert.equal(rowByKey(data, 'out-queuereport').status, 'warn', 'a MISSED day paints the outcome row amber');
});

// -- Report Usage summary (Batch 10) ------------------------------------------

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

test('usage: computeReportUsageSummary_ aggregates runs/users/manager-runs/hit-rate per report, busiest-first, window-scoped', function () {
  installHealth({});
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'Report Usage': [
    ['Timestamp', 'Report', 'Department', 'Role', 'Email', 'Cache Hit'],
    [daysAgo(2),  'insights', 'CSR',   'manager', 'm1@x.com', 'TRUE'],
    [daysAgo(1),  'insights', 'CSR',   'manager', 'm1@x.com', 'FALSE'],
    [daysAgo(1),  'insights', 'Sales', 'admin',   'a@x.com',  'TRUE'],
    [daysAgo(1),  'insights', 'CSR',   'manager', 'm2@x.com', 'TRUE'],
    [daysAgo(3),  'inbound',  '(all)', 'admin',   'a@x.com',  'FALSE'],
    [daysAgo(45), 'summary',  'CSR',   'manager', 'm1@x.com', 'FALSE'],  // outside the 30d window
  ] } });
  const ru = h.call('computeReportUsageSummary_');
  assert.equal(ru.available, true);
  assert.equal(ru.rowsInWindow, 5, 'the 45-day-old row is excluded');
  assert.equal(ru.clipped, false);
  assert.deepEqual(Array.from(ru.reports.map(function (r) { return r.report; })), ['insights', 'inbound'],
    'busiest-first; the out-of-window report does not appear');
  const ins = ru.reports[0];
  assert.equal(ins.runs, 4);
  assert.equal(ins.users, 3, 'unique emails');
  assert.equal(ins.managerRuns, 3, 'the un-gating signal');
  assert.equal(ins.cacheHitPct, 75);
  assert.match(String(ins.lastUsed), /^\d{4}-\d{2}-\d{2}$/);
  const inb = ru.reports[1];
  assert.equal(inb.managerRuns, 0, 'admin-only use shows zero manager runs');
});

test('usage: missing sheet -> available:false; getSystemHealth degrades to a muted unavailable row', function () {
  installHealth({ missingSheets: ['Report Usage'] });
  const ru = h.call('computeReportUsageSummary_');
  assert.equal(ru.available, false);
  assert.match(ru.reason, /setup/i);
  const row = rowByKey(h.call('getSystemHealth'), 'usage-none');
  assert.equal(row.status, 'muted');
  assert.match(row.value, /unavailable/);
});

test('usage: getSystemHealth renders one muted row per report + never warns (evidence, not health)', function () {
  installHealth({});
  h.state.spreadsheet.getSheetByName('Report Usage').appendRow([daysAgo(1), 'summary', 'CSR', 'manager', 'm1@x.com', 'FALSE']);
  const data = h.call('getSystemHealth');
  const row = rowByKey(data, 'usage-summary');
  assert.ok(row, 'per-report usage row present');
  assert.equal(row.status, 'muted');
  assert.match(row.value, /1 run\(s\) · 1 user\(s\) · 1 by managers · 0% cache hits · last \d{4}-\d{2}-\d{2}/);
  assert.ok(!rowByKey(data, 'usage-clipped'), 'no clip note when the scan covered the window');
});

test('usage: header-only sheet -> "no report opens recorded" muted row', function () {
  installHealth({});   // fixture sheets are header-only
  const row = rowByKey(h.call('getSystemHealth'), 'usage-none');
  assert.equal(row.status, 'muted');
  assert.match(row.value, /no report opens/);
});

test('O-5/Batch-10: a smoke FAILED outcome paints the out-smoke row amber; ok stays green', function () {
  installHealth({ props: { SMOKE_LAST: '2026-07-16T12:00:00Z',
    SMOKE_LAST_RESULT: 'FAILED 1/7 | sheet-open ok | latest-dqe-date ok | dept-summary ok | missed-report ok | insights ok | qcd-alldept ok | neon FAIL' } });
  assert.equal(rowByKey(h.call('getSystemHealth'), 'out-smoke').status, 'warn');
  installHealth({ props: { SMOKE_LAST: '2026-07-16T12:00:00Z',
    SMOKE_LAST_RESULT: 'ok 7/7 | sheet-open ok | latest-dqe-date ok | dept-summary ok | missed-report ok | insights ok | qcd-alldept ok | neon ok' } });
  assert.equal(rowByKey(h.call('getSystemHealth'), 'out-smoke').status, 'ok');
});

test('O-5: a healthy "Sent ..." queue-report outcome stays green', function () {
  installHealth({ props: {
    NEON_HOST: 'h',
    QUEUE_REPORT_LAST_RESULT: 'Sent 2026-07-16 to 4 subscribers at Thu Jul 17 2026',
  } });
  const data = h.call('getSystemHealth');
  assert.equal(rowByKey(data, 'out-queuereport').status, 'ok');
});

// ── R7 (G-3): UI surface toggles (UI_FLAGS) ──────────────────────────────

test('uiflags: sanitize dedupes, lowercases, drops unknown keys (tolerant grammar)', function () {
  const out = h.ctx.uiFlagsSanitize_(
    ' dept-team-strip , NOPE, Ins-Heatmap, dept-team-strip ,, ov-user-table ');
  assert.deepEqual(Array.from(out), ['dept-team-strip', 'ins-heatmap', 'ov-user-table']);
  assert.deepEqual(Array.from(h.ctx.uiFlagsSanitize_(null)), []);
  assert.deepEqual(Array.from(h.ctx.uiFlagsSanitize_(['dept-qcd-side', 'garbage'])), ['dept-qcd-side']);
});

test('uiflags: save is admin-gated; writes the property, clears it when empty', function () {
  h.state.userEmail = 'stranger@x.com';
  h.state.props = { ADMIN_EMAILS: 'admin@x.com', SPREADSHEET_ID: 'fake' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': [['h']] } });
  assert.throws(function () { h.call('saveUiFlags', { flags: ['dept-team-strip'] }); }, /admin/i);

  h.state.userEmail = 'admin@x.com';
  const saved = h.call('saveUiFlags', { flags: ['dept-team-strip', 'bogus', 'ins-queue-health'] });
  assert.deepEqual(Array.from(saved.flags), ['dept-team-strip', 'ins-queue-health']);
  assert.equal(h.state.props.UI_FLAGS, 'dept-team-strip,ins-queue-health');

  const read = h.call('getUiFlags');
  assert.deepEqual(Array.from(read.flags), ['dept-team-strip', 'ins-queue-health']);
  assert.ok(read.registry && read.registry['dept-missed-section'], 'registry ships to the editor');

  const cleared = h.call('saveUiFlags', { flags: [] });
  assert.deepEqual(Array.from(cleared.flags), []);
  assert.equal(h.state.props.UI_FLAGS, undefined, 'empty set deletes the property');
});
