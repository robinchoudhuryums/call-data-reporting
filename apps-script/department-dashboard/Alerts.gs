/**
 * Low Answer Rate Alerts - admin-driven dept threshold alerts.
 *
 * Migration of the legacy DQE Report's checkLowAnswerRate.js +
 * sendManualAlert.js, redesigned to fit the new dashboard's
 * data model:
 *
 *   - Thresholds and extra recipients live in a sheet ("Alert
 *     Config") so admins can adjust without code edits. Created
 *     by setup() if missing.
 *   - Recipients per dept resolved from Access Control (the
 *     dept's manager) UNION Extra Recipients column (manual
 *     additions); admin emails always cc'd for visibility.
 *   - Data source is DQE Historical Data, not a separate dept-
 *     summary sheet. Per-dept answer-rate computed live by
 *     rolling up the dept's roster agents for the chosen date.
 *   - All sends are admin-gated; google.script.run callables
 *     check user.role === 'admin' independently of the client.
 *   - A daily time-driven trigger (runDailyAlerts_) can be
 *     installed via installAlertTrigger_; runs the previous
 *     BUSINESS day's check at 8am (Monday assesses Friday),
 *     skipping weekend runs.
 *   - Every per-dept outcome of every run is logged to the "Alert
 *     Log" sheet -- including previews. Preview rows are marked by
 *     a "preview:" prefix on the Triggered By column and use the
 *     `would-send` status (vs the real-run `sent`).
 *
 * Public entries (callable via google.script.run, all admin-
 * only at the server boundary):
 *   getAlertsInit() -> {
 *     config: [{ department, threshold, extraRecipients[], active, notes }],
 *     log: [{ timestamp, department, dateChecked, threshold,
 *             answerRate, triggered, recipients, notes }],
 *     trigger: { installed, hour? },
 *     spreadsheetUrl: string,
 *     defaultDate: 'yyyy-MM-dd' (yesterday in TZ)
 *   }
 *   previewAlerts({ date }) -> [{ ...same shape as sendAlerts return }]
 *   sendAlerts({ date }) -> [{ department, status, answerRate,
 *                              threshold, recipients, notes }]
 *   installAlertTrigger() -> { installed: true, hour }
 *   uninstallAlertTrigger() -> { installed: false }
 */

const ALERT_LOW_AGENT_THRESHOLD = 50;   // pct under which an agent gets called out in the body
const ALERT_DEFAULT_HOUR        = 8;    // 8 AM trigger hour
// E10 threshold-drift surface. Reads the most-recent
// daily-trigger entries per dept from the Alert Log to flag
// thresholds that have drifted away from the dept's actual
// performance. CHRONIC = the threshold is too strict (alerts fire
// nearly every day -> noise / fatigue); LENIENT = the threshold is
// too loose (alerts never fire and the dept averages far above
// it -> useless config). Per-dept window: last
// DRIFT_LOOKBACK_ENTRIES daily-trigger entries (skips weekends +
// holidays naturally since those don't get trigger rows). Render
// is admin-only (rides on the existing Alerts modal gating).
const DRIFT_LOOKBACK_ENTRIES   = 30;
const DRIFT_MIN_TOTAL_TO_ASSESS = 10;   // <10 entries = "—"; not enough signal
const DRIFT_CHRONIC_FIRE_RATIO = 0.80;  // fired/total >= 80% -> chronic
const DRIFT_LENIENT_HEADROOM_PTS = 10;  // mean rate >= threshold + 10pts AND fired=0 -> lenient
const DRIFT_LOG_SCAN_CAP       = 2000;  // max Alert Log rows we'll read to bucket the lookback

function getAlertsInit() {
  assertAdmin_();
  // Pull config first so the drift helper can be keyed by the same
  // dept list + thresholds. Drift is best-effort -- a failure (e.g.
  // Alert Log sheet missing) returns an empty map and the modal
  // table simply renders no drift column data; the rest of the
  // payload is unaffected.
  const config = readAlertConfig_();
  // O-3: flag config rows whose Department matches no DO NOT EDIT! header
  // (typo, or a header renamed after the row was saved). Such a dept reads
  // an empty roster -> rung 0 -> perpetual plausible-looking `no-data`, so
  // it is silently never monitored. Best-effort (a roster read failure just
  // skips the flag); the modal renders a "⚠ unknown dept" chip and
  // runAlertsCore_ logs an `error` outcome per run.
  try {
    const knownDepts = {};
    getAllDepartments_().forEach(function (d) { knownDepts[d] = true; });
    if (Object.keys(knownDepts).length) {
      config.forEach(function (c) {
        if (c.department && !knownDepts[c.department]) c.unknownDept = true;
      });
    }
  } catch (e) {
    Logger.log('getAlertsInit: dept validation skipped: %s', e);
  }
  let drift = {};
  try {
    drift = computeThresholdDrift_(config, DRIFT_LOOKBACK_ENTRIES);
  } catch (e) {
    Logger.log('computeThresholdDrift_ failed: %s', e);
  }
  // F2 divergence detector: sheet-vs-Neon DQE max-date comparison. Best-effort
  // -- null on any failure (computeNeonMirrorHealth_ already swallows its own
  // errors and returns a status object; the try/catch here is belt-and-
  // suspenders so a Neon hiccup never breaks the Alerts modal). The client
  // hides the line when Neon isn't configured on this project.
  let neonMirror = null;
  try {
    neonMirror = computeNeonMirrorHealth_();
  } catch (e) {
    Logger.log('computeNeonMirrorHealth_ failed: %s', e);
  }
  // F3: Neon READ-back failure signal (NEON_READ_LAST_ERROR). Best-effort --
  // null on any failure; the client hides the line in the healthy/sheet case.
  let neonRead = null;
  try {
    neonRead = computeNeonReadHealth_();
  } catch (e) {
    Logger.log('computeNeonReadHealth_ failed: %s', e);
  }
  // Admin-tunable answer-rate standards (ANSWER_TARGETS Script Property,
  // Config.gs registry). Best-effort: a parse failure just renders the
  // section with seed defaults.
  let answerTargets = null;
  try {
    answerTargets = {
      effective: getAnswerTargets_(),
      surfaces: ANSWER_TARGET_SURFACES,
      seedDefault: ANSWER_TARGET_DEFAULT,
    };
  } catch (e) {
    Logger.log('getAlertsInit answerTargets failed: %s', e);
  }
  return {
    config: config,
    drift: drift,
    log: readAlertLog_(20),
    trigger: getAlertTriggerStatus_(),
    pipelineHealth: readPipelineHealth_(20),
    neonMirror: neonMirror,
    neonRead: neonRead,
    answerTargets: answerTargets,
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + getSpreadsheetId_() + '/edit',
    // O-8: default to the previous BUSINESS day (what the daily trigger
    // actually assesses, INV-33) -- calendar yesterday made every Monday
    // open on Sunday, a guaranteed all-`no-data` preview that read like a
    // broken pipeline.
    defaultDate: prevBusinessDayIso_(new Date()),
  };
}

/**
 * Saves the admin-tunable answer-rate standards (ANSWER_TARGETS Script
 * Property). Config write path per INV-01: assertAdmin_ + loud validation
 * (answerTargetsPropertyString_ throws on a non-numeric / out-of-range
 * value) + LockService + a Logger.log audit line. req = {global, direct,
 * inbound} -- blank/absent unsets that surface (global then falls back to
 * the seed default). An all-blank save deletes the property entirely.
 * Display-layer only: no cache bump needed; viewers pick the change up on
 * their next page load, emails at their next send.
 */
function saveAnswerTargets(req) {
  assertAdmin_();
  const propStr = answerTargetsPropertyString_(req || {});
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Busy — please retry.');
  try {
    const props = PropertiesService.getScriptProperties();
    if (propStr) props.setProperty('ANSWER_TARGETS', propStr);
    else props.deleteProperty('ANSWER_TARGETS');
    ANSWER_TARGETS_MEMO_ = null;   // this execution serves the fresh values
    Logger.log('AnswerTargets saved by %s: %s',
      Session.getActiveUser().getEmail(), propStr || '(cleared — seed defaults)');
  } finally {
    lock.releaseLock();
  }
  return { effective: getAnswerTargets_(), raw: propStr };
}

/**
 * Reads the Pipeline Health sheet, newest-first, up to maxRows
 * entries. Safe no-op if the sheet is missing (returns []).
 * Admin-only: only called from getAlertsInit which asserts admin.
 */
function readPipelineHealth_(maxRows) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.PIPELINE_HEALTH);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const startRow = Math.max(2, lastRow - maxRows + 1);
  const rows = sheet.getRange(startRow, 1, lastRow - startRow + 1,
                              PIPELINE_HEALTH_HEADERS.length).getValues();
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    out.push({
      timestamp: r[0] instanceof Date
        ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd HH:mm')
        : String(r[0] || ''),
      step:        String(r[1] || ''),
      status:      String(r[2] || ''),
      rows:        r[3] === '' || r[3] == null ? null : r[3],
      durationMs:  r[4] === '' || r[4] == null ? null : r[4],
      notes:       String(r[5] || ''),
    });
  }
  return out;
}

function previewAlerts(req) {
  assertAdmin_();
  const dateIso = String((req && req.date) || '').trim();
  if (!isIsoDate_(dateIso)) throw new Error('date must be YYYY-MM-DD');
  return runAlertsCore_(dateIso, /*dryRun=*/true, /*triggeredBy=*/Session.getActiveUser().getEmail());
}

function sendAlerts(req) {
  assertAdmin_();
  const dateIso = String((req && req.date) || '').trim();
  if (!isIsoDate_(dateIso)) throw new Error('date must be YYYY-MM-DD');
  return runAlertsCore_(dateIso, /*dryRun=*/false, /*triggeredBy=*/Session.getActiveUser().getEmail());
}

function installAlertTrigger() {
  assertAdmin_();
  installAlertTrigger_();
  return getAlertTriggerStatus_();
}

function uninstallAlertTrigger() {
  assertAdmin_();
  uninstallAlertTrigger_();
  return getAlertTriggerStatus_();
}

/**
 * Time-driven trigger entry point. Underscore suffix blocks
 * google.script.run from reaching it; the daily trigger calls it
 * by name, which is allowed by Apps Script even for underscore-
 * suffixed functions.
 *
 * Skips Saturday + Sunday: weekend call activity is essentially
 * zero, so a fired alert would just be noise. Holiday handling
 * is via the Alert Config `Skip Dates` column (E8): admins enter
 * comma-separated ISO dates / ranges per dept; the trigger path
 * checks `entry.skipDates` against today and logs `skipped` with
 * a "Skip date match" note when it hits. Manual sends from the UI
 * bypass this gate intentionally so admins can force-send after
 * a holiday review.
 */
function runDailyAlerts_() {
  const tz = TZ;
  const now = new Date();
  // F-6 class: skip when TODAY is Sat/Sun -- INV-33's documented contract
  // (no weekend alert emails). The old check tested the DATA date's dow,
  // which FIRED Friday's alerts on SATURDAY morning and skipped Monday
  // entirely. The assessed date is the previous BUSINESS day, so Monday's
  // run assesses Friday (mirrors the F-6 digest fix).
  const dowToday = now.getDay();   // 0 = Sun, 6 = Sat
  if (dowToday === 0 || dowToday === 6) {
    Logger.log('runDailyAlerts_: weekend run -- skipping.');
    return;
  }
  // S5: a company holiday (COMPANY_HOLIDAYS Script Property) is a
  // non-working day too -- nobody is in to act on the alert, and the
  // assessed data day is walked back past holidays regardless. Same
  // TRIGGER-ONLY semantics as the weekend skip: manual sends + previews
  // are unaffected, so an admin can still force a post-holiday catch-up.
  const todayIso = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  if (isCompanyHoliday_(todayIso)) {
    Logger.log('runDailyAlerts_: company holiday (' + todayIso + ') -- skipping.');
    return;
  }
  // Previous BUSINESS day, skipping weekends AND company holidays (S5;
  // shared walker in Util.gs -- with no holidays configured this is exactly
  // the F-6 behavior: Mon -> Fri, else yesterday).
  const dateIso = prevBusinessDayIso_(now);
  try {
    runAlertsCore_(dateIso, /*dryRun=*/false, /*triggeredBy=*/'daily-trigger');
  } catch (e) {
    Logger.log('runDailyAlerts_ failed: %s', e);
    // Surface to admins via email so a silent trigger failure
    // doesn't go unnoticed.
    try {
      MailApp.sendEmail({
        to: getAdminEmails_().join(','),
        subject: '[Dashboard] Daily alert trigger failed',
        body: 'runDailyAlerts_ threw: ' + (e && e.message ? e.message : String(e))
            + '\nDate: ' + dateIso + '\nStack: ' + (e && e.stack ? e.stack : '(no stack)'),
      });
    } catch (e2) { /* best-effort */ }
  }
}

/**
 * Core engine: iterates the Alert Config, computes each active
 * dept's answer rate for the date, decides whether to fire, and
 * sends + logs. Returns an array of per-dept result records the
 * UI can render. Logs all results to the Alert Log sheet so the
 * full history is queryable independently of UI sessions.
 */
function runAlertsCore_(dateIso, dryRun, triggeredBy) {
  // F2: pre-flight the Alert Log BEFORE any email is sent. appendAlertLog_
  // silently no-ops when the sheet is missing (e.g. setup() not re-run),
  // which would let real sends go out with no audit row. Fail fast here so
  // either every per-dept outcome is logged or nothing is sent. The trigger
  // path (runDailyAlerts_) catches this and emails admins; the UI surfaces it.
  if (!openSpreadsheet_().getSheetByName(SHEETS.ALERT_LOG)) {
    throw new Error('Alert Log sheet missing -- run setup() before running alerts. '
      + 'Every alert outcome must be logged.');
  }

  // F4: serialize REAL sends so a double-click on "Send alerts" -- or an admin
  // send racing the 8 AM runDailyAlerts_ trigger -- can't double-fire manager
  // emails + duplicate Alert Log rows. Preview (dryRun) is self-marked
  // (preview: / would-send) and read-mostly, so it isn't locked. Uses the same
  // project-wide script lock as OrphanFix / DeptConfig (tryLock + throw on
  // contention). A deliberate SEQUENTIAL re-send is still allowed -- the lock is
  // free by then -- which is intended (admins can force-send after a holiday).
  let alertLock = null;
  if (!dryRun) {
    alertLock = LockService.getScriptLock();
    // OPS-2: wait up to 2 minutes, not 15s. The 8 AM digest trigger shares
    // this project-wide lock and Apps Script schedules both randomly inside
    // the same hour; with the digest now releasing the lock before its
    // sends (see sendDigestsForCadence_) any residual contention is brief,
    // and waiting it out beats dropping the whole day's alerts.
    if (!alertLock.tryLock(120000)) {
      throw new Error('Another alert run is already in progress — please retry in a moment.');
    }
  }
  try {

  const cfg = readAlertConfig_();
  const results = [];

  // Every per-dept outcome of every run -- preview or real -- is
  // appended to the Alert Log. Preview rows are distinguished by
  // prefixing the Triggered By column with "preview:" and by the
  // `would-send` status (vs real `sent`); other statuses are shared
  // between modes. Logging previews leaves a fingerprint of "Robin
  // looked at 2026-05-19 at 9:13am" which would otherwise vanish at
  // session end.
  const loggedBy = dryRun ? ('preview:' + (triggeredBy || '')) : (triggeredBy || '');
  const pushAndLog = function (rec) {
    results.push(rec);
    appendAlertLog_(rec, loggedBy, dateIso);
  };

  // E8: Skip Dates honored ONLY on the time-triggered path. Manual
  // sends from the UI explicitly bypass this so an admin can still
  // force-send on a holiday if needed (e.g. catching up after a
  // post-holiday review). Matches the INV-33 policy.
  const honorSkipDates = (triggeredBy === 'daily-trigger');

  // O-3: real dept headers, resolved once per run. Best-effort -- if the
  // roster read fails, validation is skipped (null set = old behavior)
  // rather than erroring every dept.
  let alertKnownDeptSet = null;
  try {
    alertKnownDeptSet = {};
    getAllDepartments_().forEach(function (d) { alertKnownDeptSet[d] = true; });
    if (!Object.keys(alertKnownDeptSet).length) alertKnownDeptSet = null;
  } catch (deptErr) { alertKnownDeptSet = null; }

  cfg.forEach(function (entry) {
    // OPS-9: a duplicate dept row (first row wins; see
    // parseAlertConfigValues_) must not re-evaluate + re-email the dept.
    // Logged as `skipped` so the hand-edit is visible in the Alert Log.
    if (entry.duplicateRow) {
      pushAndLog({
        department: entry.department,
        status: 'skipped',
        answerRate: null,
        threshold: entry.threshold,
        recipients: [],
        notes: 'Duplicate Alert Config row for this department -- the FIRST row wins. '
             + 'Remove this row via the modal editor.',
      });
      return;
    }
    // F4: a dept configured with an invalid threshold (blank / <=0 /
    // non-numeric) would otherwise be silently un-monitored. Surface it as an
    // `error` outcome (visible in the Alert Log + modal results) so the
    // misconfiguration is caught instead of the dept quietly going dark.
    if (entry.invalidThreshold) {
      pushAndLog({
        department: entry.department,
        status: 'error',
        answerRate: null,
        threshold: entry.threshold,
        recipients: [],
        notes: 'Invalid threshold in Alert Config ("' + (entry.thresholdRaw || '') + '") -- '
             + 'department NOT monitored. Set a positive number (e.g. 80).',
      });
      return;
    }
    // O-3 (the F4 pattern, for the Department cell): a dept name matching no
    // DO NOT EDIT! header yields an empty roster -> rung 0 -> a perpetual,
    // plausible-looking `no-data`, so a renamed/typo'd dept silently stops
    // being monitored forever. Surface it as an `error` outcome instead.
    // Exact match -- the roster join is case-sensitive (INV-04).
    if (alertKnownDeptSet && !alertKnownDeptSet[entry.department]) {
      pushAndLog({
        department: entry.department,
        status: 'error',
        answerRate: null,
        threshold: entry.threshold,
        recipients: [],
        notes: 'Department not found on the roster sheet (renamed or typo?) -- '
             + 'NOT monitored. Fix the Department cell to match the DO NOT EDIT! '
             + 'header exactly (case-sensitive).',
      });
      return;
    }
    if (!entry.active) {
      pushAndLog({
        department: entry.department,
        status: 'skipped',
        answerRate: null,
        threshold: entry.threshold,
        recipients: [],
        notes: 'Inactive in Alert Config',
      });
      return;
    }
    if (honorSkipDates && isDateInSkipRanges_(dateIso, entry.skipDates)) {
      pushAndLog({
        department: entry.department,
        status: 'skipped',
        answerRate: null,
        threshold: entry.threshold,
        recipients: [],
        notes: 'Skip date match (' + dateIso + ') in Alert Config',
      });
      return;
    }
    try {
      const roster = getRosterForDepartment_(entry.department);
      const stats  = computeDeptAnswerRateForDate_(entry.department, dateIso, roster);

      // No call activity for the date -- skip without alerting.
      // Treat as "no data" rather than "0% answer rate" which
      // would otherwise misfire below-threshold every quiet day.
      if (stats.rung === 0) {
        pushAndLog({
          department: entry.department,
          status: 'no-data',
          answerRate: null,
          threshold: entry.threshold,
          recipients: [],
          notes: 'No call activity on ' + dateIso,
        });
        return;
      }

      const recipientsTo = resolveRecipients_(entry);
      const recipientsCc = getAdminEmails_();

      // Above threshold = healthy. Log but don't send.
      if (stats.pct >= entry.threshold) {
        pushAndLog({
          department: entry.department,
          status: 'above-threshold',
          answerRate: round1_(stats.pct),
          threshold: entry.threshold,
          recipients: recipientsTo,
          notes: 'Above threshold; no alert sent',
        });
        return;
      }

      if (recipientsTo.length === 0) {
        pushAndLog({
          department: entry.department,
          status: 'no-recipients',
          answerRate: round1_(stats.pct),
          threshold: entry.threshold,
          recipients: [],
          notes: 'No manager in Access Control and no Extra Recipients configured',
        });
        return;
      }

      // Send (unless dry-run).
      let sentStatus = 'would-send';
      let sentNotes  = 'Preview mode (dry run)';
      if (!dryRun) {
        sendAlertEmail_(entry, dateIso, stats, recipientsTo, recipientsCc);
        sentStatus = 'sent';
        sentNotes  = 'Sent to ' + recipientsTo.length + ' recipient'
                   + (recipientsTo.length === 1 ? '' : 's');
      }
      pushAndLog({
        department: entry.department,
        status: sentStatus,
        answerRate: round1_(stats.pct),
        threshold: entry.threshold,
        recipients: recipientsTo,
        notes: sentNotes,
      });
    } catch (e) {
      Logger.log('Alert processing failed for %s: %s', entry.department, e);
      pushAndLog({
        department: entry.department,
        status: 'error',
        answerRate: null,
        threshold: entry.threshold,
        recipients: [],
        notes: (e && e.message) ? e.message : String(e),
      });
    }
  });

  return results;
  } finally {
    if (alertLock) alertLock.releaseLock();   // F4
  }
}

/**
 * Per-dept rollup of yesterday's DQE Historical Data rows. Skips
 * queue-sentinel rows. Also collects per-agent "low" outliers
 * (under ALERT_LOW_AGENT_THRESHOLD% answer rate) so the email
 * can highlight individuals.
 */
// OPS-11: ONE full-sheet scan per RUN, not per dept. The date-filtered
// per-agent tuples are memoized per execution (Apps Script globals are
// per-execution, so no cross-run staleness); each dept then filters the
// small per-date subset by its roster. ~14 configured depts previously
// re-read the whole multi-year sheet 14x per run -- linear-in-history
// waste that lengthened exactly the lock-hold window OPS-2 cares about.
let ALERT_DATE_ROWS_MEMO_ = { dateIso: null, rows: null };
function alertRowsForDate_(dateIso) {
  if (ALERT_DATE_ROWS_MEMO_.dateIso === dateIso && ALERT_DATE_ROWS_MEMO_.rows) {
    return ALERT_DATE_ROWS_MEMO_.rows;
  }
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  const lastRow = sheet.getLastRow();
  const rows = [];
  if (lastRow >= 2) {
    const ssTZ = ss.getSpreadsheetTimeZone();
    const values = sheet.getRange(2, 1, lastRow - 1, HISTORICAL_COLS.TOTAL_ANSWERED).getValues();
    for (let i = 0; i < values.length; i++) {
      const r = values[i];
      const dIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
      if (dIso !== dateIso) continue;
      const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
      if (!agent) continue;
      if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;   // INV-23 sentinels
      rows.push({
        agent:    agent,
        rung:     Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0,
        missed:   Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0,
        answered: Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
      });
    }
  }
  ALERT_DATE_ROWS_MEMO_ = { dateIso: dateIso, rows: rows };
  return rows;
}

function computeDeptAnswerRateForDate_(dept, dateIso, roster) {
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  const dateRows = alertRowsForDate_(dateIso);

  let rung = 0, answered = 0, missed = 0;
  const lowAgents = [];

  for (let i = 0; i < dateRows.length; i++) {
    const r = dateRows[i];
    if (!rosterSet[r.agent]) continue;

    const aRung     = r.rung;
    const aMissed   = r.missed;
    const aAnswered = r.answered;

    rung += aRung; answered += aAnswered; missed += aMissed;

    if (aRung > 0) {
      const aPct = (aAnswered / aRung) * 100;
      if (aPct < ALERT_LOW_AGENT_THRESHOLD) {
        lowAgents.push({
          name: r.agent, rung: aRung, answered: aAnswered, missed: aMissed,
          pct: round1_(aPct),
        });
      }
    }
  }
  lowAgents.sort(function (a, b) { return a.pct - b.pct; });
  return {
    rung: rung, answered: answered, missed: missed,
    pct: rung > 0 ? (answered / rung) * 100 : 0,
    lowAgents: lowAgents,
  };
}

/**
 * Dept's manager(s) from Access Control + Extra Recipients from
 * the config row. Deduped, blank-filtered. Order: managers first
 * (the people accountable for the dept), then any extras.
 */
function resolveRecipients_(cfgEntry) {
  const out = [];
  const seen = {};
  const add = function (email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e || seen[e]) return;
    seen[e] = true;
    out.push(e);
  };
  const managers = lookupDeptManagers_(cfgEntry.department);
  managers.forEach(add);
  (cfgEntry.extraRecipients || []).forEach(add);
  return out;
}

function lookupDeptManagers_(dept) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const email = String(values[i][0] || '').trim();
    const d     = String(values[i][1] || '').trim();
    if (!email || !d) continue;
    if (d === dept) out.push(email);
  }
  return out;
}

/**
 * Reads the "Alert Config" sheet. Returns one entry per data
 * row. Blank-department rows are dropped (no dept to alert on).
 * A row WITH a department but an invalid threshold (blank, <=0,
 * or non-numeric) is NOT dropped -- it's returned flagged
 * `invalidThreshold:true` so the dept doesn't silently fall out
 * of monitoring (F4): runAlertsCore_ logs an `error` Alert Log
 * row for it and the modal config table flags it, instead of the
 * dept just vanishing with no signal.
 *
 * Schema (row 1 headers): Department | Threshold % | Extra Recipients | Active | Notes | Skip Dates
 */
/**
 * Raw Alert Config rows as a 2D array in column order
 * [Department, Threshold %, Extra Recipients, Active, Notes, Skip Dates],
 * from the ACTIVE source (C3: Neon `alert_config` when CONFIG_SOURCE=neon,
 * else the sheet). The Neon path falls back to the sheet on any error so the
 * flip is safe. readAlertConfig_ applies the SAME parse to either, so parity
 * is exact. Returns [] (never throws) on a missing/empty source.
 */
function alertConfigRawValues_() {
  if (typeof getConfigSource_ === 'function' && getConfigSource_() === 'neon') {
    const neon = neonAlertConfigRawValues_();
    if (neon !== null) return neon;   // null = unreachable/error -> sheet fallback
  }
  return sheetAlertConfigRawValues_();
}

/** SHEET-only raw read (no CONFIG_SOURCE dispatch) -- used by the flag-aware
 * reader above and read DIRECTLY by compareAlertConfigSources (F-5). */
function sheetAlertConfigRawValues_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ALERT_CONFIG);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  // Width 6 covers the E8 Skip Dates column (added at col F, end of
  // row). Sheets returns empty strings for col F on pre-E8 sheets
  // where setup() ran before the schema bump -- safe to read without
  // re-running setup, because the sheet's maxColumns default (26) is
  // larger than 6.
  return sheet.getRange(2, 1, lastRow - 1, 6).getValues();
}

/** Lazily create alert_config (no setup() change). */
function ensureAlertConfigTable_(conn) {
  const ddl = conn.createStatement();
  ddl.execute('CREATE TABLE IF NOT EXISTS alert_config ('
    + 'department text PRIMARY KEY, threshold text, extra_recipients text, '
    + 'active boolean NOT NULL DEFAULT true, notes text, skip_dates text)');
  ddl.close();
}

/** Neon -> the same 6-col raw row order; null on unreachable/error. */
function neonAlertConfigRawValues_() {
  const conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
  if (!conn) return null;
  try {
    ensureAlertConfigTable_(conn);
    const sql = "SELECT COALESCE(json_agg(t ORDER BY t.department), '[]')::text AS j FROM ("
      + 'SELECT department, threshold, extra_recipients, active, notes, skip_dates FROM alert_config) t';
    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    return JSON.parse(json || '[]').map(function (r) {
      return [r.department || '', r.threshold == null ? '' : r.threshold,
              r.extra_recipients || '', (r.active === false ? 'FALSE' : 'TRUE'),
              r.notes || '', r.skip_dates || ''];
    });
  } catch (e) {
    return null;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

function readAlertConfig_() {
  return parseAlertConfigValues_(alertConfigRawValues_());
}

/** The shared raw-rows -> entries parse, applied identically to either
 * source (sheet or Neon) so parity is exact. */
function parseAlertConfigValues_(values) {
  if (!values || !values.length) return [];
  const out = [];
  // OPS-9: dedupe hand-edited duplicate dept rows FIRST-ROW-WINS -- the
  // save-editor's upsert edits the first case-insensitive match, so the
  // first row is the one an admin's edits actually land on. Later rows are
  // kept but FLAGGED (duplicateRow) so the modal can show them; the run
  // loop skips them (two CSR rows used to mean two evaluations + two
  // duplicate alert emails + two log rows). The Neon config path is immune
  // (PK on department); the sheet -- still the default -- was not.
  const seenDept_ = {};
  for (let i = 0; i < values.length; i++) {
    const dept = String(values[i][0] || '').trim();
    if (!dept) continue;
    const dupKey = dept.toLowerCase();
    const duplicateRow = !!seenDept_[dupKey];
    seenDept_[dupKey] = true;
    // F4: a dept row with a bad threshold is flagged, not dropped, so it
    // can't silently fall out of monitoring with no log row / no UI signal.
    const thresholdRaw = String(values[i][1] == null ? '' : values[i][1]).trim();
    const threshold = Number(values[i][1]);
    const invalidThreshold = !isFinite(threshold) || threshold <= 0;
    const extras = String(values[i][2] || '').split(',')
                     .map(function (s) { return s.trim(); })
                     .filter(function (s) { return !!s; });
    // Active = TRUE unless explicitly FALSE/false/0/no.
    const rawActive = values[i][3];
    const active = !(rawActive === false || rawActive === 'FALSE' || rawActive === 'false'
                  || rawActive === 0 || rawActive === 'no' || rawActive === 'No');
    const notes = String(values[i][4] || '').trim();
    const skipDatesRaw = String(values[i][5] || '').trim();
    out.push({
      department: dept,
      duplicateRow: duplicateRow,
      threshold: invalidThreshold ? 0 : threshold,
      thresholdRaw: thresholdRaw,
      invalidThreshold: invalidThreshold,
      extraRecipients: extras,
      active: active,
      notes: notes,
      // Normalized array of {from, to} ISO-date ranges; empty when
      // the cell is empty OR contains only garbage. The raw string is
      // kept for round-trip display in the modal config table so
      // admins see what's in the sheet, not the parsed form.
      skipDatesRaw: skipDatesRaw,
      skipDates: parseSkipDateRanges_(skipDatesRaw),
    });
  }
  return out;
}

// -- C3 Alert Config -> Neon migration (editor-run; data layer only) ------
// Backfill the sheet into Neon + a parity gate, mirroring the C2 Dept Config
// cutover discipline. The reader (alertConfigRawValues_) already honors
// CONFIG_SOURCE with sheet fallback. NOTE: flipping CONFIG_SOURCE=neon makes
// Alert Config editable ONLY via an admin UI (it's hand-edited in the sheet
// today) -- that edit surface is the remaining C3 work before a flip is
// usable; until then, keep CONFIG_SOURCE=sheet.

/** Upsert one alert_config row (department PK). Used by the backfill. */
function neonUpsertAlertConfigRow_(rec) {
  const conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
  if (!conn) throw new Error('Neon unreachable -- alert_config write skipped.');
  try {
    ensureAlertConfigTable_(conn);
    const sql = 'INSERT INTO alert_config (department, threshold, extra_recipients, active, notes, skip_dates) '
      + 'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (department) DO UPDATE SET '
      + 'threshold=EXCLUDED.threshold, extra_recipients=EXCLUDED.extra_recipients, '
      + 'active=EXCLUDED.active, notes=EXCLUDED.notes, skip_dates=EXCLUDED.skip_dates';
    const st = conn.prepareStatement(sql);
    st.setString(1, rec.department);
    st.setString(2, rec.thresholdRaw == null ? '' : String(rec.thresholdRaw));
    st.setString(3, (rec.extraRecipients || []).join(', '));
    st.setBoolean(4, !!rec.active);
    st.setString(5, rec.notes || '');
    st.setString(6, rec.skipDatesRaw || '');
    st.executeUpdate();
    st.close();
  } finally {
    try { conn.close(); } catch (e) {}
  }
}

function backfillAlertConfigToNeon() {
  assertAdmin_();
  // Read the SHEET explicitly (not the flag-aware reader) so the backfill
  // always copies sheet -> Neon regardless of CONFIG_SOURCE.
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ALERT_CONFIG);
  let n = 0;
  if (sheet && sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
    values.forEach(function (r) {
      const dept = String(r[0] || '').trim();
      if (!dept) return;
      neonUpsertAlertConfigRow_({
        department: dept, thresholdRaw: String(r[1] == null ? '' : r[1]).trim(),
        extraRecipients: String(r[2] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        active: !(r[3] === false || r[3] === 'FALSE' || r[3] === 'false' || r[3] === 0 || r[3] === 'no' || r[3] === 'No'),
        notes: String(r[4] || '').trim(), skipDatesRaw: String(r[5] || '').trim(),
      });
      n++;
    });
  }
  Logger.log('backfillAlertConfigToNeon: upserted %s row(s).', n);
  return { upserted: n };
}

function compareAlertConfigSources() {
  assertAdmin_();
  const norm = function (rows) {
    const m = {};
    rows.forEach(function (e) {
      m[e.department] = JSON.stringify([e.threshold, e.extraRecipients, e.active, e.notes, e.skipDatesRaw]);
    });
    return m;
  };
  // Read each source DIRECTLY -- never through the flag-aware reader, and
  // never by flipping the live CONFIG_SOURCE property (F-5). The old
  // property round-trip had two flaws: (1) the flag-aware reader silently
  // falls back to the SHEET when Neon is unreachable, so a Neon outage
  // compared the sheet against itself and reported PARITY CLEAN -- a false
  // green light to flip CONFIG_SOURCE against an empty/stale table; (2)
  // Script Properties are global, so concurrent requests briefly read the
  // flipped source. Neon-unreachable now returns clean:false + error.
  const sheetRows = parseAlertConfigValues_(sheetAlertConfigRawValues_());
  const neonRaw = neonAlertConfigRawValues_();
  if (neonRaw === null) {
    Logger.log('compareAlertConfigSources: NEON UNREACHABLE -- no comparison performed. '
      + 'Do NOT flip CONFIG_SOURCE on this result.');
    return { clean: false, error: 'Neon unreachable -- no comparison performed.',
             missingInNeon: [], missingInSheet: [], mismatched: [] };
  }
  const neonRows = parseAlertConfigValues_(neonRaw);
  const s = norm(sheetRows), nn = norm(neonRows);
  const missingInNeon = [], missingInSheet = [], mismatched = [];
  Object.keys(s).forEach(function (d) { if (!(d in nn)) missingInNeon.push(d); else if (s[d] !== nn[d]) mismatched.push(d); });
  Object.keys(nn).forEach(function (d) { if (!(d in s)) missingInSheet.push(d); });
  const clean = !missingInNeon.length && !missingInSheet.length && !mismatched.length;
  Logger.log('compareAlertConfigSources: %s. missing-in-neon=%s; missing-in-sheet=%s; mismatched=%s',
    clean ? 'PARITY CLEAN' : 'DIFFERENCES', JSON.stringify(missingInNeon), JSON.stringify(missingInSheet), JSON.stringify(mismatched));
  return { clean: clean, missingInNeon: missingInNeon, missingInSheet: missingInSheet, mismatched: mismatched };
}

// -- C3 Alert Config WRITE path (admin editor RPCs) -----------------------
// Public, admin-gated CRUD so the per-dept threshold/recipients config is
// edited from the Alerts modal instead of by hand. Writes the ACTIVE source
// (Neon when CONFIG_SOURCE=neon, else the sheet) -- the same dispatch C2 uses.
// INV-01 config-write mitigations: assertAdmin_ + validation + LockService
// (+ a Logger.log audit line). Keyed by department (one alert row per dept).

function saveAlertConfigRow(req) {
  assertAdmin_();
  const department = String((req && req.department) || '').trim();
  if (!department) throw new Error('Department is required.');
  if (getAllDepartments_().indexOf(department) === -1) {
    throw new Error('"' + department + '" is not a department. It must match a DO NOT EDIT! column header exactly.');
  }
  const thresholdNum = Number(req && req.threshold);
  if (!isFinite(thresholdNum) || thresholdNum <= 0 || thresholdNum > 100) {
    throw new Error('Threshold must be a number between 1 and 100.');
  }
  const extras = String((req && req.extraRecipients) || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
  const bad = extras.filter(function (e) { return !acIsValidEmail_(e); });
  if (bad.length) throw new Error('Invalid extra-recipient email(s): ' + bad.join(', '));
  const rec = {
    department: department, thresholdRaw: String(thresholdNum), extraRecipients: extras,
    active: !(req && req.active === false), notes: String((req && req.notes) || '').trim().slice(0, 500),
    skipDatesRaw: String((req && req.skipDates) || '').trim().slice(0, 500),
  };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  try {
    if (typeof getConfigSource_ === 'function' && getConfigSource_() === 'neon') neonUpsertAlertConfigRow_(rec);
    else sheetUpsertAlertConfigRow_(rec);
    Logger.log('saveAlertConfigRow: %s by %s', department, Session.getActiveUser().getEmail());
  } finally { lock.releaseLock(); }
  return { saved: true };
}

function sheetUpsertAlertConfigRow_(rec) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ALERT_CONFIG);
  if (!sheet) throw new Error('Alert Config sheet missing -- run setup().');
  const row = [rec.department, rec.thresholdRaw, (rec.extraRecipients || []).join(', '),
               rec.active ? 'TRUE' : 'FALSE', rec.notes || '', rec.skipDatesRaw || ''];
  const lastRow = sheet.getLastRow();
  let found = -1;
  if (lastRow >= 2) {
    const col = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < col.length; i++) {
      if (String(col[i][0] || '').trim().toLowerCase() === rec.department.toLowerCase()) { found = i + 2; break; }
    }
  }
  if (found > 0) sheet.getRange(found, 1, 1, 6).setValues([row]);
  else sheet.appendRow(row);
}

function removeAlertConfigRow(req) {
  assertAdmin_();
  const department = String((req && req.department) || '').trim();
  if (!department) throw new Error('Department is required.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  let removed = 0;
  try {
    if (typeof getConfigSource_ === 'function' && getConfigSource_() === 'neon') removed = neonRemoveAlertConfigRow_(department);
    else removed = sheetRemoveAlertConfigRow_(department);
    Logger.log('removeAlertConfigRow: removed %s row(s) for %s by %s', removed, department, Session.getActiveUser().getEmail());
  } finally { lock.releaseLock(); }
  return { removed: removed };
}

function sheetRemoveAlertConfigRow_(department) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ALERT_CONFIG);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const col = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  let removed = 0;
  for (let i = col.length - 1; i >= 0; i--) {
    if (String(col[i][0] || '').trim().toLowerCase() === department.toLowerCase()) { sheet.deleteRow(i + 2); removed++; }
  }
  return removed;
}

function neonRemoveAlertConfigRow_(department) {
  const conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
  if (!conn) throw new Error('Neon unreachable -- alert_config delete skipped.');
  let n = 0;
  try {
    ensureAlertConfigTable_(conn);
    const st = conn.prepareStatement('DELETE FROM alert_config WHERE lower(department)=lower(?)');
    st.setString(1, department);
    n = st.executeUpdate() || 0;
    st.close();
  } finally { try { conn.close(); } catch (e) {} }
  return n;
}

// parseSkipDateRanges_ / isDateInSkipRanges_ moved to Util.gs (S5: the
// COMPANY_HOLIDAYS source shares the same grammar + helpers).

/**
 * Appends a result row to the Alert Log sheet. Tail-only --
 * never overwrites or rewrites existing rows. The sheet is
 * idempotently created by setup_().
 */
function appendAlertLog_(rec, triggeredBy, dateChecked) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ALERT_LOG);
  if (!sheet) return;
  sheet.appendRow([
    new Date(),
    rec.department,
    dateChecked,
    rec.threshold,
    rec.answerRate == null ? '' : rec.answerRate,
    rec.status === 'sent' ? 'TRUE' : 'FALSE',
    (rec.recipients || []).join(', '),
    triggeredBy || '',
    rec.notes || '',
    rec.status,
  ]);
}

/**
 * E10 threshold-drift summary. For each dept in `config`, reads the
 * most-recent DRIFT_LOOKBACK_ENTRIES daily-trigger Alert Log entries
 * and computes the fired-count + mean answer rate. Preview rows
 * (Triggered By starts with `preview:`) and non-trigger callers
 * (manual sends from the UI) are excluded so the signal reflects
 * the real automated cadence only.
 *
 * Severity classifier:
 *   chronic - fired/total >= DRIFT_CHRONIC_FIRE_RATIO. The threshold
 *             is firing nearly every day; either the dept is
 *             sustainedly under-performing and the alert is just
 *             noise, or the threshold is set too high. Either way
 *             the admin should look.
 *   lenient - fired === 0 AND meanRate (from above-threshold rows) >
 *             threshold + DRIFT_LENIENT_HEADROOM_PTS. The threshold
 *             is so far below actual performance that it will never
 *             catch a real degradation. Informational, not urgent.
 *   ok      - everything else; renders neutral.
 *   cold    - total < DRIFT_MIN_TOTAL_TO_ASSESS. Not enough data to
 *             draw any conclusion; renders as a dash.
 *
 * Returns: { deptName: { fired, total, meanRate (or null), severity } }
 * Best-effort: a failure in the Alert Log read leaves the map empty
 * and the caller renders no drift column. Bounded by
 * DRIFT_LOG_SCAN_CAP so a runaway log doesn't blow the script budget.
 */
function computeThresholdDrift_(config, lookbackEntries) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ALERT_LOG);
  if (!sheet) return {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  const startRow = Math.max(2, lastRow - DRIFT_LOG_SCAN_CAP + 1);
  const rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, 10).getValues();

  // Bucket by dept, taking the last lookbackEntries daily-trigger
  // rows per dept. Iterate newest-first (bottom up) so the per-dept
  // cap stops at the most-recent N.
  const buckets = {};
  const thresholdsByDept = {};
  for (let i = 0; i < config.length; i++) {
    // F4: skip invalid-threshold depts -- their threshold is a placeholder
    // 0, so the lenient/chronic ratios would be meaningless. They surface
    // via the `error` Alert Log row + the modal config-table flag instead.
    if (config[i].invalidThreshold) continue;
    // R8-A5: honor the OPS-9 first-row-wins dedup. Without this, a
    // hand-edited duplicate dept row OVERWROTE the bucket + threshold, so
    // the LAST duplicate's threshold drove the lenient/chronic
    // classification while the run loop, save editor, and modal all use
    // the FIRST row -- the drift chip could brand a dept "lenient" against
    // a threshold the alert engine never evaluates.
    if (config[i].duplicateRow) continue;
    buckets[config[i].department] = { fired: 0, total: 0, rateSum: 0, rateCount: 0 };
    thresholdsByDept[config[i].department] = config[i].threshold;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const dept = String(r[1] || '');
    const b = buckets[dept];
    if (!b) continue;            // dept not in current config; skip
    if (b.total >= lookbackEntries) continue;
    const triggeredBy = String(r[7] || '');
    if (triggeredBy.indexOf('preview:') === 0) continue;
    if (triggeredBy !== 'daily-trigger') continue;
    const status = String(r[9] || '');
    // F5: only count days the alert actually ASSESSED (had data +
    // recipients, so it genuinely decided fire-vs-not). 'no-data',
    // 'skipped', 'no-recipients', and 'error' aren't assessments and
    // would dilute both the chronic fire-ratio (fired/total) and the
    // DRIFT_MIN_TOTAL_TO_ASSESS gate.
    if (status !== 'sent' && status !== 'above-threshold') continue;
    b.total++;
    if (status === 'sent') b.fired++;
    const rate = r[4];
    if (rate !== '' && rate != null && isFinite(Number(rate))) {
      b.rateSum += Number(rate);
      b.rateCount++;
    }
  }

  // Classify + shape the return.
  const out = {};
  Object.keys(buckets).forEach(function (dept) {
    const b = buckets[dept];
    const meanRate = b.rateCount ? round1_(b.rateSum / b.rateCount) : null;
    let severity = 'ok';
    if (b.total < DRIFT_MIN_TOTAL_TO_ASSESS) {
      severity = 'cold';
    } else if (b.fired / b.total >= DRIFT_CHRONIC_FIRE_RATIO) {
      severity = 'chronic';
    } else if (b.fired === 0 && meanRate != null
            && meanRate >= (thresholdsByDept[dept] + DRIFT_LENIENT_HEADROOM_PTS)) {
      severity = 'lenient';
    }
    out[dept] = {
      fired: b.fired,
      total: b.total,
      meanRate: meanRate,
      severity: severity,
    };
  });
  return out;
}

function readAlertLog_(maxRows) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ALERT_LOG);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const startRow = Math.max(2, lastRow - maxRows + 1);
  const rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, 10).getValues();
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    out.push({
      timestamp: r[0] instanceof Date
        ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd HH:mm')
        : String(r[0] || ''),
      department: r[1] || '',
      dateChecked: r[2] || '',
      threshold: r[3] || '',
      answerRate: r[4] === '' ? null : r[4],
      triggered: r[5] === 'TRUE' || r[5] === true,
      recipients: r[6] || '',
      triggeredBy: r[7] || '',
      notes: r[8] || '',
      status: r[9] || '',
    });
  }
  return out;
}

/**
 * Builds + sends the alert email. Subject + body match the
 * legacy intent: dept + date callout, big-number answer-%, a
 * table of per-agent low-performers, and a link back to the
 * dashboard for drilldown.
 */
function sendAlertEmail_(cfgEntry, dateIso, stats, recipientsTo, recipientsCc) {
  const dept = cfgEntry.department;
  const threshold = cfgEntry.threshold;
  const pct = stats.pct;
  const pctStr = round1_(pct).toFixed(1) + '%';
  const thresholdStr = threshold.toFixed(0) + '%';

  const dashboardUrl = PropertiesService.getScriptProperties()
    .getProperty('DASHBOARD_URL') || '';

  let agentsTable = '';
  if (stats.lowAgents.length) {
    agentsTable =
      '<h3 style="margin: 20px 0 8px; color: #6b7280; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">'
      +   'Agents below ' + ALERT_LOW_AGENT_THRESHOLD + '% on ' + dateIso
      + '</h3>'
      + '<table style="border-collapse: collapse; width: 100%; font-family: sans-serif; font-size: 13px;">'
      + '<thead><tr style="background: #f9fafb;">'
      +   '<th style="text-align: left; padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">Agent</th>'
      +   '<th style="text-align: right; padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">Rung</th>'
      +   '<th style="text-align: right; padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">Answered</th>'
      +   '<th style="text-align: right; padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">Missed</th>'
      +   '<th style="text-align: right; padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">% Answered</th>'
      + '</tr></thead><tbody>';
    stats.lowAgents.forEach(function (a) {
      agentsTable +=
        '<tr>'
        +   '<td style="padding: 6px 12px; border-bottom: 1px solid #f3f4f6;">' + escapeHtmlServer_(a.name) + '</td>'
        +   '<td style="padding: 6px 12px; text-align: right; border-bottom: 1px solid #f3f4f6;">' + a.rung + '</td>'
        +   '<td style="padding: 6px 12px; text-align: right; border-bottom: 1px solid #f3f4f6;">' + a.answered + '</td>'
        +   '<td style="padding: 6px 12px; text-align: right; border-bottom: 1px solid #f3f4f6;">' + a.missed + '</td>'
        +   '<td style="padding: 6px 12px; text-align: right; border-bottom: 1px solid #f3f4f6; font-weight: 700; color: #9A3412;">' + a.pct.toFixed(1) + '%</td>'
        + '</tr>';
    });
    agentsTable += '</tbody></table>';
  }

  const htmlBody =
    '<div style="font-family: sans-serif; color: #1f2937; max-width: 720px;">'
    +   '<div style="background: #FEF2F2; border-left: 4px solid #DC2626; padding: 16px 20px; border-radius: 4px;">'
    +     '<h2 style="margin: 0 0 4px; color: #991B1B; font-size: 18px;">'
    +       'Low Answer Rate &mdash; ' + escapeHtmlServer_(dept)
    +     '</h2>'
    +     '<div style="color: #7C2D12; font-size: 13px;">' + dateIso + '</div>'
    +   '</div>'
    +   '<div style="margin: 20px 0; padding: 20px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">'
    +     '<div style="font-size: 12px; color: #6b7280; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">Answer Rate</div>'
    +     '<div style="font-size: 36px; font-weight: 700; color: #DC2626; line-height: 1.1; margin: 4px 0;">' + pctStr + '</div>'
    +     '<div style="font-size: 13px; color: #6b7280;">Threshold: ' + thresholdStr + ' &middot; '
    +       stats.answered + ' answered of ' + stats.rung + ' rung &middot; '
    +       stats.missed + ' missed'
    +     '</div>'
    +   '</div>'
    +   agentsTable
    +   (dashboardUrl
        ? '<div style="margin-top: 20px;"><a href="' + escapeHtmlServer_(dashboardUrl) + '" style="display: inline-block; background: #1d4ed8; color: #fff; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600;">Open Department Dashboard</a></div>'
        : '')
    +   '<div style="margin-top: 24px; font-size: 11px; color: #9ca3af;">'
    +     'Sent by the Department Dashboard alert engine. Threshold and recipients are configured in the "Alert Config" sheet.'
    +   '</div>'
    + '</div>';

  MailApp.sendEmail({
    to:       recipientsTo.join(','),
    cc:       (recipientsCc || []).join(','),
    subject:  '[Dashboard Alert] ' + dept + ' answer rate ' + pctStr + ' on ' + dateIso,
    htmlBody: htmlBody,
  });
}

// ── Trigger management ────────────────────────────────────────────
function installAlertTrigger_() {
  uninstallAlertTrigger_();
  ScriptApp.newTrigger('runDailyAlerts_')
    .timeBased()
    .everyDays(1)
    .atHour(ALERT_DEFAULT_HOUR)
    .create();
}

function uninstallAlertTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDailyAlerts_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function getAlertTriggerStatus_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDailyAlerts_') {
      return { installed: true, hour: ALERT_DEFAULT_HOUR };
    }
  }
  return { installed: false };
}

// ── Tiny helpers ──────────────────────────────────────────────────
// assertAdmin_, round1_, escapeHtmlServer_ moved to Util.gs.

function yesterdayIso_() {
  const now = new Date();
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
  return Utilities.formatDate(y, TZ, 'yyyy-MM-dd');
}
