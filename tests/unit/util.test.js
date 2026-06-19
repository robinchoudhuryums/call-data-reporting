'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');

// Util.gs pulls a couple of names from Config.gs (none at load time);
// load both so the shared-scope refs resolve.
const h = loadGas({ files: ['Config.gs', 'Util.gs'] });

test('round1_ rounds to one decimal and coerces junk to 0', function () {
  assert.equal(h.call('round1_', 3.14159), 3.1);
  assert.equal(h.call('round1_', 3.15), 3.2);
  assert.equal(h.call('round1_', -2.449), -2.4);
  assert.equal(h.call('round1_', null), 0);
  assert.equal(h.call('round1_', 'not a number'), 0);
  assert.equal(h.call('round1_', 0), 0);
});

test('formatSecondsHms_ matches the Sonia 2026-03-09 spot-check (S7)', function () {
  // CLAUDE.md Operator State #5 / S7: TTT 0:15:03, ATT 0:03:01.
  assert.equal(h.call('formatSecondsHms_', 903), '0:15:03');   // TTT
  assert.equal(h.call('formatSecondsHms_', 181), '0:03:01');   // ATT
});

test('formatSecondsHms_ zero/empty and padding/rounding', function () {
  assert.equal(h.call('formatSecondsHms_', 0), '0:00:00');
  assert.equal(h.call('formatSecondsHms_', null), '0:00:00');
  assert.equal(h.call('formatSecondsHms_', undefined), '0:00:00');
  assert.equal(h.call('formatSecondsHms_', 3661), '1:01:01');
  assert.equal(h.call('formatSecondsHms_', 59), '0:00:59');
  assert.equal(h.call('formatSecondsHms_', 90.4), '0:01:30');  // rounds
  assert.equal(h.call('formatSecondsHms_', 89.6), '0:01:30');
});

test('escapeHtmlServer_ neutralizes all five entities', function () {
  assert.equal(h.call('escapeHtmlServer_', '<b>"x"&\'y\'</b>'),
    '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;');
  assert.equal(h.call('escapeHtmlServer_', null), '');
  assert.equal(h.call('escapeHtmlServer_', 42), '42');
  // & is escaped first so existing entities aren't double-mangled into ambiguity
  assert.equal(h.call('escapeHtmlServer_', 'a & b'), 'a &amp; b');
});

test('generateMonthList_ inclusive, spans year boundary', function () {
  deepEqual(
    h.call('generateMonthList_', new Date(2025, 0, 15), new Date(2025, 2, 3)),
    ['2025-01', '2025-02', '2025-03']);
  // single month
  deepEqual(
    h.call('generateMonthList_', new Date(2026, 4, 1), new Date(2026, 4, 28)),
    ['2026-05']);
  // across Dec -> Jan
  deepEqual(
    h.call('generateMonthList_', new Date(2025, 10, 2), new Date(2026, 1, 9)),
    ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('buildTeamInsights_ gates on non-trivial volume and caps at 3', function () {
  // Trivial volume (both rung < 10) -> no insights.
  deepEqual(h.call('buildTeamInsights_', { rung: 3, pct: 50 }, { rung: 2, pct: 90 }), []);

  // Answer-rate swing >= 5 pts surfaces a negative insight.
  const out = h.call('buildTeamInsights_',
    { rung: 100, pct: 70, answered: 70, missed: 5, att: 180 },
    { rung: 100, pct: 90, answered: 90, missed: 5, att: 180 });
  assert.ok(out.length >= 1 && out.length <= 3);
  assert.equal(out[0].type, 'negative');
  assert.match(out[0].text, /Answer rate fell/);
});

test('buildTeamInsights_ excludeVolume drops raw-volume insights, keeps rate + ATT', function () {
  // Big answer-rate swing + big answered-volume swing + big missed swing +
  // big ATT swing -> without the flag, volume insights appear.
  const curr = { rung: 200, pct: 70, answered: 140, missed: 40, att: 240 };
  const prev = { rung: 100, pct: 90, answered: 90,  missed: 5,  att: 180 };

  const full = h.call('buildTeamInsights_', curr, prev);
  assert.ok(full.some(function (i) { return /call volume/.test(i.text); }),
    'volume insight present without the flag');

  const trimmed = h.call('buildTeamInsights_', curr, prev, { excludeVolume: true });
  assert.ok(!trimmed.some(function (i) { return /call volume|Missed-call count/.test(i.text); }),
    'no raw-volume insights with excludeVolume');
  assert.ok(trimmed.some(function (i) { return /Answer rate/.test(i.text); }),
    'answer-rate insight retained');
  assert.ok(trimmed.some(function (i) { return /Avg talk time/.test(i.text); }),
    'avg-talk-time insight retained');
});

test('assertAdmin_ throws for non-admins, passes for admins', function () {
  // resolveUser_ lives in Auth.gs; inject a stub into the shared scope
  // so we exercise assertAdmin_'s role check in isolation.
  h.ctx.resolveUser_ = function (email) {
    return { role: email === 'admin@x.com' ? 'admin' : 'manager' };
  };

  h.state.userEmail = 'manager@x.com';
  assert.throws(function () { h.call('assertAdmin_'); }, /admin-only/);

  h.state.userEmail = 'admin@x.com';
  assert.doesNotThrow(function () { h.call('assertAdmin_'); });
});
