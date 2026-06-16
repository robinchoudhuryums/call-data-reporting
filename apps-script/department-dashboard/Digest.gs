/**
 * Manager Digest emails.
 *
 * Sheet-driven subscription list ("Digest Config") + two scheduled
 * triggers (daily, weekly) that compute a dept's recent KPIs and
 * email a small HTML summary to each subscriber. Modeled on
 * Alerts.gs: same admin-gated UI controls, similar schema-on-sheet
 * pattern, same install/uninstall trigger lifecycle.
 *
 * Public entries (callable via google.script.run; all admin-only):
 *   getDigestsInit()
 *     -> { config: [{ email, department, cadence, format, active, notes }],
 *          trigger: { daily, weekly, monthly },
 *          spreadsheetUrl }
 *   sendPreviewDigest({ email, department, cadence, format? })
 *     -> { to } (sends one digest to the active admin so they can
 *                 verify what subscribers will receive)
 *   installDigestTriggers()   -> { daily: true, weekly: true, monthly: true }
 *   uninstallDigestTriggers() -> { daily: false, weekly: false, monthly: false }
 *
 * Trigger entry points (called by time-based triggers, never via
 * google.script.run thanks to the trailing underscore):
 *   runDailyDigests_()
 *   runWeeklyDigests_()
 *   runMonthlyDigests_()
 *
 * Date windows:
 *   - Daily digest covers the immediately-preceding calendar day,
 *     skipping weekends (Sat/Sun fire returns early; Monday's
 *     digest covers Friday).
 *   - Weekly digest covers Mon-Fri of the prior week, sent Monday
 *     morning.
 *   - Monthly digest covers the prior calendar month, sent on the
 *     1st (ScriptApp onMonthDay trigger).
 *
 * Cadence values in the sheet: 'daily', 'weekly', or 'monthly'
 * (case-insensitive, trimmed). Anything else is treated as inactive.
 *
 * Format values (col F; appended non-destructively like Alert
 * Config's Skip Dates -- pre-E8-style precedent): 'summary' (default;
 * the KPI-tile digest + WoW callout) or 'insights' (the
 * Insights-report digest: team rollup deltas + a per-agent delta
 * table, computed by the SAME computeInsights_ the Insights modal
 * uses, vs a cadence-appropriate prior window -- daily compares to
 * the INV-28 auto-adjacent day, weekly to the previous Mon-Fri,
 * monthly to the previous calendar month).
 */

const DIGEST_DAILY_TRIGGER_HOUR   = 8;   // 8 AM script-TZ
const DIGEST_WEEKLY_TRIGGER_HOUR  = 8;
const DIGEST_MONTHLY_TRIGGER_HOUR = 8;   // 1st of the month, 8 AM

function getDigestsInit() {
  assertAdmin_();
  return {
    config:         readDigestConfig_(),
    trigger:        getDigestTriggerStatus_(),
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + getSpreadsheetId_() + '/edit',
  };
}

/**
 * Sends a one-shot preview digest to the active admin (NOT to the
 * subscriber's address). Lets the admin verify what a subscriber
 * will see. The supplied email/department/cadence describe the
 * digest content; the recipient is always the admin.
 */
function sendPreviewDigest(req) {
  assertAdmin_();
  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  if (getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }
  const cadence = normalizeCadence_(String((req && req.cadence) || 'daily'));
  if (!cadence) throw new Error('Cadence must be "daily", "weekly", or "monthly".');
  const format = normalizeFormat_(String((req && req.format) || 'summary'));

  const window = digestWindowFor_(cadence, new Date());
  if (!window) throw new Error('No window available for cadence ' + cadence);

  const adminEmail = Session.getActiveUser().getEmail();
  sendDigestEmail_({
    to:         adminEmail,
    dept:       dept,
    cadence:    cadence,
    format:     format,
    fromIso:    window.fromIso,
    toIso:      window.toIso,
    isPreview:  true,
    previewFor: String((req && req.email) || ''),
  });
  return { to: adminEmail };
}

function installDigestTriggers() {
  assertAdmin_();
  uninstallDigestTriggers_();
  ScriptApp.newTrigger('runDailyDigests_')
    .timeBased().everyDays(1).atHour(DIGEST_DAILY_TRIGGER_HOUR).create();
  ScriptApp.newTrigger('runWeeklyDigests_')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(DIGEST_WEEKLY_TRIGGER_HOUR).create();
  ScriptApp.newTrigger('runMonthlyDigests_')
    .timeBased().onMonthDay(1).atHour(DIGEST_MONTHLY_TRIGGER_HOUR).create();
  return getDigestTriggerStatus_();
}

function uninstallDigestTriggers() {
  assertAdmin_();
  uninstallDigestTriggers_();
  return getDigestTriggerStatus_();
}

// -- Trigger entry points (underscore = not RPC-callable) ----------

function runDailyDigests_() {
  try {
    const now = new Date();
    // Check the DATA WINDOW date's day-of-week, not today's.
    // On Monday (today=1), yesterday=Sunday (dow=0) → skip, so
    // Friday data doesn't get lost. Matches runDailyAlerts_ logic.
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    const dow = yesterday.getDay();   // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) {
      Logger.log('runDailyDigests_: skipping weekend data date (%s)', yesterday);
      return;
    }
    sendDigestsForCadence_('daily');
  } catch (e) {
    Logger.log('runDailyDigests_ failed: %s', e);
    notifyDigestFailure_('daily', e);
  }
}

function runWeeklyDigests_() {
  try {
    sendDigestsForCadence_('weekly');
  } catch (e) {
    Logger.log('runWeeklyDigests_ failed: %s', e);
    notifyDigestFailure_('weekly', e);
  }
}

function runMonthlyDigests_() {
  try {
    sendDigestsForCadence_('monthly');
  } catch (e) {
    Logger.log('runMonthlyDigests_ failed: %s', e);
    notifyDigestFailure_('monthly', e);
  }
}

// -- Engine --------------------------------------------------------

function sendDigestsForCadence_(cadence) {
  const cfg = readDigestConfig_();
  const window = digestWindowFor_(cadence, new Date());
  if (!window) return;
  const failures = [];
  cfg.forEach(function (entry) {
    if (!entry.active) return;
    if (entry.cadence !== cadence) return;
    try {
      sendDigestEmail_({
        to:        entry.email,
        dept:      entry.department,
        cadence:   cadence,
        format:    entry.format,
        fromIso:   window.fromIso,
        toIso:     window.toIso,
        isPreview: false,
      });
    } catch (e) {
      // Per-subscriber failure shouldn't stop the rest. The outer
      // catch in runDaily/Weekly/MonthlyDigests_ only fires on
      // cfg-read / window-compute style failures.
      const msg = (e && e.message) ? e.message : String(e);
      Logger.log('sendDigestEmail_ failed for %s: %s', entry.email, msg);
      failures.push({ email: entry.email, dept: entry.department, error: msg });
    }
  });
  // A swallowed per-subscriber failure was previously only in the log, so a
  // chronically failing recipient (bad address, per-recipient quota) stayed
  // invisible. Surface a single best-effort summary to admins; the run still
  // succeeds for the recipients that did go out.
  if (failures.length) {
    try { notifyDigestRecipientFailures_(cadence, failures); }
    catch (notifyErr) { Logger.log('notifyDigestRecipientFailures_ failed: %s', notifyErr); }
  }
}

/**
 * Best-effort admin notification listing the recipients whose digest send
 * threw during a cadence run (see sendDigestsForCadence_). Separate from
 * notifyDigestFailure_, which fires when the whole run aborts (cfg read /
 * window compute). Never throws.
 */
function notifyDigestRecipientFailures_(cadence, failures) {
  const to = getAdminEmails_().join(',');
  if (!to) return;
  const lines = failures.map(function (f) {
    return '- ' + f.email + ' (' + (f.dept || '?') + '): ' + f.error;
  }).join('\n');
  MailApp.sendEmail({
    to:      to,
    subject: '[Dashboard] ' + cadence + ' digest: ' + failures.length
             + ' recipient' + (failures.length === 1 ? '' : 's') + ' failed to send',
    body:    'These ' + cadence + ' digest sends failed (other recipients were '
             + 'unaffected, and the run otherwise completed):\n\n' + lines
             + '\n\nTime: ' + new Date(),
  });
}

/**
 * Computes dept totals for [fromIso, toIso] using the same summary
 * shape getDepartmentSummary returns. Direct private-helper call
 * because the trigger context has no Session.getActiveUser identity
 * to feed the public function's auth gates.
 */
function computeDigestStats_(dept, fromIso, toIso) {
  const summary = computeSummary_(dept, fromIso, toIso, 'roster');
  return {
    rows:   (summary.rows || []).length,
    totals: summary.totals || {},
    meta:   summary.meta   || {},
  };
}

/**
 * Week-over-week "driver" narrative for the digest (#11). Reuses the
 * Overview's tested INV-48 logic (computeWowDelta_ + computeWowDriver_)
 * by building the `stats` shape those expect -- dept-level
 * `trendByDate` ({rung, answered}) + per-agent `agentTrendByDate`
 * ({answered, missed}) -- over the 14-day window ending on `anchorIso`
 * (the digest window's end). computeWowDelta_ then carves the 7-day
 * current vs prior-7 windows internally and attaches `.driver` when
 * |deltaPct| >= WOW_DRIVER_THRESHOLD.
 *
 * Roster-scoped (rosterSet gate) so floaters (INV-53) and queue
 * sentinels (INV-23) never skew the dept's attribution -- matching
 * computeDigestStats_'s 'roster' scope. Best-effort: any failure (or
 * a quiet/low-activity dept) returns null and the digest renders
 * without the narrative.
 *
 * Returns the computeWowDelta_ shape: { curPct, prevPct, deltaPct,
 * driver? } or null.
 */
function computeDigestWowDriver_(dept, anchorIso) {
  try {
    const roster = getRosterForDepartment_(dept);
    const rosterSet = {};
    for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
    if (!sheet) return null;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;
    const ssTZ = ss.getSpreadsheetTimeZone();

    // 14-day window ending on the anchor (7 current + 7 prior), the
    // same span computeWowDelta_ walks back from its anchor date.
    const anchorObj = parseIsoNoon_(anchorIso);
    const windowStartIso = Utilities.formatDate(
      new Date(anchorObj.getTime() - 13 * 86400000), TZ, 'yyyy-MM-dd');

    const numCols = HISTORICAL_COLS.TOTAL_ANSWERED;   // need rung/missed/answered
    const values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

    const trendByDate = {};        // iso -> { rung, answered }
    const agentTrendByDate = {};   // agent -> iso -> { answered, missed }
    for (let i = 0; i < values.length; i++) {
      const r = values[i];
      const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
      if (!dateIso || dateIso < windowStartIso || dateIso > anchorIso) continue;
      const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
      if (!agent) continue;
      if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;   // INV-23 sentinels
      if (!rosterSet[agent]) continue;                                // roster-only (INV-53)
      const rung     = Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
      const missed   = Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
      const answered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;

      let t = trendByDate[dateIso];
      if (!t) t = trendByDate[dateIso] = { rung: 0, answered: 0 };
      t.rung += rung; t.answered += answered;

      let a = agentTrendByDate[agent];
      if (!a) a = agentTrendByDate[agent] = {};
      let b = a[dateIso];
      if (!b) b = a[dateIso] = { answered: 0, missed: 0 };
      b.answered += answered; b.missed += missed;
    }

    return computeWowDelta_(
      { trendByDate: trendByDate, agentTrendByDate: agentTrendByDate }, anchorIso);
  } catch (e) {
    Logger.log('computeDigestWowDriver_ failed: %s', e);
    return null;
  }
}

function sendDigestEmail_(opts) {
  const dept    = opts.dept;
  const to      = String(opts.to || '').trim();
  if (!to) throw new Error('Digest recipient is empty.');
  const format  = normalizeFormat_(opts.format);
  const rangeLabel = opts.fromIso === opts.toIso
    ? opts.fromIso
    : (opts.fromIso + ' – ' + opts.toIso);

  // Core content per Format: 'summary' = KPI tiles + the WoW driver
  // callout (the original digest); 'insights' = the Insights-report
  // rollup + per-agent delta table.
  let coreHtml;
  if (format === 'insights') {
    coreHtml = digestInsightsHtml_(dept, opts.fromIso, opts.toIso, opts.cadence);
  } else {
    coreHtml = digestSummaryHtml_(dept, opts.fromIso, opts.toIso);
  }

  // Deep link into the dashboard pre-primed to this digest's exact view
  // (the state-in-URL share format): the Insights report with this
  // window, the full roster selected, and -- for weekly/monthly -- the
  // cadence-appropriate custom prior window. The intimidation hurdle is
  // highest at an empty report form; this link skips it entirely. Falls
  // back to the bare dashboard URL ('' when DASHBOARD_URL is unset, in
  // which case no button renders -- same degradation as before).
  const deepLink = digestDeepLink_(dept, opts.fromIso, opts.toIso, opts.cadence);
  const dashboardUrl = deepLink
    || PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL') || '';
  const linkLabel = deepLink ? 'See the full breakdown in the dashboard' : 'Open Dashboard';

  const previewBanner = opts.isPreview
    ? ('<div style="background:#FEF3C7;border-left:4px solid #D97706;padding:10px 14px;border-radius:4px;margin-bottom:12px;">'
      +   '<strong style="color:#92400E;">Preview only.</strong> '
      +   '<span style="color:#7C2D12;">This is what '
      +   escapeHtmlServer_(opts.previewFor || '(the subscriber)')
      +   ' would receive for the '
      +   escapeHtmlServer_(opts.cadence) + ' ' + escapeHtmlServer_(format) + ' digest on '
      +   escapeHtmlServer_(rangeLabel) + '.</span>'
      + '</div>')
    : '';

  const subject = (opts.isPreview ? '[Preview] ' : '')
    + 'Dashboard digest — ' + dept + ' — ' + rangeLabel;

  const htmlBody =
      '<div style="font-family: sans-serif; color: #1f2937; max-width: 720px;">'
    +   previewBanner
    +   '<div style="background: #EFF6FF; border-left: 4px solid #1d4ed8; padding: 16px 20px; border-radius: 4px;">'
    +     '<h2 style="margin: 0 0 4px; color: #1e3a8a; font-size: 18px;">'
    +       escapeHtmlServer_(dept) + ' digest'
    +     '</h2>'
    +     '<div style="color: #1e3a8a; font-size: 13px;">' + escapeHtmlServer_(rangeLabel) + '</div>'
    +   '</div>'
    +   coreHtml
    +   (dashboardUrl
        ? '<div style="margin-top: 16px;"><a href="' + escapeHtmlServer_(dashboardUrl) + '" style="display: inline-block; background: #1d4ed8; color: #fff; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600;">' + escapeHtmlServer_(linkLabel) + '</a></div>'
        : '')
    +   '<div style="margin-top: 24px; font-size: 11px; color: #9ca3af;">'
    +     'Sent by the Department Dashboard digest engine. To stop receiving these, ask an admin to remove your row from the "Digest Config" sheet (or set Active=FALSE).'
    +   '</div>'
    + '</div>';

  MailApp.sendEmail({
    to:       to,
    subject:  subject,
    htmlBody: htmlBody,
  });
}

/**
 * The original 'summary' digest body: 4 KPI tiles + the WoW driver
 * callout (#11). Extracted unchanged from sendDigestEmail_ when the
 * Format column landed, so the summary path stays byte-identical.
 */
function digestSummaryHtml_(dept, fromIso, toIso) {
  const stats   = computeDigestStats_(dept, fromIso, toIso);
  const totals  = stats.totals || {};
  const pct = (Number(totals.totalRung) || 0) > 0
    ? ((Number(totals.totalAnswered) || 0) / Number(totals.totalRung)) * 100
    : 0;
  const pctStr     = pct.toFixed(1) + '%';
  const rungStr    = String(Number(totals.totalRung)     || 0);
  const ansStr     = String(Number(totals.totalAnswered) || 0);
  const missedStr  = String(Number(totals.totalMissed)   || 0);
  const attStr     = digestFormatHms_(Number(totals.attSeconds) || 0);

  // WoW "driver" narrative (#11): which agent's net answered/missed
  // change most explains the dept's week-over-week answer-rate shift.
  // Anchored on the digest window's end date; best-effort (null on a
  // quiet dept or any error -> no callout rendered).
  const wow = computeDigestWowDriver_(dept, toIso);
  let wowNarrative = digestWowNarrative_(wow);
  // Answer-first fallback: on a quiet week (no notable WoW driver) the
  // digest still ends with one plain-language takeaway, never bare tiles.
  if (!wowNarrative && Number(totals.totalRung) > 0) {
    wowNarrative =
        '<div style="margin:16px 0;padding:12px 16px;background:#EFF6FF;border-left:3px solid #1d4ed8;'
      +   'border-radius:4px;font-size:14px;color:#1f2937;line-height:1.5;">'
      +   'The team answered ' + escapeHtmlServer_(ansStr) + ' of ' + escapeHtmlServer_(rungStr)
      +   ' rung calls (' + escapeHtmlServer_(pctStr) + ') across ' + stats.rows + ' agent'
      +   (stats.rows === 1 ? '' : 's') + ' — no notable week-over-week shift.'
      + '</div>';
  }

  return '<div style="margin: 20px 0; padding: 20px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">'
    +     '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">'
    +       digestStatTile_('Answer rate', pctStr)
    +       digestStatTile_('Rung',         rungStr)
    +       digestStatTile_('Answered',     ansStr)
    +       digestStatTile_('Missed',       missedStr)
    +     '</div>'
    +     '<div style="margin-top:12px;font-size:13px;color:#6b7280;">'
    +       'Avg talk time: <strong>' + escapeHtmlServer_(attStr) + '</strong>'
    +       ' · ' + stats.rows + ' agent' + (stats.rows === 1 ? '' : 's') + ' with activity'
    +     '</div>'
    +   '</div>'
    +   wowNarrative;
}

/**
 * Cadence-appropriate prior window for the 'insights' digest format.
 * Daily -> null (computeInsights_'s INV-28 auto-adjacent default is
 * exactly "the previous day"). Weekly -> the window shifted back 7
 * days (previous Mon-Fri; the raw INV-28 window for a Mon-Fri range
 * would be the preceding Wed-Sun, comparing a workweek against mostly
 * weekend). Monthly -> the previous calendar month (lengths may
 * differ by up to 3 days -- below the INV-35 1.2x mismatch bar).
 */
function digestInsightsPrior_(cadence, fromIso, toIso) {
  if (cadence === 'weekly') {
    const shift = function (iso) {
      const p = iso.split('-');
      const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - 7, 12);
      return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
    };
    return { from: shift(fromIso), to: shift(toIso) };
  }
  if (cadence === 'monthly') {
    const p = fromIso.split('-');
    const first = new Date(Number(p[0]), Number(p[1]) - 2, 1, 12);
    const last  = new Date(Number(p[0]), Number(p[1]) - 1, 0, 12);
    return {
      from: Utilities.formatDate(first, TZ, 'yyyy-MM-dd'),
      to:   Utilities.formatDate(last,  TZ, 'yyyy-MM-dd'),
    };
  }
  return null;   // daily: INV-28 auto-adjacent = the previous day
}

/**
 * Builds the state-in-URL deep link this digest's button targets: the
 * Insights report primed with the digest window, the dept's full
 * roster selected, and (weekly/monthly) the cadence-appropriate custom
 * prior window -- the same `#/route?from=...&agents=a|b` format the
 * dashboard's SHARE_STATE_ registry reads. Returns '' when
 * DASHBOARD_URL is unset (caller falls back to the old generic link).
 */
function digestDeepLink_(dept, fromIso, toIso, cadence) {
  const base = String(PropertiesService.getScriptProperties()
    .getProperty('DASHBOARD_URL') || '').trim();
  if (!base) return '';
  const roster = getRosterForDepartment_(dept);
  const parts = ['from=' + fromIso, 'to=' + toIso];
  if (roster.names.length) {
    parts.push('agents=' + encodeURIComponent(roster.names.join('|')));
  }
  const prior = digestInsightsPrior_(cadence, fromIso, toIso);
  if (prior) {
    parts.push('mode=custom', 'pfrom=' + prior.from, 'pto=' + prior.to);
  }
  return base.split('#')[0] + '#/report/insights?' + parts.join('&');
}

/**
 * One narrated takeaway sentence from an Insights teamStats block --
 * the digest's answer-first line. Empty string on a no-activity window.
 */
function digestTakeaway_(teamStats) {
  const t = teamStats || {};
  const rung = (t.rung && t.rung.val) || 0;
  const prevRung = (t.rung && t.rung.prev) || 0;
  if (!rung && !prevRung) return '';
  const pct = t.pct || {};
  const dp = Number(pct.deltaPct || 0);
  let phrase = '';
  if (prevRung > 0) {
    phrase = Math.abs(dp) < 0.05
      ? ', about the same as the prior period'
      : ', ' + (dp > 0 ? 'up ' : 'down ') + Math.abs(dp).toFixed(1) + ' points vs the prior period';
  }
  return 'The team answered ' + ((t.answered && t.answered.formatted) || 0)
       + ' of ' + ((t.rung && t.rung.formatted) || 0) + ' rung calls ('
       + ((pct.formatted) || '0%') + phrase + ').';
}

/** Inline-styled delta span for the insights digest (sage up / amber down by valence). */
function digestDeltaHtml_(stat, valence) {
  const s = stat || { deltaPct: 0, type: 'volume' };
  const dp = Number(s.deltaPct || 0);
  if (Math.abs(dp) < 0.05) {
    return '<span style="color:#9ca3af;font-size:11px;">&ndash;</span>';
  }
  let color = '#6b7280';                                   // neutral grey
  if (valence === 'pos') color = dp > 0 ? '#059669' : '#D97706';
  else if (valence === 'neg') color = dp > 0 ? '#D97706' : '#059669';
  const arrow = dp > 0 ? '&#9650;' : '&#9660;';
  const suffix = s.type === 'pctPoints' ? ' pts' : '%';
  return '<span style="color:' + color + ';font-size:11px;font-weight:700;white-space:nowrap;">'
       + arrow + ' ' + Math.abs(dp).toFixed(1) + suffix + '</span>';
}

/**
 * The 'insights' digest body: the dept's full-roster Insights run
 * (team rollup deltas + a per-agent delta table) vs the
 * cadence-appropriate prior window. Reuses computeInsights_ verbatim
 * -- the SAME aggregation the Insights modal serves -- with the full
 * roster as the selection, so floaters are naturally excluded
 * (roster-only, matching computeDigestStats_'s 'roster' scope).
 * Returns an HTML fragment (no MailApp), so it's unit-testable.
 */
function digestInsightsHtml_(dept, fromIso, toIso, cadence) {
  const roster = getRosterForDepartment_(dept);
  if (!roster.names.length) {
    return '<div style="margin:20px 0;padding:16px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;color:#6b7280;font-size:13px;">'
         + 'No roster found for ' + escapeHtmlServer_(dept) + ' — nothing to report.'
         + '</div>';
  }
  const prior = digestInsightsPrior_(cadence, fromIso, toIso);
  const data = computeInsights_(dept, fromIso, toIso, roster.names.slice(), roster,
                                prior ? prior.from : '', prior ? prior.to : '');
  const t = data.teamStats || {};

  // Answer-first takeaway line before any tile (anti-intimidation).
  const takeaway = digestTakeaway_(t);
  const takeawayHtml = takeaway
    ? '<div style="margin:16px 0 0;padding:12px 16px;background:#EFF6FF;border-left:3px solid #1d4ed8;'
      + 'border-radius:4px;font-size:14px;color:#1f2937;line-height:1.5;">'
      + escapeHtmlServer_(takeaway) + '</div>'
    : '';

  const tile = function (label, stat, valence) {
    return '<td style="padding:10px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;text-align:center;">'
      + '<div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;">'
      +   escapeHtmlServer_(label) + '</div>'
      + '<div style="font-size:18px;color:#111827;font-weight:700;margin-top:2px;">'
      +   escapeHtmlServer_(String((stat && stat.formatted) || '-')) + '</div>'
      + '<div style="margin-top:2px;">' + digestDeltaHtml_(stat, valence) + '</div>'
      + '</td>';
  };

  const agentRows = (data.agentData || []).map(function (a) {
    const m = a.metrics || {};
    const cell = function (stat, valence) {
      return '<td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;white-space:nowrap;">'
        + escapeHtmlServer_(String((stat && stat.formatted) || '-'))
        + ' ' + digestDeltaHtml_(stat, valence)
        + '</td>';
    };
    return '<tr>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;">' + escapeHtmlServer_(a.name) + '</td>'
      + cell(m.rung, 'pos') + cell(m.missed, 'neg') + cell(m.answered, 'pos')
      + cell(m.pct, 'pos') + cell(m.att, 'neu')
      + '</tr>';
  }).join('');

  return takeawayHtml
    + '<div style="margin: 20px 0; padding: 20px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">'
    +   '<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:8px;">'
    +     'Department rollup &middot; vs ' + escapeHtmlServer_(data.priorDateLabel || 'prior period')
    +   '</div>'
    +   '<table style="border-collapse:separate;border-spacing:6px;width:100%;"><tr>'
    +     tile('Rung', t.rung, 'pos') + tile('Missed', t.missed, 'neg')
    +     tile('Answered', t.answered, 'pos') + tile('% Answered', t.pct, 'pos')
    +     tile('Avg ATT', t.att, 'neu')
    +   '</tr></table>'
    + '</div>'
    + '<div style="margin: 16px 0; padding: 20px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;">'
    +   '<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:8px;">'
    +     'Per-agent &middot; current value with change vs the prior window'
    +   '</div>'
    +   '<table style="border-collapse:collapse;width:100%;font-size:13px;">'
    +     '<thead><tr style="background:#f9fafb;">'
    +       '<th style="text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;">Agent</th>'
    +       '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #e5e7eb;">Rung</th>'
    +       '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #e5e7eb;">Missed</th>'
    +       '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #e5e7eb;">Answered</th>'
    +       '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #e5e7eb;">% Ans</th>'
    +       '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #e5e7eb;">ATT</th>'
    +     '</tr></thead>'
    +     '<tbody>' + (agentRows
            || '<tr><td colspan="6" style="padding:8px 10px;color:#6b7280;">No agent activity in this window.</td></tr>')
    +     '</tbody>'
    +   '</table>'
    + '</div>';
}

/**
 * Renders the WoW "driver" callout (#11) from a computeDigestWowDriver_
 * result. Empty string when there's no notable shift / no attributable
 * agent (wow null or wow.driver absent) -- the digest then shows just
 * the KPI tiles, as before. Sage callout for an answer-rate gain,
 * amber for a drop, mirroring the dashboard's good/warn valence.
 */
function digestWowNarrative_(wow) {
  if (!wow || !wow.driver) return '';
  const d = wow.driver;
  const up = (Number(wow.deltaPct) || 0) > 0;
  const arrow = up ? '▲' : '▼';                 // ▲ / ▼
  const deltaTxt = (wow.deltaPct > 0 ? '+' : '') + Number(wow.deltaPct).toFixed(1) + ' pts';
  const metricWord = d.metric === 'missed' ? 'missed' : 'answered';
  const absDelta = Math.abs(Number(d.delta) || 0);
  const moreFewer = (Number(d.delta) || 0) >= 0 ? 'more' : 'fewer';
  const sentence =
      escapeHtmlServer_(d.agent) + ' ' + metricWord + ' ' + absDelta + ' ' + moreFewer
    + ' call' + (absDelta === 1 ? '' : 's')
    + ' over the last 7 days (' + d.cur + ' vs ' + d.prev + ' the 7 days before)'
    + ' — the biggest driver of the department’s '
    + (up ? 'answer-rate gain' : 'answer-rate drop') + '.';

  const c = up
    ? { bg: '#ECFDF5', border: '#059669', head: '#065F46', body: '#064E3B' }
    : { bg: '#FFFBEB', border: '#D97706', head: '#92400E', body: '#7C2D12' };

  return '<div style="margin:16px 0;padding:12px 16px;background:' + c.bg
       +   ';border-left:4px solid ' + c.border + ';border-radius:4px;">'
       +   '<div style="font-size:11px;font-weight:700;text-transform:uppercase;'
       +     'letter-spacing:0.05em;color:' + c.head + ';">'
       +     'What changed · answer rate ' + arrow + ' '
       +     escapeHtmlServer_(deltaTxt) + ' week-over-week'
       +   '</div>'
       +   '<div style="font-size:13px;color:' + c.body + ';margin-top:4px;line-height:1.4;">'
       +     sentence
       +   '</div>'
       + '</div>';
}

function digestStatTile_(label, value) {
  return '<div style="padding:10px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;text-align:center;">'
       +   '<div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;">'
       +     escapeHtmlServer_(label)
       +   '</div>'
       +   '<div style="font-size:20px;color:#111827;font-weight:700;margin-top:2px;">'
       +     escapeHtmlServer_(value)
       +   '</div>'
       + '</div>';
}

function digestFormatHms_(totalSeconds) {
  totalSeconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return h + ':' + pad(m) + ':' + pad(s);
}

// -- Config / triggers --------------------------------------------

function readDigestConfig_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.DIGEST_CONFIG);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  // Width covers the Format column (col F, appended at the end of the
  // row -- the Alert Config Skip Dates precedent). Pre-existing sheets
  // keep their 5-col header; col F reads back as '' and normalizes to
  // 'summary', so behavior is unchanged until an admin sets a value.
  const values = sheet.getRange(2, 1, lastRow - 1, DIGEST_CONFIG_HEADERS.length).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const email   = String(values[i][0] || '').trim();
    const dept    = String(values[i][1] || '').trim();
    if (!email || !dept) continue;
    const cadence = normalizeCadence_(String(values[i][2] || ''));
    if (!cadence) continue;
    const rawActive = values[i][3];
    const active = !(rawActive === false || rawActive === 'FALSE' || rawActive === 'false'
                  || rawActive === 0 || rawActive === 'no' || rawActive === 'No');
    out.push({
      email:      email,
      department: dept,
      cadence:    cadence,
      active:     active,
      notes:      String(values[i][4] || '').trim(),
      format:     normalizeFormat_(String(values[i][5] || '')),
    });
  }
  return out;
}

function normalizeCadence_(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'daily' || s === 'd' || s === 'day') return 'daily';
  if (s === 'weekly' || s === 'w' || s === 'week') return 'weekly';
  if (s === 'monthly' || s === 'm' || s === 'month') return 'monthly';
  return '';
}

/**
 * Format column normalization: 'insights' (and the tolerated synonyms
 * 'detail' / 'agents') selects the Insights-report digest; anything
 * else -- including the empty col F on pre-Format sheets -- is the
 * original 'summary'.
 */
function normalizeFormat_(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'insights' || s === 'insight' || s === 'detail' || s === 'agents') return 'insights';
  return 'summary';
}

/**
 * Returns { fromIso, toIso } for the digest window given a cadence
 * and a reference "now" date.
 *   daily   -> previous calendar day (single-day range)
 *   weekly  -> previous Mon-Fri (5-day range)
 *   monthly -> previous calendar month (1st..last day)
 * Returns null on bad cadence.
 */
function digestWindowFor_(cadence, now) {
  const tz = TZ;
  const fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  if (cadence === 'daily') {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    const iso = fmt(yesterday);
    return { fromIso: iso, toIso: iso };
  }
  if (cadence === 'weekly') {
    // Find the most recent Monday before today, then go back 7 days
    // to get the prior week's Monday; Friday = Monday + 4.
    const dow = now.getDay();   // 0=Sun..6=Sat
    // Days since most recent Monday (treat Sun as 6 since last Mon).
    const daysSinceMon = (dow === 0) ? 6 : (dow - 1);
    const thisMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMon, 12);
    const lastMon = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - 7, 12);
    const lastFri = new Date(lastMon.getFullYear(), lastMon.getMonth(), lastMon.getDate() + 4, 12);
    return { fromIso: fmt(lastMon), toIso: fmt(lastFri) };
  }
  if (cadence === 'monthly') {
    // Previous calendar month, robust to being fired on any day of the
    // current month (the trigger targets the 1st, but a manual run /
    // preview can happen anytime).
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12);
    const last  = new Date(now.getFullYear(), now.getMonth(), 0, 12);
    return { fromIso: fmt(first), toIso: fmt(last) };
  }
  return null;
}

function uninstallDigestTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    const fn = triggers[i].getHandlerFunction();
    if (fn === 'runDailyDigests_' || fn === 'runWeeklyDigests_' || fn === 'runMonthlyDigests_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function getDigestTriggerStatus_() {
  let daily = false, weekly = false, monthly = false;
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    const fn = triggers[i].getHandlerFunction();
    if (fn === 'runDailyDigests_')   daily   = true;
    if (fn === 'runWeeklyDigests_')  weekly  = true;
    if (fn === 'runMonthlyDigests_') monthly = true;
  }
  return { daily: daily, weekly: weekly, monthly: monthly };
}

function notifyDigestFailure_(cadence, err) {
  try {
    const to = getAdminEmails_().join(',');
    if (!to) return;
    MailApp.sendEmail({
      to:      to,
      subject: '[Dashboard] ' + cadence + ' digest run failed',
      body:    (cadence === 'daily'   ? 'runDailyDigests_'
                : cadence === 'monthly' ? 'runMonthlyDigests_'
                : 'runWeeklyDigests_')
               + ' threw: ' + ((err && err.message) ? err.message : String(err))
               + '\n\nTime: ' + new Date()
               + '\n\nStack:\n' + ((err && err.stack) ? err.stack : '(no stack)'),
    });
  } catch (mailErr) {
    Logger.log('Also failed to email digest failure: %s', mailErr);
  }
}
