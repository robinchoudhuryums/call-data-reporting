'use strict';

// Neon keep-warm (NeonKeepWarm.gs, Operator State #20). The only dashboard
// file no suite loaded.
//
// This engine is COST-shaped rather than correctness-shaped, which is exactly
// why it needs a guard: every failure mode here is silent. Neon's free tier
// suspends the compute after ~5 min idle, so the trigger pings it every 5
// minutes -- but ONLY inside a weekday business-hours window, because the
// default 6h x ~22 weekdays budget sits just under the ~190h free allowance.
// A gate that stops closing pings 24/7 and blows the allowance; a gate that
// closes too eagerly silently stops warming and every reader pays cold-start
// again. Neither throws, neither shows up on the Health page, and the trigger
// keeps reporting itself as installed either way.
//
// So the assertions are about ONE observable: did this invocation open a Neon
// connection? Everything else (weekday, window, flag, property parsing) is
// upstream of that.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({
  project: 'dashboard',
  files: ['Config.gs', 'NeonKeepWarm.gs'],
  capture: ['TZ', 'NEON_KEEPWARM_EVERY_MINUTES',
            'NEON_KEEPWARM_DEFAULT_START_HOUR', 'NEON_KEEPWARM_DEFAULT_END_HOUR'],
});
const TZ = h.consts.TZ;

// NeonKeepWarm calls this helper from Alerts.gs, which we do not load.
h.ctx.logStatusReturn_ = function (s) { return s; };

// ── Pinning "now" to a WALL-CLOCK hour in the script timezone ─────────────
// The gate reads Utilities.formatDate(now, TZ, 'u'/'H'), so a test that
// constructs a Date in the HOST zone asserts against whatever offset the
// runner happens to have (UTC here). Instead: search the 24 UTC hours of the
// target day for the instant whose TZ-local hour and ISO weekday are the ones
// we want. Offset- and DST-independent by construction.
function instantAt(y, mon, day, tzHour) {
  // Scan a 72-hour UTC span centred on the target day: a TZ-local evening
  // lands on the FOLLOWING UTC day (Chicago is UTC-5/-6), so a search bounded
  // to the same UTC date silently cannot reach it.
  const fmt = h.shim.globals.Utilities.formatDate;
  const base = Date.UTC(y, mon - 1, day, 0, 30, 0) - 24 * 3600 * 1000;
  for (let i = 0; i < 72; i++) {
    const cand = new Date(base + i * 3600 * 1000);
    if (Number(fmt(cand, TZ, 'H')) === tzHour
        && Number(fmt(cand, TZ, 'd')) === day
        && Number(fmt(cand, TZ, 'M')) === mon) {
      return cand;
    }
  }
  throw new Error('no instant maps to ' + tzHour + ':30 ' + TZ + ' on '
    + y + '-' + mon + '-' + day);
}

// Runs keepNeonWarm_ at a pinned instant with a spy on the connection getter.
// Returns { opened, closed, result } -- `opened` is the cost signal.
function runAt(date, opts) {
  opts = opts || {};
  let opened = 0, closed = 0, lastArgs = null;
  const RealDate = h.ctx.Date;
  function FakeDate() {
    if (arguments.length === 0) return new RealDate(date.getTime());
    return new RealDate(...arguments);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.now = function () { return date.getTime(); };

  h.ctx.Date = FakeDate;
  h.ctx.getDashboardNeonConn_ = function (args) {
    opened++; lastArgs = args;
    if (opts.connThrows) throw new Error('boom');
    if (opts.unreachable) return null;
    return {
      createStatement: function () {
        return {
          executeQuery: function () {
            if (opts.queryThrows) throw new Error('query failed');
            return { close: function () {} };
          },
          close: function () {},
        };
      },
      close: function () { closed++; },
    };
  };
  try {
    h.fn('keepNeonWarm_')();
  } finally {
    h.ctx.Date = RealDate;
  }
  return {
    opened: opened, closed: closed, connArgs: lastArgs,
    result: h.state.props.NEON_KEEPWARM_LAST_RESULT,
    stamp: h.state.props.NEON_KEEPWARM_LAST,
  };
}

function reset(props) {
  Object.keys(h.state.props).forEach(function (k) { delete h.state.props[k]; });
  Object.assign(h.state.props, props || {});
}

// A weekday and a weekend day in the same week (2026-08-31 is a Monday).
const MON = [2026, 8, 31];
const SAT = [2026, 9, 5];
const SUN = [2026, 9, 6];

// ── The cost gate: when is a connection opened at all? ────────────────────

test('flag off: no connection is opened, whatever the clock says', function () {
  reset({});   // NEON_KEEPWARM_ENABLED unset
  const out = runAt(instantAt(MON[0], MON[1], MON[2], 9));
  assert.equal(out.opened, 0,
    'an unenabled keep-warm must cost nothing -- the trigger fires '
    + 'project-wide every few minutes');
});

test('flag set to anything other than the exact string "true" does not enable it', function () {
  ['TRUE', 'yes', '1', 'True', ''].forEach(function (v) {
    reset({ NEON_KEEPWARM_ENABLED: v });
    assert.equal(runAt(instantAt(MON[0], MON[1], MON[2], 9)).opened, 0,
      'value ' + JSON.stringify(v) + ' should not enable the engine');
  });
});

test('enabled + weekday + inside the window: a connection IS opened', function () {
  reset({ NEON_KEEPWARM_ENABLED: 'true' });
  const out = runAt(instantAt(MON[0], MON[1], MON[2], 9));   // default window 7..13
  assert.equal(out.opened, 1);
  assert.equal(out.result, 'ok');
  assert.equal(out.closed, 1, 'the connection must be closed, or the ping leaks one every 5 min');
});

test('weekends are skipped even when enabled and inside the hour window', function () {
  [SAT, SUN].forEach(function (day) {
    reset({ NEON_KEEPWARM_ENABLED: 'true' });
    const out = runAt(instantAt(day[0], day[1], day[2], 9));
    assert.equal(out.opened, 0, 'day ' + day.join('-') + ' is a weekend');
  });
});

test('the hour window is HALF-OPEN: start hour pings, end hour does not', function () {
  const start = h.consts.NEON_KEEPWARM_DEFAULT_START_HOUR;
  const end   = h.consts.NEON_KEEPWARM_DEFAULT_END_HOUR;

  reset({ NEON_KEEPWARM_ENABLED: 'true' });
  assert.equal(runAt(instantAt(MON[0], MON[1], MON[2], start)).opened, 1,
    'the start hour is inside the window');

  reset({ NEON_KEEPWARM_ENABLED: 'true' });
  assert.equal(runAt(instantAt(MON[0], MON[1], MON[2], end)).opened, 0,
    'the end hour is OUTSIDE -- an inclusive end silently widens the monthly '
    + 'budget by a full hour a day');

  reset({ NEON_KEEPWARM_ENABLED: 'true' });
  assert.equal(runAt(instantAt(MON[0], MON[1], MON[2], start - 1)).opened, 0);
  reset({ NEON_KEEPWARM_ENABLED: 'true' });
  assert.equal(runAt(instantAt(MON[0], MON[1], MON[2], end + 1)).opened, 0);
});

test('a custom window is honoured', function () {
  reset({ NEON_KEEPWARM_ENABLED: 'true',
          NEON_KEEPWARM_START_HOUR: '10', NEON_KEEPWARM_END_HOUR: '12' });
  assert.equal(runAt(instantAt(MON[0], MON[1], MON[2], 9)).opened, 0);
  reset({ NEON_KEEPWARM_ENABLED: 'true',
          NEON_KEEPWARM_START_HOUR: '10', NEON_KEEPWARM_END_HOUR: '12' });
  assert.equal(runAt(instantAt(MON[0], MON[1], MON[2], 11)).opened, 1);
});

// ── Property parsing: a typo must NARROW to the default, never widen ──────

test('an unparseable or out-of-range hour property falls back to the default', function () {
  // The cost failure mode: if a typo'd property parsed as NaN and the
  // comparison silently passed, the window would become all day.
  const hourOf = h.fn('neonKeepWarmHour_');
  const dflt = h.consts.NEON_KEEPWARM_DEFAULT_START_HOUR;
  ['', null, undefined, 'abc', '-1', '24', '99', '7.5abc', ' '].forEach(function (raw) {
    const got = hourOf(raw, dflt);
    assert.equal(got, dflt, JSON.stringify(raw) + ' must fall back to the default');
  });
  assert.equal(hourOf('0', dflt), 0, 'midnight is a legal hour, not a falsy miss');
  assert.equal(hourOf('23', dflt), 23);
});

test('a garbage window property cannot widen the window to 24/7', function () {
  reset({ NEON_KEEPWARM_ENABLED: 'true',
          NEON_KEEPWARM_START_HOUR: 'oops', NEON_KEEPWARM_END_HOUR: 'oops' });
  // Falls back to the 7..13 default, so 3 AM is still outside.
  assert.equal(runAt(instantAt(MON[0], MON[1], MON[2], 3)).opened, 0);
});

// ── Outcome recording + best-effort contract ─────────────────────────────

test('NEO-3: the ping asks for skipReadHealth so it cannot pollute the DQE read streak', function () {
  // Keep-warm runs independently of DQE_READ_SOURCE. If its pings recorded
  // read health, a keep-warm failure would masquerade as a DQE read-back
  // failure -- and that warning is never cleared on the sheet path, so it
  // would be sticky and misleading.
  reset({ NEON_KEEPWARM_ENABLED: 'true' });
  const out = runAt(instantAt(MON[0], MON[1], MON[2], 9));
  assert.ok(out.connArgs && out.connArgs.skipReadHealth === true,
    'getDashboardNeonConn_ must be called with { skipReadHealth: true }');
});

test('an unreachable Neon records "unreachable" and does not throw', function () {
  reset({ NEON_KEEPWARM_ENABLED: 'true' });
  let out;
  assert.doesNotThrow(function () {
    out = runAt(instantAt(MON[0], MON[1], MON[2], 9), { unreachable: true });
  });
  assert.equal(out.result, 'unreachable');
  assert.ok(out.stamp, 'the last-ping stamp is what the Alerts modal shows');
});

test('a failing query records an error outcome and still CLOSES the connection', function () {
  reset({ NEON_KEEPWARM_ENABLED: 'true' });
  const out = runAt(instantAt(MON[0], MON[1], MON[2], 9), { queryThrows: true });
  assert.match(out.result, /^error: /);
  assert.equal(out.closed, 1, 'the finally block must close it even on a query failure');
});

test('the handler never throws, even when the connection getter itself does', function () {
  // A trigger handler that throws produces a failed-execution email every 5
  // minutes during business hours.
  reset({ NEON_KEEPWARM_ENABLED: 'true' });
  assert.doesNotThrow(function () {
    runAt(instantAt(MON[0], MON[1], MON[2], 9), { connThrows: true });
  });
});

// ── Status read (the Alerts modal's line) ────────────────────────────────

test('the status estimate tracks the configured window, not the default', function () {
  reset({ NEON_KEEPWARM_ENABLED: 'true',
          NEON_KEEPWARM_START_HOUR: '8', NEON_KEEPWARM_END_HOUR: '10',
          NEON_HOST: 'db.example' });
  const st = h.fn('getNeonKeepWarmStatus_')();
  assert.equal(st.enabled, true);
  assert.equal(st.startHour, 8);
  assert.equal(st.endHour, 10);
  assert.equal(st.neonConfigured, true);
  assert.equal(st.estMonthlyHours, 2 * 22,
    'the monthly estimate is what an admin sizes against the free allowance');
});

test('an inverted window reports ZERO estimated hours rather than a negative', function () {
  reset({ NEON_KEEPWARM_START_HOUR: '13', NEON_KEEPWARM_END_HOUR: '7' });
  const st = h.fn('getNeonKeepWarmStatus_')();
  assert.equal(st.estMonthlyHours, 0);
});

test('an inverted window also pings NOTHING (no hour satisfies it)', function () {
  reset({ NEON_KEEPWARM_ENABLED: 'true',
          NEON_KEEPWARM_START_HOUR: '13', NEON_KEEPWARM_END_HOUR: '7' });
  [3, 9, 15, 20].forEach(function (hr) {
    assert.equal(runAt(instantAt(MON[0], MON[1], MON[2], hr)).opened, 0,
      'hour ' + hr + ' must not ping under an inverted window');
  });
});
