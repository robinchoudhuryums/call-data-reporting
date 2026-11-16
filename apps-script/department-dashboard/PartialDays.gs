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
    credits: PARTIAL_DAY_CREDITS_.slice(), reasons: PARTIAL_DAY_REASONS_.slice(),
    // P9: the suggestions the admin dismissed ("that was a whole day").
    reviewed: readPartialDayReviewed_(), suggestDays: PARTIAL_SUGGEST_DAYS_ };
}

/**
 * P9: every row of the sheet that names a date and an agent, whatever its
 * credit -- `{ 'YYYY-MM-DD|agent': credit }`. A suggestion is never made for
 * a day that already has a row: a mark answers it, and a reviewed row (credit
 * 1, PARTIAL_DAY_REVIEWED_REASON_) is the admin saying "that was a whole day".
 */
function readPartialDayAnswered_() {
  const out = {};
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.PARTIAL_DAYS);
  if (!sheet || sheet.getLastRow() < 2) return out;
  let tz = null;
  try { tz = ss.getSpreadsheetTimeZone(); } catch (e) { tz = null; }
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.min(Math.max(sheet.getMaxColumns(), 1), 3)).getValues();
  rows.forEach(function (r) {
    const d = exceptionDayFromRow_([r[0], '', '', ''], tz);
    const agent = String(r[1] == null ? '' : r[1]).trim();
    const c = Number(r[2]);
    if (!d || !agent || r[2] === '' || r[2] == null || isNaN(c)) return;
    out[d.date + '|' + agent] = c;
  });
  return out;
}

/** P9: the reviewed rows (credit 1) for the editor, newest first -- { date, agent, addedBy, addedAt }. */
function readPartialDayReviewed_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.PARTIAL_DAYS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  let tz = null;
  try { tz = ss.getSpreadsheetTimeZone(); } catch (e) { tz = null; }
  const width = Math.min(Math.max(sheet.getMaxColumns(), 1), PARTIAL_DAYS_HEADERS.length);
  const out = [];
  sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues().forEach(function (r) {
    const d = exceptionDayFromRow_([r[0], '', '', ''], tz);
    const agent = String(r[1] == null ? '' : r[1]).trim();
    if (!d || !agent || Number(r[2]) !== 1) return;
    const at = r[5] instanceof Date ? r[5].toISOString() : String(r[5] == null ? '' : r[5]);
    out.push({ date: d.date, agent: agent, addedBy: String(r[4] == null ? '' : r[4]), addedAt: at });
  });
  out.sort(function (a, b) {
    return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.agent < b.agent ? -1 : (a.agent > b.agent ? 1 : 0)));
  });
  return out;
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

// ── P9: suggestions of likely partial days (owner plan 2026-11-13) ──────────
//
// The admin should not have to know which days to mark. The per-call tables
// record when each call started, so for every agent and day there is a FIRST
// and a LAST call time; a day whose span is much shorter than that agent's own
// usual span is a likely partial day. This only SUGGESTS: nothing is written
// until the admin marks the day (savePartialDay) or dismisses the suggestion
// (dismissPartialDaySuggestion). Read-only, admin-only.

/** PURE. Seconds after midnight (Pacific, as stored) -> 'H:MM' Central. */
function pdClockCst_(sec) {
  let s = Math.round(Number(sec) || 0) + 7200;   // stored journey times are Pacific
  if (s < 0) s = 0;
  const h = Math.floor(s / 3600) % 24, m = Math.floor((s % 3600) / 60);
  return h + ':' + (m < 10 ? '0' : '') + m;
}

/** PURE. The median of a list of numbers (0 for none). */
function pdMedian_(list) {
  const a = (list || []).slice().sort(function (x, y) { return x - y; });
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * PURE. The share a day's span suggests, against the agent's usual span:
 * the nearest quarter below a whole day, 0 for almost nothing, null when the
 * day is within an eighth of usual (not a suggestion). Values are exactly the
 * ones the editor can save (PARTIAL_DAY_CREDITS_).
 */
function pdSuggestedCredit_(spanHours, usualHours) {
  const u = Number(usualHours) || 0;
  if (!(u > 0)) return null;
  const r = (Number(spanHours) || 0) / u;
  if (r < 0.125) return 0;
  if (r < 0.375) return 0.25;
  if (r < 0.625) return 0.5;
  if (r < 0.875) return 0.75;
  return null;
}

/**
 * PURE. Suggestions from per-agent day spans.
 *   spans: [{ agent, date, first, last, n }] -- first / last in seconds after
 *          midnight (Pacific), n = calls seen that day.
 *   opts:  { isWorkday(iso), answered: { 'date|agent': credit }, minDays,
 *            minUsualHours, max }
 * An agent's USUAL span is the median over their workdays in the list -- the
 * median, so a few short days do not pull "usual" down to meet them. Returns
 * { suggestions: [{ date, agent, first, last, hours, usualHours, calls,
 * usualCalls, credit }], truncated, judged, skippedAgents } -- newest first.
 */
function partialDaySuggestionsFrom_(spans, opts) {
  opts = opts || {};
  const isWorkday = typeof opts.isWorkday === 'function' ? opts.isWorkday : function () { return true; };
  const answered = opts.answered || {};
  const minDays = opts.minDays != null ? opts.minDays : PARTIAL_SUGGEST_MIN_DAYS_;
  const minUsual = opts.minUsualHours != null ? opts.minUsualHours : PARTIAL_SUGGEST_MIN_USUAL_HOURS_;
  const max = opts.max != null ? opts.max : PARTIAL_SUGGEST_MAX_;
  const byAgent = {};
  (spans || []).forEach(function (sp) {
    if (!sp || !sp.agent || !sp.date || !isWorkday(sp.date)) return;
    const first = Number(sp.first), last = Number(sp.last);
    if (isNaN(first) || isNaN(last) || last < first) return;
    (byAgent[sp.agent] || (byAgent[sp.agent] = [])).push({
      date: sp.date, first: first, last: last, hours: (last - first) / 3600, n: Number(sp.n) || 0 });
  });
  const out = [];
  let judged = 0;
  const skippedAgents = [];
  Object.keys(byAgent).sort().forEach(function (agent) {
    const days = byAgent[agent];
    const usual = pdMedian_(days.map(function (d) { return d.hours; }));
    if (days.length < minDays || usual < minUsual) { skippedAgents.push(agent); return; }
    judged++;
    const usualCalls = pdMedian_(days.map(function (d) { return d.n; }));
    days.forEach(function (d) {
      if (answered[d.date + '|' + agent] != null) return;
      const credit = pdSuggestedCredit_(d.hours, usual);
      if (credit == null) return;
      out.push({ date: d.date, agent: agent, first: pdClockCst_(d.first), last: pdClockCst_(d.last),
        hours: Math.round(d.hours * 10) / 10, usualHours: Math.round(usual * 10) / 10,
        calls: d.n, usualCalls: Math.round(usualCalls), credit: credit });
    });
  });
  out.sort(function (a, b) {
    return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.agent < b.agent ? -1 : (a.agent > b.agent ? 1 : 0)));
  });
  return { suggestions: out.slice(0, max), truncated: out.length > max, judged: judged, skippedAgents: skippedAgents };
}

/** SQL: an 'HH:MM:SS' text column / expression as seconds after midnight. */
function pdSecSql_(expr) {
  return "((split_part(" + expr + ", ':', 1))::int * 3600 + (split_part(" + expr + ", ':', 2))::int * 60"
    + " + (split_part(" + expr + ", ':', 3))::int)";
}

/**
 * Per-agent day spans for `names` over [from, to], from the per-call tables:
 * every leg a named agent had on an inbound call (the stored journey), every
 * outbound call they placed, every direct call. Returns { ok, rows:
 * [[agent, date, first, last, n]], reason }. Aggregated in the database, so
 * what comes back is one small row per agent-day, never a call.
 */
function pdFetchAgentDaySpans_(names, from, to) {
  const out = { ok: false, rows: [], reason: '' };
  if (!names || !names.length) { out.ok = true; return out; }
  if (typeof getDashboardNeonConn_ !== 'function') { out.reason = 'The call-level tables are not set up on this install.'; return out; }
  const clock = "'^[0-9]{1,2}:[0-9]{2}:[0-9]{2}$'";
  const num = function (expr) { return "CASE WHEN (" + expr + ") ~ '^[0-9]+$' THEN (" + expr + ")::int ELSE 0 END"; };
  const namesJson = JSON.stringify(names);
  let conn = null;
  try {
    conn = getDashboardNeonConn_();
    if (!conn) { out.reason = 'The call-level tables could not be reached. Try again in a few minutes.'; return out; }
    const merged = {};
    const take = function (json) {
      JSON.parse(json || '[]').forEach(function (r) {
        const k = r[0] + '|' + r[1];
        const m = merged[k] || (merged[k] = [r[0], r[1], Number(r[2]), Number(r[3]), 0]);
        m[2] = Math.min(m[2], Number(r[2])); m[3] = Math.max(m[3], Number(r[3])); m[4] += Number(r[4]) || 0;
      });
    };
    // Inbound legs (the journey) + outbound calls.
    const st = conn.prepareStatement(
      "SELECT COALESCE(json_agg(json_build_array(agent, d, s0, e0, n)), '[]')::text AS j FROM ("
      + "SELECT e->>'name' AS agent, c.call_date::text AS d, min(" + pdSecSql_("e->>'t'") + ") AS s0, "
      +   "max(" + pdSecSql_("e->>'t'") + " + " + num("e->>'secs'") + " + " + num("e->>'talk'") + ") AS e0, count(*)::int AS n "
      + "FROM inbound_calls c, json_array_elements(CASE WHEN c.journey LIKE '[%' THEN c.journey::json ELSE '[]'::json END) e "
      + "WHERE c.call_date BETWEEN ?::date AND ?::date AND (e->>'t') ~ " + clock + " "
      +   "AND COALESCE(e->>'transfer', '') <> 'true' "
      +   "AND e->>'name' IN (SELECT json_array_elements_text(?::json)) GROUP BY 1, 2 "
      + "UNION ALL "
      + "SELECT agent_name, call_date::text, min(" + pdSecSql_('call_start') + "), "
      +   "max(" + pdSecSql_('call_start') + " + COALESCE(ring_seconds, 0) + COALESCE(talk_seconds, 0)), count(*)::int "
      + "FROM outbound_calls WHERE call_date BETWEEN ?::date AND ?::date AND call_start ~ " + clock + " "
      +   "AND agent_name IN (SELECT json_array_elements_text(?::json)) GROUP BY 1, 2) u");
    try { if (typeof st.setQueryTimeout === 'function') st.setQueryTimeout(90); } catch (te) { /* best-effort */ }
    st.setString(1, from); st.setString(2, to); st.setString(3, namesJson);
    st.setString(4, from); st.setString(5, to); st.setString(6, namesJson);
    const rs = st.executeQuery();
    const json = rs.next() ? rs.getString('j') : '[]';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'partialSuggest');
    rs.close(); st.close();
    take(json);
    // Direct calls: a separate statement, because the table exists only once
    // cdr-import has captured a day into it -- its absence must not cost the
    // inbound / outbound evidence above.
    try {
      const sd = conn.prepareStatement(
        "SELECT COALESCE(json_agg(json_build_array(agent, d, s0, e0, n)), '[]')::text AS j FROM ("
        + "SELECT agent_name AS agent, call_date::text AS d, min(" + pdSecSql_('call_start') + ") AS s0, "
        +   "max(" + pdSecSql_('call_start') + " + COALESCE(ring_sec, 0) + COALESCE(talk_sec, 0)) AS e0, count(*)::int AS n "
        + "FROM direct_calls WHERE call_date BETWEEN ?::date AND ?::date AND call_start ~ " + clock + " "
        +   "AND agent_name IN (SELECT json_array_elements_text(?::json)) GROUP BY 1, 2) u");
      try { if (typeof sd.setQueryTimeout === 'function') sd.setQueryTimeout(60); } catch (te2) { /* best-effort */ }
      sd.setString(1, from); sd.setString(2, to); sd.setString(3, namesJson);
      const rd = sd.executeQuery();
      const dj = rd.next() ? rd.getString('j') : '[]';
      if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(dj ? dj.length : 0, 'partialSuggest');
      rd.close(); sd.close();
      take(dj);
    } catch (eD) {
      Logger.log('[partial-days] direct_calls spans unavailable (suggestions use inbound + outbound only): %s', (eD && eD.message) || eD);
    }
    out.rows = Object.keys(merged).map(function (k) { return merged[k]; });
    out.ok = true;
  } catch (e) {
    out.reason = 'The call-level tables could not be read. Try again in a few minutes.';
    Logger.log('[partial-days] suggestion read failed: %s', (e && e.message) || e);
  } finally {
    try { if (conn) conn.close(); } catch (eC) { /* already closed */ }
  }
  return out;
}

/**
 * P9: likely partial days for one department's roster over the last
 * PARTIAL_SUGGEST_DAYS_ days. Admin-only, read-only -- nothing is marked here.
 *   req: { department }
 * Returns { available, reason?, department, from, to, suggestions, truncated,
 * judged, notJudged }.
 */
function getPartialDaySuggestions(req) {
  assertAdmin_();
  const dept = String((req && req.department) || '').trim();
  if (!dept || getAllDepartments_().indexOf(dept) === -1) throw new Error('Choose a department.');
  const names = (getRosterForDepartment_(dept).names || []).slice();
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const end = new Date(today + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() - 1);                       // through yesterday: today has not landed
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (PARTIAL_SUGGEST_DAYS_ - 1));
  const to = end.toISOString().slice(0, 10), from = start.toISOString().slice(0, 10);
  const base = { department: dept, from: from, to: to, suggestions: [], truncated: false, judged: 0, notJudged: [] };
  // P9 follow-on: how long the database read took rides in the payload (and
  // the log), so whether the read needs narrowing is a measured question --
  // it expands every inbound journey in the look-back, and its cost on the
  // production database was not known when it shipped.
  const t0 = Date.now();
  const read = pdFetchAgentDaySpans_(names, from, to);
  base.readMs = Date.now() - t0;
  try { Logger.log('[partial-days] suggestion read for %s: %s ms, %s agent-day row(s), ok=%s', dept, base.readMs, read.rows.length, read.ok); } catch (eL) {}
  if (!read.ok) return Object.assign(base, { available: false, reason: read.reason });
  const workdayMemo = {};
  const res = partialDaySuggestionsFrom_(read.rows.map(function (r) {
    return { agent: r[0], date: r[1], first: r[2], last: r[3], n: r[4] };
  }), {
    // A weekend, a company holiday or an exception day is not a day anyone
    // is expected to work a usual span on.
    isWorkday: function (iso) {
      if (workdayMemo[iso] == null) {
        workdayMemo[iso] = countWorkingDays_(iso, iso) === 1 && !exceptionDayFor_(iso, dept);
      }
      return workdayMemo[iso];
    },
    answered: readPartialDayAnswered_(),
  });
  try { logReportUsage_('partialDays:suggest', dept, resolveUser_(Session.getActiveUser().getEmail()), false); } catch (eU) {}
  return Object.assign(base, { available: true, suggestions: res.suggestions, truncated: res.truncated,
    judged: res.judged, notJudged: res.skippedAgents });
}

/**
 * P9: dismiss a suggestion -- "that was a whole day". Stores a row with
 * Credit 1 (not a mark: no figure and no cache key moves) so the suggestion
 * does not come back; removePartialDay un-dismisses it. A day that already
 * has a row is left exactly as it is.
 *   req: { date: 'YYYY-MM-DD', agent: roster name }
 */
function dismissPartialDaySuggestion(req) {
  assertAdmin_();
  const date = String((req && req.date) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T12:00:00Z').getTime())) throw new Error('Choose a date.');
  if (date > Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd')) throw new Error('That date has not happened yet.');
  const agent = String((req && req.agent) || '').trim();
  const rosters = partialDayRosters_();
  if (!agent || !Object.keys(rosters).some(function (d) { return rosters[d].indexOf(agent) !== -1; })) {
    throw new Error('"' + agent + '" is not on any department roster.');
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
      sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    }
    if (readPartialDayAnswered_()[date + '|' + agent] == null) {
      sheet.appendRow([date, sheetSafeCell_(agent), 1, PARTIAL_DAY_REVIEWED_REASON_, sheetSafeCell_(user), new Date().toISOString()]);
    }
  } finally {
    lock.releaseLock();
  }
  try { logReportUsage_('partialDays:reviewed', date, resolveUser_(Session.getActiveUser().getEmail()), false); } catch (eU) {}
  return getPartialDaysInit();
}
