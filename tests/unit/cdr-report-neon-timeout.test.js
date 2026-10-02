'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

// CR-6 (broad-scan 2026-10-01): cdr-report's shared reader factory,
// dbHistorical.js::getNeonConn() -- behind the 9 AM Inbound / Outbound exports,
// the insurer sync and dbReporting -- bounded no statement, so a hang ran to the
// execution ceiling, whose kill skips the callers' catch blocks and records
// nothing. The factory now returns a wrapper that sets setQueryTimeout on every
// statement. (Dashboard twin: neon-conn-memo.test.js, DL-3.)

const h = loadGas({ project: 'cdr-report', files: ['dbHistorical.js'] });

test('CR-6: every statement from getNeonConn() carries setQueryTimeout(240)', function () {
  const timeouts = [];
  const stmt = function () { return { setQueryTimeout: function (s) { timeouts.push(s); } }; };
  const raw = { prepareStatement: stmt, createStatement: stmt, setAutoCommit: function () {},
                commit: function () {}, rollback: function () {}, close: function () { raw.closed = true; } };
  h.state.props = { NEON_HOST: 'h', NEON_DB: 'd', NEON_USER: 'u', NEON_PASS: 'p' };
  h.ctx.Jdbc = { getConnection: function () { return raw; } };
  const conn = h.call('getNeonConn');
  assert.ok(conn.__cdrTimed, 'the wrapper, not the raw connection');
  conn.prepareStatement('SELECT 1');
  conn.createStatement();
  assert.deepEqual(timeouts, [240, 240]);
  conn.close();
  assert.equal(raw.closed, true, 'close reaches the real connection');
  // A driver without setQueryTimeout is not an error.
  h.ctx.Jdbc = { getConnection: function () { return { prepareStatement: function () { return {}; }, close: function () {} }; } };
  assert.doesNotThrow(function () { h.call('getNeonConn').prepareStatement('x'); });
});

test('CR-6: the wrapper forwards every Connection method a getNeonConn() caller uses -- a seventh fails here first', function () {
  const dir = path.join(__dirname, '..', '..', 'apps-script', 'cdr-report');
  const forwarded = ['prepareStatement', 'createStatement', 'setAutoCommit', 'commit', 'rollback', 'close'];
  const callers = fs.readdirSync(dir).filter(function (f) {
    return /\.js$/.test(f) && /\bgetNeonConn\(\)/.test(fs.readFileSync(path.join(dir, f), 'utf8'));
  });
  ['dbHistorical.js', 'dbReporting.js', 'inboundCallsExport.js', 'outboundCallsExport.js', 'insuranceNumbers.js']
    .forEach(function (f) { assert.ok(callers.indexOf(f) !== -1, f + ' should still be a getNeonConn() caller'); });
  const used = {};
  callers.forEach(function (f) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /\bconn\.([A-Za-z_]+)\(/g;
    let m;
    while ((m = re.exec(src)) !== null) used[m[1]] = f;
  });
  const unforwarded = Object.keys(used).filter(function (k) { return forwarded.indexOf(k) === -1; });
  assert.deepEqual(unforwarded, [], 'add these to cdrTimedConn_ (dbHistorical.js): '
    + unforwarded.map(function (k) { return k + ' (' + used[k] + ')'; }).join(', '));
});
