/**
 * DeptSummaryEmail.gs — "Email me this report" for My Department (Round-16).
 *
 * Caller-recipient (the sendInsightsReportEmail precedent): recomputes the
 * summary through the SAME public endpoint the page uses —
 * getDepartmentSummary, so auth (resolveUser_ + assertDeptAccess_ per dept
 * in the sub-queue set), the roster scope lock, the sub-queue combine and
 * the cache are all inherited — renders it in the EmailKit house style
 * (the Daily Call Queue Report's design language), and mails it to the
 * signed-in requester ONLY. Read-only (INV-01: no spreadsheet write;
 * MailApp rides the INV-31 scope).
 */
function sendDepartmentSummaryEmail(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const data = getDepartmentSummary(req);   // full validation + auth inside
  const meta = (data && data.meta) || {};
  const dept = meta.department || String((req && req.department) || '').trim();
  const from = meta.from || '', to = meta.to || '';
  const rangeLabel = from === to ? from : from + ' – ' + to;

  MailApp.sendEmail({
    to: email,
    subject: 'My Department: ' + dept + ' · ' + rangeLabel,
    htmlBody: deptSummaryEmailHtml_(data, dept, rangeLabel),
  });
  return { to: email };
}

/**
 * The email body: KPI row (answer rate vs the admin-tunable goal, answered /
 * missed / avg talk time), then the agent table — worst answer rate first
 * (the page's default sort), each row carrying the volume TALLY (green
 * answered + red missed blocks at a cohort-shared unit) beside the exact
 * counts + rate. A combined parent view adds a Dept column and says why the
 * grand total can undercount (crossover de-dup, sub-queue Phase 0).
 */
function deptSummaryEmailHtml_(data, dept, rangeLabel) {
  const C = EK_C_, sans = EK_SANS_;
  const rows = ((data && data.rows) || []).slice();
  const totals = (data && data.totals) || {};
  const meta = (data && data.meta) || {};

  const a = Number(totals.totalAnswered) || 0;
  const m = Number(totals.totalMissed) || 0;
  const total = a + m;
  const rate = total ? (a / total * 100) : 0;
  let target = 92;
  try { target = Number(getAnswerTargets_().global) || 92; } catch (e) { /* seed */ }
  const under = total > 0 && rate < target;

  const kpiRow = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
    + ekKpiTd_('% answered (rings)', total ? rate.toFixed(1) + '%' : '—', {
        tone: total ? (under ? 'bad' : 'good') : 'neutral',
        subHtml: ekKpiSub_(ekEsc_(target + '% goal')),
        pad: 'padding-right:6px;',
      })
    + ekKpiTd_('Answered', ekFmtInt_(a), { pad: 'padding:0 3px;' })
    + ekKpiTd_('Missed', ekFmtInt_(m), { pad: 'padding:0 3px;' })
    + ekKpiTd_('Avg talk time', formatSecondsHms_(Number(totals.attSeconds) || 0), { pad: 'padding-left:6px;' })
    + '</tr></table>';

  // Worst answer rate first, idle agents to the bottom (the page's default).
  const rateOf = function (r) {
    const ra = Number(r.totalAnswered) || 0, rm = Number(r.totalMissed) || 0;
    return (ra + rm) > 0 ? (ra / (ra + rm) * 100) : null;
  };
  rows.sort(function (x, y) {
    const rx = rateOf(x), ry = rateOf(y);
    if (rx == null && ry == null) return String(x.agent).localeCompare(String(y.agent));
    if (rx == null) return 1;
    if (ry == null) return -1;
    return rx - ry;
  });

  // Combined parent view: rows carry >1 distinct dept -> add a Dept column.
  const deptSet = {};
  rows.forEach(function (r) { if (r.dept) deptSet[r.dept] = true; });
  const multiDept = Object.keys(deptSet).length > 1;

  let maxVol = 0;
  rows.forEach(function (r) {
    const v = (Number(r.totalAnswered) || 0) + (Number(r.totalMissed) || 0);
    if (v > maxVol) maxVol = v;
  });
  const unit = ekTallyUnit_(maxVol);

  const headCols = (multiDept ? [{ label: 'Dept' }] : []).concat([
    { label: 'Agent' },
    { label: 'Answered vs missed', pad: '8px' },
    { label: '% Ans', align: 'right', pad: '8px' },
    { label: 'ATT', align: 'right' },
  ]);
  let tbl = ekTheadRow_(headCols);
  rows.forEach(function (r) {
    const ra = Number(r.totalAnswered) || 0, rm = Number(r.totalMissed) || 0;
    const rr = rateOf(r);
    const rUnder = rr != null && rr < target;
    const tail = '<span style="color:' + C.ink + ';">' + ekFmtInt_(ra) + '</span>'
      + '<span style="color:' + C.mut + ';"> / </span>'
      + '<span style="color:' + (rm > 0 ? C.bad : C.mut) + ';">' + ekFmtInt_(rm) + '</span>';
    tbl += '<tr>'
      + (multiDept
          ? '<td style="padding:6px 12px;font:11px ' + sans + ';color:' + C.mut + ';border-top:1px solid ' + C.rowline + ';white-space:nowrap;">' + ekEsc_(r.dept || '') + '</td>'
          : '')
      + '<td style="padding:6px 12px;font:12px ' + sans + ';color:' + C.ink + ';border-top:1px solid ' + C.rowline + ';white-space:nowrap;">' + ekEsc_(r.agent) + '</td>'
      + '<td style="padding:6px 8px;border-top:1px solid ' + C.rowline + ';">'
      +   ((ra + rm) > 0 ? ekTallyHtml_(ra, rm, unit, { tailHtml: tail })
                         : '<span style="font:11px ' + sans + ';color:' + C.mut + ';">no calls</span>')
      + '</td>'
      + '<td align="right" style="padding:6px 8px;font:' + (rUnder ? 'bold ' : '') + '12px ' + sans + ';color:'
      +   (rr == null ? C.mut : (rUnder ? C.watch : C.ink)) + ';border-top:1px solid ' + C.rowline + ';">'
      +   (rr == null ? '–' : Math.round(rr) + '%') + '</td>'
      + '<td align="right" style="padding:6px 12px;font:12px ' + sans + ';color:' + C.ink + ';border-top:1px solid ' + C.rowline + ';white-space:nowrap;">'
      +   ekEsc_(formatSecondsHms_(Number(r.attSeconds) || 0)) + '</td>'
      + '</tr>';
  });
  // Totals row (roster-only, the Phase D contract the page's pinned row uses).
  const cols = headCols.length;
  tbl += '<tr>'
    + '<td colspan="' + (cols - 3) + '" style="padding:9px 12px;font:bold 12px Arial,sans-serif;color:' + C.ink + ';border-top:2px solid ' + C.ink + ';">Total'
    +   (Number(totals.queueOnlyAgentCount) > 0 ? ' <span style="font-weight:normal;color:' + C.mut + ';">(roster only)</span>' : '')
    + '</td>'
    + '<td style="padding:9px 8px;border-top:2px solid ' + C.ink + ';font:bold 12px ' + sans + ';color:' + C.ink + ';">'
    +   ekFmtInt_(a) + ' <span style="color:' + C.mut + ';font-weight:normal;">/</span> <span style="color:' + (m > 0 ? C.bad : C.mut) + ';">' + ekFmtInt_(m) + '</span>'
    + '</td>'
    + '<td align="right" style="padding:9px 8px;font:bold 12px ' + sans + ';color:' + (under ? C.watch : C.ink) + ';border-top:2px solid ' + C.ink + ';">'
    +   (total ? Math.round(rate) + '%' : '–') + '</td>'
    + '<td align="right" style="padding:9px 12px;font:bold 12px ' + sans + ';color:' + C.ink + ';border-top:2px solid ' + C.ink + ';">'
    +   ekEsc_(formatSecondsHms_(Number(totals.attSeconds) || 0)) + '</td>'
    + '</tr>';

  const legendBits = [];
  if (unit > 1) legendBits.push('each block ≈ ' + unit + ' calls');
  legendBits.push('sorted worst answer rate first');
  if (Number(totals.crossoverAgentCount) > 0) {
    legendBits.push('the grand total de-duplicates ' + totals.crossoverAgentCount
      + ' crossover agent(s) counted in more than one department');
  }
  const legend = '<div style="font:10px ' + sans + ';color:#9aa6b2;padding:8px 2px 0;">'
    + ekEsc_(legendBits.join(' · ')) + '</div>';

  const dashUrl = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL') || '';
  const preTxt = dept + ': ' + (total ? rate.toFixed(1) + '% answered (' + ekFmtInt_(a) + ' of ' + ekFmtInt_(total) + ' rings)' : 'no call activity') + ' · ' + rangeLabel;

  return ekShellHtml_({
    kicker: 'Call Data · My Department',
    title: dept,
    subtitle: rangeLabel + (multiDept ? ' · combined with sub-queues' : ''),
    preheader: preTxt,
    rowsHtml: ekRow_(kpiRow)
      + ekRow_('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ' + C.line + ';border-radius:10px;border-collapse:separate;overflow:hidden;">'
          + tbl + '</table>' + legend, '18px 26px 6px'),
    ctaUrl: dashUrl ? dashUrl + '#/dept' : '',
    ctaLabel: 'Open My Department',
    footerHtml: 'Requested from the My Department page — sent only to you, not a subscription. '
      + 'Times shown for the selected range; durations are talk-time averages.',
  });
}
