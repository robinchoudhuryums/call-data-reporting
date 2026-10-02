'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Per-EXECUTION Neon-unreachable memo (NeonRead.gs::getDashboardNeonConn_).
// ~54 dashboard callsites open their own connection through this builder; a
// Neon-down request used to pay a 15-25s connect failure at EVERY one
// (measured: a 53.7s getQcdAllDepartments that was mostly failed handshakes).
// Pinned:
//   (1) after the first hard connect failure, later calls in the same
//       execution return null WITHOUT attempting a connect;
//   (2) it is per-execution state (a plain var), never CacheService -- a
//       fresh execution probes again, so recovery is never masked;
//   (3) a memoized skip still feeds the NEO-3 read-health line when the
//       caller passes {recordReadHealth:true};
//   (4) a SUCCESSFUL connect never trips it, and an unset NEON_HOST does
//       not either (unconfigured != unreachable).

const h = loadGas({ files: ['NeonRead.gs'] });

function install(opts) {
  opts = opts || {};
  h.ctx.NEON_CONN_DOWN_MEMO_ = null;          // fresh "execution"
  h.state.props.NEON_HOST = opts.host === undefined ? 'db.neon.tech' : opts.host;
  h.state.props.NEON_DB = 'db'; h.state.props.NEON_USER = 'u'; h.state.props.NEON_PASS = 'p';
  install.attempts = 0;
  h.ctx.Jdbc = {
    getConnection: function () {
      install.attempts++;
      if (opts.fail) throw new Error('Failed to establish a database connection.');
      return { close: function () {} };
    },
  };
  install.recorded = [];
  h.ctx.recordNeonReadFailure_ = function (where, e) {
    install.recorded.push(String(e && e.message ? e.message : e));
  };
}

test('memo: one failed connect per execution -- later calls skip the attempt', function () {
  install({ fail: true });
  assert.equal(h.call('getDashboardNeonConn_'), null);
  assert.equal(h.call('getDashboardNeonConn_'), null);
  assert.equal(h.call('getDashboardNeonConn_'), null);
  assert.equal(install.attempts, 1, 'exactly one real connect attempt');
});

test('memo: a fresh execution probes again (recovery never masked)', function () {
  install({ fail: true });
  h.call('getDashboardNeonConn_');
  assert.equal(install.attempts, 1);
  // "Next execution": the memo var resets (Apps Script globals are
  // per-execution) and Neon has recovered.
  h.ctx.NEON_CONN_DOWN_MEMO_ = null;
  h.ctx.Jdbc = { getConnection: function () { install.attempts++; return { close: function () {} }; } };
  assert.ok(h.call('getDashboardNeonConn_'), 'recovered connection served');
  assert.equal(install.attempts, 2);
});

test('memo: a memoized skip still records read health when asked (NEO-3)', function () {
  install({ fail: true });
  h.call('getDashboardNeonConn_');                              // trips the memo, no flag
  assert.equal(install.recorded.length, 0);
  h.call('getDashboardNeonConn_', { recordReadHealth: true });  // memoized DQE reader
  assert.equal(install.recorded.length, 1);
  assert.match(install.recorded[0], /memoized this execution/);
  assert.match(install.recorded[0], /Failed to establish/);
});

test('memo: success never trips it; unset NEON_HOST never trips it', function () {
  install({ fail: false });
  assert.ok(h.call('getDashboardNeonConn_'));
  assert.ok(h.call('getDashboardNeonConn_'));
  assert.equal(install.attempts, 2, 'healthy path unchanged -- no memoization of success');
  assert.equal(h.ctx.NEON_CONN_DOWN_MEMO_, null);
  install({ host: null });
  assert.equal(h.call('getDashboardNeonConn_'), null);
  assert.equal(h.ctx.NEON_CONN_DOWN_MEMO_, null, 'unconfigured != unreachable');
  assert.equal(install.attempts, 0);
});

// DL-3 (broad-scan 2026-10-01): no dashboard Neon read bounded its statements,
// so a lock wait ran to the execution ceiling, whose kill skips the sheet
// fallback. The factory now hands back a wrapper that bounds every statement.
test('DL-3: every statement from getDashboardNeonConn_ carries setQueryTimeout (default 120 s, override per caller)', function () {
  const timeouts = [];
  const stmt = function () { return { setQueryTimeout: function (s) { timeouts.push(s); } }; };
  const raw = { prepareStatement: stmt, createStatement: stmt, setAutoCommit: function () {},
                commit: function () {}, rollback: function () {}, close: function () { raw.closed = true; } };
  h.state.props = { NEON_HOST: 'h', NEON_DB: 'd', NEON_USER: 'u', NEON_PASS: 'p' };
  h.ctx.NEON_CONN_DOWN_MEMO_ = null;
  h.ctx.Jdbc = { getConnection: function () { return raw; } };
  const conn = h.call('getDashboardNeonConn_');
  assert.ok(conn.__neonTimed, 'the wrapper, not the raw connection');
  conn.prepareStatement('SELECT 1');
  conn.createStatement();
  assert.deepEqual(timeouts, [120, 120]);
  conn.close();
  assert.equal(raw.closed, true, 'close reaches the real connection');
  h.call('getDashboardNeonConn_', { queryTimeoutS: 240 }).createStatement();
  assert.equal(timeouts[2], 240);
  // A driver without setQueryTimeout (older shims) is not an error.
  h.ctx.Jdbc = { getConnection: function () { return { prepareStatement: function () { return {}; }, close: function () {} }; } };
  assert.doesNotThrow(function () { h.call('getDashboardNeonConn_').prepareStatement('x'); });
});

test('DL-3: the wrapper forwards every method the dashboard calls on a connection -- a seventh fails here first', function () {
  const fs = require('fs'), path = require('path');
  const dash = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
  const forwarded = ['prepareStatement', 'createStatement', 'setAutoCommit', 'commit', 'rollback', 'close'];
  const used = {};
  fs.readdirSync(dash).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (f) {
    const src = fs.readFileSync(path.join(dash, f), 'utf8');
    const re = /\b(?:conn|sharedNeonConn)\.([A-Za-z_]+)\(/g;
    let m;
    while ((m = re.exec(src)) !== null) used[m[1]] = f;
  });
  const unforwarded = Object.keys(used).filter(function (k) { return forwarded.indexOf(k) === -1; });
  assert.deepEqual(unforwarded, [], 'add these to neonTimedConn_ (NeonRead.gs): '
    + unforwarded.map(function (k) { return k + ' (' + used[k] + ')'; }).join(', '));
  const src = fs.readFileSync(path.join(dash, 'NeonBackup.gs'), 'utf8');
  assert.match(src, /getDashboardNeonConn_\(\{ queryTimeoutS: NB_QUERY_TIMEOUT_S_ \}\)/, 'the backup asks for its longer bound');
});
