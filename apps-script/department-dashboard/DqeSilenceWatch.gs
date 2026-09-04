/**
 * DQE-silence watchdog (optional, admin-toggled): alerts when a department's
 * QUEUE keeps taking calls while its AGENT data has gone dark.
 *
 * Born from a real two-month blind spot (2026-06-17 → 2026-08-13): the phone
 * system dropped the `A_Q_FieldOps_Power` token from the caller-ID column the
 * DQE build keys queue recognition on, so every agent leg for that queue was
 * silently skipped -- no DQE rows, no orphans, nothing red anywhere -- while
 * QCD (built from a different source) kept reporting the queue answering
 * ~25 calls/day. Nothing cross-checks the two, so the only detector was a
 * human noticing an empty department page. This engine IS that cross-check:
 * "queue shows volume, dept shows zero agent rows" is exactly one predicate,
 * assessed daily.
 *
 * Detection contract (the pure core is dqeSilenceAssess_, unit-tested):
 *  - A dept is SILENT on a day when its mapped queues (getDeptQcdQueues_,
 *    Dept Config over the constant, INV-54) show QCD 'Total Calls' volume > 0
 *    while ZERO DQE rows exist for its roster names (exact match, INV-04 --
 *    the same predicate the My Department table lives by, so this fires
 *    exactly when that page goes blind).
 *  - Silent days grow a per-dept STREAK carrying accumulated QCD calls; a day
 *    with DQE rows ends the episode (entry deleted, alert re-arms); a day
 *    with neither QCD nor DQE volume is NO SIGNAL and leaves the streak
 *    untouched (a quiet queue proves nothing either way).
 *  - Alert once per episode, when BOTH thresholds pass: days >= MIN_DAYS
 *    (default 2 -- one day can be a legitimate all-hands-out day) AND
 *    accumulated calls >= MIN_CALLS (default 5 -- so a 1-call/day dept like
 *    Denials still alerts once enough calls have gone agent-invisible,
 *    instead of never crossing a per-day volume bar).
 *
 * Gating + safety (the IngestWatchdog discipline):
 *  - No-ops cheaply when DQE_SILENCE_WATCH_ENABLED != 'true'.
 *  - Runs weekday mornings; skips weekends + company holidays; always
 *    assesses the PREVIOUS BUSINESS DAY (prevBusinessDayIso_), so a Monday
 *    run judges Friday.
 *  - An unreadable QCD grid or DQE read is INCONCLUSIVE: state untouched,
 *    result property says so, never a false alarm.
 *  - Best-effort: the trigger entry point never throws.
 *
 * DQE read goes through the DAL (neonFetchDqeRows_/sheetFetchDqeRows_ per
 * getDqeReadSource_), NOT a private sheet scan -- so this reader is cut over
 * by construction (the B-2 rule) and judges the same source the dashboard
 * reads.
 *
 * Operator setup (editor-run, admin): installDqeSilenceWatchTrigger() /
 * uninstallDqeSilenceWatchTrigger() / getDqeSilenceWatchStatus(); manual
 * sweep via runDqeSilenceCheckNow(). Tunables (Script Properties):
 *   DQE_SILENCE_MIN_DAYS   (default 2)
 *   DQE_SILENCE_MIN_CALLS  (default 5)
 *   DQE_SILENCE_HOUR       (0-23, default 11 Central -- after ingest + DQE build)
 * Outcome state (written by the engine, read by the Health page):
 *   DQE_SILENCE_WATCH_LAST / DQE_SILENCE_WATCH_LAST_RESULT / DQE_SILENCE_STREAKS
 */

var DQE_SILENCE_DEFAULT_HOUR = 11;
var DQE_SILENCE_DEFAULT_MIN_DAYS = 2;
var DQE_SILENCE_DEFAULT_MIN_CALLS = 5;

// ── Public (admin-gated) API ──────────────────────────────────────────

function getDqeSilenceWatchStatus() {
  assertAdmin_();
  return logStatusReturn_(getDqeSilenceWatchStatus_());
}

function installDqeSilenceWatchTrigger() {
  assertAdmin_();
  PropertiesService.getScriptProperties().setProperty('DQE_SILENCE_WATCH_ENABLED', 'true');
  installDqeSilenceWatchTrigger_();
  return logStatusReturn_(getDqeSilenceWatchStatus_());
}

function uninstallDqeSilenceWatchTrigger() {
  assertAdmin_();
  uninstallDqeSilenceWatchTrigger_();
  PropertiesService.getScriptProperties().deleteProperty('DQE_SILENCE_WATCH_ENABLED');
  return logStatusReturn_(getDqeSilenceWatchStatus_());
}

/**
 * Admin-run manual sweep (editor or RPC): assesses the previous business day
 * NOW regardless of the enabled flag / weekday gate, and returns what it
 * found without emailing. For "is it broken right now?" spot checks.
 */
function runDqeSilenceCheckNow() {
  assertAdmin_();
  var read = dqeSilenceReadDay_(prevBusinessDayIso_(new Date()));
  return logStatusReturn_({ date: read.date, inconclusive: !!read.inconclusive, depts: read.perDept });
}

// ── Trigger entry point ───────────────────────────────────────────────

function runDqeSilenceWatch_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('DQE_SILENCE_WATCH_ENABLED') || '') !== 'true') return;

    var dow = parseInt(Utilities.formatDate(new Date(), TZ, 'u'), 10);
    if (dow === 6 || dow === 7) return;
    var todayIso = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    if (typeof isCompanyHoliday_ === 'function' && isCompanyHoliday_(todayIso)) return;

    var targetIso = prevBusinessDayIso_(new Date());
    var read = dqeSilenceReadDay_(targetIso);
    var stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
    props.setProperty('DQE_SILENCE_WATCH_LAST', stamp);
    if (read.inconclusive) {
      // A flaky read must not mutate streaks or alert -- next run re-checks.
      // O-7: prefix-coded INCONCLUSIVE, not "ok (inconclusive ...)": a check
      // that could not read its source is not a healthy check, and the Health
      // classifier paints the `ok` prefix green.
      props.setProperty('DQE_SILENCE_WATCH_LAST_RESULT',
        'INCONCLUSIVE — ' + read.reason + '; state untouched, the next run re-checks');
      return;
    }

    var prev = {};
    try { prev = JSON.parse(props.getProperty('DQE_SILENCE_STREAKS') || '{}') || {}; }
    catch (e) { prev = {}; }
    var minDays  = parseInt(props.getProperty('DQE_SILENCE_MIN_DAYS'), 10);
    var minCalls = parseInt(props.getProperty('DQE_SILENCE_MIN_CALLS'), 10);
    var res = dqeSilenceAssess_(read.perDept, prev, {
      minDays:  isNaN(minDays)  ? DQE_SILENCE_DEFAULT_MIN_DAYS  : minDays,
      minCalls: isNaN(minCalls) ? DQE_SILENCE_DEFAULT_MIN_CALLS : minCalls,
    }, targetIso);

    if (res.alerts.length) {
      // OPS-1 (the IngestWatchdog/PipelineWatch discipline): mark an episode
      // `alerted` only on a CONFIRMED send. The streaks used to be persisted
      // (alerted:true baked in) BEFORE the send, so a MailApp failure -- the
      // quota-exhausted morning the Health page's mail-quota row exists for --
      // or an empty admin list permanently silenced the episode with zero
      // emails sent, while LAST_RESULT claimed "alert emailed". This engine
      // guards the 14-day Call_Legs window, so a silently dropped alert is
      // unrecoverable data loss.
      var sent = dqeSilenceSendAlert_(res.alerts, targetIso);
      if (!sent) {
        res.alerts.forEach(function (a) {
          if (res.streaks[a.dept]) res.streaks[a.dept].alerted = false;
        });
      }
      props.setProperty('DQE_SILENCE_STREAKS', JSON.stringify(res.streaks));
      props.setProperty('DQE_SILENCE_WATCH_LAST_RESULT',
        'SILENT ' + res.alerts.length + ' dept(s) as of ' + targetIso + ' — '
        + res.alerts.map(function (a) { return a.dept + ' (' + a.days + 'd, ' + a.calls + ' queue calls)'; }).join(', ')
        + (sent ? ' — alert emailed'
                : ' — ALERT EMAIL NOT SENT (no recipients or send failed); will retry next run'));
    } else {
      props.setProperty('DQE_SILENCE_STREAKS', JSON.stringify(res.streaks));
      var watching = Object.keys(res.streaks).length;
      props.setProperty('DQE_SILENCE_WATCH_LAST_RESULT',
        'ok ' + targetIso + ' (' + read.perDept.length + ' depts checked'
        + (watching ? ', ' + watching + ' under-threshold streak(s) watched' : '') + ')');
    }
  } catch (e) {
    try {
      PropertiesService.getScriptProperties().setProperty(
        'DQE_SILENCE_WATCH_LAST_RESULT', 'ERROR: ' + (e && e.message ? e.message : e));
    } catch (e2) { /* best-effort */ }
    Logger.log('runDqeSilenceWatch_ failed (best-effort): %s', e);
  }
}

// ── Pure decision core (unit-tested: tests/unit/dqe-silence-watch.test.js) ──

/**
 * perDept: [{ dept, qcdCalls, dqeRows }] for ONE assessed day.
 * prevStreaks: { dept: { since, days, calls, alerted } }.
 * Returns { streaks, alerts: [{ dept, since, days, calls }] }.
 *
 * Rules (see the header): DQE rows end an episode; QCD-silent days are no
 * signal; alert fires once per episode when both thresholds pass. `alerted`
 * stays true for the rest of the episode so a growing streak never re-mails.
 */
function dqeSilenceAssess_(perDept, prevStreaks, opts, dateIso) {
  var streaks = {};
  var alerts = [];
  var byDept = {};
  (perDept || []).forEach(function (d) { byDept[d.dept] = d; });

  // Carry forward streaks for depts absent from today's read (dept removed
  // from config mid-episode): no signal, keep state.
  Object.keys(prevStreaks || {}).forEach(function (dept) {
    if (!byDept[dept]) streaks[dept] = prevStreaks[dept];
  });

  (perDept || []).forEach(function (d) {
    var prev = (prevStreaks || {})[d.dept];
    if (d.dqeRows > 0) return;                     // healthy: episode over, entry dropped
    if (!(d.qcdCalls > 0)) {                       // no queue volume: no signal
      if (prev) streaks[d.dept] = prev;
      return;
    }
    var s = prev
      ? { since: prev.since, days: prev.days + 1, calls: prev.calls + d.qcdCalls, alerted: !!prev.alerted }
      : { since: dateIso, days: 1, calls: d.qcdCalls, alerted: false };
    if (!s.alerted && s.days >= opts.minDays && s.calls >= opts.minCalls) {
      s.alerted = true;
      alerts.push({ dept: d.dept, since: s.since, days: s.days, calls: s.calls });
    }
    streaks[d.dept] = s;
  });

  return { streaks: streaks, alerts: alerts };
}

// ── Data reads (one QCD grid + one DAL fetch per run) ─────────────────

/**
 * Reads ONE day and returns { date, perDept: [{dept, qcdCalls, dqeRows}] },
 * or { inconclusive: true, reason } when either source is unreadable --
 * inconclusive must never look like "all healthy" or "all silent".
 */
function dqeSilenceReadDay_(dateIso) {
  var grid;
  try { grid = readQcdGrid_(dateIso, dateIso); }
  catch (e) { return { inconclusive: true, reason: 'QCD read failed: ' + (e && e.message ? e.message : e) }; }
  if (!grid || grid.missing) return { inconclusive: true, reason: 'QCD Historical Data unavailable' };

  // Per-queue 'Total Calls' volume for the day (INV-50: only that source row
  // is a real total; per-source rows would double-count).
  var callsByQueue = {};
  var values = (grid.empty ? [] : grid.values) || [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var rowIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], TZ);
    if (rowIso !== dateIso) continue;
    if (String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim() !== 'Total Calls') continue;
    var q = String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim();
    callsByQueue[q] = (callsByQueue[q] || 0) + (Number(r[QCD_HISTORICAL_COLS.TOTAL_CALLS - 1]) || 0);
  }

  // The day's DQE agent set, through the DAL so it judges the SAME source the
  // dashboard reads (neon when flagged, sheet otherwise; unreachable neon
  // falls back exactly like the cutover readers).
  var rows = null;
  try {
    if (getDqeReadSource_() === 'neon') {
      var neonRows = neonFetchDqeRows_(dateIso, dateIso);
      rows = (typeof neonDqeRowsUsable_ === 'function' && neonDqeRowsUsable_(neonRows))
        ? neonRows : sheetFetchDqeRows_(dateIso, dateIso);
    } else {
      rows = sheetFetchDqeRows_(dateIso, dateIso);
    }
  } catch (e) { return { inconclusive: true, reason: 'DQE read failed: ' + (e && e.message ? e.message : e) }; }
  if (!rows) return { inconclusive: true, reason: 'DQE read returned nothing' };
  var dqeAgents = {};
  rows.forEach(function (row) { if (row && row.agent) dqeAgents[row.agent] = true; });

  var perDept = [];
  getAllDepartments_().forEach(function (dept) {
    var queues = getDeptQcdQueues_(dept) || [];
    if (!queues.length) return;                    // unmapped dept: nothing to cross-check
    var qcdCalls = 0;
    queues.forEach(function (q) { qcdCalls += callsByQueue[q] || 0; });
    var dqeRows = 0;
    (getRosterForDepartment_(dept).names || []).forEach(function (n) {
      if (dqeAgents[n]) dqeRows++;
    });
    perDept.push({ dept: dept, qcdCalls: qcdCalls, dqeRows: dqeRows });
  });
  return { date: dateIso, perDept: perDept };
}

// ── Alert email ───────────────────────────────────────────────────────

// Returns true ONLY on a confirmed send (OPS-1): the caller marks episodes
// `alerted` off this boolean, so an empty recipient list or a MailApp throw
// must return false -- never claim a send that didn't happen.
function dqeSilenceSendAlert_(alerts, dateIso) {
  var to = getAdminEmails_().join(',');
  if (!to) {
    Logger.log('dqeSilenceSendAlert_: no admin recipients -- alert NOT sent.');
    return false;
  }
  var lines = alerts.map(function (a) {
    return '  • ' + a.dept + ' — silent since ' + a.since + ' (' + a.days
      + ' business day(s), ' + a.calls + ' queue calls with NO agent rows)';
  });
  try {
    sendAppEmail_({
      to: to,
      subject: '[Dashboard] Agent data went dark for ' + alerts.length + ' department(s) — queue still active',
      notice: {
        tone: 'warn', kicker: 'Admin notice · DQE-silence watchdog',
        title: 'Agent data went dark for ' + alerts.length + ' department' + (alerts.length === 1 ? '' : 's'),
        subtitle: 'Queue still taking calls · as of ' + dateIso,
        tiles: [{ label: 'Departments dark', value: String(alerts.length), tone: 'warn' },
                { label: 'As of', value: dateIso },
                { label: 'Raw legs survive', value: '~14 days', sub: 'rebuild window' }],
        list: { title: 'Silent departments', items: alerts.map(function (a) {
          return '<strong>' + appEsc_(a.dept) + '</strong> — silent since ' + appEsc_(a.since) + ' (' + appEsc_(a.days)
            + ' business day(s), ' + appEsc_(a.calls) + ' queue calls with NO agent rows)';
        }) },
        callout: { kicker: 'Why this matters', html: 'This is the Field Ops Power failure shape (2026-06-17): the phone system changed a queue\'s '
          + 'caller-ID label, the pipeline\'s A_Q_* recognizer stopped matching those legs, and per-agent data vanished '
          + 'silently while queue totals kept flowing. Call_Legs source sheets are pruned at ~14 days, so act today.', tone: 'warn' },
        stepsTitle: 'Check, in order',
        steps: [{ head: 'Raw Data col W (Caller ID).', body: 'On an agent-ring leg for the dept\'s queue: does it still contain the A_Q_* token?' },
                { head: 'The roster column.', body: 'DO NOT EDIT!: are the names still exact-matching DQE col C (INV-04)?' },
                { head: 'The phone-system change log.', body: 'For the silent-since date.' }],
        outro: 'One email per episode: this will not re-send unless the department recovers and goes silent again.',
        ctaUrl: appDashUrl_('#/admin/health'), ctaLabel: 'Open System Health',
        footerHtml: 'Sent by the DQE-silence watchdog (Operator State #44).',
      },
      body: 'As of ' + dateIso + ', these departments\' queues are taking calls '
        + '(QCD volume) while ZERO DQE agent rows match their roster:\n\n'
        + lines.join('\n') + '\n\n'
        + 'This is the Field-Ops-Power failure shape (2026-06-17): the phone system '
        + 'changed a queue\'s caller-ID label, the pipeline\'s A_Q_* recognizer '
        + 'stopped matching those legs, and per-agent data vanished silently while '
        + 'queue totals kept flowing.\n\n'
        + 'Check, in order:\n'
        + '  1. Raw Data col W (Caller ID) on an agent-ring leg for the dept\'s queue '
        + '— does it still contain the A_Q_* token?\n'
        + '  2. The dept\'s roster column in DO NOT EDIT! (names still exact-matching '
        + 'DQE col C?)\n'
        + '  3. The phone-system change log for the silent-since date.\n\n'
        + 'Call_Legs source sheets are pruned at ~14 days — per-agent history for '
        + 'silent days can only be rebuilt while the raw legs survive, so act today.\n\n'
        + 'One email per episode: this will not re-send unless the department '
        + 'recovers and goes silent again.\n\nTime: ' + new Date(),
    });
    return true;
  } catch (e) {
    Logger.log('dqeSilenceSendAlert_: send FAILED (%s) -- episode stays un-alerted for retry.',
      (e && e.message) || e);
    return false;
  }
}

// ── Status / trigger lifecycle ────────────────────────────────────────

function getDqeSilenceWatchStatus_() {
  var props = PropertiesService.getScriptProperties();
  var installed = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'runDqeSilenceWatch_';
  });
  var streaks = {};
  try { streaks = JSON.parse(props.getProperty('DQE_SILENCE_STREAKS') || '{}') || {}; } catch (e) {}
  return {
    enabled:    String(props.getProperty('DQE_SILENCE_WATCH_ENABLED') || '') === 'true',
    installed:  installed,
    lastRun:    props.getProperty('DQE_SILENCE_WATCH_LAST') || '',
    lastResult: props.getProperty('DQE_SILENCE_WATCH_LAST_RESULT') || '',
    streaks:    streaks,
  };
}

function installDqeSilenceWatchTrigger_() {
  uninstallDqeSilenceWatchTrigger_();
  var hour = parseInt(PropertiesService.getScriptProperties().getProperty('DQE_SILENCE_HOUR'), 10);
  if (isNaN(hour) || hour < 0 || hour > 23) hour = DQE_SILENCE_DEFAULT_HOUR;
  ScriptApp.newTrigger('runDqeSilenceWatch_').timeBased().atHour(hour).everyDays(1).create();
}

function uninstallDqeSilenceWatchTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDqeSilenceWatch_') ScriptApp.deleteTrigger(t);
  });
}
