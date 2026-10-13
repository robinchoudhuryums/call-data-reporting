'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const crypto = require('crypto');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Data.gs'] });

function nodeMd5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

test('hashAgents_ is order-insensitive (INV-36)', function () {
  assert.equal(h.call('hashAgents_', ['Bob', 'Alice']), h.call('hashAgents_', ['Alice', 'Bob']));
});

test('hashAgents_ returns a 32-char lowercase hex digest', function () {
  const hex = h.call('hashAgents_', ['Alice', 'Bob', 'Carol']);
  assert.match(hex, /^[0-9a-f]{32}$/);
});

test('hashAgents_ matches a real MD5 of the sorted, pipe-joined list', function () {
  assert.equal(h.call('hashAgents_', ['Bob', 'Alice']), nodeMd5('Alice|Bob'));
  assert.equal(h.call('hashAgents_', ['Carol', 'Alice', 'Bob']), nodeMd5('Alice|Bob|Carol'));
});

test('hashAgents_ handles empty / missing input (bounded key, INV-36)', function () {
  assert.equal(h.call('hashAgents_', []), nodeMd5(''));
  assert.equal(h.call('hashAgents_', null), nodeMd5(''));
  assert.equal(h.call('hashAgents_', undefined), nodeMd5(''));
});

test('hashAgents_ keeps the key bounded for a large selection', function () {
  const big = [];
  for (let i = 0; i < 200; i++) big.push('Agent Name Number ' + i);
  const hex = h.call('hashAgents_', big);
  assert.equal(hex.length, 32);   // never grows with selection size
});

// DL-5 (broad-scan 2026-10-01): the roster is a cache dimension on every 6 h
// key whose payload is a roster's agents (D-7's rule, extended). The freshness
// tag does not move when `DO NOT EDIT!` is edited, so without it a new hire or
// a removal stayed invisible for up to the TTL.
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

function installRosters(map) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': rosterGrid(map) } });
}

test('DL-5: rosterSetHash_ -- one dept hashes as D-7 did; a set moves when ANY member roster moves', function () {
  installRosters({ Sales: ['Ann, 101', 'Bob, 102'], PAP: ['Cat, 201'] });
  assert.equal(h.call('rosterSetHash_', ['Sales']), h.call('hashAgents_', ['Ann', 'Bob']),
    'single-dept keys are byte-identical to D-7');
  const before = h.call('rosterSetHash_', ['Sales', 'PAP']);
  installRosters({ Sales: ['Ann, 101', 'Bob, 102'], PAP: ['Cat, 201', 'Dee, 202'] });
  assert.notEqual(h.call('rosterSetHash_', ['Sales', 'PAP']), before, 'a CHILD roster edit moves the combined key');
  assert.equal(h.call('rosterSetHash_', ['Sales']), h.call('hashAgents_', ['Ann', 'Bob']), 'the parent alone is unaffected');
  // An agent moving between two depts in the set changes the pairs, not just the names.
  installRosters({ Sales: ['Ann, 101'], PAP: ['Bob, 102', 'Cat, 201', 'Dee, 202'] });
  const moved = h.call('rosterSetHash_', ['Sales', 'PAP']);
  installRosters({ Sales: ['Ann, 101', 'Bob, 102'], PAP: ['Cat, 201', 'Dee, 202'] });
  assert.notEqual(h.call('rosterSetHash_', ['Sales', 'PAP']), moved);
});

test('DL-5: rosterAllDeptsHash_ moves on any dept\'s edit, from ONE range read; a missing sheet is "na"', function () {
  installRosters({ CSR: ['Ann, 101'], Sales: ['Bob, 102'] });
  const a = h.call('rosterAllDeptsHash_');
  assert.match(a, /^[0-9a-f]{32}$/);
  installRosters({ CSR: ['Ann, 101'], Sales: ['Bob, 102', 'Cat, 103'] });
  assert.notEqual(h.call('rosterAllDeptsHash_'), a);
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  assert.equal(h.call('rosterAllDeptsHash_'), 'na');
});

test('DL-5: summary (whole set), individual, both missed keys and the Overview YTD chart carry the roster', function () {
  const fs = require('fs'), path = require('path');
  const dash = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
  const src = function (f) { return fs.readFileSync(path.join(dash, f), 'utf8'); };
  assert.match(src('Data.gs'), /const rosterHash = rosterSetHash_\(deptSet\);/);
  assert.match(src('Data.gs'), /'summary:v\d+:'[\s\S]{0,300}\+ ':' \+ rosterHash;/);
  assert.match(src('IndividualReport.gs'), /INDIVIDUAL_CACHE_KEY_PREFIX \+ ':'[\s\S]{0,600}rosterSetHash_\(\[dept\]\);/);
  const missedKeys = src('MissedCallsReport.gs').match(/const cacheKey = 'missed:v\d+:[^;]+;/g) || [];
  assert.equal(missedKeys.length, 2, 'the section and the drill share one key shape');
  missedKeys.forEach(function (k) { assert.match(k, /rosterSetHash_\(\[dept\]\)/); });
  assert.match(src('CompanyOverview.gs'), /OVERVIEW_CHART_TREND_CACHE_PREFIX \+ ':'[^;]+rosterAllDeptsHash_\(\)/);
});

// DATA-1 / DATA-2 / DATA-10 (broad-scan 2026-10-12): the three 6 h keys DL-5
// missed -- the Overview blob, an explicit-pick Insights run and the agent
// app's team + history blobs -- carry the roster too.
test('DATA-1: the Overview key moves on ANY dept\'s roster edit (behavioural, through the one key helper)', function () {
  const ho = loadGas({ files: ['Config.gs', 'Util.gs', 'Data.gs', 'CompanyOverview.gs'] });
  ho.state.props.SPREADSHEET_ID = 'fake';
  ho.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': rosterGrid({ CSR: ['Ann, 101'], Sales: ['Bob, 102'] }) } });
  ho.ctx.reportFreshnessTag_ = function () { return '2026-10-09'; };   // hold every other dimension still
  ho.ctx.ROSTER_BLOCK_MEMO_ = null;
  const a = ho.call('overviewCacheKey_');
  assert.match(a, /:[0-9a-f]{32}$/, 'ends in the all-dept roster hash');
  ho.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': rosterGrid({ CSR: ['Ann, 101'], Sales: ['Bob, 102', 'Cat, 103'] }) } });
  ho.ctx.ROSTER_BLOCK_MEMO_ = null;   // per-execution memo: a new request
  assert.notEqual(ho.call('overviewCacheKey_'), a, 'a Sales hire mints a new Overview key');
  assert.ok(a.length <= 250, 'INV-36: still under the CacheService key cap');
});

test('DATA-2 / DATA-10: Insights and the agent app\'s team + history keys carry the dept roster', function () {
  const fs = require('fs'), path = require('path');
  const dash = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
  const src = function (f) { return fs.readFileSync(path.join(dash, f), 'utf8'); };
  assert.match(src('InsightsReport.gs'), /const cacheKey = INSIGHTS_CACHE_KEY_PREFIX[^;]+hashAgents_\(\(roster && roster\.names\) \|\| \[\]\);/);
  const ah = src('AgentHome.gs');
  assert.match(ah, /tag = tag \+ ':' \+ \(\(typeof rosterSetHash_ === 'function'\) \? rosterSetHash_\(\[who\.dept\]\) : 'na'\);[\s\S]{0,400}var teamKey = AGENT_HOME_CACHE_PREFIX_ \+ ':team:'[^;]+tag;/);
  assert.match(ah, /var key = 'agentHist:v1:'[^;]+rosterSetHash_\(\[who\.dept\]\)/);
});

// DATA-6 (broad-scan 2026-10-12): the two keys that EMBED queue data carry the
// latest QCD date, so a QCD landing (or a force re-import) after the DQE date
// mints a new key instead of serving the old Queue panel for the 6 h TTL.
test('DATA-6: summary and Insights keys carry the QCD freshness tag; the tag follows the latest QCD date', function () {
  const fs = require('fs'), path = require('path');
  const dash = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
  const src = function (f) { return fs.readFileSync(path.join(dash, f), 'utf8'); };
  assert.match(src('Data.gs'), /'summary:v\d+:'[\s\S]{0,400}\+ ':q' \+ qcdFreshnessTag_\(\)/);
  assert.match(src('InsightsReport.gs'), /const cacheKey = INSIGHTS_CACHE_KEY_PREFIX[^;]+\+ ':q' \+ qcdFreshnessTag_\(\)/);
  const hu = loadGas({ files: ['Config.gs', 'Util.gs'] });
  hu.ctx.qcdAllFreshnessAnchor_ = function () { return '2026-10-09'; };
  assert.equal(hu.call('qcdFreshnessTag_'), '2026-10-09');
  hu.ctx.qcdAllFreshnessAnchor_ = function () { throw new Error('read failed'); };
  assert.equal(hu.call('qcdFreshnessTag_'), 'na', 'a failure degrades to the unanchored key, never a throw');
  delete hu.ctx.qcdAllFreshnessAnchor_;
  assert.equal(hu.call('qcdFreshnessTag_'), 'na', 'QCDReport.gs absent (selective load) -> na');
});
