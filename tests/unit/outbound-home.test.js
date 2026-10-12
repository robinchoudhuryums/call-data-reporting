'use strict';

// UX-1 (owner 2026-10-12, broad-scan Batch 3b): ONE Outbound home on My
// Department. The Outbound summary and the Callbacks section (with Direct
// lines) moved out of the Insights region to sit directly under the outbound
// agent table; they read the PAGE's window rather than Insights' last result
// (so a collapsed Insights region no longer leaves them empty or stale); the
// summary dropped its own agent table (the table above is that); and it says
// when its count is the dept's own group while the table above also holds
// sub-queue agents. The rendered checks are in drive-outbound-e.js and
// drive-callbacks.js; these are the markup and unit halves.

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

test('UX-1: the Outbound summary and Callbacks sit directly under the outbound agent table, outside Insights', function () {
  const html = src('dashboard.html');
  const obWrap = html.indexOf('<div id="agents-ob-wrap"');
  const home = html.indexOf('<div id="dept-ob-sections"');
  const obFold = html.indexOf('<details id="ins-ob-fold"');
  const cbFold = html.indexOf('<details id="ins-cb-fold"');
  const info = html.indexOf('<div id="info-line"');
  const results = html.indexOf('<div id="insights-results"');
  assert.ok(obWrap > 0 && home > obWrap, 'the sections follow the outbound table');
  assert.ok(obFold > home && cbFold > obFold && info > cbFold, 'summary, then Callbacks, inside the home, before the info line');
  assert.ok(results > info, 'both are above (outside) the Insights results');
  assert.equal(html.split('id="ins-ob-fold"').length - 1, 1, 'one Outbound summary');
  assert.equal(html.split('id="ins-cb-fold"').length - 1, 1, 'one Callbacks section');
  assert.ok(html.indexOf('id="ins-dl-fold"') > cbFold, 'Direct lines moved with Callbacks');
  assert.ok(!/id="ins-ob-agents"/.test(html), 'the summary has no agent table of its own');
});

test('UX-1: both sections read the PAGE window, and an Insights render no longer drives them', function () {
  const s8 = src('script-8-insights.html');
  const s5 = src('script-5-dept.html');
  assert.match(extractFn(s8, 'insObSync_'), /obSectionWindow_\(\)/);
  assert.match(extractFn(s8, 'insCbWindow_'), /obSectionWindow_\(\)/);
  assert.ok(!/insLastData/.test(extractFn(s8, 'insObSync_') + extractFn(s8, 'insCbWindow_')),
    'neither reads Insights\' last result');
  assert.ok(!/insObSync_\(|insCbSync_\(/.test(extractFn(s8, 'insRenderReport_')),
    'an Insights render does not repaint the sections under the table');
  const sync = extractFn(s5, 'obViewSync_');
  assert.match(sync, /if \(typeof insObSync_ === 'function'\) insObSync_\(\);/);
  assert.match(sync, /if \(typeof insCbSync_ === 'function'\) insCbSync_\(\);/);
  assert.ok(!/insObAgentsHtml_/.test(s8), 'the duplicate agent-table builder is gone');

  // obSectionWindow_ is the dept page's loaded window + its INV-28 prior.
  const sb = { state: { meta: { from: '2026-10-01', to: '2026-10-07', priorFrom: '2026-09-24', priorTo: '2026-09-30' } },
               getRequestedDept: function () { return 'CSR'; } };
  vm.runInNewContext(extractFn(s5, 'obSectionWindow_'), sb);
  assert.deepEqual(JSON.parse(JSON.stringify(sb.obSectionWindow_())),
    { department: 'CSR', from: '2026-10-01', to: '2026-10-07', priorFrom: '2026-09-24', priorTo: '2026-09-30' });
  sb.state.meta = {};
  assert.equal(sb.obSectionWindow_(), null, 'nothing until the page has loaded a window');
});

test('UX-1: the summary says when it counts the dept\'s own group and the table above holds sub-queues', function () {
  const s8 = src('script-8-insights.html');
  const sb = { fmtNumber: function (n) { return String(n); } };
  vm.runInNewContext(extractFn(s8, 'insObOwnScope_') + extractFn(s8, 'insObHeadText_'), sb);

  const payload = {
    totals: { obTotal: 22, obConnectRate: 59.1 },
    deptGroups: [{ dept: 'CSR', totals: { obTotal: 14, obConnectRate: 57.1 } },
                 { dept: 'Spanish', totals: { obTotal: 8, obConnectRate: 62.5 } }],
    agents: [{ agent: 'Ann', scopeDept: 'CSR' }, { agent: 'Iris', scopeDept: 'Spanish' }],
    meta: {},
  };
  const own = sb.insObOwnScope_(payload, 'CSR');
  assert.equal(own.totals.obTotal, 14, 'the summary counts CSR\'s own group');
  assert.deepEqual(own.agents.map(function (a) { return a.agent; }), ['Ann']);
  assert.deepEqual(JSON.parse(JSON.stringify(own.scope)), { dept: 'CSR', others: ['Spanish'], tablePlaced: 22 });
  assert.equal(sb.insObHeadText_(own.totals, own.scope), 'CSR only · 14 placed · 57.1% connected');

  const solo = sb.insObOwnScope_({ totals: { obTotal: 9 }, deptGroups: [{ dept: 'Sales', totals: { obTotal: 9, obConnectRate: 40 } }], agents: [] }, 'Sales');
  assert.equal(solo.scope, null, 'no sub-queues, no label');
  assert.equal(sb.insObHeadText_(solo.totals, solo.scope), '9 placed · 40.0% connected');
  assert.equal(sb.insObHeadText_({ obTotal: 0 }, own.scope), 'CSR only: no outbound calls in this window');

  assert.match(extractFn(s8, 'insObRender_'),
    /These figures are ' \+ cur\.scope\.dept \+ '’s own group\. The table above also includes '/,
    'the note names the left-out sub-queues and the table\'s total');
});
