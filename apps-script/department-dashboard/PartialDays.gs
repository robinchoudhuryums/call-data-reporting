/**
 * Partial Days editor (P7, owner 2026-11-16, Operator State #94).
 *
 * A partial day is an AGENT's day that should count as less than a whole day
 * in the per-day figures: they left early, were in training, sat in a
 * meeting. Marking it changes ONE thing -- the divisor of answered per day and
 * outbound per day (rule A). The agent's calls stay, and no total or rate
 * moves. The list lives in the `Partial Days` sheet; the reader, the credit
 * lookup and the cache tag are in Util.gs (getPartialDays_,
 * partialDayCredit_, partialDaysTag_).
 *
 * The three public calls here are the INV-01 admin config carve-out: every one
 * starts with assertAdmin_(), validates, serializes on the script lock, stamps
 * Added By / At, neutralizes formula text (sheetSafeCell_), busts the list's
 * cache, and leaves a usage row. Nothing else writes the sheet.
 *
 * The REASON never leaves this editor: report payloads carry the date and the
 * credit only, so a manager or an agent sees that a day is marked, not why.
 */

/** Every row for the editor, newest first. */
function readPartialDayRows_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.PARTIAL_DAYS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  let tz = null;
  try { tz = ss.getSpreadsheetTimeZone(); } catch (e) { tz = null; }
  const width = Math.min(Math.max(sheet.getMaxColumns(), 1), PARTIAL_DAYS_HEADERS.length);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const out = [];
  rows.forEach(function (r) {
    const d = partialDayFromRow_(r, tz);
    if (!d) return;
    const at = r[5] instanceof Date ? r[5].toISOString() : String(r[5] == null ? '' : r[5]);
    out.push({ date: d.date, agent: d.agent, credit: d.credit, reason: d.reason,
      addedBy: String(r[4] == null ? '' : r[4]), addedAt: at });
  });
  out.sort(function (a, b) {
    return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.agent < b.agent ? -1 : (a.agent > b.agent ? 1 : 0)));
  });
  return out;
}

/** dept -> its roster names, for the editor's agent picker (and the save's check). */
function partialDayRosters_() {
  const out = {};
  getAllDepartments_().forEach(function (d) {
    let names = [];
    try { names = (getRosterForDepartment_(d).names || []).slice(); } catch (e) { names = []; }
    out[d] = names.sort();
  });
  return out;
}

function getPartialDaysInit() {
  assertAdmin_();
  return { days: readPartialDayRows_(), rosters: partialDayRosters_(),
    credits: PARTIAL_DAY_CREDITS_.slice(), reasons: PARTIAL_DAY_REASONS_.slice() };
}

/**
 * Add or update the mark for (req.date, req.agent) -- one row per pair:
 * { date: 'YYYY-MM-DD', agent: roster name, credit: 0|0.25|0.5|0.75, reason }.
 */
function savePartialDay(req) {
  assertAdmin_();
  const date = String((req && req.date) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T12:00:00Z').getTime())) {
    throw new Error('Choose a date.');
  }
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (date > today) throw new Error('A partial day is one that has already happened -- choose today or earlier.');
  const agent = String((req && req.agent) || '').trim();
  if (!agent) throw new Error('Choose an agent.');
  const rosters = partialDayRosters_();
  let onRoster = false;
  Object.keys(rosters).forEach(function (d) { if (rosters[d].indexOf(agent) !== -1) onRoster = true; });
  if (!onRoster) throw new Error('"' + agent + '" is not on any department roster (the name must match the roster exactly).');
  const credit = Number(req && req.credit);
  if (!(req && req.credit !== '' && req.credit != null) || PARTIAL_DAY_CREDITS_.indexOf(credit) === -1) {
    throw new Error('Choose how much of the day counts: ' + PARTIAL_DAY_CREDITS_.join(', ') + '.');
  }
  const reason = String((req && req.reason) || '').trim();
  if (PARTIAL_DAY_REASONS_.indexOf(reason) === -1) {
    throw new Error('Choose a reason: ' + PARTIAL_DAY_REASONS_.join(', ') + '.');
  }
  const user = (Session.getActiveUser().getEmail() || '').toLowerCase();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Busy — please retry.');
  try {
    const ss = openSpreadsheet_();
    let sheet = ss.getSheetByName(SHEETS.PARTIAL_DAYS);
    if (!sheet) {
      sheet = ss.insertSheet(SHEETS.PARTIAL_DAYS);
      sheet.appendRow(PARTIAL_DAYS_HEADERS.slice());
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');   // the Date column, as setup() pins it
    }
    let tz = null;
    try { tz = ss.getSpreadsheetTimeZone(); } catch (e) { tz = null; }
    let found = -1;
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const cols = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
      for (let i = 0; i < cols.length; i++) {
        const d = exceptionDayFromRow_([cols[i][0], '', '', ''], tz);
        if (d && d.date === date && String(cols[i][1] == null ? '' : cols[i][1]).trim() === agent) { found = i + 2; break; }
      }
    }
    const rowVals = [date, sheetSafeCell_(agent), credit, reason, sheetSafeCell_(user), new Date().toISOString()];
    if (found > 0) sheet.getRange(found, 1, 1, rowVals.length).setValues([rowVals]);
    else sheet.appendRow(rowVals);
    bustPartialDaysCache_();
    Logger.log('Partial day %s / %s saved by %s: credit=%s reason=%s', date, agent, user, credit, reason);
  } finally {
    lock.releaseLock();
  }
  // The audit row names the date and the credit, never the agent's reason.
  try { logReportUsage_('partialDays:save', date + ' x' + credit, resolveUser_(Session.getActiveUser().getEmail()), false); } catch (eU) {}
  return getPartialDaysInit();
}

/** Remove the mark for (req.date, req.agent) -- the day counts as a whole day again. */
function removePartialDay(req) {
  assertAdmin_();
  const date = String((req && req.date) || '').trim();
  const agent = String((req && req.agent) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a date.');
  if (!agent) throw new Error('Choose an agent.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Busy — please retry.');
  let removed = 0;
  try {
    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.PARTIAL_DAYS);
    if (sheet && sheet.getLastRow() >= 2) {
      let tz = null;
      try { tz = ss.getSpreadsheetTimeZone(); } catch (e) { tz = null; }
      const cols = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
      for (let i = cols.length - 1; i >= 0; i--) {
        const d = exceptionDayFromRow_([cols[i][0], '', '', ''], tz);
        if (d && d.date === date && String(cols[i][1] == null ? '' : cols[i][1]).trim() === agent) { sheet.deleteRow(i + 2); removed++; }
      }
    }
    bustPartialDaysCache_();
  } finally {
    lock.releaseLock();
  }
  try { logReportUsage_('partialDays:remove', date, resolveUser_(Session.getActiveUser().getEmail()), false); } catch (eU) {}
  const out = getPartialDaysInit();
  out.removed = removed;
  return out;
}
