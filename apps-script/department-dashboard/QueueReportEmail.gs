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
 * Public entries (google.script.run). Admin-only EXCEPT where noted -- the one
 * exception is deliberate and must not be assumed away:
 *   getQueueReportInit()          -> status + subscriber list
 *   saveQueueReportSubscriber({email, active, notes})   -> updated list
 *   removeQueueReportSubscriber({email})                -> updated list
 *   installQueueReportTrigger()   -> { installed, enabled }
 *   uninstallQueueReportTrigger() -> { installed, enabled }
 *   sendQueueReportPreview()      -> { to }   (previews to the active admin)
 *   runQueueReportGateCheck()     -> the O-10 "why hasn't it sent?" readout.
 *                                    READ-ONLY: no send, no property write,
 *                                    and it never touches the dedupe marker
 *                                    (a diagnostic that claimed the marker
 *                                    would suppress the send it explains)
 *   sendQcdAllDeptToSubscribers({date}) -> QV-5 manual blast to the list
 *   sendQcdAllDeptEmail({...})    -> QV-4. *** NOT admin-only ***: any
 *                                    SIGNED-IN viewer, and it emails the
 *                                    CALLER ONLY (it resolves the user itself
 *                                    rather than calling assertAdmin_)
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
const QUEUE_REPORT_LAST_MISSED_PROP = 'QUEUE_REPORT_LAST_MISSED';  // O-7: target ISO already flagged as missed

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
  // Round-16 (owner): only the window START blocks a send. The END hour is
  // CLASSIFICATION, not a gate -- when QCD data lands after the morning
  // window closes, the poller now sends LATE the same day (the target rolls
  // at midnight) instead of flagging the day permanently missed. The O-7
  // missed-day flag still fires once at window end so admins learn the data
  // is late, but its text now says the poller keeps retrying.
  if (ctx.hour < QUEUE_REPORT_WINDOW_START_HOUR) {
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
    if (!pre.send) return;   // disabled / pre-6am / weekend / holiday / already sent

    // Readiness gate: has the import finished writing QCD for the target date?
    const latestQcd = queueReportQcdLatestIso_();
    const decision = queueReportGateDecision_({
      enabled: true, hour: QUEUE_REPORT_WINDOW_START_HOUR, dow: 1, holiday: false,
      targetIso: targetIso,
      lastSent: props.getProperty(QUEUE_REPORT_LAST_SENT_PROP) || '',
      latestQcd: latestQcd,
    });
    if (!decision.send) {
      // O-7 (reworked for the late catch-up): data still not ready after the
      // morning window closed -- flag ONCE so admins learn it's late, but
      // KEEP polling; a late-landing import now sends the same day.
      if (decision.reason === 'not-ready'
          && Number(Utilities.formatDate(now, TZ, 'H')) >= QUEUE_REPORT_WINDOW_END_HOUR) {
        queueReportFlagMissedDay_(props, now, targetIso);
      }
      return;   // 'not-ready' -> no-op, retry next poll
    }

    const result = sendQueueReportForDate_(targetIso, {});
    const failed = result.failed || [];

    // O-9: a run with NO ACTIVE SUBSCRIBERS is not a send, and must never
    // report as one. It previously fell into the success branch below
    // (count 0, no failures) and wrote "Sent <iso> to 0 subscribers", which
    // the modal shows verbatim and the Health page classifies GREEN -- so an
    // admin who armed the trigger but never added a subscriber row saw a
    // healthy engine reporting daily success while nobody received anything.
    // Same rule as the F5 "rows:0 DQE success is a NO-OP, not freshness" and
    // the O-7 missed-day flag: a no-op does not get to look like work.
    //
    // The dedupe marker is deliberately NOT claimed. Nobody received the
    // report, so a retry cannot duplicate it (the FAILED-ALL rule) -- and it
    // means an admin who adds themselves at 8am still gets that morning's
    // report on the next poll instead of having to wait for tomorrow.
    if (result.noRecipients) {
      props.setProperty(QUEUE_REPORT_LAST_RESULT_PROP,
        'NO-SUBSCRIBERS ' + targetIso + ' — the data was ready and the report was NOT sent: '
        + 'no active Queue Report subscriber rows exist. Add one under Alerts → Report '
        + 'Subscribers (installing the trigger does not subscribe you). Will send on the '
        + 'next poll once a subscriber exists. At ' + new Date());
      return;
    }

    // O-1: marker discipline around per-recipient failures.
    //  - At least one send landed (or a clean no-recipients run): claim the
    //    date. The recipients who already got it must NEVER be re-blasted by
    //    the next poll, so partial failures are notified, not retried.
    //  - EVERY send failed (recipients existed, zero delivered): leave the
    //    marker unset so the next poll retries -- nobody received it, so a
    //    retry can't duplicate. Notify once per target date.
    if (result.count > 0 || !failed.length) {
      props.setProperty(QUEUE_REPORT_LAST_SENT_PROP, targetIso);
      const lateSend = Number(Utilities.formatDate(now, TZ, 'H')) >= QUEUE_REPORT_WINDOW_END_HOUR;
      props.setProperty(QUEUE_REPORT_LAST_RESULT_PROP,
        'Sent ' + targetIso + ' to ' + result.count + ' subscriber'
        + (result.count === 1 ? '' : 's')
        + (lateSend ? ' (LATE — QCD data landed after the morning window)' : '')
        + (failed.length ? ' — FAILED for ' + failed.length + ' (see admin email)' : '')
        + ' at ' + new Date());
      if (failed.length) notifyQueueReportSendFailures_(targetIso, failed, /*allFailed=*/false);
    } else {
      const alreadyFlagged = (props.getProperty(QUEUE_REPORT_LAST_RESULT_PROP) || '')
        .indexOf('FAILED-ALL ' + targetIso) === 0;
      props.setProperty(QUEUE_REPORT_LAST_RESULT_PROP,
        'FAILED-ALL ' + targetIso + ' — every subscriber send failed; will retry next poll. At ' + new Date());
      if (!alreadyFlagged) notifyQueueReportSendFailures_(targetIso, failed, /*allFailed=*/true);
    }
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
  // Recipients are resolved BEFORE the report is composed: an empty list means
  // there is nothing to do, and composing an all-departments report nobody will
  // receive is pure waste on every 30-min poll of the window.
  // Round-16 (owner decision): ONE message per day, To + Cc, replacing the
  // per-recipient loop. The subscriber model is group inboxes now (e.g.
  // departmentleads@) -- a single message means every person reachable more
  // than one way (two groups, or group + direct) still gets exactly ONE copy,
  // because Gmail dedupes by Message-ID within a mailbox; N separate sends
  // structurally cannot do that. This supersedes O-1's two rationales: the
  // privacy concern (recipients are a few org inboxes, not individuals --
  // and reply-all reaching the leads group is a feature), and per-recipient
  // failure isolation (a single send either lands -- claim the marker -- or
  // throws, which is the existing FAILED-ALL path: nobody received it, so
  // the next poll's retry cannot duplicate).
  const subs = opts.to
    ? [{ email: String(opts.to).trim(), cc: false }].filter(function (s) { return !!s.email; })
    : readQueueReportSubscribers_()
        .filter(function (s) { return s.active && !s.duplicateRow; });   // O-4: dupes never double-send
  let toList = subs.filter(function (s) { return !s.cc; }).map(function (s) { return s.email; });
  let ccList = subs.filter(function (s) { return s.cc; }).map(function (s) { return s.email; });
  // An email needs a To: -- if the admin marked every row Cc, promote them.
  if (!toList.length && ccList.length) { toList = ccList; ccList = []; }
  const recipients = toList.concat(ccList);

  if (!recipients.length) {
    Logger.log('sendQueueReportForDate_(%s): no active subscribers -- nothing sent.', targetIso);
    // `noRecipients` is what separates "ran, nobody subscribed" from "ran, sent
    // to everyone" -- both used to be count:0-with-no-failures, and the caller
    // reported the first one as a successful send. See runDailyQueueReport_.
    return { count: 0, to: [], failed: [], noRecipients: true };
  }

  // Batch 1 item 2: reuse the 6h-TTL qcdAll cache the web report warms, so an
  // admin "Send me a preview" doesn't pay the full cold compute when the exact
  // (targetIso,targetIso) blob is already warm (and a preview warms it for the
  // next web open). Falls through to a fresh compute + cache when cold.
  const data = qcdAllDeptCachedData_(targetIso, targetIso).data;
  const subject = 'Daily Call Queue Report — ' + (data.dateLabel || targetIso);
  const html = buildQueueReportEmailHtml_(data, targetIso, !!opts.isPreview);
  // Single send (see the To/Cc note above). One malformed hand-edited
  // address now fails the WHOLE message -- acceptable: save-time validation
  // guards the modal path, the poller retries all day, and the FAILED-ALL
  // admin email names the error. The single-address preview path (opts.to)
  // still throws so the admin sees the error in the modal.
  try {
    const msg = { to: toList.join(','), subject: subject, htmlBody: html };
    if (ccList.length) msg.cc = ccList.join(',');
    MailApp.sendEmail(msg);
    return { count: recipients.length, to: recipients, failed: [] };
  } catch (e) {
    if (opts.to) throw e;
    const errMsg = (e && e.message) ? e.message : String(e);
    Logger.log('sendQueueReportForDate_(%s): send failed (single To/Cc message): %s', targetIso, e);
    return { count: 0, to: [], failed: recipients.map(function (addr) {
      return { email: addr, error: errMsg };
    }) };
  }
}

/**
 * O-1: one batched admin notification listing the subscriber sends that
 * failed for a target date (partial or total). Best-effort; never throws.
 */
function notifyQueueReportSendFailures_(targetIso, failed, allFailed) {
  try {
    const to = getAdminEmails_().join(',');
    if (!to) return;
    const lines = (failed || []).map(function (f) {
      return ' - ' + f.email + ': ' + f.error;
    });
    MailApp.sendEmail({
      to: to,
      subject: '[Dashboard] Daily Call Queue Report — '
        + (allFailed ? 'ALL subscriber sends failed' : 'some subscriber sends failed')
        + ' (' + targetIso + ')',
      body: (allFailed
          ? 'Every subscriber send failed; the run will RETRY on the next 30-min poll inside the window.\n'
          : 'The report was delivered to the other subscribers; the failures below are NOT retried automatically '
            + '(re-add or fix the address, then use "Send me a preview" to verify).\n')
        + '\nFailed sends for ' + targetIso + ':\n' + lines.join('\n')
        + '\n\nTime: ' + new Date(),
    });
  } catch (mailErr) {
    Logger.log('notifyQueueReportSendFailures_ also failed: %s', mailErr);
  }
}

/**
 * O-7: called on post-window polls. If the target day's report was never
 * sent (data landed after the window closed, or never landed), record a
 * MISSED outcome + email admins ONCE for that day -- previously the day was
 * silently skipped forever and LAST_RESULT kept showing the prior success.
 * Suppressed when nothing was ever sent (fresh install, no baseline).
 */
function queueReportFlagMissedDay_(props, now, targetIso) {
  try {
    const hour = Number(Utilities.formatDate(now, TZ, 'H'));
    if (hour < QUEUE_REPORT_WINDOW_END_HOUR) return;                    // pre-window morning poll
    const dow = now.getDay();
    if (dow === 0 || dow === 6) return;
    if (isCompanyHoliday_(Utilities.formatDate(now, TZ, 'yyyy-MM-dd'))) return;
    if (!targetIso) return;
    const lastSent = props.getProperty(QUEUE_REPORT_LAST_SENT_PROP) || '';
    if (!lastSent || lastSent === targetIso) return;                    // sent today, or never armed
    if ((props.getProperty(QUEUE_REPORT_LAST_MISSED_PROP) || '') === targetIso) return; // already flagged
    props.setProperty(QUEUE_REPORT_LAST_MISSED_PROP, targetIso);
    props.setProperty(QUEUE_REPORT_LAST_RESULT_PROP,
      'LATE ' + targetIso + ' — QCD data was not ready before the window closed ('
      + QUEUE_REPORT_WINDOW_END_HOUR + ':00 Central). The poller keeps retrying every '
      + QUEUE_REPORT_EVERY_MINUTES + ' min until midnight and will send automatically '
      + 'once the data lands. Flagged at ' + new Date());
    const to = getAdminEmails_().join(',');
    if (to) {
      MailApp.sendEmail({
        to: to,
        subject: '[Dashboard] Daily Call Queue Report is LATE for ' + targetIso,
        body: 'The ' + QUEUE_REPORT_WINDOW_START_HOUR + ':00–' + QUEUE_REPORT_WINDOW_END_HOUR
          + ':00 send window closed without the report going out for ' + targetIso
          + ' (QCD data was not ready in time, or the import did not run).\n\n'
          + 'The poller KEEPS RETRYING every ' + QUEUE_REPORT_EVERY_MINUTES + ' minutes until '
          + 'midnight and will send automatically as soon as the data lands (the result will '
          + 'read "Sent ... (LATE)"). If the import is genuinely stuck, fix it and the send '
          + 'follows; nothing else to do here.\n\nTime: ' + new Date(),
      });
    }
  } catch (e) {
    Logger.log('queueReportFlagMissedDay_ failed (best-effort): %s', e);
  }
}

/**
 * Email-safe HTML for the all-departments report -- the "verdict layer" design
 * (docs: the Daily Call Queue Report design update). Leads with the answer:
 * a verdict alert naming any queues over the 5% line, a KPI row, then a
 * WORST-FIRST dept table whose abandoned-% cells are filled <td> bars (NOT
 * Chart.js -- images/canvas are blocked in mail). Inline styles only,
 * nested role="presentation" tables, system fonts, hidden preheader, bulletproof
 * CTA. Bound entirely to the SAME server figures the web report uses
 * (`computeQcdAllDepartments_`); compute / the 5% rule / the exported data are
 * unchanged. Worst-first ordering is EMAIL-ONLY (the web report keeps its
 * viewer-float + parent-grouping order; owner ruling). "Queues in violation" =
 * count of unique queues with abandoned % >= 5% (owner ruling), distinct from
 * the Violations column. Company figures come from `grandTotals` (F-36-deduped,
 * total-abandoned/total-offered basis) -- NOT a client-style re-sum of the
 * sections, which would double-count a queue mapped to two depts.
 */
function buildQueueReportEmailHtml_(data, targetIso, isPreview) {
  const esc = function (v) { return escapeHtmlServer_(String(v == null ? '' : v)); };
  const depts = (data && data.depts) || [];
  const gt = (data && data.grandTotals) || {};
  // R11-B4: labels/data were 'Courier New' mono (the only mono most mail
  // clients can render) -- owner disliked the look; Arial-based styling now,
  // matching the app's tone as closely as email-safe fonts allow.
  const sans = 'Arial,Helvetica,sans-serif';
  const C = {
    bad: '#b23a2c', watch: '#c66b4b', good: '#3d9476',
    ink: '#101418', mut: '#606872', line: '#e2e8ee', rowline: '#eef2f6',
    track: '#eef2f6', headbg: '#f2f6fa', page: '#e7ecf1',
    alertBg: '#f6e2d4', alertB: '#e3b39c', alertInk: '#7a3520',
    okBg: '#e6f0ea', okB: '#cfe3d7', okInk: '#2f5f4a',
    neuTile: '#f2f6fa', neuTileB: '#dde6ee',
    badTile: '#fbeae2', badTileB: '#eccbbb', goodTile: '#e6f0ea', goodTileB: '#cfe3d7',
  };
  // Tier from the ONLY company standard (5% aban) + the existing violation
  // tiering (viol>3 strong / >0 light) -- no invented thresholds.
  const tierOf = function (pct, viol) {
    if (Number(viol) > 3) return { label: 'IN VIOLATION', color: C.bad };
    if (Number(viol) > 0 || Number(pct) >= 5) return { label: 'WATCH', color: C.watch };
    return { label: 'HEALTHY', color: C.good };
  };
  // R11-B4 (owner-confirmed): share-of-total SPLIT bar (green answered /
  // red abandoned), replacing the old 0-20%-scaled fill where a 50%-abandon
  // day clamped to a full orange bar that contradicted its own number.
  // Mirrors the web report's qcdDailyBarCell_; the red softens when the row
  // passes the 5% standard (the R10-4 convention).
  // Round-16 (owner): queue rows mirror the web report's volume TALLY --
  // fixed-width block cells (answered green, abandoned red; soft red under
  // the 5% standard) at a cohort-shared unit, so a busy queue visibly
  // dwarfs a quiet one in the email too. Section/company rows keep the
  // proportional split bar (aggregates dwarf queue-scale blocks). Email-safe:
  // table cells with inline styles, no flex/inline-block.
  const tallyHtml = function (row, pctStr, textColor, bold, unit) {
    const a = Number(row.totalAnswered) || 0;
    const ab = Number(row.abandoned != null ? row.abandoned
      : Math.round((Number(row.abandonedPct) || 0) / 100 * (Number(row.totalCalls) || 0))) || 0;
    const abPct = Number(row.abandonedPct) || 0;
    const redC = abPct >= 5 ? C.bad : '#e8c4b2';
    // R17e (owner): slimmer cells than the original 5px+2px buy the higher
    // block ceiling (TALLY_MAX_BLOCKS below), which lets the unit ladder
    // land on 20 calls/block for a ~350-500-call queue day where the old
    // 14-block ceiling forced 50/block and hid the scale. R17f (owner):
    // 4px+1px, not R17e's 3px+1px -- the column widened to 190px, so the
    // 25-block ceiling no longer needs sliver cells.
    const blocks = function (n, color) {
      let out = '';
      for (let i = 0; i < n; i++) {
        out += '<td width="4" style="background:' + color + ';height:12px;line-height:12px;font-size:0;">&nbsp;</td>'
             + '<td width="1" style="font-size:0;">&nbsp;</td>';
      }
      return out;
    };
    let nA = a > 0 ? Math.max(1, Math.round(a / unit)) : 0;
    let nAb = ab > 0 ? Math.max(1, Math.round(ab / unit)) : 0;
    // R18 (owner): CLIP rather than re-scale. The unit is now email-wide
    // (tallyBasisFor_ below), so a queue far above the rest would otherwise
    // run past the column and force the shrink-to-fit that R16e's ceiling
    // exists to prevent. A clipped row keeps its proportions between
    // answered and abandoned, and carries a "»" so it reads as "off the
    // scale, see the count" instead of as a row that merely tied with the
    // longest bar -- which is exactly the misread the per-section unit
    // produced in the other direction.
    let clipped = false;
    if (nA + nAb > TALLY_MAX_BLOCKS) {
      clipped = true;
      const keepAb = nAb > 0
        ? Math.min(nAb, Math.max(1, Math.round(TALLY_MAX_BLOCKS * nAb / (nA + nAb))))
        : 0;
      nAb = keepAb;
      nA = Math.max(0, TALLY_MAX_BLOCKS - keepAb);
    }
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
      + blocks(nA, C.good) + blocks(nAb, redC)
      + (clipped
          ? '<td style="font:bold 11px ' + sans + ';color:' + C.mut + ';padding:0 2px 0 1px;line-height:12px;">&raquo;</td>'
          : '')
      + '<td align="right" style="font:' + (bold ? 'bold ' : '') + '11px ' + sans + ';color:' + textColor + ';padding-left:4px;white-space:nowrap;">' + esc(pctStr) + '</td>'
      + '</tr></table>';
  };
  const barHtml = function (row, pctStr, textColor, bold) {
    const total = Number(row.totalCalls) || 0;
    const abPct = Number(row.abandonedPct) || 0;
    if (total <= 0) {
      return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
        + '<td style="padding:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.track + ';border-radius:5px;"><tr>'
        +   '<td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr></table></td>'
        + '<td width="42" align="right" style="font:11px ' + sans + ';color:' + C.mut + ';padding-left:6px;">&ndash;</td>'
        + '</tr></table>';
    }
    const ansPct = row.totalAnswered != null
      ? Math.max(0, Math.min(100, (Number(row.totalAnswered) || 0) / total * 100))
      : Math.max(0, 100 - abPct);
    let abW = Math.round(abPct);
    if (abPct > 0 && abW < 2) abW = 2;   // a real abandon stays visible
    let ansW = Math.min(100 - abW, Math.round(ansPct));
    const restW = Math.max(0, 100 - ansW - abW);
    const redC = abPct >= 5 ? C.bad : '#e8c4b2';   // full red only past the 5% standard
    let cells = '';
    if (ansW > 0)  cells += '<td width="' + ansW + '%" style="background:' + C.good + ';height:8px;line-height:8px;font-size:0;">&nbsp;</td>';
    if (abW > 0)   cells += '<td width="' + abW + '%" style="background:' + redC + ';height:8px;line-height:8px;font-size:0;">&nbsp;</td>';
    if (restW > 0) cells += '<td width="' + restW + '%" style="background:' + C.track + ';height:8px;line-height:8px;font-size:0;">&nbsp;</td>';
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
      + '<td style="padding:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.track + ';border-radius:5px;"><tr>'
      +   cells
      + '</tr></table></td>'
      + '<td width="42" align="right" style="font:' + (bold ? 'bold ' : '') + '11px ' + sans + ';color:' + textColor + ';padding-left:6px;">' + esc(pctStr) + '</td>'
      + '</tr></table>';
  };
  // A dept's report lines: its queues[] when present, else the dept total as one.
  const deptQueues = function (d) {
    if (d.queues && d.queues.length) return d.queues;
    const t = d.totals || {};
    return [{ queue: d.dept, totalCalls: t.totalCalls, abandonedPct: t.abandonedPct,
              abandonedPctStr: t.abandonedPctStr, violations: t.violations,
              violationsMtd: t.violationsMtd }];
  };
  // R12-24 (owner): the Viol column is MONTH-TO-DATE (through the range end's
  // month) -- falls back to the range figure for a pre-v5 cached payload.
  const violOf = function (o) {
    return (o && o.violationsMtd != null) ? Number(o.violationsMtd) || 0
      : Number((o || {}).violations) || 0;
  };

  // Offenders (unique queues >= 5%) for the alert + preheader, worst-first.
  const seen = {}, offenders = [];
  depts.forEach(function (d) {
    deptQueues(d).forEach(function (q) {
      if (seen[q.queue]) return; seen[q.queue] = true;
      if (Number(q.abandonedPct) >= 5) {
        offenders.push({ queue: q.queue, pct: Number(q.abandonedPct) || 0,
          pctStr: q.abandonedPctStr || (Number(q.abandonedPct) || 0).toFixed(2) + '%',
          viol: Number(q.violations) || 0 });
      }
    });
  });
  offenders.sort(function (a, b) { return (b.viol - a.viol) || (b.pct - a.pct); });

  // R18 (owner): the tally unit is EMAIL-WIDE again, and the R16d per-section
  // unit is RETIRED. Per-section was a defensible trade on paper -- each
  // section reads well, and cross-dept magnitude is in the Total column --
  // but it does not survive contact with a reader. Bar length is
  // pre-attentive and a caption is not, so nobody checks "block ≈ N calls"
  // before comparing two bars. Measured on the 2026-08-11 email: CSR's 349
  // calls drew 17 blocks while Sales (50) and Field Ops Power (25) each drew
  // 25 -- the busiest queue in the company rendered as the shortest of the
  // three, and Field Ops (42) read as quieter than Field Ops Power (25).
  // One unit restores the only property a tally has: length ∝ quantity.
  // Ladder = the web report's ansTallyUnitFor_, replicated server-side;
  // 0 = no volume.
  // R16e (owner): the block CEILING is a LAYOUT constraint, not a taste
  // call. The tally is an HTML-email table of fixed-width cells inside the
  // "Abandoned %" column: past the column's natural-width budget the
  // renderer SHRINKS every cell to fit (measured at the original 5px+2px
  // cells in the 150px column: 20 blocks rendered 4.09px against 5px for a
  // 9-block row). Blocks then stop being uniform between rows, which is
  // exactly what a tally must never do. Keeping the widest row under the
  // fit threshold makes every block identical everywhere.
  // R17e/R17f (owner): the ceiling is 25 so the unit ladder lands on
  // 20 calls/block for a ~350-500-call queue day (the old 14-block ceiling
  // forced 50/block, which read as a much quieter queue); the column is
  // 190px wide (was 150) so those 25 blocks keep 4px+1px cells -- 25 x 5px
  // = 125px + the ~45px % label + 16px padding = 186px, just under the
  // column's edge. Raising the ceiling or fattening the cells without
  // widening the column re-introduces the squeeze.
  const TALLY_MAX_BLOCKS = 25;
  const tallyUnitFor_ = function (max) {
    if (!max) return 0;
    const ladder = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
    for (let i = 0; i < ladder.length; i++) {
      if (Math.ceil(max / ladder[i]) <= TALLY_MAX_BLOCKS) return ladder[i];
    }
    return ladder[ladder.length - 1];
  };
  // R18: which value the ONE unit is derived from. Scaling to the true
  // maximum is the naive answer and it fails: this company's queue day spans
  // ~349 to ~1, so a unit that fits CSR puts nine of twelve queues under a
  // single block and the small half of the report stops saying anything.
  // Instead, drop leading OUTLIERS -- a value more than TALLY_OUTLIER_RATIO
  // times the next one down -- and scale to the largest survivor; the dropped
  // rows clip with a "»". Two genuinely-large queues are NOT outliers (349 vs
  // 300 stops the walk immediately), so a day whose top is broad sets the
  // scale from that top and nothing clips -- the squeeze is then real, not an
  // artifact. Bounded twice so the scale can never be set by the tail: at
  // most a quarter of the rows may be dropped, and never below two survivors.
  const TALLY_OUTLIER_RATIO = 2.5;
  const tallyBasisFor_ = function (totals) {
    const vals = (totals || []).filter(function (v) { return v > 0; })
      .sort(function (a, b) { return b - a; });
    if (!vals.length) return { basis: 0, clipped: 0 };
    const maxDrop = Math.min(Math.floor(vals.length / 4), Math.max(0, vals.length - 2));
    let i = 0;
    while (i < maxDrop && vals[i] > TALLY_OUTLIER_RATIO * vals[i + 1]) i++;
    return { basis: vals[i], clipped: i };
  };
  // Worst-first dept order (EMAIL ONLY).
  // R12-22 (owner): sections are PARENT-GROUPED like the web report --
  // Spanish nests under CSR, PAP under Sales, PAK under Power (the payload's
  // `parent` field, #3) instead of standing as their own dept sections. The
  // banner line carries the SECTION total (parent own + children) INLINE, and
  // a section whose whole story is ONE queue renders banner-only (the old
  // shape repeated identical numbers on the banner and the lone queue row).
  const byName = {};
  depts.forEach(function (d) { byName[d.dept] = d; });
  const childrenOf = {};
  const parentsOnly = [];
  depts.forEach(function (d) {
    if (d.parent && byName[d.parent]) {
      (childrenOf[d.parent] = childrenOf[d.parent] || []).push(d);
    } else {
      parentsOnly.push(d);
    }
  });
  const secTotals = function (d) {
    const own = d.totals || {};
    const t = {
      calls: Number(own.totalCalls) || 0,
      abnd: Number(own.abandoned) || 0,
      viol: Number(own.violations) || 0,
      // Owner round: the section's MONTH-TO-DATE violations, so a dept that
      // rendered banner-only still reports them (see the banner below).
      violMtd: violOf(own),
    };
    (childrenOf[d.dept] || []).forEach(function (c) {
      const ct = c.totals || {};
      t.calls += Number(ct.totalCalls) || 0;
      t.abnd  += Number(ct.abandoned)  || 0;
      t.viol  += Number(ct.violations) || 0;
      t.violMtd += violOf(ct);
    });
    t.pct = t.calls > 0 ? (t.abnd / t.calls * 100) : 0;
    return t;
  };
  const ordered = parentsOnly.slice().sort(function (a, b) {
    const sa = secTotals(a), sb = secTotals(b);
    return (sb.pct - sa.pct) || (sb.viol - sa.viol);
  });

  const gPct = Number(gt.abandonedPct) || 0;
  const gTotal = Number(gt.totalCalls) || 0;
  const gAns = Number(gt.totalAnswered) || 0;
  const gAnsPct = gTotal > 0 ? (gAns / gTotal * 100) : 0;
  const gViol = Number(gt.violations) || 0;
  const overCount = offenders.length;

  const dashUrl = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL') || '';
  const dateLbl = esc(data.dateLabel || targetIso);

  // ---- preheader ----
  const preheadTxt = overCount
    ? (overCount + ' queue' + (overCount === 1 ? '' : 's') + ' over the 5% line — '
        + offenders.slice(0, 2).map(function (o) { return o.queue + ' ' + o.pctStr; }).join(', ')
        + '. Company aban ' + (gt.abandonedPctStr || gPct.toFixed(1) + '%') + '.')
    : ('All queues under the 5% line. Company aban ' + (gt.abandonedPctStr || gPct.toFixed(1) + '%') + '.');
  const preheader = '<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;'
    + 'font-size:1px;line-height:1px;color:' + C.page + ';">' + esc(preheadTxt) + '</div>';

  // R11-B4 (owner): the verdict alert banner is RETIRED -- the KPI tiles +
  // per-row color already carry it. (offenders still feed the preheader.)

  // ---- KPI row ----
  // R16c (owner): every tile centers its content -- the sub-line-less
  // "Queues in viol." tile read awkward left-aligned, and centering only
  // it would have broken the row's symmetry.
  const kpi = function (label, value, bg, bd, labelColor, valColor, pad, subHtml) {
    return '<td class="kpi" width="25%" valign="top" style="' + (pad || '') + '">'
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:10px;"><tr>'
      + '<td class="kpi-cell" align="center" style="padding:12px 14px;text-align:center;">'
      + '<div style="font:600 9px ' + sans + ';letter-spacing:0.8px;text-transform:uppercase;color:' + labelColor + ';">' + esc(label) + '</div>'
      + '<div style="font:bold 26px Arial,sans-serif;color:' + valColor + ';padding-top:2px;">' + esc(value) + '</div>'
      + (subHtml || '')
      + '</td></tr></table></td>';
  };
  // MTD sub-lines (owner spec, Round-16; mirrors the web band): MTD =
  // month-start(report date)..report date vs the ENTIRE previous month.
  // Total calls compares per-WORKDAY averages; aban down / answered up =
  // green, reverse = orange, volume delta always gray; every delta grays
  // under 3 elapsed workdays (low signal). Null-guarded so a payload
  // without `mtd` renders the pre-v6 tiles unchanged.
  const m = (data && data.mtd) || null;
  const mtdUsable = !!(m && m.workdays > 0 && m.totalCalls > 0);
  const mtdPriorUsable = !!(m && m.priorWorkdays > 0 && m.priorTotalCalls > 0);
  const mtdLowSignal = !!(m && m.workdays < 3);
  const mtdSub = function (valueTxt, deltaTxt, deltaColor) {
    return '<div style="font:11px ' + sans + ';color:' + C.mut + ';padding-top:6px;white-space:nowrap;">'
      + '<span style="font-weight:bold;font-size:9px;letter-spacing:0.6px;">MTD</span> '
      + '<span style="color:' + C.ink + ';font-weight:bold;">' + esc(valueTxt) + '</span>'
      + (deltaTxt ? ' &middot; <span style="color:' + (mtdLowSignal ? C.mut : deltaColor) + ';font-weight:bold;">' + esc(deltaTxt) + '</span>' : '')
      + '</div>';
  };
  let mtdAbanSub = '', mtdCallsSub = '', mtdAnsSub = '';
  if (mtdUsable) {
    const mAbanPct = Number(m.abandonedPct) || 0;
    const mAnsPct = m.totalCalls > 0 ? (m.answered / m.totalCalls * 100) : 0;
    const mAvg = m.totalCalls / m.workdays;
    const vsLbl = ' vs ' + (m.priorLabel || 'prior');
    if (mtdPriorUsable) {
      const pAbanPct = Number(m.priorAbandonedPct) || 0;
      const pAnsPct = m.priorTotalCalls > 0 ? (m.priorAnswered / m.priorTotalCalls * 100) : 0;
      const pAvg = m.priorTotalCalls / m.priorWorkdays;
      const dAban = mAbanPct - pAbanPct;
      const dAns = mAnsPct - pAnsPct;
      const dAvgPct = pAvg > 0 ? ((mAvg - pAvg) / pAvg * 100) : 0;
      mtdAbanSub = mtdSub(mAbanPct.toFixed(2) + '%',
        (dAban <= 0 ? '▼ ' : '▲ ') + Math.abs(dAban).toFixed(2) + ' pts' + vsLbl,
        dAban <= 0 ? C.good : C.watch);
      mtdCallsSub = mtdSub(Math.round(mAvg) + '/day',
        (dAvgPct >= 0 ? '▲ ' : '▼ ') + Math.abs(dAvgPct).toFixed(1) + '%' + vsLbl,
        C.mut);
      mtdAnsSub = mtdSub(mAnsPct.toFixed(1) + '%',
        (dAns >= 0 ? '▲ ' : '▼ ') + Math.abs(dAns).toFixed(1) + ' pts' + vsLbl,
        dAns >= 0 ? C.good : C.watch);
    } else {
      mtdAbanSub = mtdSub(mAbanPct.toFixed(2) + '%', '', '');
      mtdCallsSub = mtdSub(Math.round(mAvg) + '/day', '', '');
      mtdAnsSub = mtdSub(mAnsPct.toFixed(1) + '%', '', '');
    }
  }
  // Round-16 (owner): the per-queue MTD pace sub-line, mirroring the web
  // table's qMtdSub -- "MTD Ø <avg>/day · <prior month> <avg> ▲/▼ %", per-
  // WORKDAY averages from the SAME mtd block as the KPI sub-lines so every
  // level reconciles. Neutral gray throughout (volume is demand, not
  // performance). A queue with no prior-month activity reads "new this
  // month"; no activity in either window renders nothing. Null-guarded so a
  // pre-v6 cached payload (no mtd / no per-queue fields) renders no line.
  const qMtdSubEmail = function (q) {
    if (!m || !(m.workdays > 0)) return '';
    const mCalls = Number(q.mtdTotalCalls) || 0;
    const pCalls = Number(q.priorTotalCalls) || 0;
    if (!mCalls && !pCalls) return '';
    const mAvg = Math.round(mCalls / m.workdays);
    const pAvg = m.priorWorkdays > 0 ? (pCalls / m.priorWorkdays) : 0;
    const pLbl = m.priorLabel || 'prior';
    let tail;
    if (pAvg > 0) {
      const dPct = (mAvg - pAvg) / pAvg * 100;
      // R16c (owner): '/day' on the PRIOR value too -- a bare "Jun 100"
      // read as a date rather than the prior month's per-day average.
      tail = esc(pLbl) + ' ' + Math.round(pAvg) + '/day '
        + (dPct >= 0 ? '&#9650;' : '&#9660;') + ' ' + Math.abs(dPct).toFixed(1) + '%';
    } else {
      tail = 'new this month';
    }
    return '<div style="font:10px ' + sans + ';color:' + C.mut + ';padding-top:2px;white-space:nowrap;">'
      + 'MTD &Oslash; ' + mAvg + '/day &middot; ' + tail + '</div>';
  };
  // R16c/R16d (owner): the daily company aban VALUE color-codes on its own
  // tier ladder -- green <=3%, amber 3-4%, red >4% (tighter than the 5%
  // queue violation line: the company-wide blend should sit well under it).
  // R16d: when the value goes RED the CARD tints light red too (the same
  // badTile treatment as the Queues-in-viol card); green/amber keep the
  // neutral tile.
  const gValColor = gPct <= 3 ? C.good : (gPct <= 4 ? C.watch : C.bad);
  const abanOver = gValColor === C.bad;
  const kpiRow = '<tr><td style="padding:16px 26px 4px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
    + kpi('Daily Company Aban %', (gt.abandonedPctStr || gPct.toFixed(1) + '%'),
        abanOver ? C.badTile : C.neuTile, abanOver ? C.badTileB : C.neuTileB,
        abanOver ? '#8a5a44' : '#6b7580', gValColor, 'padding-right:6px;', mtdAbanSub)
    + kpi('Total calls', gTotal, C.neuTile, C.neuTileB, '#6b7580', C.ink, 'padding:0 3px;', mtdCallsSub)
    + kpi('Queues in viol.', overCount, overCount > 0 ? C.badTile : C.neuTile, overCount > 0 ? C.badTileB : C.neuTileB,
        overCount > 0 ? '#8a5a44' : '#6b7580', overCount > 0 ? C.bad : C.ink, 'padding:0 3px;')
    + kpi('Answered', gAnsPct.toFixed(1) + '%', C.goodTile, C.goodTileB, '#3f7a5f', C.good, 'padding-left:6px;', mtdAnsSub)
    + '</tr></table></td></tr>';

  // ---- table (worst-first sections) ----
  // R18: ONE tally unit for the whole email, derived from every queue row it
  // will draw -- own queues and sub-queue children alike, using the exact
  // same answered+abandoned total tallyHtml renders, so the scale cannot
  // disagree with the bars. Disclosed once in the column header below.
  const tallyTotals = ordered.reduce(function (acc, d) {
    const push = function (q) {
      acc.push((Number(q.totalAnswered) || 0) + (Number(q.abandoned) || 0));
    };
    deptQueues(d).forEach(push);
    (childrenOf[d.dept] || []).forEach(function (c) { deptQueues(c).forEach(push); });
    return acc;
  }, []);
  const tallyScale = tallyBasisFor_(tallyTotals);
  // R18b (owner): PREFER 2 calls/block. The adaptive basis landed on 5 for a
  // typical day, which is coarse where most queues live -- an 11-call queue
  // and a 13-call one drew the same 2-3 blocks. At 2/block the bottom half of
  // the report regains resolution and the top simply clips, which is the
  // trade the clip marker exists to make legible. The adaptive ladder is kept
  // as a FALLBACK, not deleted: clipping is only honest while it is rare, and
  // once a large share of rows sit at the ceiling they all draw the same
  // length and the tally stops ranking anything. So take 2 when it clips at
  // most a quarter of the rows, else fall back to the basis-derived unit.
  const TALLY_UNIT_PREFERRED = 2;
  const tallyUnit = (function () {
    const basisUnit = tallyUnitFor_(tallyScale.basis);
    if (!basisUnit || basisUnit <= TALLY_UNIT_PREFERRED) return basisUnit;
    const vals = tallyTotals.filter(function (v) { return v > 0; });
    const wouldClip = vals.filter(function (v) {
      return Math.round(v / TALLY_UNIT_PREFERRED) > TALLY_MAX_BLOCKS;
    }).length;
    // Strict minority, with no floor: a report of two or three queues may not
    // clip at all (one of two rows at the ceiling is not "rare", it is half
    // the report), and four or more may clip a quarter of them.
    return wouldClip <= Math.floor(vals.length / 4)
      ? TALLY_UNIT_PREFERRED : basisUnit;
  })();
  // Rows past the ceiling at the unit actually chosen -- what the "»" legend
  // is gating on. Recomputed rather than reusing tallyScale.clipped, which
  // counts outliers dropped from the BASIS and is only equal to this when the
  // basis-derived unit won.
  const tallyClipped = tallyTotals.filter(function (v) {
    return v > 0 && tallyUnit > 0 && Math.round(v / tallyUnit) > TALLY_MAX_BLOCKS;
  }).length;
  const violHdr = 'Viol (MTD)';
  let tbl = '<tr style="background:' + C.headbg + ';">'
    + '<td style="padding:9px 12px;font:600 9px ' + sans + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;">Queue</td>'
    + '<td align="right" style="padding:9px 8px;font:600 9px ' + sans + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;">Total</td>'
    // R17f (owner): 190px, up from 150 -- the Viol column had slack, and the
    // extra width lets the tally blocks keep 4px cells at the 25-block
    // ceiling instead of the 3px slivers the 150px column forced.
    + '<td width="190" style="padding:9px 8px;font:600 9px ' + sans + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;">Abandoned %</td>'
    + '<td align="right" style="padding:9px 12px;font:600 9px ' + sans + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;white-space:nowrap;">' + violHdr + '</td></tr>';
  ordered.forEach(function (d) {
    const sec = secTotals(d);
    const dt = tierOf(sec.pct, sec.viol);
    // R11-F (owner): the dept name strip carries its health VERDICT as a
    // colored LEFT EDGE (green / watch / red) + a distinct tinted background so
    // it stands out from the queue rows, replacing the HEALTHY/WATCH text
    // label; and its mini-summary now includes the ABANDONED COUNT + % (the
    // web app's QV-2 dept-banner shape) so "how many calls did we lose" reads
    // without opening the dashboard.
    const dCalls = sec.calls, dAbnd = sec.abnd, dPct = sec.pct;
    const dPctStr = dPct.toFixed(1) + '%';
    const kids = childrenOf[d.dept] || [];
    // One flat row list: own queues, then each child's queues as sub-rows.
    const rowDefs = deptQueues(d).map(function (q) { return { q: q, sub: null }; });
    kids.forEach(function (c) {
      deptQueues(c).forEach(function (q) { rowDefs.push({ q: q, sub: c.dept }); });
    });
    // R16c (owner): the banner-only collapse for single-queue sections is
    // RETIRED -- every queue now renders its own data row beneath the
    // banner, so the visual TALLY (which only queue rows carry) appears for
    // every queue, not just sub-queue depts. The banner keeps the section
    // rollup; the row carries the tally + per-queue viol + MTD pace line.
    // Some numbers repeat on single-queue sections -- accepted for the
    // uniform structure (the old dedup was why the tally went missing).
    // Owner round: the dept name is a LINK into that dept's My Department page.
    //
    // Authorization is NOT delegated to this link, and must never be read as if
    // it were. `assertDeptAccess_` gates every report endpoint server-side and
    // rejects a dept outside the viewer's `user.departments` whatever the client
    // asks for. The client's '/dept' share-state provider additionally IGNORES a
    // dept the viewer doesn't hold, so a recipient who clicks another
    // department's line lands on their OWN dept rather than on an error page --
    // this report goes to a subscriber list that is not the same thing as the
    // Access Control roster, so that case is expected, not exceptional.
    //
    // encodeURIComponent for the value (dept names carry spaces and '&' --
    // 'Eligibility MM&R' would otherwise truncate at the ampersand), then esc()
    // for the surrounding HTML attribute.
    const deptLink = dashUrl
      ? (dashUrl + '#/dept?dept=' + encodeURIComponent(d.dept))
      : '';
    // (R16c: the single-queue banner no longer carries the queue name inline
    // -- the queue's own row below shows it.)
    const deptLabel = esc(d.dept);
    // Underline-free + inherited color so the banner looks unchanged; without
    // the explicit color some clients paint it link-blue against the tinted
    // strip. Falls back to plain text when DASHBOARD_URL is unset, exactly as
    // the CTA block below already does.
    const bannerName = deptLink
      ? ('<a href="' + esc(deptLink) + '" style="color:' + C.ink
         + ';text-decoration:none;">' + deptLabel + '</a>')
      : deptLabel;
    const stripBg = dt.color === C.bad ? C.badTile : (dt.color === C.watch ? C.alertBg : C.okBg);
    // Owner round: month-to-date violations on the BANNER. A section whose
    // whole story is one queue renders banner-only (no per-queue rows), so its
    // MTD count had nowhere to appear -- a dept green TODAY but carrying
    // violations from earlier in the month showed nothing at all, which is the
    // opposite of what the column is for. Rendered whenever > 0, on every
    // section, so it does not depend on today's tier.
    const secViolMtd = Number(sec.violMtd) || 0;
    // R18: the unit is email-wide (tallyUnit, computed before this loop) and
    // disclosed ONCE in the column header, so the per-section block-size note
    // is gone -- it was the thing that made a changing scale look sanctioned.
    // Owner round: the section's MTD violations move OUT of the summary text and
    // into the real Viol column, so the banner reads "4" under the "Viol (MTD)"
    // header instead of repeating the label as " 4 viol MTD". That means the
    // banner can no longer colspan the whole table -- it spans the first three
    // columns and gets its own fourth cell, which has to repeat the strip's
    // background and top border by hand so the row still reads as one band.
    tbl += '<tr>'
      + '<td colspan="3" style="padding:0;border-top:1px solid ' + C.rowline + ';">'
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + stripBg + ';border-left:4px solid ' + dt.color + ';border-collapse:separate;"><tr>'
      // (R16c: the MTD pace line lives on the queue rows for EVERY section
      // now -- the banner-only collapse that parked it here is retired.)
      +   '<td style="padding:8px 12px;font:bold 13px Arial,sans-serif;color:' + C.ink + ';">' + bannerName + '</td>'
      +   '<td align="right" style="padding:8px 12px;font:12px ' + sans + ';color:' + C.mut + ';white-space:nowrap;">'
      +     esc(dCalls) + ' calls &middot; <span style="' + (dPct >= 5 ? 'font-weight:bold;color:' + C.bad : 'color:' + C.ink) + ';">' + esc(dAbnd) + ' abandoned (' + esc(dPctStr) + ')</span>'
      +   '</td>'
      + '</tr></table></td>'
      + '<td align="right" style="background:' + stripBg + ';border-top:1px solid ' + C.rowline
      +   ';padding:8px 12px;font:' + (secViolMtd > 0 ? 'bold ' : '') + '12px ' + sans
      +   ';color:' + (secViolMtd > 0 ? dt.color : C.mut) + ';">'
      +   (secViolMtd > 0 ? esc(String(secViolMtd)) : '')
      + '</td>'
      + '</tr>';
    rowDefs.forEach(function (rd) {
      const q = rd.q;
      const pct = Number(q.abandonedPct) || 0;
      const t = tierOf(pct, q.violations);
      const pctStr = q.abandonedPctStr || pct.toFixed(1) + '%';
      const viol = violOf(q);
      const rowLbl = rd.sub
        ? '&#8627; <b>' + esc(rd.sub) + '</b> <span style="color:' + C.mut + ';">&middot; ' + esc(q.queue) + '</span>'
        : esc(q.queue);
      tbl += '<tr>'
        + '<td style="padding:6px 12px' + (rd.sub ? ' 6px 22px' : '') + ';font:12px ' + sans + ';color:' + C.ink + ';border-top:1px solid ' + C.rowline + ';">' + rowLbl + qMtdSubEmail(q) + '</td>'
        + '<td align="right" style="padding:6px 8px;font:12px ' + sans + ';color:' + C.ink + ';border-top:1px solid ' + C.rowline + ';">' + esc(q.totalCalls) + '</td>'
        + '<td style="padding:6px 8px;border-top:1px solid ' + C.rowline + ';">' + (tallyUnit > 0 ? tallyHtml(q, pctStr, pct >= 5 ? t.color : C.mut, pct >= 5, tallyUnit) : barHtml(q, pctStr, pct >= 5 ? t.color : C.mut, pct >= 5)) + '</td>'
        + '<td align="right" style="padding:6px 12px;font:' + (viol > 0 ? 'bold ' : '') + '12px ' + sans + ';color:' + (viol > 0 ? t.color : C.mut) + ';border-top:1px solid ' + C.rowline + ';">' + esc(String(viol)) + '</td>'
        + '</tr>';
    });
  });
  const gTier = tierOf(gPct, gViol);
  // Owner round: the company total's Viol cell is deliberately BLANK. Summing
  // month-to-date violation DAYS across departments produces a number with no
  // meaning -- two depts each violating on the same day reads as 2, and the
  // figure only grows as more depts are added. The per-section counts are the
  // real signal; a company roll-up of them invited exactly the wrong reading.
  tbl += '<tr>'
    + '<td style="padding:9px 12px;font:bold 12px Arial,sans-serif;color:' + C.ink + ';border-top:2px solid ' + C.ink + ';">Company total</td>'
    + '<td align="right" style="padding:9px 8px;font:bold 12px ' + sans + ';color:' + C.ink + ';border-top:2px solid ' + C.ink + ';">' + esc(gTotal) + '</td>'
    + '<td style="padding:9px 8px;border-top:2px solid ' + C.ink + ';">' + barHtml({ totalCalls: gTotal, totalAnswered: gAns, abandonedPct: gPct }, (gt.abandonedPctStr || gPct.toFixed(1) + '%'), gPct >= 5 ? gTier.color : C.mut, true)
    // (R16d: the "each block ≈ N" note moved to each section's banner --
    // the unit is per-section now, so a single company-row note would lie.)
    + '</td>'
    + '<td align="right" style="padding:9px 12px;border-top:2px solid ' + C.ink + ';">&nbsp;</td>'
    + '</tr>';

  const tableBlock = depts.length
    ? ('<tr><td style="padding:18px 26px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ' + C.line + ';border-radius:10px;border-collapse:separate;overflow:hidden;">'
      + tbl + '</table>'
      // R18: the tally scale is disclosed ONCE, here, next to the sentence that
      // already explains the bars -- it belongs with them, and the column
      // header is too narrow to carry it without wrapping to two lines.
      + '<div style="font:10px ' + sans + ';color:#9aa6b2;padding:8px 2px 0;">Depts sorted worst-first &middot; bars show answered (green) vs abandoned (red) share of calls'
      +   (tallyUnit > 1 ? ' &middot; one block &asymp; ' + tallyUnit + ' calls, the same across every queue below' : '')
      +   (tallyClipped > 0 ? ' &middot; &raquo; marks a queue past the end of that scale \u2014 read its count' : '')
      +   ' &middot; full columns (Ans/Longest/Avg) live in the dashboard &middot; Viol = each queue\u2019s 5%-violation days month-to-date (through this report\u2019s end date).</div>'
      + '</td></tr>')
    : '<tr><td style="padding:18px 26px 6px;font:400 14px Arial,sans-serif;color:' + C.mut + ';">No queue activity recorded for this day.</td></tr>';

  // ---- bulletproof CTA (there is no direct route to the all-dept modal; land
  // on Overview, where the "Daily Call Queue Report" button opens it). ----
  const ctaBlock = dashUrl
    ? ('<tr><td style="padding:12px 26px 24px;" align="left"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td bgcolor="' + C.ink + '" style="border-radius:8px;"><a href="' + esc(dashUrl) + '#/overview" '
      +   'style="display:block;padding:11px 20px;font:bold 13px Arial,sans-serif;color:#ffffff;text-decoration:none;">Open the dashboard &rarr;</a>'
      + '</td></tr></table></td></tr>')
    : '';

  const previewBar = isPreview
    ? ('<tr><td style="padding:14px 26px 0;"><div style="background:#FEF3C7;border-left:4px solid #D97706;padding:10px 14px;border-radius:6px;font:400 13px Arial,sans-serif;color:#7C2D12;">'
      + '<strong style="color:#92400E;">Preview only.</strong> This is what subscribers receive each weekday morning once the previous workday&rsquo;s data has been processed.</div></td></tr>')
    : '';

  return ''
    + preheader
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.page + ';"><tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="wrap" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">'
    // header
    + '<tr><td style="padding:22px 26px 18px;border-bottom:1px solid ' + C.line + ';">'
    +   '<div style="font:600 11px ' + sans + ';letter-spacing:1.5px;text-transform:uppercase;color:#8a97a4;">Call Data &middot; Daily report</div>'
    +   '<div style="font:bold 23px Arial,sans-serif;color:' + C.ink + ';letter-spacing:-0.4px;padding-top:4px;">Daily Call Queue Report</div>'
    +   '<div style="font:400 13px Arial,sans-serif;color:' + C.mut + ';padding-top:3px;">' + dateLbl + ' &middot; all departments</div>'
    + '</td></tr>'
    + previewBar
    + kpiRow
    + tableBlock
    + ctaBlock
    // footer
    + '<tr><td style="padding:16px 26px 22px;border-top:1px solid ' + C.line + ';background:#f7fafc;">'
    +   '<div style="font:400 11px/1.6 Arial,sans-serif;color:#8a97a4;">Automated daily summary from the Call Data dashboard. Times shown in CST for the previous business day.<br>'
    +   'An admin can manage this notification in Alerts &rarr; Daily Call Queue Report.</div>'
    + '</td></tr>'
    + '</table></td></tr></table>';
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
  // Round-16 (To/Cc): bounded to the sheet's real width -- a legacy 3-column
  // sheet (pre-Cc) reads cleanly with every row defaulting to To.
  const width = Math.min(QUEUE_REPORT_SUBSCRIBERS_HEADERS.length, sheet.getLastColumn());
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const out = [];
  const seenEmail = {};   // O-4: OPS-9 discipline -- first-row-wins on hand-edited duplicates
  for (let i = 0; i < values.length; i++) {
    const email = String(values[i][0] || '').trim();
    if (!email) continue;
    const rawActive = values[i][1];
    const active = !(rawActive === false || rawActive === 'FALSE' || rawActive === 'false'
                   || rawActive === 0 || rawActive === 'no' || rawActive === 'No');
    const rawCc = values[i][3];
    const cc = (rawCc === true || rawCc === 'TRUE' || rawCc === 'true' || rawCc === 'yes' || rawCc === 'Yes');
    const entry = { email: email, active: active, notes: String(values[i][2] || '').trim(), cc: cc };
    const key = email.toLowerCase();
    if (seenEmail[key]) {
      // Duplicate hand-edited row: flag it (kept in the list so the modal
      // shows it and remove deletes all copies) but the send loop skips it,
      // so the subscriber gets ONE email per run, not one per row.
      entry.duplicateRow = true;
    }
    seenEmail[key] = true;
    out.push(entry);
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
  const cc = !!(req && (req.cc === true || req.cc === 'true'));
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
    const rowVals = [email, active ? 'TRUE' : 'FALSE', notes, cc ? 'TRUE' : 'FALSE'];
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
 * O-10: PURE verdict for the gate check -- turns a gate reason plus the
 * resolved inputs into { wouldSend, explanation }. Split out for the same
 * reason queueReportGateDecision_ is: the interesting cases (already-sent,
 * not-ready, ready-but-nobody-subscribed) are the ones a wall-clock test can
 * never reach on demand.
 *
 * The load-bearing rule is `wouldSend`: the gate is evaluated BEFORE the
 * recipient list, so decision.send can be true while the run would deliver
 * nothing. Reporting that as "ready" tells an admin to expect an email that
 * will not arrive -- which is the O-9 failure wearing a different hat.
 */
function queueReportGateExplain_(ctx) {
  ctx = ctx || {};
  const targetIso = ctx.targetIso || '(unknown)';
  const subs = Number(ctx.activeSubs) || 0;
  let explanation;
  if (ctx.reason === 'disabled') {
    explanation = ctx.installed
      ? 'The trigger is installed but QUEUE_REPORT_ENABLED is not "true", so every run returns '
        + 'immediately. Uninstall and re-install from this modal to reset both together.'
      : 'No trigger is installed and the enable flag is off. Click "Install daily trigger".';
  } else if (ctx.reason === 'outside-window') {
    explanation = 'It is ' + ctx.hour + ':00 Central, outside the ' + QUEUE_REPORT_WINDOW_START_HOUR
      + ':00–' + QUEUE_REPORT_WINDOW_END_HOUR + ':00 send window. Nothing sends until the next '
      + 'window opens.';
  } else if (ctx.reason === 'weekend' || ctx.reason === 'holiday') {
    explanation = 'Today is a ' + ctx.reason + ' — the report only sends on working days.';
  } else if (ctx.reason === 'already-sent') {
    explanation = 'The dedupe marker already claims ' + targetIso + ', so this day will not be sent '
      + 'again. NOTE: before the O-9 fix a run with NO subscribers also claimed this marker, so a '
      + 'date can be marked sent that nobody received. Use "Send to subscribers…" on the report to '
      + 'deliver it now; the next working day gets a fresh target and is unaffected.';
  } else if (ctx.reason === 'not-ready') {
    explanation = 'QCD Historical Data only reaches ' + (ctx.latestQcd || '(nothing)') + ', so '
      + targetIso + ' has not been imported + processed yet. The poll retries every '
      + QUEUE_REPORT_EVERY_MINUTES + ' min until the window closes at '
      + QUEUE_REPORT_WINDOW_END_HOUR + ':00 Central; after that the day is flagged MISSED and is '
      + 'NOT retried automatically.';
  } else if (!subs) {
    explanation = 'The gate would send, but there are no active Queue Report subscribers — so '
      + 'nothing would go out. Add a row under Report Subscribers.';
  } else {
    explanation = 'The gate would send ' + targetIso + ' to ' + subs + ' subscriber'
      + (subs === 1 ? '' : 's') + ' on the next poll.';
  }
  return { wouldSend: !!ctx.send && subs > 0, explanation: explanation };
}

/**
 * O-10: "why hasn't it sent?" -- evaluates the REAL gate against the REAL
 * clock, properties and sheet, and reports every input plus the decision.
 * READ-ONLY: sends nothing, writes no property, touches no marker.
 *
 * This exists because every non-send path in runDailyQueueReport_ returns
 * SILENTLY. `disabled`, `outside-window`, `weekend`, `holiday`, `already-sent`
 * and `not-ready` write nothing anywhere -- QUEUE_REPORT_LAST_RESULT is only
 * set on a send, a no-subscriber run, a failure, or the post-window MISSED
 * flag. So an admin whose report hasn't arrived has no way to ask WHY, and the
 * trigger entry point is `_`-suffixed, which hides it from the editor's Run
 * picker too (the compareDqeSources_ / runDqeParityCheck precedent). Every
 * hypothesis then costs a day to test, which is exactly how this played out.
 *
 * Returns the gate inputs, the decision, a plain-English explanation, and --
 * because it is the question that actually follows -- WHEN the next window is
 * and WHICH date that run will target.
 */
function runQueueReportGateCheck() {
  assertAdmin_();
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const targetIso = prevBusinessDayIso_(now);
  const todayIso = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  const hour = Number(Utilities.formatDate(now, TZ, 'H'));
  const lastSent = props.getProperty(QUEUE_REPORT_LAST_SENT_PROP) || '';
  const enabled = props.getProperty(QUEUE_REPORT_ENABLED_PROP) === 'true';
  const installed = queueReportTriggerInstalled_();
  // The readiness read is the only non-trivial cost here, and an admin asking
  // this question always wants to know it -- so unlike the trigger (which
  // short-circuits before it), always resolve it.
  const latestQcd = queueReportQcdLatestIso_();
  const subs = readQueueReportSubscribers_();
  const activeSubs = subs.filter(function (s) { return s.active && !s.duplicateRow; });

  const decision = queueReportGateDecision_({
    enabled: enabled, hour: hour, dow: now.getDay(),
    holiday: isCompanyHoliday_(todayIso),
    targetIso: targetIso, lastSent: lastSent, latestQcd: latestQcd,
  });

  const verdict = queueReportGateExplain_({
    reason: decision.reason, send: decision.send, installed: installed, hour: hour,
    targetIso: targetIso, latestQcd: latestQcd, activeSubs: activeSubs.length,
  });
  const explain = verdict.explanation;

  // "When does it next get a chance, and for which day?" -- walk forward to the
  // next moment the window + weekday gates both pass, and resolve THAT run's
  // target. Bounded; holidays are honored via the same helper the gate uses.
  let nextRun = null, nextTarget = null;
  const probe = new Date(now.getTime());
  if (hour >= QUEUE_REPORT_WINDOW_START_HOUR) probe.setDate(probe.getDate() + 1);
  for (let i = 0; i < 14; i++) {
    const iso = Utilities.formatDate(probe, TZ, 'yyyy-MM-dd');
    const dow = probe.getDay();
    if (dow !== 0 && dow !== 6 && !isCompanyHoliday_(iso)) {
      nextRun = iso;
      nextTarget = prevBusinessDayIso_(new Date(probe.getFullYear(), probe.getMonth(), probe.getDate(), 12));
      break;
    }
    probe.setDate(probe.getDate() + 1);
  }

  const out = {
    now: Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm') + ' Central',
    installed: installed, enabled: enabled,
    windowLabel: QUEUE_REPORT_WINDOW_START_HOUR + ':00–' + QUEUE_REPORT_WINDOW_END_HOUR + ':00 Central, weekdays',
    targetDate: targetIso, latestQcdDate: latestQcd, lastSentMarker: lastSent,
    activeSubscribers: activeSubs.length, totalSubscriberRows: subs.length,
    decision: decision.reason, wouldSend: verdict.wouldSend,
    explanation: explain,
    nextWindowDate: nextRun, nextWindowTarget: nextTarget,
    lastResult: props.getProperty(QUEUE_REPORT_LAST_RESULT_PROP) || '',
  };
  Logger.log('runQueueReportGateCheck: %s', JSON.stringify(out, null, 2));
  return out;
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

/**
 * QV-4: manual self-send from the all-dept report modal -- emails the CALLER
 * the report for the CURRENTLY DISPLAYED range. Read-only + MailApp (the
 * sendInsightsReportEmail precedent: caller-recipient, same auth as the
 * report it renders -- getQcdAllDepartments is open to every signed-in
 * manager/admin, so this is too). No preview banner, no subscriber list, no
 * interplay with the automated engine's dedupe marker. Range-safe: the email
 * builder reads data.dateLabel (its targetIso arg is only the label
 * fallback), and qcdAllDeptCachedData_ already serves multi-day blobs.
 */
function sendQcdAllDeptEmail(req) {
  const user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');
  const data = qcdAllDeptCachedData_(from, to).data;
  const email = Session.getActiveUser().getEmail();
  const label = data.dateLabel || (from === to ? from : (from + ' – ' + to));
  const html = buildQueueReportEmailHtml_(data, label, false);
  MailApp.sendEmail({ to: email, subject: 'Daily Call Queue Report — ' + label, htmlBody: html });
  Logger.log('sendQcdAllDeptEmail: %s..%s -> %s', from, to, email);
  return { to: email, dateLabel: label };
}

/**
 * QV-5: manual SUBSCRIBER blast from the modal (admin-only) -- sends ONE
 * day's report to the active subscriber list on demand, reusing
 * sendQueueReportForDate_'s per-recipient isolation (O-1).
 *
 * Dedupe-marker semantics (the one interplay with the automated engine): when
 * the sent day IS the gate's current target (previous business day) and at
 * least one recipient received it, the QUEUE_REPORT_LAST_SENT marker is
 * CLAIMED so the morning poll can't double-blast the same day (the O-1
 * partial-claim rule: delivered recipients are never re-blasted). Any other
 * date never touches the marker -- the automated engine only ever sends the
 * current target day, so there is nothing to dedupe against.
 * QUEUE_REPORT_LAST_RESULT is deliberately NOT written (it is the TRIGGER
 * run's diagnostic; a manual send must not repaint the Health outcome row).
 */
function sendQcdAllDeptToSubscribers(req) {
  assertAdmin_();
  const date = String((req && req.date) || '').trim();
  if (!isIsoDate_(date)) throw new Error('date must be YYYY-MM-DD.');
  const result = sendQueueReportForDate_(date, {});
  let markerClaimed = false;
  if (result.count > 0 && date === prevBusinessDayIso_(new Date())) {
    try {
      PropertiesService.getScriptProperties().setProperty(QUEUE_REPORT_LAST_SENT_PROP, date);
      markerClaimed = true;
    } catch (e) { /* best-effort -- worst case the morning poll re-sends */ }
  }
  Logger.log('sendQcdAllDeptToSubscribers: %s -> %s sent, %s failed, markerClaimed=%s',
    date, result.count, (result.failed || []).length, markerClaimed);
  return { date: date, count: result.count, failed: result.failed || [],
           markerClaimed: markerClaimed };
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
