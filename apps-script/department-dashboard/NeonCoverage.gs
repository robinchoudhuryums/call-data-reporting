/**
 * Neon coverage check (R7 / G-2) — per-date sheet-vs-Neon reconciliation.
 *
 * The existing mirror-health lines compare only MAX(call_date) (sheet vs
 * Neon), so an INTERIOR gap — a date whose mirror write failed and was never
 * retried, or a count drift left by a partial write — is invisible until a
 * reader trips over it. This check walks a WINDOW (default 30 days ending
 * yesterday) and, for every mirrored table with a sheet primary, compares
 * per-date row counts:
 *
 *   dqe_history          ← 'DQE Historical Data'    (date col 2, INV-10)
 *   qcd_history          ← 'QCD Historical Data'    (date col 3, INV-50)
 *   call_history_dept    ← 'CDR Historical Data'    (date col 3, INV-52)
 *   direct_call_history  ← 'Direct Call History'    (date col 2)
 *
 * plus the two NO-SHEET-PRIMARY per-call tables, `inbound_calls` and
 * `outbound_calls` (the export tab is a copy, not a source; outbound has no
 * export at all): for each the check flags ZERO-ROW WEEKDAYS inside the
 * window — holiday-aware (COMPANY_HOLIDAYS) and floored at that table's own
 * capture start (MIN(call_date)), since dates before its capture went live
 * are expected-empty. An outbound_calls table that doesn't exist yet
 * (cdr-import not deployed with the Option B capture) is a clean SKIP, not
 * a probe error (`ncMissingTableError_`).
 *
 * Findings are classified per table:
 *   missing-in-neon  sheet has rows for the date, Neon has none
 *                    → the mirror never landed; run the table's backfill or
 *                      force re-import the date.
 *   count-mismatch   both sides have rows but the counts differ
 *                    → partial/stale mirror; re-import (authoritative
 *                      per-date replace, IMP-5) or run the upsert backfill.
 *   extra-in-neon    Neon has rows for a date the sheet doesn't
 *                    → phantom rows (pre-IMP-5 leftovers); force re-import
 *                      the date so the authoritative delete clears them.
 *
 * READ-ONLY + best-effort: never writes to Neon or the sheets; each table is
 * independently try/caught; the outcome is emailed to the admins and stored
 * OPS-8 prefix-coded in NEON_COVERAGE_LAST / NEON_COVERAGE_LAST_RESULT
 * (surfaced as the Health page's "Neon coverage — last check" row).
 *
 * Run `runNeonCoverageCheck()` from the dashboard editor as an admin
 * (assertAdmin_-gated, the SmokeCheck.gs pattern). Tunable Script Property:
 * NEON_COVERAGE_DAYS (default 30; window ends yesterday).
 *
 * JDBC discipline: every Neon read is ONE json_agg round-trip per table
 * (never per-row rs.getXXX iteration — the 0403b2c lesson).
 */

var NEON_COVERAGE_DEFAULT_DAYS = 30;
var NEON_COVERAGE_MAX_EMAIL_LINES = 40;   // cap the per-finding detail in the email

// Table ↔ sheet registry. dateCol is 1-indexed on the sheet.
var NEON_COVERAGE_TABLES_ = [
  { table: 'dqe_history',         sheet: 'DQE Historical Data',   dateCol: 2,
    fix: 'force re-import the date, or backfillDQEHistoryUpsert() (cdr-report)' },
  { table: 'qcd_history',         sheet: 'QCD Historical Data',   dateCol: 3,
    fix: 'force re-import the date (QCD mirror is authoritative per-date)' },
  { table: 'call_history_dept',   sheet: 'CDR Historical Data',   dateCol: 3,
    fix: 'force re-import the date, or backfillCDRHistory (cdr-report)' },
  { table: 'direct_call_history', sheet: 'Direct Call History',   dateCol: 2,
    fix: 'force re-import the date, or backfillDirectCallToNeon() (cdr-import)' },
];

/** Admin/editor entry point. Returns the full result object (also emailed). */
function runNeonCoverageCheck() {
  assertAdmin_();
  var t0 = Date.now();
  var props = PropertiesService.getScriptProperties();
  var days = parseInt(props.getProperty('NEON_COVERAGE_DAYS'), 10);
  if (!isFinite(days) || days < 1 || days > 366) days = NEON_COVERAGE_DEFAULT_DAYS;

  // Window: `days` days ending YESTERDAY (today's import may not have run).
  var end = new Date(); end.setDate(end.getDate() - 1);
  var start = new Date(end.getTime()); start.setDate(start.getDate() - (days - 1));
  var fromIso = Utilities.formatDate(start, TZ, 'yyyy-MM-dd');
  var toIso = Utilities.formatDate(end, TZ, 'yyyy-MM-dd');

  var out = { from: fromIso, to: toIso, tables: [], inbound: null, findings: 0, errors: [] };
  var conn = null;
  try {
    conn = getDashboardNeonConn_();
    if (!conn) {
      var msg = 'skipped (Neon unreachable/unconfigured)';
      ncRecord_(msg);
      return { error: msg, from: fromIso, to: toIso };
    }
    var ss = openSpreadsheet_();

    for (var i = 0; i < NEON_COVERAGE_TABLES_.length; i++) {
      var spec = NEON_COVERAGE_TABLES_[i];
      try {
        var sheetCounts = ncSheetDateCounts_(ss, spec.sheet, spec.dateCol, fromIso, toIso);
        if (sheetCounts == null) {
          out.tables.push({ table: spec.table, sheet: spec.sheet, skipped: 'sheet missing' });
          continue;
        }
        var neonCounts = ncNeonDateCounts_(conn, spec.table, fromIso, toIso);
        var cmp = ncCompareCoverage_(sheetCounts, neonCounts);
        cmp.table = spec.table; cmp.sheet = spec.sheet; cmp.fix = spec.fix;
        out.findings += cmp.missingInNeon.length + cmp.countMismatch.length + cmp.extraInNeon.length;
        out.tables.push(cmp);
      } catch (te) {
        var tmsg = spec.table + ': ' + (te && te.message ? te.message : te);
        out.errors.push(tmsg);
        Logger.log('runNeonCoverageCheck table failed — ' + tmsg);
      }
    }

    // No-sheet-primary per-call tables: zero-row weekday check. Each entry
    // is independently try/caught; a table that doesn't exist yet (the
    // outbound capture not deployed) is a clean skip, not a probe error.
    var noSheetSpecs = [
      { table: 'inbound_calls',
        fix: 'force re-import the date (heals within the ~14-day Call_Legs retention; older days are unrecoverable — IMP-11)' },
      { table: 'outbound_calls',
        fix: 'force re-import the date or run backfillOutboundCalls (cdr-import; same ~14-day Call_Legs ceiling — IMP-11)' },
    ];
    out.noSheet = [];
    for (var n = 0; n < noSheetSpecs.length; n++) {
      var nspec = noSheetSpecs[n];
      try {
        var counts = ncNeonDateCounts_(conn, nspec.table, fromIso, toIso);
        var floorIso = ncNeonMinDate_(conn, nspec.table);
        var missing = ncExpectedWeekdayGaps_(fromIso, toIso, counts, floorIso, function (iso) {
          return (typeof isCompanyHoliday_ === 'function') ? isCompanyHoliday_(iso) : false;
        });
        out.noSheet.push({ table: nspec.table, captureStart: floorIso,
          zeroRowWeekdays: missing, fix: nspec.fix });
        out.findings += missing.length;
      } catch (ie) {
        var imsg = nspec.table + ': ' + (ie && ie.message ? ie.message : ie);
        if (ncMissingTableError_(imsg)) {
          out.noSheet.push({ table: nspec.table, skipped: 'table not created yet (capture not deployed)' });
          Logger.log('runNeonCoverageCheck: ' + nspec.table + ' not created yet — skipped.');
        } else {
          out.errors.push(imsg);
          Logger.log('runNeonCoverageCheck no-sheet table failed — ' + imsg);
        }
      }
    }
    // Back-compat alias (pre-outbound shape): out.inbound = the inbound entry.
    out.inbound = out.noSheet[0] || null;

    out.ms = Date.now() - t0;
    var summary = out.findings
      ? ('GAPS ' + out.findings + ' finding(s) over ' + fromIso + '..' + toIso
         + (out.errors.length ? (' (+' + out.errors.length + ' probe error(s))') : '') + ' | ' + out.ms + 'ms')
      : ((out.errors.length ? ('FAILED-PROBE ' + out.errors.length + ' table probe error(s)')
                            : 'ok clean') + ' over ' + fromIso + '..' + toIso + ' | ' + out.ms + 'ms');
    ncRecord_(summary);
    ncEmailResult_(out, summary);
    Logger.log('runNeonCoverageCheck: ' + summary);
    return out;
  } catch (e) {
    var fmsg = 'FAILED: ' + (e && e.message ? e.message : e);
    ncRecord_(fmsg);
    Logger.log('runNeonCoverageCheck failed: ' + fmsg);
    return { error: fmsg, from: fromIso, to: toIso };
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

// ── Pure helpers (unit-tested, tests/unit/neon-coverage.test.js) ────────

/**
 * Tolerant display-value → ISO date. Handles 'YYYY-MM-DD' and 'M/D/YYYY'
 * (the two shapes the historical sheets render); anything else → null.
 * The F-3/F-10 rule: writer-side date comparisons go through ISO-normalized
 * DISPLAY values, never String(getValues()).
 */
/**
 * PURE. True when a probe error means the TABLE ISN'T CREATED YET (Postgres
 * undefined_table, surfaced through JDBC as 'relation "x" does not exist')
 * — a clean skip for the no-sheet-primary tables whose capture may not be
 * deployed yet, as opposed to a real probe failure worth alarming on.
 */
function ncMissingTableError_(msg) {
  return /relation .* does not exist|does not exist/i.test(String(msg || ''));
}

function ncCellDateIso_(s) {
  var str = String(s == null ? '' : s).trim();
  if (!str) return null;
  var m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return str;
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    var mo = ('0' + m[1]).slice(-2), da = ('0' + m[2]).slice(-2);
    return m[3] + '-' + mo + '-' + da;
  }
  return null;
}

/**
 * Pure per-date comparison. Both args are { iso: rowCount } maps limited to
 * the window. Returns sorted finding lists (oldest first).
 */
function ncCompareCoverage_(sheetCounts, neonCounts) {
  var missingInNeon = [], countMismatch = [], extraInNeon = [];
  var dates = {};
  Object.keys(sheetCounts || {}).forEach(function (d) { dates[d] = true; });
  Object.keys(neonCounts || {}).forEach(function (d) { dates[d] = true; });
  Object.keys(dates).sort().forEach(function (d) {
    var s = Number((sheetCounts || {})[d]) || 0;
    var n = Number((neonCounts || {})[d]) || 0;
    if (s > 0 && n === 0)      missingInNeon.push({ date: d, sheetRows: s });
    else if (s === 0 && n > 0) extraInNeon.push({ date: d, neonRows: n });
    else if (s > 0 && n > 0 && s !== n) countMismatch.push({ date: d, sheetRows: s, neonRows: n });
  });
  return { missingInNeon: missingInNeon, countMismatch: countMismatch, extraInNeon: extraInNeon };
}

/**
 * Pure: weekdays (Mon–Fri) in [fromIso..toIso] that have ZERO rows in
 * `counts`, skipping company holidays (holidayFn) and days before
 * `floorIso` (capture start; null floor = no rows at all → every eligible
 * weekday is a gap, which correctly reads as "capture never ran").
 */
function ncExpectedWeekdayGaps_(fromIso, toIso, counts, floorIso, holidayFn) {
  var out = [];
  var fp = String(fromIso || '').split('-');
  var tp = String(toIso || '').split('-');
  if (fp.length !== 3 || tp.length !== 3) return out;
  var cur = new Date(+fp[0], +fp[1] - 1, +fp[2], 12);
  var end = new Date(+tp[0], +tp[1] - 1, +tp[2], 12);
  var guard = 0;
  while (cur <= end && guard++ < 400) {
    var dow = cur.getDay();
    var iso = cur.getFullYear() + '-' + ('0' + (cur.getMonth() + 1)).slice(-2)
            + '-' + ('0' + cur.getDate()).slice(-2);
    var eligible = dow >= 1 && dow <= 5
      && (!floorIso || iso >= floorIso)
      && !(holidayFn && holidayFn(iso));
    if (eligible && !((counts || {})[iso] > 0)) out.push(iso);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// ── Data reads ──────────────────────────────────────────────────────────

/**
 * Per-date row counts from a historical sheet's date column, limited to the
 * window. Reads the ONE column as display values (INV-02/F-3 discipline —
 * date cells coerce; ISO-normalize the display string). Returns null when
 * the sheet is missing (caller reports 'skipped').
 */
function ncSheetDateCounts_(ss, sheetName, dateCol, fromIso, toIso) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  var counts = {};
  if (lastRow < 2) return counts;
  var vals = sheet.getRange(2, dateCol, lastRow - 1, 1).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    var iso = ncCellDateIso_(vals[i][0]);
    if (iso && iso >= fromIso && iso <= toIso) counts[iso] = (counts[iso] || 0) + 1;
  }
  return counts;
}

/** Per-date row counts from a Neon table over the window — one json_agg fetch. */
function ncNeonDateCounts_(conn, table, fromIso, toIso) {
  var sql = "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
          + 'SELECT call_date::text AS d, COUNT(*) AS n FROM ' + table
          + ' WHERE call_date BETWEEN ?::date AND ?::date GROUP BY 1) t';
  var stmt = conn.prepareStatement(sql);
  stmt.setString(1, fromIso);
  stmt.setString(2, toIso);
  var rs = stmt.executeQuery();
  var json = rs.next() ? rs.getString('j') : '[]';
  rs.close(); stmt.close();
  var counts = {};
  (JSON.parse(json || '[]') || []).forEach(function (r) {
    if (r && r.d) counts[String(r.d).trim()] = Number(r.n) || 0;
  });
  return counts;
}

/** MIN(call_date) for a table as ISO, or null (empty table / no capture). */
function ncNeonMinDate_(conn, table) {
  var stmt = conn.createStatement();
  var rs = stmt.executeQuery('SELECT MIN(call_date)::text AS d FROM ' + table);
  var d = rs.next() ? rs.getString('d') : null;
  rs.close(); stmt.close();
  return d ? String(d).trim() : null;
}

// ── Outcome recording + email ───────────────────────────────────────────

function ncRecord_(result) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('NEON_COVERAGE_LAST', new Date().toISOString());
    props.setProperty('NEON_COVERAGE_LAST_RESULT', String(result).slice(0, 2000));
  } catch (e) { /* best-effort */ }
}

/** Emails the admins the run's findings (or the all-clear). Best-effort. */
function ncEmailResult_(out, summary) {
  try {
    var to = getAdminEmails_().join(',');
    if (!to) return;
    var lines = [];
    (out.tables || []).forEach(function (t) {
      if (t.skipped) { lines.push(t.table + ' ← ' + t.sheet + ': skipped (' + t.skipped + ')'); return; }
      var n = t.missingInNeon.length + t.countMismatch.length + t.extraInNeon.length;
      if (!n) { lines.push(t.table + ' ← ' + t.sheet + ': clean'); return; }
      lines.push(t.table + ' ← ' + t.sheet + ': ' + n + ' finding(s) — fix: ' + t.fix);
      t.missingInNeon.forEach(function (f) { lines.push('    MISSING IN NEON  ' + f.date + '  (sheet has ' + f.sheetRows + ' row(s))'); });
      t.countMismatch.forEach(function (f) { lines.push('    COUNT MISMATCH   ' + f.date + '  sheet ' + f.sheetRows + ' vs neon ' + f.neonRows); });
      t.extraInNeon.forEach(function (f) { lines.push('    EXTRA IN NEON    ' + f.date + '  (' + f.neonRows + ' phantom row(s), no sheet rows)'); });
    });
    (out.noSheet || (out.inbound ? [out.inbound] : [])).forEach(function (ns) {
      if (ns.skipped) { lines.push(ns.table + ' (no sheet primary): skipped (' + ns.skipped + ')'); return; }
      var ibm = ns.zeroRowWeekdays || [];
      if (!ibm.length) {
        lines.push(ns.table + ' (no sheet primary): clean — every eligible weekday has rows'
          + (ns.captureStart ? ' (capture since ' + ns.captureStart + ')' : ''));
      } else {
        lines.push(ns.table + ' (no sheet primary): ' + ibm.length + ' zero-row weekday(s) — fix: ' + ns.fix);
        lines.push('    ' + ibm.join(', '));
      }
    });
    (out.errors || []).forEach(function (e) { lines.push('PROBE ERROR: ' + e); });
    if (lines.length > NEON_COVERAGE_MAX_EMAIL_LINES) {
      lines = lines.slice(0, NEON_COVERAGE_MAX_EMAIL_LINES);
      lines.push('… detail truncated; run runNeonCoverageCheck() in the editor for the full object.');
    }
    MailApp.sendEmail({
      to: to,
      subject: '[Dashboard] Neon coverage check: '
        + (out.findings ? (out.findings + ' finding(s)') : (out.errors && out.errors.length ? 'probe errors' : 'clean'))
        + ' (' + out.from + '..' + out.to + ')',
      body: 'Per-date sheet-vs-Neon coverage over ' + out.from + '..' + out.to + ':\n\n'
        + lines.join('\n') + '\n\n'
        + 'Summary: ' + summary + '\n'
        + 'Findings also surface on the Health page ("Neon coverage — last check").\n'
        + 'All fixes are the existing idempotent re-import / backfill paths — this check never writes.',
    });
  } catch (e) {
    Logger.log('ncEmailResult_ failed: ' + (e && e.message ? e.message : e));
  }
}
