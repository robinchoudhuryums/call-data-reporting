'use strict';
/**
 * Assembles the standalone browser harness: dashboard.html with the Apps
 * Script scriptlets replaced by literals, the styles/script includes inlined,
 * CDN libs pointed at local copies, and a google.script.run stub that serves
 * the generated payloads. Output: ./site/index.html (+ vendor/ + payloads/).
 */
const fs = require('fs');
const path = require('path');

const REPO = require('path').resolve(__dirname, '../../apps-script/department-dashboard');
const HERE = __dirname;
const SITE = path.join(HERE, 'site');
fs.mkdirSync(path.join(SITE, 'vendor'), { recursive: true });

// F7: copy the COMMITTED vendor bundles into the built site. They used to be a
// manual `cp` out of node_modules (README step), which meant a fresh checkout
// silently built a site whose Chart global was missing -- every chart then
// rendered through safeChart_'s "unavailable" path and the harness reported
// nothing useful. tests/unit/ui-harness-vendor.test.js pins these to the same
// versions dashboard.html loads from the CDN.
for (const f of ['chart.umd.js', 'datalabels.min.js', 'html2canvas-pro.min.js']) {
  const src = path.join(HERE, 'vendor', f);
  if (!fs.existsSync(src)) {
    console.error('missing committed vendor bundle: tools/ui-harness/vendor/' + f);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(SITE, 'vendor', f));
}

const role = process.argv[2] || 'admin';   // admin | manager

let html = fs.readFileSync(path.join(REPO, 'dashboard.html'), 'utf8');

// #4 (Round-16): script.html is now an ASSEMBLER -- its body is a list of
// nested `include_('script-N-...')` scriptlets resolved server-side by the
// template-evaluating include_ (Code.gs). Mirror that here: recursively
// substitute nested include scriptlets with the named file's content, so the
// harness keeps booting the same assembled client the real page serves. A
// missing fragment file is a hard build error (it would be a render error in
// production too).
function resolveIncludes_(content) {
  return content.replace(/<\?!= include(Js)?_\('([\w-]+)'\) \?>/g, function (_, js, name) {
    const p = path.join(REPO, name + '.html');
    if (!fs.existsSync(p)) {
      console.error('include reference to missing file: ' + name + '.html');
      process.exit(1);
    }
    let body = fs.readFileSync(p, 'utf8');
    if (js) {
      // includeJs_: strip the fragment's own <script> wrapper (Code.gs does
      // the same) so the assembler's single script element stays single.
      const o = body.indexOf('<' + 'script>');
      const c = body.lastIndexOf('</' + 'script>');
      if (o === -1 || c === -1 || c <= o) {
        console.error('fragment ' + name + '.html is not script-tag wrapped');
        process.exit(1);
      }
      body = body.slice(o + 8, c);
    }
    return resolveIncludes_(body);
  });
}
const styles = resolveIncludes_(fs.readFileSync(path.join(REPO, 'styles.html'), 'utf8'));
const script = resolveIncludes_(fs.readFileSync(path.join(REPO, 'script.html'), 'utf8'));

// Payloads inlined as JS (fetch() would work over http, but inline is robust).
const P = {};
for (const f of fs.readdirSync(path.join(HERE, 'payloads'))) {
  P[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(HERE, 'payloads', f), 'utf8'));
}
const meta = P.meta;

const user = role === 'admin'
  ? { email: 'admin@ums.com', role: 'admin', department: null,
      departments: ['CSR', 'Sales', 'Spanish', 'Power', 'Billing'] }
  : { email: 'manager@ums.com', role: 'manager', department: 'CSR' };

// The google.script mock. Chaining API + name-dispatched fixtures; unmocked
// RPCs invoke the FAILURE handler async (mirrors a server throw) and log.
const stub = `<script>
window.__HARNESS__ = { role: ${JSON.stringify(role)}, calls: [], unmocked: [] };
(function () {
  var ROLE = window.__HARNESS__.role;
  var P = ${JSON.stringify(P)};
  function spanDays(req) {
    if (!req || !req.from || !req.to) return 1;
    return Math.round((new Date(req.to) - new Date(req.from)) / 864e5) + 1;
  }
  var handlers = {
    getLatestDataDates: function () { return P.latestDates; },
    getLatestDataDate: function () { return P.latestDates.latest; },
    getCompanyOverview: function () { return P[${JSON.stringify(role)} === 'admin' ? 'ov-admin' : 'ov-manager']; },
    getDepartmentSummary: function (req) {
      var d = spanDays(req);
      // A dept with NO sub-queues, so the single-dept render + CSV stay covered.
      // Checked BEFORE the window branches: it is the department that decides
      // this payload's shape, not the range.
      if (req && req.department && req.department !== 'CSR') return P['summary-30d-sales'];
      // The Team Rings MTD window, by EXACT from/to -- ahead of the span-length
      // buckets, which would hand a 1-2-day-old month the single-day fixture
      // and make "MTD moves the numbers" unsatisfiable (2026-09-03).
      var latestIso = P.latestDates && P.latestDates.latest;
      if (req && !req.subScope && latestIso && P['summary-mtd']
          && req.to === latestIso && req.from === latestIso.slice(0, 8) + '01') {
        return P['summary-mtd'];
      }
      // Sub-queue scope: the 30-day window has all three scopes captured, so the
      // switcher's round-trip is exercised for real instead of always serving the
      // combined payload back. Other windows keep the single (combined) fixture.
      // The client no longer SENDS subScope (the switcher is retired), but the
      // server still honors it and gen-payloads still captures both, so these
      // stay -- a stub that silently stopped serving them would hide a
      // regression in a path the server still supports.
      if (d > 2 && d <= 45 && req && req.subScope === 'own')  return P['summary-30d-own'];
      if (d > 2 && d <= 45 && req && req.subScope === 'subs') return P['summary-30d-subs'];
      if (d <= 2) return P['summary-day'];
      if (d <= 45) return P['summary-30d'];
      return P['summary-ytd'];
    },
    getMissedCallsReport: function (req) {
      return spanDays(req) <= 2 ? P['missed-day'] : P['missed-30d'];
    },
    getIndividualReportInit: function () { return P['ir-init']; },
    getIndividualReport: function () { return P['ir-report']; },
    getInsightsReportInit: function () { return P['insights-init']; },
    // R17d: span-aware, like getDepartmentSummary. The dept page's default
    // window is a single day (INV-43), and only that payload exercises the
    // calendar's year-to-date fallback -- one fixture for every span pinned
    // the region to a 30-day shape it rarely renders in practice.
    getInsightsReport: function (req) {
      return spanDays(req) <= 2 ? P['insights-day'] : P['insights'];
    },
    getMissedCallsSlice: function () { return P['missed-slice']; },
    getQcdAllDepartments: function () { return P['qcd-alldept']; },
    getEscalationsBadge: function () { return { available: true, open: 3, review: 2, overdue: 1 }; },
    getEscalationsInit: function () { var e = JSON.parse(JSON.stringify(P['esc-init'])); if (ROLE==='manager'){e.role='manager';e.isAdmin=false;e.department='CSR';e.departments=['CSR'];} return e; },
    getEscalations: function () { return P[ROLE==='manager' ? 'esc-list-mgr' : 'esc-list']; },
    getEscalationActivity: function () { return P['esc-activity']; },
    getAlertsInit: function () { return P['alerts-init']; },
    getDigestsInit: function () { return P['digests-init']; },
    getQueueReportInit: function () { return P['queuereport-init']; },
    getOrphanFixInit: function () { return P['orphan-init']; },
    getDeptConfigInit: function () { return P['deptconfig-init']; },
    getAccessControlInit: function () { return P['access-init']; },
    getSystemHealth: function () { return P['health']; },
    getUiFlags: function () { return P['ui-flags']; },
    // Batch G: outbound report. Inline fixture; the payload shape is pinned
    // server-side by tests/unit/outbound-report.test.js.
    getOutboundReport: function (req) {
      return {
        meta: { from: (req && req.from) || '2026-07-21', to: (req && req.to) || '2026-08-19',
          department: (req && req.department) || '', companyView: !(req && req.department),
          available: true, vetting: true, callbackWindowDays: 3,
          coverageStart: '2026-08-15', unrosteredAgents: 1, offRosterAgents: 0,
          cacheHit: false, computeMs: 12 },
        kpis: { agents: 2, obTotal: 61, obConnected: 44, obConnectRate: 72.1,
          obTalkSec: 9120, obAttSec: 207, attempts: 70 },
        kpisPrior: { agents: 2, obTotal: 50, obConnected: 35, obConnectRate: 70,
          obTalkSec: 8000, obAttSec: 229, attempts: 60 },
        callback: { abandonedTotal: 25, abandonedAnonymous: 5, abandonedTracked: 20,
          calledBack: 14, calledBackConnected: 9, calledBackPct: 70,
          medianCallbackSec: 1980, pendingTail: 2 },
        callbackPrior: { abandonedTracked: 18, calledBack: 11, calledBackPct: 61.1 },
        daily: [
          { date: '2026-08-17', tracked: 8, calledBack: 6, ratePct: 75 },
          { date: '2026-08-18', tracked: 7, calledBack: 5, ratePct: 71.4 },
          { date: '2026-08-19', tracked: 5, calledBack: 3, ratePct: 60 },
        ],
        agents: [
          { agent: 'Test Agent', dept: 'CSR', obTotal: 40, obConnected: 30,
            obConnectRate: 75, obTalkSec: 6000, obAttSec: 200, attempts: 45 },
          { agent: 'Ghost Dialer', dept: 'Unrostered', obTotal: 21, obConnected: 14,
            obConnectRate: 66.7, obTalkSec: 3120, obAttSec: 223, attempts: 25 },
        ],
      };
    },
    // F-e: coaching worklist (admin-only until released). Inline fixture --
    // small and stable; the payload shape itself is pinned server-side by
    // tests/unit/coaching.test.js.
    getCoachingWorklist: function (req) {
      return { available: true, rows: [
        { id: 'cf-1', department: 'CSR', agent_name: 'Test Agent',
          window_from: '2026-08-03', window_to: '2026-08-14',
          rate_pct: 21.4, team_rate_pct: 78.9, team_ratio_pct: 27.1, gap_pts: 57.5,
          missed: 44, rung: 56, answered: 12, times_flagged: 2, status: 'open',
          created_at: '2026-08-10 13:00:00', updated_at: '2026-08-17 13:00:00',
          closed_by: null, closed_at: null, note: null },
      ], meta: { status: (req && req.status) || 'open',
        lastRunAt: '2026-08-17T13:00:00.000Z',
        lastResult: 'ok 1 new, 1 continuing, 0 recovered-open (2026-08-03..2026-08-14) — emailed admins',
        enabled: true,
        thresholds: { windowWorkdays: 10, maxTeamRatio: 0.5, behindTeamPts: 5, minMissed: 20 } } };
    },
    getOutboundUncalled: function (req) {
      return { meta: { from: (req && req.from) || '2026-07-21', to: (req && req.to) || '2026-08-19',
          department: (req && req.department) || null, companyView: !(req && req.department),
          available: true, truncated: false, scope: 'range', tzLabel: 'CST', callbackWindowDays: 3 },
        calls: [
          { callDate: '2026-08-19', callId: 'oc-1', cstStart: '10:41:00',
            entryQueue: 'A_Q_CSR', finalQueue: 'A_Q_CSR', abandonStage: 'queue',
            abandonedOnHold: false, waitSeconds: 95, holdSeconds: null },
        ] };
    },
    updateCoachingFlagStatus: function (req) { return { id: req && req.id, status: req && req.action }; },
    getCoachingDeliveryStatus: function () {
      return { installed: true, enabled: true, lastRunAt: '2026-08-17T13:00:00.000Z',
        lastResult: 'ok 1 new, 1 continuing, 0 recovered-open (2026-08-03..2026-08-14) — emailed admins' };
    },
    installCoachingDeliveryTrigger: function () { return { installed: true, enabled: true, lastRunAt: null, lastResult: null }; },
    uninstallCoachingDeliveryTrigger: function () { return { installed: false, enabled: false, lastRunAt: null, lastResult: null }; },
    runCoachingDeliveryNow: function () {
      return { result: 'ok 0 new, 1 continuing, 0 recovered-open (2026-08-03..2026-08-14) — no email (nothing new) [manual]',
        newCount: 0, continuingCount: 1, recoveredCount: 0 };
    },
    // getInboundHeatmap intentionally UNMOCKED: Neon-backed; the panel must
    // hide silently on failure (that IS part of the audit).
    // Its CELL drill is mocked (R16h) -- it backs the heatmap cell list AND
    // the Insights day drill's wait-time lens, whose failure mode is an
    // in-panel error rather than the silent hide being audited above.
    getInboundHeatmapCell: function () { return P['heatmap-cell']; },
    // The per-call journey drill. Mocked so a driver can actually CLICK a
    // "↳ path" button: Step 3/4 added three client renderers (the origin
    // line, outboundJourneyHtml_, the not-entitled copy) that were unit-pinned
    // but had never executed in a browser -- the class that let the header
    // dept selector throw in production until a driver first clicked it.
    // Keyed off the request so ONE walk covers all three:
    //   kind='outbound'      -> the linked outbound call (outboundJourneyHtml_)
    //   callId ending '000'  -> a refusal (the not-entitled branch)
    //   otherwise            -> an INTERNAL record carrying an origin agent
    //                           and an OUTBOUND-kind related link
    getCallJourney: function (req) {
      req = req || {};
      if (String(req.kind || '') === 'outbound') {
        return { available: true, found: true, kind: 'outbound', call: {
          callDate: '2026-08-21', callStart: '07:14:29', callId: 'OB-777',
          agentName: 'Marie (Muskaan) Jindal', agentExt: '279',
          department: 'Field Operations (Market Activity)',
          connected: true, talkSeconds: 339, ringSeconds: 10, attempts: 1,
          journey: [{ t: '07:14:29', name: '(external number)', kind: 'answer', talk: 339 }],
        } };
      }
      if (/000$/.test(String(req.callId || ''))) {
        return { available: true, found: false, reason: 'not-entitled' };
      }
      return { available: true, found: true, call: {
        callDate: '2026-08-21', callStart: '07:14:57', callId: String(req.callId || 'IN-1'),
        disposition: 'abandoned', abandonStage: 'queue', abandonedOnHold: false,
        holdSeconds: 0, waitSeconds: 309, entryQueue: 'A_Q_Spanish', finalQueue: 'A_Q_Spanish',
        isInternal: true, relatedCallId: 'OB-777', relatedCallKind: 'outbound',
        originAgent: 'Marie (Muskaan) Jindal',
        originDept: 'Field Operations (Market Activity)',
        numQueues: 1, numTransfers: 0, dialIn: null, insurer: null,
        journey: [{ t: '07:14:57', name: 'A_Q_Spanish', kind: 'queue', abandoned: true, secs: 309 }],
      } };
    },
    getDeptDayAbandons: function () { return P['dept-day-abandons']; },
    // Live-presence heartbeat: fires at load from script-1-core for every
    // role; fire-and-forget on the client, so the ack shape is all it needs.
    recordPresence: function () { return { ok: true }; },
  };
  function makeRunner() {
    var ok = null, fail = null;
    var proxy;
    var runner = {
      withSuccessHandler: function (f) { ok = f; return proxy; },
      withFailureHandler: function (f) { fail = f; return proxy; },
      withUserObject: function () { return proxy; },
    };
    proxy = new Proxy(runner, {
      get: function (t, name) {
        if (name in t) return t[name];
        if (typeof name !== 'string') return undefined;
        return function () {
          var args = [].slice.call(arguments);
          window.__HARNESS__.calls.push({ fn: name, args: args });
          var h = handlers[name];
          setTimeout(function () {
            if (h) { try { ok && ok(h.apply(null, args)); } catch (e) { console.error('[harness ok-handler]', name, e); } }
            else {
              window.__HARNESS__.unmocked.push(name);
              console.warn('[harness] unmocked RPC: ' + name);
              fail && fail(new Error('harness: unmocked RPC ' + name));
            }
          }, 60 + Math.random() * 120);   // realistic latency
        };
      },
    });
    return proxy;
  }
  window.google = {
    script: {
      run: makeRunner(),
      url: { getLocation: function (cb) { cb({ hash: '', parameter: {}, parameters: {} }); } },
      history: { push: function () {}, replace: function () {}, setChangeHandler: function () {} },
      host: { close: function () {}, setHeight: function () {}, setWidth: function () {}, origin: '' },
    },
  };
  Object.defineProperty(window.google.script, 'run', { get: function () { return makeRunner(); } });
})();
</script>`;

// --- substitutions -----------------------------------------------------------
html = html.replace("<?!= include_('styles') ?>", styles);
html = html.replace("<?!= include_('script') ?>", stub + '\n' + script);
html = html.replace('<?!= userJson ?>', JSON.stringify(user));
html = html.replace('<?!= dashboardUrlJson ?>', JSON.stringify('https://example.test/exec'));
html = html.replace('<?!= workWindowJson ?>', JSON.stringify({ pst: '6:30 AM - 3:00 PM PST', cst: '8:30 AM - 5:00 PM CST' }));
html = html.replace('<?!= companyHolidaysJson ?>', JSON.stringify([]));
html = html.replace('<?!= uiFlagsJson ?>', JSON.stringify([]));
html = html.replace('<?!= answerTargetsJson ?>', JSON.stringify({ global: 80, band: 10 }));
// R23: the display-standards bundle (per-dept answer targets + amber bands,
// CSR transfer tiers, the abandon standard) -- mirrors getStandardsBundle_'s
// seed defaults so the three-tier tints render like production.
html = html.replace('<?!= standardsJson ?>', JSON.stringify({
  answer: { global: 80, band: 10, direct: null, inbound: null,
            depts: { CSR: { target: 92, band: 2 } } },
  transfer: { deep: 25, light: 30, amber: 35 },
  abandon: 4,
}));
// Update notice: empty stamp (like a pre-E3 deployment) so the notice stays
// suppressed in the harness -- the recordPresence mock returns no stamp either.
html = html.replace('<?!= buildStampJson ?>', JSON.stringify(''));

// Local vendor copies (downloaded by the runner beforehand). Strip SRI (local).
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js[^"]*"[^>]*>/, '<script src="vendor/chart.umd.js">');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chartjs-plugin-datalabels[^"]*"[^>]*>/, '<script src="vendor/datalabels.min.js">');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/html2canvas-pro[^"]*"[^>]*>/, '<script src="vendor/html2canvas-pro.min.js">');
// Fonts: keep the Google Fonts links (they fail closed to fallbacks offline).

const out = path.join(SITE, 'index-' + role + '.html');
fs.writeFileSync(out, html);
console.log('built ' + out + ' (' + Math.round(html.length / 1024) + ' KB)');
