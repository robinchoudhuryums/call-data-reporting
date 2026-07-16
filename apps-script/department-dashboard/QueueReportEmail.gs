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
  // Batch 1 item 2: reuse the 6h-TTL qcdAll cache the web report warms, so an
  // admin "Send me a preview" doesn't pay the full cold compute when the exact
  // (targetIso,targetIso) blob is already warm (and a preview warms it for the
  // next web open). Falls through to a fresh compute + cache when cold.
  const data = qcdAllDeptCachedData_(targetIso, targetIso).data;
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
  const mono = "'Courier New',monospace";
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
  const barW = function (pct) { return Math.max(0, Math.min(100, Math.round((Number(pct) || 0) * 5))); };
  const barHtml = function (pct, pctStr, barColor, textColor, bold) {
    const w = barW(pct);
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
      + '<td style="padding:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.track + ';border-radius:5px;"><tr>'
      +   '<td width="' + w + '%" style="background:' + barColor + ';height:8px;line-height:8px;font-size:0;border-radius:5px;">&nbsp;</td><td>&nbsp;</td>'
      + '</tr></table></td>'
      + '<td width="42" align="right" style="font:' + (bold ? 'bold ' : '') + '11px ' + mono + ';color:' + textColor + ';padding-left:6px;">' + esc(pctStr) + '</td>'
      + '</tr></table>';
  };
  // A dept's report lines: its queues[] when present, else the dept total as one.
  const deptQueues = function (d) {
    if (d.queues && d.queues.length) return d.queues;
    const t = d.totals || {};
    return [{ queue: d.dept, totalCalls: t.totalCalls, abandonedPct: t.abandonedPct,
              abandonedPctStr: t.abandonedPctStr, violations: t.violations }];
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
  const ordered = depts.slice().sort(function (a, b) {
    const pa = Number((a.totals || {}).abandonedPct) || 0, pb = Number((b.totals || {}).abandonedPct) || 0;
    const va = Number((a.totals || {}).violations) || 0, vb = Number((b.totals || {}).violations) || 0;
    return (pb - pa) || (vb - va);
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

  // ---- verdict alert ----
  const alertHtml = overCount
    ? ('<tr><td style="padding:18px 26px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
      +   'style="background:' + C.alertBg + ';border:1px solid ' + C.alertB + ';border-radius:10px;"><tr>'
      + '<td style="padding:14px 16px;font:400 14px/1.5 Arial,sans-serif;color:' + C.alertInk + ';">'
      + '<strong>&#9873; ' + overCount + ' queue' + (overCount === 1 ? '' : 's') + ' over the 5% line.</strong><br>'
      + '<strong>' + esc(offenders[0].queue) + '</strong> hit <strong>' + esc(offenders[0].pctStr) + '</strong> &mdash; '
      +   esc(String(offenders[0].viol)) + ' violation' + (offenders[0].viol === 1 ? '' : 's') + '.'
      + (overCount > 1 ? ' <strong>' + esc(offenders[1].queue) + '</strong> hit <strong>' + esc(offenders[1].pctStr) + '</strong>.' : '')
      + ' All other queues held under 5%.'
      + '</td></tr></table></td></tr>')
    : ('<tr><td style="padding:18px 26px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
      +   'style="background:' + C.okBg + ';border:1px solid ' + C.okB + ';border-radius:10px;"><tr>'
      + '<td style="padding:14px 16px;font:400 14px/1.5 Arial,sans-serif;color:' + C.okInk + ';">'
      + '<strong>&#10003; All queues held under the 5% line.</strong></td></tr></table></td></tr>');

  // ---- KPI row ----
  const kpi = function (label, value, bg, bd, labelColor, valColor, pad) {
    return '<td class="kpi" width="25%" valign="top" style="' + (pad || '') + '">'
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:10px;"><tr>'
      + '<td class="kpi-cell" style="padding:12px 14px;">'
      + '<div style="font:9px ' + mono + ';letter-spacing:1px;text-transform:uppercase;color:' + labelColor + ';">' + esc(label) + '</div>'
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
  let tbl = '<tr style="background:' + C.headbg + ';">'
    + '<td style="padding:9px 12px;font:9px ' + mono + ';letter-spacing:1px;text-transform:uppercase;color:#8a97a4;">Queue</td>'
    + '<td align="right" style="padding:9px 8px;font:9px ' + mono + ';letter-spacing:1px;text-transform:uppercase;color:#8a97a4;">Total</td>'
    + '<td width="150" style="padding:9px 8px;font:9px ' + mono + ';letter-spacing:1px;text-transform:uppercase;color:#8a97a4;">Abandoned %</td>'
    + '<td align="right" style="padding:9px 12px;font:9px ' + mono + ';letter-spacing:1px;text-transform:uppercase;color:#8a97a4;">Viol</td></tr>';
  ordered.forEach(function (d) {
    const dt = tierOf((d.totals || {}).abandonedPct, (d.totals || {}).violations);
    tbl += '<tr><td colspan="4" style="padding:9px 12px 3px;font:bold 13px Arial,sans-serif;color:' + C.ink + ';border-top:1px solid ' + C.rowline + ';">'
      + esc(d.dept) + ' &nbsp;<span style="font:10px ' + mono + ';color:' + dt.color + ';">' + dt.label + '</span></td></tr>';
    deptQueues(d).forEach(function (q) {
      const pct = Number(q.abandonedPct) || 0;
      const t = tierOf(pct, q.violations);
      const pctStr = q.abandonedPctStr || pct.toFixed(1) + '%';
      const viol = Number(q.violations) || 0;
      tbl += '<tr>'
        + '<td style="padding:6px 12px;font:12px ' + mono + ';color:' + C.ink + ';border-top:1px solid ' + C.rowline + ';">' + esc(q.queue) + '</td>'
        + '<td align="right" style="padding:6px 8px;font:12px ' + mono + ';color:' + C.ink + ';border-top:1px solid ' + C.rowline + ';">' + esc(q.totalCalls) + '</td>'
        + '<td style="padding:6px 8px;border-top:1px solid ' + C.rowline + ';">' + barHtml(pct, pctStr, t.color, pct >= 5 ? t.color : C.mut, pct >= 5) + '</td>'
        + '<td align="right" style="padding:6px 12px;font:' + (viol > 0 ? 'bold ' : '') + '12px ' + mono + ';color:' + (viol > 0 ? t.color : C.mut) + ';border-top:1px solid ' + C.rowline + ';">' + esc(String(viol)) + '</td>'
        + '</tr>';
    });
  });
  const gTier = tierOf(gPct, gViol);
  tbl += '<tr>'
    + '<td style="padding:9px 12px;font:bold 12px Arial,sans-serif;color:' + C.ink + ';border-top:2px solid ' + C.ink + ';">Company total</td>'
    + '<td align="right" style="padding:9px 8px;font:bold 12px ' + mono + ';color:' + C.ink + ';border-top:2px solid ' + C.ink + ';">' + esc(gTotal) + '</td>'
    + '<td style="padding:9px 8px;border-top:2px solid ' + C.ink + ';">' + barHtml(gPct, (gt.abandonedPctStr || gPct.toFixed(1) + '%'), gTier.color, gPct >= 5 ? gTier.color : C.mut, true) + '</td>'
    + '<td align="right" style="padding:9px 12px;font:bold 12px ' + mono + ';color:' + (gViol > 0 ? gTier.color : C.mut) + ';border-top:2px solid ' + C.ink + ';">' + esc(gViol) + '</td>'
    + '</tr>';

  const tableBlock = depts.length
    ? ('<tr><td style="padding:18px 26px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ' + C.line + ';border-radius:10px;border-collapse:separate;overflow:hidden;">'
      + tbl + '</table>'
      + '<div style="font:10px ' + mono + ';color:#9aa6b2;padding:8px 2px 0;">Depts sorted worst-first &middot; bars scale to the 5% threshold &middot; full columns (Ans/Longest/Avg) live in the dashboard.</div>'
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
    +   '<div style="font:11px ' + mono + ';letter-spacing:2px;text-transform:uppercase;color:#8a97a4;">Call Data &middot; Daily report</div>'
    +   '<div style="font:bold 23px Arial,sans-serif;color:' + C.ink + ';letter-spacing:-0.4px;padding-top:4px;">Daily Call Queue Report</div>'
    +   '<div style="font:400 13px Arial,sans-serif;color:' + C.mut + ';padding-top:3px;">' + dateLbl + ' &middot; all departments</div>'
    + '</td></tr>'
    + previewBar
    + alertHtml
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
