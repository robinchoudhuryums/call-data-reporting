/**
 * Agent role Phase B — the "My Performance" endpoint (docs/agent-role-plan.md).
 *
 * getAgentHome({from, to}) serves the agent app (agent.html): the caller's
 * OWN numbers in full plus the team's AGGREGATE numbers only (owner ruling —
 * no per-teammate rows in the payload, named or anonymized; rank is the one
 * relational element and is ORDINAL only). Identity is ALWAYS server-derived
 * from the resolved user for agents; the request never names an agent.
 * Admins may pass {department, agentName} to preview any agent (support /
 * future view-as; admins are entitled to all data). Managers are refused —
 * nothing here that their own pages don't already show (plan §security).
 *
 * Data sources:
 *  - computeSummary_(dept, from, to, 'roster'): the same aggregation the
 *    My Department table serves, so every own-number here RECONCILES with
 *    the row the manager sees for this agent. ATT is therefore the INV-05
 *    SIMPLE MEAN, deliberately NOT the reports-family weighted ATT (INV-25):
 *    "my number differs from my manager's number" is the dispute this choice
 *    avoids. Team figures come from the roster-only totals (INV-53).
 *  - The DQE DAL (neonFetchDqeRows_/sheetFetchDqeRows_ per getDqeReadSource_,
 *    with the LM2 neonDqeRowsUsable_ fallback — the B-2 same-commit cutover
 *    rule) for the own 30-day trend and the own missed-call timestamps
 *    (slot cols K..AC; already CST per INV-20 — no re-conversion).
 *
 * Caching: two blobs under REPORT_CACHE_TTL_SECONDS, both suffixed with the
 * read-source tag (CORE-3 discipline). The TEAM blob is per (dept, window) —
 * every agent on a team shares one compute (the personalizeOverview_
 * pattern: own-row extraction happens per request AFTER the cache). The ME
 * blob (trend + missed detail) is per agent, keyed through hashAgents_
 * (INV-36 — never a raw name in a cache key).
 *
 * Wait time on missed rings (owner decision 3) is NOT here yet: per-ring
 * wait exists only where the inbound capture holds the call, and the join
 * is a Phase B follow-on — the list ships timestamps-only, honestly.
 */

var AGENT_HOME_CACHE_PREFIX_ = 'agentHome:v1';
var AGENT_TREND_DAYS_ = 30;

/** Resolve who this request is about. Agents: self, always. Admins: preview. */
function agentHomeResolve_(req) {
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (user && user.role === 'agent') {
    return { user: user, dept: user.agentDept, agentName: user.agentName };
  }
  if (user && user.role === 'admin') {
    var dept = String((req && req.department) || '').trim();
    var agentName = String((req && req.agentName) || '').trim();
    if (!dept || !agentName) {
      throw new Error('Admin preview needs department and agentName.');
    }
    if (getAllDepartments_().indexOf(dept) === -1) {
      throw new Error('Unknown department: ' + dept);
    }
    return { user: user, dept: dept, agentName: agentName };
  }
  throw new Error('Not authorized.');
}

/** DAL fetch honoring DQE_READ_SOURCE with the documented fallback (B-2/LM2). */
function ahFetchDalRows_(fromIso, toIso, opts) {
  var src = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  if (src === 'neon' && typeof neonFetchDqeRows_ === 'function') {
    var rows = neonFetchDqeRows_(fromIso, toIso, opts);
    var usable = (typeof neonDqeRowsUsable_ === 'function')
      ? neonDqeRowsUsable_(rows) : (rows && rows.length > 0);
    if (usable) return rows;
  }
  return sheetFetchDqeRows_(fromIso, toIso, opts);
}

/**
 * Pure: extract clean time-of-day strings from one slot cell (comma-joined
 * "H:MM:SS"). Tolerates the coercion shapes the K..AC repair recovers — a
 * "12/30/1899 10:23:33" date-render yields "10:23:33"; junk tokens are
 * DROPPED, never guessed (the classifyAbandonedCell_ philosophy).
 */
function ahSlotTimes_(cell) {
  if (cell == null || cell === '') return [];
  var out = [];
  String(cell).split(',').forEach(function (tok) {
    var m = String(tok).trim().match(/(\d{1,2}:\d{2}:\d{2})$/);
    if (m) out.push(m[1]);
  });
  return out;
}

/** Pure: "H:MM:SS" -> seconds-of-day for chronological sort (bad -> -1). */
function ahTimeSec_(t) {
  var m = String(t || '').match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return -1;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Pure (unit-tested): project a computeSummary_ result into the team blob —
 * slim roster rows (rank basis), team aggregates. No teammate identities
 * leave this projection except inside rankRows, which stays SERVER-side.
 */
function agentHomeTeamBlob_(summary) {
  var rosterRows = (summary.rows || []).filter(function (r) { return r.matchedViaRoster; });
  var t = summary.totals || {};
  var answered = Number(t.totalAnswered) || 0;
  var missed = Number(t.totalMissed) || 0;
  var denom = answered + missed;
  return {
    team: {
      answered: answered,
      missed: missed,
      rung: Number(t.totalRung) || 0,
      answerRatePct: denom ? Math.round((answered / denom) * 1000) / 10 : null,
      attSeconds: Number(t.attSeconds) || 0,
      rosterAgentCount: Number(t.rosterAgentCount) || 0,
      activeAgents: rosterRows.filter(function (r) {
        return (r.totalAnswered + r.totalMissed + r.totalRung) > 0;
      }).length,
    },
    // Rank basis + own-row extraction source. SERVER-INTERNAL: getAgentHome
    // consumes this and ships only the caller's own row + an ordinal.
    rankRows: rosterRows.map(function (r) {
      var d = r.totalAnswered + r.totalMissed;
      return {
        agent: r.agent,
        answered: r.totalAnswered,
        missed: r.totalMissed,
        rung: r.totalRung,
        unique: r.totalUnique,
        attSeconds: r.attSeconds,
        daysActive: r.daysActive,
        ratePct: d ? Math.round((r.totalAnswered / d) * 1000) / 10 : null,
      };
    }),
  };
}

/**
 * Pure (unit-tested): the caller's own view from the team blob — own KPIs,
 * ordinal rank among roster agents WITH activity (rate desc, answered desc,
 * name asc — a zero-activity agent is unranked, never branded last).
 */
function agentHomeOwnView_(blob, agentName) {
  var own = null;
  for (var i = 0; i < blob.rankRows.length; i++) {
    if (blob.rankRows[i].agent === agentName) { own = blob.rankRows[i]; break; }   // INV-04 exact
  }
  var me = {
    hasData: !!own,
    answered: own ? own.answered : 0,
    missed: own ? own.missed : 0,
    rung: own ? own.rung : 0,
    unique: own ? own.unique : 0,
    answerRatePct: own ? own.ratePct : null,
    attSeconds: own ? own.attSeconds : 0,
    daysActive: own ? own.daysActive : 0,
  };
  var ranked = blob.rankRows.filter(function (r) { return (r.answered + r.missed) > 0; });
  ranked.sort(function (a, b) {
    if (b.ratePct !== a.ratePct) return (b.ratePct || 0) - (a.ratePct || 0);
    if (b.answered !== a.answered) return b.answered - a.answered;
    return a.agent.localeCompare(b.agent);
  });
  var rank = null;
  for (var j = 0; j < ranked.length; j++) {
    if (ranked[j].agent === agentName) { rank = { rank: j + 1, of: ranked.length, basis: 'answerRate' }; break; }
  }
  return { me: me, rank: rank };
}

/**
 * Pure (unit-tested): own trend + own missed timestamps from DAL rows.
 * Sentinel rows (INV-23) never match a roster agent name, so exact-name
 * filtering excludes them by construction.
 */
function agentHomeOwnDetail_(dalRows, agentName, fromIso, toIso, trendFromIso) {
  var byDate = {};
  var missedDays = {};
  (dalRows || []).forEach(function (r) {
    if (r.agent !== agentName) return;   // INV-04 exact
    var d = r.dateIso;
    if (d >= trendFromIso && d <= toIso) {
      var b = byDate[d] || (byDate[d] = { answered: 0, missed: 0 });
      b.answered += r.totalAnswered;
      b.missed += r.totalMissed;
    }
    if (d >= fromIso && d <= toIso && r.slots) {
      var times = [];
      r.slots.forEach(function (cell) { times.push.apply(times, ahSlotTimes_(cell)); });
      if (times.length) {
        times.sort(function (a, b2) { return ahTimeSec_(a) - ahTimeSec_(b2); });
        missedDays[d] = (missedDays[d] || []).concat(times);
      }
    }
  });
  var trend = Object.keys(byDate).sort().map(function (d) {
    var b = byDate[d];
    var den = b.answered + b.missed;
    return { date: d, answered: b.answered, missed: b.missed,
             ratePct: den ? Math.round((b.answered / den) * 1000) / 10 : null };
  });
  var missed = Object.keys(missedDays).sort().reverse().map(function (d) {
    return { date: d, times: missedDays[d] };
  });
  var missedTotal = missed.reduce(function (n, day) { return n + day.times.length; }, 0);
  return { trend: trend, missedDays: missed, missedTotal: missedTotal };
}

function getAgentHome(req) {
  req = req || {};
  var who = agentHomeResolve_(req);
  var from = String(req.from || '').trim();
  var to = String(req.to || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');

  var tag = (typeof readSourceCacheTag_ === 'function') ? readSourceCacheTag_() : 'sheet-sheet';
  var cache = CacheService.getScriptCache();

  // TEAM blob: one compute per (dept, window), shared by the whole team.
  var teamKey = AGENT_HOME_CACHE_PREFIX_ + ':team:' + who.dept + ':' + from + ':' + to + ':' + tag;
  var blob = null, teamHit = false;
  var cachedTeam = cache.get(teamKey);
  if (cachedTeam) {
    try { blob = JSON.parse(cachedTeam); teamHit = true; } catch (e) { blob = null; }
  }
  if (!blob) {
    blob = agentHomeTeamBlob_(computeSummary_(who.dept, from, to, 'roster'));
    try { cache.put(teamKey, JSON.stringify(blob), REPORT_CACHE_TTL_SECONDS); }
    catch (e) { /* oversized/unavailable -- serve uncached */ }
  }
  var ownView = agentHomeOwnView_(blob, who.agentName);

  // ME blob: own trend (last AGENT_TREND_DAYS_ ending `to`) + own missed
  // timestamps (the selected window). One DAL fetch covers both ranges.
  var trendFrom = Utilities.formatDate(
    new Date(parseIsoNoon_(to).getTime() - (AGENT_TREND_DAYS_ - 1) * 86400000), TZ, 'yyyy-MM-dd');
  var fetchFrom = from < trendFrom ? from : trendFrom;
  var meKey = AGENT_HOME_CACHE_PREFIX_ + ':me:' + who.dept + ':' + hashAgents_([who.agentName])
    + ':' + from + ':' + to + ':' + tag;
  var detail = null, meHit = false;
  var cachedMe = cache.get(meKey);
  if (cachedMe) {
    try { detail = JSON.parse(cachedMe); meHit = true; } catch (e) { detail = null; }
  }
  if (!detail) {
    var dalRows = ahFetchDalRows_(fetchFrom, to, { includeMissedDetail: true });
    detail = agentHomeOwnDetail_(dalRows, who.agentName, from, to, trendFrom);
    try { cache.put(meKey, JSON.stringify(detail), REPORT_CACHE_TTL_SECONDS); }
    catch (e) { /* serve uncached */ }
  }

  logReportUsage_('agentHome', who.dept, who.user, teamHit && meHit);

  return {
    meta: {
      department: who.dept,
      agentName: who.agentName,
      from: from,
      to: to,
      trendFrom: trendFrom,
      workWindow: (typeof DASHBOARD_WORK_WINDOW !== 'undefined') ? DASHBOARD_WORK_WINDOW : '',
    },
    me: ownView.me,
    meAttFormatted: formatSecondsHms_(ownView.me.attSeconds),
    team: blob.team,
    teamAttFormatted: formatSecondsHms_(blob.team.attSeconds),
    rank: ownView.rank,   // client ships hidden (owner: build, hide for now)
    trend: detail.trend,
    missedDays: detail.missedDays,
    missedTotal: detail.missedTotal,
  };
}
