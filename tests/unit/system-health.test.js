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
  const sheets = {};
  ['Access Control', 'Alert Config', 'Alert Log', 'Pipeline Health', 'Digest Config',
   'Agent Alias Overrides', 'Orphan Fix Log', 'Dept Config', 'Report Usage']
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
  assert.equal(rowByKey(data, 'mirror-health').status, 'ok');
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
