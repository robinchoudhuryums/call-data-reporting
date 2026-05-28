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

  const activeRoster = {};
  const activeFloater = {};
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < from || dateIso > to) continue;
    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;
    // Skip queue-sentinel rows (INV-23). Same filter Data.gs applies.
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;
    const rung     = Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
    const missed   = Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
    const answered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    const hadActivity = rung > 0 || missed > 0 || answered > 0;
    if (!hadActivity) continue;
    if (rosterSet[agent]) {
      activeRoster[agent] = true;
      continue;
    }
    // Off-roster: only count as a floater if their col-D extensions
    // actually overlap this dept's queue ext set -- otherwise the
    // row is for some other dept's agent who happens to be in
    // Historical Data but isn't matched into THIS dept's view.
    const rowExts = parseExtensions_(r[HISTORICAL_COLS.QUEUE_EXT - 1]);
    for (let j = 0; j < rowExts.length; j++) {
      if (deptQueueExts[rowExts[j]]) {
        activeFloater[agent] = true;
        break;
      }
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
  try { cache.put(cacheKey, JSON.stringify(out), CACHE_TTL_SECONDS); }
  catch (e) { /* harmless */ }
  return out;
}
