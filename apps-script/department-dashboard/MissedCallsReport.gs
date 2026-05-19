/**
 * Missed Calls Report - server-side data.
 *
 * Migration of MissedCallsReport.js from the legacy DQE Report Apps Script
 * project. Reads the 19 missed-call time-slot columns (K-AC) and the
 * abandoned-missed-times column (AF) from DQE Historical Data, filtering
 * by the same date + scope rules as the main dashboard.
 *
 * Public entry (callable via google.script.run):
 *   getMissedCallsReport({ department, from, to, scope })
 *
 * Returns:
 *   {
 *     meta: { department, from, to, scope, rosterSize, rowsMatched,
 *             agentCount, totalMissed, generatedAt, cacheHit, computeMs },
 *     agents: [{ name, missedTimes: [{ date, time, label, abandoned }], total }],
 *     chart:  { labels: [..18], counts: [..18] }
 *   }
 *
 * Cached 5 min per (dept, from, to, scope) tuple. Best-effort -- large
 * ranges may exceed CacheService's per-value 100KB limit; if put fails
 * we log and continue.
 *
 * Notes on data shape:
 *   - K-AC columns store comma-separated CST H:MM:SS timestamps already
 *     converted from PST by the source pipeline (buildDQEHistoricalData
 *     .gs). No further timezone math here. (INV-20)
 *   - AF stores the same H:MM:SS strings for the subset of timestamps
 *     that were part of an abandoned call. Cross-referencing K-AC
 *     entries against AF yields the "abandoned" boolean per timestamp.
 *   - Chart range is 8 AM - 5 PM CST (INV-18). The work window itself
 *     is 8:30 AM - 5 PM CST; chart starts earlier so early-morning
 *     rings aren't silently dropped.
 */

const MISSED_CHART_START_HOUR = 8;    // 8:00 AM CST
const MISSED_CHART_END_HOUR   = 17;   // 5:00 PM CST (exclusive)
const MISSED_BUCKET_MINUTES   = 30;   // 30-min buckets -> 18 total

const HISTORICAL_TIME_SLOTS_START = 11;  // K
const HISTORICAL_TIME_SLOTS_END   = 29;  // AC
const HISTORICAL_ABANDONED_PARENT_IDS    = 30;  // AD
const HISTORICAL_ABANDONED_MISSED_TIMES  = 32;  // AF

function getMissedCallsReport(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') {
    throw new Error('Not authorized.');
  }

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

  let scope = String((req && req.scope) || 'roster').trim();
  if (scope !== 'roster' && scope !== 'queue' && scope !== 'both') {
    scope = 'roster';
  }

  const cache = CacheService.getScriptCache();
  // v10: per-entry parentId attached to each abandoned timestamp;
  // queue-only entries gain alsoIn[] for cross-queue overflow; new
  // queueOnlyUniqueCount/EventCount in meta.
  const cacheKey = 'missed:v10:' + dept + ':' + scope + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeMissedCallsReport_(dept, from, to, scope);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  try {
    cache.put(cacheKey, JSON.stringify(data), CACHE_TTL_SECONDS);
  } catch (e) {
    // Large ranges may exceed cache value size; harmless.
    Logger.log('MissedCallsReport cache put failed: %s', e);
  }

  return data;
}

function computeMissedCallsReport_(dept, from, to, scope) {
  const roster = getRosterForDepartment_(dept);
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) {
    throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptyMissedReport_(dept, from, to, scope, roster.names.length);
  }

  const ssTZ = ss.getSpreadsheetTimeZone();

  // Read cols 1..AH. Need date (col 2) and agent (col 3) for filtering,
  // K-AC for missed times, AF for abandoned cross-reference.
  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  const range = sheet.getRange(2, 1, lastRow - 1, numCols);
  const values = range.getValues();
  const displays = range.getDisplayValues();

  // Shared with Data.gs queue-scope matching: override if set, else
  // derived from this dept's roster agents' col D values.
  const deptQueueExts = getDeptQueueExts_(dept, rosterSet, values).exts;

  // Chart buckets: 8 AM-5 PM CST in 30-min slots = 18 buckets
  const totalBuckets = (MISSED_CHART_END_HOUR - MISSED_CHART_START_HOUR)
                       * (60 / MISSED_BUCKET_MINUTES);
  const chartCounts = new Array(totalBuckets).fill(0);
  const startMin = MISSED_CHART_START_HOUR * 60;
  const endMin   = MISSED_CHART_END_HOUR   * 60;

  // Per-agent aggregator (real agent rings)
  const agentMap = {};   // agent -> { missedTimes: [], total: 0 }
  // Per-queue aggregator (sentinel rows = queue-only abandoned events)
  const queueOnlyMap = {}; // queueName -> { entries: [], total: 0, parentIds: {} }
  let rowsMatched = 0;
  let totalMissed = 0;
  let abandonedRings = 0;            // per-ring count (one per red timestamp)
  const uniqueAbandonedParents = {}; // ALL abandoned parents (col AD across all rows)
  const uniqueNoRingParents = {};    // subset: those that came from sentinel rows

  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];

    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < from || dateIso > to) continue;

    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;

    // Sentinel rows carry queue-only abandoned events (no agent rang).
    // Their "agent name" is the queue identifier itself. These don't go
    // through roster matching -- they're intrinsically queue-level data.
    const isSentinel = /^A_Q_/.test(agent) || agent === 'Backup CSR';

    // Both sentinel and agent rows match against deptQueueExts -- col D
    // is the shared-queue extension in either case. (Previously agent
    // rows tested against deptExtensions, but that's the
    // personal-extension set and never overlaps.)
    let inQueue = false;
    if (isSentinel || scope !== 'roster') {
      const rowExts = parseExtensions_(r[HISTORICAL_COLS.QUEUE_EXT - 1]);
      for (let j = 0; j < rowExts.length; j++) {
        if (deptQueueExts[rowExts[j]]) { inQueue = true; break; }
      }
    }
    const inRoster = !isSentinel && !!rosterSet[agent];

    let include;
    if (isSentinel) {
      // Queue-only entries are always included when their queue
      // serves this dept, regardless of the user's scope toggle.
      // Roster matching doesn't apply (no agent).
      include = inQueue;
    } else if (scope === 'roster')     { include = inRoster; }
    else if (scope === 'queue')        { include = inQueue; }
    else                               { include = inRoster || inQueue; }
    if (!include) continue;

    rowsMatched++;

    // Collect all missed-call timestamps from K-AC (19 columns).
    // We keep both the raw display label (for rendering) and a
    // normalized 24-hour key (for matching against AF).
    const slotTimes = [];  // [{ label, key }]
    for (let c = HISTORICAL_TIME_SLOTS_START; c <= HISTORICAL_TIME_SLOTS_END; c++) {
      const cell = String(rd[c - 1] || '').trim();
      if (!cell) continue;
      cell.split(',').forEach(function (t) {
        const trimmed = t.trim();
        if (!trimmed) return;
        slotTimes.push({ label: trimmed, key: normTimeKey_(trimmed) });
      });
    }

    if (slotTimes.length === 0) continue;

    // Build the set of abandoned-missed timestamps (col AF). Normalize
    // the same way as slot times so AM/PM differences or 24-vs-12 hour
    // formatting in either column don't break the cross-reference.
    //
    // Also build a positional pairing of AF timestamps -> AD parent
    // IDs. The two columns are populated in lockstep by the source
    // pipeline: AF[i] is the timestamp of the i-th abandoned event in
    // this row, AD[i] is its parent call ID. Pairing them gives us a
    // {timeKey -> parentId} map so each red 🚨 timestamp can carry
    // its own parent ID through to the client.
    const abandonedStr = String(rd[HISTORICAL_ABANDONED_MISSED_TIMES - 1] || '').trim();
    const abandonedKeys = {};
    const abandonedTimeToParent = {};  // timeKey -> parentId
    let abandonedTimeList = [];
    if (abandonedStr) {
      abandonedStr.split(',').forEach(function (t) {
        const k = normTimeKey_(t.trim());
        if (k) abandonedKeys[k] = true;
        abandonedTimeList.push(k);
      });
    }
    const abandonedIdsCell = String(rd[HISTORICAL_ABANDONED_PARENT_IDS - 1] || '').trim();
    const abandonedIdList = abandonedIdsCell
      ? abandonedIdsCell.split(',').map(function (s) { return s.trim(); })
                        .filter(function (s) { return !!s; })
      : [];
    // Pair positionally. Mismatched lengths shouldn't happen given the
    // source-pipeline invariant, but pair only up to the shorter list
    // so a malformed row doesn't throw -- it just shows missing IDs.
    const pairLen = Math.min(abandonedTimeList.length, abandonedIdList.length);
    for (let p = 0; p < pairLen; p++) {
      if (abandonedTimeList[p]) abandonedTimeToParent[abandonedTimeList[p]] = abandonedIdList[p];
    }

    // Col AD ("Abandoned Parent Call IDs") feeds dept-wide unique-
    // abandoned-call counts. Sentinel rows additionally feed
    // uniqueNoRingParents for the "No-ring abandons: K" breakdown.
    abandonedIdList.forEach(function (id) {
      uniqueAbandonedParents[id] = true;
      if (isSentinel) uniqueNoRingParents[id] = true;
    });

    // Pick the accumulator + push function based on row type.
    let target;
    if (isSentinel) {
      if (!queueOnlyMap[agent]) {
        queueOnlyMap[agent] = { entries: [], total: 0 };
      }
      target = queueOnlyMap[agent];
    } else {
      if (!agentMap[agent]) {
        agentMap[agent] = { missedTimes: [], total: 0 };
      }
      target = agentMap[agent];
    }

    slotTimes.forEach(function (item) {
      const isAbandoned = !!abandonedKeys[item.key];
      if (isAbandoned) abandonedRings++;

      // Compute bucket index once; -1 means "outside the 8 AM-5 PM
      // chart range". The client uses this on chart-bar clicks to
      // pull up just the rings that contributed to a given bucket.
      // Queue-only entries also feed the chart per the user's design
      // (every missed event at a real time counts toward the
      // hour-of-day distribution).
      const minutes = parseHmsKeyToMinutes_(item.key);
      let bucketIdx = -1;
      if (minutes >= startMin && minutes < endMin) {
        const candidate = Math.floor((minutes - startMin) / MISSED_BUCKET_MINUTES);
        if (candidate >= 0 && candidate < totalBuckets) {
          bucketIdx = candidate;
          chartCounts[candidate]++;
        }
      }

      const entry = {
        date: dateIso,
        time: item.label,
        // Use the normalized 24h key as the formatter input so AM/PM
        // is computed from the hour value, not from any AM/PM suffix
        // that may already be present in the raw cell display.
        label: formatHmsToAmPm_(item.key),
        abandoned: isAbandoned,
        // Parent call ID for abandoned entries -- null otherwise.
        // Sourced from AF<->AD positional pairing within this row.
        parentId: isAbandoned ? (abandonedTimeToParent[item.key] || null) : null,
        // Numeric sort key (seconds past midnight) so chronological
        // sort works across 9 vs 10 hours.
        sortKey: hmsKeyToSeconds_(item.key),
        // Chart bucket this ring contributes to (-1 if out of range).
        bucket: bucketIdx,
      };

      if (isSentinel) {
        target.entries.push(entry);
      } else {
        target.missedTimes.push(entry);
        // totalMissed counts agent rings only -- queue-only abandoned
        // calls aren't "missed rings" because no agent was rung.
        totalMissed++;
      }
      target.total++;
    });
  }

  // Sort each agent's missedTimes by date then time, for stable display
  const agents = Object.keys(agentMap)
    .sort()
    .map(function (name) {
      const list = agentMap[name].missedTimes.slice();
      list.sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.sortKey - b.sortKey;
      });
      return {
        name: name,
        missedTimes: list,
        total: agentMap[name].total,
      };
    });

  // Cross-queue overlap: a single abandoned call that progressed
  // through multiple queues (e.g. A_Q_CSR -> Backup CSR overflow)
  // shows up under each queue's sentinel row. Building a global
  // parentId -> Set<queueName> map lets us:
  //   1. Tag each entry with "[also rang X, Y]" so the relationship
  //      is visible to the user.
  //   2. Report a unique-parents count alongside the per-queue total
  //      ("8 unique calls across 3 queues (10 ring events)").
  const parentToQueues = {};   // parentId -> { qname: true, ... }
  Object.keys(queueOnlyMap).forEach(function (qname) {
    queueOnlyMap[qname].entries.forEach(function (e) {
      if (!e.parentId) return;
      if (!parentToQueues[e.parentId]) parentToQueues[e.parentId] = {};
      parentToQueues[e.parentId][qname] = true;
    });
  });

  // Build queue-only sections (one per queue with no-ring entries),
  // sorted by queue name; entries within each sorted by date + time.
  // Per-entry `alsoIn`: queues OTHER than this one where the same
  // parent ID also appears. Empty when the call only hit one queue.
  const queueOnly = Object.keys(queueOnlyMap)
    .sort()
    .map(function (queueName) {
      const list = queueOnlyMap[queueName].entries.slice().map(function (e) {
        const others = [];
        if (e.parentId && parentToQueues[e.parentId]) {
          Object.keys(parentToQueues[e.parentId]).forEach(function (q) {
            if (q !== queueName) others.push(q);
          });
          others.sort();
        }
        return {
          date: e.date, time: e.time, label: e.label,
          abandoned: e.abandoned, parentId: e.parentId,
          sortKey: e.sortKey, bucket: e.bucket,
          alsoIn: others,
        };
      });
      list.sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.sortKey - b.sortKey;
      });
      return {
        queue: queueName,
        entries: list,
        total: queueOnlyMap[queueName].total,
      };
    });

  // Unique queue-only abandoned calls across all queues (parent IDs).
  // Total ring events = sum of per-queue totals (10 in the sample).
  const queueOnlyUniqueCount = Object.keys(parentToQueues).length;
  const queueOnlyEventCount = queueOnly.reduce(
    function (s, q) { return s + q.total; }, 0);

  // Chart labels
  const chartLabels = [];
  for (let i = 0; i < totalBuckets; i++) {
    chartLabels.push(formatMinutesAmPm_(startMin + i * MISSED_BUCKET_MINUTES));
  }

  return {
    meta: {
      department: dept,
      from: from, to: to,
      scope: scope,
      rosterSize: roster.names.length,
      rowsMatched: rowsMatched,
      agentCount: agents.length,
      totalMissed: totalMissed,
      // ALL abandoned calls in scope (both rang-an-agent and queue-
      // only). One abandoned parent counts as 1 regardless of how
      // many agents rang or whether any did.
      abandonedCallCount: Object.keys(uniqueAbandonedParents).length,
      // Subset: abandoned calls that NEVER rang an agent. Surfaced
      // separately in the summary line when > 0.
      noRingAbandonCount: Object.keys(uniqueNoRingParents).length,
      // Per-ring count for diagnostics (one increment per red
      // timestamp; agent rings only). Same as the number of red
      // rows in the agent grid.
      abandonedRings: abandonedRings,
      // Queue-only headline counts. queueOnlyUniqueCount dedupes by
      // parent ID across queues (overflow calls); queueOnlyEventCount
      // is the raw sum of per-queue entries (still useful to surface
      // the overflow signal in the headline).
      queueOnlyUniqueCount: queueOnlyUniqueCount,
      queueOnlyEventCount: queueOnlyEventCount,
      generatedAt: new Date().toISOString(),
    },
    agents: agents,
    queueOnly: queueOnly,
    chart: {
      labels: chartLabels,
      counts: chartCounts,
    },
  };
}

function emptyMissedReport_(dept, from, to, scope, rosterSize) {
  return {
    meta: {
      department: dept,
      from: from, to: to,
      scope: scope,
      rosterSize: rosterSize || 0,
      rowsMatched: 0,
      agentCount: 0,
      totalMissed: 0,
      abandonedCallCount: 0,
      noRingAbandonCount: 0,
      abandonedRings: 0,
      queueOnlyUniqueCount: 0,
      queueOnlyEventCount: 0,
      generatedAt: new Date().toISOString(),
    },
    agents: [],
    queueOnly: [],
    chart: { labels: [], counts: [] },
  };
}

/**
 * Normalizes a time string to a canonical 24-hour "H:MM:SS" key for
 * cross-column matching. Handles:
 *   - 24-hour "21:15:23"     -> "21:15:23"
 *   - 12-hour "9:15:23 PM"   -> "21:15:23"
 *   - 12-hour "9:15:23 AM"   -> "9:15:23"
 *   - "12:30:00 AM"          -> "0:30:00"
 *   - "12:30:00 PM"          -> "12:30:00"
 *   - Hour-padding "09:15:23" -> "9:15:23"
 *   - Missing seconds "9:15"  -> "9:15:00"
 *
 * Returns '' if unparseable.
 */
function normTimeKey_(s) {
  if (s == null || s === '') return '';
  let str = String(s).trim().toUpperCase();
  const isPM = /\bPM\b/.test(str);
  const isAM = /\bAM\b/.test(str);
  str = str.replace(/\s*(AM|PM)\s*/, '').trim();

  const parts = str.split(':');
  if (parts.length < 2) return '';
  let h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  const sec = parts.length >= 3 ? (parseInt(parts[2]) || 0) : 0;

  if (isPM && h < 12) h += 12;
  else if (isAM && h === 12) h = 0;

  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return h + ':' + pad(m) + ':' + pad(sec);
}

/**
 * Normalized "H:MM:SS" key -> minutes past midnight.
 */
function parseHmsKeyToMinutes_(key) {
  if (!key) return -1;
  const parts = key.split(':');
  if (parts.length < 2) return -1;
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  return h * 60 + m;
}

/**
 * Normalized "H:MM:SS" key -> total seconds past midnight (used as a
 * numeric chronological sort key).
 */
function hmsKeyToSeconds_(key) {
  if (!key) return 0;
  const parts = key.split(':');
  if (parts.length < 2) return 0;
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  const s = parts.length >= 3 ? (parseInt(parts[2]) || 0) : 0;
  return h * 3600 + m * 60 + s;
}

/**
 * "9:15:23" (24-hour) -> "9:15:23 AM". Preserves seconds for parity with
 * the legacy missed-timestamp display.
 */
function formatHmsToAmPm_(timeStr) {
  if (!timeStr) return '';
  const parts = String(timeStr).trim().split(':');
  if (parts.length < 2) return timeStr;
  let h = parseInt(parts[0]) || 0;
  const m = String(parts[1] || '00').padStart(2, '0');
  const s = String(parts[2] || '00').padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m + ':' + s + ' ' + ampm;
}

/**
 * Total-minutes-past-midnight -> "H:MM AM/PM" label (no seconds, used
 * for chart bucket labels).
 */
function formatMinutesAmPm_(totalMinutes) {
  let h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + (m < 10 ? '0' + m : m) + ' ' + ampm;
}
