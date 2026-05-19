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
 *   - Team avg per-agent: teamTotal / roster.length. Includes roster
 *     members with zero activity in the range, so the avg "spreads"
 *     dept volume across the full roster (legacy behavior).
 *   - Team % Answered, TTT, ATT: weighted across the whole team's
 *     calls in range (NOT per-agent mean of percentages).
 *
 * Caching: 5 min per (dept, from, to, sortedAgents) tuple. Best-
 * effort -- large ranges with many agents may exceed CacheService's
 * per-value 100KB limit; on cache-put failure we log + continue.
 */

const INDIVIDUAL_CACHE_KEY_PREFIX = 'individual:v1';

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
  // Sensible default range = current month-to-date, matching the
  // main dashboard's default behavior.
  const tz = TZ;
  const now = new Date();
  const fmt = function (d) {
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  };
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return {
    department: dept,
    agents: roster.names.slice().sort(),
    defaultStart: fmt(firstOfMonth),
    defaultEnd: fmt(now),
  };
}

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

  const rawAgents = (req && req.agents) || [];
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    throw new Error('Select at least one agent.');
  }
  // Trim, dedupe, and constrain to the dept roster -- prevents a
  // crafted client request from pulling another dept's agent's data.
  const roster = getRosterForDepartment_(dept);
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;
  const seen = {};
  const selectedAgents = [];
  for (let i = 0; i < rawAgents.length; i++) {
    const n = String(rawAgents[i] || '').trim();
    if (!n || seen[n]) continue;
    if (!rosterSet[n]) continue;  // silently drop off-roster names
    seen[n] = true;
    selectedAgents.push(n);
  }
  if (selectedAgents.length === 0) {
    throw new Error('No selected agent is on this department\'s roster.');
  }
  // Stable key for cache regardless of input order.
  const agentsKey = selectedAgents.slice().sort().join('|');

  const cache = CacheService.getScriptCache();
  const cacheKey = INDIVIDUAL_CACHE_KEY_PREFIX + ':'
                 + dept + ':' + from + ':' + to + ':' + agentsKey;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeIndividualReport_(dept, from, to, selectedAgents, roster);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  try {
    cache.put(cacheKey, JSON.stringify(data), CACHE_TTL_SECONDS);
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
function computeIndividualReport_(dept, from, to, selectedAgents, roster) {
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;
  const selectedSet = {};
  for (let i = 0; i < selectedAgents.length; i++) selectedSet[selectedAgents[i]] = true;

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

  // Read cols 1..AH. We only need date (B), agent (C), rung (F),
  // missed (G), answered (H), TTT (I), ATT (J). Reading the same
  // range as Data.gs keeps cache locality on Apps Script's side.
  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  const range = sheet.getRange(2, 1, lastRow - 1, numCols);
  const values   = range.getValues();
  const displays = range.getDisplayValues();

  // Aggregators.
  // aggregatedStats[agent][monthKey] = { rung, missed, answered, ttt, attTotal }
  //   attTotal = sum of (ATT_for_that_day * answered_that_day) so the
  //   monthly weighted ATT is attTotal / answered.
  // summaryStats[agent] = same shape, over the user's selected range.
  // teamTotal = same shape, over the user's selected range, across
  //   the full dept roster.
  const aggregatedStats = {};
  const summaryStats = {};
  selectedAgents.forEach(function (a) {
    aggregatedStats[a] = {};
    summaryStats[a]    = { rung: 0, missed: 0, answered: 0, ttt: 0, attTotal: 0 };
  });
  const teamTotal = { rung: 0, missed: 0, answered: 0, ttt: 0, attTotal: 0 };
  const activeDaySet = {};   // ISO day -> true; for dept "per day" stats

  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];

    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso) continue;
    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;
    // Skip queue-sentinel rows (queue-only abandoned events; not an agent).
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;

    const inUserRange   = (dateIso >= from && dateIso <= to);
    const inTrendRange  = (dateIso >= trendStartIso && dateIso <= trendEndIso);

    // Fast-path: row touches neither window we care about.
    if (!inUserRange && !inTrendRange) continue;

    const rung     = Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
    const missed   = Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
    const answered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    const tttSec   = parseHmsDisplay_(rd[HISTORICAL_COLS.TTT - 1]);
    const attAvg   = parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]);
    // attTotal = ATT * Answered. Days with answered=0 contribute 0,
    // so unanswered/abandoned days don't drag down the weighted ATT.
    const attTotal = answered > 0 ? attAvg * answered : 0;

    // Team totals (dept-wide, over user's selected range).
    if (inUserRange && rosterSet[agent]) {
      teamTotal.rung     += rung;
      teamTotal.missed   += missed;
      teamTotal.answered += answered;
      teamTotal.ttt      += tttSec;
      teamTotal.attTotal += attTotal;
      activeDaySet[dateIso] = true;
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
    }
  }

  // Team average (per-agent simple mean across the roster), with
  // weighted % / TTT / ATT computed across the whole team's data.
  const rosterSize = roster.names.length || 1;
  const teamAvg = {
    rung:     Math.round(teamTotal.rung     / rosterSize),
    missed:   Math.round(teamTotal.missed   / rosterSize),
    answered: Math.round(teamTotal.answered / rosterSize),
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

  // Per-agent summary cards.
  const summaryData = selectedAgents.map(function (agent) {
    const s = summaryStats[agent];
    const agPct = s.rung > 0 ? (s.answered / s.rung) * 100 : 0;
    const agTtt = s.answered > 0 ? s.ttt      / s.answered : 0;
    const agAtt = s.answered > 0 ? s.attTotal / s.answered : 0;
    return {
      name: agent,
      stats: {
        rung:     s.rung,
        missed:   s.missed,
        answered: s.answered,
        pct:      agPct.toFixed(1) + '%',
        ttt:      formatSecondsHms_(agTtt),
        att:      formatSecondsHms_(agAtt),
      },
      raw: {
        rung: s.rung, missed: s.missed, answered: s.answered,
        pct: agPct, ttt: agTtt, att: agAtt,
      },
    };
  });

  // Human-readable date label like "Jan 5, 2026 - Jan 18, 2026".
  const dateLabel = Utilities.formatDate(startDate, TZ, 'MMM d, yyyy')
                  + ' - '
                  + Utilities.formatDate(endDate,   TZ, 'MMM d, yyyy');

  return {
    meta: {
      department: dept,
      from: from, to: to,
      trendStart: trendStartIso,
      trendEnd:   trendEndIso,
      agents: selectedAgents,
      mode: selectedAgents.length > 1 ? 'comparison' : 'individual',
      rosterSize: rosterSize,
      generatedAt: new Date().toISOString(),
    },
    dateLabel: dateLabel,
    trendData: { labels: chartLabels, datasets: chartDatasets },
    summaryData: summaryData,
    teamAvg: teamAvgOut,
    deptStats: deptStats,
    mode: selectedAgents.length > 1 ? 'comparison' : 'individual',
  };
}

function emptyIndividualReport_(dept, from, to, selectedAgents, masterMonthKeys) {
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
    trendData: { labels: labels, datasets: datasets },
    summaryData: selectedAgents.map(function (a) {
      return {
        name: a,
        stats: { rung: 0, missed: 0, answered: 0, pct: '0.0%', ttt: '0:00:00', att: '0:00:00' },
        raw:   { rung: 0, missed: 0, answered: 0, pct: 0, ttt: 0, att: 0 },
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
  // dataUrl is "data:image/png;base64,XXXXX". Strip the prefix before
  // decoding so the resulting blob is a clean PNG.
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

/**
 * Lists "YYYY-MM" month keys from start to end, inclusive on both
 * ends. Always month-anchored to the 1st.
 */
function generateMonthList_(start, end) {
  const out = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  while (cur <= last) {
    out.push(cur.getFullYear() + '-' + pad(cur.getMonth() + 1));
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

/**
 * Seconds -> "H:MM:SS". Matches legacy formatSecondsToTime output.
 */
function formatSecondsHms_(totalSeconds) {
  if (!totalSeconds || totalSeconds === 0) return '0:00:00';
  totalSeconds = Math.round(totalSeconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return h + ':' + pad(m) + ':' + pad(s);
}
