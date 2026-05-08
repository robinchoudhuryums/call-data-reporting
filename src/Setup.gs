/**
 * One-time / idempotent setup. Run once from the Apps Script editor's
 * "Run" dropdown after first deploy: select setup, click Run.
 *
 * Creates the Access Control and Department Queues sheets in the CDR
 * Report spreadsheet if they don't exist. Safe to re-run; existing
 * sheets are left untouched (no data overwritten).
 *
 * After running, populate Access Control with manager emails and
 * Department Queues with the queue extensions per department.
 */
function setup() {
  const ss = openSpreadsheet_();

  ensureSheet_(ss, SHEETS.ACCESS_CONTROL, ACCESS_CONTROL_HEADERS);
  ensureSheet_(ss, SHEETS.DEPT_QUEUES, DEPT_QUEUES_HEADERS);

  Logger.log(
    'Setup complete. Verified sheets: "%s", "%s".',
    SHEETS.ACCESS_CONTROL, SHEETS.DEPT_QUEUES
  );
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
