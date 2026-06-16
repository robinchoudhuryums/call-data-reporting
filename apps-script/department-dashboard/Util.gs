/**
 * Shared utility functions used across multiple dashboard .gs files.
 *
 * Consolidated here so cross-file dependencies via Apps Script's
 * shared global scope are explicit rather than implicit. Each
 * function was previously defined in the file noted below; callers
 * are unchanged (global scope is flat).
 */

// -- Auth (was Alerts.gs) -------------------------------------------------

function assertAdmin_() {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role !== 'admin') throw new Error('Alerts are admin-only.');
}

/**
 * Shared per-department access gate for the report endpoints
 * (Data.gs, IndividualReport, PerformanceReport, CompareRangesReport,
 * InsightsReport, MissedCallsReport, QCDReport). Centralizes the
 * dept-authorization triad that was previously copy-pasted verbatim at
 * ~10 call sites, so the security-relevant check can't drift between
 * them. Throws on rejection; returns nothing on success.
 *
 *   - role 'none'    -> 'Not authorized.' (defense-in-depth; callers
 *                       generally check this earlier too)
 *   - manager        -> may only request their own department
 *   - admin          -> may request any department that exists
 *
 * Reports with a non-standard scope (InboundReport's company-view /
 * manager-pin, CompanyOverview's company-wide aggregate) keep their
 * own gates and intentionally do NOT route through this helper.
 */
function assertDeptAccess_(user, dept) {
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  if (user.role === 'manager' && dept !== user.department) {
    throw new Error('Not authorized for this department.');
  }
  if (user.role === 'admin' && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }
}

// -- Report-usage telemetry --------------------------------------------------

/**
 * Appends one row to the Report Usage sheet recording a report open.
 * Called from the public report endpoints on BOTH the cache-hit and
 * fresh-compute paths, so the sheet reflects actual usage (the
 * evidence base for the PR/CR retirement decisions).
 *
 * INV-01 TELEMETRY CARVE-OUT -- the one sanctioned spreadsheet write
 * reachable from non-admin RPCs. Kept safe by construction:
 *   - append-only, fixed 6-column schema (REPORT_USAGE_HEADERS);
 *   - no user-controlled free text: `report` is a code constant at
 *     each call site, `dept` has already passed the caller's
 *     dept-validation, role/email come from resolveUser_;
 *   - best-effort: any failure (missing sheet pre-setup(), quota,
 *     transient error) is swallowed -- telemetry must never block,
 *     slow-fail, or error a report.
 * Do NOT add parameters that carry caller-supplied strings, and do
 * not reuse this helper for anything that isn't pure telemetry.
 */
function logReportUsage_(report, dept, user, cacheHit) {
  try {
    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.REPORT_USAGE);
    if (!sheet) return;   // setup() not re-run yet -- silently skip
    sheet.appendRow([
      new Date(),
      String(report || ''),
      String(dept || ''),
      (user && user.role)  ? String(user.role)  : '',
      (user && user.email) ? String(user.email) : '',
      cacheHit ? 'TRUE' : 'FALSE',
    ]);
  } catch (e) { /* best-effort -- never block a report */ }
}

// -- Formatting (was IndividualReport.gs) ----------------------------------

function formatSecondsHms_(totalSeconds) {
  if (!totalSeconds || totalSeconds === 0) return '0:00:00';
  totalSeconds = Math.round(totalSeconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return h + ':' + pad(m) + ':' + pad(s);
}

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
 * INV-29 monthly-trend window start. The single source of truth for the
 * 12-month trend axis, shared by the Individual, Performance, Insights,
 * and QCD reports so their trends stay aligned (previously this exact
 * block was hand-copied into all four -- a silent-drift trap, since
 * INV-29 *requires* IR and PR to align). Given the selected range's
 * start/end Dates, returns the trend-window START as a Date:
 *   - the range's own start when the range is > 366 days OR a full
 *     calendar year (Jan 1 - Dec 31 of one year) -- the range IS the
 *     window;
 *   - otherwise first-of-month(end - 12 months).
 * Callers derive their own ISO strings and call
 * generateMonthList_(start, end) for the bucket keys.
 *
 * Caller dates are noon-anchored; Math.round (not ceil) keeps the
 * +-1h DST wobble from inflating fall-back ranges by a day at the
 * 366-day boundary.
 */
function computeTrendStartDate_(startDate, endDate) {
  const msPerDay = 86400000;
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
  return trendStartDate;
}

// -- Numeric (was Alerts.gs) -----------------------------------------------

function round1_(n) { return Math.round((Number(n) || 0) * 10) / 10; }

function escapeHtmlServer_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -- Report helpers (was PerformanceReport.gs) -----------------------------

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

// -- Active agents (was IndividualReport.gs) -------------------------------

/**
 * Returns the agents who had any rung/answered/missed activity in
 * [from, to] for `dept`. Two groups:
 *   - `agents`:   active roster members (sorted, string[])
 *   - `floaters`: active queue-only floaters -- agents matched into
 *                 the dept's view via shared-queue extension overlap
 *                 (col D) but NOT on the dept's roster. Each entry is
 *                 { name, sourceHomes } where sourceHomes lists every
 *                 OTHER dept whose roster they appear on (per
 *                 buildDeptsByAgent_ in Data.gs). Empty array means
 *                 the floater is on no dept's roster at all.
 *
 * Used by the Individual / Performance / Compare Ranges report
 * pickers (Phase D+1 expansion of INV-53) to show floaters as a
 * third group beneath "Active in range" / "No activity in range",
 * so managers can include floaters in their reports while the
 * server-side team-avg computation still excludes them per the
 * floater-exclusion contract.
 *
 * Cache key `individual_active:v2` -- v2 bumped from v1 because the
 * return shape changed from `string[]` to `{agents, floaters}`.
 */
function computeActiveAgentsInRange_(dept, from, to, roster) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'individual_active:v2:' + dept + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* recompute */ }
  }

  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) return { agents: [], floaters: [] };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { agents: [], floaters: [] };
  const ssTZ = ss.getSpreadsheetTimeZone();

  const activeRoster = {};
  const activeFloater = {};
  // Classifier shared by both sources: same sentinel skip (INV-23),
  // activity test, and queue-ext floater gate the legacy loop applies.
  const classify = function (agent, rung, missed, answered, extCell, deptQueueExts) {
    if (!agent) return;
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') return;
    if (!(rung > 0 || missed > 0 || answered > 0)) return;
    if (rosterSet[agent]) { activeRoster[agent] = true; return; }
    // Off-roster: only count as a floater if their col-D extensions
    // actually overlap this dept's queue ext set -- otherwise the
    // row is for some other dept's agent who happens to be in
    // Historical Data but isn't matched into THIS dept's view.
    const rowExts = parseExtensions_(extCell);
    for (let j = 0; j < rowExts.length; j++) {
      if (deptQueueExts[rowExts[j]]) {
        activeFloater[agent] = true;
        break;
      }
    }
  };

  // F1 DAL cutover: when DQE_READ_SOURCE=neon, the windowed rows come
  // from dqe_history (the rows are pre-filtered to [from, to]) and the
  // dept ext set keeps its all-history derivation via
  // deptQueueExtsForNeonReader_. Fallback: any error or empty result
  // falls through to the legacy whole-sheet scan below, which is
  // byte-identical to pre-cutover behavior. Parity pinned by
  // tests/unit/dal-cutover.test.js.
  let usedNeon = false;
  const dqeSource = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  if (dqeSource === 'neon' && typeof neonFetchDqeRows_ === 'function') {
    try {
      const _t0 = Date.now();
      const dalRows = neonFetchDqeRows_(from, to);
      if (dalRows && dalRows.length) {
        const neonExts = deptQueueExtsForNeonReader_(dept, rosterSet, sheet, lastRow).exts;
        for (let i = 0; i < dalRows.length; i++) {
          const row = dalRows[i];
          classify(row.agent, row.totalRung, row.totalMissed, row.totalAnswered,
                   row.queueExt, neonExts);
        }
        usedNeon = true;
        if (typeof logDqeReadTiming_ === 'function') logDqeReadTiming_('activeAgents', 'neon', _t0, dalRows.length);
      }
    } catch (e) {
      Logger.log('computeActiveAgentsInRange_: neon read failed, falling back to sheet: '
        + (e && e.message ? e.message : e));
      usedNeon = false;
    }
  }

  if (!usedNeon) {
    // Pull col D too -- needed for queue-extension matching against
    // the dept's queue ext set (mirrors Data.gs::computeSummary_).
    const numCols = Math.max(HISTORICAL_COLS.TOTAL_ANSWERED, HISTORICAL_COLS.QUEUE_EXT);
    const range = sheet.getRange(2, 1, lastRow - 1, numCols);
    const values = range.getValues();

    // Dept's queue extension set -- the same getDeptQueueExts_ helper
    // Data.gs uses, so the floater list here exactly matches what My
    // Department would surface for the same range.
    const deptQueueResult = getDeptQueueExts_(dept, rosterSet, values);
    const deptQueueExts = deptQueueResult.exts;

    for (let i = 0; i < values.length; i++) {
      const r = values[i];
      const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
      if (!dateIso || dateIso < from || dateIso > to) continue;
      classify(String(r[HISTORICAL_COLS.AGENT - 1] || '').trim(),
               Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0,
               Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0,
               Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
               r[HISTORICAL_COLS.QUEUE_EXT - 1],
               deptQueueExts);
    }
  }

  // Build sourceHomes for floaters via the same lazy lookup Data.gs
  // uses (buildDeptsByAgent_). Empty floater list = no lookup needed.
  const floaterNames = Object.keys(activeFloater).sort();
  let floaters = [];
  if (floaterNames.length > 0) {
    const deptsByAgent = buildDeptsByAgent_();
    floaters = floaterNames.map(function (name) {
      return {
        name: name,
        sourceHomes: deptsByAgent[name] || [],
      };
    });
  }

  const out = {
    agents:   Object.keys(activeRoster).sort(),
    floaters: floaters,
  };
  try { cache.put(cacheKey, JSON.stringify(out), REPORT_CACHE_TTL_SECONDS); }
  catch (e) { /* harmless */ }
  return out;
}
