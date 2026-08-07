/**
 * EmailKit.gs — the shared outbound-email design language (Round-16).
 *
 * The Daily Call Queue Report email set the house style for report emails
 * (QueueReportEmail.gs): a 600px white card on a cool page background, a
 * kicker + title header, tinted rounded KPI tiles, tables with volume
 * tallies, a bulletproof CTA and a quiet footer — all inline styles on
 * nested role="presentation" tables (mail clients strip <style> blocks and
 * CSS custom properties). This file extracts that language so OTHER report
 * emails (My Department, the Insights report + summary) render as one
 * family.
 *
 * QueueReportEmail.gs deliberately keeps its own local copies: its output
 * is pinned by tests/unit/queue-report.test.js and its helpers carry
 * report-specific behavior (the 5%-standard softening, banner-only
 * sections, the MTD sub-lines). Don't fold it into this kit — evolve the
 * kit for the caller-requested report emails, and let the queue report
 * keep its pinned shape.
 */

var EK_SANS_ = 'Arial,Helvetica,sans-serif';
// Same palette constants as buildQueueReportEmailHtml_'s C map.
var EK_C_ = {
  bad: '#b23a2c', watch: '#c66b4b', good: '#3d9476',
  ink: '#101418', mut: '#606872', line: '#e2e8ee', rowline: '#eef2f6',
  track: '#eef2f6', headbg: '#f2f6fa', page: '#e7ecf1',
  neuTile: '#f2f6fa', neuTileB: '#dde6ee',
  badTile: '#fbeae2', badTileB: '#eccbbb',
  goodTile: '#e6f0ea', goodTileB: '#cfe3d7',
  okInk: '#2f5f4a', alertInk: '#7a3520',
};

function ekEsc_(v) { return escapeHtmlServer_(String(v == null ? '' : v)); }

function ekFmtInt_(n) {
  n = Number(n) || 0;
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * One KPI tile as a <td> (the queue email's kpi() shape). opts.tone picks
 * the tint: 'good' | 'bad' | 'neutral' (default). opts.subHtml renders
 * under the value (use ekKpiSub_); opts.pad spaces tiles apart.
 */
function ekKpiTd_(label, value, opts) {
  opts = opts || {};
  const C = EK_C_;
  const tone = opts.tone || 'neutral';
  const bg = tone === 'good' ? C.goodTile : tone === 'bad' ? C.badTile : C.neuTile;
  const bd = tone === 'good' ? C.goodTileB : tone === 'bad' ? C.badTileB : C.neuTileB;
  const labelColor = tone === 'good' ? '#3f7a5f' : tone === 'bad' ? '#8a5a44' : '#6b7580';
  const valColor = tone === 'good' ? C.good : tone === 'bad' ? C.bad : C.ink;
  return '<td class="kpi" width="' + (opts.width || '25%') + '" valign="top" style="' + (opts.pad || '') + '">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:10px;"><tr>'
    + '<td class="kpi-cell" style="padding:12px 14px;">'
    + '<div style="font:600 9px ' + EK_SANS_ + ';letter-spacing:0.8px;text-transform:uppercase;color:' + labelColor + ';">' + ekEsc_(label) + '</div>'
    + '<div style="font:bold 24px Arial,sans-serif;color:' + valColor + ';padding-top:2px;white-space:nowrap;">' + ekEsc_(value) + '</div>'
    + (opts.subHtml || '')
    + '</td></tr></table></td>';
}

/** Small muted sub-line under a KPI value (caller escapes dynamic parts). */
function ekKpiSub_(innerHtml) {
  return '<div style="font:11px ' + EK_SANS_ + ';color:' + EK_C_.mut + ';padding-top:6px;white-space:nowrap;">'
    + innerHtml + '</div>';
}

/**
 * Signed-delta text vs a prior window: "▲ 2.1 pts vs prior" with valence
 * color. opts: goodWhenUp (true/false; null/undefined = neutral gray),
 * suffix (' pts' / '%' / ''), decimals (default 1), vs (label; '' hides).
 * Returns '' for a null/NaN delta.
 */
function ekDeltaHtml_(delta, opts) {
  opts = opts || {};
  const d = Number(delta);
  if (delta == null || !isFinite(d)) return '';
  const decimals = opts.decimals != null ? opts.decimals : 1;
  const up = d >= 0;
  let color = EK_C_.mut;
  if (opts.goodWhenUp === true) color = up ? EK_C_.good : EK_C_.watch;
  else if (opts.goodWhenUp === false) color = up ? EK_C_.watch : EK_C_.good;
  const vs = opts.vs != null ? opts.vs : ' vs prior';
  return '<span style="color:' + color + ';font-weight:bold;">'
    + (up ? '&#9650;' : '&#9660;') + ' ' + Math.abs(d).toFixed(decimals)
    + ekEsc_(opts.suffix || '') + '</span>'
    + (vs ? '<span style="color:' + EK_C_.mut + ';">' + ekEsc_(vs) + '</span>' : '');
}

/**
 * Cohort tally unit for email rows: the web ansTallyUnitFor_ ladder
 * (≤36 blocks for the busiest row), taking the max per-row total.
 */
function ekTallyUnit_(maxTotal) {
  const max = Number(maxTotal) || 0;
  if (!max) return 0;
  const ladder = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
  for (let i = 0; i < ladder.length; i++) {
    if (Math.ceil(max / ladder[i]) <= 36) return ladder[i];
  }
  return ladder[ladder.length - 1];
}

/**
 * Volume tally: green answered + red missed block cells at the shared unit,
 * with a trailing text cell (opts.tailHtml — rate/counts, caller-styled).
 * Email-safe fixed-width <td> blocks (the queue email's tallyHtml shape);
 * min one block for a nonzero value.
 */
function ekTallyHtml_(answered, missed, unit, opts) {
  opts = opts || {};
  const a = Number(answered) || 0, m = Number(missed) || 0;
  const missColor = opts.missColor || EK_C_.bad;
  const blocks = function (n, color) {
    let out = '';
    for (let i = 0; i < n; i++) {
      out += '<td width="5" style="background:' + color + ';height:12px;line-height:12px;font-size:0;">&nbsp;</td>'
           + '<td width="2" style="font-size:0;">&nbsp;</td>';
    }
    return out;
  };
  const nA = a > 0 ? Math.max(1, Math.round(a / (unit || 1))) : 0;
  const nM = m > 0 ? Math.max(1, Math.round(m / (unit || 1))) : 0;
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + blocks(nA, EK_C_.good) + blocks(nM, missColor)
    + (opts.tailHtml
        ? '<td align="right" style="font:11px ' + EK_SANS_ + ';padding-left:4px;white-space:nowrap;">' + opts.tailHtml + '</td>'
        : '')
    + '</tr></table>';
}

/** A table header row in the house style (cols: [{label, align, pad}]). */
function ekTheadRow_(cols) {
  return '<tr style="background:' + EK_C_.headbg + ';">'
    + cols.map(function (c) {
        return '<td' + (c.align ? ' align="' + c.align + '"' : '')
          + ' style="padding:9px ' + (c.pad || '12px') + ';font:600 9px ' + EK_SANS_
          + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;white-space:nowrap;">'
          + ekEsc_(c.label) + '</td>';
      }).join('')
    + '</tr>';
}

/**
 * A tinted callout band (the takeaway / verdict line). tone: 'good' |
 * 'warn' | 'neutral'. Caller escapes bodyHtml's dynamic parts.
 */
function ekCalloutHtml_(kicker, bodyHtml, tone) {
  const C = EK_C_;
  const c = tone === 'good' ? { bg: '#e6f0ea', bd: C.good, head: C.okInk }
    : tone === 'warn' ? { bg: '#f6e2d4', bd: C.watch, head: C.alertInk }
    : { bg: C.headbg, bd: '#8a97a4', head: '#4a5560' };
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + c.bg
    + ';border-left:4px solid ' + c.bd + ';border-radius:6px;"><tr><td style="padding:10px 14px;">'
    + (kicker
        ? '<div style="font:600 9px ' + EK_SANS_ + ';letter-spacing:0.8px;text-transform:uppercase;color:' + c.head + ';">'
          + ekEsc_(kicker) + '</div>'
        : '')
    + '<div style="font:13px/1.5 Arial,sans-serif;color:' + EK_C_.ink + ';padding-top:2px;">' + bodyHtml + '</div>'
    + '</td></tr></table>';
}

/**
 * The full email shell: hidden preheader, page background, 600px white
 * card with kicker/title/subtitle header, the caller's body rows
 * (each a complete '<tr><td …>…</td></tr>'), an optional bulletproof CTA,
 * and the footer note.
 */
function ekShellHtml_(o) {
  o = o || {};
  const C = EK_C_;
  const preheader = o.preheader
    ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:'
      + C.page + ';">' + ekEsc_(o.preheader) + '</div>'
    : '';
  const cta = (o.ctaUrl && o.ctaLabel)
    ? '<tr><td style="padding:12px 26px 24px;" align="left"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td bgcolor="' + C.ink + '" style="border-radius:8px;"><a href="' + ekEsc_(o.ctaUrl) + '" '
      + 'style="display:block;padding:11px 20px;font:bold 13px Arial,sans-serif;color:#ffffff;text-decoration:none;">'
      + ekEsc_(o.ctaLabel) + ' &rarr;</a></td></tr></table></td></tr>'
    : '';
  return ''
    + preheader
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.page + ';"><tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="wrap" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">'
    + '<tr><td style="padding:22px 26px 18px;border-bottom:1px solid ' + C.line + ';">'
    +   '<div style="font:600 11px ' + EK_SANS_ + ';letter-spacing:1.5px;text-transform:uppercase;color:#8a97a4;">' + ekEsc_(o.kicker || 'Call Data') + '</div>'
    +   '<div style="font:bold 23px Arial,sans-serif;color:' + C.ink + ';letter-spacing:-0.4px;padding-top:4px;">' + ekEsc_(o.title || '') + '</div>'
    +   (o.subtitle ? '<div style="font:400 13px Arial,sans-serif;color:' + C.mut + ';padding-top:3px;">' + ekEsc_(o.subtitle) + '</div>' : '')
    + '</td></tr>'
    + (o.rowsHtml || '')
    + cta
    + '<tr><td style="padding:16px 26px 22px;border-top:1px solid ' + C.line + ';background:#f7fafc;">'
    +   '<div style="font:400 11px/1.6 Arial,sans-serif;color:#8a97a4;">' + (o.footerHtml || 'Sent from the Call Data dashboard.') + '</div>'
    + '</td></tr>'
    + '</table></td></tr></table>';
}

/** A body row wrapping arbitrary inner HTML with the standard side padding. */
function ekRow_(innerHtml, pad) {
  return '<tr><td style="padding:' + (pad || '16px 26px 4px') + ';">' + innerHtml + '</td></tr>';
}
