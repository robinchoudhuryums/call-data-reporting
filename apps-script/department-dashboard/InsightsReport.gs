/**
 * Insights Report -- a unified period-comparison report that combines
 * the Performance Report's DEPARTMENT ROLLUP (current vs an
 * immediately-preceding prior period, INV-28) with PER-AGENT
 * comparison CARDS (folding in the Individual Report's vs-self
 * comparison). Added ALONGSIDE the originals (Performance / Compare
 * Ranges / Individual) so the combined view can be validated against
 * them before any of them is retired.
 *
 * Comparison modes: the prior window defaults to the immediately-
 * preceding same-length window the Performance Report uses (INV-28).
 * The request may instead supply an EXPLICIT priorFrom/priorTo pair
 * (both-or-neither, same contract as IR's INV-49 / PR's custom prior)
 * -- the client resolves "Same window last year" / "Custom prior
 * range" to concrete dates, so the server's mode-specific block stays
 * a single override. `meta.comparisonMode` is 'prior' (auto) or
 * 'custom' (explicit dates supplied).
 *
 * Views (both rendered):
 *   - Team rollup: KPI tiles (Rung / Missed / Answered / % Answered /
 *     TTT / ATT) with the current value + delta vs prior. Roster-only
 *     (INV-53 floater exclusion); ATT weighted by Answered (INV-25).
 *     Tiles carry sparklines from `trendData` -- the 12-month monthly
 *     team rollup (same INV-29 trend-window logic + response shape as
 *     the Performance Report, so the client chart helpers are shared).
 *   - Per-agent cards: each selected agent's current + prior + delta
 *     across the same six metrics. Floaters render with the QUEUE chip
 *     but do NOT factor into the team rollup (INV-53).
 *
 * Public entries (callable via google.script.run):
 *   getInsightsReportInit({ department, from?, to? })
 *     -> picker init (delegates to getIndividualReportInit, like
 *        Performance, so it reuses the same roster + active-in-range
 *        subset cache).
 *   getInsightsReport({ department, from, to, agents, priorFrom?, priorTo? })
 *     -> { meta, dateLabel, priorDateLabel, teamStats, agentData,
 *          teamInsights, trendData }
 *   sendInsightsReportEmail({ imageBase64, dateLabel }) -> { to }
 *
 * Reuse (Apps Script flat global scope): deltaBlock_ (Performance),
 * buildTeamInsights_ + formatSecondsHms_ (Util), getRosterForDepartment_
 * / getDeptQueueExts_ / parseExtensions_ / rowDateIso_ / parseHmsDisplay_
 * / buildDeptsByAgent_ / hashAgents_ (Data), and the F1 read helpers
 * (NeonRead). No new aggregation primitives are introduced.
 *
 * Caching: 30 min (REPORT_CACHE_TTL_SECONDS) per
 * (dept, from, to, sortedAgents) tuple under INSIGHTS_CACHE_KEY_PREFIX.
 */

// Bump when the aggregation rules or response shape change. Listed in
// the CLAUDE.md INV-30 canonical cache-prefix registry.
// v2: optional explicit priorFrom/priorTo (custom / YoY comparison
// windows resolved client-side, INV-49 pattern) + `trendData` (12-mo
// monthly team rollup powering tile sparklines + the trend chart;
// same shape as the Performance Report's). Cache key gains a priorKey
// segment so the prior window is part of the cache identity.
// v3: meta gains currentDays / priorDays / lengthMismatch (INV-35
// semantics ported from Compare Ranges -- drives the client's
// different-length warning banner + per-day sublines when a custom
// prior window's length differs >= 1.2x from the current range).
// v4: response gains `queueHealth` (QCD-into-Insights consolidation:
//     queue-level totals + prior-window totals + per-queue rows with
//     violation dates, via computeQcdReport_; null when unmapped).
const INSIGHTS_CACHE_KEY_PREFIX = 'insights:v4';

function getInsightsReportInit(req) {
  // Same picker UX (roster + default dates + active-in-range subset) as
  // the Individual / Performance reports, so delegate to their shared init.
  return getIndividualReportInit(req);
}

function getInsightsReport(req) {
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
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');

  // Optional explicit prior window (both-or-neither; INV-49 pattern).
  // Absent = auto-adjacent prior (INV-28). The client resolves YoY /
  // custom selections to concrete dates before calling.
  const customPriorFrom = String((req && req.priorFrom) || '').trim();
  const customPriorTo   = String((req && req.priorTo)   || '').trim();
  if (customPriorFrom || customPriorTo) {
    if (!isIsoDate_(customPriorFrom) || !isIsoDate_(customPriorTo)) {
      throw new Error('priorFrom/priorTo must be YYYY-MM-DD.');
    }
    if (customPriorFrom > customPriorTo) {
      throw new Error('priorFrom must be on or before priorTo.');
    }
  }

  const rawAgents = (req && req.agents) || [];
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    throw new Error('Select at least one agent.');
  }
  const roster = getRosterForDepartment_(dept);
  // INV-53: keep the input gate open so floaters can be included; off-dept
  // crafted names with no queue overlap fall out at the row-scan layer.
  const seen = {};
  const selectedAgents = [];
  for (let i = 0; i < rawAgents.length; i++) {
    const n = String(rawAgents[i] || '').trim();
    if (!n || seen[n]) continue;
    seen[n] = true;
    selectedAgents.push(n);
  }
  if (selectedAgents.length === 0) throw new Error('No selected agent provided.');

  // MD5 hash keeps the cache key bounded regardless of selection size
  // (CacheService rejects keys > 250 chars; INV-36).
  const agentsKey = hashAgents_(selectedAgents);
  const priorKey = (customPriorFrom && customPriorTo)
    ? customPriorFrom + '..' + customPriorTo
    : 'auto';
  const cache = CacheService.getScriptCache();
  const cacheKey = INSIGHTS_CACHE_KEY_PREFIX + ':' + dept + ':' + from + ':' + to
                 + ':' + agentsKey + ':' + priorKey;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      logReportUsage_('insights', dept, user, true);
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeInsights_(dept, from, to, selectedAgents, roster,
                                customPriorFrom, customPriorTo);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  try { cache.put(cacheKey, JSON.stringify(data), REPORT_CACHE_TTL_SECONDS); }
  catch (e) { Logger.log('InsightsReport cache put failed: %s', e); }

  logReportUsage_('insights', dept, user, false);
  return data;
}

function computeInsights_(dept, from, to, selectedAgents, roster,
                          customPriorFrom, customPriorTo) {
  const selectedSet = {};
  for (let i = 0; i < selectedAgents.length; i++) selectedSet[selectedAgents[i]] = true;
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  // Floater tracking (INV-53). matchedViaRoster pre-populated for selected
  // roster members so zero-call picks still render; matchedViaQueue set
  // lazily on an observed queue-overlap row. Team rollup gates on
  // matchedViaRoster so floaters stay out of dept averages.
  const agentMatchedViaRoster = {};
  const agentMatchedViaQueue  = {};
  for (let i = 0; i < selectedAgents.length; i++) {
    if (rosterSet[selectedAgents[i]]) agentMatchedViaRoster[selectedAgents[i]] = true;
  }

  const parseIso_ = function (iso) {
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
  };
  const startDate = parseIso_(from);
  const endDate   = parseIso_(to);
  const msPerDay  = 86400000;
  const isoOf = function (d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); };

  // --- Prior window (the ONLY mode-specific block) -------------------
  // Default: same-length window ending one day before the current start
  // (INV-28), via the SHARED computePriorWindow_ (Data.gs) -- the same
  // implementation computeSummary_'s E5 chips and the Performance
  // Report use, so the three surfaces can't drift. When the request
  // supplies an explicit priorFrom/priorTo (YoY / custom, resolved
  // client-side), it overrides the default -- everything below is
  // mode-agnostic.
  let priorStartDate, priorEndDate, priorFrom, priorTo, priorIsCustom;
  if (customPriorFrom && customPriorTo) {
    priorStartDate = parseIso_(customPriorFrom);
    priorEndDate   = parseIso_(customPriorTo);
    priorFrom      = customPriorFrom;
    priorTo        = customPriorTo;
    priorIsCustom  = true;
  } else {
    const priorWindow = computePriorWindow_(from, to);
    priorFrom      = priorWindow.from;
    priorTo        = priorWindow.to;
    priorStartDate = parseIso_(priorFrom);
    priorEndDate   = parseIso_(priorTo);
    priorIsCustom  = false;
  }

  // --- Window-length metadata (INV-35 semantics, ported from Compare
  //     Ranges). With the auto-adjacent prior the lengths are always
  //     equal; a custom prior can differ, and when the longer window is
  //     >= 1.2x the shorter, volume totals aren't directly comparable
  //     -- the client renders a warning banner + per-day sublines.
  // Math.round, not floor/ceil: noon-anchored dates wobble +-1h across
  // DST transitions; round absorbs it (floor truncated spring-forward).
  const currentDays = Math.round((endDate - startDate) / msPerDay) + 1;
  const priorDays   = Math.round((priorEndDate - priorStartDate) / msPerDay) + 1;
  const lengthMismatch = (Math.min(currentDays, priorDays) > 0)
    && (Math.max(currentDays, priorDays) / Math.min(currentDays, priorDays) >= 1.2);

  // --- Trend window (INV-29; mirrors the Performance Report) ---------
  // 12-month monthly buckets ending on `to`, unless the range itself is
  // > 366 days or a full calendar year (then the range IS the window).
  const diffDays = Math.round(Math.abs(endDate - startDate) / msPerDay) + 1;
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
  const trendFrom = isoOf(trendStartDate);
  const trendTo   = to;
  const monthKeys = generateMonthList_(trendStartDate, endDate);

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptyInsights_(dept, from, to, priorFrom, priorTo, selectedAgents,
                          monthKeys, priorIsCustom);
  }
  const ssTZ = ss.getSpreadsheetTimeZone();

  // F1-aware read over the UNION of the three windows this report scans
  // -- current [from,to], prior [priorFrom,priorTo] (may sit anywhere
  // relative to current once custom priors exist), and the 12-mo trend
  // [trendFrom,trendTo]. Mirrors the Performance Report read; default
  // 'sheet' is unchanged.
  const numCols  = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  let fetchFrom = from;
  if (trendFrom < fetchFrom) fetchFrom = trendFrom;
  if (priorFrom < fetchFrom) fetchFrom = priorFrom;
  let fetchTo = to;
  if (priorTo > fetchTo) fetchTo = priorTo;
  const dqeSource = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  let srcRows = null;
  let deptQueueExts;
  let effectiveSource = 'sheet';
  const _tRead = Date.now();
  if (dqeSource === 'neon' && typeof neonFetchDqeRows_ === 'function') {
    srcRows = neonFetchDqeRows_(fetchFrom, fetchTo);
    if (srcRows && srcRows.length) {
      const extValues = sheet.getRange(2, 1, lastRow - 1, HISTORICAL_COLS.QUEUE_EXT).getValues();
      deptQueueExts = getDeptQueueExts_(dept, rosterSet, extValues).exts;
      effectiveSource = 'neon';
    } else {
      srcRows = null;
      Logger.log('computeInsights_: neon returned no rows; falling back to sheet.');
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
  if (typeof logDqeReadTiming_ === 'function') {
    logDqeReadTiming_('computeInsights_:' + dept, effectiveSource, _tRead, srcRows.length);
  }

  // Accumulators. att_sum = sum(per-day ATT * per-day Answered) so the
  // weighted ATT = att_sum / answered (INV-25). monthlyTeam mirrors the
  // Performance Report's trend rollup: month-keyed totals across the
  // selected ROSTER agents (floaters excluded per INV-53).
  const blank = function () { return { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 }; };
  const teamCurr = blank();
  const teamPrev = blank();
  const perAgentCurr  = {};
  const perAgentPrior = {};
  selectedAgents.forEach(function (a) { perAgentCurr[a] = blank(); perAgentPrior[a] = blank(); });
  const monthlyTeam = {};
  monthKeys.forEach(function (k) { monthlyTeam[k] = blank(); });

  for (let i = 0; i < srcRows.length; i++) {
    const row = srcRows[i];
    const dateIso = row.dateIso;
    if (!dateIso) continue;
    const agent = row.agent;
    if (!agent) continue;
    // Queue-sentinel rows (queue-only abandoned events) -- not real agents.
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;
    if (!selectedSet[agent]) continue;

    const inCurrent = (dateIso >= from && dateIso <= to);
    const inPrior   = (dateIso >= priorFrom && dateIso <= priorTo);
    const inTrend   = (dateIso >= trendFrom && dateIso <= trendTo);
    if (!inCurrent && !inPrior && !inTrend) continue;

    // Floater detection (INV-53): a selected non-roster agent only counts
    // if their col-D extensions overlap the dept's queue set.
    if (!rosterSet[agent] && !agentMatchedViaQueue[agent]) {
      const rowExts = parseExtensions_(row.queueExt);
      for (let j = 0; j < rowExts.length; j++) {
        if (deptQueueExts[rowExts[j]]) { agentMatchedViaQueue[agent] = true; break; }
      }
    }
    const isRoster = !!agentMatchedViaRoster[agent];

    const rung     = row.totalRung;
    const missed   = row.totalMissed;
    const answered = row.totalAnswered;
    const tttSec   = row.tttSec;
    const attTotal = answered > 0 ? row.attSec * answered : 0;

    // Current wins when a custom prior window overlaps the current
    // range (same else-if semantics as the Performance Report).
    if (inCurrent) {
      const ag = perAgentCurr[agent];
      ag.rung += rung; ag.missed += missed; ag.answered += answered;
      ag.ttt += tttSec; ag.att_sum += attTotal;
      if (isRoster) {
        teamCurr.rung += rung; teamCurr.missed += missed; teamCurr.answered += answered;
        teamCurr.ttt += tttSec; teamCurr.att_sum += attTotal;
      }
    } else if (inPrior) {
      const ap = perAgentPrior[agent];
      ap.rung += rung; ap.missed += missed; ap.answered += answered;
      ap.ttt += tttSec; ap.att_sum += attTotal;
      if (isRoster) {
        teamPrev.rung += rung; teamPrev.missed += missed; teamPrev.answered += answered;
        teamPrev.ttt += tttSec; teamPrev.att_sum += attTotal;
      }
    }
    if (inTrend && isRoster) {
      const mb = monthlyTeam[dateIso.slice(0, 7)];
      if (mb) {
        mb.rung += rung; mb.missed += missed; mb.answered += answered;
        mb.ttt += tttSec; mb.att_sum += attTotal;
      }
    }
  }

  // --- Team stats with deltas (reuse deltaBlock_) --------------------
  const currPct = teamCurr.rung     > 0 ? (teamCurr.answered / teamCurr.rung)   * 100 : 0;
  const prevPct = teamPrev.rung     > 0 ? (teamPrev.answered / teamPrev.rung)   * 100 : 0;
  const currAtt = teamCurr.answered > 0 ? (teamCurr.att_sum  / teamCurr.answered)     : 0;
  const prevAtt = teamPrev.answered > 0 ? (teamPrev.att_sum  / teamPrev.answered)     : 0;
  const teamStats = {
    rung:     deltaBlock_(teamCurr.rung,     teamPrev.rung,     'volume',    String(teamCurr.rung)),
    missed:   deltaBlock_(teamCurr.missed,   teamPrev.missed,   'volume',    String(teamCurr.missed)),
    answered: deltaBlock_(teamCurr.answered, teamPrev.answered, 'volume',    String(teamCurr.answered)),
    pct:      deltaBlock_(currPct,           prevPct,           'pctPoints', currPct.toFixed(1) + '%'),
    ttt:      deltaBlock_(teamCurr.ttt,      teamPrev.ttt,      'volume',    formatSecondsHms_(teamCurr.ttt)),
    att:      deltaBlock_(currAtt,           prevAtt,           'volume',    formatSecondsHms_(currAtt)),
  };

  // --- Per-agent cards ----------------------------------------------
  // Drop selected names that match neither path (off-dept crafted names
  // with no queue overlap); roster members always pass (INV-53).
  const visibleAgents = selectedAgents.filter(function (a) {
    return agentMatchedViaRoster[a] || agentMatchedViaQueue[a];
  });
  let depsByAgent = null;
  for (let i = 0; i < visibleAgents.length; i++) {
    if (agentMatchedViaQueue[visibleAgents[i]] && !agentMatchedViaRoster[visibleAgents[i]]) {
      depsByAgent = buildDeptsByAgent_();
      break;
    }
  }
  const agentData = visibleAgents.map(function (agent) {
    const c = perAgentCurr[agent], p = perAgentPrior[agent];
    const cPct = c.rung     > 0 ? (c.answered / c.rung)   * 100 : 0;
    const pPct = p.rung     > 0 ? (p.answered / p.rung)   * 100 : 0;
    const cAtt = c.answered > 0 ? (c.att_sum  / c.answered)     : 0;
    const pAtt = p.answered > 0 ? (p.att_sum  / p.answered)     : 0;
    const matchedViaRoster = !!agentMatchedViaRoster[agent];
    const matchedViaQueue  = !!agentMatchedViaQueue[agent];
    const sourceHomes = (matchedViaQueue && !matchedViaRoster && depsByAgent)
      ? (depsByAgent[agent] || []) : [];
    return {
      name: agent,
      matchedViaRoster: matchedViaRoster,
      matchedViaQueue:  matchedViaQueue,
      sourceHomes:      sourceHomes,
      // Each metric is a deltaBlock_ (current vs prior), same shape the
      // team tiles use -- so the client renders both with one helper.
      metrics: {
        rung:     deltaBlock_(c.rung,     p.rung,     'volume',    String(c.rung)),
        missed:   deltaBlock_(c.missed,   p.missed,   'volume',    String(c.missed)),
        answered: deltaBlock_(c.answered, p.answered, 'volume',    String(c.answered)),
        pct:      deltaBlock_(cPct,       pPct,       'pctPoints', cPct.toFixed(1) + '%'),
        ttt:      deltaBlock_(c.ttt,      p.ttt,      'volume',    formatSecondsHms_(c.ttt)),
        att:      deltaBlock_(cAtt,       pAtt,       'volume',    formatSecondsHms_(cAtt)),
      },
      rawAnswered: c.answered,
    };
  }).sort(function (a, b) { return b.rawAnswered - a.rawAnswered; });

  // --- Team insights vs prior (reuse buildTeamInsights_) -------------
  const teamInsights = buildTeamInsights_(
    { rung: teamCurr.rung, missed: teamCurr.missed, answered: teamCurr.answered, pct: currPct, att: currAtt },
    { rung: teamPrev.rung, missed: teamPrev.missed, answered: teamPrev.answered, pct: prevPct, att: prevAtt }
  );

  // --- 12-month team trend (powers tile sparklines + the trend chart;
  //     same shape as the Performance Report's trendData) -------------
  const trendLabels = monthKeys.map(function (m) {
    const parts = m.split('-');
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return Utilities.formatDate(d, TZ, 'MMM, yy');
  });
  const trendSeries = monthKeys.map(function (m) {
    const b = monthlyTeam[m];
    const pct = b.rung     > 0 ? (b.answered / b.rung)   * 100 : 0;
    const att = b.answered > 0 ? (b.att_sum  / b.answered)     : 0;
    return {
      rung:     b.rung,
      missed:   b.missed,
      answered: b.answered,
      pct:      pct,
      ttt:      b.ttt,
      att:      att,
    };
  });

  const fmt = function (d) { return Utilities.formatDate(d, TZ, 'MMM d, yyyy'); };
  const rosterCount = visibleAgents.filter(function (a) { return agentMatchedViaRoster[a]; }).length;
  return {
    meta: {
      department: dept,
      from: from, to: to,
      priorFrom: priorFrom, priorTo: priorTo,
      comparisonMode: priorIsCustom ? 'custom' : 'prior',
      currentDays: currentDays, priorDays: priorDays,
      lengthMismatch: lengthMismatch,
      trendStart: trendFrom, trendEnd: trendTo,
      agents: selectedAgents,
      rosterSize: roster.names.length,
      rosterAgentCount: rosterCount,
      queueOnlyAgentCount: visibleAgents.length - rosterCount,
      generatedAt: new Date().toISOString(),
    },
    dateLabel:      fmt(startDate)      + ' - ' + fmt(endDate),
    priorDateLabel: fmt(priorStartDate) + ' - ' + fmt(priorEndDate),
    teamStats:    teamStats,
    agentData:    agentData,
    teamInsights: teamInsights,
    trendData:    { labels: trendLabels, series: trendSeries },
    // Queue health (the QCD-into-Insights consolidation): the dept's
    // queue-level abandoned % / violations for the SAME window + prior
    // window, sourced from the same computeQcdReport_ the QCD modal
    // uses so the two surfaces can't disagree. null when the dept has
    // no mapped queues or the QCD sheet is missing (best-effort).
    queueHealth: insightsQueueHealth_(dept, from, to, priorFrom, priorTo),
  };
}

/**
 * Best-effort queue-level rollup for the Insights "Queue health"
 * section. Reuses computeQcdReport_ (QCDReport.gs, flat global scope)
 * for the current AND prior windows -- never throws; null hides the
 * section client-side. INV-51 rollup semantics (sub-queues included).
 * NOTE: totals.violations from computeQcdReport_ is MONTH-TO-DATE
 * (INV-51), so it's surfaced as violationsMtd; the per-queue rows'
 * `violations` are selected-range counts with their violationDates.
 */
function insightsQueueHealth_(dept, from, to, priorFrom, priorTo) {
  try {
    if (typeof computeQcdReport_ !== 'function') return null;
    const cur = computeQcdReport_(dept, from, to);
    if (!cur || !cur.meta || cur.meta.unmapped) return null;
    let prior = null;
    try { prior = computeQcdReport_(dept, priorFrom, priorTo); } catch (e) { prior = null; }
    const pick = function (t) {
      t = t || {};
      return {
        totalCalls:      Number(t.totalCalls) || 0,
        abandoned:       Number(t.abandoned) || 0,
        abandonedPct:    Number(t.abandonedPct) || 0,
        abandonedPctStr: t.abandonedPctStr || '0.00%',
        longestWait:     t.longestWait || '0:00:00',
        avgAnswer:       t.avgAnswer || '0:00:00',
      };
    };
    return {
      queues:        cur.meta.queues || [],
      totals:        pick(cur.totals),
      priorTotals:   prior && prior.meta && !prior.meta.unmapped ? pick(prior.totals) : null,
      violationsMtd: Number(cur.totals && cur.totals.violations) || 0,
      perQueue: (cur.queueBreakdown || []).map(function (q) {
        return {
          queue:           q.queue,
          totalCalls:      q.totalCalls,
          abandoned:       q.abandoned,
          abandonedPct:    q.abandonedPct,
          abandonedPctStr: q.abandonedPctStr,
          violations:      q.violations,
          violationDates:  q.violationDates || [],
        };
      }),
    };
  } catch (e) {
    Logger.log('insightsQueueHealth_ (best-effort): ' + (e && e.message ? e.message : e));
    return null;
  }
}

function emptyInsights_(dept, from, to, priorFrom, priorTo, selectedAgents,
                        monthKeys, priorIsCustom) {
  const roster = getRosterForDepartment_(dept);
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;
  const zeroMetric = function (formatted, type) {
    return { val: 0, prev: 0, formatted: formatted, delta: 0, deltaPct: 0, type: type };
  };
  const zeroMetrics = function () {
    return {
      rung:     zeroMetric('0', 'volume'),
      missed:   zeroMetric('0', 'volume'),
      answered: zeroMetric('0', 'volume'),
      pct:      zeroMetric('0.0%', 'pctPoints'),
      ttt:      zeroMetric('0:00:00', 'volume'),
      att:      zeroMetric('0:00:00', 'volume'),
    };
  };
  // Match the populated path's trendData shape so the client chart /
  // sparklines render an empty axis instead of throwing on a no-data day.
  const trendLabels = (monthKeys || []).map(function (m) {
    const p = m.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, 1);
    return Utilities.formatDate(d, TZ, 'MMM, yy');
  });
  const trendSeries = trendLabels.map(function () {
    return { rung: 0, missed: 0, answered: 0, pct: 0, ttt: 0, att: 0 };
  });
  return {
    meta: {
      department: dept, from: from, to: to,
      priorFrom: priorFrom, priorTo: priorTo,
      comparisonMode: priorIsCustom ? 'custom' : 'prior',
      currentDays: 0, priorDays: 0,
      lengthMismatch: false,
      trendStart: from, trendEnd: to,
      agents: selectedAgents,
      rosterSize: roster.names.length,
      rosterAgentCount: 0, queueOnlyAgentCount: 0,
      generatedAt: new Date().toISOString(),
    },
    dateLabel: from + ' - ' + to,
    priorDateLabel: priorFrom + ' - ' + priorTo,
    teamStats: zeroMetrics(),
    // Only roster members can appear in an empty sheet (floaters need a
    // confirmable queue-overlap row, which doesn't exist here).
    agentData: selectedAgents.filter(function (a) { return !!rosterSet[a]; }).map(function (a) {
      return {
        name: a, matchedViaRoster: true, matchedViaQueue: false, sourceHomes: [],
        metrics: zeroMetrics(), rawAnswered: 0,
      };
    }),
    teamInsights: [],
    trendData: { labels: trendLabels, series: trendSeries },
  };
}

/**
 * Emails the captured Insights Report PNG to the active user. Same
 * pattern as the Performance / Individual email-export paths.
 */
function sendInsightsReportEmail(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dataUrl = String((req && req.imageBase64) || '');
  const dateLabel = String((req && req.dateLabel) || 'Insights Report');
  if (!dataUrl) throw new Error('No image payload.');
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('Malformed image payload.');
  const decoded = Utilities.base64Decode(dataUrl.slice(commaIdx + 1));
  const blob = Utilities.newBlob(decoded, 'image/png', 'Insights_Report.png');

  MailApp.sendEmail({
    to: email,
    subject: 'Insights Report: ' + dateLabel,
    htmlBody:
      '<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">'
      + 'Here is the visual snapshot of the Insights report -- department '
      + 'rollup plus per-agent cards, comparing the selected range against '
      + 'the immediately-preceding period.'
      + '</div>'
      + '<div style="text-align: center; border: 1px solid #eee; padding: 10px;">'
      + '<img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;">'
      + '</div>',
    inlineImages: { reportImg: blob },
  });
  return { to: email };
}
