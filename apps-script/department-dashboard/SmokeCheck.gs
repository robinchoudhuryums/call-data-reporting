/**
 * Live smoke harness (Batch 10) — an editor-run, READ-ONLY pass/fail sweep
 * of the live install's main read paths, emailed to the admins.
 *
 * WHY: the unit harness (node --test) pins the pure compute logic against
 * fixtures, but it cannot see a LIVE install's wiring — a missing Script
 * Property, an un-consented OAuth scope, a renamed sheet, a Neon outage,
 * a roster edit that emptied a dept. This sweep exercises the real
 * spreadsheet + real Neon + real config through the SAME compute helpers
 * the public endpoints use, so "deploy went out but the dashboard is
 * broken" is caught by one Run click instead of the first manager of the
 * morning. It complements — not replaces — the manual Regression
 * Scenarios in CLAUDE.md (client-side surfaces like deep links, the tour,
 * and modal wiring still need a browser).
 *
 * WHAT IT DOES NOT DO: no writes (the one side effect is the
 * SMOKE_LAST / SMOKE_LAST_RESULT Script Properties + the email), no cache
 * puts (it calls the compute helpers, not the caching get* endpoints —
 * except getLatestDataDate/getLatestDataDates, whose small cache writes
 * are real values any dashboard open would produce), and no Report Usage
 * telemetry rows (compute helpers don't log usage; the suppress flag is
 * set belt-and-suspenders anyway).
 *
 * HOW TO RUN: Apps Script editor → Run → runLiveSmoke (admin account).
 * The result emails getAdminEmails_() and lands on the Health page as the
 * "Live smoke — last run" outcome row (OPS-8 prefix-coded: a healthy run
 * leads with "ok", a failing one with "FAILED").
 */

var SMOKE_INSIGHTS_WINDOW_DAYS_ = 7;   // small window keeps the sweep cheap

function runLiveSmoke() {
  assertAdmin_();
  // Belt-and-suspenders: never let a smoke run skew the Report Usage
  // evidence base (the F-27 cache-warm discipline), even if a future
  // check reaches a get* endpoint.
  REPORT_USAGE_SUPPRESS_ = true;
  var checks;
  try {
    checks = liveSmokeChecks_();
  } finally {
    REPORT_USAGE_SUPPRESS_ = false;
  }

  var failed = checks.filter(function (c) { return !c.ok; });
  var summary = (failed.length
      ? 'FAILED ' + failed.length + '/' + checks.length
      : 'ok ' + checks.length + '/' + checks.length)
    + ' | ' + checks.map(function (c) {
        return c.name + (c.ok ? ' ok' : ' FAIL');
      }).join(' | ');

  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('SMOKE_LAST', new Date().toISOString());
    props.setProperty('SMOKE_LAST_RESULT', summary);
  } catch (e) { Logger.log('runLiveSmoke: could not record SMOKE_LAST_RESULT: ' + e); }

  // One line per check in the log (the editor's immediate feedback) …
  checks.forEach(function (c) {
    Logger.log('[smoke] %s %s (%sms)%s', c.ok ? 'PASS' : 'FAIL', c.name, c.ms,
      c.note ? ' — ' + c.note : '');
  });

  // … and the email artifact. Best-effort: a mail failure must not turn a
  // green smoke into a throw.
  try {
    var subject = 'Live smoke: ' + (failed.length
      ? 'FAIL (' + (checks.length - failed.length) + '/' + checks.length + ' passed)'
      : 'PASS (' + checks.length + '/' + checks.length + ')');
    var body = 'Dashboard live smoke run — ' + new Date() + '\n\n'
      + checks.map(function (c) {
          return (c.ok ? '[PASS] ' : '[FAIL] ') + c.name + ' (' + c.ms + 'ms)'
            + (c.note ? '\n       ' + c.note : '');
        }).join('\n')
      + '\n\nRe-run from the Apps Script editor: Run -> runLiveSmoke.';
    MailApp.sendEmail(getAdminEmails_().join(','), subject, body);
  } catch (mailErr) {
    Logger.log('runLiveSmoke: result email failed: ' + mailErr);
  }

  return { summary: summary, checks: checks };
}

/**
 * The check list. Each check is independently try/caught and timed; a
 * throw becomes its FAIL note. Later checks that depend on an earlier
 * one's output (latest date, first dept) fail with a "skipped:" note
 * rather than throwing confusingly on null.
 */
function liveSmokeChecks_() {
  var checks = [];
  var run = function (name, fn) {
    var t0 = Date.now();
    try {
      var note = fn();
      checks.push({ name: name, ok: true, ms: Date.now() - t0,
                    note: String(note == null ? '' : note) });
    } catch (e) {
      checks.push({ name: name, ok: false, ms: Date.now() - t0,
                    note: String(e && e.message ? e.message : e) });
    }
  };

  // 1. The CDR Report spreadsheet opens and DQE Historical Data has rows.
  run('sheet-open', function () {
    var ss = openSpreadsheet_();
    var dqe = ss.getSheetByName('DQE Historical Data');
    if (!dqe) throw new Error('DQE Historical Data sheet not found — SPREADSHEET_ID pointing at the right workbook?');
    if (dqe.getLastRow() < 2) throw new Error('DQE Historical Data has no data rows');
    return (dqe.getLastRow() - 1) + ' data rows';
  });

  // 2. Latest-date lookup (source-aware: exercises Neon when
  //    DQE_READ_SOURCE=neon, the sheet scan otherwise).
  var latestIso = null;
  run('latest-dqe-date', function () {
    var raw = getLatestDataDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw || ''))) {
      throw new Error('unexpected value: ' + raw);
    }
    latestIso = raw;
    return latestIso + ' (source=' + getDqeReadSource_() + ')';
  });

  // 3. My Department aggregation for the first roster dept on the latest day.
  var dept = null;
  run('dept-summary', function () {
    if (!latestIso) throw new Error('skipped: no latest DQE date');
    var depts = getAllDepartments_();
    if (!depts || !depts.length) throw new Error('no departments on the DO NOT EDIT! roster');
    dept = depts[0];
    var s = computeSummary_(dept, latestIso, latestIso, 'roster');
    if (!s || !Array.isArray(s.rows)) throw new Error('summary payload has no rows array');
    return dept + ' ' + latestIso + ': ' + s.rows.length + ' agent row(s)';
  });

  // 4. Missed Calls compute (slot/abandoned detail path, incl. the
  //    classifyAbandonedCell_ read-side guards).
  run('missed-report', function () {
    if (!dept || !latestIso) throw new Error('skipped: prior check failed');
    var m = computeMissedCallsReport_(dept, latestIso, latestIso, 'roster');
    if (!m || !m.meta) throw new Error('missed payload has no meta');
    return m.meta.totalMissed + ' missed · ' + m.meta.abandonedCallCount + ' abandoned'
      + (m.meta.abandonedDetailLost ? ' · DETAIL LOST on ' + (m.meta.abandonedDetailLostDates || []).join(',') : '');
  });

  // 5. Insights agent-free compute over a short window (team rollup +
  //    Queue health -- the manager's primary surface).
  run('insights', function () {
    if (!dept || !latestIso) throw new Error('skipped: prior check failed');
    var roster = getRosterForDepartment_(dept);
    var agents = resolveInsightsAgents_([], roster);
    if (!agents.length) throw new Error('empty roster for ' + dept);
    var from = smokeShiftIso_(latestIso, -(SMOKE_INSIGHTS_WINDOW_DAYS_ - 1));
    var ins = computeInsights_(dept, from, latestIso, agents, roster, '', '');
    if (!ins || !ins.teamStats) throw new Error('insights payload has no teamStats');
    var qh = ins.queueHealth;
    return dept + ' ' + from + '..' + latestIso + ': ' + agents.length + ' agents'
      + ', queueHealth=' + (qh ? (qh.error ? 'ERROR' : (qh.unmapped ? 'unmapped' : 'ok')) : 'null');
  });

  // 6. All-departments queue report for the latest QCD day (exercises the
  //    QCD read source + queuesForDept_ mapping end-to-end).
  run('qcd-alldept', function () {
    var dates = getLatestDataDates();
    var qcdIso = dates && dates.qcd;
    if (!qcdIso) throw new Error('no QCD date on record (QCD Historical Data empty?)');
    var q = computeQcdAllDepartments_(qcdIso, qcdIso);
    if (!q || !Array.isArray(q.depts)) throw new Error('qcd-all payload has no depts array');
    if (!q.depts.length) throw new Error('no dept had QCD activity on ' + qcdIso + ' — queue mappings? (Operator State #14)');
    return qcdIso + ': ' + q.depts.length + ' dept section(s), '
      + q.grandTotals.totalCalls + ' calls company-wide';
  });

  // 7. Neon connectivity (the no-sheet-fallback surfaces: Escalations,
  //    Inbound, Caller Lookup). Skips cleanly when unconfigured. NEO-3:
  //    no recordReadHealth — a smoke probe is not a DQE read.
  run('neon', function () {
    if (!PropertiesService.getScriptProperties().getProperty('NEON_HOST')) {
      return 'n/a (Neon unconfigured)';
    }
    var conn = getDashboardNeonConn_();
    if (!conn) throw new Error('Neon configured but unreachable');
    try {
      var st = conn.createStatement();
      st.setQueryTimeout(5);
      st.execute('SELECT 1');
      st.close();
      return 'SELECT 1 ok';
    } finally {
      try { conn.close(); } catch (ce) {}
    }
  });

  return checks;
}

/** ISO date arithmetic without TZ surprises (noon-anchored, like the
 *  report builders' parseIso_ helpers). */
function smokeShiftIso_(iso, deltaDays) {
  var p = String(iso).split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
  d.setDate(d.getDate() + deltaDays);
  var mm = String(d.getMonth() + 1); if (mm.length < 2) mm = '0' + mm;
  var dd = String(d.getDate());      if (dd.length < 2) dd = '0' + dd;
  return d.getFullYear() + '-' + mm + '-' + dd;
}
