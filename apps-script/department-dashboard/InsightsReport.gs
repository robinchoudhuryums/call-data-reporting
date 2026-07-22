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
 * Reuse (Apps Script flat global scope): deltaBlock_ (Util.gs; moved
 * there from the retired Performance Report),
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
// v5: queueHealth gains `trend` (monthly abandoned-% series per queue +
//     dept total -- the compact Queue health chart).
// v6: queueHealth.trend gains the DAILY series (Monthly/Daily toggle);
//     queueHealthOwnOnly request flag (sub-queue toggle, mirrors QCD's)
//     joins the cache key; queueHealth carries hasSubQueues +
//     includeSubQueues so the client can show/hide the toggle.
// v7: trend + queue-health charts CONSOLIDATED into one tabbed chart.
//     Response gains `trendDaily` (daily team series for the selected
//     window -> the chart's Monthly/Daily toggle for Answered/%/ATT);
//     queueHealth now always-separates sub-queues (seq #5) -- the
//     `queueHealthOwnOnly` request flag + the cache `qhown/qhroll`
//     dimension are retired, and queueHealth.perQueue rows carry `subDept`.
// v9..v18: see CLAUDE.md INV-30 -- the canonical version history.
// v8: queueHealth.perQueue rows gain `topAbandonSource` (4c) -- the
//     non-Overall call source driving the most abandons in that queue
//     (from the bySource breakdown 4a added to computeQcdReport_), so
//     the Queue health table can annotate WHERE a queue's abandons come
//     from. Null when no sub-source has abandons.
const INSIGHTS_CACHE_KEY_PREFIX = 'insights:v19';

function getInsightsReportInit(req) {
  // Same picker UX (roster + default dates + active-in-range subset) as
  // the Individual / Performance reports, so delegate to their shared init.
  return getIndividualReportInit(req);
}

/**
 * Resolve a requested agent list to a deduped, trimmed selection. An EMPTY
 * request defaults to the full department roster (the digest pattern, INV-45)
 * -- this powers the agent-free "queue / dept dashboard" run of Insights (the
 * QCD-report-replacement quick-look): a manager who picks no agent still gets
 * the team rollup + Queue health + trend + every roster agent's card.
 * Floaters stay excluded because only roster names seed the default. INV-53:
 * a NON-empty selection keeps the input gate open (off-dept crafted names
 * fall out at the row-scan layer). The non-empty path is byte-equivalent to
 * the dedup loop it replaced in getInsightsReport / sendInsightsReportEmail.
 */
function resolveInsightsAgents_(rawAgents, roster) {
  const seen = {};
  const out = [];
  const push = function (name) {
    const n = String(name || '').trim();
    if (!n || seen[n]) return;
    seen[n] = true;
    out.push(n);
  };
  const list = Array.isArray(rawAgents) ? rawAgents : [];
  for (let i = 0; i < list.length; i++) push(list[i]);
  if (out.length === 0) {
    const names = (roster && roster.names) || [];
    for (let i = 0; i < names.length; i++) push(names[i]);
  }
  return out;
}

function getInsightsReport(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  assertDeptAccess_(user, dept);

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

  const roster = getRosterForDepartment_(dept);
  // INV-53: keep the input gate open so floaters can be included; off-dept
  // crafted names with no queue overlap fall out at the row-scan layer.
  // Agent-free (QCD-replacement) run: an EMPTY selection defaults to the full
  // department roster (resolveInsightsAgents_ -- the digest pattern, INV-45),
  // so a manager can open Insights as a queue / dept dashboard without first
  // picking agents and still get the team rollup + Queue health + trend +
  // every roster agent's card.
  const selectedAgents = resolveInsightsAgents_(req && req.agents, roster);
  if (selectedAgents.length === 0) throw new Error('No agents on this department\'s roster.');

  // MD5 hash keeps the cache key bounded regardless of selection size
  // (CacheService rejects keys > 250 chars; INV-36).
  const agentsKey = hashAgents_(selectedAgents);
  const priorKey = (customPriorFrom && customPriorTo)
    ? customPriorFrom + '..' + customPriorTo
    : 'auto';
  const cache = CacheService.getScriptCache();
  // CORE-3 (extended for #3): suffix the key with BOTH read sources -- Insights
  // embeds the DQE agent data/trend AND the QCD Queue-health section, so a flip
  // of EITHER DQE_READ_SOURCE or QCD_READ_SOURCE can't serve a cross-source
  // payload for the TTL.
  const dqeReadSrc = (typeof readSourceCacheTag_ === 'function') ? readSourceCacheTag_() : 'sheet-sheet';
  const cacheKey = INSIGHTS_CACHE_KEY_PREFIX + ':' + dept + ':' + from + ':' + to
                 + ':' + agentsKey + ':' + priorKey + ':' + dqeReadSrc;
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

  // RPT-3: never cache a payload whose Queue health is the F8 error shape
  // ({error:true}, a transient QCD read/compute failure) -- the INV-30 rule
  // the Inbound/Direct reports already follow for unavailable payloads.
  // Since the QCD retirement this is managers' ONLY queue surface; caching
  // the error pinned "Queue health unavailable" for every viewer of this
  // (dept, range, agents, prior) tuple for the full 30-min TTL.
  if (data.queueHealth && data.queueHealth.error) {
    Logger.log('InsightsReport: queueHealth errored -- skipping cache put so the next request retries.');
  } else if (data.meta && data.meta.sourceUnavailable) {
    // R8-C1: outage-empty shape (Neon unreachable + no DQE sheet) -- never
    // pin it for the TTL; the next request retries the live source.
    Logger.log('InsightsReport: DQE source unavailable -- skipping cache put.');
  } else if (typeof deptConfigReadFailed_ === 'function' && deptConfigReadFailed_()) {
    // R8-C4: Queue health was built with constant-only config after a
    // failed Dept Config read -- serve it, don't pin it.
    Logger.log('InsightsReport: Dept Config read errored -- skipping cache put.');
  } else {
    try { cache.put(cacheKey, JSON.stringify(data), REPORT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('InsightsReport cache put failed: %s', e); }
  }

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
  // INV-35: flag on WORKING days (Mon-Fri), not calendar days, so equal-
  // workday windows with a different weekend count aren't falsely flagged.
  // currentDays/priorDays (calendar) are kept for display/per-day sublines.
  const currentWorkDays = countWorkingDays_(from, to);
  const priorWorkDays   = countWorkingDays_(priorFrom, priorTo);
  const lengthMismatch = (Math.min(currentWorkDays, priorWorkDays) > 0)
    && (Math.max(currentWorkDays, priorWorkDays) / Math.min(currentWorkDays, priorWorkDays) >= 1.2);

  // --- Trend window (INV-29; shared helper in Util.gs keeps IR/PR/
  // Insights/QCD aligned) -------------------------------------------
  // 12-month monthly buckets ending on `to`, unless the range itself is
  // > 366 days or a full calendar year (then the range IS the window).
  const trendStartDate = computeTrendStartDate_(startDate, endDate);
  const trendFrom = isoOf(trendStartDate);
  const trendTo   = to;
  const monthKeys = generateMonthList_(trendStartDate, endDate);

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  // F-35: hard-require the DQE sheet only when it IS the read source. With
  // DQE_READ_SOURCE=neon the sheet may be trimmed/archived -- the old
  // unconditional check served the EMPTY report despite dqe_history being
  // fully populated (so the sheet could never actually be retired). If the
  // Neon read then fails or returns nothing, the sheet-fallback block below
  // returns the empty report rather than crashing on the missing sheet.
  const dqeSource = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  const neonCapable = (dqeSource === 'neon' && typeof neonFetchDqeRows_ === 'function');
  const lastRow = sheet ? sheet.getLastRow() : 0;
  if (!neonCapable) {
    if (!sheet) throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
    if (lastRow < 2) {
      return emptyInsights_(dept, from, to, priorFrom, priorTo, selectedAgents,
                            monthKeys, priorIsCustom);
    }
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
  let srcRows = null;
  let deptQueueExts;
  let effectiveSource = 'sheet';
  const _tRead = Date.now();
  if (neonCapable) {
    srcRows = neonFetchDqeRows_(fetchFrom, fetchTo);
    if (neonDqeRowsUsable_(srcRows)) {   // LM2: reachable-empty is trusted; only unreachable falls back
      // RPT-4: the Neon path derives the dept ext set via the shared Neon
      // helper (its own sheet fallback covers F-35), like IR and Missed --
      // this was the last reader still doing a full-sheet cols A..D read
      // while flagged onto Neon.
      deptQueueExts = deptQueueExtsForNeonReader_(dept, rosterSet, sheet, lastRow).exts;
      effectiveSource = 'neon';
    } else {
      srcRows = null;
      Logger.log('computeInsights_: neon returned no rows; falling back to sheet.');
    }
  }
  if (srcRows === null) {
    if (!sheet || lastRow < 2) {   // F-35: neon empty AND no sheet to fall back to
      const e = emptyInsights_(dept, from, to, priorFrom, priorTo, selectedAgents,
                               monthKeys, priorIsCustom);
      // R8-C1: neon-path corner = source OUTAGE (reachable-empty is trusted
      // upstream, LM2), not real data -- mark so the caller skips the cache
      // put (the RPT-3 / Inbound unavailable-not-cached discipline).
      if (neonCapable) e.meta.sourceUnavailable = true;
      return e;
    }
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
  // Daily team series over the SELECTED window (powers the consolidated
  // trend chart's Daily view; the Monthly view uses monthlyTeam). Roster-
  // gated like teamCurr so floaters don't dilute it (INV-53).
  const dailyTeam = {};   // iso -> blank()
  // Roster members with ANY activity in the CURRENT window. This is the
  // team-average divisor the client uses (team-total / rosterAgentCount).
  // Matches the Individual Report's active-agent denominator (INV-27) so
  // the two reports compute the same per-agent baseline for identical
  // inputs -- counting all SELECTED roster members (incl. zero-activity
  // ones) understated the baseline (F1).
  const activeRosterCurr = {};   // agent -> true
  // R11-E (item 6): full-department answered total in the CURRENT window over
  // ALL active roster agents -- NOT just the selected ones. The share-of-
  // answered donut divides by this (and folds unselected agents into an
  // "Other" slice) so a given agent's share is the same whether the report is
  // run for the whole dept or a subset (it was previously a share of the
  // SELECTED agents' answered, which inflated shares on a partial selection).
  let deptAnsweredCurr = 0;
  // R11-E (item 4): per-agent monthly series for the per-agent trend line chart
  // (one line per selected agent, month axis = trendLabels). agent -> ym -> {}.
  const perAgentMonthly = {};

  for (let i = 0; i < srcRows.length; i++) {
    const row = srcRows[i];
    const dateIso = row.dateIso;
    if (!dateIso) continue;
    const agent = row.agent;
    if (!agent) continue;
    // Queue-sentinel rows (queue-only abandoned events) -- not real agents.
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;
    // R11-E (item 6): accumulate the dept-wide answered total BEFORE the
    // selection gate, so the donut's denominator is the whole department.
    if (rosterSet[agent] && dateIso >= from && dateIso <= to) {
      deptAnsweredCurr += (row.totalAnswered || 0);
    }
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
        if (rung || missed || answered) activeRosterCurr[agent] = true;
        var db = dailyTeam[dateIso] || (dailyTeam[dateIso] = blank());
        db.rung += rung; db.missed += missed; db.answered += answered;
        db.ttt += tttSec; db.att_sum += attTotal;
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
      const ym = dateIso.slice(0, 7);
      const mb = monthlyTeam[ym];
      if (mb) {
        mb.rung += rung; mb.missed += missed; mb.answered += answered;
        mb.ttt += tttSec; mb.att_sum += attTotal;
      }
      // R11-E (item 4): per-agent monthly buckets (rung/answered/missed) for
      // the per-agent trend line chart, aligned to the same month axis.
      const pam = perAgentMonthly[agent] || (perAgentMonthly[agent] = {});
      const pamb = pam[ym] || (pam[ym] = { rung: 0, answered: 0, missed: 0 });
      pamb.rung += rung; pamb.answered += answered; pamb.missed += missed;
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
  // ROSTER-ONLY report (matches the My Department table's Phase 14 flip,
  // commit 80e17da): queue-only floaters -- agents matched into the dept only
  // by a shared-queue extension overlap -- proved to be mostly false positives
  // in production (e.g. CSR agents who merely transfer INTO Service's queue),
  // so Insights drops them entirely; only the dept's own roster agents render.
  // The team rollup already gated on matchedViaRoster, so teamStats/trend are
  // unchanged -- this only removes floater cards (and off-dept crafted names,
  // which never matched roster anyway). queueOnlyAgentCount is therefore always
  // 0 here. Floaters remain available in IR/PR/CR (INV-53), same split as My
  // Department.
  const visibleAgents = selectedAgents.filter(function (a) {
    return agentMatchedViaRoster[a];
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
      // R11-E (item 4): per-agent monthly series aligned to trendLabels/monthKeys
      // (null on a gap month), for the per-agent trend line chart.
      trendMonthly: monthKeys.map(function (m) {
        const b = (perAgentMonthly[agent] || {})[m];
        if (!b) return null;
        const pct = b.rung > 0 ? (b.answered / b.rung) * 100 : 0;
        return { rung: b.rung, answered: b.answered, missed: b.missed, pct: round1_(pct) };
      }),
    };
  }).sort(function (a, b) { return b.rawAnswered - a.rawAnswered; });

  // --- Team insights vs prior (reuse buildTeamInsights_) -------------
  // On a length mismatch, drop the raw-volume insights (answered/missed
  // counts) -- they're not comparable across windows of different lengths.
  // Answer rate (%) and avg talk time (per-call average) stay.
  const teamInsights = buildTeamInsights_(
    { rung: teamCurr.rung, missed: teamCurr.missed, answered: teamCurr.answered, pct: currPct, att: currAtt },
    { rung: teamPrev.rung, missed: teamPrev.missed, answered: teamPrev.answered, pct: prevPct, att: prevAtt },
    { excludeVolume: lengthMismatch }
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

  // Daily team series for the selected window (Daily view of the trend
  // chart). Same per-bucket shape as trendSeries; sorted oldest-first.
  const dailyKeys = Object.keys(dailyTeam).sort();
  const trendDailyLabels = dailyKeys.map(function (iso) { return iso.slice(5); });
  const trendDailySeries = dailyKeys.map(function (iso) {
    const b = dailyTeam[iso];
    const pct = b.rung     > 0 ? (b.answered / b.rung)   * 100 : 0;
    const att = b.answered > 0 ? (b.att_sum  / b.answered)     : 0;
    return { rung: b.rung, missed: b.missed, answered: b.answered, pct: pct, ttt: b.ttt, att: att };
  });

  const fmt = function (d) { return Utilities.formatDate(d, TZ, 'MMM d, yyyy'); };
  // Selected roster survivors -- used ONLY to derive the floater count.
  const selectedRosterCount = visibleAgents.filter(function (a) { return agentMatchedViaRoster[a]; }).length;
  // Team-average divisor: roster members with activity in the current
  // window (INV-27 / F1), not all selected roster members.
  const activeRosterCount = Object.keys(activeRosterCurr).length;
  return {
    meta: {
      department: dept,
      from: from, to: to,
      priorFrom: priorFrom, priorTo: priorTo,
      comparisonMode: priorIsCustom ? 'custom' : 'prior',
      // F12: a custom prior window that OVERLAPS the current range silently
      // attributes the overlapping days to the current period only (the
      // inCurrent/else-if-inPrior branch). Flag it so the client can warn --
      // auto-adjacent priors are disjoint by construction, so this is custom-only.
      priorOverlap: priorIsCustom && (priorFrom <= to && from <= priorTo),
      currentDays: currentDays, priorDays: priorDays,
      // Working-day counts (Mon-Fri minus company holidays, INV-35's
      // countWorkingDays_). The client's trend-pill / triage / quiet
      // classification normalizes the VOLUME metrics per working day with
      // these (owner note: a raw answered-count drop caused purely by a
      // shorter/holiday-bearing window read as "Slipping" unfairly).
      currentWorkDays: currentWorkDays, priorWorkDays: priorWorkDays,
      lengthMismatch: lengthMismatch,
      trendStart: trendFrom, trendEnd: trendTo,
      agents: selectedAgents,
      rosterSize: roster.names.length,
      rosterAgentCount: activeRosterCount,
      queueOnlyAgentCount: visibleAgents.length - selectedRosterCount,
      // R11-E (item 6): whole-department answered total (current window, all
      // active roster agents) -- the true denominator for the share donut.
      answeredDeptTotal: deptAnsweredCurr,
      generatedAt: new Date().toISOString(),
    },
    dateLabel:      fmt(startDate)      + ' - ' + fmt(endDate),
    priorDateLabel: fmt(priorStartDate) + ' - ' + fmt(priorEndDate),
    teamStats:    teamStats,
    agentData:    agentData,
    teamInsights: teamInsights,
    trendData:    { labels: trendLabels, series: trendSeries },
    // Daily team series (selected window) for the consolidated trend
    // chart's Monthly/Daily toggle. trendData stays the 12-mo monthly
    // series (parity-pinned); this is additive.
    trendDaily:   { labels: trendDailyLabels, series: trendDailySeries },
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
    // F8: a MISSING `QCD Historical Data` sheet is a benign "this install has
    // no QCD data yet" state (fresh install / mid-setup), not a compute error
    // -- treat it like unmapped (null, hide). Only an UNEXPECTED throw with the
    // sheet present is surfaced as {error:true} below, so a real data problem
    // isn't masked as a normal empty.
    // R8-C3 (the F-35 treatment, applied to QCD): hard-require the sheet
    // only when it IS the read source. With QCD_READ_SOURCE=neon,
    // computeQcdReport_ reads qcd_history and the sheet may be trimmed --
    // the unconditional check silently hid Queue health for every dept
    // despite Neon being fully populated (and this is managers' ONLY queue
    // surface since the QCD retirement).
    const _qcdSrc = (typeof getQcdReadSource_ === 'function') ? getQcdReadSource_() : 'sheet';
    if (_qcdSrc !== 'neon') {
      const _ss = (typeof openSpreadsheet_ === 'function') ? openSpreadsheet_() : null;
      if (_ss && !_ss.getSheetByName('QCD Historical Data')) return null;
    }
    // Always separate sub-queues (seq #5 semantics): children are shown as
    // their own lines/rows + EXCLUDED from the dept total. The user-facing
    // "Include sub-queues" toggle was retired here too.
    const cur = computeQcdReport_(dept, from, to, /*includeSub=*/ true, /*separate=*/ true);
    if (!cur || !cur.meta) return null;
    // v18 (QCD retirement): an UNMAPPED dept is signaled explicitly so the
    // client can render the "no queues mapped" hint (+ admin Dept Config
    // CTA) the retired QCD modal used to show -- Insights Queue health is
    // now the only place a manager learns their dept needs mapping. A
    // missing QCD sheet (above) stays null = silently hidden.
    if (cur.meta.unmapped) return { unmapped: true };
    let prior = null;
    try { prior = computeQcdReport_(dept, priorFrom, priorTo, true, true); } catch (e) { prior = null; }
    const pick = function (t) {
      t = t || {};
      return {
        totalCalls:      Number(t.totalCalls) || 0,
        totalAnswered:   Number(t.totalAnswered) || 0,
        abandoned:       Number(t.abandoned) || 0,
        abandonedPct:    Number(t.abandonedPct) || 0,
        abandonedPctStr: t.abandonedPctStr || '0.00%',
        longestWait:     t.longestWait || '0:00:00',
        avgAnswer:       t.avgAnswer || '0:00:00',
      };
    };
    // Compact trend: the monthly abandoned-% series per queue + the
    // dept total, sliced out of the same trendData the QCD chart uses
    // (abandoned % is the queue metric with a company standard -- the
    // 5% line -- so it's the one the compact chart shows; the QCD
    // Report keeps the full metric tabs + daily view).
    let trend = null;
    const td = cur.trendData;
    if (td && Array.isArray(td.labels) && td.labels.length) {
      const qList = cur.meta.queues || [];
      // Generic per-field extractors so the queue-view metric sub-selector
      // (consolidation Phase 1, gap 1) can render Abandoned % / Total Calls /
      // Violations from the SAME monthly/daily buckets (each carries all three).
      const monthlyPerQueue = function (field) {
        const out = {};
        qList.forEach(function (q) {
          const m = td.perQueue && td.perQueue[q] && td.perQueue[q].monthly;
          if (m) out[q] = m.map(function (b) { return round1_(b[field]); });
        });
        return out;
      };
      const monthlyTotal = function (field) {
        return (td.series || []).map(function (b) { return round1_(b[field]); });
      };
      trend = {
        labels: td.labels,
        // Abandoned % is the DEFAULT/legacy series (drives the forecast +
        // back-compat with the existing "by queue" chart path).
        total: monthlyTotal('abandonedPct'),
        perQueue: monthlyPerQueue('abandonedPct'),
        // gap 1: the other two queue metrics, same monthly structure, read by
        // the client when the queue-view sub-selector picks them.
        metrics: {
          totalCalls: { total: monthlyTotal('totalCalls'), perQueue: monthlyPerQueue('totalCalls') },
          violations: { total: monthlyTotal('violations'), perQueue: monthlyPerQueue('violations') },
        },
      };
      // Daily view -- selected range scoped. dailyTotal (abandoned %) also
      // feeds the days-to-violation forecast, so it stays the default series.
      const daily = cur.dailySeries || [];
      if (daily.length) {
        const dailyPerQueueOf = function (field) {
          const out = {};
          qList.forEach(function (q) {
            const dq = cur.perQueue && cur.perQueue[q] && cur.perQueue[q].daily;
            if (dq) out[q] = dq.map(function (d) { return round1_(d[field]); });
          });
          return out;
        };
        const dailyTotalOf = function (field) {
          return daily.map(function (d) { return round1_(d[field]); });
        };
        trend.dailyLabels = daily.map(function (d) { return d.date; });
        trend.dailyTotal  = dailyTotalOf('abandonedPct');
        trend.dailyPerQueue = dailyPerQueueOf('abandonedPct');
        trend.metrics.totalCalls.dailyTotal    = dailyTotalOf('totalCalls');
        trend.metrics.totalCalls.dailyPerQueue = dailyPerQueueOf('totalCalls');
        trend.metrics.violations.dailyTotal    = dailyTotalOf('violations');
        trend.metrics.violations.dailyPerQueue = dailyPerQueueOf('violations');
      }
    }
    return {
      hasSubQueues:       !!cur.meta.hasSubQueues,
      subQueuesSeparated: true,
      queues:        cur.meta.queues || [],
      totals:        pick(cur.totals),
      priorTotals:   prior && prior.meta && !prior.meta.unmapped ? pick(prior.totals) : null,
      violationsMtd: Number(cur.totals && cur.totals.violations) || 0,
      trend:         trend,
      // Consolidation Phase 1 (gap 3): the per-day numeric series the QCD
      // Report renders as its daily table -- selected-range scoped, dept-OWN
      // queues (separateSubQueues). Lets Insights Queue health show the same
      // daily numbers the QCD modal does (not just the chart series).
      dailySeries:   cur.dailySeries || [],
      perQueue: (cur.queueBreakdown || []).map(function (q) {
        return {
          queue:            q.queue,
          subDept:          q.subDept || null,
          totalCalls:       q.totalCalls,
          // Secondary metrics (#1): surfaced only in the per-queue expand +
          // the dept-total secondary line, not the headline tiles/columns.
          totalAnswered:    q.totalAnswered,
          longestWait:      q.longestWait,
          avgAnswer:        q.avgAnswer,
          abandoned:        q.abandoned,
          abandonedPct:     q.abandonedPct,
          abandonedPctStr:  q.abandonedPctStr,
          violations:       q.violations,
          violationDates:   q.violationDates || [],
          // 4c: the call source driving the most abandons in this queue
          // (from the 4a bySource breakdown). Null when no sub-source has
          // any abandons -- the client renders nothing in that case.
          topAbandonSource: insTopAbandonSource_(q.bySource),
          // Consolidation Phase 1 (gap 2): the FULL per-call-source breakdown
          // (Overall + CSR / Ad-campaign / New Call Menu / Non-CSR ...) so the
          // Insights queue row can expand into the same subtable the QCD modal
          // shows -- not just the single topAbandonSource annotation.
          bySource:         q.bySource || [],
        };
      }),
    };
  } catch (e) {
    // F8: distinguish a genuine COMPUTE FAILURE from the legitimate "no mapped
    // queues" empty (which returns null above and hides the section). A real
    // QCD read/compute error returns a distinct {error:true} so the client can
    // render an "unavailable" note instead of silently hiding it as if the
    // dept simply had no queues -- which would mask a real data problem.
    Logger.log('insightsQueueHealth_ (best-effort): ' + (e && e.message ? e.message : e));
    return { error: true };
  }
}

/**
 * 4c: from a queue's per-call-source breakdown (bySource, added by 4a),
 * pick the source contributing the most ABANDONED calls -- excluding the
 * 'Overall' (Total Calls) roll-up row. Returns a compact descriptor for
 * the Queue health annotation, or null when no sub-source has any
 * abandons (so the client renders nothing). Directional, not a precise
 * decomposition: sub-source abandon counts needn't sum to Overall.
 */
function insTopAbandonSource_(bySource) {
  if (!Array.isArray(bySource)) return null;
  let best = null;
  bySource.forEach(function (s) {
    if (!s || s.isOverall) return;            // skip the Total-Calls roll-up
    const ab = Number(s.abandoned) || 0;
    if (ab <= 0) return;
    if (!best || ab > best.abandoned) {
      best = { source: s.source, abandoned: ab, totalCalls: Number(s.totalCalls) || 0,
               abandonedPctStr: s.abandonedPctStr || '0.00%' };
    }
  });
  return best;
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
      currentWorkDays: 0, priorWorkDays: 0,
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
    // F5: mirror the populated computeInsights_ shape so a no-data day returns
    // every top-level field. The client already guards both (insRenderQueueHealth_
    // early-returns on a null `queueHealth`; the trend view checks
    // `data.trendDaily && ...`), so this is shape-consistency, not a crash fix --
    // but other empty-shapes (emptyCompareRanges_) mirror their populated shape
    // and this one should too. trendDaily empty mirrors trendData's empty form;
    // queueHealth null is what insightsQueueHealth_ returns when unmapped.
    trendDaily: { labels: [], series: [] },
    queueHealth: null,
  };
}

/**
 * Emails the captured Insights Report PNG to the active user. Same
 * pattern as the Performance / Individual email-export paths.
 */
/**
 * Emails the Insights report to the requester as a SERVER-RENDERED HTML report
 * (department rollup KPI tiles + per-agent delta table), NOT an html2canvas
 * screenshot. The screenshot path mis-rendered the per-agent card bars in mail
 * clients; rendering the report HTML server-side (reusing the digest's
 * renderInsightsEmailBody_) is robust and email-native. Recomputes the report
 * from the same params the modal used (department / from / to / agents / prior
 * window), so it always matches what the user is looking at. Charts stay in the
 * web app (Copy image / Print). Mirrors getInsightsReport's request validation.
 */
function sendInsightsReportEmail(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  assertDeptAccess_(user, dept);

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');

  const customPriorFrom = String((req && req.priorFrom) || '').trim();
  const customPriorTo   = String((req && req.priorTo)   || '').trim();
  if (customPriorFrom || customPriorTo) {
    if (!isIsoDate_(customPriorFrom) || !isIsoDate_(customPriorTo)) {
      throw new Error('priorFrom/priorTo must be YYYY-MM-DD.');
    }
    // F-33: getInsightsReport enforces this order check; the email path
    // omitted it, so a reversed pair reached computeInsights_ where
    // `inPrior` was never true -- the emailed report silently rendered
    // prior = 0 everywhere (every volume delta +100%) instead of erroring
    // like the on-screen path.
    if (customPriorFrom > customPriorTo) {
      throw new Error('priorFrom must be on or before priorTo.');
    }
  }

  const roster = getRosterForDepartment_(dept);
  // Agent-free run defaults to the full roster (INV-45), mirroring
  // getInsightsReport so the emailed report matches the on-screen one.
  const selectedAgents = resolveInsightsAgents_(req && req.agents, roster);
  if (!selectedAgents.length) throw new Error('No agents on this department\'s roster.');

  // Density Phase 2 (#9): style='summary' sends the short form -- takeaway +
  // rollup tiles + only the behind-team-average agents -- instead of the full
  // per-agent table. Same auth, same compute, same recipient (the caller);
  // only the TEMPLATE differs, so the dept-permission story is unchanged.
  const style = String((req && req.style) || '').trim().toLowerCase();
  const summary = style === 'summary';

  const data = computeInsights_(dept, from, to, selectedAgents, roster,
                                customPriorFrom, customPriorTo);
  const dateLabel  = (data && data.dateLabel) || (from + ' - ' + to);
  const priorLabel = (data && data.priorDateLabel) || 'the prior period';

  const dashboardUrl = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL') || '';
  const htmlBody =
    '<div style="font-family: sans-serif; color: #1f2937; max-width: 760px;">'
    + '<div style="background:#EFF6FF;border-left:4px solid #1d4ed8;padding:16px 20px;border-radius:4px;">'
    +   '<h2 style="margin:0 0 4px;color:#1e3a8a;font-size:18px;">Insights &mdash; ' + escapeHtmlServer_(dept) + '</h2>'
    +   '<div style="color:#3730a3;font-size:13px;">' + escapeHtmlServer_(dateLabel)
    +     ' &middot; vs ' + escapeHtmlServer_(priorLabel) + '</div>'
    + '</div>'
    + (summary ? renderInsightsEmailSummary_(data) : renderInsightsEmailBody_(data))
    + (dashboardUrl
        ? '<div style="margin-top:20px;"><a href="' + escapeHtmlServer_(dashboardUrl)
          + '" style="display:inline-block;background:#1d4ed8;color:#fff;padding:8px 16px;border-radius:6px;'
          + 'text-decoration:none;font-size:13px;font-weight:600;">Open Department Dashboard</a></div>'
        : '')
    + '<div style="margin-top:24px;font-size:11px;color:#9ca3af;">'
    +   'Sent from the Department Dashboard Insights report. Charts (trend, share, per-agent) '
    +   'are available in the web app via Copy image / Print.'
    + '</div>'
    + '</div>';

  MailApp.sendEmail({ to: email,
    subject: (summary ? 'Insights Summary: ' : 'Insights Report: ') + dateLabel,
    htmlBody: htmlBody });
  return { to: email };
}
