/**
 * Sheet coverage check (R25) — the SHEET-side twin of runNeonCoverageCheck.
 *
 * THE BLIND SPOT THIS CLOSES. Everything that watches the historical sheets
 * watches the TRAILING EDGE or per-agent silence:
 *   - the ingest watchdog / freshness pill / Overview banner ask "is the
 *     LATEST date too old" (36h staleness);
 *   - the DQE-silence watchdog asks "does a queue have volume while this
 *     dept has zero agent rows" (per dept, per day);
 *   - Pipeline Health records a run that FAILED — a run that never happened
 *     writes nothing at all;
 *   - runNeonCoverageCheck compares sheet-vs-Neon, so a date missing from
 *     BOTH sides produces no finding.
 * So an INTERIOR hole is invisible: the import doesn't run on Tuesday,
 * Wednesday's run succeeds, freshness goes green, and Tuesday is simply gone.
 * Every report then averages over a window quietly missing a day — no error,
 * no banner, just numbers that are a little wrong forever.
 *
 * This check walks a window and flags BUSINESS DAYS with ZERO rows in each
 * dashboard-read historical sheet, holiday-aware (COMPANY_HOLIDAYS) and
 * floored at that sheet's own earliest date (dates before the sheet begins
 * are expected-empty, not gaps).
 *
 * SHEET-ONLY BY DESIGN: it opens no Neon connection, so it is exactly as
 * useful during an outage as outside one — which is when a missed import is
 * most likely and least likely to be noticed. It reuses the Neon check's
 * pure primitives (`ncExpectedWeekdayGaps_`, `ncSheetDateCounts_`,
 * `ncCellDateIso_`) so the two checks cannot disagree about what a
 * business-day gap IS; each is typeof-guarded, so a partial push degrades to
 * a clean error instead of a crash.
 *
 * READ-ONLY + best-effort: never writes a sheet; each sheet is independently
 * try/caught; the outcome is emailed to admins and stored OPS-8 prefix-coded
 * in SHEET_COVERAGE_LAST / SHEET_COVERAGE_LAST_RESULT (the Health page's
 * "Sheet coverage — last check" row reads them).
 *
 * Run `runSheetCoverageCheck()` from the dashboard editor as an admin.
 * Tunable: SHEET_COVERAGE_DAYS (default 30; window ends yesterday).
 */

var SHEET_COVERAGE_DEFAULT_DAYS_ = 30;

/**
 * The dashboard-read historical sheets and their date columns. Kept to the
 * sheets a MANAGER's numbers actually come from: a gap here silently changes
 * a report. (CDR / Q Path are legacy-read only — INV-52 — so a hole in them
 * misleads nobody on this dashboard and would only add noise here.)
 */
var SHEET_COVERAGE_SHEETS_ = [
  { sheet: 'DQE Historical Data', dateCol: 2, label: 'DQE (per-agent metrics)',
    fix: 'force re-import the date (cdr-import Manual Export), or run buildDQEHistoricalData for it' },
  { sheet: 'QCD Historical Data', dateCol: 3, label: 'QCD (queue metrics)',
    fix: 'force re-import the date — the QCD block rebuilds with it' },
  { sheet: 'Direct Call History', dateCol: 2, label: 'Direct-extension metrics',
    fix: 'run runDirectCallBuild() for the date (cdr-import), or force re-import it' },
];

/**
 * PURE core (unit-tested): given per-sheet date counts, produce the findings.
 * `countsBySheet` is { sheetName: {iso: n} | null }; a null means the sheet is
 * MISSING, which is reported distinctly from "present but has holes" — the
 * two need different operator responses.
 */
function sheetCoverageAssess_(specs, fromIso, toIso, countsBySheet, floorBySheet, holidayFn) {
  var out = [];
  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    var counts = countsBySheet[spec.sheet];
    if (counts === null || counts === undefined) {
      out.push({ sheet: spec.sheet, label: spec.label, missingSheet: true, gaps: [], fix: spec.fix });
      continue;
    }
    // Floor at the sheet's earliest date: a window reaching back before the
    // sheet begins must not report every one of those days as a gap.
    var floorIso = floorBySheet[spec.sheet] || null;
    var gaps = (typeof ncExpectedWeekdayGaps_ === 'function')
      ? ncExpectedWeekdayGaps_(fromIso, toIso, counts, floorIso, holidayFn)
      : [];
    out.push({ sheet: spec.sheet, label: spec.label, missingSheet: false,
               gaps: gaps, firstDate: floorIso, fix: spec.fix });
  }
  return out;
}

/** Earliest ISO date present in a sheet's date column (null when empty). */
function sheetCoverageFirstDate_(ss, sheetName, dateCol) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var vals = sheet.getRange(2, dateCol, lastRow - 1, 1).getDisplayValues();
  var min = null;
  for (var i = 0; i < vals.length; i++) {
    var iso = (typeof ncCellDateIso_ === 'function') ? ncCellDateIso_(vals[i][0]) : null;
    if (iso && (min === null || iso < min)) min = iso;
  }
  return min;
}

function runSheetCoverageCheck() {
  assertAdmin_();
  var t0 = Date.now();
  var props = PropertiesService.getScriptProperties();
  var days = parseInt(props.getProperty('SHEET_COVERAGE_DAYS'), 10);
  if (!isFinite(days) || days < 1 || days > 366) days = SHEET_COVERAGE_DEFAULT_DAYS_;

  // Window ends YESTERDAY: today's import legitimately may not have run yet
  // (the same rule the date presets and the Neon check use).
  var end = new Date(); end.setDate(end.getDate() - 1);
  var start = new Date(end.getTime()); start.setDate(start.getDate() - (days - 1));
  var fromIso = Utilities.formatDate(start, TZ, 'yyyy-MM-dd');
  var toIso = Utilities.formatDate(end, TZ, 'yyyy-MM-dd');

  var out = { from: fromIso, to: toIso, sheets: [], findings: 0, errors: [] };
  try {
    var ss = openSpreadsheet_();
    var countsBySheet = {}, floorBySheet = {};
    for (var i = 0; i < SHEET_COVERAGE_SHEETS_.length; i++) {
      var spec = SHEET_COVERAGE_SHEETS_[i];
      try {
        countsBySheet[spec.sheet] = (typeof ncSheetDateCounts_ === 'function')
          ? ncSheetDateCounts_(ss, spec.sheet, spec.dateCol, fromIso, toIso) : null;
        floorBySheet[spec.sheet] = sheetCoverageFirstDate_(ss, spec.sheet, spec.dateCol);
      } catch (se) {
        countsBySheet[spec.sheet] = undefined;
        out.errors.push(spec.sheet + ': ' + (se && se.message ? se.message : se));
      }
    }
    out.sheets = sheetCoverageAssess_(
      SHEET_COVERAGE_SHEETS_, fromIso, toIso, countsBySheet, floorBySheet,
      function (iso) {
        return (typeof isCompanyHoliday_ === 'function') ? isCompanyHoliday_(iso) : false;
      });
    for (var j = 0; j < out.sheets.length; j++) {
      out.findings += (out.sheets[j].gaps || []).length + (out.sheets[j].missingSheet ? 1 : 0);
    }
  } catch (e) {
    var msg = 'FAILED ' + (e && e.message ? e.message : e);
    sheetCoverageRecord_(msg);
    return { error: msg, from: fromIso, to: toIso };
  }

  out.ms = Date.now() - t0;
  var summary = out.findings
    ? ('GAPS ' + out.findings + ' finding(s) over ' + fromIso + '..' + toIso
       + (out.errors.length ? (' (+' + out.errors.length + ' read error(s))') : '')
       + ' | ' + out.ms + 'ms')
    : ('CLEAN no missing business days over ' + fromIso + '..' + toIso + ' | ' + out.ms + 'ms');
  sheetCoverageRecord_(summary);
  sheetCoverageLog_(out, summary);
  sheetCoverageNotify_(out, summary);
  return out;
}

function sheetCoverageRecord_(summary) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('SHEET_COVERAGE_LAST', new Date().toISOString());
    props.setProperty('SHEET_COVERAGE_LAST_RESULT', String(summary).slice(0, 2000));
  } catch (e) { /* best-effort */ }
}

function sheetCoverageLog_(out, summary) {
  try {
    Logger.log('=== SHEET COVERAGE %s ===', summary);
    (out.sheets || []).forEach(function (s) {
      if (s.missingSheet) { Logger.log('  %s: SHEET MISSING — %s', s.sheet, s.fix); return; }
      if (!s.gaps.length) { Logger.log('  %s: clean', s.sheet); return; }
      Logger.log('  %s: %s missing business day(s): %s — fix: %s',
        s.sheet, s.gaps.length, s.gaps.join(', '), s.fix);
    });
    (out.errors || []).forEach(function (e) { Logger.log('  read error: %s', e); });
  } catch (e) { /* best-effort */ }
}

/** Emails admins ONLY when there is something to act on (the OPS-8 rule). */
function sheetCoverageNotify_(out, summary) {
  try {
    if (!out.findings) return;
    var to = getAdminEmails_().join(',');
    if (!to) return;
    var lines = (out.sheets || []).map(function (s) {
      if (s.missingSheet) return '<li><strong>' + escapeHtmlServer_(s.sheet) + '</strong>: sheet MISSING — ' + escapeHtmlServer_(s.fix) + '</li>';
      if (!s.gaps.length) return '';
      return '<li><strong>' + escapeHtmlServer_(s.sheet) + '</strong> (' + escapeHtmlServer_(s.label) + '): '
        + s.gaps.length + ' missing business day(s) — ' + escapeHtmlServer_(s.gaps.join(', '))
        + '<br><em>Fix: ' + escapeHtmlServer_(s.fix) + '</em></li>';
    }).filter(function (x) { return !!x; });
    MailApp.sendEmail({
      to: to,
      subject: '[Dashboard] Sheet coverage — ' + out.findings + ' missing day(s)',
      htmlBody: '<p>A business day inside ' + out.from + '..' + out.to + ' has NO rows in a '
        + 'dashboard-read historical sheet. Reports covering that window are averaging over a '
        + 'day that silently is not there.</p><ul>' + lines.join('') + '</ul>'
        + '<p style="color:#666;font-size:12px;">' + escapeHtmlServer_(summary) + '</p>',
    });
  } catch (e) {
    Logger.log('sheetCoverageNotify_ failed (best-effort): ' + (e && e.message ? e.message : e));
  }
}
