/**
 * Exception Days editor (owner 2026-10-22, Operator State #81).
 *
 * An exception day is a day whose call data is REAL but unfair to judge by --
 * the 09/21/26 8x8 outage is the case that asked for it. Every windowed figure
 * (counts as well as rates, so the numbers on a screen keep reconciling) leaves
 * it out, every report says so, and an admin can switch the exclusion off to
 * compare. The list lives in the `Exception Days` sheet; the reader, the
 * exclusion step and the cache tag are in Util.gs (getExceptionDays_,
 * applyExceptionDays_, exceptionDaysTag_).
 *
 * The three public calls here are the INV-01 admin config carve-out: every one
 * starts with assertAdmin_(), validates, serializes on the script lock, stamps
 * Added By / At, neutralizes formula text (sheetSafeCell_), busts the list's
 * cache, and leaves a usage row. Nothing else writes the sheet.
 */

var EXCEPTION_REASON_MAX_ = 200;

/** Every row (inactive included) for the editor, newest first. */
function readExceptionDayRows_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.EXCEPTION_DAYS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  let tz = null;
  try { tz = ss.getSpreadsheetTimeZone(); } catch (e) { tz = null; }
  const width = Math.min(Math.max(sheet.getMaxColumns(), 1), EXCEPTION_DAYS_HEADERS.length);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const out = [];
  rows.forEach(function (r) {
    const asActive = r.slice();
    asActive[3] = '';   // parse the date / departments even for a parked row
    const d = exceptionDayFromRow_(asActive, tz);
    if (!d) return;
    const act = r[3];
    const at = r[5] instanceof Date ? r[5].toISOString() : String(r[5] == null ? '' : r[5]);
    out.push({ date: d.date, depts: d.depts, reason: d.reason,
      active: !(act === false || /^(false|no|0)$/i.test(String(act == null ? '' : act).trim())),
      addedBy: String(r[4] == null ? '' : r[4]), addedAt: at });
  });
  out.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return out;
}

function getExceptionDaysInit() {
  assertAdmin_();
  return { days: readExceptionDayRows_(), departments: getAllDepartments_() };
}

/**
 * Add or update the exception day for `req.date` (one row per date):
 * { date: 'YYYY-MM-DD', departments: [] (all) | [names], reason, active }.
 */
function saveExceptionDay(req) {
  assertAdmin_();
  const date = String((req && req.date) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T12:00:00Z').getTime())) {
    throw new Error('Choose a date.');
  }
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (date > today) throw new Error('An exception day is one that has already happened -- choose today or earlier.');
  const reason = String((req && req.reason) || '').trim();
  if (!reason) throw new Error('Say why this day is excluded (for example "8x8 outage") -- every report shows it.');
  if (reason.length > EXCEPTION_REASON_MAX_) throw new Error('Keep the reason to ' + EXCEPTION_REASON_MAX_ + ' characters.');
  const known = {};
  getAllDepartments_().forEach(function (d) { known[d] = true; });
  const depts = [];
  ((req && req.departments) || []).forEach(function (d) {
    const n = String(d || '').trim();
    if (!n) return;
    if (!known[n]) throw new Error('"' + n + '" is not a department on the roster.');
    if (depts.indexOf(n) === -1) depts.push(n);
  });
  const active = !(req && (req.active === false || req.active === 'false'));
  const user = (Session.getActiveUser().getEmail() || '').toLowerCase();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Busy — please retry.');
  try {
    const ss = openSpreadsheet_();
    let sheet = ss.getSheetByName(SHEETS.EXCEPTION_DAYS);
    if (!sheet) {
      sheet = ss.insertSheet(SHEETS.EXCEPTION_DAYS);
      sheet.appendRow(EXCEPTION_DAYS_HEADERS.slice());
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');   // the Date column, as setup() pins it
    }
    let tz = null;
    try { tz = ss.getSpreadsheetTimeZone(); } catch (e) { tz = null; }
    let found = -1;
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const col = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < col.length; i++) {
        const d = exceptionDayFromRow_([col[i][0], '', '', ''], tz);
        if (d && d.date === date) { found = i + 2; break; }
      }
    }
    const rowVals = [date, depts.join(', '), sheetSafeCell_(reason), active ? 'TRUE' : 'FALSE',
      sheetSafeCell_(user), new Date().toISOString()];
    if (found > 0) sheet.getRange(found, 1, 1, rowVals.length).setValues([rowVals]);
    else sheet.appendRow(rowVals);
    bustExceptionDaysCache_();
    Logger.log('Exception day %s saved by %s: depts=%s active=%s reason=%s', date, user, depts.join('|') || 'ALL', active, reason);
  } finally {
    lock.releaseLock();
  }
  try { logReportUsage_('exceptionDays:save', depts.length ? depts.join(', ') : 'ALL', resolveUser_(), false); } catch (eU) {}
  return getExceptionDaysInit();
}

/** Remove the exception day for `req.date` -- its data counts again everywhere. */
function removeExceptionDay(req) {
  assertAdmin_();
  const date = String((req && req.date) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a date.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Busy — please retry.');
  let removed = 0;
  try {
    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.EXCEPTION_DAYS);
    if (sheet && sheet.getLastRow() >= 2) {
      let tz = null;
      try { tz = ss.getSpreadsheetTimeZone(); } catch (e) { tz = null; }
      const col = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
      for (let i = col.length - 1; i >= 0; i--) {
        const d = exceptionDayFromRow_([col[i][0], '', '', ''], tz);
        if (d && d.date === date) { sheet.deleteRow(i + 2); removed++; }
      }
    }
    bustExceptionDaysCache_();
  } finally {
    lock.releaseLock();
  }
  try { logReportUsage_('exceptionDays:remove', date, resolveUser_(), false); } catch (eU) {}
  const out = getExceptionDaysInit();
  out.removed = removed;
  return out;
}
