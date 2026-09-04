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
  // R29: `band` switches to the v2 dark header (ekBandRowsHtml_); the CTA
  // then takes the accent color and a second, text-only CTA is allowed.
  // Callers that pass no band render byte-identically to before.
  const banded = !!o.band;
  const ctaBg = banded ? C.good : C.ink;
  const cta2 = (banded && o.cta2Url && o.cta2Label)
    ? '<td style="padding-left:12px;"><a href="' + ekEsc_(o.cta2Url) + '" style="font:600 13px ' + EK_SANS_ + ';color:' + C.mut + ';text-decoration:underline;">' + ekEsc_(o.cta2Label) + '</a></td>'
    : '';
  const cta = (o.ctaUrl && o.ctaLabel)
    ? '<tr><td style="padding:12px 26px 24px;" align="left"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td bgcolor="' + ctaBg + '" style="border-radius:8px;"><a href="' + ekEsc_(o.ctaUrl) + '" '
      + 'style="display:block;padding:11px 20px;font:bold 13px Arial,sans-serif;color:#ffffff;text-decoration:none;">'
      + ekEsc_(o.ctaLabel) + ' &rarr;</a></td>' + cta2 + '</tr></table></td></tr>'
    : '';
  const header = banded
    ? ekBandRowsHtml_({ tone: o.band.tone, glyph: o.band.glyph, kicker: o.kicker, title: o.title, subtitle: o.subtitle })
    : '<tr><td style="padding:22px 26px 18px;border-bottom:1px solid ' + C.line + ';">'
    +   '<div style="font:600 11px ' + EK_SANS_ + ';letter-spacing:1.5px;text-transform:uppercase;color:#8a97a4;">' + ekEsc_(o.kicker || 'Call Data') + '</div>'
    +   '<div style="font:bold 23px Arial,sans-serif;color:' + C.ink + ';letter-spacing:-0.4px;padding-top:4px;">' + ekEsc_(o.title || '') + '</div>'
    +   (o.subtitle ? '<div style="font:400 13px Arial,sans-serif;color:' + C.mut + ';padding-top:3px;">' + ekEsc_(o.subtitle) + '</div>' : '')
    + '</td></tr>';
  const footerInner = banded
    ? '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
      + '<td style="font:400 11px/1.6 Arial,sans-serif;color:#8a97a4;">' + (o.footerHtml || 'Sent from the Call Data dashboard.') + '</td>'
      + '<td align="right" valign="top" style="font:bold 11px ' + EK_SANS_ + ';letter-spacing:1.2px;color:#b3bcc6;white-space:nowrap;padding-left:12px;">CALL DATA</td>'
      + '</tr></table>'
    : '<div style="font:400 11px/1.6 Arial,sans-serif;color:#8a97a4;">' + (o.footerHtml || 'Sent from the Call Data dashboard.') + '</div>';
  return ''
    + preheader
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.page + ';"><tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="wrap" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">'
    + header
    + (o.rowsHtml || '')
    + cta
    + '<tr><td style="padding:16px 26px 22px;border-top:1px solid ' + C.line + ';background:#f7fafc;">'
    +   footerInner
    + '</td></tr>'
    + '</table></td></tr></table>';
}

/** A body row wrapping arbitrary inner HTML with the standard side padding. */
function ekRow_(innerHtml, pad) {
  return '<tr><td style="padding:' + (pad || '16px 26px 4px') + ';">' + innerHtml + '</td></tr>';
}

// ── EmailKit v2 (R29): the notice family ─────────────────────────────────
//
// Every admin notice (watchdogs, run failures, sign-in sightings, client
// issues, coverage checks, the coaching batch, the smoke result) used to be
// a plain-text `body`. They now ALSO carry an HTML alternative in the house
// style, built from ONE spec by ekNoticeHtml_: a dark header band with a
// severity-toned stripe + glyph badge, up to a row of status tiles, a toned
// callout, a list, numbered steps, a monospace block for stacks/logs, and
// one or two CTAs. The plain-text body stays as the client fallback (and is
// what the existing tests pin), so nothing a test reads has changed.
//
// Senders do not call this directly: they pass `notice: {...}` to
// sendAppEmail_ (Config.gs), which renders it through ekNoticeHtml_ when the
// kit is loaded. That keeps every sender file free of a hard dependency on
// this file (the unit suites load files selectively) while production --
// one shared scope -- always renders it. email-kit-v2.test.js sweeps every
// plain-text sender for the `notice:` spec.

var EK_BAND_ = Object.freeze({
  neutral: { stripe: '#8a97a4', glyph: '#5f6b77', kicker: '#aab4bf' },
  good:    { stripe: '#3d9476', glyph: '#3d9476', kicker: '#9fd3bd' },
  warn:    { stripe: '#c66b4b', glyph: '#c66b4b', kicker: '#f0c4ae' },
  bad:     { stripe: '#b23a2c', glyph: '#b23a2c', kicker: '#f2b8ae' },
});
var EK_GLYPH_ = Object.freeze({ neutral: 'i', good: '&#10003;', warn: '!', bad: '&#10007;' });

/** The dark header band: stripe, glyph badge, kicker / title / subtitle. */
function ekBandRowsHtml_(o) {
  const tone = EK_BAND_[o.tone] ? o.tone : 'neutral';
  const t = EK_BAND_[tone];
  const glyph = o.glyph || EK_GLYPH_[tone];
  return '<tr><td style="height:5px;background:' + t.stripe + ';font-size:0;line-height:0;">&nbsp;</td></tr>'
    + '<tr><td bgcolor="' + EK_C_.ink + '" style="background:' + EK_C_.ink + ';padding:22px 26px 20px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
    + '<td valign="top" style="width:44px;padding-right:14px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td width="44" height="44" align="center" valign="middle" bgcolor="' + t.glyph + '" style="border-radius:22px;font:bold 20px ' + EK_SANS_ + ';color:#ffffff;">' + glyph + '</td></tr></table></td>'
    + '<td valign="middle">'
    + '<div style="font:600 10px ' + EK_SANS_ + ';letter-spacing:1.6px;text-transform:uppercase;color:' + t.kicker + ';">' + ekEsc_(o.kicker || 'Call Data') + '</div>'
    + '<div style="font:bold 22px ' + EK_SANS_ + ';color:#ffffff;letter-spacing:-0.3px;padding-top:4px;">' + ekEsc_(o.title || '') + '</div>'
    + (o.subtitle ? '<div style="font:400 13px ' + EK_SANS_ + ';color:#aab4bf;padding-top:4px;">' + ekEsc_(o.subtitle) + '</div>' : '')
    + '</td></tr></table></td></tr>';
}

/** A row of equal tinted status tiles: [{label, value, sub, tone}]. */
function ekTilesHtml_(list) {
  const C = EK_C_;
  list = (list || []).filter(function (t) { return t && t.label != null; }).slice(0, 4);
  if (!list.length) return '';
  const w = Math.floor(100 / list.length);
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
    + list.map(function (t, i) {
      const bg = t.tone === 'good' ? C.goodTile : t.tone === 'warn' ? '#f6e2d4' : t.tone === 'bad' ? C.badTile : C.neuTile;
      const bd = t.tone === 'good' ? C.goodTileB : t.tone === 'warn' ? '#e8c3ad' : t.tone === 'bad' ? C.badTileB : C.neuTileB;
      const ink = t.tone === 'good' ? C.okInk : (t.tone === 'warn' || t.tone === 'bad') ? C.alertInk : C.ink;
      return '<td width="' + w + '%" valign="top" style="padding:0 ' + (i === list.length - 1 ? 0 : 8) + 'px 0 0;">'
        + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:10px;"><tr><td style="padding:12px 12px 10px;">'
        + '<div style="font:600 9px ' + EK_SANS_ + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;">' + ekEsc_(t.label) + '</div>'
        + '<div style="font:bold 18px ' + EK_SANS_ + ';color:' + ink + ';padding-top:3px;letter-spacing:-0.2px;word-break:break-word;">' + ekEsc_(t.value == null ? '' : t.value) + '</div>'
        + (t.sub ? '<div style="font:11px ' + EK_SANS_ + ';color:' + C.mut + ';padding-top:2px;">' + ekEsc_(t.sub) + '</div>' : '')
        + '</td></tr></table></td>';
    }).join('') + '</tr></table>';
}

/** Numbered steps with round chips: [{head, body}] (body is HTML, caller-escaped). */
function ekStepsHtml_(list, tone) {
  const chip = tone === 'warn' ? EK_C_.watch : tone === 'bad' ? EK_C_.bad : EK_C_.good;
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
    + (list || []).map(function (s, i) {
      return '<tr><td valign="top" style="width:30px;padding:6px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        + '<td width="24" height="24" align="center" valign="middle" bgcolor="' + chip + '" style="border-radius:12px;font:bold 12px ' + EK_SANS_ + ';color:#ffffff;">' + (i + 1) + '</td></tr></table></td>'
        + '<td valign="top" style="padding:7px 0 6px 10px;font:13px/1.5 ' + EK_SANS_ + ';color:' + EK_C_.ink + ';border-bottom:1px solid ' + EK_C_.line + ';">'
        + '<strong>' + ekEsc_(s.head || '') + '</strong>' + (s.body ? ' <span style="color:' + EK_C_.mut + ';">' + s.body + '</span>' : '') + '</td></tr>';
    }).join('') + '</table>';
}

/** A bulleted list of pre-escaped HTML items with a small uppercase title. */
function ekListHtml_(title, items) {
  items = (items || []).filter(Boolean);
  if (!items.length) return '';
  return (title ? ekSectionTitle_(title) : '')
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
    + items.map(function (it) {
      return '<tr><td valign="top" style="width:14px;padding:4px 0;font:13px ' + EK_SANS_ + ';color:#8a97a4;">&bull;</td>'
        + '<td style="padding:4px 0 4px 6px;font:13px/1.5 ' + EK_SANS_ + ';color:' + EK_C_.ink + ';border-bottom:1px solid ' + EK_C_.rowline + ';">' + it + '</td></tr>';
    }).join('') + '</table>';
}

/** Monospace block for stacks / logs (escaped, wrapped, capped). */
function ekMonoHtml_(title, text, cap) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return '';
  const shown = t.length > (cap || 4000) ? (t.slice(0, cap || 4000) + '\n…') : t;
  return (title ? ekSectionTitle_(title) : '')
    + '<div style="font:12px/1.5 Menlo,Consolas,monospace;color:' + EK_C_.ink + ';background:' + EK_C_.headbg
    + ';border:1px solid ' + EK_C_.line + ';border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;">'
    + ekEsc_(shown) + '</div>';
}

function ekSectionTitle_(title) {
  return '<div style="font:600 9px ' + EK_SANS_ + ';letter-spacing:0.8px;text-transform:uppercase;color:#8a97a4;padding-bottom:4px;">' + ekEsc_(title) + '</div>';
}

/** Dashboard URL + route hash, or '' when DASHBOARD_URL is unset (no CTA). */
function ekDashUrl_(hash) {
  var url = '';
  try { url = String(PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL') || '').trim(); } catch (e) {}
  return url ? (url + (hash || '')) : '';
}

/**
 * One notice, one spec:
 *   { tone, glyph, kicker, title, subtitle, preheader,
 *     tiles: [{label, value, sub, tone}],
 *     callout: {kicker, html, tone},
 *     list: {title, items: [html]},
 *     stepsTitle, steps: [{head, body}],
 *     mono: {title, text},
 *     intro (html), outro (html),
 *     ctaUrl, ctaLabel, cta2Url, cta2Label, footerHtml }
 * Sections render in that order; absent ones are skipped.
 */
function ekNoticeHtml_(o) {
  o = o || {};
  const tone = EK_BAND_[o.tone] ? o.tone : 'neutral';
  let rows = '';
  if (o.intro) rows += ekRow_('<div style="font:14px/1.55 ' + EK_SANS_ + ';color:' + EK_C_.ink + ';">' + o.intro + '</div>', '20px 26px 4px');
  if (o.tiles && o.tiles.length) rows += ekRow_(ekTilesHtml_(o.tiles), (o.intro ? '10px' : '20px') + ' 26px 6px');
  if (o.callout && o.callout.html) rows += ekRow_(ekCalloutHtml_(o.callout.kicker || '', o.callout.html, o.callout.tone || (tone === 'neutral' ? 'neutral' : tone === 'good' ? 'good' : 'warn')), '10px 26px 4px');
  if (o.list && o.list.items && o.list.items.length) rows += ekRow_(ekListHtml_(o.list.title, o.list.items), '12px 26px 4px');
  if (o.steps && o.steps.length) rows += ekRow_((o.stepsTitle ? ekSectionTitle_(o.stepsTitle) : '') + ekStepsHtml_(o.steps, tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : 'good'), '12px 26px 6px');
  if (o.mono && o.mono.text) rows += ekRow_(ekMonoHtml_(o.mono.title, o.mono.text), '12px 26px 6px');
  if (o.outro) rows += ekRow_('<div style="font:13px/1.5 ' + EK_SANS_ + ';color:' + EK_C_.mut + ';">' + o.outro + '</div>', '10px 26px 8px');
  if (!rows) rows = ekRow_('', '8px 26px 8px');
  return ekShellHtml_({
    band: { tone: tone, glyph: o.glyph },
    kicker: o.kicker || 'Call Data · Admin notice',
    title: o.title || '',
    subtitle: o.subtitle || '',
    preheader: o.preheader || o.title || '',
    rowsHtml: rows,
    ctaUrl: o.ctaUrl || '', ctaLabel: o.ctaLabel || '',
    cta2Url: o.cta2Url || '', cta2Label: o.cta2Label || '',
    footerHtml: o.footerHtml || 'Sent from the Call Data dashboard.',
  });
}
