/**
 * Individual & Peer Comparison Report - server-side data.
 *
 * Migration of IndividualReport.js from the legacy DQE Report Apps
 * Script project. Reads DQE Historical Data and produces:
 *   - Per-agent summary stats for the selected date range, vs a
 *     dept "team average" computed across the full roster.
 *   - Monthly trend buckets over a 12-month window for the
 *     volume/efficiency/duration line charts.
 *
 * Public entries (callable via google.script.run):
 *   getIndividualReportInit({ department })
 *     -> { department, agents: [..roster names..], defaultStart, defaultEnd }
 *   getIndividualReport({ department, from, to, agents: [..names..] })
 *     -> { meta, dateLabel, trendData, summaryData, teamAvg, deptStats, mode }
 *   sendIndividualReportEmail({ imageBase64, dateLabel })
 *     -> { to } (the recipient email; the active user)
 *
 * Authorization: managers limited to their own dept; admins can pick
 * any dept that exists in the dept list. Same model as Data.gs.
 *
 * Calculation notes:
 *   - Per-agent summary % Answered, TTT (sum), and ATT (weighted by
 *     Answered) match the legacy IndividualReport's math. This means
 *     ATT differs from the main dashboard's simple-mean ATT (INV-05);
 *     intentional, matches the report managers are migrating from.
 *     Days with Answered=0 contribute 0 to both the numerator and the
 *     denominator, so unanswered/abandoned days don't drag the ATT
 *     down -- matches the user's "only times the agent actually
 *     spoke with a caller" intent.
 *   - Team avg per-agent: teamTotal / activeAgentCount, where
 *     activeAgentCount = count of roster members with ANY call
 *     activity (rung/answered/missed > 0) in the selected range
 *     (INV-27). Zero-call roster members are excluded from BOTH
 *     numerator and denominator so they don't dilute the per-agent
 *     baseline. `TEAM_AVG_EXCLUDES` removes additional configured
 *     names (e.g. managers on the roster who take only a token
 *     number of calls).
 *   - Team % Answered, TTT, ATT: weighted across the whole team's
 *     calls in range (NOT per-agent mean of percentages).
 *
 * Caching: 5 min per (dept, from, to, sortedAgents) tuple. Best-
 * effort -- large ranges with many agents may exceed CacheService's
 * per-value 100KB limit; on cache-put failure we log + continue.
 */

// Bump when aggregation rules or response shape change so stale
// cached values don't linger. CLAUDE.md INV-30 is the canonical
// current-version list -- keep this constant aligned with that.
//
// v6: optional prior-period comparison (priorFrom/priorTo). When
// supplied, each summary card carries a `priorStats` field so the
// client can render a vs-prior delta badge alongside vs-team-avg
// (Strategic 5 / same-agent YoY).
// v7: per-agent `excludedFromTeamAvg` flag added (Phase E, E4) so
// the client can render an "EXCLUDED" pill on agents listed in
// TEAM_AVG_EXCLUDES[dept]. Pure additive field; no aggregation
// change. Bump to keep response shape consistent across cached
// + fresh requests.
// v8: INV-53 expansion -- input gate relaxed to accept floaters
// (queue-only agents), per-agent matchedViaRoster / matchedViaQueue /
// sourceHomes added, summaryData filtered to drop names that match
// neither path (security against crafted off-dept names). Team-avg
// accumulator unchanged (already gated by rosterSet[agent], so
// floaters were already excluded from the team-avg numerator +
// denominator -- the v7 -> v8 change only widens what can APPEAR in
// summaryData).
const INDIVIDUAL_CACHE_KEY_PREFIX = 'individual:v8';

function getIndividualReportInit(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  if (user.role === 'manager' && dept !== user.department) {
    throw new Error('Not authorized for this department.');
  }
  if (user.role === 'admin' && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }

  const roster = getRosterForDepartment_(dept);
  const tz = TZ;
  const now = new Date();
  const fmt = function (d) {
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  };
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Optional: when from/to are passed, also return the subset of
  // roster names with any rung/answered/missed activity in range,
  // PLUS the active floaters (queue-only matched). The client picker
  // shows three groups: Active in range / No activity / Floaters --
  // managers can include floaters in their report and the server-side
  // team-avg still excludes them per INV-53.
  let activeAgents = null;
  let activeFloaters = null;
  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (isIsoDate_(from) && isIsoDate_(to) && from <= to) {
    const active = computeActiveAgentsInRange_(dept, from, to, roster);
    activeAgents   = active.agents;
    activeFloaters = active.floaters;
  }

  return {
    department: dept,
    agents: roster.names.slice().sort(),
    defaultStart: fmt(firstOfMonth),
    defaultEnd: fmt(now),
    activeAgents:   activeAgents,
    activeFloaters: activeFloaters,
  };
}

// computeActiveAgentsInRange_ moved to Util.gs.

function getIndividualReport(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  if (user.role === 'manager' && dept !== user.department) {
    throw new Error('Not authorized for this department.');
  }
  if (user.role === 'admin' && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) {
    throw new Error('from/to must be YYYY-MM-DD.');
  }
  if (from > to) throw new Error('from must be on or before to.');

  // Optional prior-period for same-agent YoY / vs-self comparison.
  // Both dates required if either is supplied; absent = no
  // comparison (legacy behavior, no `priorStats` field in output).
  const priorFrom = String((req && req.priorFrom) || '').trim();
  const priorTo   = String((req && req.priorTo)   || '').trim();
  if (priorFrom || priorTo) {
    if (!isIsoDate_(priorFrom) || !isIsoDate_(priorTo)) {
      throw new Error('priorFrom/priorTo must be YYYY-MM-DD.');
    }
    if (priorFrom > priorTo) {
      throw new Error('priorFrom must be on or before priorTo.');
    }
  }

  const rawAgents = (req && req.agents) || [];
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    throw new Error('Select at least one agent.');
  }
  // Trim + dedupe. Phase D+1 (INV-53 expansion): roster-membership is
  // NO LONGER the security gate at this layer -- floaters can be
  // selected for the report too. Off-dept names that match neither
  // the roster nor the dept's queue extensions are silently dropped
  // by computeIndividualReport_'s row scan (security preserved: a
  // crafted name from a different dept that never touched this
  // dept's queue produces no rows + falls out of summaryData).
  const roster = getRosterForDepartment_(dept);
  const seen = {};
  const selectedAgents = [];
  for (let i = 0; i < rawAgents.length; i++) {
    const n = String(rawAgents[i] || '').trim();
    if (!n || seen[n]) continue;
    seen[n] = true;
    selectedAgents.push(n);
  }
  if (selectedAgents.length === 0) {
    throw new Error('No selected agent provided.');
  }
  // MD5 hash of the agent list keeps the cache key length-bounded
  // (CacheService rejects keys > 250 chars; raw join blows past
  // that on big rosters like Sales). Order-insensitive by design.
  const agentsKey = hashAgents_(selectedAgents);
  const priorKey = (priorFrom && priorTo) ? (priorFrom + '..' + priorTo) : 'none';

  const cache = CacheService.getScriptCache();
  const cacheKey = INDIVIDUAL_CACHE_KEY_PREFIX + ':'
                 + dept + ':' + from + ':' + to + ':' + agentsKey + ':' + priorKey;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeIndividualReport_(dept, from, to, selectedAgents, roster,
                                        priorFrom, priorTo);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  try {
    cache.put(cacheKey, JSON.stringify(data), REPORT_CACHE_TTL_SECONDS);
  } catch (e) {
    // Big ranges with many agents may exceed cache size; harmless.
    Logger.log('IndividualReport cache put failed: %s', e);
  }

  return data;
}

/**
 * Computes the individual/comparison report. Pure (no caching).
 *
 * Trend window:
 *   - If selected range > 366 days OR equals a single full calendar
 *     year (Jan 1 to Dec 31), use the range as the trend window.
 *   - Otherwise, trend = first-of-month(end - 12 months) ... end.
 *   Matches legacy IndividualReport behavior.
 */
function computeIndividualReport_(dept, from, to, selectedAgents, roster,
                                  priorFrom, priorTo) {
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;
  const selectedSet = {};
  for (let i = 0; i < selectedAgents.length; i++) selectedSet[selectedAgents[i]] = true;
  const hasPrior = !!(priorFrom && priorTo);

  // ISO -> Date (noon to avoid DST edges).
  const parseIso_ = function (iso) {
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
  };
  const startDate = parseIso_(from);
  const endDate   = parseIso_(to);

  // Trend window resolution.
  const msPerDay = 86400000;
  const diffDays = Math.ceil(Math.abs(endDate - startDate) / msPerDay) + 1;
  const isFullYear =
       startDate.getMonth() === 0 && startDate.getDate() === 1
    && endDate.getMonth()   === 11 && endDate.getDate()   === 31
    && startDate.getFullYear() === endDate.getFullYear();

  let trendStartDate;
  if (diffDays > 366 || isFullYear) {
    trendStartDate = new Date(startDate);
  } else {
    trendStartDate = new Date(endDate);
    trendStartDate.setMonth(trendStartDate.getMonth() - 12);
    trendStartDate.setDate(1);
  }
  const trendStartIso = Utilities.formatDate(trendStartDate, TZ, 'yyyy-MM-dd');
  const trendEndIso   = to;
  const masterMonthKeys = generateMonthList_(trendStartDate, endDate);

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) {
    throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptyIndividualReport_(dept, from, to, selectedAgents, masterMonthKeys);
  }
  const ssTZ = ss.getSpreadsheetTimeZone();

  // F1 cutover #4 (Individual Report): source the rows for the UNION of
  // the windows this report scans -- user [from,to], 12-mo trend
  // [trendStartIso, to], and (optional) prior [priorFrom, priorTo] -- from
  // Neon when DQE_READ_SOURCE=neon, else the sheet. Both produce the same
  // normalized `srcRows`, so the aggregation loop below is source-agnostic.
  // Default 'sheet' is byte-identical to pre-cutover (individual-report.test.js
  // guards it). deptQueueExts (floater match set) needs ALL history on its
  // derived path, so the Neon path reads a cheap cols-A..D slice for the
  // unchanged getDeptQueueExts_ while the windowed rows come from Neon.
  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  let fetchFrom = trendStartIso;                       // trend start <= from <= to
  if (hasPrior && priorFrom < fetchFrom) fetchFrom = priorFrom;
  let fetchTo = to;
  if (hasPrior && priorTo > fetchTo) fetchTo = priorTo;
  const dqeSource = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  let srcRows = null;
  let deptQueueExts;
  let effectiveSource = 'sheet';
  const _tRead = Date.now();
  if (dqeSource === 'neon' && typeof neonFetchDqeRows_ === 'function') {
    srcRows = neonFetchDqeRows_(fetchFrom, fetchTo);
    if (srcRows && srcRows.length) {
      deptQueueExts = deptQueueExtsForNeonReader_(dept, rosterSet, sheet, lastRow).exts;
      effectiveSource = 'neon';
    } else {
      srcRows = null;
      Logger.log('computeIndividualReport_: neon returned no rows; falling back to sheet.');
    }
  }
  if (srcRows === null) {
    const range = sheet.getRange(2, 1, lastRow - 1, numCols);
    const values   = range.getValues();
    const displays = range.getDisplayValues();
    deptQueueExts = getDeptQueueExts_(dept, rosterSet, values).exts;
    srcRows = [];
    for (let i = 0; i < values.length; i++) {
      const r = values[i], rd = displays[i];
      const dIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
      if (!dIso || dIso < fetchFrom || dIso > fetchTo) continue;
      const ag = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
      if (!ag) continue;
      srcRows.push({
        dateIso:       dIso,
        agent:         ag,
        queueExt:      String(r[HISTORICAL_COLS.QUEUE_EXT - 1] || '').trim(),
        totalRung:     Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0,
        totalMissed:   Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0,
        totalAnswered: Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
        tttSec:        parseHmsDisplay_(rd[HISTORICAL_COLS.TTT - 1]),
        attSec:        parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]),
      });
    }
  }
  if (typeof logDqeReadTiming_ === 'function') logDqeReadTiming_('computeIndividualReport_:' + dept, effectiveSource, _tRead, srcRows.length);

  // Aggregators.
  // aggregatedStats[agent][monthKey] = { rung, missed, answered, ttt, attTotal }
  //   attTotal = sum of (ATT_for_that_day * answered_that_day) so the
  //   monthly weighted ATT is attTotal / answered.
  // summaryStats[agent] = same shape, over the user's selected range.
  // teamTotal = same shape, over the user's selected range, across
  //   the full dept roster.
  const aggregatedStats = {};
  const summaryStats = {};
  // Per-agent stats for the optional prior window. Same shape as
  // summaryStats. Only populated when hasPrior; surfaced in the
  // response as `priorStats` on each summary card.
  const priorSummaryStats = {};
  selectedAgents.forEach(function (a) {
    aggregatedStats[a]    = {};
    summaryStats[a]       = { rung: 0, missed: 0, answered: 0, ttt: 0, attTotal: 0 };
    priorSummaryStats[a]  = { rung: 0, missed: 0, answered: 0, ttt: 0, attTotal: 0 };
  });
  const teamTotal = { rung: 0, missed: 0, answered: 0, ttt: 0, attTotal: 0 };
  const activeDaySet  = {};   // ISO day -> true; for dept "per day" stats
  // Track which roster agents actually had ANY activity in range,
  // so the team-avg denominator only counts agents who took calls
  // (zero-call roster members shouldn't drag the average down).
  const activeAgentSet = {};

  // Per-dept exclusion list for managers / others who are on the
  // roster but shouldn't factor into the team average. Resolved at
  // request time so config edits take effect on next request (after
  // cache TTL).
  const excludedAgents = {};
  // Effective exclude list (Dept Config sheet overriding the
  // TEAM_AVG_EXCLUDES constant; see DeptConfig.gs).
  const excludeList = getTeamAvgExcludes_(dept);
  for (let i = 0; i < excludeList.length; i++) excludedAgents[excludeList[i]] = true;

  // Floater detection (Phase D+1 / INV-53 expansion). Build the dept's
  // queue extension set once; per-agent matchedViaRoster + matchedViaQueue
  // flags drive the summaryData QUEUE chip rendering. Floaters
  // (matchedViaQueue && !matchedViaRoster) appear in summaryData /
  // trend charts but are EXCLUDED from the team-avg accumulator
  // below by the existing `rosterSet[agent]` gate (same rule
  // Data.gs::computeSummary_ enforces for My Department).
  // deptQueueExts was computed source-aware above; used below for floater
  // detection on selected non-roster agents.
  // matchedViaRoster is true for any selected agent who's on the
  // dept roster, regardless of whether they have rows in range --
  // so a manager who picks a zero-activity roster member still
  // sees their card. matchedViaQueue is populated lazily as we
  // observe queue-overlap rows.
  const agentMatchedViaRoster = {};
  const agentMatchedViaQueue  = {};
  for (let i = 0; i < selectedAgents.length; i++) {
    const a = selectedAgents[i];
    if (rosterSet[a]) agentMatchedViaRoster[a] = true;
  }

  for (let i = 0; i < srcRows.length; i++) {
    const row = srcRows[i];

    const dateIso = row.dateIso;
    if (!dateIso) continue;
    const agent = row.agent;
    if (!agent) continue;
    // Skip queue-sentinel rows (queue-only abandoned events; not an agent).
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;

    const inUserRange   = (dateIso >= from && dateIso <= to);
    const inTrendRange  = (dateIso >= trendStartIso && dateIso <= trendEndIso);
    const inPriorRange  = hasPrior
      ? (dateIso >= priorFrom && dateIso <= priorTo) : false;

    // Fast-path: row touches no window we care about.
    if (!inUserRange && !inTrendRange && !inPriorRange) continue;

    // Tag floaters: a selected agent NOT on the roster gets
    // matchedViaQueue=true if any of their rows' col-D extensions
    // overlap the dept's queue set. Only relevant for non-roster
    // selections (roster flag was pre-populated above).
    if (selectedSet[agent] && !rosterSet[agent] && !agentMatchedViaQueue[agent]) {
      const rowExts = parseExtensions_(row.queueExt);
      for (let j = 0; j < rowExts.length; j++) {
        if (deptQueueExts[rowExts[j]]) { agentMatchedViaQueue[agent] = true; break; }
      }
    }

    const rung     = row.totalRung;
    const missed   = row.totalMissed;
    const answered = row.totalAnswered;
    const tttSec   = row.tttSec;
    const attAvg   = row.attSec;
    // attTotal = ATT * Answered. Days with answered=0 contribute 0,
    // so unanswered/abandoned days don't drag down the weighted ATT.
    const attTotal = answered > 0 ? attAvg * answered : 0;

    // Team totals (dept-wide, over user's selected range). Excludes
    // configured managers; only counts agents with at least one call
    // event so zero-call roster members don't dilute the average.
    if (inUserRange && rosterSet[agent] && !excludedAgents[agent]) {
      teamTotal.rung     += rung;
      teamTotal.missed   += missed;
      teamTotal.answered += answered;
      teamTotal.ttt      += tttSec;
      teamTotal.attTotal += attTotal;
      activeDaySet[dateIso] = true;
      if (rung > 0 || answered > 0 || missed > 0) {
        activeAgentSet[agent] = true;
      }
    }

    // Per-selected-agent.
    if (selectedSet[agent]) {
      if (inTrendRange) {
        const monthKey = dateIso.slice(0, 7);   // "YYYY-MM"
        let bucket = aggregatedStats[agent][monthKey];
        if (!bucket) {
          bucket = { rung: 0, missed: 0, answered: 0, ttt: 0, attTotal: 0 };
          aggregatedStats[agent][monthKey] = bucket;
        }
        bucket.rung     += rung;
        bucket.missed   += missed;
        bucket.answered += answered;
        bucket.ttt      += tttSec;
        bucket.attTotal += attTotal;
      }
      if (inUserRange) {
        const s = summaryStats[agent];
        s.rung     += rung;
        s.missed   += missed;
        s.answered += answered;
        s.ttt      += tttSec;
        s.attTotal += attTotal;
      }
      if (inPriorRange) {
        const p = priorSummaryStats[agent];
        p.rung     += rung;
        p.missed   += missed;
        p.answered += answered;
        p.ttt      += tttSec;
        p.attTotal += attTotal;
      }
    }
  }

  // Team average (per-agent simple mean across active, non-excluded
  // roster members), with weighted % / TTT / ATT computed across
  // those agents' calls. activeAgentCount is the denominator; if
  // every roster member was inactive or excluded, fall back to 1 to
  // avoid divide-by-zero (totals will be 0 anyway).
  const activeAgentCount = Math.max(1, Object.keys(activeAgentSet).length);
  const teamAvg = {
    rung:     Math.round(teamTotal.rung     / activeAgentCount),
    missed:   Math.round(teamTotal.missed   / activeAgentCount),
    answered: Math.round(teamTotal.answered / activeAgentCount),
    pctAnswered: teamTotal.rung     > 0 ? (teamTotal.answered / teamTotal.rung)    * 100 : 0,
    tttPerCall:  teamTotal.answered > 0 ? (teamTotal.ttt       / teamTotal.answered)     : 0,
    att:         teamTotal.answered > 0 ? (teamTotal.attTotal  / teamTotal.answered)     : 0,
  };

  const teamAvgOut = {
    rung:     teamAvg.rung,
    missed:   teamAvg.missed,
    answered: teamAvg.answered,
    pct:      teamAvg.pctAnswered.toFixed(1) + '%',
    ttt:      formatSecondsHms_(teamAvg.tttPerCall),
    att:      formatSecondsHms_(teamAvg.att),
    raw: {
      rung:        teamAvg.rung,
      missed:      teamAvg.missed,
      answered:    teamAvg.answered,
      pctAnswered: teamAvg.pctAnswered,
      ttt:         teamAvg.tttPerCall,
      att:         teamAvg.att,
    },
  };

  // Dept per-day stats (denominator = days with any activity).
  const dayCount = Object.keys(activeDaySet).length || 1;
  const deptStats = {
    dailyRung:     (teamTotal.rung     / dayCount).toFixed(1),
    dailyMissed:   (teamTotal.missed   / dayCount).toFixed(1),
    dailyAnswered: (teamTotal.answered / dayCount).toFixed(1),
    ansPct:        (teamTotal.rung > 0 ? (teamTotal.answered / teamTotal.rung) * 100 : 0).toFixed(1) + '%',
    activeDays:    dayCount,
  };

  // Trend chart data: labels + per-agent monthly buckets.
  const chartLabels = masterMonthKeys.map(function (m) {
    const parts = m.split('-');
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return Utilities.formatDate(d, TZ, 'MMM, yy');
  });
  const chartDatasets = {};
  selectedAgents.forEach(function (agent) {
    chartDatasets[agent] = masterMonthKeys.map(function (m) {
      const b = aggregatedStats[agent][m] || { rung: 0, missed: 0, answered: 0, ttt: 0, attTotal: 0 };
      const pct = b.rung > 0 ? (b.answered / b.rung) * 100 : 0;
      const att = b.answered > 0 ? (b.attTotal / b.answered) : 0;
      return {
        rung: b.rung, missed: b.missed, answered: b.answered,
        pct: pct, att: att,
      };
    });
  });

  // Per-agent summary cards. Includes:
  //   share -- agent's portion of the dept's volume on each metric
  //   insights -- rules-based notable comparisons vs team avg
  //   priorStats / priorRaw -- same-agent prior-window stats when
  //     hasPrior; the client renders a vs-prior delta badge.
  //   matchedViaRoster / matchedViaQueue / sourceHomes -- INV-53
  //     floater-awareness fields. Floaters render with the QUEUE
  //     chip and are EXCLUDED from teamTotal (gated above by the
  //     existing rosterSet[agent] check).
  // Phase D+1 / INV-53: filter out selected names that match
  // neither path -- a crafted off-dept name with no rows would
  // otherwise show as a zero-stats card. Roster members ALWAYS
  // pass since agentMatchedViaRoster was pre-populated.
  const visibleAgents = selectedAgents.filter(function (a) {
    return agentMatchedViaRoster[a] || agentMatchedViaQueue[a];
  });
  // Build sourceHomes for any floaters so the QUEUE chip can show
  // their other-dept home list. Lazy; only runs if floaters exist.
  let irDeptsByAgent = null;
  for (let i = 0; i < visibleAgents.length; i++) {
    if (agentMatchedViaQueue[visibleAgents[i]] && !agentMatchedViaRoster[visibleAgents[i]]) {
      irDeptsByAgent = buildDeptsByAgent_();
      break;
    }
  }
  const summaryData = visibleAgents.map(function (agent) {
    const s = summaryStats[agent];
    const agPct = s.rung > 0 ? (s.answered / s.rung) * 100 : 0;
    const agTtt = s.answered > 0 ? s.ttt      / s.answered : 0;
    const agAtt = s.answered > 0 ? s.attTotal / s.answered : 0;
    const share = {
      rung:     teamTotal.rung     > 0 ? (s.rung     / teamTotal.rung)     * 100 : 0,
      answered: teamTotal.answered > 0 ? (s.answered / teamTotal.answered) * 100 : 0,
      missed:   teamTotal.missed   > 0 ? (s.missed   / teamTotal.missed)   * 100 : 0,
    };
    const agentRaw = {
      rung: s.rung, missed: s.missed, answered: s.answered,
      pct: agPct, ttt: agTtt, att: agAtt,
    };

    let priorStats = null;
    let priorRaw   = null;
    if (hasPrior) {
      const p = priorSummaryStats[agent];
      const pPct = p.rung > 0 ? (p.answered / p.rung) * 100 : 0;
      const pTtt = p.answered > 0 ? p.ttt      / p.answered : 0;
      const pAtt = p.answered > 0 ? p.attTotal / p.answered : 0;
      priorStats = {
        rung:     p.rung,
        missed:   p.missed,
        answered: p.answered,
        pct:      pPct.toFixed(1) + '%',
        ttt:      formatSecondsHms_(pTtt),
        att:      formatSecondsHms_(pAtt),
      };
      priorRaw = {
        rung: p.rung, missed: p.missed, answered: p.answered,
        pct: pPct, ttt: pTtt, att: pAtt,
      };
    }

    const matchedViaRoster = !!agentMatchedViaRoster[agent];
    const matchedViaQueue  = !!agentMatchedViaQueue[agent];
    const sourceHomes = (matchedViaQueue && !matchedViaRoster && irDeptsByAgent)
      ? (irDeptsByAgent[agent] || [])
      : [];
    return {
      name: agent,
      // excludedFromTeamAvg (E4, Phase E): true when this agent
      // appears in TEAM_AVG_EXCLUDES[dept] -- per INV-26, those
      // agents are subtracted from BOTH numerator and denominator
      // of the team-avg. Client renders an "EXCLUDED" pill on the
      // agent's row so the exclusion is visible to managers reading
      // the report.
      excludedFromTeamAvg: !!excludedAgents[agent],
      // INV-53 floater-awareness fields. matchedViaRoster=true for
      // roster members; matchedViaQueue=true for agents whose rows
      // had queue-overlap with this dept's queue extensions. Floaters
      // (queue-only) render with the QUEUE chip + sourceHomes suffix.
      matchedViaRoster: matchedViaRoster,
      matchedViaQueue:  matchedViaQueue,
      sourceHomes:      sourceHomes,
      stats: {
        rung:     s.rung,
        missed:   s.missed,
        answered: s.answered,
        pct:      agPct.toFixed(1) + '%',
        ttt:      formatSecondsHms_(agTtt),
        att:      formatSecondsHms_(agAtt),
      },
      raw: agentRaw,
      share: {
        rung:     share.rung.toFixed(1)     + '%',
        answered: share.answered.toFixed(1) + '%',
        missed:   share.missed.toFixed(1)   + '%',
        rawRung:     share.rung,
        rawAnswered: share.answered,
        rawMissed:   share.missed,
      },
      insights: buildAgentInsights_(agentRaw, teamAvg),
      priorStats: priorStats,
      priorRaw:   priorRaw,
    };
  });

  // Human-readable date label like "Jan 5, 2026 - Jan 18, 2026".
  const dateLabel = Utilities.formatDate(startDate, TZ, 'MMM d, yyyy')
                  + ' - '
                  + Utilities.formatDate(endDate,   TZ, 'MMM d, yyyy');
  let priorDateLabel = null;
  if (hasPrior) {
    const priorStart = parseIso_(priorFrom);
    const priorEnd   = parseIso_(priorTo);
    priorDateLabel = Utilities.formatDate(priorStart, TZ, 'MMM d, yyyy')
                   + ' - '
                   + Utilities.formatDate(priorEnd,   TZ, 'MMM d, yyyy');
  }

  return {
    meta: {
      department: dept,
      from: from, to: to,
      priorFrom: hasPrior ? priorFrom : null,
      priorTo:   hasPrior ? priorTo   : null,
      trendStart: trendStartIso,
      trendEnd:   trendEndIso,
      agents: selectedAgents,
      mode: selectedAgents.length > 1 ? 'comparison' : 'individual',
      rosterSize: roster.names.length,
      activeAgentCount: activeAgentCount,
      excludedAgents: excludeList,
      generatedAt: new Date().toISOString(),
    },
    dateLabel: dateLabel,
    priorDateLabel: priorDateLabel,
    trendData: { labels: chartLabels, datasets: chartDatasets },
    summaryData: summaryData,
    teamAvg: teamAvgOut,
    deptStats: deptStats,
    mode: selectedAgents.length > 1 ? 'comparison' : 'individual',
  };
}

function emptyIndividualReport_(dept, from, to, selectedAgents, masterMonthKeys) {
  // Empty-shape excludedFromTeamAvg lookup (E4): even when there's no
  // data, we surface the flag so the badge renders consistently --
  // useful when a manager opens a range that has no calls yet but
  // wants to confirm an excluded agent is still configured as such.
  const emptyExcludedSet = {};
  const emptyExcludeList = getTeamAvgExcludes_(dept);
  for (let i = 0; i < emptyExcludeList.length; i++) emptyExcludedSet[emptyExcludeList[i]] = true;
  // Per INV-53: also surface matchedViaRoster on the empty shape so
  // the UI can still render an unflagged card. matchedViaQueue is
  // always false here because there's no Raw Data to detect overlap
  // against -- a floater selection in an empty range falls out
  // entirely (no card rendered).
  const emptyRoster = getRosterForDepartment_(dept);
  const emptyRosterSet = {};
  for (let i = 0; i < emptyRoster.names.length; i++) emptyRosterSet[emptyRoster.names[i]] = true;
  const labels = (masterMonthKeys || []).map(function (m) {
    const p = m.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, 1);
    return Utilities.formatDate(d, TZ, 'MMM, yy');
  });
  const datasets = {};
  selectedAgents.forEach(function (a) {
    datasets[a] = labels.map(function () {
      return { rung: 0, missed: 0, answered: 0, pct: 0, att: 0 };
    });
  });
  return {
    meta: {
      department: dept, from: from, to: to,
      trendStart: from, trendEnd: to,
      agents: selectedAgents,
      mode: selectedAgents.length > 1 ? 'comparison' : 'individual',
      rosterSize: 0,
      generatedAt: new Date().toISOString(),
    },
    dateLabel: from + ' - ' + to,
    priorDateLabel: null,
    trendData: { labels: labels, datasets: datasets },
    summaryData: selectedAgents.filter(function (a) {
      // Empty range: only roster members render (floaters need actual
      // rows to be confirmed as matched via queue).
      return !!emptyRosterSet[a];
    }).map(function (a) {
      return {
        name: a,
        excludedFromTeamAvg: !!emptyExcludedSet[a],
        matchedViaRoster: true,
        matchedViaQueue:  false,
        sourceHomes:      [],
        stats: { rung: 0, missed: 0, answered: 0, pct: '0.0%', ttt: '0:00:00', att: '0:00:00' },
        raw:   { rung: 0, missed: 0, answered: 0, pct: 0, ttt: 0, att: 0 },
        share: { rung: '0.0%', answered: '0.0%', missed: '0.0%',
                 rawRung: 0, rawAnswered: 0, rawMissed: 0 },
        insights: [],
        priorStats: null,
        priorRaw:   null,
      };
    }),
    teamAvg: {
      rung: 0, missed: 0, answered: 0, pct: '0.0%', ttt: '0:00:00', att: '0:00:00',
      raw: { rung: 0, missed: 0, answered: 0, pctAnswered: 0, ttt: 0, att: 0 },
    },
    deptStats: { dailyRung: '0.0', dailyMissed: '0.0', dailyAnswered: '0.0', ansPct: '0.0%', activeDays: 0 },
    mode: selectedAgents.length > 1 ? 'comparison' : 'individual',
  };
}

/**
 * Rules-based notable comparisons between this agent and the team
 * average. Returns up to 3 insights of shape { type, text }, where
 * `type` is one of:
 *   positive -- agent is on the favorable side of the metric
 *   negative -- agent is on the unfavorable side
 *   neutral  -- direction-ambiguous metric (e.g. ATT, where longer
 *               could mean "more thorough" or "slower" depending
 *               on context; surface but don't color-code as good/
 *               bad).
 *
 * Rule order = surfacing priority:
 *   1. % Answered     (>= 5 pt absolute spread, agent rung >= 10)
 *   2. Call volume    (>= 25% relative spread, team rung > 0)
 *   3. Avg talk time  (>= 25% relative spread, agent answered >= 10)
 *   4. Missed-call    (>= 30% relative spread, agent missed >= 3)
 *
 * Tuning notes:
 *   - Activity-minimum gates (rung>=5/10, answered>=10, missed>=3)
 *     suppress one-call outliers from triggering noise.
 *   - 25-30% relative spreads catch real outliers but spare the
 *     ~20% normal day-to-day variance most depts see.
 */
function buildAgentInsights_(agent, teamAvg) {
  const out = [];
  if (!agent || agent.rung < 5) return out;

  if (agent.rung >= 10 && teamAvg.pctAnswered > 0) {
    const pctDelta = agent.pct - teamAvg.pctAnswered;
    if (Math.abs(pctDelta) >= 5) {
      const above = pctDelta > 0;
      out.push({
        type: above ? 'positive' : 'negative',
        text: 'Answer rate is ' + Math.abs(pctDelta).toFixed(1)
            + ' pts ' + (above ? 'above' : 'below') + ' team avg ('
            + agent.pct.toFixed(1) + '% vs '
            + teamAvg.pctAnswered.toFixed(1) + '%).',
      });
    }
  }

  if (teamAvg.rung > 0) {
    const rungDelta = ((agent.rung - teamAvg.rung) / teamAvg.rung) * 100;
    if (Math.abs(rungDelta) >= 25) {
      const above = rungDelta > 0;
      out.push({
        type: above ? 'positive' : 'negative',
        text: 'Call volume is ' + Math.abs(rungDelta).toFixed(0)
            + '% ' + (above ? 'higher' : 'lower') + ' than team avg ('
            + agent.rung + ' vs ' + teamAvg.rung + ' rung).',
      });
    }
  }

  // ATT direction is genuinely ambiguous -- longer can mean
  // thorough service or slow handling. Mark neutral so the UI
  // surfaces it without coloring as good/bad.
  if (teamAvg.att > 0 && agent.answered >= 10) {
    const attDelta = ((agent.att - teamAvg.att) / teamAvg.att) * 100;
    if (Math.abs(attDelta) >= 25) {
      out.push({
        type: 'neutral',
        text: 'Avg talk time is ' + Math.abs(attDelta).toFixed(0)
            + '% ' + (attDelta > 0 ? 'longer' : 'shorter') + ' than team avg ('
            + formatSecondsHms_(agent.att) + ' vs '
            + formatSecondsHms_(teamAvg.att) + ').',
      });
    }
  }

  if (teamAvg.missed > 0 && agent.missed >= 3) {
    const missedDelta = ((agent.missed - teamAvg.missed) / teamAvg.missed) * 100;
    if (Math.abs(missedDelta) >= 30) {
      const above = missedDelta > 0;
      out.push({
        type: above ? 'negative' : 'positive',
        text: 'Missed-call count is ' + Math.abs(missedDelta).toFixed(0)
            + '% ' + (above ? 'above' : 'below') + ' team avg ('
            + agent.missed + ' vs ' + teamAvg.missed + ' missed).',
      });
    }
  }

  return out.slice(0, 3);
}

/**
 * Emails the report's rendered image (data: URL base64 PNG) to the
 * active user. Used by the "Email (Image)" button. Returns the
 * recipient's email so the client can confirm in the UI.
 */
function sendIndividualReportEmail(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dataUrl = String((req && req.imageBase64) || '');
  const dateLabel = String((req && req.dateLabel) || 'Individual Report');
  if (!dataUrl) throw new Error('No image payload.');
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('Malformed image payload.');
  const decoded = Utilities.base64Decode(dataUrl.slice(commaIdx + 1));
  const blob = Utilities.newBlob(decoded, 'image/png', 'Individual_Report.png');

  MailApp.sendEmail({
    to: email,
    subject: 'Individual Report: ' + dateLabel,
    htmlBody:
      '<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">'
      + 'Here is the visual snapshot of the individual performance report.'
      + '</div>'
      + '<div style="text-align: center; border: 1px solid #eee; padding: 10px;">'
      + '<img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;">'
      + '</div>',
    inlineImages: { reportImg: blob },
  });
  return { to: email };
}

// generateMonthList_, formatSecondsHms_ moved to Util.gs.
