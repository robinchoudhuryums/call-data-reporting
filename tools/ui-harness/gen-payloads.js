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
      const picks = [];   // { slot, t } per generated ring
      for (let k = 0; k < Math.min(missed, 4); k++) {
        const slot = 1 + Math.floor(rnd() * 16);
        const hh = 8 + Math.floor(slot / 2), mm = (slot % 2) * 30 + Math.floor(rnd() * 29);
        const t = (hh > 12 ? hh - 12 : hh) + ':' + (mm < 10 ? '0' + mm : mm) + ':15 ' + (hh >= 12 ? 'PM' : 'AM');
        slots[slot] = slots[slot] ? slots[slot] + ',' + t : t;
        picks.push({ slot: slot, t: t });
      }
      row.slots = slots;
      if (di >= days.length - 8 && picks.length >= 2) {   // some abandoned parents recently
        // R17a: alternate between a RE-RUNG parent -- one call, two rings 40s
        // apart (a SIBLING ring appended to the same slot so the timeline
        // carries both, chronologically ADJACENT, sharing one id: the shape
        // the agent card groups) -- and two DISTINCT abandoned calls (no
        // group), so both shapes of the F-2 lockstep are exercised.
        // (the LATEST day always takes the re-rung branch -- it is the dept
        // page's default window, which is where drive-smoke asserts the group)
        if (di % 2 === 0 || di === days.length - 1) {
          const p0 = picks[0];
          const tb = p0.t.replace(':15 ', ':55 ');
          slots[p0.slot] += ',' + tb;
          const id = String(1762242202000 + di * 100);
          row.abdIds = [id, id].join(',');
          row.abdTimes = [p0.t, tb].join(',');
        } else {
          row.abdIds = picks.slice(0, 2).map((_, i2) => String(1762242202000 + di * 100 + i2)).join(',');
          row.abdTimes = picks.slice(0, 2).map(function (p) { return p.t; }).join(',');
        }
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

// CSR Transfer Historical Data (INV-52 schema; computeCsrTransferRange_ reads
// cols 3/6/7 over the range and is CSR-only). Without this sheet every payload
// carried `csrTransfer: null`, so the My Department Transfer % tile -- and the
// R16e Queue-health Transfer % card that mirrors it -- were structurally
// unreachable from the gate. Owner 2026-10-22: the rows are PER AGENT (the
// real sheet's shape), so the agent table's Transfer % column has something to
// join -- each day's totals split across four CSR roster agents, with Robin
// Choudhury deliberately absent so the column's "no transfer row" dash renders.
// The per-day totals (and so the tile) are what they were before the split.
// SB-6: the 11 destination columns (H..R, labels in the header row) too, so
// the Transfer detail's "where the transfers went" bar has data. Each
// transfer takes the next slot of a fixed 20-step pattern (7 named queues, one
// step left OUTSIDE them), so the shares are stable and the untracked part of
// the bar renders as well.
const XFER_DESTS = ['A_Q_Sales', 'A_Q_Billing', 'A_Q_Intake', 'A_Q_PAP', 'A_Q_Spanish', 'A_Q_Supplies', 'A_Q_Returns', '', '', '', ''];
const XFER_PATTERN = [0, 1, 0, 2, 0, 3, 1, 0, 2, 4, 0, 1, 5, 0, 2, 6, 0, 1, 3, -1];
let xferStep = 0;
const CSR_TRANSFER = [['Month Year', 'Week', 'Date', 'Agent', 'Trans %', 'Total Calls', 'Transferred'].concat(XFER_DESTS)];
const XFER_AGENTS = ['Anna Reyes', 'Ben Ortiz', 'Carla Diaz', 'Dev Patel'];
const xferDests = (n) => {
  const out = XFER_DESTS.map(() => 0);
  for (let j = 0; j < n; j++) { const q = XFER_PATTERN[xferStep++ % XFER_PATTERN.length]; if (q >= 0) out[q]++; }
  return out;
};
days.slice(-90).forEach((dIso) => {
  const total = 90 + Math.round(rnd() * 40);
  const transferred = Math.round(total * (0.08 + rnd() * 0.06));
  // Transfers split 10/20/30/40% and calls 35/30/25/10% (remainders to Dev),
  // so the agents land on different tiers -- Dev, few calls and many
  // transfers, reads red. Both still sum to the day's totals.
  const split = (n, ws) => { const out = ws.map((w) => Math.floor(n * w)); out.push(n - out.reduce((a, b) => a + b, 0)); return out; };
  const trs = split(transferred, [0.1, 0.2, 0.3]);
  const cls = split(total, [0.35, 0.3, 0.25]);
  XFER_AGENTS.forEach((agent, i) => {
    const calls = cls[i];
    CSR_TRANSFER.push([dIso.slice(0, 7), '', dIso, agent,
      calls ? (trs[i] / calls * 100).toFixed(1) + '%' : '0%', calls, trs[i]]
      .concat(xferDests(trs[i])));
  });
});

// Pipeline Health: recent DQE success so the admin staleness banner stays off.
const PH = [['Timestamp', 'Step', 'Status', 'Rows', 'Duration (ms)', 'Notes']];
PH.push([new Date(today.getTime() - 3600e3).toISOString(), 'processIntegratedHistory:DQE', 'success', 42, 1200, LATEST]);
PH.push([new Date(today.getTime() - 3600e3).toISOString(), 'autoImport', 'success', 900, 60000, 'Call_Legs_' + LATEST]);

// #81 (owner 2026-10-22): one ALL-department exception day, 8 workdays back --
// inside the 30-day window the dept page opens on, outside "last 7" -- so the
// notes, the striped day bar, the Overview band and the excluded figures are
// all driven by the REAL server code. EXC_DATE is in meta.json for the drivers.
const EXC_DATE = days[days.length - 8];
const EXCEPTION_DAYS = [['Date', 'Departments', 'Reason', 'Active', 'Added By', 'Added At'],
  [EXC_DATE, '', '8x8 outage', 'TRUE', 'admin@ums.com', '2026-01-01T00:00:00Z']];

const SHEETS = {
  'Exception Days': EXCEPTION_DAYS,
  'DO NOT EDIT!': ROSTER,
  'DQE Historical Data': dqeSheet(dqeRows),
  'QCD Historical Data': qcdRows,
  'CSR Transfer Historical Data': CSR_TRANSFER,
  'Pipeline Health': PH,
  'Access Control': [['Email', 'Department', 'Notes'], ['manager@ums.com', 'CSR', '']],
};

// ------------------------------------------------------------------ load --
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'NeonRead.gs',
          'MissedCallsReport.gs', 'IndividualReport.gs', 'InsightsReport.gs', 'Digest.gs',
          'NeonCoverage.gs', 'InboundReport.gs', 'OutboundReport.gs', 'DirectCallReport.gs',
          'ExceptionDays.gs'],   // #81: the editor's init
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

// Batch E2: a fake Neon connection that answers ONLY the Overview's grouped
// outbound read (the SQL carries p_yesterday), so the tiles' outbound line is
// produced by the REAL ovReadOutboundByDept_ + shaper + strip. Every other
// statement throws, so nothing else in the Overview silently reads it.
function withOverviewOutboundConn(fn) {
  const per = Object.keys(DEPT_OF).map(function (a, i) {
    const r = { agent: a };
    [['yesterday', 1], ['last30', 22], ['last60', 44], ['last90', 66], ['ytd', 70]].forEach(function (kv) {
      const placed = (3 + (i * 5) % 11) * kv[1];
      r['p_' + kv[0]] = placed;
      r['c_' + kv[0]] = Math.round(placed * (0.4 + (i % 5) * 0.08));
      // Batch F1: the prior window's counts (the real shaper drops the ones
      // whose window predates capture), varied so chips go both ways.
      const pp = Math.max(0, Math.round(placed * (0.75 + ((i * 7) % 6) * 0.1)));
      r['pp_' + kv[0]] = pp;
      r['pc_' + kv[0]] = Math.round(pp * (0.45 + (i % 3) * 0.06));
    });
    return r;
  });
  const blob = JSON.stringify({ agents: per, coverageStart: '2026-07-10' });
  const realConn = h.ctx.getDashboardNeonConn_;
  h.ctx.getDashboardNeonConn_ = function () {
    return {
      createStatement: function () {
        return { executeQuery: function (sql) {
          if (String(sql).indexOf('p_yesterday') === -1) throw new Error('harness: only the outbound read is faked');
          let n = 0;
          return { next: function () { return n++ === 0; }, getString: function () { return blob; }, close: function () {} };
        }, close: function () {} };
      },
      close: function () {},
    };
  };
  try { return fn(); } finally { h.ctx.getDashboardNeonConn_ = realConn; }
}

// ------------------------------------------------------------------ calls --
install('admin@ums.com');
dump('latestDates', h.call('getLatestDataDates'));
dump('ov-admin', withOverviewOutboundConn(function () { return h.call('getCompanyOverview', {}); }));
// F47: the Overview chart's YTD range (fetched on demand, viewer-shaped).
dump('ovytd-admin', h.call('getOverviewChartTrend', {}));

install('manager@ums.com');
dump('ov-manager', withOverviewOutboundConn(function () { return h.call('getCompanyOverview', {}); }));
dump('ovytd-manager', h.call('getOverviewChartTrend', {}));

// Dept summaries (CSR): single latest day (page default, INV-43), last-30, YTD.
install('admin@ums.com');
dump('summary-day', h.call('getDepartmentSummary', { department: 'CSR', from: LATEST, to: LATEST }));
// The Team Rings panel's MTD window (`latest.slice(0,8)+'01' .. latest`,
// script-5-dept). Captured for REAL so the mock can serve it by exact window:
// routing it by span LENGTH served the single-day fixture back whenever the
// month was 1-2 days old, and the "MTD moves the numbers" check failed on the
// 3rd with nothing but docs changed (2026-09-03).
dump('summary-mtd', h.call('getDepartmentSummary',
  { department: 'CSR', from: LATEST.slice(0, 8) + '01', to: LATEST }));
const s30 = span(30);
dump('summary-30d', h.call('getDepartmentSummary', { department: 'CSR', from: s30.from, to: s30.to }));
// Batch D: the My Department Outbound / Both view, served by the REAL
// getDeptOutboundSummary (roster attribution, PC-12 grouping, team per-day)
// over a deterministic outbound_calls blob built from the same agents, plus
// one dialler on no roster (left out, and counted in the disclosure note).
{
  const sum = JSON.parse(fs.readFileSync(path.join(OUT, 'summary-30d.json'), 'utf8'));
  const agents = (sum.rows || []).map(function (r, i) {
    const total = 4 + ((i * 7) % 23);
    const conn = Math.max(1, Math.round(total * (0.45 + (i % 4) * 0.1)));
    return { agent: r.agent, ob_total: total, ob_connected: Math.min(conn, total),
      ob_unconn_brief: Math.floor((total - Math.min(conn, total)) / 2),
      ob_unconn_real: Math.ceil((total - Math.min(conn, total)) / 2),
      ob_talk_sec: Math.min(conn, total) * (90 + i * 13), attempts: total + (i % 3), ob_days: 3 + (i % 9) };
  });
  agents.push({ agent: 'Off Roster Dialler', ob_total: 9, ob_connected: 4, ob_unconn_brief: 2,
    ob_unconn_real: 3, ob_talk_sec: 600, attempts: 10, ob_days: 2 });
  // Batch E1: the Insights Outbound fold compares the current window with its
  // prior window, so each window gets its own scaled blob (identical blobs
  // would render every delta as "no change" and hide the delta path).
  let blob = JSON.stringify({ agents: agents, coverageStart: '2026-07-10' });
  function scaled(f) {
    return JSON.stringify({ coverageStart: '2026-07-10', agents: agents.map(function (a) {
      const t = Math.max(1, Math.round(a.ob_total * f)); const c = Math.min(t, Math.round(a.ob_connected * f * 0.95));
      return Object.assign({}, a, { ob_total: t, ob_connected: c, ob_unconn_brief: Math.floor((t - c) / 2),
        ob_unconn_real: Math.ceil((t - c) / 2), ob_talk_sec: c * 100 });
    }) });
  }
  const realConn = h.ctx.getDashboardNeonConn_;
  h.ctx.getDashboardNeonConn_ = function () {
    return {
      createStatement: function () {
        return { executeQuery: function () {
          let n = 0;
          return { next: function () { return n++ === 0; }, getString: function () { return blob; }, close: function () {} };
        }, close: function () {} };
      },
      close: function () {},
    };
  };
  dump('dept-outbound-30d', h.call('getDeptOutboundSummary', { department: 'CSR', from: s30.from, to: s30.to }));
  // Batch E1: the Insights fold's OTHER windows (the 30-day one is
  // dept-outbound-30d above, which the mock serves first): its prior, and the
  // single-day payload's current + prior, by exact from|to. Scaled so the
  // prior differs and the delta path renders.
  const pw = h.call('computePriorWindow_', s30.from, s30.to);
  const pwDay = h.call('computePriorWindow_', LATEST, LATEST);
  const windows = {};
  [[pw.from, pw.to, 0.85], [LATEST, LATEST, 0.2], [pwDay.from, pwDay.to, 0.25]].forEach(function (w) {
    blob = scaled(w[2]);
    h.state.cache.clear();
    windows[w[0] + '|' + w[1]] = h.call('getDeptOutboundSummary', { department: 'CSR', from: w[0], to: w[1] });
  });
  dump('dept-outbound-windows', windows);
  h.ctx.getDashboardNeonConn_ = realConn;
}
// D1 (owner 2026-10-21): the Direct Calls report, served by the REAL
// getDirectCallReport over a fake direct_call_history. The data stops one
// workday BEFORE the asked end (the not-yet-imported day -> the clamp) and
// one mid-window workday has no rows (-> the missing-workday note, the prior
// chips dropped); 'direct-all-clean' has full coverage, so its chips render.
{
  const sum = JSON.parse(fs.readFileSync(path.join(OUT, 'summary-30d.json'), 'utf8'));
  const rows = (sum.rows || []).filter(function (r) { return r.agent; });
  const agentRows = function (dept) {
    return rows.map(function (r, i) {
      const ia = 3 + (i % 4), ea = 9 + (i * 5) % 17, imf = i % 3, emf = 2 + (i % 5), imb = i % 2, emb = 1 + (i % 3);
      const ot = 6 + (i * 3) % 11, oi = 1 + (i % 3), oc = Math.max(1, ot - 2 - (i % 3));
      return { agent: r.agent, dept: dept, ib_answered: ia + ea, ib_missed_free: imf + emf, ib_missed_busy: imb + emb,
        ib_talk_sec: (ia + ea) * (95 + i * 7), ib_int_answered: ia, ib_ext_answered: ea,
        ib_int_missed_free: imf, ib_ext_missed_free: emf, ib_int_missed_busy: imb, ib_ext_missed_busy: emb,
        ob_total: ot, ob_connected: oc, ob_talk_sec: oc * 110, ob_int_total: oi, ob_ext_total: ot - oi,
        ob_int_connected: Math.min(oi, oc), ob_ext_connected: oc - Math.min(oi, oc) };
    });
  };
  const sumK = function (as) {
    const k = { agents: as.length };
    const f = { ibAnswered: 'ib_answered', ibMissedFree: 'ib_missed_free', ibMissedBusy: 'ib_missed_busy', ibTalkSec: 'ib_talk_sec',
      obTotal: 'ob_total', obConnected: 'ob_connected', obTalkSec: 'ob_talk_sec',
      ibIntAnswered: 'ib_int_answered', ibExtAnswered: 'ib_ext_answered', ibIntMissedFree: 'ib_int_missed_free',
      ibExtMissedFree: 'ib_ext_missed_free', ibIntMissedBusy: 'ib_int_missed_busy', ibExtMissedBusy: 'ib_ext_missed_busy',
      obIntTotal: 'ob_int_total', obExtTotal: 'ob_ext_total', obIntConnected: 'ob_int_connected', obExtConnected: 'ob_ext_connected' };
    Object.keys(f).forEach(function (c) { k[c] = as.reduce(function (t, a) { return t + (a[f[c]] || 0); }, 0); });
    return k;
  };
  const csr = agentRows('CSR');
  const all = csr.concat(agentRows('Sales').slice(0, 3).map(function (a, i) { return Object.assign({}, a, { agent: ['Elena Park', 'Frank Wu', 'Gita Rao'][i] }); }));
  const prior = function (k) { return Object.assign({}, k, { ibAnswered: Math.round(k.ibAnswered * 0.9), ibMissedFree: Math.round(k.ibMissedFree * 1.1), obTotal: Math.round(k.obTotal * 0.8) }); };
  const asked = days.slice(-22);                       // ~a month of workdays
  const gap = asked[10];                               // one workday with no rows
  const mxShort = days[days.length - 2];               // the data stops a workday early
  const presentShort = days.filter(function (d) { return d <= mxShort && d !== gap; });
  const connFor = function (cov, body) {
    return function () {
      return { createStatement: function () {
        return { executeQuery: function (sql) {
          const j = String(sql).indexOf("'mx'") !== -1 ? JSON.stringify(cov) : JSON.stringify(body);
          let n = 0;
          return { next: function () { return n++ === 0; }, getString: function () { return j; }, close: function () {} };
        }, close: function () {} };
      }, close: function () {} };
    };
  };
  const realConn = h.ctx.getDashboardNeonConn_;
  install('admin@ums.com');
  h.state.cache.clear();
  h.ctx.getDashboardNeonConn_ = connFor({ mx: mxShort, days: presentShort },
    { kpis: sumK(csr), agents: csr, kpisPrior: prior(sumK(csr)), deptsPrior: [], coverageStart: days[0] });
  dump('direct-30d', h.call('getDirectCallReport', { from: asked[0], to: LATEST, department: 'CSR' }));
  h.state.cache.clear();
  h.ctx.getDashboardNeonConn_ = connFor({ mx: LATEST, days: days },
    { kpis: sumK(all), agents: all, kpisPrior: prior(sumK(all)),
      deptsPrior: [{ dept: 'CSR', ib_answered: 400, ib_missed_free: 60, ib_missed_busy: 30, ob_total: 150 },
                   { dept: 'Sales', ib_answered: 90, ib_missed_free: 20, ib_missed_busy: 5, ob_total: 40 }],
      coverageStart: days[0] });
  dump('direct-all-clean', h.call('getDirectCallReport', { from: asked[0], to: LATEST, department: '' }));
  dump('direct-meta', { asked: { from: asked[0], to: LATEST }, gap: gap, dataThrough: mxShort });
  h.ctx.getDashboardNeonConn_ = realConn;
}
const yStart = iso(new Date(today.getFullYear(), 0, 1));
dump('summary-ytd', h.call('getDepartmentSummary', { department: 'CSR', from: yStart, to: LATEST }));
// Sub-queue scopes. The fixture roster already nests Spanish under CSR (the
// OVERVIEW_PARENT_OF constant), so the DEFAULT CSR payload above is already the
// COMBINED view -- these two add the other scopes so the switcher round-trip and
// the subtotal-parity property are testable in the browser rather than assumed.
dump('summary-30d-own', h.call('getDepartmentSummary',
  { department: 'CSR', from: s30.from, to: s30.to, subScope: 'own' }));
dump('summary-30d-subs', h.call('getDepartmentSummary',
  { department: 'CSR', from: s30.from, to: s30.to, subScope: 'subs' }));
// A dept with NO sub-queues, so the single-dept paths stay covered -- above all
// the CSV's byte-compatibility guarantee (no leading `Department` column), which
// lost its automated cover when the scope switcher was retired and there was no
// one-dept payload left to drive.
//
// Sales qualifies WITHOUT any fixture-data change: its seeded child in
// OVERVIEW_PARENT_OF is `PAP`, which is not in this roster, and
// subQueueChildMap_ drops an edge naming a dept that does not exist. So Sales
// renders exactly like the 11 of 14 real departments that never had a
// sub-queue, while still having agents and data.
dump('summary-30d-sales', h.call('getDepartmentSummary',
  { department: 'Sales', from: s30.from, to: s30.to }));

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
// R17d: the SINGLE-DAY insights payload. The dept page's default window is
// one day (INV-43), so this -- not the 30-day capture above -- is what the
// region actually renders on a cold load, and it is the only payload whose
// `trendDaily` is too short to fill a calendar (the trendYtd fallback path).
// Serving one payload for every span hid that whole branch from the gate.
dump('insights-day', h.call('getInsightsReport', {
  department: 'CSR', from: LATEST, to: LATEST, agents: [],
}));
// E5 / ST4: a SECOND department's Insights, from the real server code, so a
// dept switch is observable in the rendered brief -- with one CSR payload for
// every request, a brief left showing the previous dept's numbers would read
// as correct. Sales has no answer target of its own (the G2 default label).
dump('insights-sales', h.call('getInsightsReport', {
  department: 'Sales', from: s30.from, to: s30.to, agents: [],
}));
dump('insights-day-sales', h.call('getInsightsReport', {
  department: 'Sales', from: LATEST, to: LATEST, agents: [],
}));
dump('insights-init', h.call('getInsightsReportInit', { department: 'CSR' }));
try {
  dump('missed-slice', h.call('getMissedCallsSlice', {
    department: 'CSR', from: s30.from, to: s30.to, filter: {},
  }));
} catch (e) { console.log('missed-slice skipped: ' + e.message); }

// R16h: the inbound abandon list behind the heatmap cell drill AND the
// Insights Daily-breakdown day drill's second lens. HAND-AUTHORED, unlike
// every payload above: getInboundHeatmapCell reads Neon, which this generator
// has no connection to. The shape is the one the server's row mapper emits
// and `tests/unit/heatmap-cell-drill.test.js` pins field by field, so a
// server-side shape change fails there rather than silently drifting here.
// (getInboundHeatmap itself stays UNMOCKED on purpose -- the panel hiding
// silently on failure is part of what the gate audits.)
dump('heatmap-cell', {
  meta: { available: true, scope: 'range', from: LATEST, to: LATEST,
    department: 'CSR', companyView: false, unmapped: false,
    dow: null, slot: null, truncated: false,
    windowStartHour: 8, slotMinutes: 60, tzLabel: 'CST' },
  calls: [
    { callDate: LATEST, callId: '1762242202191', cstStart: '09:12:44', entryQueue: 'A_Q_CustomerSuccess',
      finalQueue: 'A_Q_CustomerSuccess', abandonStage: 'queue', abandonedOnHold: false,
      waitSeconds: 96, holdSeconds: null },
    { callDate: LATEST, callId: '1762242165529', cstStart: '10:41:09', entryQueue: 'A_Q_CustomerSuccess',
      finalQueue: 'Backup CSR', abandonStage: 'queue', abandonedOnHold: false,
      waitSeconds: 142, holdSeconds: null },
    { callDate: LATEST, callId: '1762242119004', cstStart: '13:28:31', entryQueue: 'A_Q_CustomerSuccess',
      finalQueue: 'A_Q_CustomerSuccess', abandonStage: null, abandonedOnHold: true,
      waitSeconds: 58, holdSeconds: 74 },
    { callDate: LATEST, callId: '1762242093117', cstStart: '15:02:10', entryQueue: 'A_Q_Spanish',
      finalQueue: 'A_Q_Spanish', abandonStage: 'queue', abandonedOnHold: false,
      waitSeconds: 211, holdSeconds: null },
  ],
});

// R16i: the SAME rows as the cell drill, plus the reconcile note only
// getDeptDayAbandons ships (it renders beneath a QCD-sourced abandon count,
// and the two figures differ by definition). Separate key so the heatmap
// cell fixture keeps NOT carrying the note -- that endpoint doesn't send one.
dump('dept-day-abandons', (function () {
  const cell = JSON.parse(fs.readFileSync(path.join(OUT, 'heatmap-cell.json'), 'utf8'));
  cell.meta.scope = 'day';
  cell.meta.reconcileNote = 'Counts callers who hung up before reaching an agent. '
    + 'The Queue-health \u201cAbandoned\u201d figure counts only callers who waited past its '
    + 'threshold, so the two numbers differ \u2014 often several-fold. Both are correct; '
    + 'they answer different questions.';
  return cell;
})());

// All-departments Daily Call Queue Report (F7 fixture gap): without this the
// #qcd-alldept-modal had no payload, so its `tr.qcd-expandable` rows never
// rendered and the F13 keyboard fix could only be verified on the Insights
// Queue-health table (same markup + helper, but not the same screen).
// Single day = the report's own default (the latest queue day).
dump('qcd-alldept', h.call('getQcdAllDepartments', { from: LATEST, to: LATEST }));

// #81: the exception-day editor's first paint, from the REAL init.
dump('exception-init', h.call('getExceptionDaysInit'));
dump('meta', { latest: LATEST, from30: s30.from, ytdStart: yStart, excDate: EXC_DATE });
console.log('LATEST=' + LATEST);
