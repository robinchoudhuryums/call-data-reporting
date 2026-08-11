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
    getInsightsReport: function () { return P['insights']; },
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
    // getInboundHeatmap intentionally UNMOCKED: Neon-backed; the panel must
    // hide silently on failure (that IS part of the audit).
    // Its CELL drill is mocked (R16h) -- it backs the heatmap cell list AND
    // the Insights day drill's wait-time lens, whose failure mode is an
    // in-panel error rather than the silent hide being audited above.
    getInboundHeatmapCell: function () { return P['heatmap-cell']; },
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
html = html.replace('<?!= answerTargetsJson ?>', JSON.stringify({ global: 92 }));

// Local vendor copies (downloaded by the runner beforehand). Strip SRI (local).
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js[^"]*"[^>]*>/, '<script src="vendor/chart.umd.js">');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chartjs-plugin-datalabels[^"]*"[^>]*>/, '<script src="vendor/datalabels.min.js">');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/html2canvas-pro[^"]*"[^>]*>/, '<script src="vendor/html2canvas-pro.min.js">');
// Fonts: keep the Google Fonts links (they fail closed to fallbacks offline).

const out = path.join(SITE, 'index-' + role + '.html');
fs.writeFileSync(out, html);
console.log('built ' + out + ' (' + Math.round(html.length / 1024) + ' KB)');
