/**
 * Automated Daily Call Queue Report email.
 *
 * Emails the all-departments "Daily Call Queue Report" (the same company-wide
 * QCD snapshot the #qcd-alldept-modal renders) for the PREVIOUS WORKDAY, once
 * daily, to an opt-in subscriber list -- but ONLY after that day's Raw Data has
 * been imported and processed completely (the QCD block is the last historical
 * sheet the import writes, so "QCD Historical Data has the target date" is the
 * completion signal).
 *
 * Modeled on the opt-in, admin-toggled trigger modules already in the project
 * (Digest.gs / NeonKeepWarm.gs / CacheWarm.gs / IngestWatchdog.gs): a
 * Script-Property enable flag + an install/uninstall trigger lifecycle + an
 * Alerts-modal admin section.
 *
 * WHY POLL A WINDOW (not a single fixed hour): the import can finish at a
 * variable time each morning, and the report must not send before the data is
 * ready. The trigger runs every 30 min inside a weekday-morning window and
 * sends ONCE, as soon as the previous workday's QCD data has landed
 * (QUEUE_REPORT_LAST_SENT dedupes). A fixed hour would skip the whole day if
 * the import ran late.
 *
 * Public entries (google.script.run; all admin-only):
 *   getQueueReportInit()          -> status + subscriber list
 *   saveQueueReportSubscriber({email, active, notes})   -> updated list
 *   removeQueueReportSubscriber({email})                -> updated list
 *   installQueueReportTrigger()   -> { installed, enabled }
 *   uninstallQueueReportTrigger() -> { installed, enabled }
 *   sendQueueReportPreview()      -> { to }   (previews to the active admin)
 *
 * Trigger entry point (underscore = not RPC-callable; ScriptApp dispatches by
 * name):
 *   runDailyQueueReport_()
 *
 * Requires script.send_mail (already present, INV-31) + script.scriptapp (for
 * the trigger). Reads the previous-business-day helper (prevBusinessDayIso_,
 * Util.gs, weekend/holiday-aware) and the extracted computeQcdAllDepartments_
 * (QCDReport.gs).
 */

// Weekday-morning poll window (script TZ = America/Chicago, TZ in Config.gs).
const QUEUE_REPORT_WINDOW_START_HOUR = 6;    // 6 AM
const QUEUE_REPORT_WINDOW_END_HOUR   = 12;   // noon (exclusive)
const QUEUE_REPORT_EVERY_MINUTES     = 30;   // Apps Script allows 1/5/10/15/30

// Script Property keys.
const QUEUE_REPORT_ENABLED_PROP    = 'QUEUE_REPORT_ENABLED';       // 'true' to arm
const QUEUE_REPORT_LAST_SENT_PROP  = 'QUEUE_REPORT_LAST_SENT';     // target ISO already sent (dedupe)
const QUEUE_REPORT_LAST_RESULT_PROP = 'QUEUE_REPORT_LAST_RESULT';  // human status for the modal

// ── Trigger entry point ───────────────────────────────────────────────────

/**
 * PURE gate decision (no clock, no I/O) so the window / weekday / holiday /
 * dedupe / readiness logic is deterministically testable. Returns
 * { send: bool, reason }. ctx: { enabled, hour, dow, holiday, targetIso,
 * lastSent, latestQcd }.
 */
function queueReportGateDecision_(ctx) {
  ctx = ctx || {};
  if (!ctx.enabled) return { send: false, reason: 'disabled' };
  if (ctx.hour < QUEUE_REPORT_WINDOW_START_HOUR || ctx.hour >= QUEUE_REPORT_WINDOW_END_HOUR) {
    return { send: false, reason: 'outside-window' };
  }
  if (ctx.dow === 0 || ctx.dow === 6) return { send: false, reason: 'weekend' };
  if (ctx.holiday) return { send: false, reason: 'holiday' };
  if (!ctx.targetIso) return { send: false, reason: 'no-target' };
  if (ctx.lastSent === ctx.targetIso) return { send: false, reason: 'already-sent' };
  if (!ctx.latestQcd || ctx.latestQcd < ctx.targetIso) return { send: false, reason: 'not-ready' };
  return { send: true, reason: 'ready' };
}

function runDailyQueueReport_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const now = new Date();
    const targetIso = prevBusinessDayIso_(now);   // previous business day (weekend/holiday-aware)
    const todayIso = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
    // Only touch the (cheap) sheet-read for readiness when the window/weekday
    // gates pass -- most polls are outside the window and short-circuit here.
    const pre = queueReportGateDecision_({
      enabled:  props.getProperty(QUEUE_REPORT_ENABLED_PROP) === 'true',
      hour:     Number(Utilities.formatDate(now, TZ, 'H')),
      dow:      now.getDay(),
      holiday:  isCompanyHoliday_(todayIso),
      targetIso: targetIso,
      lastSent: props.getProperty(QUEUE_REPORT_LAST_SENT_PROP) || '',
      latestQcd: '9999-99-99',   // readiness checked below only if the rest pass
    });
    if (!pre.send) return;

    // Readiness gate: has the import finished writing QCD for the target date?
    const latestQcd = queueReportQcdLatestIso_();
    const decision = queueReportGateDecision_({
      enabled: true, hour: QUEUE_REPORT_WINDOW_START_HOUR, dow: 1, holiday: false,
      targetIso: targetIso,
      lastSent: props.getProperty(QUEUE_REPORT_LAST_SENT_PROP) || '',
      latestQcd: latestQcd,
    });
    if (!decision.send) return;   // 'not-ready' -> no-op, retry next poll

    const result = sendQueueReportForDate_(targetIso, {});
    // Only claim the date as sent once a send actually happened (recipients > 0
    // OR a clean no-recipients run). A thrown error leaves the marker unset so
    // the next poll retries.
    props.setProperty(QUEUE_REPORT_LAST_SENT_PROP, targetIso);
    props.setProperty(QUEUE_REPORT_LAST_RESULT_PROP,
      'Sent ' + targetIso + ' to ' + result.count + ' subscriber'
      + (result.count === 1 ? '' : 's') + ' at ' + new Date());
  } catch (e) {
    Logger.log('runDailyQueueReport_ failed: %s', e);
    try {
      PropertiesService.getScriptProperties().setProperty(QUEUE_REPORT_LAST_RESULT_PROP,
        'FAILED at ' + new Date() + ': ' + ((e && e.message) ? e.message : String(e)));
    } catch (pe) { /* best-effort */ }
    notifyQueueReportFailure_(e);
  }
}

// ── Readiness signal ──────────────────────────────────────────────────────

/**
 * Most-recent ISO date present in QCD Historical Data (the sheet the import
 * writes authoritatively). Trigger-safe (no Session user / auth). Mirrors the
 * QCD block of getLatestDataDates; the sheet is the "import finished" signal
 * even when DQE/QCD reads are flipped to Neon. Returns '' when absent.
 */
function queueReportQcdLatestIso_() {
  try {
    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName('QCD Historical Data');
    if (!sheet) return '';
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return '';
    const ssTZ = ss.getSpreadsheetTimeZone();
    const values = sheet.getRange(2, QCD_HISTORICAL_COLS.DATE, lastRow - 1, 1).getValues();
    let latest = '';
    for (let i = 0; i < values.length; i++) {
      const iso = rowDateIso_(values[i][0], ssTZ);
      if (iso && iso > latest) latest = iso;
    }
    return latest;
  } catch (e) {
    Logger.log('queueReportQcdLatestIso_ failed: %s', e);
    return '';
  }
}

// ── Send ──────────────────────────────────────────────────────────────────

/**
 * Composes the Daily Call Queue Report for one date and sends it. opts.to (a
 * single address) overrides the subscriber list -- used by the admin preview
 * (isPreview). Returns { count, to }.
 */
function sendQueueReportForDate_(targetIso, opts) {
  opts = opts || {};
  const data = computeQcdAllDepartments_(targetIso, targetIso);
  const recipients = opts.to
    ? [String(opts.to).trim()].filter(Boolean)
    : readQueueReportSubscribers_().filter(function (s) { return s.active; })
        .map(function (s) { return s.email; });

  if (!recipients.length) {
    Logger.log('sendQueueReportForDate_(%s): no active subscribers -- nothing sent.', targetIso);
    return { count: 0, to: [] };
  }

  const subject = 'Daily Call Queue Report — ' + (data.dateLabel || targetIso);
  const html = buildQueueReportEmailHtml_(data, targetIso, !!opts.isPreview);
  // One send with the full list on `to` would expose every subscriber's
  // address to the others; send individually (small list, weekday-once).
  recipients.forEach(function (addr) {
    MailApp.sendEmail({ to: addr, subject: subject, htmlBody: html });
  });
  return { count: recipients.length, to: recipients };
}

/**
 * Email-safe HTML for the all-departments report. Inline styles only (mail
 * clients don't honor <style>/CSS vars -- the Digest.gs / Alerts.gs
 * convention). Per-dept subtotals + a company grand-total row; abandoned % is
 * warn-tinted at/over the 5% company standard. Per-queue detail is
 * intentionally omitted (too dense for email) -- the dashboard link opens it.
 */
function buildQueueReportEmailHtml_(data, targetIso, isPreview) {
  const esc = function (v) { return escapeHtmlServer_(String(v == null ? '' : v)); };
  const depts = (data && data.depts) || [];
  const gt = (data && data.grandTotals) || {};

  const th = 'padding:6px 10px;text-align:right;font:600 12px Arial,sans-serif;'
    + 'color:#374151;border-bottom:2px solid #E5E7EB;';
  const thL = th + 'text-align:left;';
  const td = 'padding:6px 10px;text-align:right;font:400 13px Arial,sans-serif;'
    + 'color:#111827;border-bottom:1px solid #F3F4F6;';
  const tdL = td + 'text-align:left;';
  // Abandoned-% cell style: warn tint at/over the 5% standard.
  const pctCell = function (pctStr, pct) {
    const warn = Number(pct) >= 5;
    return td + (warn ? 'color:#B45309;font-weight:700;' : '');
  };

  let rows = '';
  depts.forEach(function (d) {
    const t = d.totals || {};
    const name = d.parent
      ? ('&nbsp;&nbsp;↳ ' + esc(d.dept) + ' <span style="color:#9CA3AF;">(sub-queue · ' + esc(d.parent) + ')</span>')
      : esc(d.dept);
    rows += '<tr>'
      + '<td style="' + tdL + '">' + name + '</td>'
      + '<td style="' + td + '">' + esc(t.totalCalls) + '</td>'
      + '<td style="' + td + '">' + esc(t.totalAnswered) + '</td>'
      + '<td style="' + td + '">' + esc(t.abandoned) + '</td>'
      + '<td style="' + pctCell(t.abandonedPctStr, t.abandonedPct) + '">' + esc(t.abandonedPctStr) + '</td>'
      + '<td style="' + td + '">' + esc(t.longestWait) + '</td>'
      + '<td style="' + td + '">' + esc(t.violations) + '</td>'
      + '</tr>';
  });

  const grandRow = '<tr>'
    + '<td style="' + tdL + 'font-weight:700;border-top:2px solid #E5E7EB;">Company total</td>'
    + '<td style="' + td + 'font-weight:700;border-top:2px solid #E5E7EB;">' + esc(gt.totalCalls) + '</td>'
    + '<td style="' + td + 'font-weight:700;border-top:2px solid #E5E7EB;">' + esc(gt.totalAnswered) + '</td>'
    + '<td style="' + td + 'font-weight:700;border-top:2px solid #E5E7EB;">' + esc(gt.abandoned) + '</td>'
    + '<td style="' + pctCell(gt.abandonedPctStr, gt.abandonedPct) + 'border-top:2px solid #E5E7EB;">' + esc(gt.abandonedPctStr) + '</td>'
    + '<td style="' + td + 'font-weight:700;border-top:2px solid #E5E7EB;">' + esc(gt.longestWait) + '</td>'
    + '<td style="' + td + 'font-weight:700;border-top:2px solid #E5E7EB;">' + esc(gt.violations) + '</td>'
    + '</tr>';

  const emptyNote = depts.length ? '' :
    '<p style="font:400 13px Arial,sans-serif;color:#6B7280;">No queue activity recorded for this day.</p>';

  const dashUrl = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL') || '';
  const linkBtn = dashUrl
    ? ('<p style="margin:16px 0 0;"><a href="' + esc(dashUrl) + '#/overview" '
      + 'style="background:#2563EB;color:#fff;text-decoration:none;padding:9px 16px;'
      + 'border-radius:4px;font:600 13px Arial,sans-serif;display:inline-block;">'
      + 'Open the dashboard for per-queue detail</a></p>')
    : '';

  const previewBanner = isPreview
    ? ('<div style="background:#FEF3C7;border-left:4px solid #D97706;padding:10px 14px;'
      + 'border-radius:4px;margin-bottom:12px;font:400 13px Arial,sans-serif;">'
      + '<strong style="color:#92400E;">Preview only.</strong> '
      + '<span style="color:#7C2D12;">This is what subscribers receive each weekday morning '
      + 'once the previous workday&rsquo;s data has been processed.</span></div>')
    : '';

  return ''
    + '<div style="max-width:760px;margin:0 auto;font-family:Arial,sans-serif;color:#111827;">'
    +   previewBanner
    +   '<h2 style="font:700 18px Arial,sans-serif;margin:0 0 2px;">Daily Call Queue Report</h2>'
    +   '<div style="font:400 13px Arial,sans-serif;color:#6B7280;margin-bottom:14px;">'
    +     esc(data.dateLabel || targetIso) + ' · all departments</div>'
    +   emptyNote
    +   (depts.length
        ? ('<table style="border-collapse:collapse;width:100%;">'
          + '<thead><tr>'
          +   '<th style="' + thL + '">Department</th>'
          +   '<th style="' + th + '">Total</th>'
          +   '<th style="' + th + '">Answered</th>'
          +   '<th style="' + th + '">Abandoned</th>'
          +   '<th style="' + th + '">Abd %</th>'
          +   '<th style="' + th + '">Longest wait</th>'
          +   '<th style="' + th + '">Violations</th>'
          + '</tr></thead><tbody>' + rows + grandRow + '</tbody></table>')
        : '')
    +   linkBtn
    +   '<p style="font:400 11px Arial,sans-serif;color:#9CA3AF;margin-top:18px;">'
    +     'You are receiving this because you subscribed to the Daily Call Queue Report. '
    +     'An admin can remove you from the Alerts &rarr; Daily Call Queue Report list.</p>'
    + '</div>';
}

function notifyQueueReportFailure_(err) {
  try {
    const to = getAdminEmails_().join(',');
    if (!to) return;
    MailApp.sendEmail({
      to:      to,
      subject: '[Dashboard] Daily Call Queue Report run failed',
      body:    'runDailyQueueReport_ threw: ' + ((err && err.message) ? err.message : String(err))
               + '\n\nTime: ' + new Date()
               + '\n\nStack:\n' + ((err && err.stack) ? err.stack : '(no stack)'),
    });
  } catch (mailErr) {
    Logger.log('Also failed to email queue-report failure: %s', mailErr);
  }
}

// ── Subscriber sheet ──────────────────────────────────────────────────────

/** Reads the Queue Report Subscribers sheet -> [{ email, active, notes }]. */
function readQueueReportSubscribers_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.QUEUE_REPORT_SUBSCRIBERS);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, QUEUE_REPORT_SUBSCRIBERS_HEADERS.length).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const email = String(values[i][0] || '').trim();
    if (!email) continue;
    const rawActive = values[i][1];
    const active = !(rawActive === false || rawActive === 'FALSE' || rawActive === 'false'
                   || rawActive === 0 || rawActive === 'no' || rawActive === 'No');
    out.push({ email: email, active: active, notes: String(values[i][2] || '').trim() });
  }
  return out;
}

// ── Admin RPCs (all assertAdmin_-gated) ───────────────────────────────────

function getQueueReportInit() {
  assertAdmin_();
  const props = PropertiesService.getScriptProperties();
  return {
    subscribers:    readQueueReportSubscribers_(),
    installed:      queueReportTriggerInstalled_(),
    enabled:        props.getProperty(QUEUE_REPORT_ENABLED_PROP) === 'true',
    lastSent:       props.getProperty(QUEUE_REPORT_LAST_SENT_PROP) || '',
    lastResult:     props.getProperty(QUEUE_REPORT_LAST_RESULT_PROP) || '',
    windowLabel:    QUEUE_REPORT_WINDOW_START_HOUR + ':00–' + QUEUE_REPORT_WINDOW_END_HOUR
                    + ':00 Central, weekdays (every ' + QUEUE_REPORT_EVERY_MINUTES + ' min)',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + getSpreadsheetId_() + '/edit',
  };
}

/**
 * Upsert one subscriber (key = email, case-insensitive). Config write path
 * (INV-01): assertAdmin_ + input validation + LockService + a Logger.log audit
 * line. Creates the sheet lazily if setup() hasn't run.
 */
function saveQueueReportSubscriber(req) {
  assertAdmin_();
  const email = String((req && req.email) || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  const active = !(req && (req.active === false || req.active === 'false'));
  const notes = String((req && req.notes) || '').trim().slice(0, 500);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Busy — please retry.');
  try {
    const ss = openSpreadsheet_();
    let sheet = ss.getSheetByName(SHEETS.QUEUE_REPORT_SUBSCRIBERS);
    if (!sheet) {
      sheet = ss.insertSheet(SHEETS.QUEUE_REPORT_SUBSCRIBERS);
      sheet.appendRow(QUEUE_REPORT_SUBSCRIBERS_HEADERS.slice());
      sheet.setFrozenRows(1);
    }
    const lastRow = sheet.getLastRow();
    let foundRow = -1;
    if (lastRow >= 2) {
      const emails = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < emails.length; i++) {
        if (String(emails[i][0] || '').trim().toLowerCase() === email.toLowerCase()) {
          foundRow = i + 2; break;
        }
      }
    }
    const rowVals = [email, active ? 'TRUE' : 'FALSE', notes];
    if (foundRow > 0) {
      sheet.getRange(foundRow, 1, 1, rowVals.length).setValues([rowVals]);
    } else {
      sheet.appendRow(rowVals);
    }
    Logger.log('QueueReportSubscriber saved by %s: %s (active=%s)',
      Session.getActiveUser().getEmail(), email, active);
  } finally {
    lock.releaseLock();
  }
  return { subscribers: readQueueReportSubscribers_() };
}

function removeQueueReportSubscriber(req) {
  assertAdmin_();
  const email = String((req && req.email) || '').trim().toLowerCase();
  if (!email) throw new Error('Email is required.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Busy — please retry.');
  try {
    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.QUEUE_REPORT_SUBSCRIBERS);
    if (sheet) {
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        const emails = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (let i = emails.length - 1; i >= 0; i--) {
          if (String(emails[i][0] || '').trim().toLowerCase() === email) {
            sheet.deleteRow(i + 2);
          }
        }
      }
    }
    Logger.log('QueueReportSubscriber removed by %s: %s',
      Session.getActiveUser().getEmail(), email);
  } finally {
    lock.releaseLock();
  }
  return { subscribers: readQueueReportSubscribers_() };
}

function installQueueReportTrigger() {
  assertAdmin_();
  uninstallQueueReportTrigger_();
  ScriptApp.newTrigger('runDailyQueueReport_')
    .timeBased().everyMinutes(QUEUE_REPORT_EVERY_MINUTES).create();
  PropertiesService.getScriptProperties().setProperty(QUEUE_REPORT_ENABLED_PROP, 'true');
  return { installed: true, enabled: true };
}

function uninstallQueueReportTrigger() {
  assertAdmin_();
  uninstallQueueReportTrigger_();
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(QUEUE_REPORT_ENABLED_PROP);
  return { installed: false, enabled: false };
}

/**
 * Preview the report to the ACTIVE ADMIN (never the subscribers) for the
 * previous workday, regardless of the readiness gate -- lets an admin verify
 * the email before/without arming the trigger.
 */
function sendQueueReportPreview() {
  assertAdmin_();
  const targetIso = prevBusinessDayIso_(new Date());
  const adminEmail = Session.getActiveUser().getEmail();
  sendQueueReportForDate_(targetIso, { to: adminEmail, isPreview: true });
  return { to: adminEmail, date: targetIso };
}

// ── Trigger lifecycle helpers ─────────────────────────────────────────────

function uninstallQueueReportTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDailyQueueReport_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function queueReportTriggerInstalled_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDailyQueueReport_') return true;
  }
  return false;
}
