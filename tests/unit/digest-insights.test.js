'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// The digest-Insights bridge: monthly cadence + the Format column +
// digestInsightsHtml_ (which reuses computeInsights_, hence the
// Insights/Performance files in the loader -- Apps Script flat scope).
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'PerformanceReport.gs',
          'InsightsReport.gs', 'Digest.gs'],
});

const ROSTER = rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202'] });

function install(rows, digestConfigRows) {
  h.state.props.SPREADSHEET_ID = 'fake';
  const sheets = {
    'DO NOT EDIT!': ROSTER,
    'DQE Historical Data': dqeSheet(rows || []),
  };
  if (digestConfigRows) {
    sheets['Digest Config'] = [
      ['Email', 'Department', 'Cadence', 'Active', 'Notes', 'Format'],
    ].concat(digestConfigRows);
  }
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: sheets });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.state.cache.clear();
}

test('digest: monthly cadence + format normalization', function () {
  assert.equal(h.call('normalizeCadence_', 'monthly'), 'monthly');
  assert.equal(h.call('normalizeCadence_', ' Month '), 'monthly');
  assert.equal(h.call('normalizeCadence_', 'fortnightly'), '');
  assert.equal(h.call('normalizeFormat_', ''), 'summary');          // empty col F = legacy rows
  assert.equal(h.call('normalizeFormat_', 'summary'), 'summary');
  assert.equal(h.call('normalizeFormat_', 'Insights'), 'insights');
  assert.equal(h.call('normalizeFormat_', 'detail'), 'insights');
  assert.equal(h.call('normalizeFormat_', 'garbage'), 'summary');   // tolerant default
});

test('digest: monthly window = previous calendar month', function () {
  const w = h.call('digestWindowFor_', 'monthly', new Date(2026, 5, 15, 12));  // Jun 15
  assert.equal(w.fromIso, '2026-05-01');
  assert.equal(w.toIso,   '2026-05-31');
  // Year boundary: fired in January -> previous December.
  const y = h.call('digestWindowFor_', 'monthly', new Date(2026, 0, 1, 12));
  assert.equal(y.fromIso, '2025-12-01');
  assert.equal(y.toIso,   '2025-12-31');
});

test('digest: cadence-appropriate prior windows for the insights format', function () {
  // Daily: null -> computeInsights_'s INV-28 auto-adjacent (= previous day).
  assert.equal(h.call('digestInsightsPrior_', 'daily', '2026-03-10', '2026-03-10'), null);
  // Weekly: shift-7 (previous Mon-Fri), NOT the raw INV-28 Wed-Sun window.
  const wk = h.call('digestInsightsPrior_', 'weekly', '2026-03-09', '2026-03-13');
  assert.equal(wk.from, '2026-03-02');
  assert.equal(wk.to,   '2026-03-06');
  // Monthly: the previous calendar month (length may differ; that's fine).
  const mo = h.call('digestInsightsPrior_', 'monthly', '2026-05-01', '2026-05-31');
  assert.equal(mo.from, '2026-04-01');
  assert.equal(mo.to,   '2026-04-30');
});

test('digest: readDigestConfig_ parses Format (col F) with the legacy 5-col fallback', function () {
  install([], [
    ['mgr@x.com',  'Alpha', 'monthly', true, '', 'insights'],
    ['mgr2@x.com', 'Alpha', 'weekly',  true, ''],            // legacy row, no col F
  ]);
  const cfg = h.call('readDigestConfig_');
  assert.equal(cfg.length, 2);
  assert.equal(cfg[0].cadence, 'monthly');
  assert.equal(cfg[0].format,  'insights');
  assert.equal(cfg[1].cadence, 'weekly');
  assert.equal(cfg[1].format,  'summary');                    // empty F -> default
});

test('digest: deep link primes the Insights report in the share-state format', function () {
  install([]);
  // Unset DASHBOARD_URL -> '' (caller falls back to the generic link path).
  delete h.state.props.DASHBOARD_URL;
  assert.equal(h.call('digestDeepLink_', 'Alpha', '2026-05-01', '2026-05-31', 'monthly'), '');

  h.state.props.DASHBOARD_URL = 'https://script.google.com/a/macros/x/exec#old';
  const link = h.call('digestDeepLink_', 'Alpha', '2026-05-01', '2026-05-31', 'monthly');
  // Existing fragment stripped; share-state route + params appended.
  assert.ok(link.indexOf('/exec#/report/insights?') !== -1, 'route present, old fragment stripped');
  assert.ok(link.indexOf('from=2026-05-01') !== -1 && link.indexOf('to=2026-05-31') !== -1);
  assert.ok(link.indexOf('agents=' + encodeURIComponent('Anna|Ben')) !== -1, 'full roster selection');
  // Monthly cadence -> custom prior window = previous calendar month.
  assert.ok(link.indexOf('mode=custom') !== -1);
  assert.ok(link.indexOf('pfrom=2026-04-01') !== -1 && link.indexOf('pto=2026-04-30') !== -1);

  // Daily cadence: INV-28 auto-adjacent -> no custom prior params.
  const daily = h.call('digestDeepLink_', 'Alpha', '2026-05-12', '2026-05-12', 'daily');
  assert.ok(daily.indexOf('mode=custom') === -1);
});

test('digest: insights-format body carries the rollup + per-agent deltas vs the prior month', function () {
  install([
    // Current window: May 2026.
    dqeRow({ date: '2026-05-12', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00' }),
    dqeRow({ date: '2026-05-13', agent: 'Ben',  ext: '501', rung: 6,  missed: 2, answered: 4, att: '0:02:00' }),
    // Prior window: April 2026 (Anna only).
    dqeRow({ date: '2026-04-10', agent: 'Anna', ext: '501', rung: 4,  missed: 2, answered: 3, att: '0:04:00' }),
  ]);
  const html = h.call('digestInsightsHtml_', 'Alpha', '2026-05-01', '2026-05-31', 'monthly');
  assert.ok(html.indexOf('Department rollup') !== -1, 'rollup section present');
  assert.ok(html.indexOf('Per-agent') !== -1, 'per-agent section present');
  assert.ok(html.indexOf('Anna') !== -1 && html.indexOf('Ben') !== -1, 'both roster agents render');
  // Anna's rung went 4 -> 10 (+150%): an up-arrow delta should render.
  assert.ok(html.indexOf('&#9650;') !== -1, 'an up-delta arrow renders');
  // Prior label is the previous calendar month, not the INV-28 auto window.
  assert.ok(html.indexOf('Apr') !== -1, 'prior label names April');
});
