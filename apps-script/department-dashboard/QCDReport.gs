/**
 * QCD (Queue Call Detail) Report -- server-side data.
 *
 * Reads the `QCD Historical Data` sheet (one row per dept-name-like
 * callQueue value, per callSource, per day; written by
 * cdr-import/autoImport.js's processIntegratedHistory). Surfaces:
 *
 *   - Dept-level KPI tiles (Total Calls, Answered, Abandoned, Avg
 *     Wait, Violations) aggregated over the selected range from
 *     rows where callSource === 'Total Calls'.
 *   - Per-source breakdown table (one row per callSource: CSR,
 *     Ad-campaign, New Call Menu, Non-CSR (internal), and the
 *     Total Calls roll-up row) nested under the dept aggregate.
 *   - 12-month trend chart (monthly buckets) over the same trend
 *     window the Individual / Performance Reports use.
 *
 * Public entries (callable via google.script.run):
 *   getQcdReportInit({ department }) -> { department, defaultStart,
 *     defaultEnd, sources }
 *   getQcdReport({ department, from, to }) -> { meta, dateLabel,
 *     totals, sourceBreakdown, trendData }
 *   sendQcdReportEmail({ imageBase64, dateLabel }) -> { to }
 *
 * Authorization: same per-dept model as IR / PR / CR. Managers can
 * only request their own dept; admins can pick any dept from the
 * dropdown.
 *
 * Cache: 5 min per (dept, from, to) tuple under `qcd:v1:` prefix.
 * No agent-list dimension since QCD is queue/dept-scoped, not
 * agent-scoped.
 *
 * IMPORTANT: QCD Historical Data's `callQueue` column carries
 * DEPT-NAME-LIKE values ("CSR", "Sales", "Power"), NOT raw queue
 * names like "A_Q_CSR". Filtering against dept name is the right
 * approach -- legacy DQE Report's buildTable4 does the same.
 * If new depts produce QCD rows with names that don't match the
 * roster headers, they'll be invisible until added to the roster
 * sheet or aliased here.
 */

const QCD_CACHE_KEY_PREFIX = 'qcd:v1';

// Sources we surface in the breakdown table, in display order.
// The first entry MUST be 'Total Calls' (the daily roll-up row;
// everything else sums per-source contributions). Pulled from the
// QCDR Output static label sheet -- pinning here so the dashboard
// renders the same source set regardless of label sheet drift.
const QCD_SOURCES = Object.freeze([
  'Total Calls',
  'CSR',
  'Ad-campaign',
  'New Call Menu',
  'Non-CSR (internal)',
]);

function getQcdReportInit(req) {
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

  const tz = TZ;
  const now = new Date();
  const fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return {
    department:   dept,
    defaultStart: fmt(firstOfMonth),
    defaultEnd:   fmt(now),
    sources:      QCD_SOURCES.slice(),
  };
}

function getQcdReport(req) {
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

  const cache = CacheService.getScriptCache();
  const cacheKey = QCD_CACHE_KEY_PREFIX + ':' + dept + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeQcdReport_(dept, from, to);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit  = false;

  try { cache.put(cacheKey, JSON.stringify(data), CACHE_TTL_SECONDS); }
  catch (e) { Logger.log('QCDReport cache put failed: %s', e); }

  return data;
}

function computeQcdReport_(dept, from, to) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName('QCD Historical Data');
  if (!sheet) {
    throw new Error('Sheet "QCD Historical Data" not found. Verify the pipeline has run at least once for this dept.');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptyQcdReport_(dept, from, to);
  }
  const ssTZ = ss.getSpreadsheetTimeZone();

  // Read all 12 cols. Display values for the H:MM:SS time fields
  // (longestWait / avgAnswer); raw values for everything else.
  const lastCol = 12;
  const range = sheet.getRange(2, 1, lastRow - 1, lastCol);
  const values   = range.getValues();
  const displays = range.getDisplayValues();

  // Trend window: same logic as Individual / Performance Reports
  // (12-mo monthly buckets unless range > 366 days or full year).
  const parseIso_ = function (iso) {
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
  };
  const startDate = parseIso_(from);
  const endDate   = parseIso_(to);
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
  const monthKeys = generateMonthList_(trendStartDate, endDate);

  // Per-source accumulators for the selected range. We don't accumulate
  // every source -- only the ones in QCD_SOURCES -- so a label-sheet
  // drift adding new sources doesn't silently dilute the dept totals.
  const sourceAcc = {};
  QCD_SOURCES.forEach(function (s) {
    sourceAcc[s] = {
      totalCalls:    0,
      totalAnswered: 0,
      abandoned:     0,
      longestWaitSec: 0,
      longestWaitN:   0,
      avgAnswerSec:   0,
      avgAnswerN:     0,
      violations:    0,
      // Per-day series for the per-source trend (only Total Calls
      // surfaces in the trend chart today; kept per-source so the
      // shape's available if we want sub-tabs later).
      monthly: {},
    };
  });

  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];
    const dateIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso) continue;
    const callQueue = String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim();
    if (callQueue !== dept) continue;
    const source = String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim();
    const bucket = sourceAcc[source];
    if (!bucket) continue;   // unknown source label -- skip

    const inUserRange = (dateIso >= from && dateIso <= to);
    const inTrendRange = (dateIso >= trendStartIso && dateIso <= trendEndIso);
    if (!inUserRange && !inTrendRange) continue;

    const totalCalls    = Number(r[QCD_HISTORICAL_COLS.TOTAL_CALLS - 1])    || 0;
    const totalAnswered = Number(r[QCD_HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    const abandoned     = Number(r[QCD_HISTORICAL_COLS.ABANDONED - 1])      || 0;
    // longestWait + avgAnswer are stored H:MM:SS; parse from display
    // strings so the spreadsheet-TZ-vs-script-TZ duration gotcha
    // (INV-02) doesn't bite. parseHmsDisplay_ is shared from Data.gs.
    const longestWaitSec = parseHmsDisplay_(rd[QCD_HISTORICAL_COLS.LONGEST_WAIT - 1]);
    const avgAnswerSec   = parseHmsDisplay_(rd[QCD_HISTORICAL_COLS.AVG_ANSWER   - 1]);
    const violations     = Number(r[QCD_HISTORICAL_COLS.VIOLATIONS - 1]) || 0;

    if (inUserRange) {
      bucket.totalCalls    += totalCalls;
      bucket.totalAnswered += totalAnswered;
      bucket.abandoned     += abandoned;
      // longest wait: take the MAX across days (longest wait observed
      // anywhere in the range). avgAnswer: simple mean across days
      // with non-zero values, matching legacy buildTable4 semantics.
      if (longestWaitSec > bucket.longestWaitSec) bucket.longestWaitSec = longestWaitSec;
      if (avgAnswerSec > 0) { bucket.avgAnswerSec += avgAnswerSec; bucket.avgAnswerN++; }
      bucket.violations += violations;
    }
    if (inTrendRange) {
      const monthKey = dateIso.slice(0, 7);
      let mb = bucket.monthly[monthKey];
      if (!mb) {
        mb = { totalCalls: 0, totalAnswered: 0, abandoned: 0, violations: 0 };
        bucket.monthly[monthKey] = mb;
      }
      mb.totalCalls    += totalCalls;
      mb.totalAnswered += totalAnswered;
      mb.abandoned     += abandoned;
      mb.violations    += violations;
    }
  }

  // Build per-source breakdown rows (preserving QCD_SOURCES order).
  const sourceBreakdown = QCD_SOURCES.map(function (src) {
    const b = sourceAcc[src];
    const pct = b.totalCalls > 0 ? (b.abandoned / b.totalCalls) * 100 : 0;
    return {
      source:           src,
      isTotal:          src === 'Total Calls',
      totalCalls:       b.totalCalls,
      totalAnswered:    b.totalAnswered,
      abandoned:        b.abandoned,
      abandonedPct:     pct,
      abandonedPctStr:  pct.toFixed(2) + '%',
      longestWait:      formatSecondsHms_(b.longestWaitSec),
      longestWaitSec:   b.longestWaitSec,
      avgAnswer:        formatSecondsHms_(b.avgAnswerN > 0
                          ? Math.round(b.avgAnswerSec / b.avgAnswerN) : 0),
      avgAnswerSec:     b.avgAnswerN > 0 ? Math.round(b.avgAnswerSec / b.avgAnswerN) : 0,
      violations:       b.violations,
    };
  });

  const totalRow = sourceBreakdown[0];   // 'Total Calls'

  // Trend chart series (Total Calls source only). Per-month
  // totalCalls + abandoned + violations + abandonedPct.
  const trendLabels = monthKeys.map(function (m) {
    const parts = m.split('-');
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return Utilities.formatDate(d, TZ, 'MMM, yy');
  });
  const trendSeries = monthKeys.map(function (m) {
    const b = sourceAcc['Total Calls'].monthly[m]
            || { totalCalls: 0, totalAnswered: 0, abandoned: 0, violations: 0 };
    const pct = b.totalCalls > 0 ? (b.abandoned / b.totalCalls) * 100 : 0;
    return {
      totalCalls:    b.totalCalls,
      totalAnswered: b.totalAnswered,
      abandoned:     b.abandoned,
      abandonedPct:  pct,
      violations:    b.violations,
    };
  });

  const fmt = function (d) { return Utilities.formatDate(d, TZ, 'MMM d, yyyy'); };
  const dateLabel = fmt(startDate) + ' - ' + fmt(endDate);

  return {
    meta: {
      department: dept,
      from: from, to: to,
      trendStart: trendStartIso,
      trendEnd:   trendEndIso,
      sources: QCD_SOURCES.slice(),
      generatedAt: new Date().toISOString(),
    },
    dateLabel: dateLabel,
    totals: {
      totalCalls:      totalRow.totalCalls,
      totalAnswered:   totalRow.totalAnswered,
      abandoned:       totalRow.abandoned,
      abandonedPct:    totalRow.abandonedPct,
      abandonedPctStr: totalRow.abandonedPctStr,
      longestWait:     totalRow.longestWait,
      avgAnswer:       totalRow.avgAnswer,
      violations:      totalRow.violations,
    },
    sourceBreakdown: sourceBreakdown,
    trendData: { labels: trendLabels, series: trendSeries },
  };
}

function emptyQcdReport_(dept, from, to) {
  return {
    meta: {
      department: dept,
      from: from, to: to,
      trendStart: from, trendEnd: to,
      sources: QCD_SOURCES.slice(),
      generatedAt: new Date().toISOString(),
    },
    dateLabel: from + ' - ' + to,
    totals: {
      totalCalls: 0, totalAnswered: 0, abandoned: 0,
      abandonedPct: 0, abandonedPctStr: '0.00%',
      longestWait: '0:00:00', avgAnswer: '0:00:00', violations: 0,
    },
    sourceBreakdown: QCD_SOURCES.map(function (s) {
      return {
        source: s, isTotal: s === 'Total Calls',
        totalCalls: 0, totalAnswered: 0, abandoned: 0,
        abandonedPct: 0, abandonedPctStr: '0.00%',
        longestWait: '0:00:00', longestWaitSec: 0,
        avgAnswer: '0:00:00', avgAnswerSec: 0, violations: 0,
      };
    }),
    trendData: { labels: [], series: [] },
  };
}

/**
 * Emails the captured QCD Report PNG to the active user. Same
 * pattern as Individual / Performance / Compare Ranges email
 * exports.
 */
function sendQcdReportEmail(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dataUrl = String((req && req.imageBase64) || '');
  const dateLabel = String((req && req.dateLabel) || 'QCD Report');
  if (!dataUrl) throw new Error('No image payload.');
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('Malformed image payload.');
  const decoded = Utilities.base64Decode(dataUrl.slice(commaIdx + 1));
  const blob = Utilities.newBlob(decoded, 'image/png', 'QCD_Report.png');

  MailApp.sendEmail({
    to: email,
    subject: 'QCD Report: ' + dateLabel,
    htmlBody:
      '<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">'
      + 'Here is the visual snapshot of the QCD report (queue / call '
      + 'detail metrics: Total Calls, Abandoned %, Violations, etc.).'
      + '</div>'
      + '<div style="text-align: center; border: 1px solid #eee; padding: 10px;">'
      + '<img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;">'
      + '</div>',
    inlineImages: { reportImg: blob },
  });
  return { to: email };
}
