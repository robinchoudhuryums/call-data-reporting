'use strict';
/**
 * UI-harness payload generator (audit tooling; lives in the scratchpad,
 * never shipped). Drives the REAL dashboard server code (Data.gs,
 * CompanyOverview.gs, MissedCallsReport.gs ...) inside the repo's node vm
 * harness over a rich fake-spreadsheet fixture, and dumps the RPC payloads
 * as JSON for the browser harness's google.script.run stub.
 *
 * Run: node gen-payloads.js  (cwd = this dir; repo path resolved below)
 */
const fs = require('fs');
const path = require('path');

const REPO = require('path').resolve(__dirname, '../..');
const { loadGas } = require(path.join(REPO, 'tests/harness/loadGas'));
const { makeFakeSpreadsheet } = require(path.join(REPO, 'tests/harness/fakeSheet'));
const { dqeRow, dqeSheet, rosterGrid } = require(path.join(REPO, 'tests/harness/fixtures'));

const OUT = path.join(__dirname, 'payloads');
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- fixture --
// Real dept names so the DEPT_QCD_QUEUES / OVERVIEW_PARENT_OF constants
// resolve (Spanish nests under CSR on the Overview).
const ROSTER = rosterGrid({
  CSR: ['Anna Reyes, 101', 'Ben Ortiz, 102', 'Carla Diaz, 103', 'Dev Patel, 104', 'Robin Choudhury, 105'],
  Sales: ['Elena Park, 201', 'Frank Wu, 202', 'Gita Rao, 203', 'Hank Miller, 204'],
  Spanish: ['Iris Vega, 301', 'Jorge Luna, 302'],
  Power: ['Kim Lee, 401', 'Luis Mora, 402', 'Mia Chen, 403'],
  Billing: ['Nora Hale, 501', 'Omar Aziz, 502', 'Pia Kaur, 503'],
});

function iso(d) {
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function hms(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return h + ':' + p(m) + ':' + p(s);
}

// Deterministic pseudo-random so re-runs produce the same page.
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }

// Weekdays for the last N calendar days ending YESTERDAY (real clock: the
// Overview windows are computed from the live clock server-side).
const today = new Date(); today.setHours(12, 0, 0, 0);
const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
// If yesterday is a weekend, walk back to Friday (latest DQE date).
while (yesterday.getDay() === 0 || yesterday.getDay() === 6) yesterday.setDate(yesterday.getDate() - 1);
const days = [];
for (let i = 400; i >= 0; i--) {           // ~13 months so YTD + 12-mo trends have data
  const d = new Date(yesterday); d.setDate(yesterday.getDate() - i);
  if (d.getDay() === 0 || d.getDay() === 6) continue;
  days.push(iso(d));
}
const LATEST = days[days.length - 1];

// Per-agent daily profile: (baseRung, answerRate, attSec). Carla is the
// struggling agent (low rate); Dev has a mid-range gap (PTO); Robin is the
// token-calls manager (TEAM_AVG_EXCLUDES seed).
const PROFILES = {
  'Anna Reyes': [26, 0.95, 190], 'Ben Ortiz': [22, 0.93, 205], 'Carla Diaz': [24, 0.78, 250],
  'Dev Patel': [18, 0.91, 180], 'Robin Choudhury': [3, 0.97, 120],
  'Elena Park': [20, 0.94, 210], 'Frank Wu': [17, 0.88, 240], 'Gita Rao': [19, 0.92, 200], 'Hank Miller': [15, 0.90, 230],
  'Iris Vega': [12, 0.93, 220], 'Jorge Luna': [10, 0.86, 260],
  'Kim Lee': [16, 0.95, 180], 'Luis Mora': [14, 0.89, 210], 'Mia Chen': [13, 0.92, 195],
};
const DEPT_OF = {
  'Anna Reyes': 'CSR', 'Ben Ortiz': 'CSR', 'Carla Diaz': 'CSR', 'Dev Patel': 'CSR', 'Robin Choudhury': 'CSR',
  'Elena Park': 'Sales', 'Frank Wu': 'Sales', 'Gita Rao': 'Sales', 'Hank Miller': 'Sales',
  'Iris Vega': 'Spanish', 'Jorge Luna': 'Spanish',
  'Kim Lee': 'Power', 'Luis Mora': 'Power', 'Mia Chen': 'Power',
  'Nora Hale': 'Billing', 'Omar Aziz': 'Billing', 'Pia Kaur': 'Billing',
};
const EXT_OF = {}; ROSTER[0].forEach(() => {});   // exts assigned below per roster literal
Object.keys(DEPT_OF).forEach((a, i) => { EXT_OF[a] = String(101 + i); });

const dqeRows = [];
days.forEach((dIso, di) => {
  const monthYear = dIso.slice(0, 7);
  Object.keys(PROFILES).forEach((agent) => {
    if (!DEPT_OF[agent]) return;
    const [base, rate, att] = PROFILES[agent];
    // Dev's PTO gap: ~2 weeks in the middle third.
    if (agent === 'Dev Patel' && di > days.length * 0.55 && di < days.length * 0.62) return;
    const rung = Math.max(1, Math.round(base * (0.75 + rnd() * 0.5)));
    // Gentle upward drift for Anna, downward for Jorge (trend-arrow variety).
    let r = rate + (agent === 'Anna Reyes' ? (di / days.length - 0.5) * 0.06 : 0)
                 + (agent === 'Jorge Luna' ? (0.5 - di / days.length) * 0.10 : 0)
                 + (rnd() - 0.5) * 0.06;
    r = Math.min(0.99, Math.max(0.55, r));
    const answered = Math.round(rung * r);
    const missed = rung - answered;
    const attSec = Math.round(att * (0.85 + rnd() * 0.3));
    const row = {
      month: monthYear, date: dIso, agent, ext: EXT_OF[agent] || '100',
      unique: Math.round(rung * 0.8), rung, missed, answered,
      ttt: hms(attSec * answered), att: hms(attSec),
      aaw: missed ? hms(20 + Math.round(rnd() * 60)) : '',
    };
    // Missed-time slots + abandoned detail on the LAST 30 days for CSR so the
    // Missed section has a chart + timelines + journeys.
    if (missed > 0 && DEPT_OF[agent] === 'CSR' && di >= days.length - 22) {
      const slots = new Array(19).fill('');
      const times = [];
      for (let k = 0; k < Math.min(missed, 4); k++) {
        const slot = 1 + Math.floor(rnd() * 16);
        const hh = 8 + Math.floor(slot / 2), mm = (slot % 2) * 30 + Math.floor(rnd() * 29);
        const t = (hh > 12 ? hh - 12 : hh) + ':' + (mm < 10 ? '0' + mm : mm) + ':15 ' + (hh >= 12 ? 'PM' : 'AM');
        slots[slot] = slots[slot] ? slots[slot] + ',' + t : t;
        times.push(t);
      }
      row.slots = slots;
      if (di >= days.length - 8 && times.length >= 2) {   // some abandoned parents recently
        row.abdIds = times.slice(0, 2).map((_, i2) => String(1762242202000 + di * 100 + i2)).join(',');
        row.abdTimes = times.slice(0, 2).join(',');
      }
    }
    dqeRows.push(dqeRow(row));
  });
  // Queue-only sentinel abandons on CSR's main queue, a few recent days.
  if (di >= days.length - 6 && di % 2 === 0) {
    const s = new Array(19).fill('');
    s[3] = '9:41:22 AM'; s[10] = '1:12:05 PM';
    dqeRows.push(dqeRow({
      month: dIso.slice(0, 7), date: dIso, agent: 'A_Q_CustomerSuccess', ext: '900',
      unique: 0, rung: 0, missed: 0, answered: 0, ttt: '0:00:00', att: '0:00:00',
      slots: s, abdIds: String(1762249900000 + di), abdTimes: '9:41:22 AM',
    }));
  }
  // Orphan-name rows on recent dates so the admin Orphan-nag banner renders.
  if (di >= days.length - 3) {
    dqeRows.push(dqeRow({
      month: dIso.slice(0, 7), date: dIso, agent: 'Jon Smyth (Temp)', ext: '777',
      unique: 2, rung: 4, missed: 1, answered: 3, ttt: '0:09:00', att: '0:03:00',
    }));
  }
});

// QCD Historical Data: one Total-Calls row per dept queue per day (+ a
// CSR sub-source row so per-source breakdowns exist).
const QCD_HEADER = ['Month Year', 'Week', 'Date', 'Call Queue', 'Call Source',
  'Total Calls', 'Total Answered', 'Abandoned', 'Longest Wait', 'Avg Answer', 'Abandoned %', 'Violations'];
const QCD_QUEUES = ['A_Q_CustomerSuccess', 'A_Q_Sales', 'A_Q_Spanish', 'A_Q_PowerChairs', 'A_Q_Billing'];
const qcdRows = [QCD_HEADER];
days.slice(-90).forEach((dIso, i) => {
  QCD_QUEUES.forEach((q, qi) => {
    const total = 40 + Math.round(rnd() * 60) + qi * 5;
    // CSR runs hot on some days (>5% => violations + warn tints).
    const abdPct = (q === 'A_Q_CustomerSuccess' && i % 4 === 0) ? 6 + rnd() * 4 : 1 + rnd() * 4;
    const abd = Math.round(total * abdPct / 100);
    const viol = abdPct >= 5 ? 1 : 0;
    qcdRows.push([dIso.slice(0, 7), '', dIso, q, 'Total Calls', total, total - abd, abd,
      hms(60 + Math.round(rnd() * 200)), hms(10 + Math.round(rnd() * 40)),
      abdPct.toFixed(1) + '%', viol]);
    if (q === 'A_Q_CustomerSuccess') {
      qcdRows.push([dIso.slice(0, 7), '', dIso, q, 'Ad-campaign', Math.round(total * 0.3),
        Math.round(total * 0.28), Math.round(total * 0.02), '0:02:00', '0:00:20',
        (abdPct * 1.2).toFixed(1) + '%', 0]);
    }
  });
});

// Pipeline Health: recent DQE success so the admin staleness banner stays off.
const PH = [['Timestamp', 'Step', 'Status', 'Rows', 'Duration (ms)', 'Notes']];
PH.push([new Date(today.getTime() - 3600e3).toISOString(), 'processIntegratedHistory:DQE', 'success', 42, 1200, LATEST]);
PH.push([new Date(today.getTime() - 3600e3).toISOString(), 'autoImport', 'success', 900, 60000, 'Call_Legs_' + LATEST]);

const SHEETS = {
  'DO NOT EDIT!': ROSTER,
  'DQE Historical Data': dqeSheet(dqeRows),
  'QCD Historical Data': qcdRows,
  'Pipeline Health': PH,
  'Access Control': [['Email', 'Department', 'Notes'], ['manager@ums.com', 'CSR', '']],
};

// ------------------------------------------------------------------ load --
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'NeonRead.gs',
          'MissedCallsReport.gs', 'IndividualReport.gs', 'InsightsReport.gs', 'Digest.gs'],
});

function install(email) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@ums.com';
  h.state.userEmail = email;
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: SHEETS });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  if (h.ctx.QCD_SHEET_DATA_MEMO_ !== undefined) h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  if (h.ctx.QCD_NEON_GRID_MEMO_ !== undefined) h.ctx.QCD_NEON_GRID_MEMO_ = null;
  h.state.cache.clear();
}

function dump(name, obj) {
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(obj));
  const keys = obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 12).join(',') : typeof obj;
  console.log('wrote ' + name + '.json  [' + keys + ']');
}

function span(nDays) {
  const to = LATEST;
  const f = new Date(yesterday); f.setDate(f.getDate() - (nDays - 1));
  return { from: iso(f), to };
}

// ------------------------------------------------------------------ calls --
install('admin@ums.com');
dump('latestDates', h.call('getLatestDataDates'));
dump('ov-admin', h.call('getCompanyOverview', {}));

install('manager@ums.com');
dump('ov-manager', h.call('getCompanyOverview', {}));

// Dept summaries (CSR): single latest day (page default, INV-43), last-30, YTD.
install('admin@ums.com');
dump('summary-day', h.call('getDepartmentSummary', { department: 'CSR', from: LATEST, to: LATEST }));
const s30 = span(30);
dump('summary-30d', h.call('getDepartmentSummary', { department: 'CSR', from: s30.from, to: s30.to }));
const yStart = iso(new Date(today.getFullYear(), 0, 1));
dump('summary-ytd', h.call('getDepartmentSummary', { department: 'CSR', from: yStart, to: LATEST }));

// Missed report: same three windows.
dump('missed-day', h.call('getMissedCallsReport', { department: 'CSR', from: LATEST, to: LATEST }));
dump('missed-30d', h.call('getMissedCallsReport', { department: 'CSR', from: s30.from, to: s30.to }));

// Individual Report (for the IR modal's tab a11y verification).
dump('ir-report', h.call('getIndividualReport', {
  department: 'CSR', from: s30.from, to: s30.to,
  agents: ['Anna Reyes', 'Carla Diaz'],
}));
dump('ir-init', h.call('getIndividualReportInit', { department: 'CSR' }));

// Insights (Phase 2): agent-free whole-dept run over the launcher window
// (last 30 ending yesterday) -- the exact auto-run request -- as admin AND
// manager (identical here; the page gates only the heatmap client-side).
dump('insights', h.call('getInsightsReport', {
  department: 'CSR', from: s30.from, to: s30.to, agents: [],
}));
dump('insights-init', h.call('getInsightsReportInit', { department: 'CSR' }));
try {
  dump('missed-slice', h.call('getMissedCallsSlice', {
    department: 'CSR', from: s30.from, to: s30.to, filter: {},
  }));
} catch (e) { console.log('missed-slice skipped: ' + e.message); }

dump('meta', { latest: LATEST, from30: s30.from, ytdStart: yStart });
console.log('LATEST=' + LATEST);
