'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
// Legacy (prototype-agnostic) deepEqual: arrays built inside the vm realm have a
// different Array.prototype than the test realm, so assert/strict's deepEqual
// (which checks prototypes) false-fails on them.
const { deepEqual } = require('node:assert');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// Pipeline-failure watchdog (PipelineWatch.gs, testing-feedback #3): an hourly
// trigger scans the Pipeline Health sheet for `failure` rows newer than a
// watermark and emails the admins. The scan is a pure helper; the trigger is
// exercised end-to-end against a fake Pipeline Health sheet.
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'PipelineWatch.gs'] });

const HDR = ['Timestamp', 'Step', 'Status', 'Rows', 'Duration (ms)', 'Notes'];

function phRow(ms, step, status, notes) {
  return [new Date(ms), step, status, null, null, notes || ''];
}

// Rebuild the Pipeline Health sheet (props persist across calls, so the
// watermark carries over between simulated trigger runs).
function setRows(rows) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'Pipeline Health': [HDR].concat(rows) },
  });
}

function resetState() {
  h.state.props = { SPREADSHEET_ID: 'fake', PIPELINE_WATCH_ENABLED: 'true', ADMIN_EMAILS: 'admin@x.com' };
  h.state.sentEmails.length = 0;
}

// ── Pure scan helper ──────────────────────────────────────────────────

test('scan: baseline run (sinceMs=null) flags NO failures but still finds maxTsMs', function () {
  const rows = [
    { tsMs: 100, step: 'buildDQE', status: 'failure', notes: 'boom' },
    { tsMs: 200, step: 'autoImport', status: 'success', notes: '' },
  ];
  const r = h.call('pipelineWatchScan_', rows, null);
  assert.equal(r.newFailures.length, 0, 'no failures on the baseline run');
  assert.equal(r.maxTsMs, 200);
});

test('scan: returns failures newer than the watermark, ascending; ignores success + old', function () {
  const rows = [
    { tsMs: 300, step: 'C', status: 'failure', notes: 'new-2' },
    { tsMs: 150, step: 'A', status: 'failure', notes: 'old (<= watermark)' },
    { tsMs: 250, step: 'B', status: 'failure', notes: 'new-1' },
    { tsMs: 400, step: 'D', status: 'success', notes: 'newer but not a failure' },
  ];
  const r = h.call('pipelineWatchScan_', rows, 200);
  deepEqual(r.newFailures.map(function (f) { return f.step; }), ['B', 'C'], 'ascending, only >200 failures');
  assert.equal(r.maxTsMs, 400, 'maxTsMs spans success rows too');
});

test('scan: rows with no usable timestamp are skipped, do not break maxTsMs', function () {
  const rows = [
    { tsMs: null, step: 'X', status: 'failure', notes: 'no ts -> cannot dedup' },
    { tsMs: 500, step: 'Y', status: 'failure', notes: 'ok' },
  ];
  const r = h.call('pipelineWatchScan_', rows, 100);
  deepEqual(r.newFailures.map(function (f) { return f.step; }), ['Y']);
  assert.equal(r.maxTsMs, 500);
});

// ── Trigger end-to-end ────────────────────────────────────────────────

test('trigger: disabled -> no email, no state written', function () {
  resetState();
  h.state.props.PIPELINE_WATCH_ENABLED = 'false';
  setRows([phRow(1000, 'buildDQE', 'failure', 'x')]);
  h.call('runPipelineWatch_');
  assert.equal(h.state.sentEmails.length, 0);
  assert.equal(h.state.props.PIPELINE_WATCH_LAST_TS, undefined, 'no watermark written while disabled');
});

test('trigger: first run establishes a silent baseline (no email), later failures alert once', function () {
  resetState();
  // First run: an EXISTING failure is in history -> baseline, no email.
  setRows([
    phRow(1000, 'buildDQE', 'failure', 'pre-install failure'),
    phRow(2000, 'autoImport', 'success', ''),
  ]);
  h.call('runPipelineWatch_');
  assert.equal(h.state.sentEmails.length, 0, 'baseline never blasts the backlog');
  assert.match(h.state.props.PIPELINE_WATCH_LAST_RESULT, /baseline/);
  assert.equal(h.state.props.PIPELINE_WATCH_LAST_TS, '2000', 'watermark = newest row');

  // Second run: a NEW failure lands after the baseline -> one email.
  setRows([
    phRow(1000, 'buildDQE', 'failure', 'pre-install failure'),
    phRow(2000, 'autoImport', 'success', ''),
    phRow(3000, 'processIntegratedHistory:QCD:neon', 'failure', 'mirror threw'),
  ]);
  h.call('runPipelineWatch_');
  assert.equal(h.state.sentEmails.length, 1, 'exactly one alert for the new failure');
  assert.match(h.state.sentEmails[0].subject, /Pipeline failure: 1 new/);
  assert.match(h.state.sentEmails[0].body, /processIntegratedHistory:QCD:neon/);
  assert.equal(h.state.props.PIPELINE_WATCH_LAST_TS, '3000', 'watermark advanced past the new failure');

  // Third run: nothing new -> no second email, healthy result.
  h.call('runPipelineWatch_');
  assert.equal(h.state.sentEmails.length, 1, 'the same failure is not re-alerted');
  assert.match(h.state.props.PIPELINE_WATCH_LAST_RESULT, /no new failures/);
});

test('trigger: a failed send leaves the watermark un-advanced so it retries (OPS-1)', function () {
  resetState();
  // Baseline first.
  setRows([phRow(1000, 'autoImport', 'success', '')]);
  h.call('runPipelineWatch_');
  const baseTs = h.state.props.PIPELINE_WATCH_LAST_TS;

  // New failure, but the mail send throws (quota) -> notify returns false.
  setRows([
    phRow(1000, 'autoImport', 'success', ''),
    phRow(4000, 'buildDQE', 'failure', 'threw'),
  ]);
  const realMail = h.ctx.MailApp;
  h.ctx.MailApp = { sendEmail: function () { throw new Error('Service invoked too many times'); } };
  try {
    h.call('runPipelineWatch_');
  } finally { h.ctx.MailApp = realMail; }
  assert.equal(h.state.sentEmails.length, 0, 'send threw -> nothing captured');
  assert.equal(h.state.props.PIPELINE_WATCH_LAST_TS, baseTs, 'watermark NOT advanced on a failed send');
  assert.match(h.state.props.PIPELINE_WATCH_LAST_RESULT, /FAILED/);

  // Mail works again -> the retry actually sends and advances the watermark.
  h.call('runPipelineWatch_');
  assert.equal(h.state.sentEmails.length, 1, 'retry delivers the previously-failed alert');
  assert.equal(h.state.props.PIPELINE_WATCH_LAST_TS, '4000');
});
