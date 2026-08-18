'use strict';
/**
 * Agent role Phase B: builds the AGENT app site (site/index-agent.html) from
 * the REAL client files (agent.html + styles.html + agentApp.html) and a
 * payload computed by the REAL getAgentHome (AgentHome.gs via the loadGas
 * harness -- computeSummary_/the DAL are fixture-fed, but the endpoint, its
 * projections, and every payload field the client renders are the real code).
 *
 * Run: node build-agent.js   (then: node drive-agent.js)
 */
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../../tests/harness/loadGas');

const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const SITE = path.join(__dirname, 'site');

// ── 1. Payload from the real endpoint ─────────────────────────────────────
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'AgentHome.gs'] });
h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
h.state.userEmail = 'agent1@x.com';
h.ctx.resolveUser_ = function () {
  return { email: 'agent1@x.com', role: 'agent', department: null, departments: [],
           allDepts: false, agentDept: 'CSR', agentName: 'Maria Lopez' };
};
h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
h.ctx.parseIsoNoon_ = function (iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
};
h.ctx.hashAgents_ = function (list) { return 'h' + list.join('|').length; };
h.ctx.logReportUsage_ = function () {};
h.ctx.computeSummary_ = function () {
  return {
    rows: [
      { agent: 'Maria Lopez', matchedViaRoster: true, totalRung: 160, totalMissed: 9,
        totalAnswered: 142, totalUnique: 120, attSeconds: 192, daysActive: 9 },
      { agent: 'Devon Park', matchedViaRoster: true, totalRung: 150, totalMissed: 20,
        totalAnswered: 120, totalUnique: 100, attSeconds: 185, daysActive: 9 },
      { agent: 'Sam Reed', matchedViaRoster: true, totalRung: 120, totalMissed: 12,
        totalAnswered: 108, totalUnique: 90, attSeconds: 201, daysActive: 8 },
    ],
    totals: { totalAnswered: 370, totalMissed: 41, totalRung: 430, attSeconds: 193, rosterAgentCount: 3 },
  };
};
h.ctx.ahFetchDalRows_ = function () {
  const rows = [];
  // 20 weekdays of own trend + a few missed-slot days.
  for (let i = 0; i < 28; i++) {
    const d = new Date(2026, 7, 13 - i, 12);   // ending 2026-08-13
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const pad = (x) => (x < 10 ? '0' + x : String(x));
    const iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    rows.push({ dateIso: iso, agent: 'Maria Lopez',
      totalAnswered: 12 + (i % 5), totalMissed: i % 3, attSec: 170 + (i % 40),
      slots: (i % 3) ? ['10:23:33,10:08:41', '', '14:41:00'].slice(0, (i % 3)) : [] });
  }
  return rows;
};
const payload = h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13' });
const latestIso = '2026-08-13';

// Phase C: the history payload from the REAL getAgentHistory (12-month DAL
// fixture; team = Maria + a teammate so the you-vs-team line has separation).
h.ctx.getLatestDataDate = function () { return latestIso; };
h.ctx.getRosterForDepartment_ = function () { return { names: ['Maria Lopez', 'Devon Park'] }; };
const histRows = [];
for (let mo = 0; mo < 12; mo++) {
  const d = new Date(2026, 7 - mo, 10, 12);
  const pad = (x) => (x < 10 ? '0' + x : String(x));
  const iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  histRows.push({ dateIso: iso, agent: 'Maria Lopez',
    totalAnswered: 260 + mo * 3, totalMissed: 14 + (mo % 6), attSec: 180 + (mo % 30) });
  histRows.push({ dateIso: iso, agent: 'Devon Park',
    totalAnswered: 220, totalMissed: 26, attSec: 200 });
}
h.ctx.ahFetchDalRows_ = function () { return histRows; };
const historyPayload = h.call('getAgentHistory', {});

// ── 2. Assemble the page ──────────────────────────────────────────────────
const read = (f) => fs.readFileSync(path.join(DASH, f), 'utf8');
let html = read('agent.html');
html = html.replace("<?!= include_('styles') ?>", read('styles.html'));
html = html.replace("<?!= include_('agentApp') ?>", read('agentApp.html'));
html = html.replace('<?!= userJson ?>', JSON.stringify({
  email: 'agent1@x.com', role: 'agent', agentDept: 'CSR', agentName: 'Maria Lopez',
}));
html = html.replace('<?!= workWindowJson ?>', JSON.stringify('8:30 AM – 5:00 PM CST'));
// R23: the server-resolved dept answer standard (CSR pilot -> the 92/2 seed).
html = html.replace('<?!= answerStdJson ?>', JSON.stringify({ target: 92, band: 2 }));
if (html.indexOf('<?!=') !== -1) {
  console.error('build-agent: unresolved scriptlet remains in the assembled page.');
  process.exit(1);
}

// Mock google.script.run BEFORE the app script boots. Calls to unmocked
// functions are recorded (the drive asserts none); beacon calls are recorded
// separately (an app that ERRORS reports itself -- the drive reads both).
const mock = `<script>
(function () {
  var PAYLOAD = ${JSON.stringify(payload)};
  var HISTORY = ${JSON.stringify(historyPayload)};
  var LATEST = ${JSON.stringify(latestIso)};
  window.__MOCK_UNMOCKED__ = [];
  window.__MOCK_BEACONS__ = [];
  function runner() {
    var onOk = function () {}, onErr = function () {};
    var api = {
      withSuccessHandler: function (f) { onOk = f; return api; },
      withFailureHandler: function (f) { onErr = f; return api; },
      withUserObject: function () { return api; },
      getLatestDataDate: function () { setTimeout(function () { onOk(LATEST); }, 10); },
      getAgentHome: function (req) { setTimeout(function () { onOk(PAYLOAD); }, 20); },
      getAgentHistory: function (req) { setTimeout(function () { onOk(HISTORY); }, 20); },
      reportClientIssue: function (p) { window.__MOCK_BEACONS__.push(p); setTimeout(function () { onOk({ok:true}); }, 5); },
      // Live-presence heartbeat: fires at load; fire-and-forget ack.
      recordPresence: function () { setTimeout(function () { onOk({ok:true}); }, 5); },
    };
    return new Proxy(api, {
      get: function (t, k) {
        if (k in t) return t[k];
        return function () { window.__MOCK_UNMOCKED__.push(String(k)); setTimeout(function () { onErr(new Error('unmocked: ' + String(k))); }, 5); };
      },
    });
  }
  window.google = { script: { run: runner() } };
  // Each chained call sequence needs a fresh handler pair.
  Object.defineProperty(window.google.script, 'run', { get: function () { return runner(); } });
})();
</script>`;
html = html.replace('<script>\n    window.__USER__', mock + '\n<script>\n    window.__USER__');

if (!fs.existsSync(SITE)) fs.mkdirSync(SITE, { recursive: true });
fs.writeFileSync(path.join(SITE, 'index-agent.html'), html);
console.log('build-agent: wrote site/index-agent.html (' + html.length + ' bytes; payload from real getAgentHome)');
