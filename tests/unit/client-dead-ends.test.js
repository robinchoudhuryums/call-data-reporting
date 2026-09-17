'use strict';

// Batch 4 of the 2026-09-17 broad scan: the client DEAD-END / STALE-STATE
// fixes. Each was a place where the page stopped telling the truth -- a
// loader that never cleared, an error with no way out, a stale panel under a
// new dept's title, a store fed a payload that was not good, a second click
// that dispatched a second mutation. None of them is reachable from
// `node --test` behaviourally (they live in the assembled client IIFE and
// need a click), so these are SOURCE pins: each names the guard that closes
// the dead end and fails if a refactor removes it. The rendered-UI gate
// (`npm run ci:ui`) is where the behaviour is exercised.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
function src(name) { return fs.readFileSync(path.join(DIR, name), 'utf8'); }
function between(s, startRe, endRe) {
  const a = s.search(startRe);
  assert.ok(a >= 0, 'start anchor missing: ' + startRe);
  const rest = s.slice(a);
  const b = rest.search(endRe);
  return b >= 0 ? rest.slice(0, b) : rest;
}

test('C2-1 / C2-4: Insights and IR validation refusals go through ONE refuse helper that clears the loader', function () {
  const ins = src('script-8-insights.html');
  const run = between(ins, /function runInsReport\(/, /\n  function (?!runInsReport)/);
  assert.ok(/function insRefuse_\(/.test(ins), 'insRefuse_ exists');
  assert.ok(/launcherHideLoading_\('ins-launcher-loading'\)/.test(between(ins, /function insRefuse_\(/, /\n  function /)),
    'the refuse helper clears the launcher loader (the "Refreshing… forever" dead end)');
  assert.ok(!/\{ insSetFormError\(/.test(run), 'no early-return in runInsReport sets the form error directly -- each routes through insRefuse_ (the clear + the RPC failure handler may still call it)');
  assert.ok((run.match(/insRefuse_\(/g) || []).length >= 5, 'no-dept, both date checks, prior.error and the mixed-dept refusal all route through it');

  const ir = src('script-6-ir.html');
  const irRun = between(ir, /function runIrReport\(/, /\n  function (?!runIrReport)/);
  assert.ok(/function irRefuse_\(/.test(ir), 'irRefuse_ exists');
  assert.ok(!/\{ irSetFormError\(/.test(irRun), 'no early-return in runIrReport sets the form error directly');
  assert.ok((irRun.match(/irRefuse_\(/g) || []).length >= 5, 'dates, agents, mixed-dept and prior.error refusals all route through it');
  assert.ok(/hideIrDrillLoading_\(\);/.test(between(ir, /function irRefuse_\(/, /\n  function (?!irRefuse_)/)),
    'the refuse helper clears the drill loader unconditionally (C2-4)');
});

test('C2-2: the IR edit popover applies the checked agents and refuses a mixed-dept pick', function () {
  const ir = src('script-6-ir.html');
  const pop = between(ir, /function irApplyEditPopover_\(/, /\n  function (?!irApplyEditPopover_)/);
  assert.ok(/irApplyCheckedAgents_\(/.test(pop), 'the popover commits the checkbox state before scoping');
  assert.ok(/subqPickerScope_\(\$\('ir-agent-list'\)\)/.test(pop), 'the popover runs the same one-dept scope gate as the form');
  assert.ok(/\.mixed\)/.test(pop) && /irSetResultsStatus\('error'/.test(pop), 'a mixed pick is REFUSED with a visible error, not silently narrowed');
});

test('C1-1: the Overview hard error is a Retry block beside the skeleton, never the loader\'s text', function () {
  const s3 = src('script-3-overview.html');
  assert.ok(/function ovShowLoadError_\(/.test(s3) && /function ovClearLoadError_\(/.test(s3));
  assert.ok(!/\$\('ov-loading'\)\.textContent\s*=/.test(s3), 'nothing overwrites the loader markup with error text');
  const load = between(s3, /function ovLoad_\(/, /\n  function (?!ovLoad_)/);
  assert.ok(/ovShowLoadError_\(/.test(load), 'the failure handler uses the block');
  assert.ok(/ovClearLoadError_\(\)/.test(load), 'a fresh non-silent load resets it');
  const show = between(s3, /function ovShowLoadError_\(/, /\n  function ovClearLoadError_/);
  assert.ok(/id="ov-load-retry"/.test(show) && /ovLoad_\(false\)/.test(show), 'the block carries a Retry that re-runs the load');
  assert.ok(/escapeHtml\(msg/.test(show), 'the server message is escaped before innerHTML');
});

test('C1-2: the async init latest-date snap yields to a window the user already picked', function () {
  const s2 = src('script-2-chrome.html');
  assert.ok(/var datesTouched_ = false;/.test(s2), 'the flag is declared');
  const init = between(s2, /\.getLatestDataDates\(\);/.source ? /withSuccessHandler\(function \(dates\) \{/ : null, /\.getLatestDataDates\(\);/);
  assert.ok(/if \(!datesTouched_\) \{\s*\$\('from-date'\)\.value = dqe;\s*\$\('to-date'\)\.value = dqe;/.test(init),
    'the snap writes From/To only while untouched');
  // Every user-driven window write sets the flag: typed dates, preset chips, the chart deep link.
  const fromL = between(s2, /\$\('from-date'\)\.addEventListener\('change'/, /\}\);/);
  const toL = between(s2, /\$\('to-date'\)\.addEventListener\('change'/, /\}\);/);
  assert.ok(/datesTouched_ = true/.test(fromL) && /datesTouched_ = true/.test(toL));
  const presets = between(s2, /function initDatePresets_\(/, /\n  function /);
  assert.ok(/datesTouched_ = true/.test(presets), 'a preset chip is a user pick');
  const s3 = src('script-3-overview.html');
  const route = between(s3, /function ovRouteToDept_\(/, /\n  function /);
  assert.ok(/datesTouched_ = true/.test(route), 'the chart-point deep link is a user pick');
});

test('C1-9: a getLatestDataDates failure is SAID, not swallowed', function () {
  const s2 = src('script-2-chrome.html');
  const fail = between(s2, /withFailureHandler\(function \(err\) \{\s*\/\/ C1-9/, /\.getLatestDataDates\(\);/);
  assert.ok(/showToast\(/.test(fail), 'the user sees a toast');
  assert.ok(/reportClientIssue_\('load-failure'/.test(fail), 'the admin hears about it (R19 beacon)');
  assert.ok(/refresh\(\);/.test(fail), 'the range fallback is unchanged');
});

test('C1-4: entering/exiting view-as re-fetches the escalation badge so the strip re-scopes', function () {
  const s3 = src('script-3-overview.html');
  const va = between(s3, /function applyViewAs_\(/, /\n  function (?!applyViewAs_)/);
  assert.ok(/loadEscBadge_\(\)/.test(va));
});

test('C1-6: a dept switch hides the previous dept\'s Transfer detail with the other side panels', function () {
  const s5 = src('script-5-dept.html');
  const sw = between(s5, /if \(lastSummaryDept_ !== null && lastSummaryDept_ !== dept\) \{/, /\n    \}\n/);
  assert.ok(/dept-transfer-section/.test(sw) && /dept-missed-section/.test(sw) && /dept-qcd-snapshot/.test(sw),
    'the transfer section joins the QCD snapshot + missed section in the switch-time hide');
});

test('C1-5: the SWR pre-paint does NOT re-enable Refresh -- only the live paint does', function () {
  const s5 = src('script-5-dept.html');
  const onData = between(s5, /function onData\(data, opts\) \{/, /\n  function (?!onData)/);
  assert.ok(/if \(!\(opts && opts\.swr\)\) \$\('refresh-btn'\)\.disabled = false;/.test(onData));
  assert.ok(!/^\s*\$\('refresh-btn'\)\.disabled = false;/m.test(onData), 'no unconditional re-enable remains in onData');
  const onError = between(s5, /function onError\(err, hadSwrPaint\) \{/, /\n  function (?!onError)/);
  assert.ok(/\$\('refresh-btn'\)\.disabled = false;/.test(onError), 'a failure still re-enables it (no stuck-disabled dead end)');
});

test('C1-7 / C1-8: every tile render re-syncs the solo markers, and an empty dept list says so', function () {
  const s3 = src('script-3-overview.html');
  const tiles = between(s3, /function ovRenderTiles_\(/, /\n  function (?!ovRenderTiles_)/);
  assert.ok(/ovSyncTilePins_\(ovChartInstance\)/.test(tiles), 'pins re-applied inside the renderer itself, so every caller inherits it');
  assert.ok(/depts\.length \? html : ovEmptyStateHtml_\(\)/.test(tiles), 'the empty state replaces a blank grid');
  assert.ok(/function ovEmptyStateHtml_\(/.test(s3) && /role="status"/.test(between(s3, /function ovEmptyStateHtml_\(/, /\n  \}/)));
});

test('C1-10: the chart-point deep link sets the window BEFORE the selector change, and fetches once', function () {
  const s3 = src('script-3-overview.html');
  const route = between(s3, /function ovRouteToDept_\(/, /\n  function (?!ovRouteToDept_)/);
  const iDates = route.search(/\$\('from-date'\)\.value = isoDate;/);
  const iDispatch = route.search(/sel\.dispatchEvent\(new Event\('change'\)\)/);
  assert.ok(iDates >= 0 && iDispatch >= 0 && iDates < iDispatch, 'dates first, so the change handler\'s refresh() carries the clicked day');
  assert.ok(/\} else if \(datesSet\) \{\s*refresh\(\);/.test(route), 'a same-dept click refreshes exactly once; a dept switch relies on the change handler');
  assert.equal((route.match(/refresh\(\);/g) || []).length, 1, 'no second unconditional refresh() after the dispatch');
});

test('C2-3: the last-good store refuses an UNAVAILABLE Inbound payload and an errored Insights queue-health', function () {
  const s9 = src('script-9-inbound-direct.html');
  assert.ok(/if \(!\(data && data\.meta && data\.meta\.available === false\)\) \{\s*reportLastGoodWrite_\('inbound'/.test(s9));
  const s8 = src('script-8-insights.html');
  assert.ok(/if \(!\(data && data\.queueHealth && data\.queueHealth\.error\)\) \{\s*reportLastGoodWrite_\('ins'/.test(s8));
});

test('C2-6: the row-invoked mutation verbs carry an in-flight guard, released on BOTH handlers', function () {
  const s7 = src('script-7-admin.html');
  const s10 = src('script-10-escalations.html');
  assert.ok(/function mutationBusy_\(key\)/.test(s7) && /function mutationDone_\(key\)/.test(s7));
  [['script-7-admin.html', 'alCfgRemove_', 'alCfgRemove'],
   ['script-7-admin.html', 'alDgRemove_', 'alDgRemove'],
   ['script-7-admin.html', 'alQrRemove_', 'alQrRemove'],
   ['script-7-admin.html', 'acAgentRemove_', 'acRemove'],
   ['script-7-admin.html', 'acRemoveRow_', 'acRemove'],
   ['script-10-escalations.html', 'escSaveComment_', 'busyKey']].forEach(function (t) {
    const s = t[0] === 'script-7-admin.html' ? s7 : s10;
    const fn = between(s, new RegExp('function ' + t[1] + '\\('), /\n  function (?!$)/);
    const key = t[2] === 'busyKey' ? 'busyKey' : "'" + t[2] + "'";
    assert.ok(fn.indexOf('mutationBusy_(' + key + ')') >= 0, t[1] + ' guards dispatch');
    assert.equal((fn.match(/mutationDone_\(/g) || []).length, 2, t[1] + ' releases on success AND failure');
  });
});

test('C2-7: the four admin modal init failures render a Retry, not a dead "Error:" loader', function () {
  const s7 = src('script-7-admin.html');
  assert.ok(/function adminInitError_\(elId, err, retryFn\)/.test(s7));
  ['al-loading', 'of-loading', 'ac-loading', 'dc-loading'].forEach(function (id) {
    assert.ok(new RegExp("adminInitError_\\('" + id + "'").test(s7), id + ' routes through the helper');
    assert.ok(!new RegExp("\\$\\('" + id + "'\\)\\.textContent = 'Error").test(s7), id + ' no longer overwrites the loader text');
  });
  const helper = between(s7, /function adminInitError_\(/, /\n  \}\n/);
  assert.ok(/origHtml/.test(helper) && /retryFn\(\)/.test(helper), 'Retry restores the loader markup and re-runs the init');
  assert.ok(/escapeHtml\(msg\)/.test(helper), 'the server message is escaped before innerHTML');
});
