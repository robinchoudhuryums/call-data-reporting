// ============================================================================
// neonEgress.js — month-to-date Neon read metering for the CDR REPORT project
// ----------------------------------------------------------------------------
// WHY THIS EXISTS: the dashboard project has metered its Neon reads since the
// R24 egress round (`neonNoteEgress_`, NeonRead.gs), and the Health page ranks
// consumers from it. But metering stopped at the project boundary — cdr-report
// and cdr-import had ZERO callsites — and Apps Script Script Properties are
// per-project, so the dashboard's counter structurally cannot see traffic from
// here.
//
// That gap was found the expensive way. When the Neon data-transfer quota blew
// a second time, the dashboard counter read ~196 MB against a 5 GB cap: about
// 4% of the overage. The remaining 96% was in projects nothing was watching —
// including the two per-call export triggers below, which run DAILY and
// `json_agg` a window of `inbound_calls` / `outbound_calls` into one string.
// A budget gauge blind to two thirds of the system turns every overage into an
// investigation instead of a lookup.
//
// SHAPE: deliberately identical to the dashboard's, so whoever knows one knows
// the other — `{ m:'YYYY-MM', bytes, reads, by:{ label:{b,r} } }` under the
// same `NEON_EGRESS_MTD` key. Same key name, different project store: it is
// the same measurement, and the TOTAL is the sum across projects. Read this
// one with `showNeonEgress()` (CDR Tools menu) rather than eyeballing raw JSON.
//
// CONTRACT: best-effort, post-fetch, never gates a read and never throws. A
// gauge that can break the thing it measures is worse than no gauge.
// ============================================================================

var CDR_EGRESS_PROP_ = 'NEON_EGRESS_MTD';
var CDR_EGRESS_MAX_SURFACES_ = 24;   // matches the dashboard's cap

/** Current UTC month key, 'YYYY-MM'. Matches the dashboard's keying. */
function cdrEgressMonthKey_() {
  var d = new Date();
  var m = d.getUTCMonth() + 1;
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m;
}

/**
 * Adds one instrumented read to the month-to-date counters.
 * `bytes` is the payload length WE received (so the figure is a FLOOR: it
 * counts payloads, not the wire — TLS, protocol framing and handshakes sit
 * outside it, exactly as on the dashboard side).
 * Unknown/overflow labels land in 'other'. Never throws.
 */
function cdrNoteEgress_(bytes, surface) {
  try {
    var n = Number(bytes) || 0;
    if (n <= 0) return;
    var props = PropertiesService.getScriptProperties();
    var key = cdrEgressMonthKey_();
    var cur = null;
    try { cur = JSON.parse(props.getProperty(CDR_EGRESS_PROP_) || 'null'); } catch (e) { cur = null; }
    if (!cur || cur.m !== key) cur = { m: key, bytes: 0, reads: 0 };
    cur.bytes += n;
    cur.reads += 1;
    if (!cur.by || typeof cur.by !== 'object') cur.by = {};
    var label = String(surface || 'other').trim().slice(0, 24) || 'other';
    if (!cur.by[label] && Object.keys(cur.by).length >= CDR_EGRESS_MAX_SURFACES_) label = 'other';
    var s = cur.by[label] || (cur.by[label] = { b: 0, r: 0 });
    s.b += n;
    s.r += 1;
    props.setProperty(CDR_EGRESS_PROP_, JSON.stringify(cur));
  } catch (e) { /* best-effort -- a gauge must never break a read */ }
}

/**
 * { month, bytes, reads, top:[{label,bytes,reads}] } for this project.
 * A stale month reads as ZERO rather than as last month's total -- the same
 * rule as the dashboard's readNeonEgress_, so a quiet month is not mistaken
 * for a busy one that simply stopped being written to.
 */
function cdrReadEgress_() {
  var out = { month: cdrEgressMonthKey_(), bytes: 0, reads: 0, top: [], staleMonth: null };
  try {
    var props = PropertiesService.getScriptProperties();
    var cur = null;
    try { cur = JSON.parse(props.getProperty(CDR_EGRESS_PROP_) || 'null'); } catch (e) { cur = null; }
    if (!cur) return out;
    if (cur.m !== out.month) {
      // Surfaced rather than silently zeroed: a frozen record is itself a
      // finding (it means reads STOPPED), and that is precisely what a
      // read-source flip or an outage looks like from here.
      out.staleMonth = cur.m || null;
      return out;
    }
    out.bytes = Number(cur.bytes) || 0;
    out.reads = Number(cur.reads) || 0;
    var by = (cur.by && typeof cur.by === 'object') ? cur.by : {};
    out.top = Object.keys(by).map(function (k) {
      return { label: k, bytes: Number(by[k].b) || 0, reads: Number(by[k].r) || 0 };
    }).sort(function (a, b) { return b.bytes - a.bytes; });
  } catch (e) { /* best-effort */ }
  return out;
}

function cdrEgressMb_(bytes) { return Math.round((Number(bytes) || 0) / 10485.76) / 100; }

/**
 * EDITOR/MENU-RUN. Logs this project's month-to-date Neon read volume and the
 * per-surface ranking. The point of the ranking: egress reduction should start
 * from evidence, not from guessing which report "feels heavy".
 *
 * NB this covers the CDR REPORT project only. The dashboard keeps its own
 * counter under the same key, and cdr-import is still UNMETERED (its Neon
 * traffic is mirror WRITES, a different question). Add them for a total.
 */
function showNeonEgress() {
  var e = cdrReadEgress_();
  var lines = ['Neon read volume (CDR Report project) — ' + e.month];
  if (e.staleMonth) {
    lines.push('  no reads recorded this month; last record was ' + e.staleMonth
      + ' (a frozen counter means reads STOPPED — an outage or a read-source flip)');
  } else {
    lines.push('  total: ' + cdrEgressMb_(e.bytes) + ' MB over ' + e.reads + ' reads');
    if (!e.top.length) lines.push('  (no per-surface attribution yet)');
    e.top.forEach(function (t) {
      lines.push('  ' + t.label + ': ' + cdrEgressMb_(t.bytes) + ' MB / ' + t.reads + ' reads');
    });
  }
  lines.push('  NOTE: a FLOOR (payload bytes, not wire). The dashboard project');
  lines.push('  meters separately under the same key; cdr-import is unmetered.');
  var msg = lines.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e2) { /* editor-run: log only */ }
  return e;
}
