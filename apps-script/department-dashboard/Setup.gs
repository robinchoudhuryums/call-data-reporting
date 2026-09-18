/**
 * One-time / idempotent setup. Run once from the Apps Script editor's
 * "Run" dropdown after first deploy: select setup, click Run.
 *
 * Creates these sheets in the CDR Report spreadsheet if missing:
 *   - Access Control        (manager -> dept mapping)
 *   - Alert Config          (low-answer-rate alert thresholds + recipients)
 *   - Alert Log             (history of alert checks / sends)
 *   - Pipeline Health       (append-only telemetry: autoImport, buildDQE,
 *                            neonWrite success/failure with row counts and
 *                            durations)
 *   - Digest Config         (manager digest subscribers: email | dept |
 *                            cadence | active | notes)
 *   - Agent Alias Overrides (persistent rename map read by the build
 *                            script's canonicalization step)
 *   - Orphan Fix Log        (append-only audit trail of admin-driven
 *                            orphan fixes: alias adds + backfill renames)
 *   - Dept Config           (admin-authored, no-redeploy overrides for
 *                            DEPT_QCD_QUEUES / OVERVIEW_PARENT_OF /
 *                            TEAM_AVG_EXCLUDES; edited via the Dept
 *                            Config admin modal)
 *   - Report Usage          (append-only telemetry of report opens --
 *                            the INV-01 telemetry carve-out; feeds the
 *                            report-consolidation decisions)
 *   - Queue Report Subscribers (opt-in list for the automated Daily
 *                            Call Queue Report email -- QueueReportEmail.gs,
 *                            Operator State #31)
 *   - Company Holidays      (H1: the operator-curated "company is closed"
 *                            list, one range per row; the PRIMARY source
 *                            behind getCompanyHolidayRanges_, with the
 *                            COMPANY_HOLIDAYS Script Property as fallback;
 *                            also read by team-tools -- Operator State #27/#68)
 * *   - Dashboard Standards   (H2: the dashboard's RESOLVED answer target /
 *                            amber band / team-avg excludes per dept, a
 *                            PUBLISHED serialization for external readers
 *                            (team-tools) that the dashboard never reads
 *                            itself; rewritten here and by the standards /
 *                            Dept Config editors -- Operator State #37/#68)
 *
 * Safe to re-run; existing sheets keep every row (no data overwritten);
 * only BLANK header cells are filled in (OD-8, `healSheetHeaders_` below).
 *
 * After running, populate Access Control with manager emails and
 * Alert Config with one row per dept that should receive alerts.
 *
 * Note: queue extensions are parsed inline from the DO NOT EDIT!
 * roster cells (format "Name, ext1, ext2"). The earlier-planned
 * "Department Queues" sheet is not used.
 */
function setup() {
  assertAdmin_();
  const ss = openSpreadsheet_();
  // One spec per managed sheet. Iterated so a transient failure on one
  // (e.g. the "Service Spreadsheets timed out" the operator hit after a
  // sheet was created) is CAUGHT + logged and the loop CONTINUES to the
  // rest, rather than aborting and leaving later sheets uncreated. Each
  // create is followed by SpreadsheetApp.flush() so its write is committed
  // before the next insertSheet -- a slow create can't pile pending ops onto
  // the following one. Idempotent: re-running skips the ones that exist and
  // creates whatever a prior partial run missed.
  const specs = [
    [SHEETS.ACCESS_CONTROL,        ACCESS_CONTROL_HEADERS],
    [SHEETS.ALERT_CONFIG,          ALERT_CONFIG_HEADERS],
    [SHEETS.ALERT_LOG,             ALERT_LOG_HEADERS],
    [SHEETS.PIPELINE_HEALTH,       PIPELINE_HEALTH_HEADERS],
    [SHEETS.DIGEST_CONFIG,         DIGEST_CONFIG_HEADERS],
    [SHEETS.AGENT_ALIAS_OVERRIDES, AGENT_ALIAS_OVERRIDES_HEADERS],
    [SHEETS.ORPHAN_FIX_LOG,        ORPHAN_FIX_LOG_HEADERS],
    [SHEETS.DEPT_CONFIG,           DEPT_CONFIG_HEADERS],
    [SHEETS.REPORT_USAGE,          REPORT_USAGE_HEADERS],
    [SHEETS.QUEUE_REPORT_SUBSCRIBERS, QUEUE_REPORT_SUBSCRIBERS_HEADERS],
    // H1: the Dates column is plain-text pinned AT CREATION (third element =
    // 1-based text columns) -- Sheets coerces a lone `2026-12-25` to a Date
    // value, the comma-joined-cell class from Common Gotchas. The reader
    // tolerates a coerced cell too, but a pinned column never produces one.
    [SHEETS.COMPANY_HOLIDAYS,      COMPANY_HOLIDAYS_HEADERS, [1]],
    // H2: Team Avg Excludes is comma-joined names -- text-pinned like col A above.
    [SHEETS.DASHBOARD_STANDARDS,   DASHBOARD_STANDARDS_HEADERS, [4]],
  ];
  const failed = [];
  specs.forEach(function (spec) {
    try {
      ensureSheet_(ss, spec[0], spec[1], spec[2]);
      SpreadsheetApp.flush();
    } catch (e) {
      failed.push(spec[0]);
      Logger.log('Setup: sheet "%s" failed: %s -- continuing; re-run setup() to retry (idempotent).',
        spec[0], (e && e.message) ? e.message : e);
    }
  });
  // H2: (re)publish the resolved display standards into the sheet just
  // ensured -- setup() is the one write path an operator re-runs after a
  // pull, so a roster dept added since the last publish lands here.
  // Best-effort: a publish failure is logged, never fails setup.
  const pub = publishDashboardStandards_();
  if (!pub.ok) {
    Logger.log('Setup: Dashboard Standards NOT published: %s (the Health page dashboard-standards row will say so).', pub.error);
  } else {
    Logger.log('Setup: Dashboard Standards published (%s rows).', pub.rows);
  }
  if (failed.length) {
    Logger.log('Setup finished WITH ERRORS on: %s. Re-run setup() to create the rest.', failed.join(', '));
  } else {
    Logger.log('Setup complete.');
  }
}

/**
 * Creates a sheet with the given headers if missing. If the sheet already
 * exists its ROWS are never touched, but its HEADER row is HEALED (OD-8,
 * 2026-09-17): a column appended to a schema after the sheet was created
 * (Access Control's Role / Agent Name, Dept Config's Inbound queue aliases /
 * Final dept labels) used to stay header-less forever, because setup() only
 * wrote headers on CREATE and the Health page checks presence only. Healing
 * = widen the grid if narrower (REP-10) and fill BLANK header cells from the
 * schema; a NON-blank cell that differs from the schema is left alone and
 * logged (an operator relabel is not a defect, and INV-12 says setup() never
 * overwrites). The `acEnsureSchema_` pattern (Auth.gs), generalized.
 * `textCols` (optional, 1-based) are plain-text (`@`) pinned below the header
 * ONCE, at creation -- the team-tools getOrCreateQaSheet_ shape: a column that
 * holds date-shaped or comma-joined strings must never be coerced on entry,
 * and pinning at creation is cheaper than re-formatting before every write.
 */
function ensureSheet_(ss, name, headers, textCols) {
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    const heal = healSheetHeaders_(sheet, headers);
    Logger.log('Sheet "%s" already exists, skipping%s%s.', name,
      heal.healed.length ? ' (healed blank header(s): ' + heal.healed.join(', ') + ')' : '',
      heal.differing.length ? ' (left as-is, differs from schema: ' + heal.differing.join(', ') + ')' : '');
    return sheet;
  }
  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#f3f4f6');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
  (textCols || []).forEach(function (col) {
    const rows = Math.max(sheet.getMaxRows() - 1, 1);
    sheet.getRange(2, col, rows, 1).setNumberFormat('@');
  });
  Logger.log('Created sheet "%s".', name);
  return sheet;
}

/**
 * OD-8: fills BLANK header cells of an existing managed sheet from `headers`
 * (widening the grid first when it is narrower than the schema). Non-blank
 * cells are never rewritten -- they are reported in `differing` when they do
 * not match the schema. Idempotent. Returns { healed: [...], differing: [...] }.
 */
function healSheetHeaders_(sheet, headers) {
  const want = headers.length;
  const out = { healed: [], differing: [] };
  if (sheet.getMaxColumns() < want) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), want - sheet.getMaxColumns());
  }
  const have = sheet.getRange(1, 1, 1, want).getValues()[0];
  for (let i = 0; i < want; i++) {
    const cur = String(have[i] == null ? '' : have[i]).trim();
    if (cur === '') {
      sheet.getRange(1, i + 1).setValue(headers[i]);
      out.healed.push(headers[i]);
    } else if (cur !== headers[i]) {
      out.differing.push('col ' + (i + 1) + ' "' + cur + '" (schema: "' + headers[i] + '")');
    }
  }
  return out;
}
