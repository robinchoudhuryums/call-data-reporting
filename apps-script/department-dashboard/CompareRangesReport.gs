/**
 * Compare Ranges Report - server-side data.
 *
 * Per-dept-gated side-by-side comparison of two arbitrary date ranges
 * for the same set of agents. Migration of MultiComparisonTool.js
 * from the legacy DQE Report Apps Script project.
 *
 * Public entries (callable via google.script.run):
 *   getCompareRangesInit({ department, p1From?, p1To?, p2From?, p2To? })
 *     -> { department, agents, defaults, activeAgents? }
 *   getCompareRanges({ department, agents, p1From, p1To, p2From, p2To })
 *     -> { meta, p1Label, p2Label, teamStats, agentData,
 *          chartData, teamInsights }
 *   sendCompareRangesEmail({ imageBase64, p1Label, p2Label })
 *     -> { to }
 *
 * Period semantics:
 *   - Period 1 is the BASELINE; Period 2 is the COMPARISON.
 *   - Deltas are computed as P2 vs P1: positive delta = P2 is
 *     higher than P1. The UI labels are explicit so the user
 *     always knows which is which.
 *   - The two ranges can overlap; they can be of any length; they
 *     do not have to be adjacent.
 *
 * Authorization:
 *   Same model as Individual / Performance Reports -- managers
 *   are pinned to their own dept; admins can pick any dept that
 *   exists in the dept list. Previously this report was admin-
 *   only at the server boundary; opened to managers so they can
 *   run year-over-year and month-over-month comparisons within
 *   their own dept without admin help.
 *
 * ATT semantics: weighted by Answered (matches Individual /
 * Performance Reports -- see INV-25). Days with answered=0
 * contribute 0 to both numerator and denominator.
 *
 * Caching: 5 min per (dept, p1, p2, sortedAgents) tuple.
 */

// Bump on response-shape or aggregation-rule changes so stale
// entries don't bleed in. CLAUDE.md INV-30 is the canonical
// current-version list -- keep this constant aligned with that.
// v4: INV-53 expansion -- input gate relaxed to accept floaters;
// per-agent matchedViaRoster / matchedViaQueue / sourceHomes added;
// team accumulators (teamP1 / teamP2) gated on matchedViaRoster so
// floaters appear in agentData but don't dilute dept totals.
// agentData filtered to drop crafted off-dept names.
const COMPARE_RANGES_CACHE_KEY_PREFIX = 'compareRanges:v4';

function getCompareRangesInit(req) {
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
  const fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };

  // Sensible defaults: P1 = last calendar month, P2 = this
  // month-to-date. Mirrors the "Last month vs This month" preset.
  const firstOfMonth      = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstOfLastMonth  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth    = new Date(now.getFullYear(), now.getMonth(), 0);

  // Optional active-agent subset: when all four range dates are
  // supplied AND each is a valid ISO date in order, return the
  // roster names with activity in EITHER range (union). Lets the
  // picker show an Active / Inactive grouping that reflects both
  // periods together.
  //
  // Validation policy: silently skip the activeAgents fetch if any
  // date is missing or invalid -- the client legitimately calls
  // this with partial state while a user is typing in the date
  // inputs, so throwing would surface noisy errors mid-edit.
  // Malformed dates that pass `isIsoDate_` (e.g. 2026-13-99) are
  // tolerated too: `computeActiveAgentsInRange_` will simply find
  // no matching rows and return [].
  let activeAgents = null;
  let activeFloaters = null;
  const p1From = String((req && req.p1From) || '').trim();
  const p1To   = String((req && req.p1To)   || '').trim();
  const p2From = String((req && req.p2From) || '').trim();
  const p2To   = String((req && req.p2To)   || '').trim();
  if (isIsoDate_(p1From) && isIsoDate_(p1To)
      && isIsoDate_(p2From) && isIsoDate_(p2To)
      && p1From <= p1To && p2From <= p2To) {
    const unionFrom = (p1From < p2From) ? p1From : p2From;
    const unionTo   = (p1To   > p2To)   ? p1To   : p2To;
    const active = computeActiveAgentsInRange_(dept, unionFrom, unionTo, roster);
    activeAgents   = active.agents;
    activeFloaters = active.floaters;
  }

  return {
    department: dept,
    agents: roster.names.slice().sort(),
    defaults: {
      p1From: fmt(firstOfLastMonth),
      p1To:   fmt(endOfLastMonth),
      p2From: fmt(firstOfMonth),
      p2To:   fmt(now),
    },
    activeAgents:   activeAgents,
    activeFloaters: activeFloaters,
  };
}

function getCompareRanges(req) {
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

  const p1From = String((req && req.p1From) || '').trim();
  const p1To   = String((req && req.p1To)   || '').trim();
  const p2From = String((req && req.p2From) || '').trim();
  const p2To   = String((req && req.p2To)   || '').trim();
  if (!isIsoDate_(p1From) || !isIsoDate_(p1To)) {
    throw new Error('Period 1 dates must be YYYY-MM-DD.');
  }
  if (!isIsoDate_(p2From) || !isIsoDate_(p2To)) {
    throw new Error('Period 2 dates must be YYYY-MM-DD.');
  }
  if (p1From > p1To) throw new Error('Period 1 start must be on or before end.');
  if (p2From > p2To) throw new Error('Period 2 start must be on or before end.');

  const rawAgents = (req && req.agents) || [];
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    throw new Error('Select at least one agent.');
  }
  const roster = getRosterForDepartment_(dept);
  // Phase D+1 (INV-53 expansion): drop the roster-only input gate so
  // floaters can be included in the comparison. Off-dept crafted
  // names with no queue overlap fall out in computeCompareRanges_
  // (zero rows, dropped from agentData). Team accumulators below
  // gate on matchedViaRoster so floaters never dilute dept totals.
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
  // MD5 hash keeps the cache key length-bounded (CacheService rejects
  // keys > 250 chars; raw join blows past that on big rosters like
  // Sales). Order-insensitive by design.
  const agentsKey = hashAgents_(selectedAgents);

  const cache = CacheService.getScriptCache();
  const cacheKey = COMPARE_RANGES_CACHE_KEY_PREFIX + ':' + dept
                 + ':' + p1From + '..' + p1To
                 + ':' + p2From + '..' + p2To
                 + ':' + agentsKey;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeCompareRanges_(dept, selectedAgents,
                                     p1From, p1To, p2From, p2To, roster);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  try { cache.put(cacheKey, JSON.stringify(data), REPORT_CACHE_TTL_SECONDS); }
  catch (e) { Logger.log('CompareRanges cache put failed: %s', e); }

  return data;
}

function computeCompareRanges_(dept, selectedAgents,
                               p1From, p1To, p2From, p2To, roster) {
  const selectedSet = {};
  for (let i = 0; i < selectedAgents.length; i++) selectedSet[selectedAgents[i]] = true;
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  // Floater tracking (Phase D+1 / INV-53 expansion). matchedViaRoster
  // is pre-populated for selected roster members so zero-call picks
  // still render. matchedViaQueue is set lazily when we observe a
  // queue-overlap row. Team accumulators below gate on matchedViaRoster
  // so floaters appear in agentData but don't dilute dept totals.
  const agentMatchedViaRoster = {};
  const agentMatchedViaQueue  = {};
  for (let i = 0; i < selectedAgents.length; i++) {
    if (rosterSet[selectedAgents[i]]) agentMatchedViaRoster[selectedAgents[i]] = true;
  }

  // Per-agent buckets, separated by period. att_sum = sum(att *
  // answered) so weighted ATT = att_sum / answered.
  const perAgent = {};
  selectedAgents.forEach(function (a) {
    perAgent[a] = {
      p1: { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 },
      p2: { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 },
    };
  });

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) {
    throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptyCompareRanges_(dept, selectedAgents, roster,
                               p1From, p1To, p2From, p2To);
  }
  const ssTZ = ss.getSpreadsheetTimeZone();
  // F1 cutover #4c (Compare Ranges): source rows for the UNION of the two
  // periods -- [min(p1From,p2From), max(p1To,p2To)] -- from Neon when
  // DQE_READ_SOURCE=neon, else the sheet. Both produce the same normalized
  // `srcRows`, so the loop is source-agnostic. Default 'sheet' is
  // byte-identical (compare-ranges.test.js guards it). deptQueueExts derived
  // path needs ALL history, so the Neon path reads a cheap cols-A..D slice
  // for getDeptQueueExts_.
  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  const fetchFrom = p1From < p2From ? p1From : p2From;
  const fetchTo   = p1To   > p2To   ? p1To   : p2To;
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
      Logger.log('computeCompareRanges_: neon returned no rows; falling back to sheet.');
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
  if (typeof logDqeReadTiming_ === 'function') logDqeReadTiming_('computeCompareRanges_:' + dept, effectiveSource, _tRead, srcRows.length);

  for (let i = 0; i < srcRows.length; i++) {
    const row = srcRows[i];
    const dateIso = row.dateIso;
    if (!dateIso) continue;
    const agent = row.agent;
    if (!agent || !selectedSet[agent]) continue;
    // Skip queue-sentinel rows.
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;

    // Floater detection: confirm queue-overlap for non-roster selections.
    if (!rosterSet[agent] && !agentMatchedViaQueue[agent]) {
      const rowExts = parseExtensions_(row.queueExt);
      for (let j = 0; j < rowExts.length; j++) {
        if (deptQueueExts[rowExts[j]]) { agentMatchedViaQueue[agent] = true; break; }
      }
    }

    const inP1 = (dateIso >= p1From && dateIso <= p1To);
    const inP2 = (dateIso >= p2From && dateIso <= p2To);
    if (!inP1 && !inP2) continue;

    const rung     = row.totalRung;
    const missed   = row.totalMissed;
    const answered = row.totalAnswered;
    const tttSec   = row.tttSec;
    const attAvg   = row.attSec;
    const attTotal = answered > 0 ? attAvg * answered : 0;

    if (inP1) {
      const b = perAgent[agent].p1;
      b.rung += rung; b.missed += missed; b.answered += answered;
      b.ttt += tttSec; b.att_sum += attTotal;
    }
    if (inP2) {
      const b = perAgent[agent].p2;
      b.rung += rung; b.missed += missed; b.answered += answered;
      b.ttt += tttSec; b.att_sum += attTotal;
    }
  }

  // ── Per-agent display + deltas ─────────────────────────────────
  // INV-53: drop crafted off-dept names (no roster, no queue overlap).
  const visibleAgents = selectedAgents.filter(function (a) {
    return agentMatchedViaRoster[a] || agentMatchedViaQueue[a];
  });
  // Lazy sourceHomes lookup for floaters.
  let crDeptsByAgent = null;
  for (let i = 0; i < visibleAgents.length; i++) {
    if (agentMatchedViaQueue[visibleAgents[i]] && !agentMatchedViaRoster[visibleAgents[i]]) {
      crDeptsByAgent = buildDeptsByAgent_();
      break;
    }
  }
  const agentData = visibleAgents.map(function (agent) {
    const p1 = perAgent[agent].p1;
    const p2 = perAgent[agent].p2;
    const p1Pct = p1.rung > 0 ? (p1.answered / p1.rung) * 100 : 0;
    const p2Pct = p2.rung > 0 ? (p2.answered / p2.rung) * 100 : 0;
    const p1Att = p1.answered > 0 ? p1.att_sum / p1.answered : 0;
    const p2Att = p2.answered > 0 ? p2.att_sum / p2.answered : 0;
    const matchedViaRoster = !!agentMatchedViaRoster[agent];
    const matchedViaQueue  = !!agentMatchedViaQueue[agent];
    const sourceHomes = (matchedViaQueue && !matchedViaRoster && crDeptsByAgent)
      ? (crDeptsByAgent[agent] || [])
      : [];
    return {
      name: agent,
      matchedViaRoster: matchedViaRoster,
      matchedViaQueue:  matchedViaQueue,
      sourceHomes:      sourceHomes,
      p1: agentPeriodBlock_(p1, p1Pct, p1Att),
      p2: agentPeriodBlock_(p2, p2Pct, p2Att),
      deltas: {
        rung:     crDelta_(p2.rung,     p1.rung,     false),
        missed:   crDelta_(p2.missed,   p1.missed,   false),
        answered: crDelta_(p2.answered, p1.answered, false),
        pct:      crDelta_(p2Pct,       p1Pct,       true),
        ttt:      crDelta_(p2.ttt,      p1.ttt,      false),
        att:      crDelta_(p2Att,       p1Att,       false),
      },
    };
  });

  // ── Team aggregate across selected ROSTER agents, per period ──
  // INV-53: floaters (queue-only) are excluded from team totals so
  // they don't dilute the dept averages. They still appear in
  // agentData with the QUEUE chip.
  const teamP1 = { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
  const teamP2 = { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
  selectedAgents.forEach(function (agent) {
    if (!agentMatchedViaRoster[agent]) return;
    const p1 = perAgent[agent].p1; const p2 = perAgent[agent].p2;
    teamP1.rung += p1.rung; teamP1.missed += p1.missed; teamP1.answered += p1.answered;
    teamP1.ttt += p1.ttt; teamP1.att_sum += p1.att_sum;
    teamP2.rung += p2.rung; teamP2.missed += p2.missed; teamP2.answered += p2.answered;
    teamP2.ttt += p2.ttt; teamP2.att_sum += p2.att_sum;
  });
  const teamP1Pct = teamP1.rung > 0 ? (teamP1.answered / teamP1.rung) * 100 : 0;
  const teamP2Pct = teamP2.rung > 0 ? (teamP2.answered / teamP2.rung) * 100 : 0;
  const teamP1Att = teamP1.answered > 0 ? teamP1.att_sum / teamP1.answered : 0;
  const teamP2Att = teamP2.answered > 0 ? teamP2.att_sum / teamP2.answered : 0;

  const teamStats = {
    rung:     crTeamPair_(teamP2.rung,     teamP1.rung,     'volume',
                          String(teamP2.rung),     String(teamP1.rung)),
    missed:   crTeamPair_(teamP2.missed,   teamP1.missed,   'volume',
                          String(teamP2.missed),   String(teamP1.missed)),
    answered: crTeamPair_(teamP2.answered, teamP1.answered, 'volume',
                          String(teamP2.answered), String(teamP1.answered)),
    pct:      crTeamPair_(teamP2Pct,       teamP1Pct,       'pctPoints',
                          teamP2Pct.toFixed(1) + '%',
                          teamP1Pct.toFixed(1) + '%'),
    ttt:      crTeamPair_(teamP2.ttt,      teamP1.ttt,      'volume',
                          formatSecondsHms_(teamP2.ttt),
                          formatSecondsHms_(teamP1.ttt)),
    att:      crTeamPair_(teamP2Att,       teamP1Att,       'volume',
                          formatSecondsHms_(teamP2Att),
                          formatSecondsHms_(teamP1Att)),
  };

  // ── Chart data: P1 vs P2 grouped bars per agent ───────────────
  const chartLabels = agentData.map(function (a) { return a.name; });
  const chartData = {
    answered: {
      labels: chartLabels,
      p1: agentData.map(function (a) { return a.p1.raw.answered; }),
      p2: agentData.map(function (a) { return a.p2.raw.answered; }),
    },
    rung: {
      labels: chartLabels,
      p1: agentData.map(function (a) { return a.p1.raw.rung; }),
      p2: agentData.map(function (a) { return a.p2.raw.rung; }),
    },
    pct: {
      labels: chartLabels,
      p1: agentData.map(function (a) { return a.p1.raw.pct; }),
      p2: agentData.map(function (a) { return a.p2.raw.pct; }),
    },
  };

  // ── Team-level insights vs prior period (P1) ──────────────────
  const teamInsights = buildTeamInsights_(
    { rung: teamP2.rung,     missed: teamP2.missed, answered: teamP2.answered,
      pct: teamP2Pct,        att: teamP2Att },
    { rung: teamP1.rung,     missed: teamP1.missed, answered: teamP1.answered,
      pct: teamP1Pct,        att: teamP1Att });

  // Pretty labels for the side-by-side date header.
  const fmt = function (iso) {
    const p = iso.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
    return Utilities.formatDate(d, TZ, 'MMM d, yyyy');
  };
  const p1Label = fmt(p1From) + ' – ' + fmt(p1To);
  const p2Label = fmt(p2From) + ' – ' + fmt(p2To);

  // Period-length metadata so the client can render per-day
  // normalized volume metrics when the two periods are of
  // different lengths (e.g., 7 days vs 30 days). lengthMismatch
  // is true when the longer period is at least 20% longer than
  // the shorter -- the client uses it to decide whether to show
  // "X/day" annotations and the warning banner.
  const msPerDay = 86400000;
  const parseIso_ = function (iso) {
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
  };
  const p1Days = Math.floor((parseIso_(p1To) - parseIso_(p1From)) / msPerDay) + 1;
  const p2Days = Math.floor((parseIso_(p2To) - parseIso_(p2From)) / msPerDay) + 1;
  // `Math.min(...) > 0` guards the divide; inputs are already
  // validated above to ensure from <= to, so p1Days/p2Days are
  // always >= 1 in practice -- this is belt-and-suspenders for the
  // empty-state shape (emptyCompareRanges_ returns p1Days:0
  // p2Days:0) which sets lengthMismatch:false correctly.
  const lengthMismatch = (Math.min(p1Days, p2Days) > 0)
    && (Math.max(p1Days, p2Days) / Math.min(p1Days, p2Days) >= 1.2);

  return {
    meta: {
      department: dept,
      p1From: p1From, p1To: p1To,
      p2From: p2From, p2To: p2To,
      p1Days: p1Days, p2Days: p2Days,
      lengthMismatch: lengthMismatch,
      agents: selectedAgents,
      rosterSize: roster.names.length,
      generatedAt: new Date().toISOString(),
    },
    p1Label: p1Label,
    p2Label: p2Label,
    teamStats: teamStats,
    agentData: agentData,
    chartData: chartData,
    teamInsights: teamInsights,
  };
}

/**
 * Per-agent per-period block: formatted strings + raw numerics.
 * Pct + ATT are pre-computed by the caller since they require
 * cross-row aggregation (the daily-stored ATT is already an avg,
 * so we re-weight by answered).
 */
function agentPeriodBlock_(s, pct, att) {
  return {
    formatted: {
      rung:     String(s.rung),
      missed:   String(s.missed),
      answered: String(s.answered),
      pct:      pct.toFixed(1) + '%',
      ttt:      formatSecondsHms_(s.ttt),
      att:      formatSecondsHms_(att),
    },
    raw: {
      rung: s.rung, missed: s.missed, answered: s.answered,
      pct: pct, ttt: s.ttt, att: att,
    },
  };
}

/**
 * Delta between two values. For "volume" type, deltaPct is the
 * relative percent change (((p2 - p1) / p1) * 100). 0->0 = 0;
 * 0->nonzero = +100. For "pctPoints" type, deltaPct is the
 * ABSOLUTE point difference -- multiplying two percentages reads
 * as confusing.
 */
function crDelta_(p2Val, p1Val, isPctType) {
  let delta, deltaPct;
  if (isPctType) {
    delta = p2Val - p1Val;
    deltaPct = delta;
  } else {
    delta = p2Val - p1Val;
    if (p1Val === 0 && p2Val === 0) deltaPct = 0;
    else if (p1Val === 0) deltaPct = 100;
    else deltaPct = (delta / p1Val) * 100;
  }
  return { delta: delta, deltaPct: deltaPct, type: isPctType ? 'pctPoints' : 'volume' };
}

/**
 * Builds the team-level KPI tile data: both period values + delta.
 * Mirrors the shape used by PerformanceReport.gs's deltaBlock_ so
 * the client can reuse the same tile renderer.
 */
function crTeamPair_(p2Val, p1Val, type, p2Formatted, p1Formatted) {
  const d = crDelta_(p2Val, p1Val, type === 'pctPoints');
  return {
    val: p2Val,
    prev: p1Val,
    formatted: p2Formatted,
    prevFormatted: p1Formatted,
    delta: d.delta,
    deltaPct: d.deltaPct,
    type: type,
  };
}

function emptyCompareRanges_(dept, selectedAgents, roster,
                             p1From, p1To, p2From, p2To) {
  // INV-53: drop crafted off-dept names; only roster members render
  // in the empty shape (floaters need actual rows to be confirmed).
  const emptyRosterSet = {};
  if (roster && roster.names) {
    for (let i = 0; i < roster.names.length; i++) emptyRosterSet[roster.names[i]] = true;
  }
  const emptyBlock = {
    formatted: { rung: '0', missed: '0', answered: '0',
                 pct: '0.0%', ttt: '0:00:00', att: '0:00:00' },
    raw: { rung: 0, missed: 0, answered: 0, pct: 0, ttt: 0, att: 0 },
  };
  const emptyDelta = { delta: 0, deltaPct: 0, type: 'volume' };
  return {
    meta: {
      department: dept,
      p1From: p1From, p1To: p1To,
      p2From: p2From, p2To: p2To,
      p1Days: 0, p2Days: 0,
      lengthMismatch: false,
      agents: selectedAgents,
      rosterSize: roster ? roster.names.length : 0,
      generatedAt: new Date().toISOString(),
    },
    p1Label: p1From + ' – ' + p1To,
    p2Label: p2From + ' – ' + p2To,
    teamStats: {
      rung:     { val: 0, prev: 0, formatted: '0',       prevFormatted: '0',       delta: 0, deltaPct: 0, type: 'volume' },
      missed:   { val: 0, prev: 0, formatted: '0',       prevFormatted: '0',       delta: 0, deltaPct: 0, type: 'volume' },
      answered: { val: 0, prev: 0, formatted: '0',       prevFormatted: '0',       delta: 0, deltaPct: 0, type: 'volume' },
      pct:      { val: 0, prev: 0, formatted: '0.0%',    prevFormatted: '0.0%',    delta: 0, deltaPct: 0, type: 'pctPoints' },
      ttt:      { val: 0, prev: 0, formatted: '0:00:00', prevFormatted: '0:00:00', delta: 0, deltaPct: 0, type: 'volume' },
      att:      { val: 0, prev: 0, formatted: '0:00:00', prevFormatted: '0:00:00', delta: 0, deltaPct: 0, type: 'volume' },
    },
    agentData: selectedAgents.filter(function (a) {
      return !!emptyRosterSet[a];
    }).map(function (a) {
      return {
        name: a,
        matchedViaRoster: true,
        matchedViaQueue:  false,
        sourceHomes:      [],
        p1: emptyBlock, p2: emptyBlock,
        deltas: { rung: emptyDelta, missed: emptyDelta, answered: emptyDelta,
                  pct: Object.assign({}, emptyDelta, { type: 'pctPoints' }),
                  ttt: emptyDelta, att: emptyDelta },
      };
    }),
    chartData: {
      answered: { labels: selectedAgents.slice(), p1: selectedAgents.map(function(){return 0;}), p2: selectedAgents.map(function(){return 0;}) },
      rung:     { labels: selectedAgents.slice(), p1: selectedAgents.map(function(){return 0;}), p2: selectedAgents.map(function(){return 0;}) },
      pct:      { labels: selectedAgents.slice(), p1: selectedAgents.map(function(){return 0;}), p2: selectedAgents.map(function(){return 0;}) },
    },
    teamInsights: [],
  };
}

/**
 * Emails the captured Compare Ranges PNG to the active user.
 */
function sendCompareRangesEmail(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dataUrl = String((req && req.imageBase64) || '');
  const p1Label = String((req && req.p1Label) || '');
  const p2Label = String((req && req.p2Label) || '');
  if (!dataUrl) throw new Error('No image payload.');
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('Malformed image payload.');
  const decoded = Utilities.base64Decode(dataUrl.slice(commaIdx + 1));
  const blob = Utilities.newBlob(decoded, 'image/png', 'Compare_Ranges.png');

  MailApp.sendEmail({
    to: email,
    subject: 'Compare Ranges Report: ' + p1Label + ' vs ' + p2Label,
    htmlBody:
      '<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">'
      + 'Side-by-side comparison of two date ranges.'
      + '<br><strong>Period 1 (baseline):</strong> ' + escapeHtmlServer_(p1Label)
      + '<br><strong>Period 2 (comparison):</strong> ' + escapeHtmlServer_(p2Label)
      + '</div>'
      + '<div style="text-align: center; border: 1px solid #eee; padding: 10px;">'
      + '<img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;">'
      + '</div>',
    inlineImages: { reportImg: blob },
  });
  return { to: email };
}
