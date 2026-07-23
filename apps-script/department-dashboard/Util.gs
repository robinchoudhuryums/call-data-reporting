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
 *   - manager+allDepts (#1) -> like admin: any department that exists
 *   - admin          -> may request any department that exists
 *
 * Reports with a non-standard scope (InboundReport's company-view /
 * manager-pin, CompanyOverview's company-wide aggregate) keep their
 * own gates and intentionally do NOT route through this helper.
 */
function assertDeptAccess_(user, dept) {
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  // Managers are pinned to their ASSIGNED dept(s); all-dept managers (Access
  // Control dept = "ALL") + admins may request any department that exists.
  // Tier C: a manager may hold MORE THAN ONE dept -- accept any in the list.
  // `departments` is a one-element list for single-dept managers, so this is
  // byte-equivalent to the old `dept !== user.department` check for them.
  if (user.role === 'manager' && !user.allDepts) {
    var mine = (user.departments && user.departments.length) ? user.departments : [user.department];
    if (mine.indexOf(dept) === -1) throw new Error('Not authorized for this department.');
  }
  if ((user.role === 'admin' || user.allDepts) && getAllDepartments_().indexOf(dept) === -1) {
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
// F-27: set TRUE by the cache-warm trigger (CacheWarm.gs) for the duration
// of a warm run, so automated warm traffic doesn't append rows to Report
// Usage -- the sheet is the evidence base for report-retirement decisions,
// and daily warm runs (~14 fresh-compute "summary" rows/day attributed to
// the installing admin) would permanently skew it. Same-execution global:
// Apps Script executions are single-threaded, so the trigger's nested
// report calls see the flag; other users' executions have their own scope.
var REPORT_USAGE_SUPPRESS_ = false;

function logReportUsage_(report, dept, user, cacheHit) {
  if (REPORT_USAGE_SUPPRESS_) return;   // cache-warm context (F-27)
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

/**
 * Counts WORKING days (Mon-Fri) in [fromIso, toIso] inclusive. Used by the
 * Compare Ranges / Insights length-mismatch flag (INV-35) so two windows
 * with the same number of workdays but a different number of calendar days
 * (e.g. 10 calendar days spanning 2 weekends vs 8 spanning 1) are NOT
 * falsely flagged as mismatched. Weekends AND company holidays (S5: the
 * COMPANY_HOLIDAYS Script Property, same tolerant grammar as the Alert
 * Config Skip Dates cell) are skipped. UTC-noon iteration is DST-safe
 * (mirrors computePriorWindow_). ISO strings 'YYYY-MM-DD'; returns 0 on
 * empty input or an all-weekend window.
 */
function countWorkingDays_(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const f = String(fromIso).split('-');
  const t = String(toIso).split('-');
  let ms  = Date.UTC(Number(f[0]), Number(f[1]) - 1, Number(f[2]), 12);
  let end = Date.UTC(Number(t[0]), Number(t[1]) - 1, Number(t[2]), 12);
  if (isNaN(ms) || isNaN(end)) return 0;
  if (end < ms) { const tmp = ms; ms = end; end = tmp; }
  const dayMs = 86400000;
  let count = 0;
  for (let cur = ms; cur <= end; cur += dayMs) {
    const d = new Date(cur);
    const dow = d.getUTCDay();   // 0=Sun .. 6=Sat
    if (dow === 0 || dow === 6) continue;
    // S5: company holidays (COMPANY_HOLIDAYS Script Property) don't count
    // as working days either -- two windows straddling a holiday unevenly
    // no longer read as a genuine length mismatch (INV-35). Noon-UTC anchor
    // makes the ISO slice date-stable.
    if (isCompanyHoliday_(d.toISOString().slice(0, 10))) continue;
    count++;
  }
  return count;
}

// -- S5: company-holiday awareness ------------------------------------------
//
// A GLOBAL holiday list from the `COMPANY_HOLIDAYS` Script Property
// (dashboard project): comma-separated ISO dates and inclusive
// `YYYY-MM-DD..YYYY-MM-DD` ranges -- the SAME tolerant grammar as the Alert
// Config Skip Dates cell (parseSkipDateRanges_ below parses both). Distinct
// from the per-dept Skip Dates: this is "the company is closed", not "skip
// this dept's alert". Unset/empty => no holidays => every consumer behaves
// byte-identically to pre-S5 (the INV-54 regression-safety pattern).
// Consumers: countWorkingDays_ (INV-35 length-mismatch), prevBusinessDayIso_
// (alerts + daily digest walk-back), and the trigger-run holiday skips in
// runDailyAlerts_ / runDailyDigests_. The client form hints read the same
// ranges via window.__COMPANY_HOLIDAYS__ (renderDashboard_).

var COMPANY_HOLIDAYS_MEMO_ = null;   // per-execution (tests reset it)

function getCompanyHolidayRanges_() {
  if (COMPANY_HOLIDAYS_MEMO_) return COMPANY_HOLIDAYS_MEMO_;
  let raw = null;
  try { raw = PropertiesService.getScriptProperties().getProperty('COMPANY_HOLIDAYS'); } catch (e) {}
  COMPANY_HOLIDAYS_MEMO_ = raw ? parseSkipDateRanges_(raw) : [];
  return COMPANY_HOLIDAYS_MEMO_;
}

function isCompanyHoliday_(dateIso) {
  return isDateInSkipRanges_(dateIso, getCompanyHolidayRanges_());
}

/**
 * The previous BUSINESS day before `now`: walks back from yesterday over
 * Sat/Sun AND company holidays (S5). With no holidays configured this is
 * exactly the F-6 behavior (Tue-Fri -> yesterday; Mon/Sun/Sat -> Friday).
 * Shared by runDailyAlerts_ + digestWindowFor_('daily') so the two can't
 * disagree about what "Monday's run covers" means. Bounded at 14 steps --
 * a pathological all-holiday fortnight returns the 14th day back rather
 * than looping.
 */
function prevBusinessDayIso_(now) {
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  for (let i = 0; i < 14; i++) {
    const dow = d.getDay();
    const iso = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
    if (dow !== 0 && dow !== 6 && !isCompanyHoliday_(iso)) return iso;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12);
  }
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

/**
 * Parses a skip/holiday spec into an array of {from, to} ISO ranges.
 * Accepts single dates (`2026-12-25`), inclusive `..` ranges, comma
 * lists of either, and whitespace anywhere. Malformed tokens are
 * silently dropped, reversed ranges swapped -- admin-curated free text
 * with no UI validator, so the parser must never throw. (Moved from
 * Alerts.gs when the S5 company-holiday source started sharing it; the
 * E8 Skip Dates cell + COMPANY_HOLIDAYS use the same grammar.)
 */
function parseSkipDateRanges_(raw) {
  if (!raw) return [];
  const tokens = String(raw).split(',');
  const out = [];
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].trim();
    if (!tok) continue;
    const parts = tok.split('..').map(function (s) { return s.trim(); });
    let from = '', to = '';
    if (parts.length === 1 && iso.test(parts[0])) {
      from = to = parts[0];
    } else if (parts.length === 2 && iso.test(parts[0]) && iso.test(parts[1])) {
      from = parts[0]; to = parts[1];
      if (from > to) { const tmp = from; from = to; to = tmp; }
    } else {
      continue;
    }
    out.push({ from: from, to: to });
  }
  return out;
}

/**
 * True if `dateIso` (YYYY-MM-DD) falls within any range. ISO string
 * comparison is safe because the format is zero-padded and
 * lexicographically ordered. (Moved from Alerts.gs alongside the parser.)
 */
function isDateInSkipRanges_(dateIso, ranges) {
  if (!ranges || !ranges.length || !dateIso) return false;
  for (let i = 0; i < ranges.length; i++) {
    if (dateIso >= ranges[i].from && dateIso <= ranges[i].to) return true;
  }
  return false;
}

function round1_(n) { return Math.round((Number(n) || 0) * 10) / 10; }

/**
 * Combined DQE+QCD read-source cache-key suffix (CORE-3, extended for the #3
 * QCD read-back). Returns e.g. 'sheet-sheet' | 'neon-sheet' | 'neon-neon'.
 *
 * Any cache whose payload embeds BOTH the DQE metrics AND the QCD queue data
 * (the My-Department summary, Insights, the Overview) must suffix its key with
 * this so a flip of EITHER DQE_READ_SOURCE or QCD_READ_SOURCE can't serve a
 * cross-source blob for the TTL. Both getters default to 'sheet' when unset /
 * unloaded (test harnesses), so the tag is 'sheet-sheet' = pre-flag behavior.
 */
function readSourceCacheTag_() {
  var dqe = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  var qcd = (typeof getQcdReadSource_ === 'function') ? getQcdReadSource_() : 'sheet';
  return dqe + '-' + qcd;
}

function escapeHtmlServer_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -- Report helpers (was PerformanceReport.gs) -----------------------------

function buildTeamInsights_(curr, prev, opts) {
  const out = [];
  const nonTrivial = (curr.rung || 0) >= 10 || (prev.rung || 0) >= 10;
  if (!nonTrivial) return out;

  // When the two windows differ in length (INV-35), raw cumulative-volume
  // comparisons (answered count, missed count) are apples-to-oranges and
  // mislead. excludeVolume drops those, keeping the length-independent
  // metrics -- answer rate (a %) and avg talk time (a per-call average).
  const excludeVolume = !!(opts && opts.excludeVolume);

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

  if (!excludeVolume) {
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
  // CORE-3: like latestDate:v1, the key carries the ACTIVE read source so a
  // DQE_READ_SOURCE flip can't serve a picker subset computed from the
  // other source for up to the 30-min TTL (Neon can lag the sheet
  // mid-backfill, and vice versa right after a rebuild).
  const dqeSource = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  const cache = CacheService.getScriptCache();
  const cacheKey = 'individual_active:v2:' + dept + ':' + from + ':' + to + ':' + dqeSource;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* recompute */ }
  }

  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  // CORE-2 (the F-35 pattern, applied here last of the DQE readers): the
  // sheet is hard-required only when it IS the read source. The old
  // unconditional early-returns sat ABOVE the Neon branch, so with
  // DQE_READ_SOURCE=neon and a trimmed/archived sheet the IR/Insights
  // agent pickers silently rendered zero active agents while the report
  // bodies computed fine from dqe_history.
  const neonCapable = (dqeSource === 'neon' && typeof neonFetchDqeRows_ === 'function');
  const lastRow = sheet ? sheet.getLastRow() : 0;
  if (!neonCapable && (!sheet || lastRow < 2)) return { agents: [], floaters: [] };
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
  if (neonCapable) {
    try {
      const _t0 = Date.now();
      const dalRows = neonFetchDqeRows_(from, to);
      if (neonDqeRowsUsable_(dalRows)) {   // LM2: reachable-empty is trusted; only unreachable falls back
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
    // CORE-2: on the Neon path the sheet fallback may be gone entirely
    // (trimmed/archived) -- Neon failed or returned empty, so serve the
    // empty shape rather than crash on the missing sheet (F-35 semantics).
    if (!sheet || lastRow < 2) return { agents: [], floaters: [] };
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

/**
 * Read-side guard for an abandoned-ID/time cell (cols AD/AE/AF) before it's
 * split-and-counted by the Missed Calls report / Diagnostics. These cells were
 * sometimes coerced by Sheets into a thousands-separated Number (precision lost
 * past 2^53); cdr-report's sanitizer/repair marks the unrecoverable ones with
 * DQE_ABANDONED_LOST_SENTINEL. Classifying here means a coerced/lost cell is
 * NEVER parsed into fake call IDs (which would over-count abandons + render
 * garbage badges) -- the report excludes it and flags the date instead.
 *
 *   - lost  (sentinel, scientific/decimal, thousands-sep>15 digits, bare run>15)
 *       -> { lost: true,  value: '' }   (excluded; the report flags the date)
 *   - recoverable single-value coercion ("1,762,242,202,191")
 *       -> { lost: false, value: '1762242202191' }   (separators stripped)
 *   - empty / normal (single long ID, or a comma-list of long IDs)
 *       -> { lost: false, value: <unchanged> }
 *
 * Mirrors cdr-report's sanitizeAbandonedCellForNeon_; 15 digits is the
 * safe-integer ceiling (2^53 ~ 9.0e15) and a real abandoned ID / epoch-ms
 * timestamp is 13 digits, so correct values are never touched.
 */
function classifyAbandonedCell_(raw) {
  var s = (raw == null ? '' : String(raw)).trim();
  if (!s) return { lost: false, value: '' };
  if (s === DQE_ABANDONED_LOST_SENTINEL) return { lost: true, value: '' };
  if (/[eE][+\-]?\d/.test(s) || s.indexOf('.') !== -1) return { lost: true, value: '' };
  if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    var digits = s.replace(/,/g, '');
    return digits.length <= 15 ? { lost: false, value: digits } : { lost: true, value: '' };
  }
  if (/^\d+$/.test(s) && s.length > 15) return { lost: true, value: '' };
  return { lost: false, value: s };
}

/**
 * Builds the standard delta block shared across every team-stat
 * tile: { val, prev, formatted, delta, deltaPct, type }.
 *
 *   type='volume'    -> deltaPct is relative percent change of the
 *                        underlying value (0 -> nonzero = +100).
 *   type='pctPoints' -> deltaPct is the ABSOLUTE point difference
 *                        of two already-percent values; semantically
 *                        "deltaPct" is overloaded here, but the UI
 *                        renders the same +X.X label form.
 *
 * MOVED here from PerformanceReport.gs when the Performance Report was
 * retired (PR->Insights consolidation) -- InsightsReport.gs consumes it
 * for teamStats/agent metrics, and CompareRangesReport.gs mirrors its
 * shape.
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

/**
 * CORE-7: neutralizes spreadsheet formula injection on server-side sheet
 * WRITES of free-text / externally-influenced values (the sheet-side
 * sibling of the client's csvSafeCell_). Sheets executes a cell whose
 * content starts with = + - @ (or embeds a leading tab/CR) as a live
 * formula -- with "Execute as: Me" that formula runs against the OWNER's
 * spreadsheet (e.g. IMPORTXML exfil) whenever the workbook opens. A
 * leading apostrophe is Sheets' text marker: it is NOT part of the
 * stored value, so `getValue()`/`getDisplayValue()` readers see the
 * original string unchanged and lookups keep matching. Non-strings and
 * safe strings pass through untouched. Use on every admin-editor /
 * name-derived cell written via appendRow/setValue(s); values already
 * validated to a strict shape (ISO dates, emails, real dept headers)
 * don't need it.
 */
function sheetSafeCell_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}
