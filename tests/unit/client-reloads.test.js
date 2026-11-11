'use strict';

// Batch 8 of the 2026-11-09 broad scan (cycle 260): CLIENT CORRECTNESS, the
// CCX family. Each finding was the page asking for the wrong thing, asking
// twice, or keeping an answer it should have dropped:
//   CCX-1 every escalation reload wiped what was being typed on every card;
//   CCX-2 a deep link loaded the dept page two or three times over;
//   CCX-3 Refresh left five newer sections on their pre-Refresh answer;
//   CCX-4 the day quick view kept a partly-failed day, with no Retry;
//   CCX-5 four small feedback gaps (a blank card, a reasonless error, a
//         double-send, a dead-end error);
//   CCX-6 a failed Callbacks load was held for the whole window;
//   CCX-7 the Health page hid its backup section when the probe failed;
//   CCX-8 a link with mangled dates stranded Insights on its form, and inert
//         group rows showed a pointer.
//
// The client is one assembled IIFE. A function that lifts out cleanly runs
// here in a small vm with a queued fake google.script.run (the
// client-lifecycle.test.js pattern); the rest are source pins naming the
// guard. The rendered-UI gate asserts CCX-1 (drive-admin.js) and CCX-2 / CCX-8
// (drive-smoke.js, both role shards) at the real page.

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
const plain = function (x) { return JSON.parse(JSON.stringify(x)); };

// ── CCX-1: escalation drafts across a reload ─────────────────────────────────

// A list of cards whose textareas answer the two selector shapes the draft
// helpers use. `render(ids)` rebuilds every field EMPTY, as escRenderList_ does.
function escDom() {
  let fields = [];
  const FIELDS = ['esc-resolve-text', 'esc-comments-text', 'esc-reopen-text', 'esc-reject-text', 'esc-move-note', 'esc-link-note'];
  const list = {
    querySelectorAll: function (sel) {
      const cls = sel.replace(/^textarea\./, '');
      return fields.filter(function (f) { return f.cls === cls; });
    },
    querySelector: function (sel) {
      const m = /^textarea\.([\w-]+)\[data-id="([^"]*)"\]$/.exec(sel);
      if (!m) return null;
      return fields.filter(function (f) { return f.cls === m[1] && f.id === m[2]; })[0] || null;
    },
  };
  function render(ids) {
    fields = [];
    ids.forEach(function (id) {
      const details = { tagName: 'DETAILS', open: false, style: {}, className: 'esc-resolve-disc', parentNode: list };
      const panel = { tagName: 'DIV', style: { display: 'none' }, className: 'esc-reject', parentNode: list };
      FIELDS.forEach(function (cls) {
        const f = { cls: cls, id: id, value: '', inputs: 0,
          parentNode: cls === 'esc-reject-text' ? panel : details,
          getAttribute: function () { return id; },
          dispatchEvent: function () { f.inputs++; } };
        fields.push(f);
      });
    });
  }
  function field(cls, id) { return list.querySelector('textarea.' + cls + '[data-id="' + id + '"]'); }
  return { list: list, render: render, field: field };
}
function escSandbox() {
  const esc = src('script-10-escalations.html');
  const dom = escDom();
  const ctx = vm.createContext({
    $: function (id) { return id === 'esc-list' ? dom.list : null; },
    document: { querySelector: function (sel) { return dom.list.querySelector(sel); } },
    escCssId_: function (v) { return String(v); },
    Event: function (type) { this.type = type; },
  });
  const fields = /var ESC_DRAFT_FIELDS_ = \[[^\]]*\];/.exec(esc);
  assert.ok(fields, 'ESC_DRAFT_FIELDS_ not found');
  vm.runInContext(fields[0] + '\nvar escDrafts_ = {};\n'
    + extractFn(esc, 'escDraftsCapture_') + '\n' + extractFn(esc, 'escDraftsRestore_') + '\n'
    + extractFn(esc, 'escDraftsConsumed_'), ctx);
  return { ctx: ctx, dom: dom };
}

test('CCX-1: text typed on any card comes back after the reload, shown and with its Save re-armed', function () {
  const { ctx, dom } = escSandbox();
  dom.render(['7', '9']);
  dom.field('esc-resolve-text', '7').value = 'half a resolution';
  dom.field('esc-reject-text', '9').value = 'why I am rejecting';
  ctx.escDraftsCapture_();
  dom.render(['7', '9']);                       // the re-render: every field empty
  ctx.escDraftsRestore_();
  const res = dom.field('esc-resolve-text', '7'), rej = dom.field('esc-reject-text', '9');
  assert.equal(res.value, 'half a resolution');
  assert.equal(res.parentNode.open, true, 'the folded form it sits in is opened');
  assert.equal(res.inputs, 1, 'an input event re-enables its Save through the list handler');
  assert.equal(rej.value, 'why I am rejecting');
  assert.equal(rej.parentNode.style.display, '', 'the toggled panel is shown again');
  assert.equal(dom.field('esc-comments-text', '7').value, '', 'nothing is invented for an empty field');
  // Restored once: a later reload with nothing typed carries nothing.
  dom.render(['7', '9']);
  ctx.escDraftsCapture_();
  ctx.escDraftsRestore_();
  assert.equal(dom.field('esc-resolve-text', '7').value, '');
});

test('CCX-1: the field an action just SAVED is not carried; the rest of that card is', function () {
  const { ctx, dom } = escSandbox();
  dom.render(['7']);
  dom.field('esc-resolve-text', '7').value = 'half a resolution';
  dom.field('esc-comments-text', '7').value = 'saved as a comment';
  ctx.escDraftsConsumed_('7', ['esc-comments-text']);   // "Save comment only" succeeded
  ctx.escDraftsCapture_();
  dom.render(['7']);
  ctx.escDraftsRestore_();
  assert.equal(dom.field('esc-comments-text', '7').value, '');
  assert.equal(dom.field('esc-resolve-text', '7').value, 'half a resolution');
});

test('CCX-1: a superseded load keeps the drafts; a card that left the list takes its drafts with it', function () {
  const { ctx, dom } = escSandbox();
  dom.render(['7', '9']);
  dom.field('esc-resolve-text', '7').value = 'kept';
  dom.field('esc-resolve-text', '9').value = 'card 9 resolves away';
  ctx.escDraftsCapture_();          // load 1 empties the list...
  dom.render([]);
  ctx.escDraftsCapture_();          // ...load 2 starts before load 1 answered: nothing on screen to capture
  dom.render(['7']);                // only load 2 renders; card 9 is gone from this filter
  ctx.escDraftsRestore_();
  assert.equal(dom.field('esc-resolve-text', '7').value, 'kept');
  dom.render(['7', '9']);
  ctx.escDraftsCapture_();
  dom.field('esc-resolve-text', '7').value = '';
  ctx.escDraftsRestore_();
  assert.equal(dom.field('esc-resolve-text', '9').value, '', 'a draft is not held for a card that left');
});

test('CCX-1: the load captures before it empties the list, and each saving action names what it saved', function () {
  const esc = src('script-10-escalations.html');
  const load = extractFn(esc, 'escLoad_');
  const capAt = load.indexOf('escDraftsCapture_();');
  assert.ok(capAt !== -1 && capAt < load.indexOf("listEl.innerHTML = ''"), 'capture precedes the wipe');
  assert.match(load, /escRenderList_\(resp \|\| \{\}\);\s*\n\s*escDraftsRestore_\(\);/);
  const saved = {
    escSaveComment_: "['esc-comments-text']",
    escResolve_: "['esc-resolve-text', 'esc-comments-text']",
    escReopen_: "['esc-reopen-text']",
    escReject_: "['esc-reject-text']",
    escMove_: "['esc-move-note']",
    escLinkDept_: "['esc-link-note']",
  };
  Object.keys(saved).forEach(function (fn) {
    assert.ok(extractFn(esc, fn).indexOf('escDraftsConsumed_(id, ' + saved[fn] + '); escLoad_();') !== -1,
      fn + ' blanks the fields it saved before reloading');
  });
});

// ── CCX-2: deep links wait for the latest-date read ──────────────────────────

function settleSandbox() {
  const chrome = src('script-2-chrome.html');
  const timers = [];
  const state = { refreshes: 0, loading: false, issues: [] };
  const ctx = vm.createContext({
    $: function (id) { return id === 'refresh-btn' ? { disabled: state.loading } : null; },
    refresh: function () { state.refreshes++; },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); },
    reportClientIssue_: function (k, m) { state.issues.push(m); },
  });
  vm.runInContext('var DEEP_LINK_DATES_WAIT_MS_ = 10000; var latestDatesSettled_ = false; var latestDatesWaiters_ = [];\n'
    + extractFn(chrome, 'whenLatestDatesSettled_') + '\n' + extractFn(chrome, 'latestDatesSettle_') + '\n'
    + extractFn(chrome, 'bootRefreshAfterDates_'), ctx);
  return { ctx: ctx, timers: timers, state: state };
}

test('CCX-2: a waiting deep link runs once the dates settle, and the boot does not load the page a second time', function () {
  const { ctx, timers, state } = settleSandbox();
  let ran = 0;
  ctx.whenLatestDatesSettled_(function () { ran++; state.loading = true; });   // the link's own load goes out
  assert.equal(ran, 0, 'held until the latest-date read answers');
  ctx.bootRefreshAfterDates_();
  assert.equal(ran, 1);
  assert.equal(state.refreshes, 0, 'the link is loading the page: the boot refresh would be the duplicate');
  timers.forEach(function (t) { t.fn(); });
  assert.equal(ran, 1, 'the fallback timer cannot run it again');
});

test('CCX-2: with no deep link the boot loads as before; a link that sent nothing does not cost the boot load', function () {
  let s = settleSandbox();
  s.ctx.bootRefreshAfterDates_();
  assert.equal(s.state.refreshes, 1);
  // After the read settled, a late link dispatches at once.
  let ran = 0;
  s.ctx.whenLatestDatesSettled_(function () { ran++; });
  assert.equal(ran, 1);

  s = settleSandbox();
  s.ctx.whenLatestDatesSettled_(function () { /* an admin-only route for a manager: nothing loads */ });
  s.ctx.bootRefreshAfterDates_();
  assert.equal(s.state.refreshes, 1, 'no load in flight -> the boot still loads the table');
});

test('CCX-2: a latest-date read that never answers stops holding the link after the wait', function () {
  const { ctx, timers, state } = settleSandbox();
  let ran = 0;
  ctx.whenLatestDatesSettled_(function () { ran++; });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10000);
  timers[0].fn();
  assert.equal(ran, 1, 'dispatched on the provisional window, as it always used to be');
  ctx.bootRefreshAfterDates_();           // the read finally lands
  assert.equal(ran, 1);
  assert.equal(state.refreshes, 1, 'and then the boot refresh runs, as before the fix');
});

test('CCX-2: only links that land on the dept page wait; they are primed before the swap and checked after', function () {
  const nav = src('script-4-nav.html');
  assert.match(nav, /if \(landing && landing\.kind === 'page' && \(landing\.page === 'dept' \|\| landing\.page === 'insights'\)\) \{\s*whenLatestDatesSettled_\(function \(\) \{/);
  assert.match(nav, /\} else \{\s*dispatch\(\);\s*\}/, 'a modal or the Escalations page opens at once');
  const waited = nav.slice(nav.indexOf('whenLatestDatesSettled_(function () {'));
  assert.match(waited.slice(0, 500), /if \(currentRoute !== '\/overview' \|\| document\.body\.getAttribute\('data-page'\) !== 'overview'\) return;/,
    'a user who navigated while the dates were being read is not pulled back to the link');
  const prime = waited.indexOf('shareApplyDeptParam_(params.dept);');
  const carry = waited.indexOf("if (landing.page === 'insights') insCarryLinkWindowToDept_(params);");
  const go = waited.indexOf('dispatch();');
  assert.ok(prime !== -1 && carry !== -1 && prime < go && carry < go, 'dept and window are set BEFORE the page swap loads');
  assert.match(waited.slice(go, go + 700), /summaryReqKey_ !== summaryViewKey_\(\)\) refresh\(\);/,
    'a load in flight for another view is superseded');
  // The page-route path no longer refreshes on top of setPage's own load.
  assert.match(nav, /if \(def\.page === 'dept' && typeof refresh === 'function' && !\(rbtn && rbtn\.disabled\)\) refresh\(\);/);
  // refresh() records what its newest request is for.
  assert.match(src('script-5-dept.html'), /var myToken = \+\+summaryReqSeq;\s*\n\s*summaryReqKey_ = summaryViewKey_\(\);/);
});

test('CCX-2: the Insights roster is asked for once per (dept, window) while that request is out', function () {
  const ins = src('script-8-insights.html');
  const fr = fakeRun();
  const els = {
    'ins-from': { value: '2026-10-08' }, 'ins-to': { value: '2026-11-06' },
    'ins-agent-loader': { style: {}, textContent: '', innerHTML: '' },
    'ins-agent-list': { style: {} }, 'ins-generate-btn': { disabled: false }, 'ins-brief': {},
  };
  let rendered = 0;
  const ctx = vm.createContext({
    google: fr.google,
    $: function (id) { return els[id] || null; },
    getRequestedDept: function () { return 'CSR'; },
    rosterLoaderShowLoading_: function () {},
    insRenderAgentList: function () { rendered++; },
    dsFrostHide_: function () {}, insShowForm: function () {}, escapeHtml: String,
  });
  vm.runInContext("var insLastRoster = { dept: null, agents: [], rangeKey: '' }; var insRosterReqSeq_ = 0; var insRosterInFlight_ = null;"
    + ' var insLauncherAutoRun_ = false, insAutoRunPending_ = false, insScrollPending_ = null;\n'
    + extractFn(ins, 'insEnsureRoster'), ctx);
  ctx.insEnsureRoster();
  ctx.insEnsureRoster();     // refresh()'s window sync
  ctx.insEnsureRoster();     // the region open
  assert.equal(fr.calls.length, 1, 'page entry, the window sync and the region open share one request');
  // A different window is a different request.
  els['ins-from'].value = '2026-11-01';
  ctx.insEnsureRoster();
  assert.equal(fr.calls.length, 2);
  // The superseded reply is dropped; the newest renders and frees the key.
  fr.calls[0].ok({ agents: ['A'] });
  assert.equal(rendered, 0);
  fr.calls[1].ok({ agents: ['A'] });
  assert.equal(rendered, 1);
  ctx.insEnsureRoster();
  assert.equal(fr.calls.length, 2, 'now held: rendered from the roster, no request');
  // A failure frees the key too, so Retry (and the next sync) can ask again.
  els['ins-from'].value = '2026-11-02';
  ctx.document = { };
  ctx.insEnsureRoster();
  fr.calls[2].fail(new Error('down'));
  ctx.insEnsureRoster();
  assert.equal(fr.calls.length, 4);
});

// ── CCX-3: Refresh clears every section store ────────────────────────────────

test('CCX-3: Refresh drops the five newer section stores along with the four it already dropped', function () {
  const dept = src('script-5-dept.html');
  const mk = function (init) {
    const ctx = vm.createContext({});
    vm.runInContext(init + '\n'
      + extractFn(src('script-10-escalations.html'), 'apPreStoreClear_') + '\n'
      + extractFn(dept, 'refreshClearSectionStores_'), ctx);
    ctx.refreshClearSectionStores_();
    return function (expr) { return plain(vm.runInContext(expr, ctx)); };
  };
  // Every section HOLDS an answer for the window on screen.
  let get = mk("var TDC_ = { key: 'CSR|a|b', data: {}, loading: false }; var INS_OB_ = { key: 'k', cur: {} };"
    + " var INS_CB_ = { key: 'k', data: {}, error: null };"
    + " var OB_DL_VIEWS_ = { 'ins-dl': { key: 'k', data: {}, inFlight: false }, 'ov-dl': { key: 'ov', data: {} } };"
    + " var AP_PRE_ = { held: { done: true }, out: { done: false } }, AP_PRE_ORDER_ = ['held', 'out'];");
  assert.equal(get('TDC_.key'), null, 'Team Direct Calls + the Direct view');
  assert.equal(get('INS_OB_.key'), null, 'the Outbound summary section');
  assert.equal(get('INS_CB_.key'), null, 'Callbacks');
  assert.equal(get("OB_DL_VIEWS_['ins-dl'].key"), null, 'Direct lines');
  assert.equal(get("OB_DL_VIEWS_['ov-dl'].key"), 'ov', 'the Overview block has its own window and is not this page\'s');
  assert.deepEqual(get('[Object.keys(AP_PRE_), AP_PRE_ORDER_]'), [['out'], ['out']],
    'the agent panel\'s held strips and days go; a request still out stays to be joined');
  // A held ERROR is dropped too (Refresh is a way to retry).
  get = mk("var TDC_ = { key: 'k', data: null, error: 'x', loading: false }; var INS_OB_ = { key: null, cur: null };"
    + " var INS_CB_ = { key: 'k', data: null, error: 'Neon down' }; var OB_DL_VIEWS_ = {}; var AP_PRE_ = {}, AP_PRE_ORDER_ = [];");
  assert.equal(get('TDC_.key'), null);
  assert.equal(get('INS_CB_.key'), null);
  // A request already OUT for this window is left alone: its answer is as
  // fresh as a new one, and dropping the key sent the same request twice.
  get = mk("var TDC_ = { key: 'k', data: null, loading: true }; var INS_OB_ = { key: 'k', cur: null };"
    + " var INS_CB_ = { key: 'k', data: null, error: null, loadingKey: 'k' };"
    + " var OB_DL_VIEWS_ = { 'ins-dl': { key: 'k', data: null, inFlight: true } }; var AP_PRE_ = {}, AP_PRE_ORDER_ = [];");
  assert.deepEqual(get("[TDC_.key, INS_OB_.key, INS_CB_.key, OB_DL_VIEWS_['ins-dl'].key]"), ['k', 'k', 'k', 'k']);
  // The four older clears stay in refresh(); the five newer ones run from the
  // Refresh BUTTON, before its refresh() -- a debounced date-edit refresh for
  // the same window must not throw away what the first load just fetched
  // (drive-deptoutbound.js's "ONE request for this window" check).
  const refresh = extractFn(dept, 'refresh');
  ['trpFetched_ = {};', 'OB_VIEW_.key = null;', 'obSummaryStoreClear_();', 'dqvStoreClear_();']
    .forEach(function (line) { assert.ok(refresh.indexOf(line) !== -1, 'refresh() runs ' + line); });
  assert.equal(refresh.indexOf('refreshClearSectionStores_'), -1, 'not on every refresh()');
  assert.match(src('script-2-chrome.html'),
    /\$\('refresh-btn'\)\.addEventListener\('click', function \(\) \{[\s\S]{0,200}refreshClearSectionStores_\(\);\s*\n\s*refresh\(\);/);
});

test('CCX-3: every (dept, window) section store on My Department is on the Refresh list', function () {
  // The tripwire: a NEW module-level `{ key: null, ... }` store in the dept /
  // Insights fragments must be cleared by refresh() or be listed here with why not.
  const NOT_CLEARED = {
    // none today
  };
  const refresh = extractFn(src('script-5-dept.html'), 'refresh') + extractFn(src('script-5-dept.html'), 'refreshClearSectionStores_');
  ['script-5-dept.html', 'script-8-insights.html'].forEach(function (file) {
    const re = /^ {2}var ([A-Z][A-Z_]*_) = \{ key: null/gm;
    let m;
    const text = src(file);
    while ((m = re.exec(text)) !== null) {
      if (NOT_CLEARED[m[1]]) continue;
      assert.ok(new RegExp(m[1].replace(/[$]/g, '\\$') + "\\.key = null").test(refresh),
        file + ': the store ' + m[1] + ' is keyed by (dept, window) but Refresh does not drop it');
    }
  });
});

// ── CCX-4: the day quick view ────────────────────────────────────────────────

function dqvSandbox() {
  const dept = src('script-5-dept.html');
  const fr = fakeRun();
  const ctx = vm.createContext({
    google: fr.google,
    setTimeout: function (fn) { fn(); },
    excIncludeOn_: function () { return false; },
  });
  vm.runInContext("var DQV_ = { dept: 'CSR' }; var DQV_STORE_ = {}; var DQV_STORE_ORDER_ = []; var DQV_STORE_MAX_ = 18;\n"
    + extractFn(dept, 'dqvInc_') + '\n' + extractFn(dept, 'dqvKey_') + '\n'
    + extractFn(dept, 'dqvDayHasError_') + '\n' + extractFn(dept, 'dqvFetchDays_'), ctx);
  return { ctx: ctx, fr: fr };
}

test('CCX-4: a day with a failed part is shown once and NOT kept, so coming back to it asks again', function () {
  const { ctx, fr } = dqvSandbox();
  const day = { from: '2026-11-05' };
  const got = [];
  ctx.dqvFetchDays_([day], false, false, function (d) { got.push(d); }, function () {});
  fr.calls[0].ok({ days: { '2026-11-05': { summary: { rows: [] }, missed: null, errors: { missed: 'Neon timed out' } } } });
  assert.equal(got.length, 1, 'the partly-failed day is still served to the open pop-up');
  assert.equal(plain(got[0]).errors.missed, 'Neon timed out');
  ctx.dqvFetchDays_([day], false, false, function (d) { got.push(d); }, function () {});
  assert.equal(fr.calls.length, 2, 'not held as done: the second look sends a new request');
  // A whole day lands and IS kept.
  fr.calls[1].ok({ days: { '2026-11-05': { summary: { rows: [] }, missed: { agents: [] }, errors: {} } } });
  ctx.dqvFetchDays_([day], false, false, function (d) { got.push(d); }, function () {});
  assert.equal(fr.calls.length, 2, 'a complete day is served from the store');
  assert.equal(got.length, 3);
  // A day the reply left out entirely counts as failed too.
  const other = { from: '2026-11-06' };
  ctx.dqvFetchDays_([other], false, false, function () {}, function () {});
  fr.calls[2].ok({ days: {} });
  ctx.dqvFetchDays_([other], false, false, function () {}, function () {});
  assert.equal(fr.calls.length, 4);
});

test('CCX-4: the error note carries a Retry that re-opens the day on screen', function () {
  const dept = src('script-5-dept.html');
  assert.match(extractFn(dept, 'dqvShow_'), /<button type="button" class="link-btn day-qv-retry">Retry<\/button>/);
  assert.match(extractFn(dept, 'dqvWireModal_'), /if \(t\.closest\('\.day-qv-retry'\)\) \{ dqvShow_\(DQV_\.i\); return; \}/);
});

// ── CCX-5: the four small feedback gaps ──────────────────────────────────────

test('CCX-5: a null Team Direct Calls reply shows the error and its Retry instead of a blank card', function () {
  const dept = src('script-5-dept.html');
  const fr = fakeRun();
  let renders = 0;
  const ctx = vm.createContext({
    google: fr.google,
    tdcKey_: function () { return 'CSR|2026-11-05|2026-11-05'; },
    tdcRender_: function () { renders++; },
    excReq_: function (r) { return r; },
  });
  vm.runInContext('var TDC_ = { key: null, data: null, error: null, loading: false, seq: 0, wired: false };\n'
    + extractFn(dept, 'tdcFetch_'), ctx);
  ctx.tdcFetch_();
  assert.equal(fr.calls.length, 1);
  fr.calls[0].ok(null);
  assert.equal(vm.runInContext('TDC_.error', ctx), 'the server returned nothing');
  ctx.tdcFetch_();
  assert.equal(fr.calls.length, 1, 'held as an error (with Retry) rather than asked for on every sync');
});

test('CCX-5: the activity error gives its reason; an exception-day removal cannot be sent twice; the agent Home error has a Retry', function () {
  const esc = src('script-10-escalations.html');
  assert.match(extractFn(esc, 'escLoadActivity_'),
    /Could not load activity: '\s*\n\s*\+ escapeHtml\(err && err\.message \? err\.message : String\(err\)\)/);
  const rm = extractFn(src('script-7-admin.html'), 'excEditorRemove_');
  assert.match(rm, /var busyKey = 'excRemove:' \+ date;\s*\n\s*if \(mutationBusy_\(busyKey\)\) return;/);
  assert.equal((rm.match(/mutationDone_\(busyKey\);/g) || []).length, 2, 'released on success AND on failure');
  const agent = src('agentApp.html');
  assert.match(agent, /showError\('Error loading your numbers: ' \+ msg, true\);/);
  const showError = extractFn(agent, 'showError');
  assert.match(showError, /b\.id = 'agent-home-retry';/);
  assert.match(showError, /b\.addEventListener\('click', function \(\) \{ load\(\); \}\);/);
});

// ── CCX-6: the Callbacks section retries ─────────────────────────────────────

test('CCX-6: a failed or unavailable Callbacks load shows a Retry that clears the held answer and asks again', function () {
  const ins = src('script-8-insights.html');
  const state = { el: null, fetched: [], synced: 0 };
  const mk = function () {
    const e = { style: {}, textContent: '', kids: [], appendChild: function (k) { e.kids.push(k); } };
    return e;
  };
  state.el = mk();
  const ctx = vm.createContext({
    $: function (id) { return id === 'ins-cb-state' ? state.el : null; },
    document: {
      createElement: function () { const b = { on: {}, addEventListener: function (t, f) { b.on[t] = f; } }; return b; },
      createTextNode: function (t) { return { text: t }; },
    },
    insCbWindow_: function () { return { department: 'CSR', from: '2026-11-01', to: '2026-11-05' }; },
    insCbFetch_: function (w, key) { state.fetched.push(key); },
    insCbSync_: function () { state.synced++; },
  });
  vm.runInContext("var INS_CB_ = { key: 'CSR|2026-11-01|2026-11-05', seq: 0, data: null, error: 'Neon down', loadingKey: null };\n"
    + extractFn(ins, 'insCbState_') + '\n' + extractFn(ins, 'insCbRetry_'), ctx);
  ctx.insCbState_('Callbacks could not be loaded: Neon down', true);
  const btn = state.el.kids.filter(function (k) { return k.id === 'ins-cb-retry'; })[0];
  assert.ok(btn, 'the state line carries a Retry button');
  assert.equal(btn.textContent, 'Retry');
  btn.on.click();
  assert.equal(vm.runInContext('INS_CB_.error', ctx), null);
  assert.deepEqual(state.fetched, ['CSR|2026-11-01|2026-11-05']);
  // A plain status line (loading, an empty window) has no button.
  state.el = mk();
  ctx.insCbState_('Loading callbacks…');
  assert.equal(state.el.kids.length, 0);
  // If the window moved while the error sat there, the sync owns the new one.
  vm.runInContext("INS_CB_.key = 'CSR|old|old'; INS_CB_.error = 'x';", ctx);
  ctx.insCbRetry_();
  assert.equal(state.synced, 1);
  assert.equal(state.fetched.length, 1);
  // Both error paths and the "unavailable right now" reply ask for the button.
  assert.match(ins, /if \(INS_CB_\.error\) \{ insCbState_\('Callbacks could not be loaded: ' \+ INS_CB_\.error, true\); return; \}/);
  assert.match(extractFn(ins, 'insCbFetch_'), /insCbState_\('Callbacks could not be loaded: ' \+ INS_CB_\.error, true\);/);
  assert.match(extractFn(ins, 'insCbRender_'), /could not be read\)\.', true\);/);
});

// ── CCX-7: the Health backup section ─────────────────────────────────────────

test('CCX-7: a failed backup probe shows the section with the reason, not nothing', function () {
  const s9 = src('script-9-inbound-direct.html');
  assert.match(s9, /\.withFailureHandler\(function \(err\) \{\s*healthRenderBackupError_\(err && err\.message \? err\.message : String\(err\)\);\s*\}\)\s*\.getNeonBackupStatus\(\);/);
  assert.match(s9, /if \(st\) healthRenderBackup_\(st\);\s*else healthRenderBackupError_\('the server returned nothing'\);/);
  const sec = { style: { display: 'none' } }, status = { textContent: '' };
  const ctx = vm.createContext({ $: function (id) { return id === 'health-backup-section' ? sec : id === 'health-backup-status' ? status : null; } });
  vm.runInContext(extractFn(s9, 'healthRenderBackupError_'), ctx);
  ctx.healthRenderBackupError_('Exceeded maximum execution time');
  assert.equal(sec.style.display, '');
  assert.match(status.textContent, /^Backup status could not be read: Exceeded maximum execution time\./);
});

// ── CCX-8: link dates, and inert group rows ──────────────────────────────────

test('CCX-8: a link date that is not a real date is dropped with its pair; everything else is kept', function () {
  const nav = src('script-4-nav.html');
  const ctx = vm.createContext({});
  vm.runInContext(extractFn(nav, 'shareIsIsoDate_') + '\n' + extractFn(nav, 'shareCleanDateParams_'), ctx);
  const clean = function (p) { return plain(ctx.shareCleanDateParams_(p)); };
  assert.deepEqual(clean({ from: '2026-10-08', to: '2026-11-06', dept: 'CSR', agents: 'A|B' }),
    { from: '2026-10-08', to: '2026-11-06', dept: 'CSR', agents: 'A|B' });
  assert.deepEqual(clean({ from: '2026-13-45', to: 'garbage', dept: 'CSR' }), { dept: 'CSR' });
  assert.deepEqual(clean({ from: '2026-02-30', to: '2026-03-05' }), {}, 'Feb 30 is not a date');
  assert.deepEqual(clean({ from: '2026-11-06', to: '2026-10-08' }), {}, 'an inverted window is no window');
  assert.deepEqual(clean({ from: '2026-10-08' }), {}, 'half a window goes too');
  assert.deepEqual(clean({ from: '2026-10-08', to: '2026-11-06', pfrom: '10/01/2026', pto: '2026-10-07', mode: 'custom' }),
    { from: '2026-10-08', to: '2026-11-06', mode: 'custom' }, 'each pair is judged on its own');
  assert.deepEqual(clean(null), {});
  // The provider cleans before it writes a single field.
  const apply = nav.slice(nav.indexOf('function shareDatesProvider_('));
  assert.match(apply, /apply: function \(params\) \{[\s\S]{0,500}params = shareCleanDateParams_\(params\);\s*\n\s*Object\.keys\(ids\.fields\)\.forEach/);
});

test('CCX-8: the inert outbound / direct group rows have no pointer and no hover', function () {
  const css = src('styles.html');
  assert.match(css, /tr\.subq-group-head\.ob-group-head \{ cursor: default; \}/);
  assert.match(css, /tr\.subq-group-head\.ob-group-head:hover td \{ background: var\(--accent-soft\); \}/);
  // The override must come AFTER the toggle's own rules to win at equal weight.
  assert.ok(css.indexOf('tr.subq-group-head.ob-group-head { cursor: default; }') > css.indexOf('tr.subq-group-head { cursor: pointer; }'));
});
