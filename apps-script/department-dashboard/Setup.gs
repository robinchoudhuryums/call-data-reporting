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
  const ss = openSpreadsheet_();
  ensureSheet_(ss, SHEETS.ACCESS_CONTROL,        ACCESS_CONTROL_HEADERS);
  ensureSheet_(ss, SHEETS.ALERT_CONFIG,          ALERT_CONFIG_HEADERS);
  ensureSheet_(ss, SHEETS.ALERT_LOG,             ALERT_LOG_HEADERS);
  ensureSheet_(ss, SHEETS.PIPELINE_HEALTH,       PIPELINE_HEALTH_HEADERS);
  ensureSheet_(ss, SHEETS.DIGEST_CONFIG,         DIGEST_CONFIG_HEADERS);
  ensureSheet_(ss, SHEETS.AGENT_ALIAS_OVERRIDES, AGENT_ALIAS_OVERRIDES_HEADERS);
  ensureSheet_(ss, SHEETS.ORPHAN_FIX_LOG,        ORPHAN_FIX_LOG_HEADERS);
  Logger.log('Setup complete.');
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
