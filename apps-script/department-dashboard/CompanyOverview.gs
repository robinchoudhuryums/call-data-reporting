/**
 * Company Overview - cross-dept landing view.
 *
 * Single public entry callable via google.script.run:
 *   getCompanyOverview() -> {
 *     latestDate:       'yyyy-MM-dd' | null,
 *     trendIsoLabels:   ['yyyy-MM-dd', ...]    (30 entries, oldest first)
 *     trendLabels:      ['Apr 21', ...],        (human-readable, x-axis)
 *     depts: [
 *       { name, activeAgents, rosterSize,
 *         latest: { rung, missed, answered, pct, pctFormatted,
 *                   attFormatted },
 *         trend: [pct | null, ...]              (per-day % Answered;
 *                                                 null on no-data days
 *                                                 so the chart can gap),
 *       },
 *       ...
 *     ]
 *   }
 *
 * Accessibility: any authenticated user (manager or admin). The
 * legacy DQE Report spreadsheet let managers see other depts' data
 * (read-only), and reinstating that visibility is part of the
 * design intent for this view.
 *
 * Caching: 5 min under `companyOverview:v1`.
 *
 * Performance notes: one bulk read over the historical sheet (last
 * 30 days' worth of rows are scanned). Roster reads done once per
 * dept upfront. For ~14 depts and ~30 days * ~14 agents per dept,
 * this fits comfortably in a single Apps Script execution.
 */

const COMPANY_OVERVIEW_CACHE_KEY = 'companyOverview:v1';

function getCompanyOverview() {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const cache = CacheService.getScriptCache();
  const cached = cache.get(COMPANY_OVERVIEW_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* recompute */ }
  }

  const latestDate = getLatestDataDate();
  if (!latestDate) {
    return { latestDate: null, trendIsoLabels: [], trendLabels: [], depts: [] };
  }

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) return { latestDate: null, trendIsoLabels: [], trendLabels: [], depts: [] };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { latestDate: latestDate, trendIsoLabels: [], trendLabels: [], depts: [] };
  const ssTZ = ss.getSpreadsheetTimeZone();

  // 30-day window ending on latestDate (inclusive).
  const latestDateObj = parseIsoNoon_(latestDate);
  const trendDays = 30;
  const trendStart = new Date(latestDateObj.getTime() - (trendDays - 1) * 86400000);
  const trendStartIso = Utilities.formatDate(trendStart, TZ, 'yyyy-MM-dd');

  const trendIsoLabels = [];
  for (let i = 0; i < trendDays; i++) {
    const d = new Date(trendStart.getTime() + i * 86400000);
    trendIsoLabels.push(Utilities.formatDate(d, TZ, 'yyyy-MM-dd'));
  }
  const trendLabels = trendIsoLabels.map(function (iso) {
    const p = iso.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return Utilities.formatDate(d, TZ, 'MMM d');
  });

  // Load every dept's roster up front. Build a name->dept lookup so
  // we can attribute each row to the right dept(s) in O(1) inside
  // the bulk scan.  Agents on multiple rosters count in each.
  const allDepts = getAllDepartments_();
  const rosterByDept = {};
  const deptsForAgent = {};
  allDepts.forEach(function (d) {
    const roster = getRosterForDepartment_(d);
    rosterByDept[d] = roster;
    roster.names.forEach(function (name) {
      if (!deptsForAgent[name]) deptsForAgent[name] = [];
      deptsForAgent[name].push(d);
    });
  });

  // Per-dept aggregators. trendByDate keyed on ISO day; latestDay
  // is the same shape but only for latestDate.
  const deptStats = {};
  allDepts.forEach(function (d) {
    deptStats[d] = {
      latestDay: { rung: 0, missed: 0, answered: 0, att_sum: 0, activeAgents: {} },
      trendByDate: {},  // iso -> { rung, answered }
    };
  });

  // Bulk scan -- only the last `trendDays` worth of rows matter.
  const range = sheet.getRange(2, 1, lastRow - 1, HISTORICAL_COLS.CSR_AVG_ABD_WAIT);
  const values   = range.getValues();
  const displays = range.getDisplayValues();
  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];
    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < trendStartIso) continue;
    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;
    const ownerDepts = deptsForAgent[agent];
    if (!ownerDepts || !ownerDepts.length) continue;

    const rung     = Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
    const missed   = Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
    const answered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    const attAvg   = parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]);
    const attTotal = answered > 0 ? attAvg * answered : 0;

    ownerDepts.forEach(function (d) {
      const stats = deptStats[d];
      let trendDay = stats.trendByDate[dateIso];
      if (!trendDay) {
        trendDay = { rung: 0, answered: 0 };
        stats.trendByDate[dateIso] = trendDay;
      }
      trendDay.rung     += rung;
      trendDay.answered += answered;

      if (dateIso === latestDate) {
        const ld = stats.latestDay;
        ld.rung     += rung;
        ld.missed   += missed;
        ld.answered += answered;
        ld.att_sum  += attTotal;
        if (rung > 0 || answered > 0 || missed > 0) {
          ld.activeAgents[agent] = true;
        }
      }
    });
  }

  // Format per-dept output. Departments sorted by latest-day rung
  // descending so the busier teams surface first.
  const depts = allDepts.map(function (d) {
    const stats = deptStats[d];
    const ld = stats.latestDay;
    const pct = ld.rung > 0 ? (ld.answered / ld.rung) * 100 : 0;
    const att = ld.answered > 0 ? ld.att_sum / ld.answered : 0;
    const trend = trendIsoLabels.map(function (iso) {
      const day = stats.trendByDate[iso];
      if (!day || day.rung <= 0) return null;
      return round1_((day.answered / day.rung) * 100);
    });
    return {
      name: d,
      activeAgents: Object.keys(ld.activeAgents).length,
      rosterSize: rosterByDept[d].names.length,
      latest: {
        rung:           ld.rung,
        missed:         ld.missed,
        answered:       ld.answered,
        pct:            round1_(pct),
        pctFormatted:   pct.toFixed(1) + '%',
        attFormatted:   formatSecondsHms_(att),
      },
      trend: trend,
    };
  }).sort(function (a, b) { return b.latest.rung - a.latest.rung; });

  const result = {
    latestDate:     latestDate,
    trendIsoLabels: trendIsoLabels,
    trendLabels:    trendLabels,
    depts:          depts,
  };

  try { cache.put(COMPANY_OVERVIEW_CACHE_KEY, JSON.stringify(result), CACHE_TTL_SECONDS); }
  catch (e) { Logger.log('CompanyOverview cache put failed: %s', e); }

  return result;
}

function parseIsoNoon_(iso) {
  const p = iso.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
}
