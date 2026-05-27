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
 *     calendar day's check at 8am, skipping Saturdays + Sundays.
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

function getAlertsInit() {
  assertAdmin_();
  return {
    config: readAlertConfig_(),
    log: readAlertLog_(20),
    trigger: getAlertTriggerStatus_(),
    pipelineHealth: readPipelineHealth_(20),
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + getSpreadsheetId_() + '/edit',
    defaultDate: yesterdayIso_(),
  };
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
 * is intentionally not built in -- if it becomes a pain, add a
 * "skip dates" column to the Alert Config sheet later.
 */
function runDailyAlerts_() {
  const tz = TZ;
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
  const dow = yesterday.getDay();   // 0 = Sun, 6 = Sat
  if (dow === 0 || dow === 6) {
    Logger.log('runDailyAlerts_: skipping weekend (%s)', yesterday);
    return;
  }
  const dateIso = Utilities.formatDate(yesterday, tz, 'yyyy-MM-dd');
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

  cfg.forEach(function (entry) {
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
}

/**
 * Per-dept rollup of yesterday's DQE Historical Data rows. Skips
 * queue-sentinel rows. Also collects per-agent "low" outliers
 * (under ALERT_LOW_AGENT_THRESHOLD% answer rate) so the email
 * can highlight individuals.
 */
function computeDeptAnswerRateForDate_(dept, dateIso, roster) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { rung: 0, answered: 0, missed: 0, pct: 0, lowAgents: [] };

  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;
  const ssTZ = ss.getSpreadsheetTimeZone();

  const range = sheet.getRange(2, 1, lastRow - 1, HISTORICAL_COLS.TOTAL_ANSWERED);
  const values = range.getValues();

  let rung = 0, answered = 0, missed = 0;
  const lowAgents = [];

  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const dIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (dIso !== dateIso) continue;
    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent || !rosterSet[agent]) continue;
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;

    const aRung     = Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
    const aMissed   = Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
    const aAnswered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;

    rung += aRung; answered += aAnswered; missed += aMissed;

    if (aRung > 0) {
      const aPct = (aAnswered / aRung) * 100;
      if (aPct < ALERT_LOW_AGENT_THRESHOLD) {
        lowAgents.push({
          name: agent, rung: aRung, answered: aAnswered, missed: aMissed,
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
 * row; blank-department rows and rows with invalid threshold
 * are silently dropped (the column header in row 1 is preserved
 * by setup_).
 *
 * Schema (row 1 headers): Department | Threshold % | Extra Recipients | Active | Notes
 */
function readAlertConfig_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ALERT_CONFIG);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const dept = String(values[i][0] || '').trim();
    if (!dept) continue;
    const threshold = Number(values[i][1]);
    if (!isFinite(threshold) || threshold <= 0) continue;
    const extras = String(values[i][2] || '').split(',')
                     .map(function (s) { return s.trim(); })
                     .filter(function (s) { return !!s; });
    // Active = TRUE unless explicitly FALSE/false/0/no.
    const rawActive = values[i][3];
    const active = !(rawActive === false || rawActive === 'FALSE' || rawActive === 'false'
                  || rawActive === 0 || rawActive === 'no' || rawActive === 'No');
    const notes = String(values[i][4] || '').trim();
    out.push({
      department: dept,
      threshold: threshold,
      extraRecipients: extras,
      active: active,
      notes: notes,
    });
  }
  return out;
}

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
