/**
 * System Health page (admin-only) — one glance instead of the 27-item
 * Operator State Checklist.
 *
 * Aggregates the operational signals that already exist as scattered
 * helpers/properties into a single `getSystemHealth()` payload, rendered by
 * the `#health-modal` (route `#/admin/health`). PURELY a read/assembly
 * surface: it computes nothing new, writes nothing, and every section is
 * individually best-effort (a failing probe renders as its own warn row —
 * "the health page is down" must never be the failure mode).
 *
 * Row shape: { key, section, label, status: 'ok'|'warn'|'muted', value, hint }
 *   ok    = green, healthy / configured / installed
 *   warn  = amber, needs attention (the hint says what to do)
 *   muted = informational / intentionally off / not applicable
 *
 * Sections: pipeline (DQE freshness), neon (flags + read-back + mirror
 * health), triggers (which optional trigger-driven services are installed
 * and their last outcomes), config (Script Properties presence), sheets
 * (the setup()-managed tabs). Trigger presence covers THIS project only —
 * cdr-import / cdr-report triggers and Script Properties are per-project
 * and unreadable from here (their rows say so rather than guessing).
 */

function getSystemHealth() {
  assertAdmin_();
  var rows = [];
  var add = function (section, key, label, status, value, hint) {
    rows.push({ section: section, key: key, label: label, status: status,
                value: String(value == null ? '' : value), hint: hint || '' });
  };

  // ── Pipeline freshness ──────────────────────────────────────────────
  try {
    var fresh = computeOverviewPipelineFreshness_();
    if (!fresh) {
      add('pipeline', 'dqe-fresh', 'DQE build freshness', 'warn', 'no Pipeline Health rows',
        'Pipeline Health sheet empty/missing — run setup() and check the import triggers (Operator State #8/#11).');
    } else if (fresh.isStale) {
      add('pipeline', 'dqe-fresh', 'DQE build freshness', 'warn',
        fresh.latestTimestamp ? ('last fresh build ' + fresh.latestTimestamp + ' (' + fresh.hoursSinceFresh + 'h ago)') : 'no fresh build on record',
        'No fresh DQE rows in ' + OVERVIEW_PIPELINE_STALE_HOURS + 'h+ — the daily import or DQE rebuild likely didn\'t run (Operator State #1/#8/#11).');
    } else {
      add('pipeline', 'dqe-fresh', 'DQE build freshness', 'ok',
        fresh.latestTimestamp + ' (' + fresh.hoursSinceFresh + 'h ago)');
    }
  } catch (e) { add('pipeline', 'dqe-fresh', 'DQE build freshness', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── Recent pipeline step failures (the single trustworthy signal) ────
  // Flags a step ONLY when its MOST RECENT outcome is `failure` -- a step that
  // failed then recovered (its latest row is `success`) is NOT flagged, so this
  // never cries wolf about a fixed blip (the OPS-8/M1 lesson). Catches every
  // step name in one place: the CDR/QCD/DQE/Inbound sheet writes, the `:neon`
  // inline-mirror failures (L7), the `buildDQE:neon` (F4) / `:Inbound` (F9)
  // rows, and the deferred `neonMirror:*` drains -- so the admin doesn't have
  // to scan Pipeline Health by eye to know something is currently broken.
  try {
    var phRows = (typeof readPipelineHealth_ === 'function') ? readPipelineHealth_(80) : [];
    if (!phRows || !phRows.length) {
      add('pipeline', 'pipe-failures', 'Recent pipeline step failures', 'muted', 'no Pipeline Health rows');
    } else {
      var latestByStep = {};   // readPipelineHealth_ returns NEWEST-first, so first-seen per step is its latest
      phRows.forEach(function (r) { if (r && r.step && !(r.step in latestByStep)) latestByStep[r.step] = r; });
      var failingSteps = Object.keys(latestByStep).filter(function (s) {
        return String(latestByStep[s].status || '').toLowerCase() === 'failure';
      });
      if (!failingSteps.length) {
        add('pipeline', 'pipe-failures', 'Recent pipeline step failures', 'ok', 'no step currently failing');
      } else {
        var latestFail = latestByStep[failingSteps[0]];
        add('pipeline', 'pipe-failures', 'Recent pipeline step failures', 'warn',
          failingSteps.length + ' step(s) whose latest outcome is failure: ' + failingSteps.join(', '),
          'Most recent: ' + failingSteps[0] + (latestFail.timestamp ? ' @ ' + latestFail.timestamp : '')
          + (latestFail.notes ? ' — ' + latestFail.notes : '')
          + '. See Alerts modal → Pipeline Health for the full Notes.');
      }
    }
  } catch (e) { add('pipeline', 'pipe-failures', 'Recent pipeline step failures', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── Neon ────────────────────────────────────────────────────────────
  var props = PropertiesService.getScriptProperties();
  var neonConfigured = false;
  try {
    neonConfigured = !!props.getProperty('NEON_HOST');
    add('neon', 'neon-conf', 'Neon connection (NEON_* properties)',
      neonConfigured ? 'ok' : 'warn', neonConfigured ? 'configured' : 'not configured',
      neonConfigured ? '' : 'Escalations, Inbound, Caller Lookup, and the F1 read-back need the NEON_* Script Properties (Operator State #18).');
  } catch (e) { add('neon', 'neon-conf', 'Neon connection', 'warn', 'probe failed', String(e && e.message || e)); }
  try {
    var src = getDqeReadSource_();
    add('neon', 'dqe-source', 'DQE read source (DQE_READ_SOURCE)',
      'muted', src,
      src === 'neon' ? 'Reads come from dqe_history; sheet is the fallback.'
                     : 'Reads come from the DQE sheet; flip to neon after a clean runDqeParityCheck (Operator State #19).');
  } catch (e) { add('neon', 'dqe-source', 'DQE read source', 'warn', 'probe failed', String(e && e.message || e)); }
  try {
    var qsrc = (typeof getQcdReadSource_ === 'function') ? getQcdReadSource_() : 'sheet';
    add('neon', 'qcd-source', 'QCD read source (QCD_READ_SOURCE)', 'muted', qsrc,
      qsrc === 'neon' ? 'Queue-report reads come from qcd_history; sheet is the fallback.'
                      : 'Queue-report reads come from the QCD sheet; flip to neon after a clean runQcdParityCheck.');
  } catch (e) { add('neon', 'qcd-source', 'QCD read source', 'warn', 'probe failed', String(e && e.message || e)); }
  try {
    var cfgSrc = (typeof getConfigSource_ === 'function') ? getConfigSource_() : 'sheet';
    add('neon', 'config-source', 'Config source (CONFIG_SOURCE)', 'muted', cfgSrc,
      cfgSrc === 'neon' ? 'Dept/Alert/Digest Config read+write Neon tables.' : 'Config sheets are authoritative (default).');
  } catch (e) { add('neon', 'config-source', 'Config source', 'warn', 'probe failed', String(e && e.message || e)); }
  try {
    var rh = computeNeonReadHealth_();
    if (!rh.configured || (rh.source !== 'neon' && rh.status === 'ok')) {
      add('neon', 'read-health', 'Neon read-back health', 'muted', 'n/a (reads on sheet, no failure on record)');
    } else if (rh.status === 'ok') {
      add('neon', 'read-health', 'Neon read-back health', 'ok', 'no failures on record');
    } else {
      add('neon', 'read-health', 'Neon read-back health', 'warn',
        (rh.count || 0) + ' consecutive failure(s) — last: ' + (rh.message || 'unknown') + (rh.at ? ' at ' + rh.at : ''),
        'Neon DQE reads are silently falling back to the sheet — sustained outage serves aging data (Operator State #19).');
    }
  } catch (e) { add('neon', 'read-health', 'Neon read-back health', 'warn', 'probe failed', String(e && e.message || e)); }
  // Both mirror-health probes (DQE + QCD) share ONE Neon connection so the
  // page pays at most a single free-tier cold-start, not one handshake per
  // probe. Opened here, threaded into both compute*MirrorHealth_(conn), closed
  // in the finally. An explicit null (Neon configured but unreachable) tells
  // each helper to report 'error' WITHOUT re-attempting its own connection.
  var sharedNeonConn = null;
  if (neonConfigured && typeof getDashboardNeonConn_ === 'function') {
    try { sharedNeonConn = getDashboardNeonConn_(); } catch (e) { sharedNeonConn = null; }
  }
  try {
    var renderMirror = function (key, label, mh, upsertHint) {
      if (mh.status === 'ok') {
        add('neon', key, label, 'ok',
          'neon max ' + (mh.neonMax || '?') + (mh.sheetMax ? (' vs sheet ' + mh.sheetMax) : ''));
      } else if (mh.status === 'behind') {
        add('neon', key, label, 'warn',
          'behind by ' + mh.gapDays + ' day(s) (neon ' + mh.neonMax + ' < sheet ' + mh.sheetMax + ')',
          upsertHint);
      } else {
        add('neon', key, label, 'warn', mh.status,
          'Could not read the mirror max date — check Neon reachability.');
      }
    };
    try {
      if (neonConfigured) {
        renderMirror('mirror-health', 'DQE→Neon mirror',
          computeNeonMirrorHealth_(sharedNeonConn),
          'Re-import the missing date(s) or run backfillDQEHistoryUpsert() (Operator State #19).');
      } else {
        add('neon', 'mirror-health', 'DQE→Neon mirror', 'muted', 'n/a (Neon unconfigured)');
      }
    } catch (e) { add('neon', 'mirror-health', 'DQE→Neon mirror', 'warn', 'probe failed', String(e && e.message || e)); }
    try {
      if (neonConfigured && typeof computeQcdMirrorHealth_ === 'function') {
        renderMirror('qcd-mirror-health', 'QCD→Neon mirror',
          computeQcdMirrorHealth_(sharedNeonConn),
          'Re-import the missing date(s) — writeQCDRowsToNeon is authoritative per-date.');
      } else if (neonConfigured) {
        add('neon', 'qcd-mirror-health', 'QCD→Neon mirror', 'muted', 'n/a (probe unavailable)');
      } else {
        add('neon', 'qcd-mirror-health', 'QCD→Neon mirror', 'muted', 'n/a (Neon unconfigured)');
      }
    } catch (e) { add('neon', 'qcd-mirror-health', 'QCD→Neon mirror', 'warn', 'probe failed', String(e && e.message || e)); }
  } finally {
    if (sharedNeonConn) { try { sharedNeonConn.close(); } catch (ce) {} }
  }

  // ── Trigger-driven services (THIS project) ──────────────────────────
  try {
    var installed = {};
    var trig = ScriptApp.getProjectTriggers();
    for (var i = 0; i < trig.length; i++) installed[trig[i].getHandlerFunction()] = true;
    var svc = function (key, label, fns, required, offHint) {
      var on = fns.some(function (f) { return !!installed[f]; });
      var missing = fns.filter(function (f) { return !installed[f]; });
      add('triggers', key, label,
        on && !missing.length ? 'ok' : (required ? 'warn' : 'muted'),
        !missing.length ? 'installed' : (on ? ('partial — missing ' + missing.join(', ')) : 'not installed'),
        (!on || missing.length) ? offHint : '');
    };
    svc('trg-alerts',  'Daily alerts trigger',  ['runDailyAlerts_'], true,
      'Alerts only fire on manual Send without it — install from the Alerts modal (Operator State #8).');
    svc('trg-digests', 'Digest triggers (daily/weekly/monthly)',
      ['runDailyDigests_', 'runWeeklyDigests_', 'runMonthlyDigests_'], true,
      'Digest Config rows have no effect without them — install from the Alerts modal (Operator State #8).');
    svc('trg-warm',    'Report cache warming',  ['warmReportCaches_'], false,
      'Optional: pre-warms Overview / summaries / all-dept report / Insights after ingest (Operator State #21).');
    svc('trg-keepwarm','Neon keep-warm',        ['keepNeonWarm_'], false,
      'Optional; only matters once DQE_READ_SOURCE=neon (Operator State #20).');
    svc('trg-watchdog','Ingest-failure watchdog', ['runIngestWatchdog_'], false,
      'Optional: emails admins when no fresh DQE build lands (Operator State #23).');
    svc('trg-pipewatch','Pipeline-failure watchdog', ['runPipelineWatch_'], false,
      'Optional: emails admins when a Pipeline Health failure row is logged — enable via installPipelineWatchTrigger().');
    svc('trg-backup',  'Neon backup (escalations / inbound_calls)', ['runNeonBackup_'], false,
      'Optional but recommended: these tables have NO sheet fallback — install via installNeonBackupTrigger().');
    // O-5: the queue-report poller was the one trigger-driven engine this
    // inventory missed -- a deleted trigger was invisible on the page that
    // claims to replace the operator checklist.
    svc('trg-queuereport', 'Daily Call Queue Report email', ['runDailyQueueReport_'], false,
      'Optional: emails the all-dept queue report to subscribers each weekday morning (Operator State #31).');
  } catch (e) { add('triggers', 'trg-probe', 'Trigger inventory', 'warn', 'probe failed', String(e && e.message || e)); }

  // Last outcomes of the optional services (property-backed, cheap).
  try {
    var outcomes = [
      ['out-warm',     'Cache warm — last outcome',   'CACHE_WARM_LAST',    'CACHE_WARM_LAST_RESULT'],
      ['out-keepwarm', 'Keep-warm — last ping',       'NEON_KEEPWARM_LAST', 'NEON_KEEPWARM_LAST_RESULT'],
      ['out-backup',   'Neon backup — last run',      'NEON_BACKUP_LAST',   'NEON_BACKUP_LAST_RESULT'],
      ['out-pipewatch','Pipeline watch — last run',   'PIPELINE_WATCH_LAST','PIPELINE_WATCH_LAST_RESULT'],
      // O-5: queue-report outcome (this engine has no *_LAST timestamp prop;
      // the result string carries its own timestamp). MISSED / FAILED-ALL
      // outcomes trip the OPS-8 classifier's bad-word match, as intended.
      ['out-queuereport', 'Queue report — last outcome', 'QUEUE_REPORT_LAST', 'QUEUE_REPORT_LAST_RESULT'],
    ];
    for (var o = 0; o < outcomes.length; o++) {
      var at = props.getProperty(outcomes[o][2]);
      var res = props.getProperty(outcomes[o][3]);
      if (!at && !res) { add('triggers', outcomes[o][0], outcomes[o][1], 'muted', 'never run'); continue; }
      // OPS-8: outcome strings are prefix-coded -- an "ok (...)" result is
      // healthy even when its detail mentions designed-normal partial work
      // (CacheWarm's "ok (12 warmed, 3 insights skipped on budget)").
      // Substring-matching "skipped" inside an ok result painted the row
      // amber every budget-limited day, training the admin to ignore the
      // SAME row that carries the genuinely-bad "skipped (no latest
      // date)" / "FAILED" outcomes.
      // O-5: the queue report's not-sent outcome leads with "MISSED <iso>" --
      // none of the substring bad-words match it, so classify by prefix too.
      var bad = !/^ok\b/i.test(res || '')
        && (/fail|error|unreachable|skipped/i.test(res || '') || /^MISSED\b/.test(res || ''));
      add('triggers', outcomes[o][0], outcomes[o][1], bad ? 'warn' : 'ok',
        (res || '') + (at ? (' @ ' + at) : ''));
    }
  } catch (e) { add('triggers', 'out-probe', 'Service outcomes', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── Script Properties presence ──────────────────────────────────────
  try {
    var propSpecs = [
      ['DASHBOARD_URL',    true,  'Alert-email links + "Open in new tab" buttons hide without it (Operator State #7).'],
      ['ADMIN_EMAILS',     true,  'Falls back to the ADMIN_EMAILS_FALLBACK constant — editing admins then needs a redeploy (Operator State #13).'],
      ['HMAC_SECRET',      true,  'Caller Lookup + phone-hash mirrors degrade without it (Operator State #17).'],
      ['COMPANY_HOLIDAYS', false, 'Optional: holiday-aware working-day counts + alert/digest skips (Operator State #27).'],
      ['SPREADSHEET_ID',   true,  'REQUIRED — every sheet read fails without it (Operator State: setup).'],
    ];
    for (var p = 0; p < propSpecs.length; p++) {
      var name = propSpecs[p][0];
      var required = propSpecs[p][1];
      var set = !!props.getProperty(name);
      add('config', 'prop-' + name, name, set ? 'ok' : (required ? 'warn' : 'muted'),
        set ? 'set' : 'not set', set ? '' : propSpecs[p][2]);
    }
  } catch (e) { add('config', 'prop-probe', 'Script Properties', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── setup()-managed sheets ──────────────────────────────────────────
  try {
    var ss = openSpreadsheet_();
    var expected = ['Access Control', 'Alert Config', 'Alert Log', 'Pipeline Health',
                    'Digest Config', 'Agent Alias Overrides', 'Orphan Fix Log',
                    'Dept Config', 'Report Usage',
                    'Queue Report Subscribers'];   // O-5: the tenth setup() sheet (INV-12)
    var missing = expected.filter(function (n) { return !ss.getSheetByName(n); });
    add('sheets', 'setup-sheets', 'setup()-managed sheets',
      missing.length ? 'warn' : 'ok',
      missing.length ? ('missing: ' + missing.join(', ')) : (expected.length + ' present'),
      missing.length ? 'Re-run setup() from the editor as an admin (Operator State #6) — writers against missing sheets silently no-op.' : '');
  } catch (e) { add('sheets', 'setup-sheets', 'setup()-managed sheets', 'warn', 'probe failed', String(e && e.message || e)); }

  var warnCount = rows.filter(function (r) { return r.status === 'warn'; }).length;
  return { generatedAt: new Date().toISOString(), rows: rows, warnCount: warnCount };
}
