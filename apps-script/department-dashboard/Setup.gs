/**
 * One-time / idempotent setup. Run once from the Apps Script editor's
 * "Run" dropdown after first deploy: select setup, click Run.
 *
 * Creates the Access Control sheet in the CDR Report spreadsheet if
 * it doesn't exist. Safe to re-run; existing sheets are left
 * untouched (no data overwritten).
 *
 * After running, populate Access Control with manager emails.
 *
 * Note: Step E onwards parses queue extensions inline from the
 * DO NOT EDIT! roster cells (cell format "Name, ext1, ext2"). The
 * earlier-planned "Department Queues" sheet is not used. If your
 * spreadsheet already has an auto-created Department Queues sheet
 * from a previous setup, you can safely delete it.
 */
function setup() {
  const ss = openSpreadsheet_();
  ensureSheet_(ss, SHEETS.ACCESS_CONTROL, ACCESS_CONTROL_HEADERS);
  Logger.log('Setup complete. Verified sheet: "%s".', SHEETS.ACCESS_CONTROL);
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
