'use strict';

// P4 (owner 2026-11-13): the Team Direct Calls side card.
//   - a loader from the FIRST moment: the card is busy from the page's own
//     request (tdcArm_, from refresh()), not only once it has a window to ask
//     for; a failed page load stops the wait (tdcDisarm_);
//   - the LAST figures stay up, frosted, while a new range loads -- for the
//     same department only;
//   - Team Rings no longer collapses and paints over the card (CSS, with the
//     .dept-side--direct class tdcSync_ sets);
//   - the card is one headline + one bar, a key line and one labelled block.
//
// The state functions lift out of the assembled client and run here in a vm
// against a fake DOM; the layout and the markup are source pins. The rendered
// gate (drive-deptoutbound.js) asserts all four at the real page.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const S5 = fs.readFileSync(path.join(DIR, 'script-5-dept.html'), 'utf8');
const S9 = fs.readFileSync(path.join(DIR, 'script-9-inbound-direct.html'), 'utf8');
const CSS = fs.readFileSync(path.join(DIR, 'styles.html'), 'utf8');
const HTML = fs.readFileSync(path.join(DIR, 'dashboard.html'), 'utf8');

function extractFn(text, name) {
  const at = text.search(new RegExp('function ' + name + '\\('));
  assert.ok(at >= 0, 'function ' + name + ' not found');
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const IDS = ['dept-team-direct', 'tdc-date', 'tdc-note', 'tdc-tiles', 'tdc-tbody', 'tdc-loading', 'tdc-error',
  'tdc-error-msg', 'tdc-table-wrap', 'tdc-body', 'tdc-unit'];
function fakeEl() {
  return { style: { display: 'none' }, attrs: {}, textContent: '', innerHTML: '', className: '', title: '',
    setAttribute: function (k, v) { this.attrs[k] = v; } };
}
function payload(tag) {
  return { tag: tag, meta: {}, kpis: { ibAnswered: 1 },
    agents: [{ agent: 'Anna Reyes', ibAnswered: 12, ibMissedFree: 3, ibMissedBusy: 1, ibAnswerRate: 80 }] };
}
// The card's state functions + a queued google.script.run, around a fake DOM.
function mk(opts) {
  opts = opts || {};
  const els = {}; IDS.forEach(function (id) { els[id] = fakeEl(); });
  const calls = [], frost = [];
  const env = { admin: opts.admin !== false, dept: 'CSR', key: 'CSR|2026-11-01|2026-11-05', tiles: [] };
  const run = { _ok: null, _fail: null };
  run.withSuccessHandler = function (f) { run._ok = f; return run; };
  run.withFailureHandler = function (f) { run._fail = f; return run; };
  run.getDirectCallReport = function (req) { calls.push({ req: req, ok: run._ok, fail: run._fail }); };
  const ctx = vm.createContext({
    env: env, google: { script: { run: run } },
    $: function (id) { return els[id] || null; },
    tdcActive_: function () { return env.admin; },
    tdcKey_: function () { return env.key; },
    getRequestedDept: function () { return env.dept; },
    excReq_: function (r) { return r; },
    dsFrostShow_: function (h, label) { frost.push('show'); h.frosted = true; },
    dsFrostHide_: function (h) { frost.push('hide'); h.frosted = false; },
    dcViewRender_: function () {},
    directSummaryHtml_: function (k, p, mode) { return '<card ' + mode + '>'; },
    ANS_TALLY_UNITS_: [1, 2, 5, 10], ansTallyBlocks_: function () { return ''; },
    trpShortName_: function (n) { return n; }, escapeHtml: function (x) { return String(x); },
    fmtNumber: function (n) { return String(n); },
  });
  vm.runInContext('var TDC_ = { key: null, data: null, error: null, loading: false, seq: 0, wired: false,'
    + ' pending: false, pageFailed: false, last: null };\n'
    + ['dcRang_', 'tdcArm_', 'tdcDisarm_', 'tdcHeld_', 'tdcFetch_', 'tdcRender_'].map(function (n) { return extractFn(S5, n); }).join('\n'), ctx);
  const get = function (expr) { return vm.runInContext(expr, ctx); };
  const view = function () {
    return { skel: els['tdc-loading'].style.display !== 'none', body: els['tdc-body'].style.display !== 'none',
      err: els['tdc-error'].style.display !== 'none', frosted: !!els['tdc-body'].frosted,
      busy: els['dept-team-direct'].attrs['aria-busy'], rows: els['tdc-tbody'].innerHTML, date: els['tdc-date'].textContent };
  };
  return { ctx: ctx, els: els, calls: calls, env: env, get: get, view: view };
}

test('P4: the state object declared in the client carries the three new fields the functions read', function () {
  assert.match(S5, /var TDC_ = \{ key: null, data: null, error: null, loading: false, seq: 0, wired: false,\s*pending: false, pageFailed: false, last: null \};/);
});

test('P4: the card shows its loader before the first window is known, and from the moment the page starts loading', function () {
  const t = mk();
  t.ctx.tdcRender_();
  assert.deepEqual([t.view().skel, t.view().body, t.view().busy], [true, false, 'true'], 'never an empty box with a title');
  t.ctx.tdcArm_();
  assert.equal(t.get('TDC_.pending'), true);
  assert.equal(t.calls.length, 0, 'arming sends nothing -- the window is not known yet');
  assert.deepEqual([t.view().skel, t.view().busy], [true, 'true']);
});

test('P4: the page load landing clears the wait and asks once; the reply paints and is held as the last figures', function () {
  const t = mk();
  t.ctx.tdcArm_();
  t.ctx.tdcFetch_();
  assert.equal(t.get('TDC_.pending'), false);
  assert.equal(t.calls.length, 1);
  assert.deepEqual([t.view().skel, t.view().body], [true, false], 'nothing to keep on the very first load');
  t.calls[0].ok(payload('A'));
  const v = t.view();
  assert.deepEqual([v.skel, v.body, v.frosted, v.busy, v.err], [false, true, false, 'false', false]);
  assert.match(v.rows, /Anna Reyes/);
  assert.equal(t.get('TDC_.last.key'), 'CSR|2026-11-01|2026-11-05');
  assert.equal(t.get('TDC_.last.data.tag'), 'A');
});

test('P4: a new range keeps the last figures under a frost until its own reply lands', function () {
  const t = mk();
  t.ctx.tdcFetch_(); t.calls[0].ok(payload('A'));
  // The page starts loading a new window: busy at once, figures kept.
  t.ctx.tdcArm_();
  let v = t.view();
  assert.deepEqual([v.skel, v.body, v.frosted, v.busy], [false, true, true, 'true'], 'frosted from the page request, not only from the card\'s own');
  // The summary lands with the new window: the card asks for it.
  t.env.key = 'CSR|2026-10-01|2026-10-31';
  t.ctx.tdcFetch_();
  assert.equal(t.calls.length, 2);
  assert.equal(t.get('TDC_.data'), null, 'data keeps its meaning: the payload for the CURRENT key, or null (the Direct view reads it)');
  v = t.view();
  assert.deepEqual([v.skel, v.body, v.frosted, v.busy], [false, true, true, 'true']);
  assert.match(v.rows, /Anna Reyes/, 'the last figures are still on the card');
  assert.equal(v.date, '2026-10-01 – 2026-10-31', 'the date line names the window being loaded');
  t.calls[1].ok(payload('B'));
  v = t.view();
  assert.deepEqual([v.skel, v.body, v.frosted, v.busy], [false, true, false, 'false']);
  assert.equal(t.get('TDC_.last.data.tag'), 'B');
});

test('P4: another department never shows under this one\'s title -- a department switch goes to the skeleton', function () {
  const t = mk();
  t.ctx.tdcFetch_(); t.calls[0].ok(payload('A'));
  t.env.dept = 'Sales'; t.env.key = 'Sales|2026-11-01|2026-11-05';
  t.ctx.tdcArm_();
  assert.equal(t.ctx.tdcHeld_(), null);
  assert.deepEqual([t.view().skel, t.view().body], [true, false], 'armed on the new department: skeleton, not CSR\'s figures');
  t.ctx.tdcFetch_();
  assert.deepEqual([t.view().skel, t.view().body, t.view().frosted], [true, false, false]);
  assert.equal(t.view().rows, '');
});

test('P4: the Refresh button (key dropped, figures kept) reloads under the frost, not through the skeleton', function () {
  const t = mk();
  t.ctx.tdcFetch_(); t.calls[0].ok(payload('A'));
  vm.runInContext('TDC_.key = null;', t.ctx);            // refreshClearSectionStores_
  assert.equal(t.ctx.tdcHeld_().tag, 'A', 'the last good payload is still this department\'s');
  t.ctx.tdcFetch_();
  assert.equal(t.calls.length, 2, 'Refresh still re-reads from the server');
  assert.deepEqual([t.view().skel, t.view().body, t.view().frosted], [false, true, true]);
});

test('P4: a failed card load shows the error and Retry, not stale figures; a failed PAGE load stops the wait', function () {
  const t = mk();
  t.ctx.tdcFetch_(); t.calls[0].ok(payload('A'));
  t.env.key = 'CSR|2026-10-01|2026-10-31';
  t.ctx.tdcFetch_();
  t.calls[1].fail(new Error('boom'));
  let v = t.view();
  assert.deepEqual([v.err, v.body, v.skel, v.busy], [true, false, false, 'false'], 'an error is never dressed up with the old window\'s figures');
  assert.match(t.els['tdc-error-msg'].textContent, /boom/);

  const u = mk();
  u.ctx.tdcArm_();
  u.ctx.tdcDisarm_();                                    // onError: the summary failed
  assert.deepEqual([u.get('TDC_.pending'), u.get('TDC_.pageFailed')], [false, true]);
  v = u.view();
  assert.deepEqual([v.skel, v.busy], [false, 'false'], 'no skeleton left spinning for a load that is not coming');
  u.ctx.tdcArm_();                                       // the next attempt waits again
  assert.deepEqual([u.get('TDC_.pageFailed'), u.view().skel], [false, true]);
  u.ctx.tdcDisarm_(); u.ctx.tdcDisarm_();                // idempotent when nothing is pending
  assert.equal(u.get('TDC_.pending'), false);

  // A page that never sent a load at all (no department / a blank date).
  const w = mk();
  w.ctx.tdcRender_();
  assert.equal(w.view().skel, true);
  w.ctx.tdcDisarm_();
  assert.deepEqual([w.view().skel, w.view().busy], [false, 'false']);
});

test('P4: a viewer who cannot read the report is never armed (View-as, managers)', function () {
  const t = mk({ admin: false });
  t.ctx.tdcArm_();
  assert.equal(t.get('TDC_.pending'), false);
  assert.equal(t.calls.length, 0);
});

test('P4: refresh() arms the card with the page request and the failure handler disarms it', function () {
  assert.match(extractFn(S5, 'refresh'), /deptMissedFrostArm_\(\);\s*tdcArm_\(\);/, 'busy from the same moment the summary request goes out');
  assert.match(extractFn(S5, 'onError'), /tdcDisarm_\(\);/);
  assert.equal((extractFn(S5, 'refresh').match(/tdcDisarm_\(\);/g) || []).length, 2,
    'both early returns (no department, a blank date) stop the wait too -- no loader for a load that never went out');
  assert.match(extractFn(S5, 'tdcFetch_'), /var key = tdcKey_\(\);\s*TDC_\.pending = false;/, 'the landed page load clears the wait before anything else');
  assert.match(extractFn(S5, 'tdcFetch_'), /if \(TDC_\.data\) TDC_\.last = \{ key: key, data: TDC_\.data \};/);
});

test('P4: with the card in the column, Team Rings and Team Outbound keep their height instead of collapsing under it', function () {
  assert.match(extractFn(S5, 'tdcSync_'), /side\.classList\.toggle\('dept-side--direct', tdcActive_\(\)\);\s*if \(!el \|\| !tdcActive_\(\)\) return;/,
    'the class follows the viewer on every sync, View-as included (set BEFORE the early return)');
  assert.match(CSS, /\.dept-side\.dept-side--direct > #dept-team-rings,\s*\.dept-side\.dept-side--direct > #dept-team-outbound,\s*\.dept-side > #dept-team-direct \{ flex: 0 0 auto; \}/);
  assert.match(CSS, /\.dept-side\.dept-side--direct > #dept-team-rings \.trp-table-wrap,\s*\.dept-side\.dept-side--direct > #dept-team-outbound \.trp-table-wrap \{ flex: 0 0 auto; max-height: 200px; \}/);
  assert.match(CSS, /#dept-team-direct \.trp-table \{ table-layout: fixed; \}/, 'the agent table cannot push past the card');
});

test('P4: the card form is one headline and one bar, a key line, and one labelled block', function () {
  const fn = extractFn(S9, 'directSummaryHtml_');
  const card = fn.slice(fn.indexOf("if (mode === 'card') {"), fn.indexOf('const sp = k.split || {};'));
  assert.equal((card.match(/obSplitMiniHtml_\(/g) || []).length, 1, 'ONE bar -- calls to colleagues no longer get a headline and bar of their own');
  assert.equal((card.match(/class="tdc-split-num"/g) || []).length, 1, 'ONE headline figure');
  assert.match(card, /class="tdc-split-rate"/);
  assert.match(card, /class="tdc-key"/);
  ['Outside answered', 'Calls to colleagues', 'Calls to outside numbers'].forEach(function (label) {
    assert.ok(card.indexOf("row('" + label + "'") >= 0, 'the labelled block holds: ' + label);
  });
  assert.ok(!/tdc-legend/.test(HTML) && !/tdc-legend/.test(S5), 'the separate legend row under the table is gone');
  assert.match(HTML, /<div id="tdc-body" style="display:none;">/, 'the part that frosts');
  assert.match(HTML, /<th class="trp-num">Rang <span id="tdc-unit" class="tdc-unit"><\/span><\/th>/, 'the block size sits in the header');
});
