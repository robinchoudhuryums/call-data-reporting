'use strict';

// CH-4 (owner ruling 2026-10-02, Batch 15): getSystemHealth and
// getCompanyOverview were split into section / stage helpers. The split had to
// be BYTE-IDENTICAL, so this suite pins both payloads across many fixture
// states against a golden file taken from the PRE-split code
// (tests/unit/snapshots/ch4-payloads.json).
//
// The fixtures deliberately drive almost every branch the split moved: each
// Health section's ok / warn / muted / probe-failed paths, the three `part`
// passes, an unreachable Neon; the Overview's admin / manager / view-as
// viewers, parent + child + hidden depts, the 30/60/90/YTD windows, the
// queue-split narrowing, the cache put and the cached read, and its early
// returns.
//
// An INTENDED payload change regenerates the golden file:
//   UPDATE_SNAPSHOTS=1 node --test tests/unit/ch4-split-snapshot.test.js
// and the diff of that file is the review of what changed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const SNAP_FILE = process.env.CH4_SNAP_FILE || path.join(__dirname, 'snapshots', 'ch4-payloads.json');
// The Overview's weekday axis is built from local-midnight Dates formatted in
// the SCRIPT TZ, so its payload in this harness depends on the process TZ (the
// documented process-TZ == script-TZ assumption, tests/README.md). CI pins
// America/Chicago; under any other zone the Overview half skips rather than
// compare a different-but-correct payload.
const PROC_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const OV_SKIP = (PROC_TZ !== 'America/Chicago' && !process.env.CH4_SNAP_FILE)
  ? 'Overview snapshots are taken in America/Chicago (process TZ is ' + PROC_TZ + ')' : false;
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const golden = (!UPDATE && fs.existsSync(SNAP_FILE)) ? JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8')) : {};
const taken = {};
const RealDate = Date;

function frozen(h, iso, fn) {
  const fixed = new RealDate(iso).getTime();
  class FakeDate extends RealDate {
    constructor() { if (arguments.length) super(...arguments); else super(fixed); }
    static now() { return fixed; }
  }
  h.ctx.Date = FakeDate;
  try { return fn(); } finally { h.ctx.Date = RealDate; }
}

function check(name, payload) {
  const json = JSON.stringify(payload, null, 1);
  taken[name] = JSON.parse(json);
  if (UPDATE) return;
  assert.ok(Object.prototype.hasOwnProperty.call(golden, name), 'no golden snapshot for "' + name + '" -- run with UPDATE_SNAPSHOTS=1');
  assert.equal(json, JSON.stringify(golden[name], null, 1), name + ': the payload changed');
}

// ── getSystemHealth ──────────────────────────────────────────────────────────

const hh = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'SystemHealth.gs', 'NeonBackup.gs'] });
const NOW = '2026-09-24T15:00:00Z';
const realScriptApp = hh.ctx.ScriptApp;

function healthBase(opts) {
  opts = opts || {};
  hh.state.userEmail = 'admin@x.com';
  hh.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  Object.keys(opts.props || {}).forEach(function (k) { hh.state.props[k] = opts.props[k]; });
  hh.state.mailQuota = opts.mailQuota;
  if (hh.state.cache && hh.state.cache.clear) hh.state.cache.clear();
  const sheets = {};
  ['Access Control', 'Alert Config', 'Alert Log', 'Pipeline Health', 'Digest Config',
   'Agent Alias Overrides', 'Orphan Fix Log', 'Dept Config', 'Report Usage',
   'Queue Report Subscribers', 'Company Holidays', 'Dashboard Standards']
    .forEach(function (n) { if ((opts.missingSheets || []).indexOf(n) === -1) sheets[n] = [['h']]; });
  if (sheets['Dashboard Standards']) {
    sheets['Dashboard Standards'] = [['Department', 'Answer Target', 'Amber Band', 'Team Avg Excludes', 'Published At', 'Published By'],
      ['*', 80, 10, '', '2026-09-17T00:00:00', 'admin@x.com']];
  }
  if (opts.holidayRows) sheets['Company Holidays'] = [['Dates', 'Label', 'Active', 'Notes']].concat(opts.holidayRows);
  if (opts.usageRows) sheets['Report Usage'] = [['Timestamp', 'Report', 'Dept', 'Role', 'Email', 'Cache Hit']].concat(opts.usageRows);
  hh.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  hh.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
  hh.ctx.COMPANY_HOLIDAYS_SOURCE_ = '';
  hh.ctx.ANSWER_TARGETS_MEMO_ = null;
  hh.ctx.DEPT_ANSWER_TARGETS_MEMO_ = null;
  hh.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  const fns = opts.triggers || [];
  hh.ctx.ScriptApp = Object.assign({}, realScriptApp, {
    getProjectTriggers: function () {
      return fns.map(function (f) { return { getHandlerFunction: function () { return f; } }; });
    },
  });
  // Healthy defaults; scenarios override.
  hh.ctx.computeOverviewPipelineFreshness_ = function () {
    return { latestTimestamp: '2026-09-24 07:10', hoursSinceFresh: 2.5, isStale: false };
  };
  hh.ctx.getDqeReadSource_ = function () { return 'sheet'; };
  hh.ctx.getQcdReadSource_ = function () { return 'sheet'; };
  hh.ctx.getConfigSource_ = function () { return 'sheet'; };
  hh.ctx.computeNeonReadHealth_ = function () { return { configured: true, source: 'sheet', status: 'ok', count: 0 }; };
  hh.ctx.computeNeonMirrorHealth_ = function () {
    return { configured: true, status: 'ok', sheetMax: '2026-09-23', neonMax: '2026-09-23', gapDays: 0 };
  };
  hh.ctx.computeQcdMirrorHealth_ = function () {
    return { configured: true, status: 'ok', sheetMax: '2026-09-23', neonMax: '2026-09-23', gapDays: 0 };
  };
  ['readPipelineHealth_', 'ncSurvivingCallLegsDates_', 'ncRetentionRisk_', 'neonStorageByTable_',
   'neonStorageVerdict_', 'escSchemaRead_', 'escSchemaVerdict_', 'readNeonEgress_', 'readTriggerInstallers_',
   'getDashboardNeonConn_', 'BUILD_STAMP_'].forEach(function (k) { delete hh.ctx[k]; });
}

function richHealth(opts) {
  healthBase(Object.assign({
    props: {
      NEON_HOST: 'h', DASHBOARD_URL: 'u', HMAC_SECRET: 's',
      COMPANY_HOLIDAYS: '2026-12-25',
      NEON_KEEPWARM_ENABLED: 'true', INGEST_WATCHDOG_ENABLED: 'false',
      QUEUE_REPORT_ENABLED: 'true', NEON_STORAGE_CAP_MB: '512',
      EMAIL_BCC: 'ok@x.com, not-an-address',
      ALERTS_LAST: '2026-09-15T12:00:00Z', ALERTS_LAST_RESULT: 'ok 2026-09-14: 3 sent',
      DIGEST_LAST_weekly: '2026-09-21T12:00:00Z', DIGEST_LAST_RESULT_weekly: 'ok weekly',
      DIGEST_STARTED_weekly: '2026-09-24T10:00:00Z',
      NEON_BACKUP_LAST: '2026-09-20T11:00:00Z', NEON_BACKUP_LAST_RESULT: 'PARTIAL | store sheets | x',
      QUEUE_REPORT_LAST: '2026-09-23T13:00:00Z', QUEUE_REPORT_LAST_RESULT: 'LATE 2026-09-23 window closed',
      SMOKE_LAST_RESULT: 'ok 7/7',
      NEON_BACKUP_SCRUB_PENDING: JSON.stringify({ ids: ['x1'], since: '2026-09-22T00:00:00Z', lastError: 'down' }),
      SOME_LEFTOVER_KEY: 'abc',
    },
    mailQuota: 12,
    triggers: ['runDailyAlerts_', 'runDailyDigests_', 'runWeeklyDigests_', 'keepNeonWarm_',
               'runIngestWatchdog_', 'runNeonBackup_', 'runSheetCoverageWeekly_'],
    holidayRows: [['2026-11-26', 'Thanksgiving', true, '']],
    missingSheets: ['Orphan Fix Log'],
    usageRows: [
      ['2026-09-20T10:00:00Z', 'overview', '(all)', 'admin', 'admin@x.com', 'TRUE'],
      ['2026-09-21T10:00:00Z', 'insights', 'CSR', 'manager', 'mgr@x.com', 'FALSE'],
      ['2026-09-22T10:00:00Z', 'overview', 'CSR', 'manager', 'mgr@x.com', 'FALSE'],
      ['2026-07-01T10:00:00Z', 'individual', 'CSR', 'manager', 'old@x.com', 'FALSE'],
    ],
  }, opts || {}));
  hh.state.cache.set('presence:v1', JSON.stringify({
    'mgr@x.com': { t: Math.floor(new RealDate(NOW).getTime() / 1000) - 30, role: 'manager', page: 'dept' },
    'admin@x.com': { t: Math.floor(new RealDate(NOW).getTime() / 1000) - 200, role: 'admin', page: 'overview' },
  }));
  hh.state.cache.set('cissue:count', '4');
  hh.ctx.BUILD_STAMP_ = '2026-09-24T09:00Z abc1234 main';
  hh.ctx.computeOverviewPipelineFreshness_ = function () {
    return { latestTimestamp: '2026-09-22 07:10', hoursSinceFresh: 55.8, isStale: true };
  };
  hh.ctx.getDqeReadSource_ = function () { return 'neon'; };
  hh.ctx.computeNeonReadHealth_ = function () {
    return { configured: true, source: 'neon', status: 'warn', count: 3, message: 'timeout', at: '2026-09-24T08:00:00Z' };
  };
  hh.ctx.computeNeonMirrorHealth_ = function () {
    return { configured: true, status: 'behind', sheetMax: '2026-09-23', neonMax: '2026-09-21', gapDays: 2 };
  };
  hh.ctx.computeQcdMirrorHealth_ = function () { return { configured: true, status: 'error' }; };
  hh.ctx.readPipelineHealth_ = function () {
    return [
      { timestamp: '2026-09-24 06:00', step: 'processIntegratedHistory:QCD', status: 'failure', notes: 'rows:0 after delete' },
      { timestamp: '2026-09-24 05:00', step: 'historicalSort:DQE Historical Data', status: 'success', notes: 'sorted -- 12 rows moved' },
      { timestamp: '2026-09-24 05:00', step: 'historicalSort:QCD Historical Data', status: 'failure', notes: 'MIXED-TYPE -- 3 text cells' },
      { timestamp: '2026-09-24 05:00', step: 'historicalSort:CSR Transfer Historical Data', status: 'success', notes: 'skipped -- pointer set' },
      { timestamp: '2026-09-23 06:00', step: 'buildDQE', status: 'success', notes: '' },
      { timestamp: '2026-09-10 06:00', step: 'neonMirror:failure-only', status: 'failure', notes: 'old' },
      { timestamp: '2026-09-22 06:00', step: 'processIntegratedHistory:QCD', status: 'success', notes: '' },
    ];
  };
  hh.ctx.ncSurvivingCallLegsDates_ = function () { return ['2026-09-11', '2026-09-18', '2026-09-23']; };
  hh.ctx.getDashboardNeonConn_ = function () { return { close: function () {} }; };
  hh.ctx.ncRetentionRisk_ = function () {
    return { tables: [
      { table: 'inbound_calls', atRisk: [{ date: '2026-09-11', lastDay: '2026-09-25' }] },
      { table: 'outbound_calls', missingTable: true, atRisk: [] },
    ] };
  };
  hh.ctx.neonStorageByTable_ = function () { return { total: 400 }; };
  hh.ctx.neonStorageVerdict_ = function (s, cap) { return { status: 'warn', value: s.total + ' of ' + cap, hint: 'trim' }; };
  hh.ctx.escSchemaRead_ = function () { return {}; };
  hh.ctx.escSchemaVerdict_ = function () { return { status: 'ok', value: 'columns + index present', hint: '' }; };
  hh.ctx.readNeonEgress_ = function () {
    return { bytes: 300 * 1024 * 1024, reads: 812, month: '2026-09', budgetMb: 350, pctOfBudget: 86,
             top: [{ surface: 'dqe', bytes: 200 * 1024 * 1024 }, { surface: 'backup', bytes: 60 * 1024 * 1024 }] };
  };
  hh.ctx.readTriggerInstallers_ = function () { return { runNeonBackup_: 'someone.else@x.com' }; };
}

function throwingHealth() {
  richHealth();
  const boom = function () { throw new Error('boom'); };
  ['computeOverviewPipelineFreshness_', 'readPipelineHealth_', 'ncSurvivingCallLegsDates_', 'readNeonEgress_',
   'getDqeReadSource_', 'getQcdReadSource_', 'getConfigSource_', 'computeNeonReadHealth_',
   'computeNeonMirrorHealth_', 'computeQcdMirrorHealth_', 'ncRetentionRisk_', 'neonStorageVerdict_',
   'escSchemaVerdict_', 'computeReportUsageSummary_', 'dashboardStandardsStatus_', 'appEmailBccConfig_',
   'getCompanyHolidayRanges_'].forEach(function (k) { hh.ctx[k] = boom; });
  hh.ctx.ScriptApp = Object.assign({}, realScriptApp, { getProjectTriggers: boom });
}

function health(name, setup, req) {
  setup();
  try {
    check('health/' + name, frozen(hh, NOW, function () { return hh.call('getSystemHealth', req); }));
  } finally {
    hh.ctx.ScriptApp = realScriptApp;
  }
}

test('CH-4 snapshot: getSystemHealth, healthy defaults', function () { health('healthy', function () { healthBase(); }); });
test('CH-4 snapshot: getSystemHealth, rich state, every part', function () {
  health('rich-all', richHealth);
  health('rich-fast', richHealth, { part: 'fast' });
  health('rich-neon', richHealth, { part: 'neon' });
});
test('CH-4 snapshot: getSystemHealth, Neon configured but unreachable', function () {
  health('neon-unreachable', function () { richHealth(); hh.ctx.getDashboardNeonConn_ = function () { return null; }; });
});
test('CH-4 snapshot: getSystemHealth, every probe throws', function () { health('throwing', throwingHealth); });
test('CH-4 snapshot: getSystemHealth, all-clear pipeline + no Neon + empty usage', function () {
  health('quiet', function () {
    healthBase({ props: { DASHBOARD_URL: 'u' }, triggers: ['runDailyAlerts_', 'runDailyDigests_', 'runWeeklyDigests_', 'runMonthlyDigests_'],
      usageRows: [] });
    hh.ctx.readPipelineHealth_ = function () {
      return [{ timestamp: '2026-09-24 06:00', step: 'buildDQE', status: 'success', notes: '' },
              { timestamp: '2026-09-24 05:00', step: 'historicalSort:DQE Historical Data', status: 'success', notes: 'ok -- in order' }];
    };
    hh.ctx.ncSurvivingCallLegsDates_ = function () { return []; };
  });
});

// ── getCompanyOverview ───────────────────────────────────────────────────────

const ho = loadGas({ files: ['Config.gs', 'Util.gs', 'DeptConfig.gs', 'CompanyOverview.gs', 'Data.gs'] });
const LATEST = '2026-09-21';   // a Monday
const OV_NOW = '2026-09-22T15:00:00Z';

function isoMinus(n) {
  const d = new RealDate(LATEST + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function dal(date, agent, r, m, a, att, split) {
  return { dateIso: date, agent: agent, totalUnique: r, totalRung: r, totalMissed: m, totalAnswered: a,
           tttSec: a * att, attSec: att, avgAbdWaitSec: 0, csrAvgAbdWaitSec: 0, queueSplit: split || '' };
}
function ovRows() {
  const out = [];
  // Spread across YTD, the 90/60/30-day windows and the latest day.
  [0, 1, 2, 3, 6, 9, 20, 29, 45, 59, 75, 89, 120, 200, 250].forEach(function (n, i) {
    const d = isoMinus(n);
    out.push(dal(d, 'Anna', 10 + i, 2, 8 + (i % 3), 90 + i,
      JSON.stringify({ A_Q_CSR: { u: 6, r: 6, m: 1, a: 5, t: 500, n: 5, mt: '' },
                       A_Q_Spanish: { u: 4, r: 4 + i, m: 1, a: 3, t: 300, n: 3, mt: '' } })));
    out.push(dal(d, 'Bob', 5 + (i % 4), 1, 4, 75));
    out.push(dal(d, 'Cara', 7, i % 2, 6, 120));
    out.push(dal(d, 'Dev', 3, 1, 2, 60));
    out.push(dal(d, 'Hidden Hal', 9, 0, 9, 50));
    out.push(dal(d, 'A_Q_CSR', 0, 4, 0, 0));
    out.push(dal(d, 'Off Roster', 2, 0, 2, 40));
  });
  // Eve is active ONLY outside the 30-day tile window (inside the 90-day chart
  // window and YTD), so a window mix-up between the passes shows up in
  // recentlyActiveCount, the periods and the chart series.
  out.push(dal(isoMinus(60), 'Eve', 4, 1, 3, 80));
  out.push(dal(isoMinus(150), 'Eve', 6, 2, 4, 70));
  return out;
}
function ovInstall(opts) {
  opts = opts || {};
  ho.state.userEmail = 'admin@x.com';
  ho.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  if (opts.queueScope) ho.state.props.QUEUE_SPLIT_SCOPE = opts.queueScope;
  if (ho.state.cache && ho.state.cache.clear) ho.state.cache.clear();
  ho.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 301', 'Bob, 302'], Spanish: ['Anna, 301'],
      Sales: ['Cara, 401', 'Eve, 402'], PAP: ['Dev, 501'], 'CSR Backup': ['Hidden Hal, 601'] }),
    'DQE Historical Data': [['h'], ['x']],
    'Alert Log': [['Timestamp', 'Dept', 'Date', 'Rate', 'Threshold', 'Status', 'Sent', 'Triggered By'],
                  ['2026-09-22T12:00:00Z', 'Sales', LATEST, 60, 70, 'sent', true, 'daily-trigger']],
  } });
  ho.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  ho.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
  ho.ctx.COMPANY_HOLIDAYS_SOURCE_ = '';
  ho.ctx.getAllDepartments_ = function () { return ['CSR', 'Spanish', 'Sales', 'PAP', 'CSR Backup']; };
  ho.ctx.resolveUser_ = function () {
    return opts.user || { email: 'admin@x.com', role: 'admin', department: null,
      departments: ['CSR', 'Spanish', 'Sales', 'PAP', 'CSR Backup'], allDepts: false };
  };
  ho.ctx.getLatestDataDate = function () { return opts.latest === undefined ? LATEST : opts.latest; };
  ho.ctx.getDqeReadSource_ = function () { return opts.source || 'sheet'; };
  ho.ctx.neonFetchDqeRows_ = function () { return opts.neonRows || []; };
  ho.ctx.neonDqeRowsUsable_ = function (r) { return !!(r && r.length); };
  ho.ctx.sheetFetchDqeRows_ = function () { return opts.rows ? opts.rows() : ovRows(); };
  ho.ctx.inboundQueuesForDept_ = function (d) { return { CSR: ['A_Q_CSR'], Spanish: ['A_Q_Spanish'] }[d] || []; };
  ho.ctx.computeQcdSnapshots_ = function (depts, since) {
    const daily = {};
    daily[LATEST] = { totalCalls: 40, abandoned: 2 };
    daily[isoMinus(1)] = { totalCalls: 35, abandoned: 1 };
    return {
      CSR: { latestDate: LATEST, totalCalls: 40, abandonedPct: 5, violations: 1, daily: JSON.parse(JSON.stringify(daily)) },
      Sales: { latestDate: LATEST, totalCalls: 10, abandonedPct: 0, violations: 0, daily: {} },
      _companyDaily: daily,
      _since: since,
    };
  };
  ho.ctx.computeOverviewPipelineFreshness_ = function () { return { latestTimestamp: '2026-09-22 07:00', hoursSinceFresh: 8, isStale: false }; };
  ho.ctx.computeOverviewOrphanNag_ = function (names) { return { count: 1, sample: ['Off Roster'], scanned: names.length }; };
  ho.ctx.computeOverviewUnmappedQcd_ = function () { return { queues: ['A_Q_New'] }; };
  ho.ctx.logReportUsage_ = function () {};
}
function overview(name, opts, req) {
  ovInstall(opts);
  check('overview/' + name, frozen(ho, OV_NOW, function () { return ho.call('getCompanyOverview', req || {}); }));
  return ho.state.cache;
}

test('CH-4 snapshot: getCompanyOverview, admin (parent + child + hidden depts, every window)', { skip: OV_SKIP }, function () {
  overview('admin', {});
});
test('CH-4 snapshot: getCompanyOverview, the cached read returns the same payload', { skip: OV_SKIP }, function () {
  ovInstall({});
  frozen(ho, OV_NOW, function () { ho.call('getCompanyOverview', {}); });
  ho.ctx.sheetFetchDqeRows_ = function () { throw new Error('must be served from the cache'); };
  check('overview/admin-cached', frozen(ho, OV_NOW, function () { return ho.call('getCompanyOverview', {}); }));
});
test('CH-4 snapshot: getCompanyOverview, manager + view-as', { skip: OV_SKIP }, function () {
  overview('manager', { user: { email: 'mgr@x.com', role: 'manager', department: 'Sales', departments: ['Sales', 'PAP'] } });
  overview('view-as', {}, { viewAsDept: 'CSR' });
});
test('CH-4 snapshot: getCompanyOverview, queue split narrowed', { skip: OV_SKIP }, function () { overview('queue-split', { queueScope: 'dept' }); });
test('CH-4 snapshot: getCompanyOverview, Neon source falls back to the sheet', { skip: OV_SKIP }, function () {
  overview('neon-fallback', { source: 'neon', neonRows: [] });
  overview('neon-used', { source: 'neon', neonRows: ovRows().filter(function (r) { return r.agent !== 'Bob'; }) });
});
test('CH-4 snapshot: getCompanyOverview, early returns and the empty read', { skip: OV_SKIP }, function () {
  overview('no-latest', { latest: null });
  overview('empty-read', { rows: function () { return []; } });
});

test('CH-4 snapshot: write the golden file when UPDATE_SNAPSHOTS=1', { skip: !UPDATE }, function () {
  fs.mkdirSync(path.dirname(SNAP_FILE), { recursive: true });
  const ordered = {};
  Object.keys(taken).sort().forEach(function (k) { ordered[k] = taken[k]; });
  fs.writeFileSync(SNAP_FILE, JSON.stringify(ordered, null, 1) + '\n');
});
