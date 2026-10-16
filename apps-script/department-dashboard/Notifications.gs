/**
 * Notifications (owner plan Step 5a, 2026-10-16) -- ADMIN TRIAL.
 *
 * Three additions around the Low Answer Rate Alerts engine (Alerts.gs), all
 * admin-only until the owner tests and releases them:
 *
 *   1. "Would it have fired?" history -- for one department's rule, the last
 *      N workdays: that day's answer rate, whether the rule as it stands now
 *      would have fired, and what the Alert Log says actually happened.
 *      Read-only; one DQE read for the whole window (alertRowsForRange_).
 *   2. Test send -- the real alert email for a department and date, sent to
 *      the requesting admin ONLY (never a manager), logged as `test-sent`.
 *   3. The MANAGER LAYER -- a department's manager may set a STRICTER alert
 *      threshold than the admin's. "Stricter" means the rule fires on more
 *      days; NOTIFY_STRICTER_ names the direction per field (5b adds the
 *      coaching gates to it). The SERVER enforces it twice: a save that would
 *      loosen the admin's rule is refused, and at run time the stricter of
 *      the two values always applies (so an admin who later raises their own
 *      value past the manager's simply wins). Window length and schedule stay
 *      admin-only -- there is no manager field for them.
 *
 * The manager layer is BUILT BUT OFF: `NOTIFY_MANAGER_EDIT` (Script Property,
 * 'true' = on) is the release switch, flipped from the Notifications modal.
 * While it is off a manager's call is refused, no manager surface renders
 * (the user envelope's `notifyEdit` stays false) and stored manager values
 * are INERT -- the run loop applies the admin's threshold alone -- so the
 * trial cannot change what any manager receives until the owner releases it.
 *
 * Storage: `NOTIFY_MANAGER_RULES` (Script Property, JSON
 * `{ "<dept>": { "alertThreshold": 88, "by": email, "at": iso } }`), small
 * (one entry per dept, well under the 9 KB value cap). Written ONLY by
 * saveNotifyManagerRule: assertManagerOrAdmin_ + assertDeptAccess_ (the
 * INV-55 row-level dept gate) + the release switch for a manager + loud
 * validation + LockService + a Logger audit line and an append-only
 * `notify:manager-rule` usage row (INV-01's telemetry carve-out). No
 * spreadsheet is written by any function in this file except that usage row
 * and the Alert Log row of a test send (the engine's own append-only log).
 */

var NOTIFY_MANAGER_EDIT_PROP_  = 'NOTIFY_MANAGER_EDIT';
var NOTIFY_MANAGER_RULES_PROP_ = 'NOTIFY_MANAGER_RULES';
var NOTIFY_HISTORY_DAYS_DEFAULT_ = 20;
var NOTIFY_HISTORY_DAYS_MAX_     = 60;

// Which way is STRICTER for each manager-settable field ('higher' = a larger
// value fires/flags on more days). The one table both the save check and the
// run-time clamp read.
var NOTIFY_STRICTER_ = Object.freeze({
  alertThreshold: 'higher',   // "answer rate below X%": a higher X fires more
  // Step 5b, the coaching gates (Coaching.gs COACHING_GATE_FIELDS_): a flag
  // fires when the agent answers < ratio% as often as the team, >= N points
  // behind, with >= M missed rings -- so a higher ratio, fewer points and
  // fewer missed rings all flag MORE agents.
  coachRatioPct: 'higher',
  coachBehindPts: 'lower',
  coachMinMissed: 'lower',
});
// manager-layer field -> [the Coaching.gs gate it tightens, unit, min, max]
var NOTIFY_COACH_FIELDS_ = Object.freeze({
  coachRatioPct:  ['maxTeamRatioPct', '%', 5, 100],
  coachBehindPts: ['behindPts', ' pts', 0, 50],
  coachMinMissed: ['minMissed', ' missed', 1, 1000],
});

var NOTIFY_MANAGER_RULES_MEMO_ = null;   // per execution (var: the harness resets *MEMO* globals, F39)

/** PURE. The stricter of an admin value and a manager value for `field`.
 *  A missing manager value leaves the admin's; never returns the looser. */
function notifyStricterOf_(field, adminVal, mgrVal) {
  var dir = NOTIFY_STRICTER_[field];
  if (!dir) throw new Error('Unknown notification field: ' + field);
  var a = (adminVal === '' || adminVal == null) ? null : Number(adminVal);
  var m = (mgrVal === '' || mgrVal == null) ? null : Number(mgrVal);
  if (a == null || !isFinite(a)) return (m != null && isFinite(m)) ? m : null;
  if (m == null || !isFinite(m)) return a;
  return dir === 'higher' ? Math.max(a, m) : Math.min(a, m);
}

/** PURE. null when `val` is at least as strict as `adminVal`, else the
 *  sentence a manager reads ("only stricter: 85% or higher"). */
function notifyCheckStricter_(field, adminVal, val, unit) {
  var dir = NOTIFY_STRICTER_[field];
  if (!dir) return 'Unknown notification field: ' + field;
  var a = Number(adminVal), v = Number(val);
  if (!isFinite(a) || !isFinite(v)) return null;
  var ok = dir === 'higher' ? v >= a : v <= a;
  if (ok) return null;
  var u = unit || '';
  return 'Managers can only make this rule stricter: the admin\'s value is ' + a + u
    + ', so choose ' + a + u + ' or ' + (dir === 'higher' ? 'higher' : 'lower') + '.';
}

/** The release switch. */
function notifyManagerEditEnabled_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(NOTIFY_MANAGER_EDIT_PROP_) || '') === 'true';
  } catch (e) { return false; }   // fail CLOSED: the manager layer stays off
}

/** The stored manager layer, `{dept: {alertThreshold, by, at}}`. A malformed
 *  property reads as EMPTY (fail toward the admin's rules), never a throw. */
function readNotifyManagerRules_() {
  if (NOTIFY_MANAGER_RULES_MEMO_) return NOTIFY_MANAGER_RULES_MEMO_;
  var out = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(NOTIFY_MANAGER_RULES_PROP_);
    var obj = raw ? JSON.parse(raw) : {};
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      Object.keys(obj).forEach(function (dept) {
        var r = obj[dept];
        if (!r || typeof r !== 'object') return;
        var clean = {};
        Object.keys(NOTIFY_STRICTER_).forEach(function (f) {
          var v = Number(r[f]);
          if (r[f] !== '' && r[f] != null && isFinite(v)) clean[f] = v;
        });
        if (!Object.keys(clean).length) return;
        clean.by = String(r.by || '');
        clean.at = String(r.at || '');
        out[dept] = clean;
      });
    }
  } catch (e) {
    Logger.log('readNotifyManagerRules_: unreadable %s -- treated as empty: %s', NOTIFY_MANAGER_RULES_PROP_, e);
  }
  NOTIFY_MANAGER_RULES_MEMO_ = out;
  return out;
}

/** The manager's value for dept/field that APPLIES right now: null while the
 *  release switch is off (stored values are inert until release). */
function notifyAppliedManagerValue_(dept, field) {
  if (!notifyManagerEditEnabled_()) return null;
  var r = readNotifyManagerRules_()[dept];
  return (r && r[field] != null) ? r[field] : null;
}

/**
 * The alert threshold the engine applies for one Alert Config entry:
 * `{ threshold, admin, manager, source: 'admin'|'manager' }`. `manager` is the
 * APPLIED manager value (null while the switch is off).
 */
function alertEffectiveThreshold_(entry) {
  var admin = Number(entry && entry.threshold);
  var mgr = notifyAppliedManagerValue_(entry && entry.department, 'alertThreshold');
  var eff = notifyStricterOf_('alertThreshold', admin, mgr);
  return { threshold: eff, admin: admin, manager: mgr,
           source: (mgr != null && eff !== admin) ? 'manager' : 'admin' };
}

/** A shallow copy of an Alert Config entry carrying a different threshold
 *  (what the alert email states). */
function alertEntryWithThreshold_(entry, threshold) {
  var out = {};
  Object.keys(entry || {}).forEach(function (k) { out[k] = entry[k]; });
  out.threshold = threshold;
  return out;
}

/** PURE. The `n` workdays ending at `endIso` (stepped back off a weekend /
 *  holiday first), NEWEST first. `isHolidayFn` injected for tests. */
function notifyWorkdaysEnding_(endIso, n, isHolidayFn) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(endIso || ''));
  if (!m) return [];
  var isHol = isHolidayFn || function () { return false; };
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  var p = function (x) { return x < 10 ? '0' + x : String(x); };
  var out = [];
  for (var guard = 0; out.length < n && guard < n * 3 + 30; guard++) {
    var iso = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !isHol(iso)) out.push(iso);
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12);
  }
  return out;
}

/** The rules payload one viewer may see/edit: every dept they can reach
 *  (admin: all), each with its alert rule (null fields when the dept has no
 *  valid admin rule) -- admin value, stored + applied manager value, the
 *  effective threshold -- and (Step 5b) its coaching gates. */
function notifyRulesFor_(user) {
  var cfgByDept = {};
  readAlertConfig_().forEach(function (c) {
    if (c.duplicateRow || c.invalidThreshold || cfgByDept[c.department]) return;
    cfgByDept[c.department] = c;
  });
  var mgrRules = readNotifyManagerRules_();
  var enabled = notifyManagerEditEnabled_();
  var depts = user && user.role === 'admin' ? (getAllDepartments_() || [])
    : ((user && user.departments && user.departments.length) ? user.departments : [user && user.department]);
  var out = [];
  depts.forEach(function (dept) {
    if (!dept || !userCanAccessDept_(user, dept)) return;
    var c = cfgByDept[dept] || null;
    var stored = mgrRules[dept] || null;
    var eff = c ? alertEffectiveThreshold_(c) : null;
    var coaching = null;
    if (typeof coachingEffectiveGates_ === 'function') {
      try {
        var g = coachingEffectiveGates_(dept);
        coaching = { admin: g.admin, effective: g.effective, stored: {} };
        Object.keys(NOTIFY_COACH_FIELDS_).forEach(function (f) {
          if (stored && stored[f] != null) coaching.stored[NOTIFY_COACH_FIELDS_[f][0]] = stored[f];
        });
      } catch (e) { coaching = null; }
    }
    if (!c && !coaching) return;
    out.push({
      department: dept,
      hasAlert: !!c,
      active: c ? !!c.active : false,
      adminThreshold: c ? Number(c.threshold) : null,
      managerThreshold: stored && stored.alertThreshold != null ? stored.alertThreshold : null,
      managerBy: stored ? stored.by : '',
      managerAt: stored ? stored.at : '',
      effectiveThreshold: eff ? eff.threshold : null,
      effectiveSource: eff ? eff.source : 'admin',
      coaching: coaching,
    });
  });
  return { enabled: enabled, rules: out };
}

function notifyCurrentUser_() {
  return resolveUser_(Session.getActiveUser().getEmail());
}

/** A manager's (or admin's) gate for the manager layer. Admins always pass;
 *  a manager only once the layer is released. */
function notifyAssertCanEdit_(user) {
  assertManagerOrAdmin_(user);
  if (user.role !== 'admin' && !notifyManagerEditEnabled_()) {
    throw new Error('Notification settings are not available yet.');
  }
}

/**
 * RPC: the manager layer for the caller -- `{ enabled, rules: [...] }`.
 * Admin: every configured dept. Manager: their own dept(s), and only once
 * released (refused while NOTIFY_MANAGER_EDIT is off).
 */
function getNotifyRules() {
  var user = notifyCurrentUser_();
  notifyAssertCanEdit_(user);
  return notifyRulesFor_(user);
}

/**
 * RPC: set (or clear, with a blank value) a department's manager-layer
 * values. `req = { department, alertThreshold?, coachRatioPct?,
 * coachBehindPts?, coachMinMissed? }` -- only the fields PRESENT are changed.
 * Stricter-only: each is refused when it would fire / flag LESS than the
 * admin's value for that dept. All-or-nothing: every field is validated
 * before anything is written. Returns the caller's rules.
 */
function saveNotifyManagerRule(req) {
  var user = notifyCurrentUser_();
  notifyAssertCanEdit_(user);
  req = req || {};
  var dept = String(req.department || '').trim();
  if (!dept) throw new Error('Department is required.');
  assertDeptAccess_(user, dept);
  var changes = {};   // field -> number | null (clear)
  var present = Object.keys(NOTIFY_STRICTER_).filter(function (f) {
    return Object.prototype.hasOwnProperty.call(req, f);
  });
  if (!present.length) throw new Error('Nothing to save.');
  present.forEach(function (f) {
    var raw = req[f];
    if (raw === '' || raw == null) { changes[f] = null; return; }
    var adminVal, unit, lo, hi;
    if (f === 'alertThreshold') {
      var entry = readAlertConfig_().filter(function (c) { return c.department === dept && !c.duplicateRow; })[0];
      if (!entry || entry.invalidThreshold) {
        throw new Error('There is no alert rule for ' + dept + ' yet -- an admin sets the rule first.');
      }
      adminVal = Number(entry.threshold); unit = '%'; lo = 1; hi = 100;
    } else {
      if (typeof coachingAdminGates_ !== 'function') throw new Error('Coaching gates are not available.');
      var spec = NOTIFY_COACH_FIELDS_[f];
      adminVal = coachingAdminGates_(dept)[spec[0]]; unit = spec[1]; lo = spec[2]; hi = spec[3];
    }
    var val = Number(raw);
    if (!isFinite(val) || val < lo || val > hi || (f === 'alertThreshold' && val <= 0)) {
      throw new Error('That value must be a number from ' + lo + ' to ' + hi + '.');
    }
    val = f === 'coachMinMissed' ? Math.round(val) : Math.round(val * 10) / 10;
    var why = notifyCheckStricter_(f, adminVal, val, unit);
    if (why) throw new Error(why);
    changes[f] = val;
  });
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Busy -- please retry in a moment.');
  try {
    var props = PropertiesService.getScriptProperties();
    var cur = {};
    try { cur = JSON.parse(props.getProperty(NOTIFY_MANAGER_RULES_PROP_) || '{}') || {}; } catch (pe) { cur = {}; }
    if (typeof cur !== 'object' || Array.isArray(cur)) cur = {};
    var rec = cur[dept] || {};
    Object.keys(changes).forEach(function (f) {
      if (changes[f] == null) delete rec[f]; else rec[f] = changes[f];
    });
    var left = Object.keys(rec).filter(function (k) { return NOTIFY_STRICTER_[k]; });
    if (left.length) {
      rec.by = String(user.email || '');
      rec.at = new Date().toISOString();
      cur[dept] = rec;
    } else {
      delete cur[dept];
    }
    if (Object.keys(cur).length) props.setProperty(NOTIFY_MANAGER_RULES_PROP_, JSON.stringify(cur));
    else props.deleteProperty(NOTIFY_MANAGER_RULES_PROP_);
    NOTIFY_MANAGER_RULES_MEMO_ = null;
    Logger.log('saveNotifyManagerRule: %s %s by %s (%s)', dept, JSON.stringify(changes), user.email, user.role);
  } finally {
    lock.releaseLock();
  }
  logReportUsage_('notify:manager-rule', dept, user, false);
  return notifyRulesFor_(user);
}

/** RPC (admin): the release switch for the manager layer. */
function setNotifyManagerEdit(req) {
  assertAdmin_();
  var on = !!(req && req.enabled);
  var props = PropertiesService.getScriptProperties();
  if (on) props.setProperty(NOTIFY_MANAGER_EDIT_PROP_, 'true');
  else props.deleteProperty(NOTIFY_MANAGER_EDIT_PROP_);
  Logger.log('setNotifyManagerEdit: %s by %s', on ? 'ON' : 'off', Session.getActiveUser().getEmail());
  return { enabled: on };
}

/**
 * RPC (admin): would this department's rule, AS IT STANDS NOW, have fired on
 * each of the last `days` workdays? `req = { department, days }`. Each day
 * carries the answer rate the engine computes (same function, same roster,
 * same queue narrowing), the verdict, and the Alert Log's real outcome for
 * that date (newest non-preview row), so a rule change can be judged against
 * history before it is saved.
 */
function getAlertHistory(req) {
  assertAdmin_();
  req = req || {};
  var dept = String(req.department || '').trim();
  var entry = readAlertConfig_().filter(function (c) { return c.department === dept && !c.duplicateRow; })[0];
  if (!entry) throw new Error('No alert rule for ' + dept + '.');
  var n = Math.max(1, Math.min(NOTIFY_HISTORY_DAYS_MAX_, Math.floor(Number(req.days) || NOTIFY_HISTORY_DAYS_DEFAULT_)));
  var holidayFn = function (iso) { try { return isCompanyHoliday_(iso); } catch (e) { return false; } };
  var dates = notifyWorkdaysEnding_(prevBusinessDayIso_(new Date()), n, holidayFn);
  if (!dates.length) return { department: dept, days: [] };
  var eff = alertEffectiveThreshold_(entry);
  alertRowsForRange_(dates[dates.length - 1], dates[0]);   // ONE read; the per-date calls below hit the memo
  var roster = getRosterForDepartment_(dept);
  var logged = notifyAlertLogByDate_(dept, dates[dates.length - 1]);
  var fired = 0, assessed = 0;
  var days = dates.map(function (iso) {
    var row = { date: iso, rung: 0, answered: 0, missed: 0, pct: null, verdict: 'no-data',
                skipped: isDateInSkipRanges_(iso, entry.skipDates), logged: logged[iso] || null };
    if (entry.invalidThreshold) { row.verdict = 'invalid-rule'; return row; }
    try {
      var st = computeDeptAnswerRateForDate_(dept, iso, roster);
      row.rung = st.rung; row.answered = st.answered; row.missed = st.missed;
      if (st.rung > 0) {
        row.pct = round1_(st.pct);
        row.verdict = st.pct < eff.threshold ? 'would-fire' : 'quiet';
        if (!row.skipped) { assessed++; if (row.verdict === 'would-fire') fired++; }
      }
    } catch (e) {
      row.verdict = 'error';
      row.error = String(e && e.message || e).slice(0, 200);
    }
    return row;
  });
  return {
    department: dept,
    active: !!entry.active,
    threshold: eff.threshold, adminThreshold: eff.admin,
    managerThreshold: eff.manager, source: eff.source,
    managerLayerOn: notifyManagerEditEnabled_(),
    firedCount: fired, assessedCount: assessed,
    days: days,
  };
}

/** The Alert Log's newest REAL (non-preview, non-test) outcome per date for
 *  one dept, dates on or after `sinceIso`. Bounded by DRIFT_LOG_SCAN_CAP. */
function notifyAlertLogByDate_(dept, sinceIso) {
  var out = {};
  try {
    var sheet = openSpreadsheet_().getSheetByName(SHEETS.ALERT_LOG);
    if (!sheet) return out;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return out;
    var startRow = Math.max(2, lastRow - DRIFT_LOG_SCAN_CAP + 1);
    var rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, 10).getDisplayValues();
    for (var i = rows.length - 1; i >= 0; i--) {   // newest first: first hit per date wins
      var r = rows[i];
      if (String(r[1]) !== dept) continue;
      var by = String(r[7] || '');
      if (by.indexOf('preview:') === 0 || by.indexOf('test:') === 0 || by.indexOf('reason:') === 0) continue;
      var d = notifyIsoOf_(r[2]);
      if (!d || d < sinceIso || out[d]) continue;
      out[d] = { status: String(r[9] || ''), triggeredBy: by };
    }
  } catch (e) {
    Logger.log('notifyAlertLogByDate_: %s', e);
  }
  return out;
}

/** An Alert Log "Date Checked" display value -> ISO (the cell may have been
 *  coerced to a Date and displayed M/D/YYYY). */
function notifyIsoOf_(v) {
  var s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return '';
  var p = function (x) { return x.length < 2 ? '0' + x : x; };
  return m[3] + '-' + p(m[1]) + '-' + p(m[2]);
}

/**
 * RPC (admin): send the real alert email for `req.department` on `req.date`
 * to the CALLING admin only -- managers are never emailed by a test. Works on
 * a quiet day too (the email says the rule would not have fired). Logged to
 * the Alert Log as `test-sent` with Triggered By `test:<email>`, which every
 * reader (drift, history) skips.
 */
function sendAlertTest(req) {
  assertAdmin_();
  req = req || {};
  var me = String(Session.getActiveUser().getEmail() || '').trim();
  if (!me) throw new Error('Could not tell who you are -- sign in again.');
  var dept = String(req.department || '').trim();
  var dateIso = String(req.date || '').trim();
  if (!isIsoDate_(dateIso)) throw new Error('date must be YYYY-MM-DD');
  var entry = readAlertConfig_().filter(function (c) { return c.department === dept && !c.duplicateRow; })[0];
  if (!entry) throw new Error('No alert rule for ' + dept + '.');
  if (entry.invalidThreshold) throw new Error(dept + '\'s threshold is invalid -- fix the rule first.');
  if (!openSpreadsheet_().getSheetByName(SHEETS.ALERT_LOG)) {
    throw new Error('Alert Log sheet missing -- run setup() first.');
  }
  var stats = computeDeptAnswerRateForDate_(dept, dateIso, getRosterForDepartment_(dept));
  if (!(stats.rung > 0)) throw new Error('No calls for ' + dept + ' on ' + dateIso + ' -- pick another date.');
  var eff = alertEffectiveThreshold_(entry);
  assertReportEmailThrottle_(me);   // SEC-2: a user-triggered email
  sendAlertEmail_(alertEntryWithThreshold_(entry, eff.threshold), dateIso, stats, [me], [], { test: true });
  var wouldFire = stats.pct < eff.threshold;
  appendAlertLog_({
    department: dept, status: 'test-sent', answerRate: round1_(stats.pct), threshold: eff.threshold,
    recipients: [me], notes: 'Test send to the requesting admin only; the rule '
      + (wouldFire ? 'would' : 'would not') + ' have fired',
  }, 'test:' + me, dateIso);
  return { sentTo: me, department: dept, date: dateIso, pct: round1_(stats.pct),
           threshold: eff.threshold, wouldFire: wouldFire };
}
