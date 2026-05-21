/**
 * Performance Report - server-side data.
 *
 * Migration of SingleRangeReport.js (the legacy "Q Performance
 * Report") from the DQE Report Apps Script project. Distinct from
 * the Individual Report's per-agent monthly trends, this report
 * compares the SELECTED RANGE against an immediately-preceding
 * PRIOR PERIOD of the same length and surfaces dept-level deltas
 * plus per-agent breakdowns:
 *
 *   - Dept-level KPI tiles for Rung / Missed / Answered / %
 *     Answered / TTT / ATT with current value + delta vs prior.
 *   - Agent table with the same six metrics for each selected
 *     agent in the current period.
 *   - "Share of Answered Calls" pie data (per-agent slice + an
 *     "Other Agents" wedge when the selected set is a subset of
 *     the dept).
 *   - "Volume & Efficiency" bar data (per-agent Answered +
 *     Missed stacked).
 *   - Monthly trend (12-mo) for the selected-agent group rolled
 *     up to dept-level totals -- reuses the Individual Report's
 *     trend window logic.
 *
 * Public entries (callable via google.script.run):
 *   getPerformanceReportInit({ department, from?, to? })
 *     -> { department, agents, defaultStart, defaultEnd, activeAgents? }
 *   getPerformanceReport({ department, from, to, agents })
 *     -> { meta, dateLabel, priorDateLabel, teamStats, agentData,
 *          chartData, trendData }
 *   sendPerformanceReportEmail({ imageBase64, dateLabel })
 *     -> { to }
 *
 * Prior-period computation (matches legacy):
 *   durationMs = end - start
 *   prevEnd    = start - 1ms
 *   prevStart  = prevEnd - durationMs
 * Means a 30-day current window compares against the immediately-
 * preceding 30 days, NOT against the previous calendar month.
 * Documented in the UI's date-label tooltip so the comparison
 * basis is visible to managers.
 *
 * Calculation notes:
 *   - ATT is weighted by Answered (same as Individual Report); see
 *     INV-05 for the per-row stored-ATT vs. weighted tradeoff.
 *   - Deltas:
 *       * Volume metrics (Rung, Missed, Answered, TTT): relative %
 *         change ((curr - prev) / prev * 100). 0 -> 0 returns 0,
 *         0 -> nonzero returns +100 (matches legacy semantics).
 *       * % Answered: ABSOLUTE point difference (curr_pct -
 *         prev_pct) since multiplicative change on a percentage is
 *         confusing.
 *       * ATT: relative % change of weighted-avg ATT.
 *
 * Caching: 5 min per (dept, from, to, sortedAgents, priorKey) tuple
 * under the PERFORMANCE_CACHE_KEY_PREFIX below.
 */

// Bump when aggregation rules or response shape change so stale
// entries don't bleed in. CLAUDE.md INV-30 is the canonical
// current-version list -- keep this constant aligned with that.
const PERFORMANCE_CACHE_KEY_PREFIX = 'performance:v3';

function getPerformanceReportInit(req) {
  // Same init shape as Individual Report -- roster + default
  // dates + optional activeAgents subset. The picker UX is the
  // same and reuses the same active-in-range cache, so we just
  // delegate.
  return getIndividualReportInit(req);
}

function getPerformanceReport(req) {
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

  // Optional custom prior range. When both provided, overrides the
  // auto-computed immediately-preceding window. Used by the
  // "Compare with..." picker so managers can hand-pick a baseline
  // (e.g., same month last year for seasonality checks).
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
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;
  const seen = {};
  const selectedAgents = [];
  for (let i = 0; i < rawAgents.length; i++) {
    const n = String(rawAgents[i] || '').trim();
    if (!n || seen[n] || !rosterSet[n]) continue;
    seen[n] = true;
    selectedAgents.push(n);
  }
  if (selectedAgents.length === 0) {
    throw new Error('No selected agent is on this department\'s roster.');
  }
  // MD5 hash keeps the cache key length-bounded (CacheService rejects
  // keys > 250 chars; raw join blows past that on big rosters like
  // Sales). Order-insensitive by design.
  const agentsKey = hashAgents_(selectedAgents);
  const priorKey = (customPriorFrom && customPriorTo)
    ? customPriorFrom + '..' + customPriorTo
    : 'auto';

  const cache = CacheService.getScriptCache();
  const cacheKey = PERFORMANCE_CACHE_KEY_PREFIX + ':'
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
  const data = computePerformanceReport_(dept, from, to, selectedAgents, roster,
                                         customPriorFrom, customPriorTo);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  try { cache.put(cacheKey, JSON.stringify(data), CACHE_TTL_SECONDS); }
  catch (e) { Logger.log('PerformanceReport cache put failed: %s', e); }

  return data;
}

function computePerformanceReport_(dept, from, to, selectedAgents, roster,
                                   customPriorFrom, customPriorTo) {
  const selectedSet = {};
  for (let i = 0; i < selectedAgents.length; i++) selectedSet[selectedAgents[i]] = true;
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  // ISO -> Date helpers. Use noon so DST boundary days don't shift.
  const parseIso_ = function (iso) {
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
  };
  const startDate = parseIso_(from);
  const endDate   = parseIso_(to);

  // Prior period. Default = same duration ending one day before
  // the current start (legacy semantics). When the request supplies
  // a custom prior range, use it instead -- lets managers compare
  // against same-month-last-year or any other arbitrary baseline.
  const msPerDay = 86400000;
  const isoOf = function (d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); };
  let priorStartDate, priorEndDate, priorFrom, priorTo, priorIsCustom;
  if (customPriorFrom && customPriorTo) {
    priorStartDate = parseIso_(customPriorFrom);
    priorEndDate   = parseIso_(customPriorTo);
    priorFrom      = customPriorFrom;
    priorTo        = customPriorTo;
    priorIsCustom  = true;
  } else {
    const durationDays = Math.floor((endDate - startDate) / msPerDay);
    priorEndDate   = new Date(startDate.getTime() - msPerDay);
    priorStartDate = new Date(priorEndDate.getTime() - durationDays * msPerDay);
    priorFrom      = isoOf(priorStartDate);
    priorTo        = isoOf(priorEndDate);
    priorIsCustom  = false;
  }

  // Trend window resolution -- mirror Individual Report's logic.
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
  const trendFrom = isoOf(trendStartDate);
  const trendTo   = to;
  const monthKeys = generateMonthList_(trendStartDate, endDate);

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) {
    throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptyPerformanceReport_(dept, from, to, priorFrom, priorTo,
                                   selectedAgents, monthKeys);
  }
  const ssTZ = ss.getSpreadsheetTimeZone();

  const range = sheet.getRange(2, 1, lastRow - 1, HISTORICAL_COLS.CSR_AVG_ABD_WAIT);
  const values   = range.getValues();
  const displays = range.getDisplayValues();

  // Accumulators.
  //   teamCurr/teamPrev: dept totals for the selected agents across
  //     current and prior periods. att_sum = sum(per-day ATT *
  //     per-day Answered) so weighted ATT = att_sum / answered.
  //   perAgent: stats for the selected agents in current period.
  //   monthlyTeam: month-keyed totals across selected agents for the
  //     trend chart's 12-month window.
  const teamCurr = { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
  const teamPrev = { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
  const perAgent = {};
  selectedAgents.forEach(function (a) {
    perAgent[a] = { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
  });
  const monthlyTeam = {};
  monthKeys.forEach(function (k) {
    monthlyTeam[k] = { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
  });

  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];

    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso) continue;
    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;
    // Queue-sentinel rows (queue-only abandoned events).
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;

    const inCurrent = (dateIso >= from && dateIso <= to);
    const inPrior   = (dateIso >= priorFrom && dateIso <= priorTo);
    const inTrend   = (dateIso >= trendFrom && dateIso <= trendTo);

    // Selected-agent restriction: dept totals + trend roll-up are
    // computed across selected agents only, matching legacy. The
    // user's selection IS the team for this report.
    const isSelected = !!selectedSet[agent];
    if (!isSelected) continue;
    if (!inCurrent && !inPrior && !inTrend) continue;

    const rung     = Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
    const missed   = Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
    const answered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    const tttSec   = parseHmsDisplay_(rd[HISTORICAL_COLS.TTT - 1]);
    const attAvg   = parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]);
    const attTotal = answered > 0 ? attAvg * answered : 0;

    if (inCurrent) {
      teamCurr.rung     += rung;
      teamCurr.missed   += missed;
      teamCurr.answered += answered;
      teamCurr.ttt      += tttSec;
      teamCurr.att_sum  += attTotal;

      const ag = perAgent[agent];
      ag.rung     += rung;
      ag.missed   += missed;
      ag.answered += answered;
      ag.ttt      += tttSec;
      ag.att_sum  += attTotal;
    } else if (inPrior) {
      teamPrev.rung     += rung;
      teamPrev.missed   += missed;
      teamPrev.answered += answered;
      teamPrev.ttt      += tttSec;
      teamPrev.att_sum  += attTotal;
    }
    if (inTrend) {
      const monthKey = dateIso.slice(0, 7);
      const bucket = monthlyTeam[monthKey];
      if (bucket) {
        bucket.rung     += rung;
        bucket.missed   += missed;
        bucket.answered += answered;
        bucket.ttt      += tttSec;
        bucket.att_sum  += attTotal;
      }
    }
  }

  // ── Team stats with deltas ────────────────────────────────────
  const currPct = teamCurr.rung     > 0 ? (teamCurr.answered / teamCurr.rung)   * 100 : 0;
  const prevPct = teamPrev.rung     > 0 ? (teamPrev.answered / teamPrev.rung)   * 100 : 0;
  const currAtt = teamCurr.answered > 0 ? (teamCurr.att_sum  / teamCurr.answered)     : 0;
  const prevAtt = teamPrev.answered > 0 ? (teamPrev.att_sum  / teamPrev.answered)     : 0;

  const teamStats = {
    rung:     deltaBlock_(teamCurr.rung,     teamPrev.rung,     'volume', String(teamCurr.rung)),
    missed:   deltaBlock_(teamCurr.missed,   teamPrev.missed,   'volume', String(teamCurr.missed)),
    answered: deltaBlock_(teamCurr.answered, teamPrev.answered, 'volume', String(teamCurr.answered)),
    pct:      deltaBlock_(currPct,           prevPct,           'pctPoints', currPct.toFixed(1) + '%'),
    ttt:      deltaBlock_(teamCurr.ttt,      teamPrev.ttt,      'volume', formatSecondsHms_(teamCurr.ttt)),
    att:      deltaBlock_(currAtt,           prevAtt,           'volume', formatSecondsHms_(currAtt)),
  };

  // ── Per-agent data array (sorted by Answered desc) ────────────
  const agentData = selectedAgents.map(function (agent) {
    const a = perAgent[agent];
    const agPct = a.rung     > 0 ? (a.answered / a.rung)   * 100 : 0;
    const agAtt = a.answered > 0 ? (a.att_sum  / a.answered)     : 0;
    return {
      name: agent,
      stats: {
        rung:     a.rung,
        missed:   a.missed,
        answered: a.answered,
        pct:      agPct.toFixed(1) + '%',
        ttt:      formatSecondsHms_(a.ttt),
        att:      formatSecondsHms_(agAtt),
      },
      raw: { rung: a.rung, missed: a.missed, answered: a.answered,
             pct: agPct, ttt: a.ttt, att: agAtt },
    };
  }).sort(function (a, b) { return b.raw.answered - a.raw.answered; });

  // ── Chart-data helpers (just the pre-shaped series the client
  //    needs; the client renders Chart.js bar + pie). volumeBar
  //    carries per-agent pct so the bar chart can overlay a
  //    % Answered line on its second y-axis. ──────────────────────
  const chartData = {
    sharePie: agentData.map(function (a) {
      return { label: a.name, value: a.raw.answered };
    }),
    volumeBar: agentData.map(function (a) {
      return {
        label: a.name,
        answered: a.raw.answered,
        missed:   a.raw.missed,
        pct:      a.raw.pct,
      };
    }),
  };

  // ── Monthly trend rolled up to selected-agent dept totals.
  //    Includes ttt + att so the client can render multi-metric
  //    trend sub-tabs (Answered / % Answered / ATT) and sparklines
  //    on every KPI tile. ──────────────────────────────────────────
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

  // ── Team-level insights vs prior period ──────────────────────────
  const currForInsights = {
    rung:     teamCurr.rung,
    missed:   teamCurr.missed,
    answered: teamCurr.answered,
    pct:      currPct,
    att:      currAtt,
  };
  const prevForInsights = {
    rung:     teamPrev.rung,
    missed:   teamPrev.missed,
    answered: teamPrev.answered,
    pct:      prevPct,
    att:      prevAtt,
  };
  const teamInsights = buildTeamInsights_(currForInsights, prevForInsights);

  // Human-readable labels.
  const fmt = function (d) { return Utilities.formatDate(d, TZ, 'MMM d, yyyy'); };
  const dateLabel       = fmt(startDate)      + ' - ' + fmt(endDate);
  const priorDateLabel  = fmt(priorStartDate) + ' - ' + fmt(priorEndDate);

  return {
    meta: {
      department: dept,
      from: from, to: to,
      priorFrom: priorFrom, priorTo: priorTo,
      priorIsCustom: priorIsCustom,
      trendStart: trendFrom, trendEnd: trendTo,
      agents: selectedAgents,
      rosterSize: roster.names.length,
      generatedAt: new Date().toISOString(),
    },
    dateLabel: dateLabel,
    priorDateLabel: priorDateLabel,
    teamStats: teamStats,
    agentData: agentData,
    chartData: chartData,
    trendData: { labels: trendLabels, series: trendSeries },
    teamInsights: teamInsights,
  };
}

/**
 * Builds the standard delta block shared across every team-stat
 * tile: { val, formatted, delta, deltaPct, type }.
 *
 *   type='volume'    -> deltaPct is relative percent change of the
 *                        underlying value (0 -> nonzero = +100).
 *   type='pctPoints' -> deltaPct is the ABSOLUTE point difference
 *                        of two already-percent values; semantically
 *                        "deltaPct" is overloaded here, but the UI
 *                        renders the same +X.X label form.
 */
function deltaBlock_(curr, prev, type, formatted) {
  let delta, deltaPct;
  if (type === 'pctPoints') {
    delta = curr - prev;
    deltaPct = delta; // already in pp
  } else {
    delta = curr - prev;
    if (prev === 0 && curr === 0) deltaPct = 0;
    else if (prev === 0) deltaPct = 100;
    else deltaPct = (delta / prev) * 100;
  }
  return {
    val: curr,
    prev: prev,
    formatted: formatted,
    delta: delta,
    deltaPct: deltaPct,
    type: type,
  };
}

function emptyPerformanceReport_(dept, from, to, priorFrom, priorTo,
                                 selectedAgents, monthKeys) {
  const labels = (monthKeys || []).map(function (m) {
    const p = m.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, 1);
    return Utilities.formatDate(d, TZ, 'MMM, yy');
  });
  const series = labels.map(function () {
    return { rung: 0, missed: 0, answered: 0, pct: 0, ttt: 0, att: 0 };
  });
  return {
    meta: {
      department: dept, from: from, to: to,
      priorFrom: priorFrom, priorTo: priorTo,
      priorIsCustom: false,
      trendStart: from, trendEnd: to,
      agents: selectedAgents,
      rosterSize: 0,
      generatedAt: new Date().toISOString(),
    },
    dateLabel: from + ' - ' + to,
    priorDateLabel: priorFrom + ' - ' + priorTo,
    teamStats: {
      rung:     { val: 0, formatted: '0',       delta: 0, deltaPct: 0, type: 'volume' },
      missed:   { val: 0, formatted: '0',       delta: 0, deltaPct: 0, type: 'volume' },
      answered: { val: 0, formatted: '0',       delta: 0, deltaPct: 0, type: 'volume' },
      pct:      { val: 0, formatted: '0.0%',    delta: 0, deltaPct: 0, type: 'pctPoints' },
      ttt:      { val: 0, formatted: '0:00:00', delta: 0, deltaPct: 0, type: 'volume' },
      att:      { val: 0, formatted: '0:00:00', delta: 0, deltaPct: 0, type: 'volume' },
    },
    agentData: selectedAgents.map(function (a) {
      return {
        name: a,
        stats: { rung: 0, missed: 0, answered: 0, pct: '0.0%', ttt: '0:00:00', att: '0:00:00' },
        raw:   { rung: 0, missed: 0, answered: 0, pct: 0, ttt: 0, att: 0 },
      };
    }),
    chartData: {
      sharePie:  selectedAgents.map(function (a) { return { label: a, value: 0 }; }),
      volumeBar: selectedAgents.map(function (a) { return { label: a, answered: 0, missed: 0, pct: 0 }; }),
    },
    trendData: { labels: labels, series: series },
    teamInsights: [],
  };
}

/**
 * Team-level rules-based observations comparing current to prior
 * period. Returns up to 3 objects { type, text } where type is
 * 'positive' | 'negative' | 'neutral'. Same shape as the per-agent
 * insights in IndividualReport.gs so the client's renderer can
 * be reused.
 *
 * Rules:
 *   1. % Answered     -- absolute pt change >= 5 pts
 *   2. Answered count -- relative change >= 15%
 *   3. Missed count   -- relative change >= 20%
 *   4. Avg talk time  -- relative change >= 20% (neutral; direction
 *                        is ambiguous: longer can be thorough or
 *                        slow)
 *
 * Activity gates (curr or prev rung >= 10, answered >= 10 for ATT
 * rule, missed >= 5 for missed rule) suppress noise on tiny teams.
 */
function buildTeamInsights_(curr, prev) {
  const out = [];
  const nonTrivial = (curr.rung || 0) >= 10 || (prev.rung || 0) >= 10;
  if (!nonTrivial) return out;

  const pctDelta = (curr.pct || 0) - (prev.pct || 0);
  if (Math.abs(pctDelta) >= 5) {
    const up = pctDelta > 0;
    out.push({
      type: up ? 'positive' : 'negative',
      text: 'Answer rate ' + (up ? 'rose' : 'fell') + ' '
          + Math.abs(pctDelta).toFixed(1) + ' pts vs prior period ('
          + (curr.pct || 0).toFixed(1) + '% vs '
          + (prev.pct || 0).toFixed(1) + '%).',
    });
  }

  if ((prev.answered || 0) > 0) {
    const change = ((curr.answered - prev.answered) / prev.answered) * 100;
    if (Math.abs(change) >= 15) {
      const up = change > 0;
      out.push({
        type: up ? 'positive' : 'negative',
        text: 'Answered call volume ' + (up ? 'rose' : 'fell') + ' '
            + Math.abs(change).toFixed(0) + '% vs prior ('
            + curr.answered + ' vs ' + prev.answered + ').',
      });
    }
  } else if (curr.answered >= 10) {
    out.push({
      type: 'positive',
      text: 'Team answered ' + curr.answered + ' calls this period (no comparable prior data).',
    });
  }

  if ((prev.missed || 0) >= 5 || (curr.missed || 0) >= 5) {
    if ((prev.missed || 0) > 0) {
      const change = ((curr.missed - prev.missed) / prev.missed) * 100;
      if (Math.abs(change) >= 20) {
        const up = change > 0;
        out.push({
          type: up ? 'negative' : 'positive',
          text: 'Missed-call count ' + (up ? 'rose' : 'fell') + ' '
              + Math.abs(change).toFixed(0) + '% vs prior ('
              + curr.missed + ' vs ' + prev.missed + ' missed).',
        });
      }
    }
  }

  if ((prev.att || 0) > 0 && (curr.answered || 0) >= 10) {
    const change = ((curr.att - prev.att) / prev.att) * 100;
    if (Math.abs(change) >= 20) {
      out.push({
        type: 'neutral',
        text: 'Avg talk time ' + (change > 0 ? 'lengthened' : 'shortened') + ' '
            + Math.abs(change).toFixed(0) + '% vs prior ('
            + formatSecondsHms_(curr.att) + ' vs '
            + formatSecondsHms_(prev.att) + ').',
      });
    }
  }

  return out.slice(0, 3);
}

/**
 * Emails the captured Performance Report PNG to the active user.
 * Same pattern as the Individual Report's email path.
 */
function sendPerformanceReportEmail(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dataUrl = String((req && req.imageBase64) || '');
  const dateLabel = String((req && req.dateLabel) || 'Performance Report');
  if (!dataUrl) throw new Error('No image payload.');
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('Malformed image payload.');
  const decoded = Utilities.base64Decode(dataUrl.slice(commaIdx + 1));
  const blob = Utilities.newBlob(decoded, 'image/png', 'Performance_Report.png');

  MailApp.sendEmail({
    to: email,
    subject: 'Performance Report: ' + dateLabel,
    htmlBody:
      '<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">'
      + 'Here is the visual snapshot of the department performance report, '
      + 'comparing the selected range against the immediately-preceding period.'
      + '</div>'
      + '<div style="text-align: center; border: 1px solid #eee; padding: 10px;">'
      + '<img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;">'
      + '</div>',
    inlineImages: { reportImg: blob },
  });
  return { to: email };
}
