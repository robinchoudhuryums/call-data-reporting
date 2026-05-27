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

function computeActiveAgentsInRange_(dept, from, to, roster) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'individual_active:v1:' + dept + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* recompute */ }
  }

  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const ssTZ = ss.getSpreadsheetTimeZone();

  const range = sheet.getRange(2, 1, lastRow - 1, HISTORICAL_COLS.TOTAL_ANSWERED);
  const values = range.getValues();

  const active = {};
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < from || dateIso > to) continue;
    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent || !rosterSet[agent]) continue;
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;
    const rung     = Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
    const missed   = Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
    const answered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    if (rung > 0 || missed > 0 || answered > 0) active[agent] = true;
  }
  const out = Object.keys(active).sort();
  try { cache.put(cacheKey, JSON.stringify(out), CACHE_TTL_SECONDS); }
  catch (e) { /* harmless */ }
  return out;
}
