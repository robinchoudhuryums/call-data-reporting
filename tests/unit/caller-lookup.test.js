'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

// Caller Lookup (dashboard) -- the cross-project hash parity is the load-
// bearing contract: the dashboard's normalize+hash must produce the exact
// caller_hash the import pipeline wrote, or every lookup silently returns
// zero matches.
const dash = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'CallerLookup.gs'],
});
const imp = loadGas({ project: 'cdr-import', files: ['neonWrite.js'] });

function installAdmin() {
  dash.state.userEmail = 'admin@x.com';
  dash.state.props.ADMIN_EMAILS = 'admin@x.com';
  dash.state.props.SPREADSHEET_ID = 'fake';
  dash.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': rosterGrid({ Alpha: ['Anna, 201'] }) },
  });
  dash.state.cache.clear();
}

test('caller lookup: hash parity with the import pipeline (cdrHashPhone_)', function () {
  const secret = 'test-secret';
  const normalized = '+12145550123';
  const fromDash = dash.call('callerLookupHashPhone_', normalized, secret);
  const fromImport = imp.call('cdrHashPhone_', normalized, secret);
  const groundTruth = crypto.createHmac('sha256', secret).update(normalized, 'utf8').digest('hex');
  assert.equal(fromDash, groundTruth, 'dashboard hash matches node-crypto HMAC');
  assert.equal(fromImport, groundTruth, 'pipeline hash matches node-crypto HMAC');
  assert.equal(fromDash, fromImport, 'cross-project parity');
});

test('caller lookup: input validation + range cap', function () {
  installAdmin();
  dash.state.props.HMAC_SECRET = 's';
  assert.throws(function () {
    dash.call('getCallerLookup', { phone: '555', from: '2026-06-01', to: '2026-06-02' });
  }, /10-15 digits/);
  assert.throws(function () {
    dash.call('getCallerLookup', { phone: '(214) 555-0123', from: 'junk', to: '2026-06-02' });
  }, /YYYY-MM-DD/);
  assert.throws(function () {
    dash.call('getCallerLookup', { phone: '(214) 555-0123', from: '2026-06-05', to: '2026-06-02' });
  }, /on or before/);
  assert.throws(function () {
    dash.call('getCallerLookup', { phone: '(214) 555-0123', from: '2024-01-01', to: '2026-06-02' });
  }, /capped/);
});

test('caller lookup: admin-only at the server boundary', function () {
  installAdmin();
  dash.state.userEmail = 'manager@x.com';   // not in ADMIN_EMAILS
  assert.throws(function () {
    dash.call('getCallerLookup', { phone: '(214) 555-0123', from: '2026-06-01', to: '2026-06-02' });
  }, /admin-only/);
});

test('caller lookup: missing HMAC_SECRET -> configured=false (no throw)', function () {
  installAdmin();
  delete dash.state.props.HMAC_SECRET;
  const out = dash.call('getCallerLookup',
    { phone: '(214) 555-0123', from: '2026-06-01', to: '2026-06-02' });
  assert.equal(out.meta.available, false);
  assert.equal(out.meta.configured, false);
  assert.equal(out.calls.length, 0);
});

test('caller lookup: Neon unavailable -> available=false (no throw)', function () {
  installAdmin();
  dash.state.props.HMAC_SECRET = 's';
  // NeonRead.gs is not loaded -> getDashboardNeonConn_ is undefined ->
  // the typeof guard returns null conn -> graceful unavailable shape.
  const out = dash.call('getCallerLookup',
    { phone: '(214) 555-0123', from: '2026-06-01', to: '2026-06-02' });
  assert.equal(out.meta.available, false);
  assert.equal(out.meta.configured, true);
});

test('caller lookup: row shaping parses journey + strips nothing it needs', function () {
  const shaped = dash.call('callerLookupShapeCall_', {
    call_date: '2026-06-04', call_start: '10:36:07', call_id: '668970',
    disposition: 'abandoned', abandon_stage: 'queue', abandoned_on_hold: false,
    hold_seconds: 0, wait_seconds: 137, entry_queue: 'A_Q_Intake',
    final_queue: 'A_Q_Intake', final_dept: null, num_queues: 1, num_transfers: 0,
    dial_in_number: '19722281820', insurer: 'Acme Health',
    journey: JSON.stringify([{ t: '10:36:07', name: 'Introduction - New', kind: 'leg', secs: 18 }]),
  });
  assert.equal(shaped.callDate, '2026-06-04');
  assert.equal(shaped.callStart, '10:36:07');
  assert.equal(shaped.insurer, 'Acme Health');
  assert.equal(shaped.waitSeconds, 137);
  assert.ok(Array.isArray(shaped.journey) && shaped.journey.length === 1);
  assert.equal(shaped.journey[0].name, 'Introduction - New');

  // Pre-extension row (no journey column) -> journey null, summary fields intact.
  const legacy = dash.call('callerLookupShapeCall_', {
    call_date: '2026-05-01', disposition: 'answered', num_queues: 2, num_transfers: 1,
    entry_queue: 'A_Q_Sales', final_queue: 'A_Q_CSR',
  });
  assert.equal(legacy.journey, null);
  assert.equal(legacy.entryQueue, 'A_Q_Sales');
  assert.equal(legacy.numTransfers, 1);
});

test('caller lookup: 10-digit entry also tries the +1-prefixed form', function () {
  const c10 = dash.call('callerLookupHashCandidates_', '2145550123');
  assert.equal(c10.length, 2);
  assert.equal(c10[0], '+2145550123');
  assert.equal(c10[1], '+12145550123');   // matches the CDR's stored form
  const c11 = dash.call('callerLookupHashCandidates_', '12145550123');
  assert.equal(c11.length, 1);
  assert.equal(c11[0], '+12145550123');
});

// ---- Option B: outbound + day-level history sections -------------------------

test('caller lookup: outbound row shaping (journey parse, connected/talk/ring)', function () {
  const shaped = dash.call('callerLookupShapeOutbound_', {
    call_date: '2026-07-22', call_start: '09:00:00', call_id: '900001',
    agent_name: 'Maria G', agent_ext: '214', department: 'CSR',
    connected: true, talk_seconds: 192, ring_seconds: 12, attempts: 1,
    journey: JSON.stringify([{ t: '09:00:00', name: '(external number)', kind: 'answer', talk: 192 }]),
  });
  assert.equal(shaped.callDate, '2026-07-22');
  assert.equal(shaped.agentName, 'Maria G');
  assert.equal(shaped.department, 'CSR');
  assert.equal(shaped.connected, true);
  assert.equal(shaped.talkSeconds, 192);
  assert.equal(shaped.ringSeconds, 12);
  assert.ok(Array.isArray(shaped.journey) && shaped.journey.length === 1);

  const noAnswer = dash.call('callerLookupShapeOutbound_', {
    call_date: '2026-07-22', call_id: '900002', connected: false, ring_seconds: 35,
  });
  assert.equal(noAnswer.connected, false);
  assert.equal(noAnswer.talkSeconds, 0);
  assert.equal(noAnswer.ringSeconds, 35);
  assert.equal(noAnswer.journey, null);
});

test('caller lookup: history folding — one entry per (date, agent); total is a superset, never summed', function () {
  const folded = dash.call('callerLookupShapeHistory_', [
    { call_date: '2026-07-03', department: 'CSR', agent_name: 'Maria G',
      list_type: 'ob_ext_list_total', duration_sec: 240, occurrences: 2 },
    { call_date: '2026-07-03', department: 'CSR', agent_name: 'Maria G',
      list_type: 'ob_ext_list_answered', duration_sec: 240, occurrences: 1 },
    { call_date: '2026-07-03', department: 'CSR', agent_name: 'Maria G',
      list_type: 'ob_ext_list_missed', duration_sec: 0, occurrences: 1 },
    { call_date: '2026-07-05', department: 'Sales', agent_name: 'Bob R',
      list_type: 'ob_ext_list_total', duration_sec: 60, occurrences: 1 },
  ]);
  assert.equal(folded.length, 2);
  const maria = folded[0];
  assert.equal(maria.callDate, '2026-07-03');
  assert.equal(maria.dialed, 2);          // from the TOTAL list only
  assert.equal(maria.answered, 1);
  assert.equal(maria.missed, 1);
  assert.equal(maria.talkSeconds, 240);   // from the ANSWERED list's duration
  assert.equal(folded[1].agentName, 'Bob R');
  assert.equal(folded[1].dialed, 1);
});

test('caller lookup: a failing outbound/history query degrades that section only (inbound intact)', function () {
  installAdmin();
  dash.state.props.HMAC_SECRET = 's';
  // Fake conn: the inbound query succeeds with one call; the outbound +
  // history queries throw (e.g. outbound_calls not created yet -- dashboard
  // deployed ahead of cdr-import).
  dash.ctx.getDashboardNeonConn_ = function () {
    return {
      prepareStatement: function (sql) {
        if (/outbound_calls|call_history_phones/.test(sql)) {
          throw new Error('relation "outbound_calls" does not exist');
        }
        return {
          setString: function () {},
          executeQuery: function () {
            let used = false;
            return {
              next: function () { if (used) return false; used = true; return true; },
              getString: function () {
                return JSON.stringify([{ call_date: '2026-06-04', call_id: '1', disposition: 'answered' }]);
              },
              close: function () {},
            };
          },
          close: function () {},
        };
      },
      close: function () {},
    };
  };
  const out = dash.call('getCallerLookup',
    { phone: '(214) 555-0123', from: '2026-06-01', to: '2026-06-05' });
  assert.equal(out.meta.available, true);
  assert.equal(out.calls.length, 1, 'inbound results survive');
  assert.equal(out.meta.outboundAvailable, false);
  assert.equal(out.meta.historyAvailable, false);
  assert.equal(out.outboundCalls.length, 0);
  assert.equal(out.outboundHistory.length, 0);
  delete dash.ctx.getDashboardNeonConn_;
});

// ── NEON-DOWN SHEET FALLBACK ───────────────────────────────────────────────
// Both export tabs carry the HMAC hash the lookup keys on (Inbound col 4,
// Outbound col 3), so the communication history survives an outage with no
// raw number stored anywhere. The day-level "Earlier outbound activity"
// section genuinely cannot fall back (no sheet primary) and must report
// itself unavailable rather than imply the caller had no earlier activity.

function clFakeTab(rows, width) {
  return {
    getLastRow: function () { return rows.length + 1; },
    getMaxColumns: function () { return width; },
    getLastColumn: function () { return width; },
    getRange: function (row, col, numRows, numCols) {
      const out = [];
      for (let i = 0; i < numRows; i++) {
        const src = rows[row - 2 + i] || [];
        const line = [];
        for (let c = 0; c < numCols; c++) {
          const v = src[col - 1 + c];
          line.push(v == null ? '' : String(v));
        }
        out.push(line);
      }
      return { getDisplayValues: function () { return out; } };
    },
  };
}

function clInstallFallback(opts) {
  opts = opts || {};
  installAdmin();
  dash.state.props.HMAC_SECRET = 'test-secret';
  dash.ctx.getDashboardNeonConn_ = function () { return opts.conn || null; };
  dash.ctx.logReportUsage_ = function () {};
  dash.ctx.ncCellDateIso_ = function (v) {
    const s = String(v == null ? '' : v).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  };
  dash.ctx.openSpreadsheet_ = function () {
    return {
      getSheetByName: function (n) {
        if (n === 'Inbound Calls') return opts.noIb ? null : clFakeTab(opts.ibRows || [], 22);
        if (n === 'Outbound Calls') return opts.noOb ? null : clFakeTab(opts.obRows || [], 12);
        return null;
      },
    };
  };
}

test('caller lookup fallback: reconstructs both sections from the export tabs by hash', function () {
  const hash = dash.call('callerLookupHashPhone_', '+12145550123', 'test-secret');
  const ib = new Array(22).fill('');
  ib[0] = '2026-08-10'; ib[1] = 'i1'; ib[2] = 'Acme Health'; ib[3] = hash;
  ib[5] = 'abandoned'; ib[10] = 'A_Q_CSR'; ib[15] = '08:00:00';
  const other = new Array(22).fill('');
  other[0] = '2026-08-10'; other[1] = 'i2'; other[3] = 'someone-else-hash'; other[5] = 'answered';
  const ob = new Array(12).fill('');
  ob[0] = '2026-08-11'; ob[1] = 'o1'; ob[2] = hash; ob[3] = 'Ann'; ob[6] = 'TRUE';
  ob[7] = '45'; ob[9] = '1'; ob[10] = '09:00:00';

  clInstallFallback({ ibRows: [ib, other], obRows: [ob] });
  const res = dash.call('getCallerLookup',
    { phone: '2145550123', from: '2026-08-01', to: '2026-08-31' });

  assert.equal(res.meta.available, true, 'the lookup still answers during an outage');
  assert.equal(res.meta.fallbackSource, 'sheet');
  assert.equal(res.meta.matches, 1, 'only the entered number\'s calls, matched by hash');
  assert.equal(res.calls[0].callId, 'i1');
  assert.equal(res.calls[0].insurer, 'Acme Health', 'the insurer label rides the tab');
  assert.equal(res.meta.outboundAvailable, true);
  assert.equal(res.meta.outboundMatches, 1);
  assert.equal(res.outboundCalls[0].callId, 'o1');
  assert.equal(res.outboundCalls[0].connected, true);
  // The day-level section has no sheet primary: unavailable, not empty-truthy.
  assert.equal(res.meta.historyAvailable, false);
  // PHI: no hash is ever echoed back to the client.
  assert.ok(JSON.stringify(res).indexOf(hash) === -1, 'the hash never leaves the server');
});

test('caller lookup fallback: a missing Outbound tab degrades only that section', function () {
  const hash = dash.call('callerLookupHashPhone_', '+12145550123', 'test-secret');
  const ib = new Array(22).fill('');
  ib[0] = '2026-08-10'; ib[1] = 'i1'; ib[3] = hash; ib[5] = 'abandoned'; ib[15] = '08:00:00';
  clInstallFallback({ ibRows: [ib], noOb: true });
  const res = dash.call('getCallerLookup',
    { phone: '2145550123', from: '2026-08-01', to: '2026-08-31' });
  assert.equal(res.meta.available, true);
  assert.equal(res.meta.matches, 1, 'inbound still answers');
  assert.equal(res.meta.outboundAvailable, false, 'the outbound section says so');
});

test('caller lookup fallback: no export tabs at all stays honestly unavailable', function () {
  clInstallFallback({ noIb: true, noOb: true });
  const res = dash.call('getCallerLookup',
    { phone: '2145550123', from: '2026-08-01', to: '2026-08-31' });
  assert.equal(res.meta.available, false, 'never a false "no history found"');
});
