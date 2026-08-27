/**
 * Coaching / queue-member turnover suggestions — Phase 1 (ENGINE, DARK).
 *
 * Owner-ratified rules (2026-08): flag an agent for a manager conversation
 * ("meet with them or adjust the queue assignment") when, over the trailing
 * COACHING_WINDOW_WORKDAYS_ working days (holiday-aware):
 *   1. they answer less than COACHING_MAX_TEAM_RATIO_ AS OFTEN as their
 *      teammates (agentRate < ratio × teamRate), AND
 *   2. they are at least COACHING_BEHIND_TEAM_PTS_ points behind the team's
 *      aggregate answer rate (relative — an agent matching a struggling team
 *      is a team problem, not a person problem), AND
 *   3. they missed at least COACHING_MIN_MISSED_ rings in the window (volume
 *      gate — a 3-of-5 day means nothing).
 *
 * WHY THE HEADLINE GATE IS A RATIO, NOT AN ABSOLUTE FLOOR (owner ruling after
 * the first live preview): this is RING-level data — one queue call rings
 * several agents and only one can answer — so an individual's answer rate is
 * bounded by ring density, not effort. Measured team aggregates here run
 * 17-49%, so ANY fixed floor near 50% is above every agent in every dept and
 * filters nothing, while a 5-point gap off a 39% team average is ordinary
 * ring-distribution luck. The ratio self-adjusts per dept and states plainly
 * what a manager needs to hear: "answering less than half as often as the
 * rest of the team." COACHING_BEHIND_TEAM_PTS_ stays as an absolute FLOOR
 * beneath it, so a very low team rate (where half of small is still small)
 * can't manufacture flags out of noise.
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

var COACHING_WINDOW_WORKDAYS_  = 10;    // "2 weeks" = 10 working days
var COACHING_MAX_TEAM_RATIO_   = 0.5;   // headline gate: < half the team's answer rate
var COACHING_BEHIND_TEAM_PTS_  = 5;     // absolute floor beneath the ratio
var COACHING_MIN_MISSED_       = 20;    // volume gate (missed rings in window)

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
  var maxRatio  = o.maxTeamRatio != null ? o.maxTeamRatio : COACHING_MAX_TEAM_RATIO_;
  var behindPts = o.behindPts    != null ? o.behindPts    : COACHING_BEHIND_TEAM_PTS_;
  var minMissed = o.minMissed    != null ? o.minMissed    : COACHING_MIN_MISSED_;
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
    // A team that answers nothing gives no baseline to be "half of" -- no
    // flags rather than flagging everyone against a zero.
    if (teamRate == null || teamRate <= 0) return;
    if (rate >= teamRate * maxRatio) return;                // headline ratio gate
    if ((teamRate - rate) < behindPts) return;              // absolute floor beneath it
    flags.push({
      agent: r.agent,
      rung: Number(r.totalRung) || (a + m),
      missed: m,
      answered: a,
      ratePct: Math.round(rate * 10) / 10,
      teamRatePct: Math.round(teamRate * 10) / 10,
      gapPts: Math.round((teamRate - rate) * 10) / 10,
      // "answers N% as often as the team" -- the sentence a manager reads.
      teamRatioPct: Math.round(rate / teamRate * 1000) / 10,
    });
  });
  // Worst RELATIVE standing first (the gate's own metric), gap as tiebreak.
  flags.sort(function (x, y) {
    return (x.teamRatioPct - y.teamRatioPct) || (y.gapPts - x.gapPts);
  });
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
  return computeCoachingPreview_();
}

/**
 * Gate-free core shared by the admin preview RPC above and the Phase-3
 * delivery trigger (runCoachingDelivery_ -- a time trigger has no meaningful
 * Session user to assert against; its callers gate themselves). Underscore =
 * RPC-unreachable.
 */
function computeCoachingPreview_() {
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
  flags.sort(function (x, y) {
    return (x.teamRatioPct - y.teamRatioPct) || (y.gapPts - x.gapPts);
  });
  return {
    available: true,
    window: win,
    thresholds: {
      windowWorkdays: COACHING_WINDOW_WORKDAYS_,
      maxTeamRatio: COACHING_MAX_TEAM_RATIO_,
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
    Logger.log('  %s | %s: answers %s%% as often as the team (%s%% vs %s%%, %s pts behind) — %s missed of %s rung',
      f.dept, f.agent, f.teamRatioPct, f.ratePct, f.teamRatePct, f.gapPts, f.missed, f.rung);
  });
  (out.errors || []).forEach(function (e) { Logger.log('  ERROR %s: %s', e.dept, e.error); });
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — DELIVERY (Batch F-e): the separate coaching worklist + admin email
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner rulings (increments 122/124, unchanged here): delivery is an email
// plus a card in a SEPARATE coaching worklist — NEVER mixed into the
// customer-account Escalations; all depts, no pilot; ADMIN-ONLY until the
// owner releases it to managers (every surface below is assertAdmin_-gated,
// so release = swapping gates, not rebuilding). Cross-dept de-dup is
// deliberately NOT done (owner investigating the Shamir Alam double-flag);
// 0%-answered agents are genuine flags.
//
// Shape: a weekly trigger (runCoachingDelivery_, gated on
// COACHING_DELIVERY_ENABLED — the flag-gated-engine pattern, and it MUST
// stay in SystemHealth's svc() list per the install-readiness rule)
// recomputes the flags, upserts them into the Neon `coaching_flags` table
// (one OPEN row per (dept, agent) via a partial unique index; a continuing
// flag refreshes its metrics instead of duplicating; a closed row does not
// block a later re-flag), and emails the admins ONLY when there are NEW
// flags — a continuing flag is not news, and MailApp quota is shared with
// alerts/digests (the B3 lesson). An open row whose agent stops flagging is
// deliberately NOT auto-closed: the coach decides when the conversation
// happened, not the math; the worklist shows lastSeen so staleness is
// visible.
//
// INV-01: updateCoachingFlagStatus is an ADMIN-gated Neon write (the
// applyOrphanRename class — assertAdmin_ + validation + LockService + a
// Logger.log audit line + closed_by/at on the row). No sheet is touched
// anywhere. INV-55 is NOT extended: nothing here is per-dept-manager
// writable until release.

var COACHING_DELIVERY_HOUR_ = 8;        // Monday morning, Central (trigger)
var COACHING_NOTE_MAX_ = 500;

function coachingEnsureTable_(conn) {
  var ddl = conn.createStatement();
  ddl.execute('CREATE TABLE IF NOT EXISTS coaching_flags ('
    + 'id text PRIMARY KEY, '
    + 'department text NOT NULL, '
    + 'agent_name text NOT NULL, '
    + 'window_from date, window_to date, '
    + 'rate_pct double precision, team_rate_pct double precision, '
    + 'team_ratio_pct double precision, gap_pts double precision, '
    + 'missed int, rung int, answered int, '
    + 'times_flagged int DEFAULT 1, '
    + "status text NOT NULL DEFAULT 'open', "
    + 'created_at timestamptz DEFAULT now(), '
    + 'updated_at timestamptz DEFAULT now(), '
    + 'closed_by text, closed_at timestamptz, note text)');
  ddl.close();
  // ONE open row per (dept, agent); closed history never blocks a re-flag.
  var idx = conn.createStatement();
  idx.execute('CREATE UNIQUE INDEX IF NOT EXISTS uq_coaching_open '
    + "ON coaching_flags (department, agent_name) WHERE status = 'open'");
  idx.close();
}

/**
 * PURE (tests/unit/coaching.test.js): splits a fresh flag run against the
 * currently-OPEN rows. `newFlags` have no open row (insert + email);
 * `continuing` pair each flag with its open row id (metrics refresh, no
 * email); `recoveredOpenRows` are open rows whose agent no longer flags —
 * reported, never auto-closed (see the header note).
 */
function coachingDeliveryDiff_(flags, openRows) {
  var openByKey = {};
  (openRows || []).forEach(function (r) {
    openByKey[r.department + '||' + r.agent_name] = r;
  });
  var seen = {};
  var out = { newFlags: [], continuing: [], recoveredOpenRows: [] };
  (flags || []).forEach(function (f) {
    var key = f.dept + '||' + f.agent;
    seen[key] = true;
    var open = openByKey[key];
    if (open) out.continuing.push({ flag: f, id: open.id });
    else out.newFlags.push(f);
  });
  (openRows || []).forEach(function (r) {
    if (!seen[r.department + '||' + r.agent_name]) out.recoveredOpenRows.push(r);
  });
  return out;
}

/** Plain-text admin email for a run that produced NEW flags (the watchdog
 *  email family, not the EmailKit report family — this is a notification). */
function coachingEmailBody_(newFlags, continuingCount, recoveredCount, win, dashUrl) {
  var lines = [
    'The weekly coaching check flagged ' + newFlags.length + ' NEW agent(s) over '
      + win.from + ' .. ' + win.to + ' (10 working days).',
    '',
  ];
  newFlags.forEach(function (f) {
    lines.push('  ' + f.dept + ' | ' + f.agent + ': answers ' + f.teamRatioPct
      + '% as often as the team (' + f.ratePct + '% vs ' + f.teamRatePct
      + '%, ' + f.gapPts + ' pts behind) — ' + f.missed + ' missed of ' + f.rung + ' rung');
  });
  lines.push('');
  if (continuingCount) {
    lines.push(continuingCount + ' earlier flag(s) are still open in the worklist (metrics refreshed; not re-notified).');
  }
  if (recoveredCount) {
    lines.push(recoveredCount + ' open flag(s) no longer meet the gates this window — left open for you to close '
      + '(the math does not know whether the conversation happened).');
  }
  lines.push('', 'Worklist: ' + (dashUrl ? (dashUrl + '#/admin/coaching') : '(set DASHBOARD_URL for a link)'),
    '', 'Gates: rate < ' + (COACHING_MAX_TEAM_RATIO_ * 100) + '% of team rate, >= '
      + COACHING_BEHIND_TEAM_PTS_ + ' pts behind, >= ' + COACHING_MIN_MISSED_
      + ' missed — over roster rows only (INV-53), TEAM_AVG_EXCLUDES out of both sides.',
    'Admin-only until released (owner ruling); managers are not copied.');
  return lines.join('\n');
}

/** Trigger handler. Weekly; gated on COACHING_DELIVERY_ENABLED. */
function runCoachingDelivery_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('COACHING_DELIVERY_ENABLED') || '') !== 'true') return;
    var out = coachingDeliveryRun_();
    props.setProperty('COACHING_DELIVERY_LAST', new Date().toISOString());
    props.setProperty('COACHING_DELIVERY_LAST_RESULT', out.result);
  } catch (e) {
    try {
      PropertiesService.getScriptProperties().setProperty('COACHING_DELIVERY_LAST_RESULT',
        'ERROR: ' + String(e && e.message || e).slice(0, 500));
    } catch (pe) { /* best-effort */ }
    Logger.log('runCoachingDelivery_ failed: ' + (e && e.message ? e.message : e));
  }
}

/**
 * The run itself (shared by the trigger and the admin "run now" RPC).
 * Returns { result, newCount, continuingCount, recoveredCount } where
 * `result` is the OPS-8 prefix-coded outcome string the Health page's
 * classifier reads ('ok ...' healthy / anything else trips the bad-word
 * match, as intended for ERROR/SKIPPED).
 */
function coachingDeliveryRun_() {
  var preview = computeCoachingPreview_();
  if (!preview.available) {
    return { result: 'skipped (' + preview.reason + ')', newCount: 0, continuingCount: 0, recoveredCount: 0 };
  }
  var conn = getDashboardNeonConn_();
  if (!conn) {
    // Neon down: no worklist to reconcile against, and emailing flags that
    // cannot land as cards would notify without a workflow. Skip loudly.
    return { result: 'skipped (Neon unreachable — flags not persisted, no email)',
             newCount: 0, continuingCount: 0, recoveredCount: 0 };
  }
  var txn = false;
  try {
    coachingEnsureTable_(conn);
    var stmt = conn.prepareStatement(
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
      + "SELECT id, department, agent_name FROM coaching_flags WHERE status = 'open') t");
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'coaching');
    rs.close(); stmt.close();
    var diff = coachingDeliveryDiff_(preview.flags, JSON.parse(json || '[]'));

    conn.setAutoCommit(false); txn = true;
    diff.continuing.forEach(function (c) {
      var u = conn.prepareStatement('UPDATE coaching_flags SET '
        + 'window_from = ?::date, window_to = ?::date, rate_pct = ?, team_rate_pct = ?, '
        + 'team_ratio_pct = ?, gap_pts = ?, missed = ?, rung = ?, answered = ?, '
        + 'times_flagged = times_flagged + 1, updated_at = now() WHERE id = ?');
      u.setString(1, preview.window.from); u.setString(2, preview.window.to);
      u.setString(3, String(c.flag.ratePct)); u.setString(4, String(c.flag.teamRatePct));
      u.setString(5, String(c.flag.teamRatioPct)); u.setString(6, String(c.flag.gapPts));
      u.setString(7, String(c.flag.missed)); u.setString(8, String(c.flag.rung));
      u.setString(9, String(c.flag.answered)); u.setString(10, c.id);
      u.execute(); u.close();
    });
    diff.newFlags.forEach(function (f) {
      var i = conn.prepareStatement('INSERT INTO coaching_flags '
        + '(id, department, agent_name, window_from, window_to, rate_pct, team_rate_pct, '
        + 'team_ratio_pct, gap_pts, missed, rung, answered) '
        + "VALUES (?, ?, ?, ?::date, ?::date, ?, ?, ?, ?, ?, ?, ?)");
      i.setString(1, Utilities.getUuid());
      i.setString(2, f.dept); i.setString(3, f.agent);
      i.setString(4, preview.window.from); i.setString(5, preview.window.to);
      i.setString(6, String(f.ratePct)); i.setString(7, String(f.teamRatePct));
      i.setString(8, String(f.teamRatioPct)); i.setString(9, String(f.gapPts));
      i.setString(10, String(f.missed)); i.setString(11, String(f.rung));
      i.setString(12, String(f.answered));
      i.execute(); i.close();
    });
    conn.commit();

    // P13 (OPS-1): the flags are COMMITTED above before any email, so a
    // failed send used to orphan the batch forever -- the next run classed
    // them 'continuing' ("not re-notified") and no path re-attempted the
    // email, exactly on the quota-exhausted mornings the first (largest)
    // armed batch is likeliest to hit. Un-notified flags now ride the
    // COACHING_NOTIFY_PENDING property and fold into the next send; the
    // property clears only on a CONFIRMED send.
    var propsSvc = PropertiesService.getScriptProperties();
    var carried = [];
    try {
      var pnRaw = propsSvc.getProperty('COACHING_NOTIFY_PENDING');
      var pn = pnRaw ? JSON.parse(pnRaw) : null;
      if (pn && pn.flags && pn.flags.length) {
        var seenKey = {};
        diff.newFlags.forEach(function (f) { seenKey[f.dept + '\u0000' + f.agent] = true; });
        carried = pn.flags.filter(function (f) {
          return f && f.dept && f.agent && !seenKey[f.dept + '\u0000' + f.agent];
        });
      }
    } catch (pe) { carried = []; }
    var toEmail = diff.newFlags.concat(carried);
    var emailNote = ' — no email (nothing new)';
    if (toEmail.length) {
      var to = getAdminEmails_().join(',');   // admin-only until released (owner)
      var sentOk = false;
      if (to) {
        var dashUrl = '';
        try { dashUrl = propsSvc.getProperty('DASHBOARD_URL') || ''; } catch (e2) {}
        try {
          MailApp.sendEmail({
            to: to,
            subject: '[Dashboard] Coaching: ' + toEmail.length + ' new flag(s) — '
              + preview.window.from + '..' + preview.window.to,
            body: coachingEmailBody_(toEmail, diff.continuing.length,
              diff.recoveredOpenRows.length, preview.window, dashUrl),
          });
          sentOk = true;
        } catch (me) {
          Logger.log('coachingDeliveryRun_: notification send FAILED (%s) -- flags kept pending for retry.',
            (me && me.message) || me);
        }
      }
      if (sentOk) {
        try { propsSvc.deleteProperty('COACHING_NOTIFY_PENDING'); } catch (de) {}
        emailNote = ' — emailed admins'
          + (carried.length ? ' (incl. ' + carried.length + ' retried from a previous failed send)' : '');
      } else {
        // Never claim notified on an unconfirmed send: park the batch (capped
        // so the property stays under the 9KB value limit) and say so.
        try {
          propsSvc.setProperty('COACHING_NOTIFY_PENDING', JSON.stringify({
            window: preview.window, flags: toEmail.slice(0, 40),
          }));
        } catch (se) { Logger.log('coachingDeliveryRun_: pending-notify save failed: %s', se); }
        emailNote = ' — EMAIL NOT SENT (' + (to ? 'send failed' : 'no admin recipients')
          + '); ' + toEmail.length + ' flag(s) kept pending, re-emailed on the next run';
      }
    }
    return {
      result: 'ok ' + diff.newFlags.length + ' new, ' + diff.continuing.length
        + ' continuing, ' + diff.recoveredOpenRows.length + ' recovered-open ('
        + preview.window.from + '..' + preview.window.to + ')'
        + emailNote,
      newCount: diff.newFlags.length,
      continuingCount: diff.continuing.length,
      recoveredCount: diff.recoveredOpenRows.length,
    };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    throw e;
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
  }
}

// ── Worklist RPCs (admin-only until released) ─────────────────────────────

/**
 * The coaching worklist. `req.status` = 'open' (default) | 'closed' | 'all'.
 * Uncached — small, admin-only, and a fresh view after a status change
 * matters more than a saved read.
 */
function getCoachingWorklist(req) {
  assertAdmin_();
  req = req || {};
  var status = String(req.status || 'open').toLowerCase();
  if (['open', 'closed', 'all'].indexOf(status) === -1) status = 'open';
  var props = PropertiesService.getScriptProperties();
  var meta = {
    status: status,
    lastRunAt: props.getProperty('COACHING_DELIVERY_LAST') || null,
    lastResult: props.getProperty('COACHING_DELIVERY_LAST_RESULT') || null,
    enabled: String(props.getProperty('COACHING_DELIVERY_ENABLED') || '') === 'true',
    thresholds: { windowWorkdays: COACHING_WINDOW_WORKDAYS_,
                  maxTeamRatio: COACHING_MAX_TEAM_RATIO_,
                  behindTeamPts: COACHING_BEHIND_TEAM_PTS_,
                  minMissed: COACHING_MIN_MISSED_ },
  };
  var conn = getDashboardNeonConn_();
  if (!conn) return { available: false, rows: [], meta: meta };
  try {
    coachingEnsureTable_(conn);
    var where = status === 'open' ? "WHERE status = 'open'"
      : status === 'closed' ? "WHERE status <> 'open'" : '';
    var sql = "SELECT COALESCE(json_agg(t ORDER BY (t.status = 'open') DESC, t.team_ratio_pct ASC), '[]')::text AS j FROM ("
      + 'SELECT id, department, agent_name, window_from::text AS window_from, '
      + 'window_to::text AS window_to, rate_pct, team_rate_pct, team_ratio_pct, '
      + 'gap_pts, missed, rung, answered, times_flagged, status, '
      + 'created_at::text AS created_at, updated_at::text AS updated_at, '
      + 'closed_by, closed_at::text AS closed_at, note '
      + 'FROM coaching_flags ' + where + ' ORDER BY created_at DESC LIMIT 300) t';
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery(sql);
    var json = rs.next() ? rs.getString('j') : '[]';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'coaching');
    rs.close(); stmt.close();
    return { available: true, rows: JSON.parse(json || '[]'), meta: meta };
  } catch (e) {
    Logger.log('getCoachingWorklist failed: ' + (e && e.message ? e.message : e));
    return { available: false, rows: [], meta: meta };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

/**
 * Closes one OPEN flag as 'resolved' (conversation happened / queue
 * adjusted) or 'dismissed' (judged not a real issue). Open-only: two admins
 * racing from stale views get a clear error, never a silent overwrite.
 * INV-01 data-mutation set: assertAdmin_ + validation + LockService + audit
 * (closed_by/at on the row + a Logger.log line).
 */
function updateCoachingFlagStatus(req) {
  assertAdmin_();
  req = req || {};
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing flag id.');
  var action = String(req.action || '').toLowerCase().trim();
  if (action !== 'resolved' && action !== 'dismissed') {
    throw new Error('Action must be "resolved" or "dismissed".');
  }
  var note = String(req.note || '').trim().slice(0, COACHING_NOTE_MAX_);
  var admin = (Session.getActiveUser().getEmail() || '').toLowerCase();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another coaching write is in progress — retry in a moment.');
  var conn = getDashboardNeonConn_();
  if (!conn) { lock.releaseLock(); throw new Error('Coaching storage (Neon) is not configured/reachable.'); }
  try {
    coachingEnsureTable_(conn);
    var stmt = conn.prepareStatement('UPDATE coaching_flags SET status = ?, '
      + "note = NULLIF(?, ''), closed_by = ?, closed_at = now(), updated_at = now() "
      + "WHERE id = ? AND status = 'open'");
    stmt.setString(1, action);
    stmt.setString(2, note);
    stmt.setString(3, admin);
    stmt.setString(4, id);
    var updated = stmt.executeUpdate();
    stmt.close();
    if (updated !== 1) {
      throw new Error('That flag is not open any more (someone else closed it, or the id is stale) — refresh the worklist.');
    }
    Logger.log('updateCoachingFlagStatus: %s -> %s by %s%s', id, action, admin, note ? ' (note)' : '');
    return { id: id, status: action };
  } catch (e) {
    throw new Error(e && e.message ? e.message : 'Could not update the flag.');
  } finally {
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

// ── Trigger management (the DqeSilenceWatch template) ─────────────────────

function getCoachingDeliveryStatus() {
  assertAdmin_();
  return logStatusReturn_(getCoachingDeliveryStatus_());
}

function getCoachingDeliveryStatus_() {
  var props = PropertiesService.getScriptProperties();
  var installed = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'runCoachingDelivery_';
  });
  return {
    installed: installed,
    enabled: String(props.getProperty('COACHING_DELIVERY_ENABLED') || '') === 'true',
    lastRunAt: props.getProperty('COACHING_DELIVERY_LAST') || null,
    lastResult: props.getProperty('COACHING_DELIVERY_LAST_RESULT') || null,
  };
}

function installCoachingDeliveryTrigger() {
  assertAdmin_();
  uninstallCoachingDeliveryTrigger_();   // idempotent re-install
  ScriptApp.newTrigger('runCoachingDelivery_')
    .timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(COACHING_DELIVERY_HOUR_).create();
  PropertiesService.getScriptProperties().setProperty('COACHING_DELIVERY_ENABLED', 'true');
  return logStatusReturn_(getCoachingDeliveryStatus_());
}

function uninstallCoachingDeliveryTrigger() {
  assertAdmin_();
  uninstallCoachingDeliveryTrigger_();
  PropertiesService.getScriptProperties().deleteProperty('COACHING_DELIVERY_ENABLED');
  return logStatusReturn_(getCoachingDeliveryStatus_());
}

function uninstallCoachingDeliveryTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runCoachingDelivery_') ScriptApp.deleteTrigger(t);
  });
}

/** Admin "run now": the FULL run (persist + email), ignoring the enabled
 *  flag — the sendAlerts manual-fire semantics, not a dry preview (that is
 *  previewCoachingFlags). */
function runCoachingDeliveryNow() {
  assertAdmin_();
  var out = coachingDeliveryRun_();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('COACHING_DELIVERY_LAST', new Date().toISOString());
  props.setProperty('COACHING_DELIVERY_LAST_RESULT', out.result + ' [manual]');
  return logStatusReturn_(out);
}
