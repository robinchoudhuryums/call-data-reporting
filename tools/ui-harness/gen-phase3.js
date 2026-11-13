'use strict';
/** Phase-3 payload generator: Escalations (fake JDBC) + admin modal inits. */
const fs = require('fs');
const path = require('path');
const REPO = require('path').resolve(__dirname, '../..');
const { loadGas } = require(path.join(REPO, 'tests/harness/loadGas'));
const { makeFakeSpreadsheet } = require(path.join(REPO, 'tests/harness/fakeSheet'));
const { dqeRow, dqeSheet, rosterGrid } = require(path.join(REPO, 'tests/harness/fixtures'));
const OUT = path.join(__dirname, 'payloads');

function iso(d){const p=n=>n<10?'0'+n:String(n);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}
const today=new Date(); const ago=(n)=>{const d=new Date(today);d.setDate(d.getDate()-n);return iso(d);};

// --- escalation fixture rows (shape = the SELECT's column aliases) ---------
const ESC_ROWS = [
  { id: 101, department: 'CSR', occurred_at: ago(1)+' 10:42:00', caller: 'Maria G (daughter)', patient_name: 'R. Alvarez', trx: 'TRX-88121', area: 'Billing dispute', reason: 'Caller states she was promised a supervisor callback twice and never received one; invoice sent to collections in the meantime.', status: 'pending', resolution: null, comments: null, created_by: 'admin@ums.com', created_at: ago(1)+' 10:50:00', resolved_by: null, resolved_at: null, source: null,
    // ESC-L1: a LINKED copy -- Sales holds the other copy of this escalation.
    group_id: 'grp-101', linked: [{ department: 'Power', status: 'removed' }, { department: 'Sales', status: 'in_progress' }],
    // ESC-C3: the latest comments on the card face (the thread holds 4).
    card_comments: [{ actor: 'sales.mgr@ums.com', at: ago(0)+' 08:40:00', detail: 'Sales confirmed the account is current.', cut: false, department: 'Sales' },
      { actor: 'manager@ums.com', at: ago(0)+' 09:15:00', detail: 'Reached the daughter; callback scheduled for 3 PM.', cut: false, department: 'CSR' }],
    comment_count: 4 },
  // ESC-L2: Power was REMOVED from the linked escalation 101 (read-only copy).
  { id: 96, department: 'Power', occurred_at: ago(1)+' 10:42:00', caller: 'Maria G (daughter)', patient_name: 'R. Alvarez', trx: 'TRX-88121', area: 'Billing dispute', reason: 'Caller states she was promised a supervisor callback twice and never received one; invoice sent to collections in the meantime.', status: 'removed', resolution: null, comments: 'Not a Power order.', created_by: 'admin@ums.com', created_at: ago(1)+' 10:50:00', resolved_by: null, resolved_at: null, source: 'manual',
    group_id: 'grp-101', removed_by: 'admin@ums.com', removed_at: ago(0)+' 08:30:00', removed_reason: 'Dispute upheld: no Power equipment on this account.',
    linked: [{ department: 'CSR', status: 'pending' }, { department: 'Sales', status: 'in_progress' }] },
  { id: 100, department: 'CSR', occurred_at: ago(5)+' 14:05:00', caller: 'J. Okafor (self)', patient_name: 'J. Okafor', trx: 'TRX-87990', area: 'Supply delay', reason: 'Fourth call about a backordered supply; patient out of consumables since Monday.', status: 'pending', resolution: null, comments: 'Vendor ETA requested.', created_by: 'admin@ums.com', created_at: ago(5)+' 14:20:00', resolved_by: null, resolved_at: null, source: null },
  { id: 99, department: 'CSR', occurred_at: ago(2)+' 09:12:00', caller: 'Anon caller', patient_name: 'T. Nguyen', trx: 'TRX-87754', area: null, reason: 'Repeated disconnects mid-transfer; caller extremely frustrated.', status: 'in_progress', resolution: null, comments: 'Ben following up with telecom.', created_by: 'manager@ums.com', created_at: ago(2)+' 09:30:00', resolved_by: null, resolved_at: null, source: null },
  { id: 98, department: 'CSR', occurred_at: ago(0)+' 08:55:00', caller: 'P. Singh (spouse)', patient_name: 'D. Singh', trx: 'TRX-88240', area: 'Escalation request', reason: 'Submitted via team tools: caller asked for management review of a denied exchange.', status: 'pending_review', resolution: null, comments: null, created_by: 'teamtools@ums.com', created_at: ago(0)+' 09:00:00', resolved_by: null, resolved_at: null, source: 'team-tools' },
  { id: 97, department: 'CSR', occurred_at: ago(0)+' 11:20:00', caller: 'L. Brooks (case mgr)', patient_name: 'H. Wells', trx: 'TRX-88255', area: null, reason: 'Case manager reports conflicting delivery dates given by two agents.', status: 'pending_review', resolution: null, comments: null, created_by: 'teamtools@ums.com', created_at: ago(0)+' 11:25:00', resolved_by: null, resolved_at: null, source: 'team-tools' },
  { id: 90, department: 'CSR', occurred_at: ago(9)+' 15:40:00', caller: 'K. Ito (self)', patient_name: 'K. Ito', trx: 'TRX-87001', area: 'Billing dispute', reason: 'Charged twice for one shipment.', status: 'resolved', resolution: 'Duplicate charge refunded; confirmation emailed.', comments: 'Refund ref #R-5521.', created_by: 'admin@ums.com', created_at: ago(9)+' 15:52:00', resolved_by: 'manager@ums.com', resolved_at: ago(7)+' 10:02:00', source: null },
  { id: 88, department: 'CSR', occurred_at: ago(12)+' 13:00:00', caller: 'Unknown', patient_name: 'M. Diaz', trx: 'TRX-86780', area: null, reason: 'Insufficient detail to act; submitter asked to resubmit with the account number.', status: 'rejected', resolution: null, comments: null, created_by: 'teamtools@ums.com', created_at: ago(12)+' 13:04:00', resolved_by: null, resolved_at: null, source: 'team-tools' },
];
const ESC_ACTIVITY = [
  { id: 1, escalation_id: 101, action: 'created', actor: 'admin@ums.com', at: ago(1)+' 10:50:00', detail: null },
  { id: 2, escalation_id: 101, action: 'comment', actor: 'manager@ums.com', at: ago(0)+' 09:15:00', detail: 'Reached the daughter; callback scheduled for 3 PM.' },
];

// TR-1: three calls whose transfer to Sales was tried again there (Elena Park
// first each time) -- two inbound, one outbound -- plus a call with no retry.
const trAt = (t, name, x) => Object.assign({ t, name, kind: 'leg', missed: true, transfer: true }, x || {});
const TR_ROWS = [
  { kind: 'inbound', date: ago(1), callId: '1783985478661', start: '10:00:00', agent: null, journey: JSON.stringify([
    { t: '10:00:00', name: 'A_Q_CSR', kind: 'queue' }, { t: '10:00:05', name: 'Anna Reyes', kind: 'answer', talk: 300 },
    trAt('10:02:00', 'Elena Park', { secs: 3 }), { t: '10:02:20', name: 'Frank Wu', kind: 'answer', talk: 40, transfer: true, consult: true }]) },
  { kind: 'outbound', date: ago(2), callId: '1783985479001', start: '14:00:00', agent: 'Ben Ortiz', journey: JSON.stringify([
    trAt('14:01:00', 'Elena Park', { secs: 25 }), trAt('14:01:40', 'Frank Wu', { secs: 20, voicemail: true })]) },
  { kind: 'inbound', date: ago(3), callId: '1783985479302', start: '09:30:00', agent: null, journey: JSON.stringify([
    { t: '09:30:05', name: 'Dev Patel', kind: 'answer', talk: 200 },
    trAt('09:31:00', 'Elena Park', { secs: 2 }), { t: '09:31:30', name: 'Frank Wu', kind: 'answer', talk: 60, transfer: true, consult: true }]) },
  { kind: 'inbound', date: ago(3), callId: '1783985479400', start: '11:00:00', agent: null, journey: JSON.stringify([
    { t: '11:00:05', name: 'Carla Diaz', kind: 'answer', talk: 200 }, trAt('11:01:00', 'Elena Park', { secs: 30 })]) },
  // P3 (owner 2026-11-13): answered, then redirected -- Elena answers and
  // talks, the CSR then goes to Frank, and Frank takes the caller.
  { kind: 'inbound', date: ago(1), callId: '1783985480101', start: '13:00:00', agent: null, journey: JSON.stringify([
    { t: '13:00:00', name: 'A_Q_CSR', kind: 'queue' }, { t: '13:00:10', name: 'Anna Reyes', kind: 'answer', talk: 600 },
    { t: '13:02:00', name: 'Elena Park', kind: 'answer', talk: 95, transfer: true, consult: true },
    { t: '13:05:00', name: 'Frank Wu', kind: 'answer', talk: 30, transfer: true, consult: true },
    { t: '13:05:40', name: 'Frank Wu', kind: 'answer', talk: 240, transfer: true, handover: true }]) },
  // ... and one where the second person did not pick up, so no one in Sales took it.
  { kind: 'inbound', date: ago(4), callId: '1783985480202', start: '15:00:00', agent: null, journey: JSON.stringify([
    { t: '15:00:05', name: 'Dev Patel', kind: 'answer', talk: 400 },
    { t: '15:01:00', name: 'Elena Park', kind: 'answer', talk: 20, transfer: true, consult: true },
    trAt('15:02:00', 'Frank Wu', { secs: 22 })]) },
];
function mkRs(obj){ let used=false; return { next(){ if(used) return false; used=true; return true; },
  getString(k){ return (obj[k]==null)?null:String(obj[k]); }, getInt(k){ return Number(obj[k])||0; }, close(){} }; }
function fakeNeonConn() {
  const stmt = (sql) => ({
    setString(){}, setInt(){}, setObject(){},
    execute(){ return true; },
    executeQuery(){
      // ESC-C3: the LIST query now names escalation_activity too (the card
      // comment subqueries), so route on what the query SELECTS FROM.
      if (/^SELECT COALESCE\(json_agg\(t ORDER BY t\.occurred_at/.test(sql)) return mkRs({ j: JSON.stringify(ESC_ROWS) });
      if (/escalation_activity/.test(sql)) return mkRs({ j: JSON.stringify(ESC_ACTIVITY) });
      if (/FROM \(/.test(sql) && /escalations/.test(sql)) return mkRs({ j: JSON.stringify(ESC_ROWS) });
      // TR-1: the transfer-retries read (journeys prefiltered in SQL).
      if (/journey LIKE/.test(sql) && /inbound_calls/.test(sql)) return mkRs({ j: JSON.stringify(TR_ROWS) });
      if (/FILTER/.test(sql) && /escalations/.test(sql)) return mkRs({
        n_pending: '2', n_inprog: '1', n_review: '2', n_resolved: '1', n_rejected: '1',
        n_resolved_mtd: '1', n_overdue: '1', oldest_open: ago(5)+' 14:05:00' });
      return mkRs({ j: '[]' });
    },
    executeUpdate(){ return 0; }, close(){},
  });
  return { prepareStatement: stmt, createStatement: () => stmt(''),
    setAutoCommit(){}, commit(){}, rollback(){}, close(){} };
}

// --- sheets (superset of Phase 1's fixture, + admin-modal sheets) ----------
const ROSTER = rosterGrid({
  CSR: ['Anna Reyes, 101', 'Ben Ortiz, 102', 'Carla Diaz, 103', 'Dev Patel, 104', 'Robin Choudhury, 105'],
  Sales: ['Elena Park, 201', 'Frank Wu, 202'],
  Spanish: ['Iris Vega, 301'], Power: ['Kim Lee, 401'], Billing: ['Nora Hale, 501'],
});
const dqeRows = [];
for (let i = 6; i >= 0; i--) {
  const d = ago(i);
  dqeRows.push(dqeRow({ month: d.slice(0,7), date: d, agent: 'Anna Reyes', ext: '101', unique: 8, rung: 10, missed: 1, answered: 9, ttt: '0:30:00', att: '0:03:20' }));
  dqeRows.push(dqeRow({ month: d.slice(0,7), date: d, agent: 'Jon Smyth (Temp)', ext: '777', unique: 2, rung: 4, missed: 1, answered: 3, ttt: '0:09:00', att: '0:03:00' }));
}
const QCD_HEADER = ['Month Year','Week','Date','Call Queue','Call Source','Total Calls','Total Answered','Abandoned','Longest Wait','Avg Answer','Abandoned %','Violations'];
const qcdRows = [QCD_HEADER];
for (let i = 6; i >= 0; i--) {
  qcdRows.push([ago(i).slice(0,7), '', ago(i), 'A_Q_CustomerSuccess', 'Total Calls', 60, 57, 3, '0:02:00', '0:00:20', '5.0%', 1]);
  qcdRows.push([ago(i).slice(0,7), '', ago(i), 'A_Q_UnmappedNewQueue', 'Total Calls', 12, 11, 1, '0:01:00', '0:00:15', '8.3%', 1]);
}
const SHEETS = {
  'DO NOT EDIT!': ROSTER,
  'DQE Historical Data': dqeSheet(dqeRows),
  'QCD Historical Data': qcdRows,
  // G3: one staged agent (agent sign-in OFF) on the pending-welcome list.
  'Access Control': [['Email','Department','Notes','Role','Agent Name'], ['manager@ums.com','CSR','','',''],
    ['sales.mgr@ums.com','Sales','','',''], ['staged.agent@ums.com','CSR','','agent','Anna Reyes']],
  'Alert Config': [['Department','Threshold %','Extra Recipients','Active','Notes','Skip Dates'],
    ['CSR', 85, '', 'TRUE', '', ''], ['Sales', 90, 'vp@ums.com', 'TRUE', '', ''], ['Billing', '', '', 'TRUE', 'typo row', '']],
  'Alert Log': [['Timestamp','Department','Date Checked','Threshold %','Answer Rate %','Sent','Recipients','Triggered By','Notes','Status'],
    [ago(1)+' 08:00', 'CSR', ago(2), 85, 82.1, 'TRUE', 'manager@ums.com', 'daily-trigger', '', 'sent'],
    [ago(2)+' 08:00', 'CSR', ago(3), 85, 91.0, 'FALSE', '', 'daily-trigger', '', 'above-threshold']],
  'Digest Config': [['Email','Department','Cadence','Active','Notes','Format'],
    ['manager@ums.com','CSR','daily','TRUE','','summary']],
  'Queue Report Subscribers': [['Email','Active','Notes'], ['ops@ums.com','TRUE','']],
  'Pipeline Health': [['Timestamp','Step','Status','Rows','Duration (ms)','Notes'],
    [new Date().toISOString(), 'processIntegratedHistory:DQE', 'success', 42, 1200, ago(1)],
    [new Date().toISOString(), 'neonMirror:Inbound', 'failure', 0, 300, 'Neon unreachable'],
    // DCA-6: the Direct build names a person 8x8 shows on a roster extension
    // who is on no roster (ext 101 is listed for Anna Reyes) -- drive-admin
    // asserts she reaches the Outlier Fix list with her own extension.
    [new Date().toISOString(), 'processIntegratedHistory:Direct', 'success', 6, 900,
      new Date(ago(1) + 'T12:00:00').toDateString() + ' | agents=6 missedBusy=0 missedFree=1 neon=ok'
        // DCA-7: plus two people on extensions NO roster lists (third element
        // empty) -- one gets marked "Not an agent" by drive-admin.
        + ' | unrostered=[["Nina New","101","Anna Reyes",7],["Omar Unlisted","733","",4],["Pat Porter","744","",2]]']],
  'Agent Alias Overrides': [['Old Name','Canonical Name','Active','Added By','Added At','Notes']],
  'Orphan Fix Log': [['Timestamp','Admin','Action','From Name','To Name','Affected Rows','Notes']],
  'Dept Config': [['Department','QCD Queues','Overview Parent','Team Avg Excludes','Queue Ext Overrides','Active','Updated By','Updated At','Notes','Inbound Queue Aliases']],
  'Report Usage': [['Timestamp','Report','Department','Email','Role','Cache','Ms']],
};

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs',
          'DeptConfig.gs', 'Data.gs', 'NeonRead.gs', 'InboundReport.gs',
          'Escalations.gs', 'Alerts.gs', 'Digest.gs', 'QueueReportEmail.gs',
          'OrphanFix.gs', 'SystemHealth.gs', 'CacheWarm.gs', 'NeonKeepWarm.gs',
          'Notifications.gs', 'AlertReasons.gs', 'TransferRetries.gs'],
});
function install(email) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@ums.com';
  h.state.props.NEON_HOST = 'fake.neon.tech';   // neonConfigured:true
  h.state.props.AGENT_WELCOME_PENDING = '["staged.agent@ums.com"]';   // G3
  h.state.userEmail = email;
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: SHEETS });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  if (h.ctx.QCD_SHEET_DATA_MEMO_ !== undefined) h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.state.cache.clear();
  h.ctx.getDashboardNeonConn_ = fakeNeonConn;
}
function dump(name, fn) {
  try { const v = fn(); fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(v));
    console.log('wrote ' + name + ' [' + (v && typeof v === 'object' ? Object.keys(v).slice(0,10) : typeof v) + ']'); }
  catch (e) { console.log('SKIP ' + name + ': ' + (e && e.message)); }
}

install('admin@ums.com');
dump('esc-init', () => h.call('getEscalationsInit'));
dump('esc-list', () => h.call('getEscalations', { department: 'ALL', status: 'all' }));
dump('esc-activity', () => h.call('getEscalationActivity', { id: 101 }));
dump('transfer-retries', () => h.call('getTransferRetries', { from: ago(30), to: ago(1) }));   // TR-1
dump('transfer-retries-init', () => h.call('getTransferRetriesInit'));
dump('alerts-init', () => h.call('getAlertsInit'));
dump('digests-init', () => h.call('getDigestsInit'));
dump('queuereport-init', () => h.call('getQueueReportInit'));
dump('orphan-init', () => h.call('getOrphanFixInit'));
dump('deptconfig-init', () => h.call('getDeptConfigInit'));
dump('access-init', () => h.call('getAccessControlInit'));
dump('health', () => h.call('getSystemHealth'));
dump('ui-flags', () => h.call('getUiFlags'));
install('manager@ums.com');
dump('esc-list-mgr', () => h.call('getEscalations', { status: 'all' }));
