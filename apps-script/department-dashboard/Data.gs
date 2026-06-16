/**
 * Data layer.
 *
 * Public API (called via google.script.run from the client):
 *   getDepartmentSummary({ department, from, to })
 *     -> { meta, rows, totals }
 *
 * Authorization: every request re-resolves the caller and rejects
 *   any cross-department access. Admins can request any department
 *   that exists in the dept list; managers are pinned to theirs.
 *
 * Caching: 5-minute (CACHE_TTL_SECONDS) per (dept, from, to) tuple.
 *   Cached payload is the full response with meta.cacheHit overwritten
 *   to true on serve.
 *
 * Performance: one bulk getValues() over cols A..AH of DQE Historical
 *   Data, in-memory date filter + roster filter + aggregation. Roster
 *   read separately from DO NOT EDIT! (cheap, one column).
 */

/**
 * Returns the most-recent ISO date present in DQE Historical Data,
 * across all agents (no dept filter). Cached for 5 min under
 * `latestDate:v1`. The dashboard uses this at init time so the
 * default From/To pair lands on a day with actual data instead of
 * today (which may be before the daily ingest has run, or a
 * weekend with no activity).
 *
 * Returns the ISO string ('YYYY-MM-DD') or null if the sheet is
 * empty.
 */
function getLatestDataDate() {
  const cache = CacheService.getScriptCache();
  // F1 read-back (Phase 3.2 cutover #1): the cache key is suffixed with
  // the active source so flipping DQE_READ_SOURCE doesn't serve a value
  // computed from the other source (Neon can lag the sheet mid-backfill).
  // Default 'sheet' => byte-identical to pre-cutover behavior.
  const source = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  const KEY = 'latestDate:v1:' + source;
  // Sentinel for the negative case (sheet missing / empty) so we
  // don't reopen the spreadsheet on every page load when the data
  // pipeline is broken or before first ingest.
  const NEGATIVE = '__none__';
  const cached = cache.get(KEY);
  if (cached === NEGATIVE) return null;
  if (cached) return cached;

  const cachePut = function (v) {
    try { cache.put(KEY, v, CACHE_TTL_SECONDS); } catch (e) {}
  };

  // When DQE_READ_SOURCE=neon, read MAX(call_date) from dqe_history (one
  // indexed query vs a whole-column sheet scan). Best-effort: any
  // null/empty/error falls through to the sheet scan below, so a Neon
  // hiccup degrades to today's behavior rather than failing.
  if (source === 'neon' && typeof neonGetMaxDqeDate_ === 'function') {
    const _t0 = Date.now();
    const neonMax = neonGetMaxDqeDate_();
    if (neonMax) {
      if (typeof logDqeReadTiming_ === 'function') logDqeReadTiming_('getLatestDataDate', 'neon', _t0, 1);
      cachePut(neonMax); return neonMax;
    }
    Logger.log('getLatestDataDate: neon returned no date; falling back to sheet.');
  }

  const _tSheet = Date.now();
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) { cachePut(NEGATIVE); return null; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { cachePut(NEGATIVE); return null; }
  const ssTZ = ss.getSpreadsheetTimeZone();

  // The Date column is at HISTORICAL_COLS.DATE.  Scan only that
  // column to keep the read cheap.
  const values = sheet.getRange(2, HISTORICAL_COLS.DATE, lastRow - 1, 1).getValues();
  let latest = '';
  for (let i = 0; i < values.length; i++) {
    const iso = rowDateIso_(values[i][0], ssTZ);
    if (iso && iso > latest) latest = iso;
  }
  if (!latest) { cachePut(NEGATIVE); return null; }
  if (typeof logDqeReadTiming_ === 'function') logDqeReadTiming_('getLatestDataDate', 'sheet', _tSheet, lastRow - 1);
  cachePut(latest);
  return latest;
}

/**
 * Returns latest-data dates per source plus the overall max, used
 * by the header freshness pill so it doesn't go stale when one
 * source (e.g. QCD Historical Data) is updated independently of
 * another (e.g. DQE Historical Data via the cdr-report build).
 *
 * Shape:
 *   { dqe: 'yyyy-MM-dd' | null,
 *     qcd: 'yyyy-MM-dd' | null,
 *     latest: 'yyyy-MM-dd' | null }   // MAX of the above
 *
 * Cached 5 min under `latestDates:v1`. The single-source
 * `getLatestDataDate()` above is kept for the My Department From/To
 * default (which should still snap to DQE specifically -- the
 * agent table draws from DQE; defaulting to a QCD-only date would
 * land the table on an empty day).
 */
function getLatestDataDates() {
  const cache = CacheService.getScriptCache();
  const KEY = 'latestDates:v1';
  const cached = cache.get(KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* recompute */ }
  }

  const result = { dqe: null, qcd: null, latest: null };
  try {
    const ss = openSpreadsheet_();
    const ssTZ = ss.getSpreadsheetTimeZone();

    // DQE Historical Data -- col B (date). Reuses the cached
    // single-source result so we don't double-scan.
    result.dqe = getLatestDataDate();

    // QCD Historical Data -- col C. Pipeline writer is
    // autoImport.js's processIntegratedHistory QCD block; the
    // sheet may be absent on a fresh CDR Report ss that hasn't
    // ingested QCD yet, in which case we leave result.qcd null.
    const qcdSheet = ss.getSheetByName('QCD Historical Data');
    if (qcdSheet) {
      const lastRow = qcdSheet.getLastRow();
      if (lastRow >= 2) {
        const values = qcdSheet
          .getRange(2, QCD_HISTORICAL_COLS.DATE, lastRow - 1, 1)
          .getValues();
        let qcdLatest = '';
        for (let i = 0; i < values.length; i++) {
          const iso = rowDateIso_(values[i][0], ssTZ);
          if (iso && iso > qcdLatest) qcdLatest = iso;
        }
        if (qcdLatest) result.qcd = qcdLatest;
      }
    }

    // Overall max -- drives the pill's visible date + age. When
    // both sources agree, the pill matches DQE (normal steady
    // state). When they differ (e.g. during a migration where
    // QCD is fresh but DQE hasn't been rebuilt yet), the pill
    // reflects the most recent any-data signal and the tooltip
    // shows the per-source breakdown.
    if (result.dqe && result.qcd) {
      result.latest = result.dqe > result.qcd ? result.dqe : result.qcd;
    } else {
      result.latest = result.dqe || result.qcd || null;
    }
  } catch (e) {
    Logger.log('getLatestDataDates failed: %s', e);
  }
  try { cache.put(KEY, JSON.stringify(result), CACHE_TTL_SECONDS); } catch (e) {}
  return result;
}

function getDepartmentSummary(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);

  if (user.role === 'none') {
    throw new Error('Not authorized.');
  }

  const dept = String((req && req.department) || '').trim();
  if (!dept) {
    throw new Error('Department is required.');
  }
  assertDeptAccess_(user, dept);

  const from = String((req && req.from) || '').trim();
  const to = String((req && req.to) || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) {
    throw new Error('from/to must be YYYY-MM-DD.');
  }
  if (from > to) {
    throw new Error('from must be on or before to.');
  }

  // Scope: locked to 'both' since the Phase D scope-toggle
  // removal cleanup (the toggle was retained for parallel-run
  // validation through Phases D / D+1 / E; once the 'both' default
  // + roster-only totals semantics proved out, the user-facing
  // toggle was retired). `computeSummary_` still accepts a scope
  // arg because internal callers (Digest.gs) use 'roster' for the
  // manager-digest path -- the public RPC just doesn't expose it.
  const scope = 'both';

  const cache = CacheService.getScriptCache();
  // Bump the version suffix any time the aggregation rules change so
  // stale caches are invalidated instantly across all dept/range
  // tuples. v2: ATT switched to simple mean. v3: scope param added,
  // diagnostics field added to response. v4: queue-scope matching
  // switched from roster.allExtensions (personal exts) to the dept's
  // deptQueueExts (override or derived from data). Queue/Both scope
  // now actually match shared-queue extensions in col D. v5: response
  // gains a nullable `qcd` field with the dept's most-recent QCD
  // snapshot (rendered as "Yesterday's QCD" on My Department).
  // v6: QCD snapshot uses queuesForDept_ rollup so parent depts
  // (Sales / Power / CSR) include their sub-queues' QCD activity.
  // v7: default scope 'both'; per-row `sourceHome` added for
  // queue-only floaters; totals filtered to matchedViaRoster=true so
  // floaters don't dilute dept averages (Phase D).
  // v8: per-row prior-period deltas added (Phase E, E5). Each row
  // carries `priorRung` / `priorMissed` / `priorAnswered` /
  // `priorHasData` for the same-duration window immediately
  // preceding the selected range (INV-28 parallel). Drives the
  // per-row delta chip on the agent table; `meta.priorFrom` /
  // `meta.priorTo` carry the computed window so the client can
  // show it in chip hover tooltips.
  // v9: qcdSnapshot shape gains perQueue (sub-queues separated).
  const cacheKey = 'summary:v9:' + dept + ':' + scope + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      logReportUsage_('summary', dept, user, true);
      return parsed;
    } catch (e) {
      // Corrupted cache entry -- fall through to recompute.
      Logger.log('Cache parse failed, recomputing: %s', e);
    }
  }

  const t0 = Date.now();
  const data = computeSummary_(dept, from, to, scope);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  try {
    cache.put(cacheKey, JSON.stringify(data), REPORT_CACHE_TTL_SECONDS);
  } catch (e) {
    // CacheService values are capped at ~100KB. A single dept's
    // summary is well under that, but log if it ever fails.
    Logger.log('Cache put failed: %s', e);
  }

  logReportUsage_('summary', dept, user, false);
  return data;
}

function isIsoDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  // Reject format-valid but impossible dates (e.g. 2026-13-99, 2026-02-30)
  // so a typo'd date surfaces a clear "must be YYYY-MM-DD" error instead of
  // silently producing an empty/rolled-over window and a wrong-but-rendered
  // report. Round-trip through a UTC Date and confirm the parts survive.
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y
      && dt.getUTCMonth() === mo - 1
      && dt.getUTCDate() === d;
}

/**
 * Reads + aggregates. Pure -- no caching here, that's the caller's job.
 *
 * scope:
 *   'roster' - only rows whose Agent Name is in this dept's roster
 *   'queue'  - only rows whose Col D queue extensions overlap this
 *              dept's queue extension union
 *   'both'   - union of the above (an agent matched by either path)
 */
function computeSummary_(dept, from, to, scope) {
  scope = scope || 'roster';

  const roster = getRosterForDepartment_(dept);
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  // Prior window for per-row delta chips (Phase E, E5). Same
  // duration as the selected range, ending one day before `from`
  // -- mirrors Performance Report's prior-period semantics
  // (INV-28). Computed in JS Date space + formatted back to ISO so
  // DST boundaries don't shift the window by an hour.
  const priorWindow_ = computePriorWindow_(from, to);
  const priorFrom = priorWindow_.from;
  const priorTo   = priorWindow_.to;

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) {
    throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptySummary_(dept, from, to, scope, roster.names.length, 0, []);
  }

  // Pre-fetch the spreadsheet's TZ once. Used by rowDateIso_ to
  // correctly interpret any date cells that come back as Date
  // objects (currently your dates are strings, so this is mostly
  // belt-and-suspenders -- but if the column is ever reformatted
  // to a date type, this prevents the same TZ-shift bug we hit on
  // the duration columns.
  const ssTZ = ss.getSpreadsheetTimeZone();

  // Read both numeric/Date values AND display strings on the same
  // range. Duration cells (TTT/ATT/abd-wait) get parsed from their
  // display strings to avoid spreadsheet-vs-script timezone drift:
  // when getValue() returns a Date for a duration cell, the Date is
  // interpreted using the SPREADSHEET'S timezone, while our local-
  // time extraction (getHours/Min/Sec) uses the SCRIPT'S timezone.
  // Any mismatch (e.g. Mexico City TZ vs Chicago TZ) silently shifts
  // every duration by the offset. Display values are TZ-free.
  // F1 cutover #3: source the per-(date,agent) rows for [priorFrom, to]
  // (user window + the E5 prior window) from Neon when DQE_READ_SOURCE=neon,
  // else the sheet. Both produce the same normalized `srcRows` shape
  // (durations already in seconds), so the aggregation loop below is
  // source-agnostic. Default 'sheet' is byte-identical to pre-cutover --
  // compute-summary.test.js guards that.
  //
  // deptQueueExts (queue-scope match set): its DERIVED path needs ALL
  // history (every ext a roster agent ever used), NOT just the window. So
  // on the Neon path we still read a cheap cols-A..D slice for
  // getDeptQueueExts_ (no getDisplayValues), while the heavy windowed
  // aggregation comes from Neon; an override dept skips the scan entirely.
  // (A later step can move this derivation to a SELECT DISTINCT Neon query.)
  const dqeSource = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  let srcRows = null;
  let deptQueueExts, deptQueueExtsSource;
  let effectiveSource = 'sheet';
  const _tRead = Date.now();
  if (dqeSource === 'neon' && typeof neonFetchDqeRows_ === 'function') {
    srcRows = neonFetchDqeRows_(priorFrom, to);
    if (srcRows && srcRows.length) {
      const dqr = deptQueueExtsForNeonReader_(dept, rosterSet, sheet, lastRow);
      deptQueueExts = dqr.exts; deptQueueExtsSource = dqr.source;
      effectiveSource = 'neon';
    } else {
      srcRows = null;   // empty/unreachable -> fall through to the sheet path
      Logger.log('computeSummary_: neon returned no rows; falling back to sheet.');
    }
  }
  if (srcRows === null) {
    const range = sheet.getRange(2, 1, lastRow - 1, numCols);
    const values = range.getValues();
    const displays = range.getDisplayValues();
    // Queue-scope/Both-scope matching uses this set, NOT roster.allExtensions
    // (personal exts, which never overlap col D's shared-queue exts). See
    // getDeptQueueExts_ docstring.
    const dqr = getDeptQueueExts_(dept, rosterSet, values);
    deptQueueExts = dqr.exts; deptQueueExtsSource = dqr.source;
    // Build the same normalized [priorFrom, to] window the Neon path
    // returns, so the aggregation loop below is identical for both sources.
    srcRows = [];
    for (let i = 0; i < values.length; i++) {
      const r = values[i], rd = displays[i];
      const dIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
      if (!dIso || dIso < priorFrom || dIso > to) continue;
      const ag = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
      if (!ag) continue;
      srcRows.push({
        dateIso:          dIso,
        agent:            ag,
        queueExt:         String(r[HISTORICAL_COLS.QUEUE_EXT - 1] || '').trim(),
        totalUnique:      Number(r[HISTORICAL_COLS.TOTAL_UNIQUE - 1])   || 0,
        totalRung:        Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0,
        totalMissed:      Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0,
        totalAnswered:    Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
        tttSec:           parseHmsDisplay_(rd[HISTORICAL_COLS.TTT - 1]),
        attSec:           parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]),
        avgAbdWaitSec:    parseHmsDisplay_(rd[HISTORICAL_COLS.AVG_ABD_WAIT - 1]),
        csrAvgAbdWaitSec: parseHmsDisplay_(rd[HISTORICAL_COLS.CSR_AVG_ABD_WAIT - 1]),
      });
    }
  }
  if (typeof logDqeReadTiming_ === 'function') logDqeReadTiming_('computeSummary_:' + dept, effectiveSource, _tRead, srcRows.length);

  const acc = {};
  let rowsMatched = 0;
  // For diagnostics: agents that matched only via queue extension
  // overlap (not on the dept roster). Empty when scope === 'roster'.
  const queueOnlyAgents = {};

  // Prior-window per-agent totals (E5). Only the 3 metrics we chip
  // on the table: rung / missed / answered. Sibling dictionary so
  // the existing acc[] loop stays untouched. Attached to each row
  // at finalize-time if the agent also has user-window data; agents
  // with prior-only activity are silently dropped (no card to attach
  // to). `priorRowsSeen` tracks whether the prior window had ANY
  // included rows for this agent so the client can distinguish
  // "no data" from "real zero".
  const priorAcc = {};

  for (let i = 0; i < srcRows.length; i++) {
    const row = srcRows[i];
    const dateIso = row.dateIso;
    if (!dateIso) continue;
    // Accept rows in either the user-selected window OR the prior
    // window (for E5 delta chips). srcRows is already windowed to
    // [priorFrom, to]; these flags split it.
    const inUser  = (dateIso >= from && dateIso <= to);
    const inPrior = (dateIso >= priorFrom && dateIso <= priorTo);
    if (!inUser && !inPrior) continue;

    const agent = row.agent;
    if (!agent) continue;
    // Skip queue-sentinel rows (used by MissedCallsReport for queue-only
    // abandoned calls). These have agent name = a queue identifier and
    // are not real agents -- shouldn't appear in the per-agent table or
    // in the diagnostics' roster/queue match counts.
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;

    const inRoster = !!rosterSet[agent];
    let inQueue = false;
    if (scope !== 'roster') {
      const rowExts = parseExtensions_(row.queueExt);
      for (let j = 0; j < rowExts.length; j++) {
        if (deptQueueExts[rowExts[j]]) { inQueue = true; break; }
      }
    }

    let include;
    if (scope === 'roster')      include = inRoster;
    else if (scope === 'queue')  include = inQueue;
    else /* both */              include = inRoster || inQueue;
    if (!include) continue;

    // Prior-window rows: accumulate the 3 chipped metrics to
    // priorAcc and skip the user-window code path. An agent with
    // only prior-window data won't appear in `acc` and gets
    // silently dropped at finalize time (correct behavior -- they
    // had no calls in the user-selected range so they shouldn't
    // render a row).
    if (inPrior) {
      let p = priorAcc[agent];
      if (!p) p = priorAcc[agent] = { rung: 0, missed: 0, answered: 0, rows: 0 };
      p.rung     += row.totalRung;
      p.missed   += row.totalMissed;
      p.answered += row.totalAnswered;
      p.rows++;
      continue;
    }

    if (!inRoster && inQueue) queueOnlyAgents[agent] = true;

    rowsMatched++;
    let a = acc[agent];
    if (!a) {
      a = {
        agent: agent,
        matchedViaRoster: inRoster,
        matchedViaQueue: inQueue,
        totalUnique: 0,
        totalRung: 0,
        totalMissed: 0,
        totalAnswered: 0,
        tttSeconds: 0,
        attSecondsSum: 0, attSecondsCount: 0,
        // Abandoned-wait columns are already-averaged per row; simple
        // mean across rows. True weighting would need raw abandoned-
        // call counts, which the historical sheet doesn't expose
        // separately.
        avgAbdWaitSecondsSum: 0, avgAbdWaitSecondsCount: 0,
        csrAvgAbdWaitSecondsSum: 0, csrAvgAbdWaitSecondsCount: 0,
        days: {},
      };
      acc[agent] = a;
    } else {
      // Promote flags if a later row matched via the other path too.
      if (inRoster) a.matchedViaRoster = true;
      if (inQueue)  a.matchedViaQueue  = true;
    }

    a.totalUnique   += row.totalUnique;
    a.totalRung     += row.totalRung;
    a.totalMissed   += row.totalMissed;
    a.totalAnswered += row.totalAnswered;
    a.tttSeconds    += row.tttSec;

    const att = row.attSec;
    if (att) { a.attSecondsSum += att; a.attSecondsCount++; }

    const aaw = row.avgAbdWaitSec;
    if (aaw) { a.avgAbdWaitSecondsSum += aaw; a.avgAbdWaitSecondsCount++; }

    const caw = row.csrAvgAbdWaitSec;
    if (caw) { a.csrAvgAbdWaitSecondsSum += caw; a.csrAvgAbdWaitSecondsCount++; }

    a.days[dateIso] = true;
  }

  // Build the agent -> [other-depts] lookup used to populate
  // sourceHomes on queue-only rows (so the My Department table's
  // Source chip can tell the manager which OTHER depts the floater
  // is actually rostered on -- multiple, comma-separated, if they're
  // multi-rostered). Computed lazily -- only if there's at least one
  // queue-only agent in the result -- to avoid scanning every dept's
  // roster on every cache miss.
  let deptsByAgent = null;
  const queueOnlyCount = Object.keys(queueOnlyAgents).length;
  if (queueOnlyCount > 0) {
    deptsByAgent = buildDeptsByAgent_();
  }

  // Finalize per-agent rows.
  const rows = [];
  for (const k in acc) {
    if (!Object.prototype.hasOwnProperty.call(acc, k)) continue;
    const a = acc[k];
    const queueOnly = a.matchedViaQueue && !a.matchedViaRoster;
    // sourceHomes is an array of every dept whose roster this agent
    // appears on. Empty array (rendered as bare "QUEUE") means the
    // floater is on no dept's roster -- they only handled calls via
    // shared-queue extensions. Non-queue-only rows don't carry the
    // field; the client only reads it for the QUEUE chip variant.
    const sourceHomes = queueOnly && deptsByAgent
      ? (deptsByAgent[a.agent] || []) : [];
    // Prior-period chip data (E5). priorHasData=true if the prior
    // window had ANY included rows for this agent (even if all
    // metrics were zero -- still a real "real zero" data point).
    // false means the prior window had NO included rows, which the
    // client renders as a dash instead of a delta. INV-28-parallel
    // window: same length as the selected range, ending one day
    // before `from`. priorFrom / priorTo are surfaced on meta below.
    const priorBucket = priorAcc[a.agent];
    const priorHasData = !!(priorBucket && priorBucket.rows > 0);
    rows.push({
      agent: a.agent,
      matchedViaRoster: a.matchedViaRoster,
      matchedViaQueue: a.matchedViaQueue,
      sourceHomes: sourceHomes,
      totalUnique: a.totalUnique,
      totalRung: a.totalRung,
      totalMissed: a.totalMissed,
      totalAnswered: a.totalAnswered,
      priorRung:     priorHasData ? priorBucket.rung     : 0,
      priorMissed:   priorHasData ? priorBucket.missed   : 0,
      priorAnswered: priorHasData ? priorBucket.answered : 0,
      priorHasData:  priorHasData,
      tttSeconds: a.tttSeconds,
      // ATT: simple mean of the source sheet's stored per-row ATT
      // values. For single-day ranges this matches the source row
      // exactly (which is what the existing DQE Report shows); for
      // multi-day, it's the simple mean across that agent's rows in
      // range. We intentionally do NOT compute weighted TTT/Answered
      // here: the source's stored ATT is sometimes derived from a
      // denominator other than Total Answered, so a weighted formula
      // would silently disagree with the source for those rows.
      attSeconds: a.attSecondsCount
        ? Math.round(a.attSecondsSum / a.attSecondsCount) : 0,
      avgAbdWaitSeconds: a.avgAbdWaitSecondsCount
        ? Math.round(a.avgAbdWaitSecondsSum / a.avgAbdWaitSecondsCount) : 0,
      csrAvgAbdWaitSeconds: a.csrAvgAbdWaitSecondsCount
        ? Math.round(a.csrAvgAbdWaitSecondsSum / a.csrAvgAbdWaitSecondsCount) : 0,
      daysActive: Object.keys(a.days).length,
    });
  }

  // Default initial sort: missed desc, agent asc tiebreak. The client
  // can re-sort via column clicks; this just gives a sensible first paint.
  rows.sort(function (x, y) {
    if (y.totalMissed !== x.totalMissed) return y.totalMissed - x.totalMissed;
    return x.agent.localeCompare(y.agent);
  });

  // Totals: sum the summables; simple-mean the per-row averages so
  // every "average" column in the totals row uses the same method
  // it uses in the agent rows.
  //
  // Phase D: the totals sum only over matchedViaRoster=true rows.
  // Queue-only floaters (matchedViaQueue && !matchedViaRoster) are
  // shown in the agent table for visibility but their numbers do
  // NOT factor into the dept's headline averages. Rationale: a
  // floater handling 3 calls/day for another dept shouldn't drag
  // a 30-agent dept's % Answered average. Source chip on each row
  // makes the inclusion/exclusion visible to managers.
  const rosterRows = rows.filter(function (r) { return r.matchedViaRoster; });
  const totals = { totalUnique:0, totalRung:0, totalMissed:0, totalAnswered:0, tttSeconds:0 };
  for (let i = 0; i < rosterRows.length; i++) {
    totals.totalUnique   += rosterRows[i].totalUnique;
    totals.totalRung     += rosterRows[i].totalRung;
    totals.totalMissed   += rosterRows[i].totalMissed;
    totals.totalAnswered += rosterRows[i].totalAnswered;
    totals.tttSeconds    += rosterRows[i].tttSeconds;
  }
  totals.attSeconds = avg_(rosterRows, 'attSeconds');
  totals.avgAbdWaitSeconds = avg_(rosterRows, 'avgAbdWaitSeconds');
  totals.csrAvgAbdWaitSeconds = avg_(rosterRows, 'csrAvgAbdWaitSeconds');
  totals.rosterAgentCount = rosterRows.length;
  totals.queueOnlyAgentCount = rows.length - rosterRows.length;

  // Diagnostics: roster agents with no data in this range; agents
  // matched only via queue extension overlap (not on roster).
  const agentsWithData = {};
  for (const k in acc) agentsWithData[k] = true;
  const rosterWithNoData = [];
  for (let i = 0; i < roster.names.length; i++) {
    if (!agentsWithData[roster.names[i]]) {
      rosterWithNoData.push(roster.names[i]);
    }
  }
  rosterWithNoData.sort();
  const queueOnlyMatched = Object.keys(queueOnlyAgents).sort();

  // Most-recent QCD snapshot for the dept (latest day across
  // mapped queues from DEPT_QCD_QUEUES). Used by the My Department
  // page's "Yesterday's QCD" section. Nullable when dept has no
  // QCD mapping OR no recent QCD rows; client renders nothing.
  const qcdSnapshot = computeDeptQcdSnapshot_(dept, ssTZ);

  return {
    meta: {
      department: dept,
      from: from,
      to: to,
      scope: scope,
      rowsScanned: lastRow - 1,
      rowsMatched: rowsMatched,
      rosterSize: roster.names.length,
      agentsWithData: rows.length,
      deptQueueExts: Object.keys(deptQueueExts).sort(),
      deptQueueExtsSource: deptQueueExtsSource,
      // E5: prior window the per-row delta chips compare against.
      // Drives chip tooltip ("Prior period: X – Y") on the client.
      priorFrom: priorFrom,
      priorTo:   priorTo,
      generatedAt: new Date().toISOString(),
    },
    rows: rows,
    totals: totals,
    qcd: qcdSnapshot,
    diagnostics: {
      rosterWithNoData: rosterWithNoData,
      queueOnlyMatched: queueOnlyMatched,
    },
  };
}

function emptySummary_(dept, from, to, scope, rosterSize, rowsScanned, deptQueueExts) {
  return {
    meta: {
      department: dept,
      from: from, to: to,
      scope: scope || 'roster',
      rowsScanned: rowsScanned || 0,
      rowsMatched: 0,
      rosterSize: rosterSize || 0,
      agentsWithData: 0,
      deptQueueExts: deptQueueExts || [],
      deptQueueExtsSource: 'derived',
      // E5 prior-window meta on the empty shape too -- keeps the
      // client tooltip rendering consistent on no-data days.
      priorFrom: (from && to) ? computePriorWindow_(from, to).from : null,
      priorTo:   (from && to) ? computePriorWindow_(from, to).to   : null,
      generatedAt: new Date().toISOString(),
    },
    rows: [],
    totals: {
      totalUnique: 0, totalRung: 0, totalMissed: 0, totalAnswered: 0,
      tttSeconds: 0, attSeconds: 0,
      avgAbdWaitSeconds: 0, csrAvgAbdWaitSeconds: 0,
    },
    qcd: null,
    diagnostics: {
      rosterWithNoData: [],
      queueOnlyMatched: [],
    },
  };
}

/**
 * Returns the most-recent QCD snapshot for the dept. The queue list
 * still includes sub-queue children (Sales sees PAP's queues), but the
 * data is kept SEPARATED per queue -- sub-queues can behave very
 * differently from their parent, so summing them hides the real state.
 * Shape:
 *   { date, perQueue: [{ queue, subDept|null, totalCalls, totalAnswered,
 *     abandoned, abandonedPct, abandonedPctStr, violations }, ...],
 *     totalCalls, totalAnswered, abandoned, abandonedPct,
 *     abandonedPctStr, violations }            // all-queues sum (the
 *                                              // client renders it as a
 *                                              // clearly-labeled total
 *                                              // row, never alone)
 * `subDept` names the child dept owning the queue (e.g. 'PAP') so the
 * client can tag sub-queue rows.
 *
 * Returns null when the dept isn't mapped OR no recent QCD rows exist;
 * client renders nothing.
 */
function computeDeptQcdSnapshot_(dept, ssTZ) {
  try {
    const queues = (typeof queuesForDept_ === 'function')
                   ? queuesForDept_(dept) : [];
    if (!queues.length) return null;
    const queueSet = {};
    queues.forEach(function (q) { queueSet[q] = true; });

    // queue -> owning child dept (for the sub-queue tag). A queue in
    // the rollup that isn't in the dept's OWN list belongs to a child.
    const ownSet = {};
    queuesForDept_(dept, { includeChildren: false }).forEach(function (q) { ownSet[q] = true; });
    const queueOwner = {};
    const parentMap = (typeof getOverviewParentMap_ === 'function') ? getOverviewParentMap_() : {};
    Object.keys(parentMap).forEach(function (child) {
      if (parentMap[child] !== dept) return;
      getDeptQcdQueues_(child).forEach(function (q) {
        if (!ownSet[q]) queueOwner[q] = child;
      });
    });

    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName('QCD Historical Data');
    if (!sheet) return null;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;
    const tz = ssTZ || ss.getSpreadsheetTimeZone();
    const values = sheet.getRange(2, 1, lastRow - 1, 12).getValues();

    let latestDate = '';
    let byQueue = {};   // queue -> { total, answered, abandoned, violations } on latestDate
    for (let i = 0; i < values.length; i++) {
      const r = values[i];
      const source = String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim();
      if (source !== 'Total Calls') continue;
      const queue = String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim();
      if (!queueSet[queue]) continue;
      const dateIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], tz);
      if (!dateIso) continue;

      if (dateIso > latestDate) {
        latestDate = dateIso;
        byQueue = {};
      }
      if (dateIso === latestDate) {
        const b = byQueue[queue] || (byQueue[queue] = { total: 0, answered: 0, abandoned: 0, violations: 0 });
        b.total      += Number(r[QCD_HISTORICAL_COLS.TOTAL_CALLS - 1])    || 0;
        b.answered   += Number(r[QCD_HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
        b.abandoned  += Number(r[QCD_HISTORICAL_COLS.ABANDONED   - 1])    || 0;
        b.violations += Number(r[QCD_HISTORICAL_COLS.VIOLATIONS  - 1])    || 0;
      }
    }
    if (!latestDate) return null;

    let total = 0, answered = 0, abandoned = 0, violations = 0;
    // Only queues with rows on the latest date render -- a mapped queue
    // with no traffic that day would just add a zero row of noise.
    const perQueue = queues.filter(function (q) { return !!byQueue[q]; })
      .map(function (q) {
        const b = byQueue[q];
        total += b.total; answered += b.answered;
        abandoned += b.abandoned; violations += b.violations;
        const pct = b.total > 0 ? (b.abandoned / b.total) * 100 : 0;
        return {
          queue:           q,
          subDept:         queueOwner[q] || null,
          totalCalls:      b.total,
          totalAnswered:   b.answered,
          abandoned:       b.abandoned,
          abandonedPct:    pct,
          abandonedPctStr: pct.toFixed(2) + '%',
          violations:      b.violations,
        };
      });
    const pct = total > 0 ? (abandoned / total) * 100 : 0;
    return {
      date:             latestDate,
      perQueue:         perQueue,
      totalCalls:       total,
      totalAnswered:    answered,
      abandoned:        abandoned,
      abandonedPct:     pct,
      abandonedPctStr:  pct.toFixed(2) + '%',
      violations:       violations,
    };
  } catch (e) {
    Logger.log('computeDeptQcdSnapshot_ failed: %s', e);
    return null;
  }
}

/**
 * Returns the full roster for a department: agent names + their
 * queue extensions, all parsed from the DO NOT EDIT! cells.
 *
 *   {
 *     names: ["Robin Choudhury", "Darrell Compton", ...],
 *     byAgent: { "Robin Choudhury": ["139"], ... },
 *     allExtensions: { "139": true, "165": true, ... },
 *   }
 *
 * Empty shape (all collections empty) if the dept column doesn't
 * exist or the sheet is missing.
 */
function getRosterForDepartment_(dept) {
  const empty = { names: [], byAgent: {}, allExtensions: {} };
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ROSTER);
  if (!sheet) return empty;

  const lastCol = sheet.getLastColumn();
  if (lastCol < ROSTER.DEPT_FIRST_COL) return empty;

  const headerRow = sheet
    .getRange(ROSTER.HEADER_ROW, ROSTER.DEPT_FIRST_COL,
              1, lastCol - ROSTER.DEPT_FIRST_COL + 1)
    .getValues()[0];

  let foundCol = -1;
  for (let i = 0; i < headerRow.length; i++) {
    const v = String(headerRow[i] || '').trim();
    if (!v) break; // first blank ends the dept block
    if (v === dept) { foundCol = ROSTER.DEPT_FIRST_COL + i; break; }
  }
  if (foundCol === -1) return empty;

  const lastRow = sheet.getLastRow();
  if (lastRow < ROSTER.DATA_START_ROW) return empty;

  const cells = sheet
    .getRange(ROSTER.DATA_START_ROW, foundCol,
              lastRow - ROSTER.DATA_START_ROW + 1, 1)
    .getValues();

  const names = [];
  const byAgent = {};
  const allExtensions = {};
  for (let i = 0; i < cells.length; i++) {
    const parsed = parseRosterCell_(cells[i][0]);
    if (!parsed) continue;
    names.push(parsed.name);
    byAgent[parsed.name] = parsed.extensions.slice();
    for (let j = 0; j < parsed.extensions.length; j++) {
      allExtensions[parsed.extensions[j]] = true;
    }
  }
  return { names: names, byAgent: byAgent, allExtensions: allExtensions };
}

/**
 * Backward-compat shim used by diagnostics. Returns just the agent
 * names for a department. Production code (computeSummary_) calls
 * getRosterForDepartment_ directly to get the extensions too.
 */
function getAgentsForDepartment_(dept) {
  return getRosterForDepartment_(dept).names;
}

/**
 * Builds an { agentName -> [deptName, deptName, ...] } map by
 * iterating every dept's roster in getAllDepartments_ order
 * (alphabetical) and collecting every dept each name appears on.
 * Used to populate `sourceHomes` on queue-only rows in
 * computeSummary_ so the Source chip can show "QUEUE · Sales,
 * Power" for a floater rostered on multiple depts -- rather than
 * forcing a tie-breaker that hides the true picture.
 *
 * Agents not on any roster get no entry (the client renders just
 * "QUEUE" with no suffix in that case).
 *
 * Hidden depts (OVERVIEW_HIDDEN_DEPTS) are still scanned -- they're
 * hidden from the Overview only, not from the source-homes lookup,
 * so a CSR Backup floater appearing in CSR's table can still be
 * tagged with "QUEUE · CSR Backup".
 *
 * Dept order within each agent's list mirrors getAllDepartments_'s
 * order (alphabetical), so the rendered chip reads in a stable,
 * predictable sequence.
 */
function buildDeptsByAgent_() {
  const out = {};
  getAllDepartments_().forEach(function (dept) {
    const roster = getRosterForDepartment_(dept);
    for (let i = 0; i < roster.names.length; i++) {
      const name = roster.names[i];
      if (!out[name]) out[name] = [];
      out[name].push(dept);
    }
  });
  return out;
}

/**
 * Parses a DO NOT EDIT! roster cell into { name, extensions }.
 *
 * Cell shapes:
 *   "Dalia Nared"               -> { name: "Dalia Nared",      extensions: [] }
 *   "Robin Choudhury, 139"      -> { name: "Robin Choudhury",  extensions: ["139"] }
 *   "Robin Choudhury, 139, 165" -> { name: "Robin Choudhury",  extensions: ["139","165"] }
 *
 * The first comma-separated token is the agent name. Subsequent
 * tokens are kept as extensions only if they're digit-only -- guards
 * against odd cells like "Smith, Jr., 139" where "Jr." isn't an ext.
 * Returns null for blank cells.
 */
function parseRosterCell_(cellValue) {
  const raw = String(cellValue == null ? '' : cellValue).trim();
  if (!raw) return null;
  const parts = raw.split(',');
  const name = (parts[0] || '').trim();
  if (!name) return null;
  const extensions = [];
  for (let i = 1; i < parts.length; i++) {
    const ext = parts[i].trim();
    if (/^\d+$/.test(ext)) extensions.push(ext);
  }
  return { name: name, extensions: extensions };
}

/**
 * Resolves the set of queue extensions that belong to this dept, used
 * for queue-scope matching (Data.gs) and sentinel-row matching
 * (MissedCallsReport.gs). Two sources, in priority order:
 *
 *   1. Effective queue-ext override (Dept Config sheet over the
 *      DEPT_QUEUE_EXT_OVERRIDES constant, via
 *      getDeptQueueExtsOverride_) -- explicit list. Use when this
 *      dept's agents ring on queues that belong to OTHER depts (e.g.
 *      CSR agents covering A_Q_Spanish) and those queues should NOT
 *      count toward this dept.
 *   2. Derived: scan `values` (the bulk DQE Historical Data read) and
 *      collect col D extensions from any row whose agent is on this
 *      dept's roster. Across ALL history loaded into `values`, not
 *      just the report's date range -- so a queue with no rings in
 *      the current window is still recognized.
 *
 * Returns { exts: { ext: true, ... }, source: 'override'|'derived' }.
 *
 * Why this exists at all: roster cells in DO NOT EDIT! parse out as
 * PERSONAL extensions (each agent's direct line), while col D in
 * historical data is the SHARED-QUEUE extension. The two domains never
 * overlap, so matching agent-row col D against roster.allExtensions
 * always fails. deptQueueExts gives us the right comparison set.
 */
function getDeptQueueExts_(dept, rosterSet, values) {
  const set = {};
  // Effective override list (Dept Config sheet over the
  // DEPT_QUEUE_EXT_OVERRIDES constant; see DeptConfig.gs). Non-empty
  // REPLACES the data-derived set below.
  const overrideList = getDeptQueueExtsOverride_(dept);
  if (overrideList && overrideList.length) {
    for (let i = 0; i < overrideList.length; i++) {
      set[String(overrideList[i])] = true;
    }
    return { exts: set, source: 'override' };
  }
  for (let i = 0; i < values.length; i++) {
    const agent = String(values[i][HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent || !rosterSet[agent]) continue;
    const exts = parseExtensions_(values[i][HISTORICAL_COLS.QUEUE_EXT - 1]);
    for (let j = 0; j < exts.length; j++) set[exts[j]] = true;
  }
  return { exts: set, source: 'derived' };
}

/**
 * Neon equivalent of getDeptQueueExts_'s derived path: builds the dept's
 * queue-ext set from the distinct (agent, queue_extensions) pairs in
 * dqe_history (neonGetAgentExtPairs_) instead of scanning the whole sheet.
 * The override path is identical to getDeptQueueExts_. Returns null when
 * Neon pairs are unavailable (no conn / error) so the caller can fall back
 * to the sheet read.
 */
function getDeptQueueExtsNeon_(dept, rosterSet) {
  const overrideList = getDeptQueueExtsOverride_(dept);
  if (overrideList && overrideList.length) {
    const oset = {};
    for (let i = 0; i < overrideList.length; i++) oset[String(overrideList[i])] = true;
    return { exts: oset, source: 'override' };
  }
  if (typeof neonGetAgentExtPairs_ !== 'function') return null;
  const pairs = neonGetAgentExtPairs_();
  if (pairs === null) return null;   // no conn / error -> caller falls back
  const set = {};
  for (let k = 0; k < pairs.length; k++) {
    const agent = String(pairs[k].agent_name || '').trim();
    if (!agent || !rosterSet[agent]) continue;
    const exts = parseExtensions_(pairs[k].queue_extensions);
    for (let j = 0; j < exts.length; j++) set[exts[j]] = true;
  }
  return { exts: set, source: 'derived-neon' };
}

/**
 * Dept queue-ext set for the Neon read path, with a sheet fallback.
 * Prefers the Neon SELECT DISTINCT (getDeptQueueExtsNeon_); if Neon pairs
 * are unavailable, reads the cheap cols-A..D slice off the sheet and uses
 * the original derivation. Used by the cutover readers' Neon branch so
 * the all-history ext derivation no longer requires a whole-sheet scan.
 */
function deptQueueExtsForNeonReader_(dept, rosterSet, sheet, lastRow) {
  const ne = getDeptQueueExtsNeon_(dept, rosterSet);
  if (ne) return ne;
  const extValues = sheet.getRange(2, 1, lastRow - 1, HISTORICAL_COLS.QUEUE_EXT).getValues();
  return getDeptQueueExts_(dept, rosterSet, extValues);
}

/**
 * Parses a comma-separated extension list from Col D of historical
 * data (e.g. "108,165"). Returns digit-only tokens, trimmed.
 */
function parseExtensions_(cellValue) {
  const raw = String(cellValue == null ? '' : cellValue).trim();
  if (!raw) return [];
  const parts = raw.split(',');
  const exts = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (/^\d+$/.test(t)) exts.push(t);
  }
  return exts;
}

/**
 * Normalizes a date cell into YYYY-MM-DD. Accepts Date objects (the
 * common case when the cell is formatted as date), MM/DD/YYYY strings,
 * MM/DD/YY strings (2-digit year, pivoted at 70: 00-69 -> 2000s,
 * 70-99 -> 1900s), YYYY-MM-DD strings, and Sheets serial-date numbers
 * (days since 1899-12-30). Anything else returns '' and the row is
 * filtered out.
 *
 * tz is the spreadsheet's timezone, used to interpret Date objects
 * returned by getValue() for date-formatted cells. Pass it explicitly
 * (computeSummary_ does) so the spreadsheet TZ is honored even if it
 * differs from the script's TZ -- same root cause as the duration
 * column issue. Falls back to the script's TZ if omitted.
 */
function rowDateIso_(v, tz) {
  const useTz = tz || TZ;
  if (v instanceof Date) {
    return Utilities.formatDate(v, useTz, 'yyyy-MM-dd');
  }
  // Sheets serial date: e.g. 45726 = 2025-03-09. Plausible date range
  // (~1982 to ~2100) keeps us from misinterpreting small ints.
  if (typeof v === 'number' && v > 30000 && v < 100000) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, useTz, 'yyyy-MM-dd');
    }
    return '';
  }
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  // MM/DD/YYYY or M/D/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + pad2_(Number(m[1])) + '-' + pad2_(Number(m[2]));
  // MM/DD/YY or M/D/YY -- pivot 00-69 to 2000s, 70-99 to 1900s.
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const yy = Number(m[3]);
    const yyyy = yy < 70 ? 2000 + yy : 1900 + yy;
    return yyyy + '-' + pad2_(Number(m[1])) + '-' + pad2_(Number(m[2]));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}

function pad2_(n) { return n < 10 ? ('0' + n) : String(n); }

/**
 * Display-string -> seconds. Parses the formatted text shown in a
 * duration cell, e.g. "6:04:50" or "0:23:17" or "45" (raw seconds).
 * Preferred over toSeconds_ for duration cells because it bypasses
 * the spreadsheet-vs-script timezone issue described in
 * computeSummary_.
 */
function parseHmsDisplay_(s) {
  if (s == null || s === '') return 0;
  const str = String(s).trim();
  if (!str) return 0;
  if (str.indexOf(':') === -1) {
    return Number(str) || 0;
  }
  const parts = str.split(':');
  const nums = [];
  for (let i = 0; i < parts.length; i++) nums.push(Number(parts[i]) || 0);
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return 0;
}

/**
 * Cell value -> seconds. Accepts:
 *   - Number (Sheets duration, fraction of a day)
 *   - Date (time-of-day; happens when cell is formatted as time)
 *   - String "H:MM:SS" or "M:SS"
 *   - Anything else -> 0
 *
 * Kept for diagnostics. Production summary code uses parseHmsDisplay_
 * on the display strings instead -- see computeSummary_.
 */
function toSeconds_(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Math.round(v * 86400);
  if (v instanceof Date) {
    return v.getHours() * 3600 + v.getMinutes() * 60 + v.getSeconds();
  }
  const s = String(v).trim();
  if (!s) return 0;
  if (s.indexOf(':') !== -1) {
    const parts = s.split(':');
    const nums = [];
    for (let i = 0; i < parts.length; i++) nums.push(Number(parts[i]) || 0);
    if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
    if (nums.length === 2) return nums[0] * 60 + nums[1];
  }
  return Number(s) || 0;
}

function avg_(arr, key) {
  if (!arr.length) return 0;
  let s = 0, n = 0;
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i][key];
    if (raw == null) continue;
    const v = Number(raw) || 0;
    s += v; n++;
  }
  return n ? Math.round(s / n) : 0;
}

/**
 * THE shared INV-28 prior-window implementation: same duration as
 * [from, to], ending one day before `from`. Parsed at noon UTC to
 * dodge DST edges, then re-formatted as `YYYY-MM-DD` for the
 * caller's date-string comparisons.
 *
 * Consumers: computeSummary_ (E5 per-row delta chips),
 * computePerformanceReport_ (auto prior), and computeInsights_
 * (auto prior). Any future "compare against the preceding window"
 * feature should call this rather than re-deriving the math --
 * the three call sites used to carry three near-identical copies.
 */
function computePriorWindow_(from, to) {
  const fParts = from.split('-');
  const tParts = to.split('-');
  const fMs = Date.UTC(Number(fParts[0]), Number(fParts[1]) - 1, Number(fParts[2]), 12);
  const tMs = Date.UTC(Number(tParts[0]), Number(tParts[1]) - 1, Number(tParts[2]), 12);
  const dayMs = 24 * 3600 * 1000;
  const durationDays = Math.round((tMs - fMs) / dayMs) + 1;  // inclusive
  const priorToMs   = fMs - dayMs;
  const priorFromMs = priorToMs - (durationDays - 1) * dayMs;
  const fmt = function (ms) {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  };
  return { from: fmt(priorFromMs), to: fmt(priorToMs) };
}

/**
 * Stable, length-bounded hash of an agent selection for use in
 * CacheService keys. Apps Script's CacheService rejects keys
 * longer than 250 characters; agent names + a long roster blow
 * past that quickly (Sales alone has enough agents to overflow).
 * MD5 hex is 32 chars regardless of input size, which keeps the
 * compound cache key (dept + dates + agentsKey) safely bounded.
 *
 * Order-insensitive: input is sorted before hashing so cache
 * lookups hit regardless of selection order in the client.
 */
function hashAgents_(agents) {
  const joined = (agents || []).slice().sort().join('|');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, joined);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (v < 16 ? '0' : '') + v.toString(16);
  }
  return hex;
}
