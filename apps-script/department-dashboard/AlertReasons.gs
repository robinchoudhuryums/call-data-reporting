/**
 * Alert REASONS (owner plan Step 5c, 2026-10-16) -- ADMIN TRIAL.
 *
 * Two reasons to send an alert beyond the department's answer rate, both
 * per department, both emailing the ADMINS ONLY while the owner tests them:
 *
 *   agent-low  -- an agent's answer rate stays below X% on each of the last N
 *                 workdays (every one of those days with answerable calls;
 *                 an agent who did not work one of them is not "staying"
 *                 below anything). Same population as the answer-rate rule:
 *                 the dept's roster rows, queue-narrowed under
 *                 QUEUE_SPLIT_SCOPE=dept, managers in TEAM_AVG_EXCLUDES left
 *                 out (INV-26). Read: ONE DQE window (alertRowsForRange_).
 *                 RING-LEVEL caveat (Coaching.gs header): an individual's
 *                 rate is bounded by ring density, so a floor near 50% fires
 *                 on almost everyone -- pick X from History, not by feel.
 *   callbacks  -- callers who could not get through on the PREVIOUS workday
 *                 and were neither called back nor got through by the end of
 *                 the assessed day ("within a business day"). The callback
 *                 engine's own rules (obCallbackEpisodes_, CE-1): a dial by
 *                 the caller's own team, or the caller getting through,
 *                 closes an episode. Reads Neon `inbound_calls` /
 *                 `outbound_calls` (the 6c-vetted data, admin-only today); an
 *                 unreachable Neon or a day not loaded yet is a `skipped`
 *                 row saying so, never a false "nobody called back".
 *
 * Config: `ALERT_REASON_RULES` (Script Property, JSON
 * `{ "<dept>": { "agentLow": { "threshold": 40, "days": 5 },
 *                "callbacks": { "minCallers": 1 } } }`), written only by
 * saveAlertReasonRule (assertAdmin_ + validation + LockService + Logger).
 * Evaluated inside the daily alert run (runAlertsCore_) for the same date,
 * under the same claim, logged to the Alert Log with Triggered By
 * `reason:<kind>:<runner>` (the drift chip and History skip them) and the
 * statuses `sent` / `would-send` / `quiet` / `skipped` / `error`. The
 * department's Alert Config skip dates apply on the trigger path, as they do
 * to its answer-rate rule.
 */

var ALERT_REASON_RULES_PROP_ = 'ALERT_REASON_RULES';
var ALERT_REASON_RULES_MEMO_ = null;   // per execution (F39)
var ALERT_REASON_AGENT_DAYS_MIN_ = 2;
var ALERT_REASON_AGENT_DAYS_MAX_ = 20;

/** The stored rules; a malformed property reads as EMPTY (no reason fires). */
function readAlertReasonRules_() {
  if (ALERT_REASON_RULES_MEMO_) return ALERT_REASON_RULES_MEMO_;
  var out = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(ALERT_REASON_RULES_PROP_);
    var obj = raw ? JSON.parse(raw) : {};
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      Object.keys(obj).forEach(function (dept) {
        var r = obj[dept] || {}, clean = {};
        var al = r.agentLow || {};
        if (isFinite(Number(al.threshold)) && Number(al.threshold) > 0 && isFinite(Number(al.days)) && Number(al.days) >= 1) {
          clean.agentLow = { threshold: Number(al.threshold), days: Math.round(Number(al.days)) };
        }
        var cb = r.callbacks || {};
        if (r.callbacks && isFinite(Number(cb.minCallers)) && Number(cb.minCallers) >= 1) {
          clean.callbacks = { minCallers: Math.round(Number(cb.minCallers)) };
        }
        if (Object.keys(clean).length) out[dept] = clean;
      });
    }
  } catch (e) {
    Logger.log('readAlertReasonRules_: unreadable -- no reason rules apply: %s', e);
  }
  ALERT_REASON_RULES_MEMO_ = out;
  return out;
}

/**
 * RPC (admin): set or clear a department's reasons. `req = { department,
 * agentLowThreshold, agentLowDays, callbacksMin }` -- a blank threshold (or
 * days) clears agent-low, a blank callbacksMin clears callbacks. Returns the
 * whole rule map.
 */
function saveAlertReasonRule(req) {
  assertAdmin_();
  req = req || {};
  var dept = String(req.department || '').trim();
  if (!dept) throw new Error('Department is required.');
  if (getAllDepartments_().indexOf(dept) === -1) throw new Error('Unknown department: ' + dept);
  var blank = function (v) { return v === '' || v == null; };
  var rec = {};
  if (!blank(req.agentLowThreshold) || !blank(req.agentLowDays)) {
    var t = Number(req.agentLowThreshold), d = Number(req.agentLowDays);
    if (!isFinite(t) || t <= 0 || t > 100) throw new Error('The agent threshold must be a number from 1 to 100.');
    if (!isFinite(d) || d < ALERT_REASON_AGENT_DAYS_MIN_ || d > ALERT_REASON_AGENT_DAYS_MAX_) {
      throw new Error('The number of workdays must be from ' + ALERT_REASON_AGENT_DAYS_MIN_ + ' to ' + ALERT_REASON_AGENT_DAYS_MAX_ + '.');
    }
    rec.agentLow = { threshold: Math.round(t * 10) / 10, days: Math.round(d) };
  }
  if (!blank(req.callbacksMin)) {
    var m = Number(req.callbacksMin);
    if (!isFinite(m) || m < 1 || m > 500) throw new Error('The caller count must be a number from 1 to 500.');
    rec.callbacks = { minCallers: Math.round(m) };
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Busy -- please retry in a moment.');
  try {
    var props = PropertiesService.getScriptProperties();
    var cur = {};
    try { cur = JSON.parse(props.getProperty(ALERT_REASON_RULES_PROP_) || '{}') || {}; } catch (pe) { cur = {}; }
    if (typeof cur !== 'object' || Array.isArray(cur)) cur = {};
    if (Object.keys(rec).length) cur[dept] = rec; else delete cur[dept];
    if (Object.keys(cur).length) props.setProperty(ALERT_REASON_RULES_PROP_, JSON.stringify(cur));
    else props.deleteProperty(ALERT_REASON_RULES_PROP_);
    ALERT_REASON_RULES_MEMO_ = null;
    Logger.log('saveAlertReasonRule: %s %s by %s', dept, JSON.stringify(rec) || '(cleared)',
      Session.getActiveUser().getEmail());
  } finally {
    lock.releaseLock();
  }
  return { rules: readAlertReasonRules_() };
}

/**
 * PURE. Agents below `threshold` on EVERY one of `perDay` (newest first,
 * `{iso, agents:[{name, pct, answered, missed}]}`); an agent missing from a
 * day (no answerable calls) does not qualify. `excludes` = exact names left
 * out (TEAM_AVG_EXCLUDES). Returns `[{ name, days: [{iso, pct, answered,
 * missed}] }]`, lowest average first.
 */
function alertAgentLowFindings_(perDay, threshold, excludes) {
  var ex = {};
  (excludes || []).forEach(function (n) { ex[String(n)] = true; });
  if (!perDay || !perDay.length) return [];
  var byName = {};
  perDay.forEach(function (d, i) {
    (d.agents || []).forEach(function (a) {
      if (ex[a.name]) return;
      var e = byName[a.name] || (byName[a.name] = { name: a.name, days: [], ok: true });
      if (e.days.length !== i) { e.ok = false; return; }   // missed an earlier day: not every day
      if (!(Number(a.pct) < threshold)) e.ok = false;
      e.days.push({ iso: d.iso, pct: Number(a.pct), answered: a.answered, missed: a.missed });
    });
  });
  var out = [];
  Object.keys(byName).forEach(function (n) {
    var e = byName[n];
    if (e.ok && e.days.length === perDay.length) out.push({ name: e.name, days: e.days });
  });
  var avg = function (e) { return e.days.reduce(function (s, d) { return s + d.pct; }, 0) / e.days.length; };
  out.sort(function (a, b) { return (avg(a) - avg(b)) || (a.name < b.name ? -1 : 1); });
  return out;
}

/** Calendar days from `fromIso` to `toIso` (UTC arithmetic). */
function alertReasonDaysBetween_(fromIso, toIso) {
  var f = String(fromIso).split('-').map(Number), t = String(toIso).split('-').map(Number);
  return Math.round((Date.UTC(t[0], t[1] - 1, t[2]) - Date.UTC(f[0], f[1] - 1, f[2])) / 86400000);
}

/**
 * Callers of `dept` who could not get through on `abandonIso` and were not
 * called back (nor got through) by the end of `throughIso`. Returns
 * `{ available, missed: [{firstHms, queue, attempts}], pending, total }`;
 * available:false when Neon is unreachable or the read failed.
 */
function alertCallbackMisses_(dept, abandonIso, throughIso) {
  var out = { available: false, missed: [], pending: 0, total: 0 };
  if (typeof obCallbackListEpisodes_ !== 'function') return out;
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return out;
    var win = Math.max(1, alertReasonDaysBetween_(abandonIso, throughIso));
    var scope = { from: abandonIso, to: abandonIso, dept: dept, companyView: false, scopeDepts: [dept] };
    var readWin = (typeof OUTBOUND_CALLBACK_WINDOW_DAYS === 'number') ? OUTBOUND_CALLBACK_WINDOW_DAYS : 3;
    var list = obCallbackListEpisodes_(conn, scope, Math.max(0, win - readWin), win);
    if (!list) return out;
    out.available = true;
    (list.eps || []).forEach(function (ep) {
      out.total++;
      if (ep.outcome === 'pending') out.pending++;
      else if (ep.outcome === 'none') {
        out.missed.push({ firstHms: ep.firstHms || '', queue: (ep.attempts[0] && ep.attempts[0].q) || '',
                          attempts: ep.attempts.length });
      }
    });
    out.missed.sort(function (a, b) { return a.firstHms < b.firstHms ? -1 : a.firstHms > b.firstHms ? 1 : 0; });
    return out;
  } catch (e) {
    Logger.log('alertCallbackMisses_ %s: %s', dept, (e && e.message) || e);
    out.available = false;
    out.error = String((e && e.message) || e).slice(0, 200);
    return out;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

/** HH:MM:SS (raw PST, as stored) -> "h:mm AM" CST for an email line. */
function alertReasonCstTime_(hms) {
  var m = /^(\d{1,2}):(\d{2})/.exec(String(hms || ''));
  if (!m) return '';
  var h = (Number(m[1]) + 2) % 24;   // INV-20 / INV-18: stored PST, shown CST
  return ((h % 12) || 12) + ':' + m[2] + (h < 12 ? ' AM' : ' PM');
}

/**
 * The daily run's second pass (called from runAlertsCore_ after the
 * answer-rate rules): every dept with a reason rule. `pushAndLog` is the
 * run's own logger; rows carry `reason` so the outcome string, the drift chip
 * and History tell them apart. Never throws.
 */
function runAlertReasons_(dateIso, dryRun, honorSkipDates, cfg, pushAndLog) {
  var rules;
  try { rules = readAlertReasonRules_(); } catch (e) { return; }
  var depts = Object.keys(rules);
  if (!depts.length) return;
  var known = null;
  try { known = {}; getAllDepartments_().forEach(function (d) { known[d] = true; }); } catch (e) { known = null; }
  var cfgByDept = {};
  (cfg || []).forEach(function (c) { if (!c.duplicateRow && !cfgByDept[c.department]) cfgByDept[c.department] = c; });
  var admins = getAdminEmails_();
  var holidayFn = function (iso) { try { return isCompanyHoliday_(iso); } catch (e) { return false; } };

  depts.sort().forEach(function (dept) {
    var r = rules[dept];
    var base = function (kind, extra) {
      var rec = { department: dept, reason: kind, answerRate: null, recipients: [] };
      Object.keys(extra).forEach(function (k) { rec[k] = extra[k]; });
      return rec;
    };
    if (known && !known[dept]) {
      Object.keys(r).forEach(function (kind) {
        pushAndLog(base(kind === 'agentLow' ? 'agent-low' : 'callbacks', { status: 'error', threshold: 0,
          notes: 'Department not found on the roster sheet -- this reason is NOT checked.' }));
      });
      return;
    }
    var c = cfgByDept[dept];
    if (honorSkipDates && c && isDateInSkipRanges_(dateIso, c.skipDates)) {
      Object.keys(r).forEach(function (kind) {
        pushAndLog(base(kind === 'agentLow' ? 'agent-low' : 'callbacks', { status: 'skipped',
          threshold: kind === 'agentLow' ? r.agentLow.threshold : r.callbacks.minCallers,
          notes: 'Skip date match (' + dateIso + ') in Alert Config' }));
      });
      return;
    }

    if (r.agentLow) {
      try {
        var days = notifyWorkdaysEnding_(dateIso, r.agentLow.days, holidayFn);
        alertRowsForRange_(days[days.length - 1], days[0]);   // ONE read for the window
        var roster = getRosterForDepartment_(dept);
        var perDay = days.map(function (iso) {
          return { iso: iso, agents: computeDeptAnswerRateForDate_(dept, iso, roster).agents || [] };
        });
        var ex = (typeof getTeamAvgExcludes_ === 'function') ? (getTeamAvgExcludes_(dept) || []) : [];
        var found = alertAgentLowFindings_(perDay, r.agentLow.threshold, ex);
        var what = 'below ' + r.agentLow.threshold + '% on each of the last ' + days.length + ' workdays ('
          + days[days.length - 1] + '..' + days[0] + ')';
        if (!found.length) {
          pushAndLog(base('agent-low', { status: 'quiet', threshold: r.agentLow.threshold,
            notes: 'No agent ' + what }));
        } else {
          var status = 'would-send', notes = found.length + ' agent(s) ' + what + ': '
            + found.map(function (f) { return f.name; }).join(', ');
          if (!dryRun) {
            alertReasonSendAgentLow_(dept, dateIso, r.agentLow, days, found, admins);
            status = 'sent';
          }
          pushAndLog(base('agent-low', { status: status, threshold: r.agentLow.threshold,
            recipients: dryRun ? [] : admins, notes: notes + (dryRun ? ' (preview)' : ' -- emailed the admins') }));
        }
      } catch (e) {
        pushAndLog(base('agent-low', { status: 'error', threshold: r.agentLow.threshold,
          notes: String((e && e.message) || e).slice(0, 300) }));
      }
    }

    if (r.callbacks) {
      try {
        var two = notifyWorkdaysEnding_(dateIso, 2, holidayFn);
        var abandonIso = two[1];
        var res = alertCallbackMisses_(dept, abandonIso, dateIso);
        if (!res.available) {
          pushAndLog(base('callbacks', { status: 'skipped', threshold: r.callbacks.minCallers,
            notes: 'Callback data unavailable (Neon unreachable or the read failed)' + (res.error ? ': ' + res.error : '') }));
        } else if (res.pending) {
          pushAndLog(base('callbacks', { status: 'skipped', threshold: r.callbacks.minCallers,
            notes: res.pending + ' caller(s) from ' + abandonIso + ' cannot be judged yet -- ' + dateIso
              + "'s calls are not loaded; not alerting on a partial day" }));
        } else if (res.missed.length < r.callbacks.minCallers) {
          pushAndLog(base('callbacks', { status: 'quiet', threshold: r.callbacks.minCallers,
            notes: res.missed.length + ' of ' + res.total + ' caller(s) who could not get through on ' + abandonIso
              + ' were not called back by the end of ' + dateIso }));
        } else {
          var st = 'would-send';
          if (!dryRun) {
            alertReasonSendCallbacks_(dept, abandonIso, dateIso, res, admins);
            st = 'sent';
          }
          pushAndLog(base('callbacks', { status: st, threshold: r.callbacks.minCallers,
            recipients: dryRun ? [] : admins,
            notes: res.missed.length + ' of ' + res.total + ' caller(s) who could not get through on ' + abandonIso
              + ' were not called back by the end of ' + dateIso + (dryRun ? ' (preview)' : ' -- emailed the admins') }));
        }
      } catch (e) {
        pushAndLog(base('callbacks', { status: 'error', threshold: r.callbacks.minCallers,
          notes: String((e && e.message) || e).slice(0, 300) }));
      }
    }
  });
}

function alertReasonSendAgentLow_(dept, dateIso, rule, days, found, admins) {
  var n = found.length;
  var title = n + ' agent' + (n === 1 ? '' : 's') + ' below ' + rule.threshold + '% for ' + days.length + ' workdays';
  sendAppEmail_({
    to: admins.join(','),
    subject: '[Dashboard Alert · admin trial] ' + dept + ': ' + title,
    notice: {
      tone: 'warn', kicker: 'Alert · ' + dept + ' · admin trial', title: title,
      subtitle: days[days.length - 1] + ' .. ' + days[0],
      list: { title: 'Answer rate each workday (oldest first)', items: found.map(function (f) {
        return '<strong>' + appEsc_(f.name) + '</strong>: ' + f.days.slice().reverse().map(function (d) {
          return appEsc_(d.pct.toFixed(1) + '%');
        }).join(' · ');
      }) },
      callout: { kicker: 'Admin trial', tone: 'neutral', html: appEsc_('Only admins receive this reason while it is '
        + 'tested. An individual answer rate is bounded by how many rings the agent shares -- compare with History '
        + 'before acting on a single alert.') },
      ctaUrl: appDashUrl_('#/admin/alerts'), ctaLabel: 'Open Notifications',
      footerHtml: 'Sent by the daily alert run (Step 5c reason: agent below threshold).',
    },
    body: dept + ': ' + title + ' (' + days[days.length - 1] + '..' + days[0] + ')\n\n'
      + found.map(function (f) { return '  ' + f.name + ': ' + f.days.slice().reverse().map(function (d) { return d.pct.toFixed(1) + '%'; }).join(', '); }).join('\n')
      + '\n\nAdmin trial: only admins receive this reason.',
  });
}

function alertReasonSendCallbacks_(dept, abandonIso, throughIso, res, admins) {
  var n = res.missed.length;
  var title = n + ' caller' + (n === 1 ? '' : 's') + ' not called back within a business day';
  sendAppEmail_({
    to: admins.join(','),
    subject: '[Dashboard Alert · admin trial] ' + dept + ': ' + title,
    notice: {
      tone: 'warn', kicker: 'Alert · ' + dept + ' · admin trial', title: title,
      subtitle: 'Could not get through on ' + abandonIso + '; no callback by the end of ' + throughIso,
      tiles: [{ label: 'Not called back', value: String(n), tone: 'warn' },
              { label: 'Callers that day', value: String(res.total) }],
      list: { title: 'First attempt (CST) and queue', items: res.missed.slice(0, 40).map(function (m) {
        return appEsc_(alertReasonCstTime_(m.firstHms) + ' · ' + (m.queue || 'queue unknown')
          + (m.attempts > 1 ? ' · ' + m.attempts + ' attempts' : ''));
      }) },
      callout: { kicker: 'Admin trial', tone: 'neutral', html: appEsc_('Only admins receive this reason while it is '
        + 'tested. A callback is a dial to the caller by the department\'s own team; the caller getting through also counts.') },
      ctaUrl: appDashUrl_('#/report/outbound'), ctaLabel: 'Open the Callbacks list',
      footerHtml: 'Sent by the daily alert run (Step 5c reason: callers not called back).',
    },
    body: dept + ': ' + title + '. Could not get through on ' + abandonIso + ', no callback by the end of ' + throughIso + '.\n\n'
      + res.missed.slice(0, 40).map(function (m) { return '  ' + alertReasonCstTime_(m.firstHms) + '  ' + (m.queue || ''); }).join('\n')
      + '\n\nAdmin trial: only admins receive this reason.',
  });
}
