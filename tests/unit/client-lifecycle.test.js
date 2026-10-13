'use strict';

// Batch 3 of the 2026-10-12 broad scan: CLIENT LIFECYCLE -- request ordering,
// busy states and focus. Each finding was a page that stopped matching what
// the user asked for: an overnight tab clamping every window to yesterday's
// date, an agent panel painting another day under the highlighted box, a
// failed image copy leaving the Export menu dead, a save message naming the
// wrong department, a button stuck on "Updating…". IDs are prefixed B3/ to
// keep them apart from the 2026-10-01 scan's CL-n (client-correctness.test.js).
//
// The client is one assembled IIFE. Where a function lifts out cleanly it runs
// here in a small vm sandbox with a fake google.script.run that HOLDS each
// call's handlers, so a test can resolve responses out of order -- the race
// every one of these bugs needed. The rest are source pins naming the guard.
// The rendered-UI gate (`npm run ci:ui`) still boots the real page; the CL-14
// focus return is also asserted there (drive-agentpanel.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
function src(name) { return fs.readFileSync(path.join(DIR, name), 'utf8'); }

function extractFn(text, name) {
  const at = text.search(new RegExp('function ' + name + '\\('));
  assert.ok(at >= 0, 'function ' + name + ' not found');
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
  }
  throw new Error('unbalanced function ' + name);
}

// A google.script.run whose calls are QUEUED, not answered: each entry keeps
// the method, its argument and both handlers, so a test resolves them in any
// order (calls[i].ok(data) / calls[i].fail(err)).
function fakeRun() {
  const calls = [];
  let pending = {};
  const run = new Proxy({}, {
    get: function (_t, prop) {
      if (prop === 'withSuccessHandler') return function (fn) { pending.ok = fn; return run; };
      if (prop === 'withFailureHandler') return function (fn) { pending.fail = fn; return run; };
      return function (arg) {
        calls.push(Object.assign({ method: prop, arg: arg }, pending));
        pending = {};
      };
    },
  });
  return { calls: calls, google: { script: { run: run } } };
}

// A tiny element: enough DOM for the functions pinned here.
function el(id, opts) {
  const e = Object.assign({
    id: id, innerHTML: '', textContent: '', disabled: false, value: '',
    dataset: {}, style: { display: '' }, isConnected: true, focused: 0,
    attrs: {}, classes: {},
    setAttribute: function (k, v) { this.attrs[k] = String(v); },
    getAttribute: function (k) { return k in this.attrs ? this.attrs[k] : null; },
    focus: function () { this.focused++; },
    getClientRects: function () { return this.hidden ? [] : [1]; },
    classList: { toggle: function () {}, add: function () {}, remove: function () {} },
  }, opts || {});
  return e;
}

// ---------------------------------------------------------------------------
test('B3/CL-1: the latest data dates are re-read while visible, never moving the dates on screen', function () {
  const chrome = src('script-2-chrome.html');
  const f = fakeRun();
  const pills = [];
  const els = { 'from-date': el('from-date', { value: '2026-10-09' }), 'to-date': el('to-date', { value: '2026-10-09' }) };
  let now = 10 * 60 * 1000;
  const sb = {
    google: f.google, document: { hidden: false },
    Date: { now: function () { return now; } },
    $: function (id) { return els[id]; },
    setFreshnessPill_: function (d) { pills.push(d); },
    datesTouched_: false, latestDqeIso_: '2026-10-09', latestQcdIso_: '2026-10-09', dataCoverage_: null,
  };
  vm.runInNewContext(
    'var LATEST_DATES_REFRESH_MS = 5 * 60 * 1000; var latestDatesFetchedAt_ = 9 * 60 * 1000;'
    + ' var latestDatesInFlight_ = false; var latestDatesLast_ = null;'
    + extractFn(chrome, 'applyLatestDates_') + extractFn(chrome, 'refreshLatestDates_'), sb);

  sb.refreshLatestDates_(false);
  assert.equal(f.calls.length, 0, 'inside the 5-min window: no server call...');
  assert.equal(pills.length, 1, '...but the pill re-renders so "Nh ago" ages');

  sb.document.hidden = true; now += 10 * 60 * 1000;
  sb.refreshLatestDates_(false);
  assert.equal(f.calls.length, 0, 'a hidden tab pays nothing');

  sb.document.hidden = false;
  sb.refreshLatestDates_(false);
  assert.equal(f.calls.length, 1, 'visible and stale: one re-read');
  assert.equal(f.calls[0].method, 'getLatestDataDates');
  sb.refreshLatestDates_(false);
  assert.equal(f.calls.length, 1, 'one re-read in flight at a time');
  f.calls[0].ok({ dqe: '2026-10-12', qcd: '2026-10-12', latest: '2026-10-12', dqeEarliest: '2025-01-02' });
  assert.equal(sb.latestDqeIso_, '2026-10-12', 'the DQE clamp moves to the new latest date');
  assert.equal(sb.latestQcdIso_, '2026-10-12', 'so does the QCD clamp');
  assert.equal(sb.dataCoverage_.dqe, '2025-01-02');
  assert.equal(els['from-date'].value, '2026-10-09', 'a re-read never moves the dates the user is looking at');
  assert.equal(pills[pills.length - 1].latest, '2026-10-12', 'the pill shows the new date');

  // A failed re-read keeps the last good dates and backs off for a window.
  now += 10 * 60 * 1000;
  sb.refreshLatestDates_(false);
  f.calls[1].fail(new Error('quota'));
  assert.equal(sb.latestDqeIso_, '2026-10-12');
  sb.refreshLatestDates_(false);
  assert.equal(f.calls.length, 2, 'no retry storm after a failure');

  // The boot snap is the only path that writes the inputs.
  sb.applyLatestDates_({ dqe: '2026-10-13' }, true);
  assert.equal(els['from-date'].value, '2026-10-13', 'boot still snaps untouched dates');

  assert.match(chrome, /setInterval\(function \(\) \{ refreshLatestDates_\(false\); \}, LATEST_DATES_REFRESH_MS\);/);
  assert.match(chrome, /addEventListener\('visibilitychange', function \(\) \{\s*if \(!document\.hidden && latestDatesFetchedAt_\) refreshLatestDates_\(false\);/);
  assert.match(chrome, /latestDatesFetchedAt_ = Date\.now\(\);\s*applyLatestDates_\(dates, true\);\s*refresh\(\);/,
    'the boot fetch goes through the same apply step');
});

test('B3/CL-2: a cached day claims the sequence, so an older in-flight day cannot paint over it', function () {
  const s10 = src('script-10-escalations.html');
  const f = fakeRun();
  const painted = [];
  const sb = {
    google: f.google,
    AP_: { seq: 0, days: {}, node: null, agent: 'Ann', date: null, tab: 'in' },
    apRenderDay_: function (d) { painted.push(d.date); },
    apSetHtml_: function () {}, apLoadingHtml_: function () { return ''; },
    escapeHtml: String,
  };
  vm.runInNewContext(extractFn(s10, 'apSelectDay_'), sb);
  sb.AP_.days['2026-10-08'] = { date: '2026-10-08' };
  sb.apSelectDay_('2026-10-09');          // not cached: fetch in flight
  sb.apSelectDay_('2026-10-08');          // cached: instant render
  f.calls[0].ok({ date: '2026-10-09' });  // the older request lands late
  assert.deepEqual(painted, ['2026-10-08'], 'only the selected day is ever painted');
  assert.equal(sb.AP_.date, '2026-10-08');
});

test('B3/CL-3: a hidden tab parks the Overview auto-refresh and runs it on return', function () {
  const ov = src('script-3-overview.html');
  const timers = [];
  const listeners = {};
  let loads = 0;
  const sb = {
    document: {
      hidden: false,
      body: { getAttribute: function () { return 'overview'; } },
      addEventListener: function (ev, fn) { listeners[ev] = fn; },
    },
    setTimeout: function (fn) { timers.push(fn); return timers.length; },
    clearTimeout: function () {},
    ovLoad_: function (silent) { assert.equal(silent, true); loads++; },
    OV_AUTO_REFRESH_MS: 300000, ovAutoRefreshTimer_: null,
  };
  const block = ov.slice(ov.indexOf('  var ovAutoRefreshParked_ = false;'), ov.indexOf('  function ovRender_('));
  vm.runInNewContext(block, sb);
  sb.ovScheduleAutoRefresh_();
  sb.document.hidden = true;
  timers.shift()();
  assert.equal(loads, 0, 'no server call while hidden');
  sb.document.hidden = false;
  listeners.visibilitychange();
  assert.equal(loads, 1, 'the parked refresh runs when the tab is visible again');
  listeners.visibilitychange();
  assert.equal(loads, 1, 'once');
  sb.ovScheduleAutoRefresh_();
  timers.shift()();
  assert.equal(loads, 2, 'a visible tick refreshes as before');
});

test('B3/CL-4: a late no-ring prefetch for an older window neither replaces the cache nor reveals buttons', function () {
  const ins = src('script-8-insights.html');
  const f = fakeRun();
  const drill = el('wrap', { style: { display: 'none' } });
  const btn = el('b', { closest: function () { return drill; } });
  btn.attrs['data-qh-queue'] = 'A_Q_Sales';
  const tbody = {
    querySelector: function () { return btn; },
    querySelectorAll: function (sel) { return sel === '.ins-qh-missed' ? [btn] : [drill]; },
  };
  const sb = {
    google: f.google, uiFlagOn_: function () { return false; },
    $: function (id) { return id === 'ins-qh-tbody' ? tbody : null; },
    insLastData: { meta: { department: 'Sales', from: '2026-10-01', to: '2026-10-07' } },
  };
  vm.runInNewContext('let insQhNoRingCache_ = null;' + extractFn(ins, 'insQhMissedSig_')
    + extractFn(ins, 'insQhNoRingGate_') + ';this.cache = function () { return insQhNoRingCache_; };', sb);

  sb.insQhNoRingGate_();                                       // window 1 in flight
  sb.insLastData = { meta: { department: 'Sales', from: '2026-10-08', to: '2026-10-09' } };
  sb.insQhNoRingGate_();                                       // window 2 in flight
  f.calls[1].ok({ entries: [], meta: {} });                    // window 2: zero no-ring -> hidden
  assert.equal(drill.style.display, 'none');
  f.calls[0].fail(new Error('late'));                          // window 1's late failure
  assert.equal(drill.style.display, 'none', 'a stale failure must not reveal a button the current window hid');
  f.calls[0].ok({ entries: [{ source: 'queue', who: 'A_Q_Sales' }], meta: {} });
  assert.equal(sb.cache().sig, 'Sales|2026-10-08|2026-10-09', 'a stale success must not replace the current cache');
  assert.equal(drill.style.display, 'none');
});

test('B3/CL-9: a failed image capture gives the dept Export button back and clears the Insights busy flag', function () {
  const core = src('script-1-core.html');
  const btns = {
    'dept-export-btn': el('dept-export-btn', { disabled: true, innerHTML: 'Capturing…', dataset: { label: 'Export ▾' } }),
    'ir-export-btn': el('ir-export-btn'),
  };
  const toasts = [];
  const sb = {
    console: { error: function () {} },
    showToast: function (m) { toasts.push(m); },
    document: { getElementById: function (id) { return btns[id] || null; } },
    insExportBusy_: true,
  };
  vm.runInNewContext(extractFn(core, 'exportCaptureFailed_'), sb);
  sb.exportCaptureFailed_(new Error('boom'));
  assert.equal(btns['dept-export-btn'].disabled, false);
  assert.equal(btns['dept-export-btn'].innerHTML, 'Export ▾', 'the menu trigger reads its own label again');
  assert.equal(sb.insExportBusy_, false, 'the Export menu accepts the next action (CSV / TSV included)');
  assert.equal(toasts.length, 1);
  // The fragment-alone case (IR's own suite loads core without Insights).
  const sb2 = { console: sb.console, showToast: function () {}, document: sb.document };
  vm.runInNewContext(extractFn(core, 'exportCaptureFailed_'), sb2);
  assert.doesNotThrow(function () { sb2.exportCaptureFailed_(new Error('x')); });
  assert.match(src('script-8-insights.html'),
    /if \(!root\) \{ exportCaptureFailed_\(new Error\('No Insights results on screen to capture\.'\)\); return; \}/,
    'the no-results early return releases the button too');
});

test('B3/CL-10: closing or opening the Individual Report invalidates an in-flight run', function () {
  const ir = src('script-6-ir.html');
  const init = extractFn(ir, 'initIndividualReport');
  const open = extractFn(init, 'openModal');
  const close = extractFn(init, 'closeModal');
  assert.match(open, /reportReqSeq_\.ir\+\+;/, 'open claims the token before anything renders');
  assert.match(close, /reportReqSeq_\.ir\+\+;\s*irPendingAutoRun_ = false;/,
    'close cancels the run and a drill\'s pending auto-run');
  // releaseIfSuperseded still hands Generate back after a close (CL-7's rule).
  assert.match(extractFn(ir, 'runIrReport'), /if \(__rtok === irGenerateTok_\) \{ btn\.disabled = false; btn\.textContent = originalLabel; \}/);
});

test('B3/CL-11: a subscriber save or remove re-reads only the subscriber lists', function () {
  const s7 = src('script-7-admin.html');
  const save = extractFn(s7, 'alRsSave_');
  const rm = extractFn(s7, 'alDgRemove_');
  assert.ok(!/alLoadInit_\(\)/.test(save), 'alRsSave_ never re-runs the whole modal init');
  assert.ok(!/alLoadInit_\(\)/.test(rm), 'alDgRemove_ never re-runs the whole modal init');
  assert.equal((save.match(/alReloadSubscribers_\(\);/g) || []).length, 2, 'full and partial save both reload the lists');
  assert.match(rm, /alReloadSubscribers_\(\);/);
  const reload = extractFn(s7, 'alReloadSubscribers_');
  assert.match(reload, /\.getDigestsInit\(\);/);
  assert.match(reload, /alQrReload_\(\);/);
  assert.ok(!/getAlertsInit|al-body|al-loading/.test(reload), 'no spinner over the modal, no config re-render');
});

test('B3/CL-12: a Dept Config save names the dept it SENT, and locks the edit controls until it lands', function () {
  const s7 = src('script-7-admin.html');
  const f = fakeRun();
  const status = [];
  const toasts = [];
  const els = {};
  ['dc-edit-qcd', 'dc-edit-parent', 'dc-edit-excludes', 'dc-edit-qext', 'dc-edit-notes',
   'dc-edit-inbound-aliases', 'dc-edit-final-dept-labels', 'dc-edit-dept-name', 'dc-edit-section',
   'dc-save-btn', 'dc-cancel-btn', 'dc-deactivate-btn'].forEach(function (id) { els[id] = el(id); });
  const rowEdit = el('row-edit');
  let reloads = 0;
  const sb = {
    google: f.google, $: function (id) { return els[id] || null; },
    document: { querySelectorAll: function () { return [rowEdit]; } },
    dcSetStatus_: function (k, m) { status.push(m); },
    showToast: function (m) { toasts.push(m); },
    dcLoadInit_: function () { reloads++; },
    window: { confirm: function () { return true; } },
  };
  vm.runInNewContext('let dcEditDept = null; let dcBusy_ = false;'
    + extractFn(s7, 'dcSetBusy_') + extractFn(s7, 'dcOpenEdit_') + extractFn(s7, 'dcCloseEdit_')
    + extractFn(s7, 'dcSave_') + extractFn(s7, 'dcDeactivate_')
    + ';this.editing = function () { return dcEditDept; };', sb);

  sb.dcOpenEdit_({ dept: 'Sales', hasRow: true });
  sb.dcSave_();
  assert.equal(f.calls[0].method, 'saveDeptConfig');
  assert.equal(f.calls[0].arg.dept, 'Sales');
  assert.ok(els['dc-cancel-btn'].disabled && els['dc-deactivate-btn'].disabled && rowEdit.disabled,
    'Cancel, Deactivate and the row Edit buttons are locked mid-save');
  sb.dcOpenEdit_({ dept: 'CSR', hasRow: false });     // a click that slipped through
  sb.dcCloseEdit_();
  assert.equal(sb.editing(), 'Sales', 'the form being saved cannot be swapped or closed mid-save');
  f.calls[0].ok({ warnings: [] });
  assert.match(status[status.length - 1], /^Saved Sales\./);
  assert.equal(toasts[toasts.length - 1], 'Saved config for Sales');
  assert.ok(!els['dc-cancel-btn'].disabled && !rowEdit.disabled, 'unlocked once the save lands');
  assert.equal(reloads, 1);

  // Deactivate names the dept it sent, too.
  sb.dcOpenEdit_({ dept: 'Power', hasRow: true });
  sb.dcDeactivate_();
  assert.equal(f.calls[1].arg.dept, 'Power');
  assert.ok(els['dc-cancel-btn'].disabled, 'locked while deactivating');
  f.calls[1].ok({ removed: 1 });
  assert.equal(toasts[toasts.length - 1], 'Reverted Power to defaults');
  assert.ok(!els['dc-cancel-btn'].disabled);
});

test('B3/CL-13: overlapping Queue report runs leave the Update button on its real label', function () {
  const s11 = src('script-11-qcd-boot.html');
  const f = fakeRun();
  const gen = el('qcd-alldept-refresh-btn', { innerHTML: 'Update' });
  const els = {
    'qcd-alldept-refresh-btn': gen,
    'qcd-alldept-from': el('f', { value: '2026-10-01' }),
    'qcd-alldept-to': el('t', { value: '2026-10-02' }),
    'qcd-alldept-form-error': el('e'),
  };
  const sb = {
    google: f.google, $: function (id) { return els[id]; },
    clampInputsToLatest_: function () { return ''; }, latestQcdIso_: '2026-10-12',
    DS_EQ_HTML_: '<eq>', Date: Date, console: { info: function () {} },
    qcdAllDeptReqSeq_: 0, qcdAllDeptLast: null, qcdAllDeptRender_: function () {},
  };
  vm.runInNewContext(extractFn(s11, 'runQcdAllDept_'), sb);
  sb.runQcdAllDept_();
  sb.runQcdAllDept_();                      // a preset change re-runs mid-flight
  assert.equal(gen.innerHTML, '<eq>Updating…');
  f.calls[0].ok({ meta: {} });              // superseded: leaves the button alone (newest wins)
  assert.equal(gen.disabled, true, 'the newer run still owns the button');
  f.calls[1].ok({ meta: {} });
  assert.equal(gen.innerHTML, 'Update', 'the real label comes back, not the spinner');
  assert.equal(gen.disabled, false);

  const ins = extractFn(src('script-8-insights.html'), 'runInsReport');
  assert.match(ins, /if \(!gen\.dataset\.idleLabel\) gen\.dataset\.idleLabel = gen\.textContent;\s*const prev = gen\.dataset\.idleLabel;/,
    'Insights Generate stashes its idle label once, the same way');
});

test('B3/CL-14: closing the Individual Report returns focus to a SHOWN element -- the opener, the launcher, then the title', function () {
  const ir = src('script-6-ir.html');
  const title = el('page-title');
  const sb = { $: function (id) { return id === 'page-title' ? title : null; }, irReturnFocusEl_: null };
  vm.runInNewContext(extractFn(ir, 'irFocusShown_') + extractFn(ir, 'irFocusAfterClose_'), sb);

  const opener = el('ap-ir');
  const hiddenLauncher = el('individual-report-btn', { hidden: true });
  sb.irReturnFocusEl_ = opener;
  sb.irFocusAfterClose_(hiddenLauncher);
  assert.equal(opener.focused, 1, 'the agent panel\'s button gets focus back');

  opener.isConnected = false;               // the panel re-rendered away
  sb.irFocusAfterClose_(hiddenLauncher);
  assert.equal(hiddenLauncher.focused, 0, 'a hidden launcher (a manager) is never focused');
  assert.equal(title.focused, 1, 'the page title is the last resort');

  const shownLauncher = el('individual-report-btn');
  sb.irReturnFocusEl_ = null;
  sb.irFocusAfterClose_(shownLauncher);
  assert.equal(shownLauncher.focused, 1, 'a direct open (an admin) returns to the launcher as before');

  const drill = extractFn(ir, 'irDrillToAgent_');
  assert.match(drill, /irReturnFocusEl_ = \(opts && opts\.returnFocus\)\s*\|\| \(__ae && __ae !== document\.body \? __ae : null\);/,
    'the opener is the caller\'s element, else the focused one -- never <body>');
  assert.match(src('script-10-escalations.html'),
    /irDrillToAgent_\(AP_\.agent, AP_\.from, AP_\.to, \{ returnFocus: t\.closest\('\[data-ap-ir\]'\) \}\);/,
    'the agent panel passes its button explicitly');
});

test('B3/CL-15: the Health UI toggles keep unsaved ticks, ignore stale loads and show a load failure', function () {
  const s9 = src('script-9-inbound-direct.html');
  const f = fakeRun();
  const list = el('health-uiflags-list', { querySelector: function () { return this.innerHTML ? {} : null; } });
  const section = el('health-uiflags-section', { style: { display: 'none' } });
  const st = el('health-uiflags-status');
  const save = el('health-uiflags-save');
  const els = { 'health-uiflags-list': list, 'health-uiflags-section': section,
                'health-uiflags-status': st, 'health-uiflags-save': save };
  const sb = { google: f.google, $: function (id) { return els[id]; }, escapeHtml: String };
  vm.runInNewContext('var healthUiFlagsSeq_ = 0; var healthUiFlagsDirty_ = false;'
    + extractFn(s9, 'healthLoadUiFlags_') + ';this.dirty = function (v) { healthUiFlagsDirty_ = v; };', sb);

  const reg = { registry: { 'ins-queue-health': 'Queue health' }, flags: [] };
  sb.healthLoadUiFlags_();
  sb.healthLoadUiFlags_();
  f.calls[1].ok(reg);
  const rendered = list.innerHTML;
  assert.match(rendered, /data-flag="ins-queue-health"/);
  f.calls[0].ok({ registry: { other: 'Other' }, flags: [] });
  assert.equal(list.innerHTML, rendered, 'a stale response cannot repaint the list');

  sb.dirty(true);                            // the admin ticked a box, then hit Refresh
  list.innerHTML = rendered + '<!--ticked-->';
  sb.healthLoadUiFlags_();
  f.calls[2].ok(reg);
  assert.match(list.innerHTML, /ticked/, 'unsaved ticks survive the reload');
  assert.match(st.textContent, /Unsaved changes kept/);

  sb.dirty(false);
  sb.healthLoadUiFlags_();
  f.calls[3].fail(new Error('Neon down'));
  assert.equal(section.style.display, '', 'a failed load no longer hides the section');
  assert.match(list.innerHTML, /Couldn’t load the UI toggles: Neon down/);
  assert.equal(save.disabled, true, 'nothing to save when nothing loaded');

  assert.match(s9, /healthUiFlagsDirty_ = false;   \/\/ B3\/CL-15: the list now matches the server/,
    'a successful save clears the dirty flag');
  assert.match(s9, /uiList\.addEventListener\('change'/, 'a tick marks the list dirty');
});
