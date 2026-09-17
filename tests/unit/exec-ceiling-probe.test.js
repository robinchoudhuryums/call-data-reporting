'use strict';

// P-3 (broad-scan 2026-09-17): the repo carried two execution-ceiling beliefs
// (30 min vs 6 min). The ceiling is MEASURED by a one-shot trigger probe, and
// the two time budgets it governs became Script-Property-tunable so they can
// be aligned without a redeploy. These pins hold the pure verdict and the
// bounded property reads.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ project: 'cdr-import', files: ['execCeilingProbe.js', 'autoImport.js', 'inboundCalls.js'] });
const verdict = h.fn('execCeilingVerdict_');

test('verdict: a killed probe names the ceiling and a budget ~2 min under it', function () {
  const startedIso = new Date(Date.now() - 60 * 60000).toISOString();   // an hour ago: long over
  const v = verdict('358000', null, startedIso, Date.now());
  assert.equal(v.verdict, 'KILLED');
  assert.equal(v.ceilingMs, 358000);
  assert.equal(v.recommendMs, 240000, '~6 min ceiling -> a 4-min budget');
  assert.match(v.text, /killed the probe at ~358 s \(~6 min\)/);
  assert.match(v.text, /BULK_TIME_LIMIT_MS and IC_BACKFILL_TIME_LIMIT_MS to 240000/);
  assert.match(v.text, /NEON_MIRROR_BUDGET_MS .* already right/);
});

test('verdict: a probe that finished says the ceiling is above the max; no data / still running are distinct', function () {
  assert.equal(verdict(null, 'ran the full 40 min without being killed', null, Date.now()).verdict, 'ABOVE-MAX');
  assert.equal(verdict(null, null, null, Date.now()).verdict, 'NO-DATA');
  const now = Date.now();
  const running = verdict(String(20000), null, new Date(now - 25000).toISOString(), now);
  assert.equal(running.verdict, 'RUNNING', 'elapsed still tracking the clock = still alive');
});

test('the two budgets read their Script Property, default when unset, and stay inside [1 min, 40 min]', function () {
  delete h.state.props.BULK_TIME_LIMIT_MS;
  assert.equal(h.call('bulkTimeLimitMs_'), 900000, 'default 15 min');
  h.state.props.BULK_TIME_LIMIT_MS = '240000';
  assert.equal(h.call('bulkTimeLimitMs_'), 240000);
  h.state.props.BULK_TIME_LIMIT_MS = '5';
  assert.equal(h.call('bulkTimeLimitMs_'), 60000, 'floored at 1 min');
  h.state.props.BULK_TIME_LIMIT_MS = 'abc';
  assert.equal(h.call('bulkTimeLimitMs_'), 900000, 'garbage -> default');
  delete h.state.props.IC_BACKFILL_TIME_LIMIT_MS;
  assert.equal(h.call('icBackfillTimeLimitMs_'), 900000);
  h.state.props.IC_BACKFILL_TIME_LIMIT_MS = String(60 * 60000);
  assert.equal(h.call('icBackfillTimeLimitMs_'), 40 * 60000, 'capped at 40 min');
});
