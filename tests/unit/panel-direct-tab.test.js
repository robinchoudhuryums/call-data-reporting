'use strict';

// Follow-up plan 2026-11-13, batches P1 + P2 (owner notes from using the
// dashboard). Client-side rules, pinned here by source and by running the
// Direct list's pure helpers; the rendered halves are in drive-agentpanel.js
// and drive-admin.js.
//
// P1  the Call ID chip's warn tint MEANS "abandoned" -- every other call wears
//     the neutral chip; a connected outbound call that rang 0-1 s reads
//     "instant"; "missed while on another call" has its own (yellow) segment;
//     the Missed Calls strip no longer repeats the heading's date; the
//     Transfer retries header row is pinned; Outlier Fix's "Apply selected"
//     marks ticked unlisted-extension rows Not an agent.
// P2  the agent panel's Direct tab: Direction (Incoming / Outgoing), a filter
//     and sortable headers, the call id for admins, and a call PLACED to an
//     outside number counted on the Outbound tab only (the DO-1 rule).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const src = (f) => fs.readFileSync(path.join(DASH, f), 'utf8');
const S10 = src('script-10-escalations.html');
const blk = (text, a, b) => {
  const i = text.indexOf(a);
  assert.ok(i !== -1, 'marker not found: ' + a);
  const j = text.indexOf(b, i);
  assert.ok(j !== -1, 'end marker not found: ' + b);
  return text.slice(i, j);
};

// The Direct list's pure helpers, run as written.
const ctx = {};
vm.runInNewContext(
  blk(S10, '  var AD_DIRECT_OUTCOME_ = {', '  function adDirectNoteHtml_')
  + blk(S10, '  function adBusyText_', '  var AD_DSUM_TOP_')
  + blk(S10, '  function apDirectListRows_', '  /**\n   * The Direct list.')
  + '\nthis.api = { rows: apDirectListRows_, view: apDirectView_, way: apDirectWay_ };', ctx);
const api = ctx.api;
const J = (x) => JSON.parse(JSON.stringify(x));

const ROWS = [
  { callId: 'a', callStart: '09:00:00', direction: 'out', side: 'int', other: 'Cal', outcome: 'connected', ringSec: null, talkSec: 95 },
  { callId: 'b', callStart: '09:30:00', direction: 'out', side: 'ext', other: 'Outside number', outcome: 'connected', ringSec: null, talkSec: 50 },
  { callId: 'c', callStart: '10:00:00', direction: 'in', side: 'ext', other: 'Outside caller', outcome: 'answered', ringSec: 9, talkSec: 210 },
  { callId: 'd', callStart: '10:30:00', direction: 'in', side: 'int', other: 'Bea', outcome: 'missed_busy', ringSec: 18, talkSec: 0, busyWith: 'Cal' },
  { callId: 'e', callStart: '11:00:00', direction: 'in', side: 'int', other: 'Eli', outcome: 'missed_free', ringSec: 30, talkSec: 0 },
  { callId: 'f', callStart: '11:30:00', direction: 'out', side: 'int', other: 'Flo', outcome: 'not_connected', ringSec: null, talkSec: 0 },
];
const ids = (rows) => J(rows).map((r) => r.callId).join('');

test('P2: a call PLACED to an outside number leaves the Direct list; an outside caller ringing the line stays', function () {
  assert.equal(ids(api.rows(ROWS)), 'acdef', 'only the out + ext row goes (it is on the Outbound tab)');
  assert.equal(ids(api.rows([])), '');
  assert.equal(api.way(ROWS[0]), 'Outgoing');
  assert.equal(api.way(ROWS[2]), 'Incoming');
});

test('P2: the filter narrows by direction and by outcome group', function () {
  const all = api.rows(ROWS);
  assert.equal(ids(api.view(all, { way: 'in' })), 'cde');
  assert.equal(ids(api.view(all, { way: 'out' })), 'af');
  assert.equal(ids(api.view(all, { outcome: 'ok' })), 'ac', 'answered or connected');
  assert.equal(ids(api.view(all, { outcome: 'missed' })), 'ef', 'missed while free, or no answer');
  assert.equal(ids(api.view(all, { outcome: 'busy' })), 'd', 'missed while on another call is its own group');
  assert.equal(ids(api.view(all, { way: 'in', outcome: 'ok' })), 'c');
  assert.equal(ids(api.view(all, { way: 'all', outcome: 'all' })), 'acdef');
});

test('P2: sorting is stable, flips on desc, and keeps a missing value last either way', function () {
  const all = api.rows(ROWS);
  assert.equal(ids(api.view(all, {})), 'acdef', 'time order by default');
  assert.equal(ids(api.view(all, { sort: 'time', desc: true })), 'fedca');
  assert.equal(ids(api.view(all, { sort: 'talk', desc: true })), 'cadef', 'longest talk first; no talk last, in list order');
  assert.equal(ids(api.view(all, { sort: 'talk' })), 'acdef', 'shortest first; no talk still last');
  assert.equal(ids(api.view(all, { sort: 'rang' })), 'cdeaf', 'outgoing calls record no ring: last');
  assert.equal(ids(api.view(all, { sort: 'way' })), 'cdeaf', 'Incoming before Outgoing, each in list order');
  assert.equal(ids(api.view(all, { sort: 'with' })), 'daefc', 'by the other party, case-insensitive');
});

test('P2: the Direct tab says Direction, counts its own rows, and shows admins the call id in a neutral chip', function () {
  assert.match(S10, /var AP_DIRECT_COLS_ = \[\['time', 'Time'\], \['way', 'Direction'\], /);
  assert.doesNotMatch(S10, /<th>Way<\/th>/);
  assert.doesNotMatch(S10, /'Called them'/, 'the ambiguous wording is gone');
  assert.match(S10, /tabBtn\('direct', 'Direct calls', apDirectListRows_\(direct\)\.length\)/);
  assert.match(S10, /parentIdBadge\(c\.callId, '', '', \{ neutral: true \}\)/, 'no date: a direct call has no path drill');
  assert.match(S10, /<th>Colleague<\/th><th>Outgoing<\/th><th>Incoming<\/th>/);
  // The headline counts colleagues; the outside-number calls are one line.
  assert.match(S10, /<strong>' \+ fmtNumber\(oCol\) \+ '<\/strong> calls to colleagues/);
  assert.match(S10, /to outside numbers \('\s*\+ fmtNumber\(o\.toOutsideConnected \|\| 0\) \+ ' connected\) — listed under Outbound calls'/);
  // The quick view's count follows the same rows.
  assert.match(src('script-5-dept.html'), /fmtNumber\(apDirectListRows_\(\(data && data\.direct\) \|\| \[\]\)\.length\)/);
});

test('P1: the Call ID chip is warn-tinted only for an abandoned call', function () {
  const s5 = src('script-5-dept.html');
  assert.match(s5, /function parentIdBadge\(parentId, date, kind, opts\)/);
  assert.match(s5, /const chipCls = 'parent-id' \+ \(\(kind === 'outbound' \|\| \(opts && opts\.neutral\)\) \? ' parent-id--neutral' : ''\);/);
  assert.equal((s5.match(/class="' \+ chipCls \+ '"/g) || []).length, 2, 'both the admin and the manager form use it');
  // A transferred call is not an abandoned one either.
  assert.match(src('script-7-admin.html'), /parentIdBadge\(c\.callId, c\.date, c\.kind === 'outbound' \? 'outbound' : '', \{ neutral: true \}\)/);
  const css = src('styles.html');
  assert.match(css, /\.parent-id\.parent-id--neutral \{[^}]*background: var\(--paper-2\);[^}]*color: var\(--muted\);/);
});

test('P1: a connected call that rang 0-1 s reads "instant"; unanswered and unknown rings are unchanged', function () {
  const c2 = { escapeHtml: String, fmtDuration: (n) => 'D' + n };
  vm.runInNewContext(blk(S10, '  var AP_INSTANT_RING_SEC_ = 1;', '  function apOutboundTableHtml_')
    + '\nthis.ring = apOutboundRingHtml_;', c2);
  assert.match(c2.ring({ connected: true, ringSec: 0 }), />instant</);
  assert.match(c2.ring({ connected: true, ringSec: 1 }), />instant</);
  assert.equal(c2.ring({ connected: true, ringSec: 2 }), 'D2');
  assert.equal(c2.ring({ connected: false, ringSec: 0 }), 'D0', 'an unanswered call keeps its ring time');
  assert.equal(c2.ring({ connected: true, ringSec: null }), '–', 'unknown stays unknown');
});

test('P1: "missed while on another call" has its own yellow segment everywhere it is drawn', function () {
  const s9 = src('script-9-inbound-direct.html');
  [S10, s9].forEach(function (t) {
    assert.doesNotMatch(t, /cls: 'soft'[^\n]*missed while on another call/, 'no bar still uses the soft red for it');
  });
  assert.equal((s9.match(/cls: 'busy'[^\n]*missed while on another call/g) || []).length, 2);
  assert.match(S10, /cls: 'busy', n: i\.missedBusy/);
  assert.match(src('script-5-dept.html'), /\['bad', 'missed'\], \['busy', 'busy'\]/);
  const css = src('styles.html');
  assert.match(css, /\.ob-seg-busy \{ background: color-mix\(in oklab, var\(--caution\) /);
  assert.match(css, /\.tly\.mb \{ background: color-mix\(in oklab, var\(--caution\) /);
  // The soft red keeps its other meanings (rang out, brief ring).
  assert.match(css, /\.ob-seg-soft \{ background: color-mix\(in oklab, var\(--warn\) /);
});

test('P1: the Missed Calls strip does not repeat the date; the Transfer retries header row is pinned', function () {
  const s5 = src('script-5-dept.html');
  const strip = blk(s5, "const sum = $('dept-missed-summary');", 'sum.innerHTML');
  assert.doesNotMatch(strip, /Range:/);
  assert.match(strip, /Total missed:/);
  const css = src('styles.html');
  assert.match(css, /\.tr-cases-wrap \{ overflow: auto; max-height: /);
  assert.match(css, /\.tr-cases-wrap > \.tr-cases \{ overflow: clip; \}/, 'hidden would trap the sticky header (R10-9)');
  assert.match(css, /\.tr-cases-wrap > \.tr-cases thead th \{ position: sticky; top: 0;/);
});

test('P1: Outlier Fix "Apply selected" marks ticked unlisted-extension rows Not an agent, within the server\'s cap', function () {
  const s7 = src('script-7-admin.html');
  assert.match(s7, /else if \(ofUnlistedOnly_\(\(\(ofLastInit && ofLastInit\.orphans\) \|\| \[\]\)\[idx\]\)\) kind = 'ignore';/);
  assert.match(s7, /\(ofUnlistedOnly_\(o\) \? '' : ' disabled'\)/, 'tickable from the first render');
  const batch = blk(s7, '  function ofBatchApply_() {', '  // P1 (owner 2026-11-13): "Apply selected" for people marked Not an agent.');
  assert.match(batch, /else if \(r\.kind === 'ignore'\) \{\s*ignoreNames\.push\(orphan\.name\);/);
  assert.match(batch, /tone: items\.length \? 'danger' : undefined/, 'marking alone is reversible: not a destructive dialog');
  assert.match(batch, /ofIgnoreNames_\(ignoreNames\)\.then\(/);
  const chunk = Number((/var OF_IGNORE_CHUNK_ = (\d+);/.exec(s7) || [])[1]);
  const cap = Number((/ORPHAN_IGNORE_MAX_PER_CALL_ = (\d+);/.exec(src('OrphanFix.gs')) || [])[1]);
  assert.ok(chunk > 0 && cap > 0 && chunk <= cap, 'a chunk never exceeds what setOrphanIgnored accepts (' + chunk + ' <= ' + cap + ')');
});
