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
    if (!pre.send) {
      // O-7: the window closed without a send for the target day (data landed
      // late, or never) -- surface it ONCE instead of silently moving on to
      // the next weekday's target.
      if (pre.reason === 'outside-window') queueReportFlagMissedDay_(props, now, targetIso);
      return;
    }

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
    const failed = result.failed || [];
    // O-1: marker discipline around per-recipient failures.
    //  - At least one send landed (or a clean no-recipients run): claim the
    //    date. The recipients who already got it must NEVER be re-blasted by
    //    the next poll, so partial failures are notified, not retried.
    //  - EVERY send failed (recipients existed, zero delivered): leave the
    //    marker unset so the next poll retries -- nobody received it, so a
    //    retry can't duplicate. Notify once per target date.
    if (result.count > 0 || !failed.length) {
      props.setProperty(QUEUE_REPORT_LAST_SENT_PROP, targetIso);
      props.setProperty(QUEUE_REPORT_LAST_RESULT_PROP,
        'Sent ' + targetIso + ' to ' + result.count + ' subscriber'
        + (result.count === 1 ? '' : 's')
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
  // Batch 1 item 2: reuse the 6h-TTL qcdAll cache the web report warms, so an
  // admin "Send me a preview" doesn't pay the full cold compute when the exact
  // (targetIso,targetIso) blob is already warm (and a preview warms it for the
  // next web open). Falls through to a fresh compute + cache when cold.
  const data = qcdAllDeptCachedData_(targetIso, targetIso).data;
  const recipients = opts.to
    ? [String(opts.to).trim()].filter(Boolean)
    : readQueueReportSubscribers_()
        .filter(function (s) { return s.active && !s.duplicateRow; })   // O-4: dupes never double-send
        .map(function (s) { return s.email; });

  if (!recipients.length) {
    Logger.log('sendQueueReportForDate_(%s): no active subscribers -- nothing sent.', targetIso);
    return { count: 0, to: [], failed: [] };
  }

  const subject = 'Daily Call Queue Report — ' + (data.dateLabel || targetIso);
  const html = buildQueueReportEmailHtml_(data, targetIso, !!opts.isPreview);
  // One send with the full list on `to` would expose every subscriber's
  // address to the others; send individually (small list, weekday-once).
  // O-1: per-recipient isolation -- one malformed hand-edited address or a
  // mid-list quota failure previously aborted the loop, so earlier
  // subscribers were re-blasted on every 30-min poll (marker never set)
  // while later ones never received the report at all. The single-address
  // preview path (opts.to) still throws so the admin sees the error in the
  // modal.
  const sentTo = [];
  const failed = [];
  recipients.forEach(function (addr) {
    try {
      MailApp.sendEmail({ to: addr, subject: subject, htmlBody: html });
      sentTo.push(addr);
    } catch (e) {
      if (opts.to) throw e;
      failed.push({ email: addr, error: (e && e.message) ? e.message : String(e) });
      Logger.log('sendQueueReportForDate_(%s): send to %s failed: %s', targetIso, addr, e);
    }
  });
  return { count: sentTo.length, to: sentTo, failed: failed };
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
      'MISSED ' + targetIso + ' — QCD data was not ready before the window closed ('
      + QUEUE_REPORT_WINDOW_END_HOUR + ':00 Central). Not retried automatically; use '
      + '"Send me a preview" to verify the data, or wait for the next weekday window. Flagged at ' + new Date());
    const to = getAdminEmails_().join(',');
    if (to) {
      MailApp.sendEmail({
        to: to,
        subject: '[Dashboard] Daily Call Queue Report was NOT sent for ' + targetIso,
        body: 'The ' + QUEUE_REPORT_WINDOW_START_HOUR + ':00–' + QUEUE_REPORT_WINDOW_END_HOUR
          + ':00 send window closed without the report going out for ' + targetIso
          + ' (QCD data was not ready in time, or the import did not run).\n\n'
          + 'It is NOT retried automatically. If the data has since landed, subscribers can be '
          + 'served manually, or the next weekday\'s report resumes normally.\n\nTime: ' + new Date(),
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
    };
    (childrenOf[d.dept] || []).forEach(function (c) {
      const ct = c.totals || {};
      t.calls += Number(ct.totalCalls) || 0;
      t.abnd  += Number(ct.abandoned)  || 0;
      t.viol  += Number(ct.violations) || 0;
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
  const kpi = function (label, value, bg, bd, labelColor, valColor, pad) {
    return '<td class="kpi" width="25%" valign="top" style="' + (pad || '') + '">'
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:10px;"><tr>'
      + '<td class="kpi-cell" style="padding:12px 14px;">'
      + '<div style="font:600 9px ' + sans + ';letter-spacing:0.8px;text-transform:uppercase;color:' + labelColor + ';">' + esc(label) + '</div>'
      + '<div style="font:bold 26px Arial,sans-serif;color:' + valColor + ';padding-top:2px;">' + esc(value) + '</div>'
      + '</td></tr></table></td>';
  };
  const abanOver = gPct >= 5;
  const kpiRow = '<tr><td style="padding:16px 26px 4px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
    + kpi('Company aban %', (gt.abandonedPctStr || gPct.toFixed(1) + '%'),
        abanOver ? C.badTile : C.neuTile, abanOver ? C.badTileB : C.neuTileB,
        abanOver ? '#8a5a44' : '#6b7580', abanOver ? C.bad : C.ink, 'padding-right:6px;')
    + kpi('Total calls', gTotal, C.neuTile, C.neuTileB, '#6b7580', C.ink, 'padding:0 3px;')
    + kpi('Queues in viol.', overCount, overCount > 0 ? C.badTile : C.neuTile, overCount > 0 ? C.badTileB : C.neuTileB,
        overCount > 0 ? '#8a5a44' : '#6b7580', overCount > 0 ? C.bad : C.ink, 'padding:0 3px;')
    + kpi('Answered', gAnsPct.toFixed(1) + '%', C.goodTile, C.goodTileB, '#3f7a5f', C.good, 'padding-left:6px;')
    + '</tr></table></td></tr>';

  // ---- table (worst-first sections) ----
  const violHdr = 'Viol (MTD)';
  let tbl = '<tr style="background:' + C.headbg + ';">'
    + '<td style="padding:9px 12px;font:600 9px ' + sans + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;">Queue</td>'
    + '<td align="right" style="padding:9px 8px;font:600 9px ' + sans + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;">Total</td>'
    + '<td width="150" style="padding:9px 8px;font:600 9px ' + sans + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;">Abandoned %</td>'
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
    const singleRow = rowDefs.length === 1;
    const bannerName = esc(d.dept)
      + (singleRow && rowDefs[0].q.queue !== d.dept
          ? ' <span style="font-weight:normal;font-size:11px;color:' + C.mut + ';">&middot; ' + esc(rowDefs[0].q.queue) + '</span>'
          : '');
    const stripBg = dt.color === C.bad ? C.badTile : (dt.color === C.watch ? C.alertBg : C.okBg);
    tbl += '<tr><td colspan="4" style="padding:0;border-top:1px solid ' + C.rowline + ';">'
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + stripBg + ';border-left:4px solid ' + dt.color + ';border-collapse:separate;"><tr>'
      +   '<td style="padding:8px 12px;font:bold 13px Arial,sans-serif;color:' + C.ink + ';">' + bannerName + '</td>'
      +   '<td align="right" style="padding:8px 12px;font:12px ' + sans + ';color:' + C.mut + ';white-space:nowrap;">'
      +     esc(dCalls) + ' calls &middot; <span style="' + (dPct >= 5 ? 'font-weight:bold;color:' + C.bad : 'color:' + C.ink) + ';">' + esc(dAbnd) + ' abandoned (' + esc(dPctStr) + ')</span>'
      +   '</td>'
      + '</tr></table></td></tr>';
    if (singleRow) return;   // the banner IS the row -- no duplicate numbers
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
        + '<td style="padding:6px 12px' + (rd.sub ? ' 6px 22px' : '') + ';font:12px ' + sans + ';color:' + C.ink + ';border-top:1px solid ' + C.rowline + ';">' + rowLbl + '</td>'
        + '<td align="right" style="padding:6px 8px;font:12px ' + sans + ';color:' + C.ink + ';border-top:1px solid ' + C.rowline + ';">' + esc(q.totalCalls) + '</td>'
        + '<td style="padding:6px 8px;border-top:1px solid ' + C.rowline + ';">' + barHtml(q, pctStr, pct >= 5 ? t.color : C.mut, pct >= 5) + '</td>'
        + '<td align="right" style="padding:6px 12px;font:' + (viol > 0 ? 'bold ' : '') + '12px ' + sans + ';color:' + (viol > 0 ? t.color : C.mut) + ';border-top:1px solid ' + C.rowline + ';">' + esc(String(viol)) + '</td>'
        + '</tr>';
    });
  });
  const gTier = tierOf(gPct, gViol);
  const gViolShow = violOf(gt);
  tbl += '<tr>'
    + '<td style="padding:9px 12px;font:bold 12px Arial,sans-serif;color:' + C.ink + ';border-top:2px solid ' + C.ink + ';">Company total</td>'
    + '<td align="right" style="padding:9px 8px;font:bold 12px ' + sans + ';color:' + C.ink + ';border-top:2px solid ' + C.ink + ';">' + esc(gTotal) + '</td>'
    + '<td style="padding:9px 8px;border-top:2px solid ' + C.ink + ';">' + barHtml({ totalCalls: gTotal, totalAnswered: gAns, abandonedPct: gPct }, (gt.abandonedPctStr || gPct.toFixed(1) + '%'), gPct >= 5 ? gTier.color : C.mut, true) + '</td>'
    + '<td align="right" style="padding:9px 12px;font:bold 12px ' + sans + ';color:' + (gViolShow > 0 ? gTier.color : C.mut) + ';border-top:2px solid ' + C.ink + ';">' + esc(gViolShow) + '</td>'
    + '</tr>';

  const tableBlock = depts.length
    ? ('<tr><td style="padding:18px 26px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ' + C.line + ';border-radius:10px;border-collapse:separate;overflow:hidden;">'
      + tbl + '</table>'
      + '<div style="font:10px ' + sans + ';color:#9aa6b2;padding:8px 2px 0;">Depts sorted worst-first &middot; bars show answered (green) vs abandoned (red) share of calls &middot; full columns (Ans/Longest/Avg) live in the dashboard &middot; Viol = each queue\u2019s 5%-violation days month-to-date (through this report\u2019s end date).</div>'
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
  const values = sheet.getRange(2, 1, lastRow - 1, QUEUE_REPORT_SUBSCRIBERS_HEADERS.length).getValues();
  const out = [];
  const seenEmail = {};   // O-4: OPS-9 discipline -- first-row-wins on hand-edited duplicates
  for (let i = 0; i < values.length; i++) {
    const email = String(values[i][0] || '').trim();
    if (!email) continue;
    const rawActive = values[i][1];
    const active = !(rawActive === false || rawActive === 'FALSE' || rawActive === 'false'
                   || rawActive === 0 || rawActive === 'no' || rawActive === 'No');
    const entry = { email: email, active: active, notes: String(values[i][2] || '').trim() };
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
