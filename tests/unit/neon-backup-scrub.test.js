'use strict';

// ESC-D8 (owner ruling 2026-10-02, option C): a permanent escalation delete
// also scrubs the deleted rows out of the existing Neon backups.
//
// Drives the REAL nbScrubAfterDelete_ / runNeonBackup_ / restoreNeonBackupFile
// against an in-memory Drive folder (+ the real Sheets store on a fake
// workbook) and a fake Neon whose escalation rows are dated per day.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({ files: ['Config.gs', 'NeonRetention.gs', 'NeonBackup.gs'] });
const RealDate = Date;

let now = null;
let files = {};          // name -> { content, updated }
let escRows = [];        // escalations rows { id, created_at }
let actRows = [];        // escalation_activity rows { id, escalation_id, at }
let driveError = null;   // when set, DriveApp.getFolderById throws it

function fileObj(name) {
  return {
    getName: function () { return name; },
    getLastUpdated: function () { return new RealDate(files[name].updated); },
    setContent: function (c) { files[name] = { content: c, updated: now }; },
    setTrashed: function () { delete files[name]; },
    getBlob: function () { return { getDataAsString: function () { return files[name].content; } }; },
  };
}
const folder = {
  getId: function () { return 'F'; },
  getFilesByName: function (n) {
    let used = false;
    return { hasNext: function () { return !used && (n in files); }, next: function () { used = true; return fileObj(n); } };
  },
  createFile: function (n, c) { files[n] = { content: c, updated: now }; },
  getFiles: function () {
    const ks = Object.keys(files); let i = 0;
    return { hasNext: function () { return i < ks.length; }, next: function () { return fileObj(ks[i++]); } };
  },
};

function lines(rows) { return rows.map(function (r) { return JSON.stringify(r); }).join('\n'); }

function mkConn() {
  return {
    prepareStatement: function (sql) {
      const p = [];
      return {
        setString: function (i, v) { p[i - 1] = v; },
        executeQuery: function () {
          let j = '';
          if (/FROM escalations ORDER BY/.test(sql)) j = lines(escRows);
          else if (/MIN\(at\).*FROM escalation_activity/.test(sql)) {
            j = actRows.length ? actRows.map(function (r) { return r.at; }).sort()[0].slice(0, 7) : null;
          } else if (/MIN\(/.test(sql)) j = null;
          else if (/FROM escalation_activity WHERE at >= \?/.test(sql)) {
            j = lines(actRows.filter(function (r) { return r.at >= p[0] && r.at < p[1]; }));
          } else if (/FROM escalation_activity WHERE at > \?/.test(sql)) {
            j = lines(actRows.filter(function (r) { return r.at > p[0] && r.at < p[1]; }));
          }
          let served = false;
          return { next: function () { if (served) return false; served = true; return true; },
                   getString: function () { return j; }, close: function () {} };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function install() {
  files = {}; escRows = []; actRows = []; driveError = null;
  h.state.props = { NEON_BACKUP_FOLDER_ID: 'F' };
  h.state.createdSpreadsheets.length = 0;
  h.ctx.DriveApp = {
    getFolderById: function () { if (driveError) throw new Error(driveError); return folder; },
    createFolder: function () { return folder; },
  };
  h.ctx.getDashboardNeonConn_ = mkConn;
  h.ctx.getConfigSource_ = function () { return 'sheet'; };
  h.ctx.assertAdmin_ = function () {};
}

// Run `fn` "at" 06:00 Central on `iso`.
function at(iso, fn) {
  now = new RealDate(iso + 'T11:00:00Z').getTime();
  const fixed = now;
  class FakeDate extends RealDate {
    constructor() { if (arguments.length) super(...arguments); else super(fixed); }
    static now() { return fixed; }
  }
  h.ctx.Date = FakeDate;
  try { return fn(); } finally { h.ctx.Date = RealDate; }
}
function backup(iso) { return at(iso, function () { h.call('runNeonBackup_'); return h.state.props.NEON_BACKUP_LAST_RESULT; }); }
function scrub(iso, ids) { return at(iso, function () { return h.call('nbScrubAfterDelete_', ids); }); }
function ids(name, key) {
  if (!files[name]) return null;
  return files[name].content.split('\n').filter(Boolean).map(function (l) { return JSON.parse(l)[key]; });
}
function queue() { const raw = h.state.props.NEON_BACKUP_SCRUB_PENDING; return raw ? JSON.parse(raw) : null; }

// The Neon side of a delete: the rows are gone before the scrub runs.
function deleteInNeon(id) {
  escRows = escRows.filter(function (r) { return r.id !== id; });
  actRows = actRows.filter(function (r) { return r.escalation_id !== id; });
}
function seed() {
  escRows = [{ id: 'keep', created_at: '2026-09-02' }, { id: 'gone', created_at: '2026-09-03' }];
  actRows = [
    { id: 'a1', escalation_id: 'keep', at: '2026-09-02T15:00:00Z' },
    { id: 'a2', escalation_id: 'gone', at: '2026-09-03T15:00:00Z' },
    { id: 'a3', escalation_id: 'gone', at: '2026-09-28T15:00:00Z' },
  ];
}
// Activity that lands AFTER the last in-month Saturday run (09-26).
function lateActivity() { actRows.push({ id: 'a4', escalation_id: 'keep', at: '2026-09-29T15:00:00Z' }); }

test('ESC-D8: a delete scrubs the id out of every snapshot and activity file, and leaves other files alone', function () {
  install(); seed();
  backup('2026-09-19');
  backup('2026-09-26');
  files['inbound_calls-2026-09.jsonl'] = { content: JSON.stringify({ call_id: 'gone' }), updated: 1 };   // not an escalation file
  deleteInNeon('gone');
  const res = scrub('2026-09-30', ['gone']);
  assert.equal(res.status, 'ok');
  assert.equal(res.pending, 0);
  assert.equal(queue(), null, 'a clean scrub leaves no queue behind');
  assert.deepEqual(ids('escalations-2026-09-19.jsonl', 'id'), ['keep']);
  assert.deepEqual(ids('escalations-2026-09-26.jsonl', 'id'), ['keep']);
  assert.deepEqual(ids('escalation_activity-2026-09.jsonl', 'escalation_id'), ['keep']);
  assert.equal(files['inbound_calls-2026-09.jsonl'].updated, 1, 'only escalation files are touched');
  assert.equal(res.files, 3);

  // A second scrub of a clean set rewrites nothing (no timestamp churn).
  const before = JSON.stringify(files);
  scrub('2026-09-30', ['gone']);
  assert.equal(JSON.stringify(files), before);
});

test('ESC-D8: an unreachable store QUEUES the id; the next backup run retries it and stays ok', function () {
  install(); seed();
  backup('2026-09-26');
  deleteInNeon('gone');
  driveError = 'You do not have permission to call DriveApp.getFolderById';
  const res = scrub('2026-09-30', ['gone']);
  assert.equal(res.status, 'pending');
  assert.deepEqual(queue().ids, ['gone']);
  assert.match(queue().lastError, /permission/);
  assert.ok(queue().since, 'the queue records since when');
  assert.deepEqual(ids('escalations-2026-09-26.jsonl', 'id'), ['keep', 'gone'], 'nothing changed yet');

  driveError = null;
  const r = backup('2026-10-03');
  assert.match(r, /^ok \|/, 'a complete backup stays ok whatever the scrub did');
  assert.match(r, /scrub ok \(\d+ row\(s\) of deleted escalations removed from \d+ file\(s\)\)/);
  assert.equal(queue(), null);
  assert.deepEqual(ids('escalations-2026-09-26.jsonl', 'id'), ['keep']);
});

test('ESC-D8 / ENG-1: a closed month not yet final is DEFERRED, never stamped final short; the backup run finalizes it first', function () {
  install(); seed();
  backup('2026-09-26');             // Sept file last written 09-26 -- not final (final on 10-04)
  lateActivity();
  deleteInNeon('gone');
  const res = scrub('2026-10-05', ['gone']);
  assert.equal(res.status, 'pending');
  assert.equal(res.deferred.length, 1);
  assert.match(res.deferred[0], /escalation_activity-2026-09\.jsonl/);
  assert.equal(files['escalation_activity-2026-09.jsonl'].updated, new RealDate('2026-09-26T11:00:00Z').getTime(),
    'the file keeps its old date, so the next run still treats the month as open');
  assert.deepEqual(ids('escalations-2026-09-26.jsonl', 'id'), ['keep'], 'snapshots have no finality rule -- scrubbed now');
  assert.match(queue().lastError, /deferred until the next backup run finalizes/);

  const r = backup('2026-10-10');
  assert.match(r, /scrub ok/);
  assert.equal(queue(), null);
  assert.deepEqual(ids('escalation_activity-2026-09.jsonl', 'id'), ['a1', 'a4'],
    'the month was refetched from Neon -- the 09-29 row is backed up and the deleted rows are gone');
});

test('ESC-D8: before a closed month\'s final date the file is scrubbed at once -- a write then cannot mark it final', function () {
  install(); seed();
  backup('2026-09-26');
  lateActivity();
  deleteInNeon('gone');
  const res = scrub('2026-10-02', ['gone']);
  assert.equal(res.status, 'ok');
  assert.deepEqual(ids('escalation_activity-2026-09.jsonl', 'escalation_id'), ['keep']);
  const action = h.call('nbClosedMonthAction_', '2026-09', { lastUpdatedIso: '2026-10-02', tailUpdatedIso: null },
    '2026-10-10', { graceDays: 3, journeyDays: 90 });
  assert.notEqual(action, 'skip', 'the month is still open to the next run');
  backup('2026-10-10');
  assert.deepEqual(ids('escalation_activity-2026-09.jsonl', 'id'), ['a1', 'a4']);
});

test('ESC-D8: both stores are scrubbed -- a run that fell back to Sheets leaves the older Drive files behind', function () {
  install(); seed();
  backup('2026-09-19');                                    // Drive
  const book = makeFakeSpreadsheet({ id: 'BK', sheets: {} });
  h.state.spreadsheetsById.BK = book;
  h.state.props.NEON_BACKUP_SS_ID = 'BK';
  h.state.props.NEON_BACKUP_STORE = 'sheets';
  backup('2026-09-26');                                    // Sheets
  deleteInNeon('gone');
  const res = scrub('2026-09-30', ['gone']);
  assert.equal(res.status, 'ok');
  assert.deepEqual(ids('escalations-2026-09-19.jsonl', 'id'), ['keep'], 'Drive copy');
  const tab = book.getSheetByName('escalations-2026-09-26.jsonl');
  const rows = tab._data.map(function (r) { return JSON.parse(r.join('')).id; });
  assert.deepEqual(rows, ['keep'], 'Sheets copy');
  delete h.state.spreadsheetsById.BK;
});

test('ESC-D8: no backup store yet -> nothing to scrub, nothing queued, no store created', function () {
  install();
  h.state.props = {};
  let created = 0;
  h.ctx.DriveApp = { getFolderById: function () { throw new Error('x'); }, createFolder: function () { created++; return folder; } };
  const res = scrub('2026-09-30', ['gone']);
  assert.equal(res.status, 'ok');
  assert.equal(queue(), null);
  assert.equal(created, 0);
  assert.equal(h.state.createdSpreadsheets.length, 0);
});

test('ESC-D8: the queue never grows past its cap; overflow is counted, not silently lost', function () {
  install();
  driveError = 'down';
  const many = [];
  for (let i = 0; i < 160; i++) many.push('id-' + i);
  const res = scrub('2026-09-30', many);
  assert.equal(res.status, 'pending');
  assert.equal(queue().ids.length, 150);
  assert.equal(queue().dropped, 10);
  assert.ok(h.state.props.NEON_BACKUP_SCRUB_PENDING.length < 9 * 1024, 'under the property value cap');
});

test('ESC-D8: a restore leaves out rows of deleted escalations still waiting to be scrubbed', function () {
  install(); seed();
  backup('2026-09-26');
  driveError = null;
  h.state.props.NEON_BACKUP_SCRUB_PENDING = JSON.stringify({ ids: ['gone'] });
  h.state.props.NEON_RESTORE_FILE = 'escalation_activity-2026-09';
  const prev = h.call('restoreNeonBackupFile');
  assert.equal(prev.rows, 1, 'only the surviving escalation\'s activity');
  assert.equal(prev.skippedDeleted, 2);
  h.state.props.NEON_RESTORE_FILE = 'escalations-2026-09-26.jsonl';
  const snap = h.call('restoreNeonBackupFile');
  assert.equal(snap.rows, 1);
  assert.equal(snap.skippedDeleted, 1);
});

test('ESC-D8: deleteEscalation scrubs AFTER the commit and OUTSIDE the lock, with every deleted copy\'s id', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'Escalations.gs'), 'utf8');
  const body = src.slice(src.indexOf('function deleteEscalation('), src.indexOf('function escGroupIds_('));
  const commit = body.indexOf('conn.commit();');
  const release = body.indexOf('lock.releaseLock();');
  const call = body.indexOf('nbScrubAfterDelete_(goneIds)');
  assert.ok(commit > 0 && release > commit && call > release, 'commit -> release the lock -> scrub');
  assert.match(body, /goneIds = all \? escGroupIds_\(conn, meta\.groupId\) : \[id\];/);
});
