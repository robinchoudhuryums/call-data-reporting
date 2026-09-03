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

test('presence: the beat returns the serving build stamp for the update notice ("" when absent)', function () {
  installHealth({});
  h.state.cache = new Map();
  // BuildStamp.gs is not loaded by this harness, mirroring a pre-E3
  // deployment: the guarded read must yield '' (the client suppresses the
  // notice on an empty side), never a throw.
  assert.equal(h.call('recordPresence', { page: 'dept' }).stamp, '');
  h.ctx.BUILD_STAMP_ = 'deploy.sh 2026-08-28T00:00:00Z | git abc1234 | main';
  try {
    assert.equal(h.call('recordPresence', { page: 'dept' }).stamp,
      'deploy.sh 2026-08-28T00:00:00Z | git abc1234 | main');
  } finally {
    delete h.ctx.BUILD_STAMP_;   // never a real vm global here, safe to remove
  }
});

// ── All Script Properties (inventory) ────────────────────────────────────

test('props inventory: classifies the live store, flags unrecognized keys, never ships values', function () {
  installHealth({});
  h.state.cache = new Map();
  // installHealth seeds SPREADSHEET_ID + ADMIN_EMAILS (both operator); add one
  // of each other group, two dynamic-family keys, a SECRET, and an orphan.
  Object.assign(h.state.props, {
    SMOKE_LAST: '2026-08-01T00:00:00Z',              // engine
    DQE_PARITY_FROM: '2026-08-01',                   // tool
    ESC_SNAPSHOT_META: '{"chunks":1}',               // engine (prefix family)
    DIGEST_RUN_MARKER_weekly: 'claimed',             // engine (prefix family)
    NEON_PASS: 's3cr3t-sentinel-value',              // operator + secret
    OLD_RETIRED_FEATURE_KEY: 'leftover',             // unrecognized
  });
  const data = h.call('getSystemHealth', { part: 'fast' });
  const summary = rowByKey(data, 'props-count');
  assert.ok(summary, 'summary row present');
  assert.equal(summary.section, 'props');
  assert.equal(summary.status, 'muted');
  assert.match(summary.value, /8 stored — 3 operator config · 3 engine state · 1 tool params · 1 unrecognized/);
  // Group rows list KEY NAMES (discovery past the settings page's 50-row cap).
  assert.match(rowByKey(data, 'props-operator').value, /ADMIN_EMAILS.*NEON_PASS.*SPREADSHEET_ID/);
  assert.match(rowByKey(data, 'props-engine').value, /DIGEST_RUN_MARKER_weekly.*ESC_SNAPSHOT_META.*SMOKE_LAST/);
  assert.match(rowByKey(data, 'props-tool').value, /DQE_PARITY_FROM/);
  // The orphan gets its own actionable warn row (length only, no value).
  const orphan = rowByKey(data, 'props-unknown-OLD_RETIRED_FEATURE_KEY');
  assert.ok(orphan, 'unrecognized key row present');
  assert.equal(orphan.status, 'warn');
  assert.match(orphan.value, /unrecognized \(8 chars stored\)/);
  assert.doesNotMatch(orphan.value, /leftover/);
  // SECRET pin: no property VALUE — the secret's above all — reaches the
  // payload anywhere (the store holds NEON_PASS / HMAC_SECRET, and this
  // payload is served to the client).
  assert.doesNotMatch(JSON.stringify(data), /s3cr3t-sentinel-value/);
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

// broad-scan F12: the classifier can only see the rows it scans, and it was
// reading 80 while the Overview banner (post-LM1) reads 250. In deferred-mirror
// mode a retry storm writes ~5 rows per queued date per 15-min run, so 80 rows
// is about an hour of history -- a step that failed this morning scrolls out,
// vanishes from latestByStep, and the row renders a false ALL-CLEAR. Pin both
// the window and the honest wording.
test('F12: pipe-failures scans at least as wide as the Overview banner, and says so', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  let askedFor = null;
  h.ctx.readPipelineHealth_ = function (n) {
    askedFor = n;
    return [{ timestamp: '2026-08-19 07:05', step: 'processIntegratedHistory:DQE',
              status: 'success', notes: '' }];
  };
  const row = rowByKey(h.call('getSystemHealth'), 'pipe-failures');

  // The Overview banner's window is the floor -- this row must never be the
  // narrower of the two (it is the one CLAUDE.md calls the trustworthy signal).
  const ovSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'apps-script', 'department-dashboard',
                         'CompanyOverview.gs'), 'utf8');
  const ovM = /OVERVIEW_PIPELINE_FRESHNESS_SCAN_ROWS = (\d+)/.exec(ovSrc);
  assert.ok(ovM, 'OVERVIEW_PIPELINE_FRESHNESS_SCAN_ROWS not found -- update this suite');
  assert.ok(askedFor >= Number(ovM[1]),
    'pipe-failures scans ' + askedFor + ' rows but the Overview banner scans '
    + ovM[1] + ' -- the health page must not have the narrower window (F12/LM1)');

  assert.equal(row.status, 'ok');
  assert.match(row.value, /last \d+ entries/,
    'the OK text must disclose the scanned window, not claim an unqualified all-clear');
});

// ── F5: the Neon read-volume gauge ────────────────────────────────────────
//
// The owner exhausted Neon's monthly transfer allowance with managers live and
// the Neon-only surfaces (Escalations, Inbound, Direct, Caller Lookup) went to
// their "unavailable" states for the rest of the month. Every existing probe
// reported Neon as REACHABLE throughout -- because a Neon that has spent its
// allowance is reachable. This row measures consumption instead.

// The accumulator itself lives in NeonRead.gs (not loaded by the suite above,
// which is why the Health row typeof-guards the call).
const hNeon = loadGas({ files: ['Config.gs', 'NeonRead.gs'] });

test('F5: neonNoteEgress_ accumulates bytes + reads within a month', function () {
  hNeon.state.props = {};
  hNeon.call('neonNoteEgress_', 1000);
  hNeon.call('neonNoteEgress_', 2500);
  const out = hNeon.call('readNeonEgress_');
  assert.equal(out.bytes, 3500);
  assert.equal(out.reads, 2);
  assert.equal(out.budgetMb, 0, 'no budget declared -> informational only');
  assert.equal(out.pctOfBudget, null);
});

test('F5: a stale month reads as zero, not as last month\'s total', function () {
  hNeon.state.props = {
    NEON_EGRESS_MTD: JSON.stringify({ m: '1999-01', bytes: 999999, reads: 42 }),
  };
  const out = hNeon.call('readNeonEgress_');
  assert.equal(out.bytes, 0, 'a carried-over month must not report as this month');
  assert.equal(out.reads, 0);
  // ...and the next write starts the new month cleanly rather than adding to it.
  hNeon.call('neonNoteEgress_', 100);
  assert.equal(hNeon.call('readNeonEgress_').bytes, 100);
});

test('F5: a declared budget turns the gauge into a percentage', function () {
  hNeon.state.props = { NEON_EGRESS_BUDGET_MB: '10' };
  hNeon.call('neonNoteEgress_', 5 * 1024 * 1024);
  const out = hNeon.call('readNeonEgress_');
  assert.equal(out.budgetMb, 10);
  assert.equal(out.pctOfBudget, 50);
});

test('F5: zero/garbage byte counts are ignored, and the gauge never throws', function () {
  hNeon.state.props = {};
  hNeon.call('neonNoteEgress_', 0);
  hNeon.call('neonNoteEgress_', null);
  hNeon.call('neonNoteEgress_', 'junk');
  assert.equal(hNeon.call('readNeonEgress_').reads, 0,
    'a non-read must not inflate the read count');
  // Corrupt stored JSON self-heals rather than poisoning every later read.
  hNeon.state.props.NEON_EGRESS_MTD = '{not json';
  assert.equal(hNeon.call('readNeonEgress_').bytes, 0);
  hNeon.call('neonNoteEgress_', 50);
  assert.equal(hNeon.call('readNeonEgress_').bytes, 50);
});

test('F5: the Health row is muted without a budget, ok under it, warn near it', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.readNeonEgress_ = function () {
    return { month: '2026-08', bytes: 5 * 1024 * 1024, reads: 12, budgetMb: 0, pctOfBudget: null };
  };
  let row = rowByKey(h.call('getSystemHealth'), 'neon-egress');
  assert.equal(row.status, 'muted', 'no declared budget -> no invented threshold');
  assert.match(row.value, /5 MB in 12 read\(s\)/);
  assert.match(row.hint, /NEON_EGRESS_BUDGET_MB/, 'tells the operator how to arm it');
  assert.match(row.hint, /FLOOR/, 'is honest that under-budget is not proof of headroom');

  h.ctx.readNeonEgress_ = function () {
    return { month: '2026-08', bytes: 1024 * 1024, reads: 3, budgetMb: 100, pctOfBudget: 1 };
  };
  assert.equal(rowByKey(h.call('getSystemHealth'), 'neon-egress').status, 'ok');

  h.ctx.readNeonEgress_ = function () {
    return { month: '2026-08', bytes: 85 * 1024 * 1024, reads: 900, budgetMb: 100, pctOfBudget: 85 };
  };
  row = rowByKey(h.call('getSystemHealth'), 'neon-egress');
  assert.equal(row.status, 'warn', '85% of a declared budget must warn BEFORE the cliff');
  assert.match(row.value, /85% of the 100 MB budget/);
});

test('F5: the gauge degrades to an absent row when NeonRead.gs is unavailable', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.readNeonEgress_ = undefined;   // the suite's default load state
  const data = h.call('getSystemHealth');
  assert.equal(rowByKey(data, 'neon-egress'), undefined,
    'a missing accumulator drops the row; it must never throw the page');
  assert.ok(data.rows.length > 10, 'the rest of the page still renders');
});

// ── B4: the email-quota row ────────────────────────────────────────────────
//
// Alerts, digests, the Daily Call Queue Report, pipeline-failure notices,
// sign-in notifications and the client-error beacon all draw on ONE MailApp
// daily quota. Exhausting it is silent in exactly the way the Neon transfer
// cap was: sends stop, nothing surfaces, and the first sign is a manager
// asking why they stopped getting alerts.
test('B4: the mail-quota row is ok with headroom and WARNS when it runs low', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.state.mailQuota = 1400;
  let row = rowByKey(h.call('getSystemHealth'), 'mail-quota');
  assert.equal(row.status, 'ok');
  assert.match(row.value, /1400 message\(s\)/);

  h.state.mailQuota = 12;
  row = rowByKey(h.call('getSystemHealth'), 'mail-quota');
  assert.equal(row.status, 'warn', 'below the floor the alert channel is at risk');
  assert.match(row.hint, /SILENTLY/, 'the hint names the failure mode, not just the number');
  h.state.mailQuota = undefined;
});

test('B4: the quota row degrades to absent rather than throwing the page', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  const realMail = h.ctx.MailApp;
  h.ctx.MailApp = { sendEmail: function () {} };   // no getRemainingDailyQuota
  const data = h.call('getSystemHealth');
  assert.equal(rowByKey(data, 'mail-quota'), undefined);
  assert.ok(data.rows.length > 10, 'the rest of the page still renders');
  h.ctx.MailApp = realMail;
});

// ── E3: the deployed-build stamp row ──────────────────────────────────────
//
// deploy.sh stamps BuildStamp.gs at push time; a bare `clasp push -f` ships
// the committed placeholder. Either way the row is MUTED — a manual push is
// legitimate; the hint, not the color, carries the meaning.
test('E3: a real stamp renders with the compare-against-git hint', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.BUILD_STAMP_ = 'deploy.sh 2026-08-20T16:00:00Z | git abc1234 | main';
  const row = rowByKey(h.call('getSystemHealth'), 'build-stamp');
  assert.equal(row.status, 'muted');
  assert.match(row.value, /git abc1234/);
  assert.match(row.hint, /Operator State #2/);
  h.ctx.BUILD_STAMP_ = undefined;
});

test('E3: the placeholder (bypassed deploy.sh) and a pre-E3 deployment both say so', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.BUILD_STAMP_ = 'unstamped — last push bypassed scripts/deploy.sh';
  let row = rowByKey(h.call('getSystemHealth'), 'build-stamp');
  assert.equal(row.status, 'muted', 'a manual push is legitimate — never warn');
  assert.match(row.hint, /OUTSIDE scripts\/deploy\.sh/,
    'the hint must say what "unstamped" means: no CI gate ran on exactly what went live');

  h.ctx.BUILD_STAMP_ = undefined;   // BuildStamp.gs not in the deployment at all
  row = rowByKey(h.call('getSystemHealth'), 'build-stamp');
  assert.match(row.value, /pre-E3 push/);
  assert.match(row.hint, /OUTSIDE scripts\/deploy\.sh/);
});

// ── E1: the retention-horizon rows ─────────────────────────────────────────
//
// The fast half (legs-horizon) reads only the workbook, so it renders even
// mid-outage — exactly when the deadline matters. The neon half
// (retention-risk) rides the shared connection and cross-references which
// surviving dates the per-call tables are missing. Helpers live in
// NeonCoverage.gs (not loaded by this suite), so both rows are typeof-gated:
// stub them to drive the branches.
test('E1: legs-horizon renders the surviving span in the FAST part, sheet-only', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.ncSurvivingCallLegsDates_ = function () { return ['2026-08-10', '2026-08-19']; };
  let connCalls = 0;
  h.ctx.getDashboardNeonConn_ = function () { connCalls++; return { close: function () {} }; };
  const data = h.call('getSystemHealth', { part: 'fast' });
  const row = rowByKey(data, 'legs-horizon');
  assert.equal(row.status, 'muted');
  assert.match(row.value, /2 day-sheet\(s\) alive: 2026-08-10 … 2026-08-19/);
  assert.match(row.hint, /#40/, 'names the queue-split deadline that shares the window');
  assert.equal(connCalls, 0, 'the fast half must stay sheet-only (R21)');
  h.ctx.ncSurvivingCallLegsDates_ = undefined;
});

test('E1: retention-risk warns with the outage playbook when Neon is unreachable', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.ncSurvivingCallLegsDates_ = function () { return ['2026-08-10', '2026-08-19']; };
  h.ctx.ncRetentionRisk_ = function () { throw new Error('must not be called with no conn'); };
  h.ctx.getDashboardNeonConn_ = function () { return null; };   // unreachable
  const row = rowByKey(h.call('getSystemHealth', { part: 'neon' }), 'retention-risk');
  assert.equal(row.status, 'warn');
  assert.match(row.hint, /backfillInboundCalls \+ backfillOutboundCalls/);
  assert.match(row.hint, /2026-08-10/, 'names the oldest surviving sheet — the first date to die');
  h.ctx.ncSurvivingCallLegsDates_ = undefined; h.ctx.ncRetentionRisk_ = undefined;
});

test('E1: retention-risk lists unmirrored surviving dates with their deadlines, ok when clean', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.ncSurvivingCallLegsDates_ = function () { return ['2026-08-10', '2026-08-11']; };
  h.ctx.getDashboardNeonConn_ = function () { return { close: function () {} }; };
  h.ctx.ncRetentionRisk_ = function () {
    return { tables: [
      { table: 'inbound_calls', atRisk: [{ date: '2026-08-11', lastDay: '2026-08-25' }] },
      { table: 'outbound_calls', atRisk: [], missingTable: true },
    ] };
  };
  let row = rowByKey(h.call('getSystemHealth', { part: 'neon' }), 'retention-risk');
  assert.equal(row.status, 'warn');
  assert.match(row.value, /inbound_calls 2026-08-11 \(until ~2026-08-25\)/);
  assert.match(row.hint, /BEFORE the listed last day/);
  assert.match(row.hint, /outbound_calls: table not created yet/);

  h.ctx.ncRetentionRisk_ = function () {
    return { tables: [
      { table: 'inbound_calls', atRisk: [] },
      { table: 'outbound_calls', atRisk: [] },
    ] };
  };
  row = rowByKey(h.call('getSystemHealth', { part: 'neon' }), 'retention-risk');
  assert.equal(row.status, 'ok');
  assert.match(row.value, /every surviving Call_Legs date is mirrored/);
  h.ctx.ncSurvivingCallLegsDates_ = undefined; h.ctx.ncRetentionRisk_ = undefined;
});

test('E1: with the helpers absent (suite default) both rows degrade to absent, and the R21 pins hold', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.getDashboardNeonConn_ = function () { return { close: function () {} }; };
  const data = h.call('getSystemHealth');
  assert.equal(rowByKey(data, 'legs-horizon'), undefined);
  assert.equal(rowByKey(data, 'retention-risk'), undefined);
});

// ── EA-1: per-surface egress attribution ─────────────────────────────────────
// The single monthly total left egress reduction blind: the biggest lever
// depends on WHICH reader is spending. Every neonNoteEgress_ callsite now
// passes a short surface label; the gauge stores a per-label sub-count and
// the Health row renders the top consumers.

test('EA-1: neonNoteEgress_ attributes bytes per surface; readNeonEgress_ ranks top consumers', function () {
  hNeon.state.props = {};
  hNeon.call('neonNoteEgress_', 1000, 'dqe');
  hNeon.call('neonNoteEgress_', 4000, 'inbound');
  hNeon.call('neonNoteEgress_', 500, 'dqe');
  const out = hNeon.call('readNeonEgress_');
  assert.equal(out.bytes, 5500, 'the total still accumulates unchanged');
  assert.equal(out.reads, 3);
  const top = JSON.parse(JSON.stringify(out.top));
  assert.deepEqual(top, [
    { surface: 'inbound', bytes: 4000, reads: 1 },
    { surface: 'dqe', bytes: 1500, reads: 2 },
  ]);
});

test('EA-1: unlabeled reads land in "other"; label overflow folds into "other"', function () {
  hNeon.state.props = {};
  hNeon.call('neonNoteEgress_', 100);   // legacy no-label call
  for (let i = 0; i < 30; i++) hNeon.call('neonNoteEgress_', 10, 'surface-' + i);
  const out = hNeon.call('readNeonEgress_');
  const stored = JSON.parse(hNeon.state.props.NEON_EGRESS_MTD);
  const labels = Object.keys(stored.by);
  assert.ok(labels.length <= 24, 'distinct labels capped so the property stays small (got ' + labels.length + ')');
  assert.ok(stored.by.other, 'the unlabeled read and the overflow both land in other');
  assert.equal(out.bytes, 100 + 300, 'totals never lose overflow bytes');
});

test('EA-1: a pre-attribution stored value upgrades in place (earlier reads stay unattributed)', function () {
  const mk = hNeon.call('neonEgressMonthKey_');
  hNeon.state.props = {
    NEON_EGRESS_MTD: JSON.stringify({ m: mk, bytes: 7000, reads: 4 }),
  };
  hNeon.call('neonNoteEgress_', 1000, 'qcd');
  const out = hNeon.call('readNeonEgress_');
  assert.equal(out.bytes, 8000);
  assert.equal(out.reads, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(out.top)),
    [{ surface: 'qcd', bytes: 1000, reads: 1 }]);
});

test('EA-1: the Health row appends the top-consumer ranking when attribution exists', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  h.ctx.readNeonEgress_ = function () {
    return { month: '2026-08', bytes: 6 * 1024 * 1024, reads: 20, budgetMb: 0, pctOfBudget: null,
             top: [{ surface: 'dqe', bytes: 4 * 1024 * 1024, reads: 12 },
                   { surface: 'heatmap', bytes: 2 * 1024 * 1024, reads: 8 }] };
  };
  const row = rowByKey(h.call('getSystemHealth'), 'neon-egress');
  assert.match(row.value, /top: dqe 4 MB, heatmap 2 MB/);
  // ...and a pre-attribution payload (no top) renders exactly as before.
  h.ctx.readNeonEgress_ = function () {
    return { month: '2026-08', bytes: 5 * 1024 * 1024, reads: 12, budgetMb: 0, pctOfBudget: null };
  };
  const row2 = rowByKey(h.call('getSystemHealth'), 'neon-egress');
  assert.ok(row2.value.indexOf('top:') === -1);
});


// ── Batch 2 (2026-09-03 broad scan): the Health page's false-green / sticky-red cluster ──

function isoDaysAgo_(n) { return new Date(Date.now() - n * 86400000).toISOString(); }
function phStampDaysAgo_(n) {
  // The Pipeline Health reader's 'yyyy-MM-dd HH:mm' shape (script-TZ wall clock).
  const d = new Date(Date.now() - n * 86400000);
  const p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function withTriggers_(fns, fn) {
  const orig = h.ctx.ScriptApp;
  h.ctx.ScriptApp = Object.assign({}, orig, {
    getProjectTriggers: function () {
      return fns.map(function (f) { return { getHandlerFunction: function () { return f; } }; });
    },
  });
  try { return fn(); } finally { h.ctx.ScriptApp = orig; }
}

test('O-2: a LATE queue-report outcome paints the row amber (it used to read green)', function () {
  installHealth({ props: {
    NEON_HOST: 'h',
    QUEUE_REPORT_LAST_RESULT: 'LATE 2026-07-09 — QCD data did not land before the window closed; the poller keeps retrying.',
  } });
  assert.equal(rowByKey(h.call('getSystemHealth'), 'out-queuereport').status, 'warn');
  // A late SEND leads with "Sent" and stays green.
  installHealth({ props: { NEON_HOST: 'h',
    QUEUE_REPORT_LAST_RESULT: 'Sent 2026-07-09 to 3 subscribers (LATE — QCD data landed after the morning window) at X' } });
  assert.equal(rowByKey(h.call('getSystemHealth'), 'out-queuereport').status, 'ok');
});

test('O-14: the queue-report row no longer reads the never-written QUEUE_REPORT_LAST key', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'SystemHealth.gs'), 'utf8');
  assert.doesNotMatch(src, /'QUEUE_REPORT_LAST'/, 'the bare key was dead: nothing ever wrote it');
  // And the row still renders from the result string alone.
  installHealth({ props: { NEON_HOST: 'h', QUEUE_REPORT_LAST_RESULT: 'Sent 2026-07-16 to 4 subscribers at X' } });
  const row = rowByKey(h.call('getSystemHealth'), 'out-queuereport');
  assert.equal(row.status, 'ok');
  assert.doesNotMatch(row.value, / @ /, 'no phantom timestamp suffix');
});

test('O-7: an INCONCLUSIVE watchdog outcome warns, and the ingest watchdog has an outcome row', function () {
  installHealth({ props: { NEON_HOST: 'h',
    DQE_SILENCE_WATCH_LAST: '2026-07-16 07:00',
    DQE_SILENCE_WATCH_LAST_RESULT: 'INCONCLUSIVE — QCD read failed; state untouched, the next run re-checks',
    INGEST_WATCHDOG_LAST: isoDaysAgo_(0.1),
    INGEST_WATCHDOG_LAST_RESULT: 'INCONCLUSIVE — Pipeline Health unreadable (missing/empty sheet or parse error); state untouched, the next run re-checks',
  } });
  const data = h.call('getSystemHealth');
  assert.equal(rowByKey(data, 'out-dqesilence').status, 'warn', 'a check that could not check is not green');
  const iw = rowByKey(data, 'out-ingestwatch');
  assert.ok(iw, 'the ingest watchdog was the one flag-gated engine with no outcome row');
  assert.equal(iw.status, 'warn');
  installHealth({ props: { NEON_HOST: 'h', INGEST_WATCHDOG_LAST: isoDaysAgo_(0.1), INGEST_WATCHDOG_LAST_RESULT: 'fresh' } });
  assert.equal(rowByKey(h.call('getSystemHealth'), 'out-ingestwatch').status, 'ok');
});

test('O-3 / C2-5: a failure-only step name ages out of pipe-failures; a recurring one and a normal step do not', function () {
  installHealth({ props: { NEON_HOST: 'h' } });
  // 1. buildDQE:neon failed 10 days ago and (by construction) never logs
  //    success -> not flagged, but named in the hint.
  h.ctx.readPipelineHealth_ = function () {
    return [{ timestamp: phStampDaysAgo_(10), step: 'buildDQE:neon', status: 'failure', notes: 'unreachable' },
            { timestamp: phStampDaysAgo_(0.5), step: 'processIntegratedHistory:DQE', status: 'success', notes: '' }];
  };
  let row = rowByKey(h.call('getSystemHealth'), 'pipe-failures');
  assert.equal(row.status, 'ok', 'a 10-day-old failure-only row is not a live failure');
  assert.match(row.hint, /buildDQE:neon/, 'but it is disclosed');
  assert.match(row.hint, /never log a success row/);
  // 2. The same step failed YESTERDAY -> flagged.
  h.ctx.readPipelineHealth_ = function () {
    return [{ timestamp: phStampDaysAgo_(1), step: 'buildDQE:neon', status: 'failure', notes: 'unreachable' }];
  };
  row = rowByKey(h.call('getSystemHealth'), 'pipe-failures');
  assert.equal(row.status, 'warn');
  assert.match(row.value, /buildDQE:neon/);
  // 3. A step that DOES log successes keeps the M1 rule regardless of age:
  //    its latest row is failure, so it is failing.
  h.ctx.readPipelineHealth_ = function () {
    return [{ timestamp: phStampDaysAgo_(10), step: 'processIntegratedHistory:DQE', status: 'failure', notes: 'x' }];
  };
  row = rowByKey(h.call('getSystemHealth'), 'pipe-failures');
  assert.equal(row.status, 'warn');
  // 4. The list and INV-44 agree on the failure-only names.
  const names = h.ctx.HEALTH_FAILURE_ONLY_STEPS_;
  ['processIntegratedHistory:CDR:neon', 'processIntegratedHistory:QCD:neon', 'processIntegratedHistory:Direct:neon',
   'buildDQE:neon', 'processIntegratedHistory:CSR-guard', 'neonMirror:gave-up', 'bulkBackfill:QCD', 'bulkBackfill:CSR']
    .forEach(function (n) { assert.ok(names.indexOf(n) !== -1, n + ' is failure-only'); });
  const inv = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'docs', 'invariants.md'), 'utf8');
  names.forEach(function (n) { assert.ok(inv.indexOf(n) !== -1, 'INV-44 names ' + n); });
  delete h.ctx.readPipelineHealth_;
});

test('O-4: an armed engine whose last RECORDED outcome is older than its allowance warns STALE', function () {
  // Cache warm: daily trigger, 4-day allowance. 10 days old + installed -> stale.
  installHealth({ props: { NEON_HOST: 'h', CACHE_WARM_LAST: isoDaysAgo_(10), CACHE_WARM_LAST_RESULT: 'ok (12 warmed, 900ms)' } });
  let row = withTriggers_(['warmReportCaches_'], function () { return rowByKey(h.call('getSystemHealth'), 'out-warm'); });
  assert.equal(row.status, 'warn');
  assert.match(row.value, /STALE: last recorded outcome is 10(\.\d)? day\(s\) old/);
  assert.match(row.value, /6-minute kill/);
  // Same age, trigger NOT installed -> just an old ok (the svc row says "not installed").
  row = rowByKey(h.call('getSystemHealth'), 'out-warm');
  assert.equal(row.status, 'ok');
  // Fresh outcome + installed -> ok.
  installHealth({ props: { NEON_HOST: 'h', CACHE_WARM_LAST: isoDaysAgo_(1), CACHE_WARM_LAST_RESULT: 'ok (12 warmed, 900ms)' } });
  row = withTriggers_(['warmReportCaches_'], function () { return rowByKey(h.call('getSystemHealth'), 'out-warm'); });
  assert.equal(row.status, 'ok');
  // A flag-gated engine with the flag OFF is never aged (its svc row already
  // says "installed but DISABLED"); with the flag ON it is.
  installHealth({ props: { NEON_HOST: 'h', DQE_SILENCE_WATCH_LAST: '2026-01-05 07:00', DQE_SILENCE_WATCH_LAST_RESULT: 'ok 0 silent' } });
  row = withTriggers_(['runDqeSilenceWatch_'], function () { return rowByKey(h.call('getSystemHealth'), 'out-dqesilence'); });
  assert.equal(row.status, 'ok', 'flag off -> not aged');
  installHealth({ props: { NEON_HOST: 'h', DQE_SILENCE_WATCH_ENABLED: 'true', DQE_SILENCE_WATCH_LAST: '2026-01-05 07:00', DQE_SILENCE_WATCH_LAST_RESULT: 'ok 0 silent' } });
  row = withTriggers_(['runDqeSilenceWatch_'], function () { return rowByKey(h.call('getSystemHealth'), 'out-dqesilence'); });
  assert.equal(row.status, 'warn', 'flag on + armed + months old -> stale');
  // Window-gated keep-warm carries no allowance: an old ping is not stale.
  installHealth({ props: { NEON_HOST: 'h', NEON_KEEPWARM_ENABLED: 'true', NEON_KEEPWARM_LAST: isoDaysAgo_(30), NEON_KEEPWARM_LAST_RESULT: 'ok 12ms' } });
  row = withTriggers_(['keepNeonWarm_'], function () { return rowByKey(h.call('getSystemHealth'), 'out-keepwarm'); });
  assert.equal(row.status, 'ok');
});

test('O-4: healthAgeMs_ reads both stamp shapes and rejects junk', function () {
  const f = h.ctx.healthAgeMs_;
  const now = Date.now();
  assert.ok(Math.abs(f(new Date(now - 3600000).toISOString(), now) - 3600000) < 1000, 'ISO instant');
  assert.ok(f(phStampDaysAgo_(2), now) > 1.9 * 86400000 && f(phStampDaysAgo_(2), now) < 2.1 * 86400000, 'reader wall-clock stamp');
  assert.equal(f('', now), null);
  assert.equal(f('not a date', now), null);
});
