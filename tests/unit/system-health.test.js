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

// ── R19: per-user activity + the client-error beacon ─────────────────────

test('R19 usage: computeReportUsageSummary_ returns per-user rollup, busiest-first, with top-report digest + last-seen role', function () {
  installHealth({});
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'Report Usage': [
    ['Timestamp', 'Report', 'Department', 'Role', 'Email', 'Cache Hit'],
    [daysAgo(3), 'summary',  'CSR', 'manager', 'm1@x.com', 'FALSE'],
    [daysAgo(2), 'summary',  'CSR', 'manager', 'm1@x.com', 'TRUE'],
    [daysAgo(1), 'insights', 'CSR', 'manager', 'm1@x.com', 'FALSE'],
    [daysAgo(1), 'overview', '(all)', 'admin', 'a@x.com',  'FALSE'],
    [daysAgo(45), 'summary', 'CSR', 'manager', 'ghost@x.com', 'FALSE'],  // outside window
  ] } });
  const ru = h.call('computeReportUsageSummary_');
  assert.equal(ru.users.length, 2, 'out-of-window user does not appear');
  const m1 = ru.users[0];
  assert.equal(m1.email, 'm1@x.com', 'busiest first');
  assert.equal(m1.runs, 3);
  assert.equal(m1.role, 'manager');
  assert.match(m1.top, /summary 2/);
  assert.match(m1.top, /insights 1/);
  assert.match(String(m1.lastUsed), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ru.users[1].email, 'a@x.com');
});

test('R19 usage: getSystemHealth renders muted per-user rows under the users section', function () {
  installHealth({});
  h.state.spreadsheet.getSheetByName('Report Usage')
    .appendRow([daysAgo(1), 'overview', '(all)', 'manager', 'm9@x.com', 'FALSE']);
  const data = h.call('getSystemHealth');
  const row = rowByKey(data, 'user-m9@x.com');
  assert.ok(row, 'per-user row present');
  assert.equal(row.section, 'users');
  assert.equal(row.status, 'muted', 'usage evidence never warns');
  assert.match(row.value, /1 open\(s\) · manager · last \d{4}-\d{2}-\d{2} · overview 1/);
});

test('R19 beacon: first report emails the admins with user/route/message; repeat of the same signature is throttled', function () {
  installHealth({});
  h.state.sentEmails.length = 0;
  const out = h.call('reportClientIssue', {
    kind: 'uncaught', message: 'prLastRoster is not defined',
    stack: 'ReferenceError: prLastRoster is not defined\n  at initDeptSelector_',
    route: 'dept', ua: 'TestBrowser/1.0',
  });
  assert.equal(out.ok, true);
  assert.equal(out.emailed, true);
  assert.equal(h.state.sentEmails.length, 1);
  const mail = h.state.sentEmails[0];
  assert.equal(mail.to, 'admin@x.com');
  assert.match(mail.subject, /Client issue — uncaught \(admin@x\.com\)/);
  assert.match(mail.body, /prLastRoster is not defined/);
  assert.match(mail.body, /Page: {2}dept/);
  assert.match(mail.body, /TestBrowser/);

  // Same signature again -> throttled (no second email), still ok.
  const again = h.call('reportClientIssue', {
    kind: 'uncaught', message: 'prLastRoster is not defined', route: 'dept',
  });
  assert.equal(again.ok, true);
  assert.equal(again.emailed, false);
  assert.equal(h.state.sentEmails.length, 1);

  // A DIFFERENT signature still emails.
  const other = h.call('reportClientIssue', { kind: 'load-failure', message: 'Overview load failed: quota' });
  assert.equal(other.emailed, true);
  assert.equal(h.state.sentEmails.length, 2);
});

test('R19 beacon: rolling-window cap stops emails but keeps accepting reports; empty message rejected; role-none rejected', function () {
  installHealth({});
  h.state.sentEmails.length = 0;
  h.state.cache.set('cissue:count', '15');   // window cap reached
  const out = h.call('reportClientIssue', { kind: 'uncaught', message: 'some new error' });
  assert.equal(out.ok, true);
  assert.equal(out.emailed, false, 'cap reached -> no email');
  assert.equal(h.state.sentEmails.length, 0);

  assert.equal(h.call('reportClientIssue', { kind: 'uncaught', message: '' }).ok, false, 'empty message is a no-op');

  installHealth({ email: 'stranger@x.com' });
  assert.throws(function () { h.call('reportClientIssue', { kind: 'x', message: 'y' }); }, /authorized/i);
});

test('R19 beacon: oversized fields are capped, not rejected', function () {
  installHealth({});
  h.state.sentEmails.length = 0;
  h.state.cache = new Map();   // fresh throttle state
  const big = new Array(5000).join('x');
  const out = h.call('reportClientIssue', { kind: 'uncaught', message: big, stack: big, route: big, ua: big });
  assert.equal(out.emailed, true);
  const body = h.state.sentEmails[0].body;
  assert.ok(body.length < 6000, 'email body stays bounded (got ' + body.length + ')');
});

// ── R21: the fast/neon split ─────────────────────────────────────────────

test('R21 split: part=fast skips the live-Neon mirror block entirely (no connection opened)', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  let connCalls = 0;
  h.ctx.getDashboardNeonConn_ = function () { connCalls++; return { close: function () {} }; };
  const data = h.call('getSystemHealth', { part: 'fast' });
  assert.equal(connCalls, 0, 'fast part must never pay a Neon cold start');
  assert.ok(!rowByKey(data, 'mirror-health'), 'no DQE mirror row in the fast part');
  assert.ok(!rowByKey(data, 'qcd-mirror-health'), 'no QCD mirror row in the fast part');
  assert.ok(rowByKey(data, 'dqe-fresh'), 'pipeline rows present');
  assert.ok(rowByKey(data, 'neon-conf'), 'the property-read neon rows stay in the fast part');
  assert.ok(rowByKey(data, 'setup-sheets'), 'sheet rows present');
  assert.equal(data.part, 'fast');
});

test('R21 split: part=neon returns ONLY the two mirror rows, one shared connection', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  let connCalls = 0;
  h.ctx.getDashboardNeonConn_ = function () { connCalls++; return { close: function () {} }; };
  const data = h.call('getSystemHealth', { part: 'neon' });
  assert.equal(connCalls, 1, 'exactly one shared connection');
  assert.equal(data.rows.length, 2);
  assert.ok(rowByKey(data, 'mirror-health'));
  assert.ok(rowByKey(data, 'qcd-mirror-health'));
});

// ── Live presence (the "Active now" section) ─────────────────────────────

test('presence: a heartbeat stores the user; the fast part renders the Active-now summary + per-user muted row', function () {
  installHealth({});
  h.state.cache = new Map();
  assert.equal(h.call('recordPresence', { page: 'dept' }).ok, true);
  const data = h.call('getSystemHealth', { part: 'fast' });
  const summary = rowByKey(data, 'presence-now');
  assert.ok(summary, 'summary row present');
  assert.equal(summary.section, 'presence');
  assert.equal(summary.status, 'muted', 'presence is information, not a health state');
  assert.match(summary.value, /1 user\(s\)/);
  const row = rowByKey(data, 'presence-admin@x.com');
  assert.ok(row, 'per-user row present');
  assert.equal(row.status, 'muted');
  assert.match(row.value, /admin · dept · just now/);
});

test('presence: empty map renders the muted nobody-active row', function () {
  installHealth({});
  h.state.cache = new Map();
  const row = rowByKey(h.call('getSystemHealth', { part: 'fast' }), 'presence-now');
  assert.equal(row.status, 'muted');
  assert.match(row.value, /nobody active/);
});

test('presence: role-none rejected; the agent role is accepted (the rollout-timing glance covers the agent app)', function () {
  installHealth({ email: 'stranger@x.com' });
  h.state.cache = new Map();
  assert.throws(function () { h.call('recordPresence', { page: 'dept' }); }, /authorized/i);
  const realResolve = h.ctx.resolveUser_;
  h.ctx.resolveUser_ = function () {
    return { email: 'ag@x.com', role: 'agent', department: null, departments: [],
             agentDept: 'CSR', agentName: 'Anna' };
  };
  try {
    assert.equal(h.call('recordPresence', { page: 'agent' }).ok, true);
    const live = h.call('readPresence_');
    assert.equal(live.length, 1);
    assert.equal(live[0].email, 'ag@x.com');
    assert.equal(live[0].role, 'agent');
  } finally {
    h.ctx.resolveUser_ = realResolve;
  }
});

test('presence: a beat prunes entries past PRESENCE_PRUNE_SEC_; active reads stop at PRESENCE_ACTIVE_SEC_', function () {
  installHealth({});
  h.state.cache = new Map();
  const now = Math.floor(Date.now() / 1000);
  h.state.cache.set('presence:v1', JSON.stringify({
    'old@x.com':  { t: now - 1000, role: 'manager', page: 'dept' },  // past the 900s prune
    'idle@x.com': { t: now - 600,  role: 'manager', page: 'dept' },  // stored, but not "active" (>360s)
  }));
  h.call('recordPresence', { page: 'overview' });
  const stored = JSON.parse(h.state.cache.get('presence:v1'));
  assert.ok(!stored['old@x.com'], 'stale entry pruned on write');
  assert.ok(stored['idle@x.com'], 'inside the prune window it stays stored');
  const live = h.call('readPresence_');
  assert.deepEqual(Array.from(live.map(function (u) { return u.email; })), ['admin@x.com'],
    'only the fresh beat counts as ACTIVE -- the idle entry waits out its prune silently');
});

test('presence: the user cap drops the stalest entry, never the fresh beat', function () {
  installHealth({});
  h.state.cache = new Map();
  const now = Math.floor(Date.now() / 1000);
  const big = {};
  for (let i = 0; i < 100; i++) big['u' + i + '@x.com'] = { t: now - i, role: 'manager', page: 'dept' };
  h.state.cache.set('presence:v1', JSON.stringify(big));
  h.call('recordPresence', { page: 'dept' });
  const stored = JSON.parse(h.state.cache.get('presence:v1'));
  assert.equal(Object.keys(stored).length, 100, 'bounded at PRESENCE_MAX_USERS_');
  assert.ok(stored['admin@x.com'], 'the fresh beat survives');
  assert.ok(!stored['u99@x.com'], 'the stalest entry is the one dropped');
});

test('presence: corrupt cache JSON self-heals (beat succeeds, map rebuilt)', function () {
  installHealth({});
  h.state.cache = new Map();
  h.state.cache.set('presence:v1', '{not json');
  assert.equal(h.call('recordPresence', { page: 'dept' }).ok, true);
  const stored = JSON.parse(h.state.cache.get('presence:v1'));
  assert.ok(stored['admin@x.com']);
});

test('R21 split: fast + neon together cover exactly the full default payload', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.getDashboardNeonConn_ = function () { return { close: function () {} }; };
  const all = h.call('getSystemHealth').rows.map(function (r) { return r.key; }).sort();
  const split = h.call('getSystemHealth', { part: 'fast' }).rows
    .concat(h.call('getSystemHealth', { part: 'neon' }).rows)
    .map(function (r) { return r.key; }).sort();
  assert.deepEqual(JSON.parse(JSON.stringify(split)), JSON.parse(JSON.stringify(all)),
    'a row added to getSystemHealth must land in exactly one part -- this pin catches a third-bucket drift');
});
