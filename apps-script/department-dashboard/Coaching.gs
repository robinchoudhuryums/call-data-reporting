/**
 * Coaching / queue-member turnover suggestions — Phase 1 (ENGINE, DARK).
 *
 * Owner-ratified rules (2026-08): flag an agent for a manager conversation
 * ("meet with them or adjust the queue assignment") when, over the trailing
 * COACHING_WINDOW_WORKDAYS_ working days (holiday-aware):
 *   1. their answer rate is below COACHING_ANSWER_BELOW_PCT_  (absolute), AND
 *   2. they are at least COACHING_BEHIND_TEAM_PTS_ points behind the team's
 *      aggregate answer rate (relative — an agent matching a struggling team
 *      is a team problem, not a person problem), AND
 *   3. they missed at least COACHING_MIN_MISSED_ rings in the window (volume
 *      gate — a 3-of-5 day means nothing).
 *
 * Population/fairness rules inherited from computeSummary_(dept, …, 'roster'):
 * roster agents only (no floaters, INV-53), INV-23 sentinels excluded, and —
 * when QUEUE_SPLIT_SCOPE=dept — per-agent figures narrowed to the dept's own
 * queues, so a crossover agent is judged on this dept's calls only.
 * TEAM_AVG_EXCLUDES (managers on the roster) are excluded from BOTH the team
 * aggregate and candidacy — flagging a manager for coaching is noise.
 *
 * Phase 1 ships NO delivery: `previewCoachingFlags` is an admin-only,
 * read-only RPC (INV-01-clean — no sheet writes, no email) so the owner can
 * watch flag quality across all depts before any manager sees one. Delivery
 * (admin email first, then managers behind a COACHING_ENABLED flag, plus the
 * SEPARATE coaching worklist — owner: never mixed into customer-account
 * Escalations) is Phase 3.
 */

var COACHING_WINDOW_WORKDAYS_  = 10;   // "2 weeks" = 10 working days
var COACHING_ANSWER_BELOW_PCT_ = 50;   // absolute floor
var COACHING_BEHIND_TEAM_PTS_  = 5;    // relative gate vs the team aggregate
var COACHING_MIN_MISSED_       = 20;   // volume gate (missed rings in window)

/**
 * PURE. The trailing N-working-day window ending at `latestIso` (stepping
 * the end back first if it lands on a weekend/holiday). `isHolidayFn` is
 * injected for testability; production passes isCompanyHoliday_.
 */
function coachingWindowFromLatest_(latestIso, workdays, isHolidayFn) {
  var n = workdays || COACHING_WINDOW_WORKDAYS_;
  var isHol = isHolidayFn || function () { return false; };
  var d = new Date(latestIso + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  var iso = function (dt) {
    var p = function (x) { return x < 10 ? '0' + x : String(x); };
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  };
  var isBiz = function (dt) {
    var dow = dt.getDay();
    return dow !== 0 && dow !== 6 && !isHol(iso(dt));
  };
  while (!isBiz(d)) d.setDate(d.getDate() - 1);
  var to = iso(d);
  var counted = 1;
  while (counted < n) {
    d.setDate(d.getDate() - 1);
    if (isBiz(d)) counted++;
  }
  return { from: iso(d), to: to };
}

/**
 * PURE. Applies the three gates to one dept's computeSummary_ rows.
 * `excludes` = the dept's TEAM_AVG_EXCLUDES names (exact match). Returns
 * flagged agents worst-first (largest gap behind the team).
 */
function computeCoachingFlags_(rows, excludes, opts) {
  var o = opts || {};
  var answerBelow = o.answerBelow != null ? o.answerBelow : COACHING_ANSWER_BELOW_PCT_;
  var behindPts   = o.behindPts   != null ? o.behindPts   : COACHING_BEHIND_TEAM_PTS_;
  var minMissed   = o.minMissed   != null ? o.minMissed   : COACHING_MIN_MISSED_;
  var exSet = {};
  (excludes || []).forEach(function (n) { exSet[String(n)] = true; });

  // Team aggregate rate: sum over roster agents with activity, excludes out.
  var tA = 0, tM = 0;
  (rows || []).forEach(function (r) {
    if (!r || r.matchedViaRoster === false || exSet[r.agent]) return;
    tA += Number(r.totalAnswered) || 0;
    tM += Number(r.totalMissed) || 0;
  });
  var teamRate = (tA + tM) > 0 ? (tA / (tA + tM) * 100) : null;

  var flags = [];
  (rows || []).forEach(function (r) {
    if (!r || r.matchedViaRoster === false || exSet[r.agent]) return;
    var a = Number(r.totalAnswered) || 0;
    var m = Number(r.totalMissed) || 0;
    if (a + m === 0) return;
    var rate = a / (a + m) * 100;
    if (m < minMissed) return;                              // volume gate
    if (rate >= answerBelow) return;                        // absolute gate
    if (teamRate == null || (teamRate - rate) < behindPts) return;   // relative gate
    flags.push({
      agent: r.agent,
      rung: Number(r.totalRung) || (a + m),
      missed: m,
      answered: a,
      ratePct: Math.round(rate * 10) / 10,
      teamRatePct: Math.round(teamRate * 10) / 10,
      gapPts: Math.round((teamRate - rate) * 10) / 10,
    });
  });
  flags.sort(function (x, y) { return y.gapPts - x.gapPts; });
  return flags;
}

/**
 * Admin RPC (read-only, INV-01-clean): the current coaching flags across
 * every department, over the trailing window ending at the latest DQE date.
 * Per-dept best-effort — one dept's failure records an error entry rather
 * than killing the scan.
 */
function previewCoachingFlags() {
  assertAdmin_();
  var latest = getLatestDataDate();
  if (!latest) return { available: false, reason: 'no DQE data' };
  var win = coachingWindowFromLatest_(latest, COACHING_WINDOW_WORKDAYS_, function (isoDay) {
    try { return isCompanyHoliday_(isoDay); } catch (e) { return false; }
  });
  if (!win) return { available: false, reason: 'bad latest date: ' + latest };
  var flags = [], errors = [], depts = getAllDepartments_();
  depts.forEach(function (dept) {
    try {
      var summary = computeSummary_(dept, win.from, win.to, 'roster');
      var deptFlags = computeCoachingFlags_((summary && summary.rows) || [],
        getTeamAvgExcludes_(dept));
      deptFlags.forEach(function (f) { f.dept = dept; flags.push(f); });
    } catch (e) {
      errors.push({ dept: dept, error: String(e && e.message || e) });
    }
  });
  flags.sort(function (x, y) { return y.gapPts - x.gapPts; });
  return {
    available: true,
    window: win,
    thresholds: {
      windowWorkdays: COACHING_WINDOW_WORKDAYS_,
      answerBelowPct: COACHING_ANSWER_BELOW_PCT_,
      behindTeamPts: COACHING_BEHIND_TEAM_PTS_,
      minMissed: COACHING_MIN_MISSED_,
    },
    deptsScanned: depts.length,
    flags: flags,
    errors: errors,
  };
}

/** Editor wrapper (the Run-picker convention: no trailing underscore) with
 *  Logger output so an editor run reads as a report, not a silent return. */
function runCoachingPreview() {
  var out = previewCoachingFlags();
  Logger.log('Coaching preview: %s', JSON.stringify(out.window || {}));
  if (!out.available) { Logger.log('Unavailable: %s', out.reason); return out; }
  Logger.log('%s dept(s) scanned, %s flag(s), %s error(s)',
    out.deptsScanned, out.flags.length, (out.errors || []).length);
  out.flags.forEach(function (f) {
    Logger.log('  %s | %s: %s%% answered (team %s%%, %s pts behind) — %s missed of %s rung',
      f.dept, f.agent, f.ratePct, f.teamRatePct, f.gapPts, f.missed, f.rung);
  });
  (out.errors || []).forEach(function (e) { Logger.log('  ERROR %s: %s', e.dept, e.error); });
  return out;
}
