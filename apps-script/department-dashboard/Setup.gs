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
 *
 * Safe to re-run; existing sheets are left untouched (no data
 * overwritten).
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
  ];
  const failed = [];
  specs.forEach(function (spec) {
    try {
      ensureSheet_(ss, spec[0], spec[1]);
      SpreadsheetApp.flush();
    } catch (e) {
      failed.push(spec[0]);
      Logger.log('Setup: sheet "%s" failed: %s -- continuing; re-run setup() to retry (idempotent).',
        spec[0], (e && e.message) ? e.message : e);
    }
  });
  if (failed.length) {
    Logger.log('Setup finished WITH ERRORS on: %s. Re-run setup() to create the rest.', failed.join(', '));
  } else {
    Logger.log('Setup complete.');
  }
}

/**
 * Creates a sheet with the given headers if missing. No-op if the
 * sheet already exists (we never overwrite existing rows).
 */
function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    Logger.log('Sheet "%s" already exists, skipping.', name);
    return sheet;
  }
  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#f3f4f6');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
  Logger.log('Created sheet "%s".', name);
  return sheet;
}
