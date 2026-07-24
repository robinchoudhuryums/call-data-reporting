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

const role = process.argv[2] || 'admin';   // admin | manager

let html = fs.readFileSync(path.join(REPO, 'dashboard.html'), 'utf8');
const styles = fs.readFileSync(path.join(REPO, 'styles.html'), 'utf8');
const script = fs.readFileSync(path.join(REPO, 'script.html'), 'utf8');

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
    getInsightsReport: function () { return P['insights']; },
    getMissedCallsSlice: function () { return P['missed-slice']; },
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
    // getInboundHeatmap intentionally UNMOCKED: Neon-backed; the panel must
    // hide silently on failure (that IS part of the audit).
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

// Local vendor copies (downloaded by the runner beforehand). Strip SRI (local).
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js[^"]*"[^>]*>/, '<script src="vendor/chart.umd.js">');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chartjs-plugin-datalabels[^"]*"[^>]*>/, '<script src="vendor/datalabels.min.js">');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/html2canvas-pro[^"]*"[^>]*>/, '<script src="vendor/html2canvas-pro.min.js">');
// Fonts: keep the Google Fonts links (they fail closed to fallbacks offline).

const out = path.join(SITE, 'index-' + role + '.html');
fs.writeFileSync(out, html);
console.log('built ' + out + ' (' + Math.round(html.length / 1024) + ' KB)');
