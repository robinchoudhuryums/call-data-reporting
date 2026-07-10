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
 * Cached 30 min (REPORT_CACHE_TTL_SECONDS) per (dept, from, to, scope) tuple. Best-effort -- large
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

const HISTORICAL_TIME_SLOTS_START = HISTORICAL_COLS.TIME_SLOTS_START;
const HISTORICAL_TIME_SLOTS_END   = HISTORICAL_COLS.TIME_SLOTS_END;
const HISTORICAL_ABANDONED_PARENT_IDS    = HISTORICAL_COLS.ABANDONED_PARENT_IDS;
const HISTORICAL_ABANDONED_MISSED_TIMES  = HISTORICAL_COLS.ABANDONED_MISSED_TIMES;

function getMissedCallsReport(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') {
    throw new Error('Not authorized.');
  }

  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  assertDeptAccess_(user, dept);

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) {
    throw new Error('from/to must be YYYY-MM-DD.');
  }
  if (from > to) throw new Error('from must be on or before to.');

  // Scope: 'roster' so the per-agent missed-calls TIMELINES list
  // exactly the dept's roster agents -- matching the My Department
  // "Agent Call Metrics" table, which Phase 14 #4 made roster-only
  // (getDepartmentSummary scope='roster'). Cross-dept floaters who
  // never genuinely take the dept's calls were showing up as
  // false-positive missed-call cards otherwise. The QUEUE-ONLY
  // abandoned section is UNAFFECTED: queue-sentinel rows are
  // always included (computeMissedCallsReport_ keys them on
  // inQueue regardless of scope, INV-23), so genuinely-abandoned
  // queue calls with no agent ring still surface. The internal
  // scope plumbing below honors this value directly.
  const scope = 'roster';

  const cache = CacheService.getScriptCache();
  // v14 (RPT-1/RPT-2): AD/AF processed BEFORE the zero-slot early-continue
  // (slot-less abandoned parents count + lost-detail flag fires), and the
  // AF<->AD pairing is a per-time-key FIFO so duplicate seconds keep
  // distinct parent ids. See INV-30 for the full version history.
  const cacheKey = 'missed:v14:' + dept + ':' + scope + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      logReportUsage_('missed', dept, user, true);
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeMissedCallsReport_(dept, from, to, scope);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  const json = JSON.stringify(data);
  if (json.length <= 100000) {
    try { cache.put(cacheKey, json, REPORT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('MissedCallsReport cache put failed: %s', e); }
  } else {
    Logger.log('MissedCallsReport: payload %s bytes exceeds 100KB, skipping cache', json.length);
  }

  logReportUsage_('missed', dept, user, false);
  return data;
}

/**
 * Adapts normalized DAL rows (neonFetchDqeRows_ with includeMissedDetail)
 * into the { values, displays } grid shape the sheet read produces, so
 * computeMissedCallsReport_'s row loop is source-agnostic. Only the
 * columns the loop actually reads are populated: DATE / AGENT /
 * QUEUE_EXT (values) and the K..AC slots + AD parent-ids + AF
 * missed-times (displays). DAL rows are already date-windowed; the
 * loop's own range filter then passes everything through (rowDateIso_
 * passes ISO strings unchanged).
 */
function missedGridsFromDal_(dalRows) {
  const width = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  const values = [], displays = [];
  for (let i = 0; i < dalRows.length; i++) {
    const row = dalRows[i];
    const v = new Array(width).fill('');
    const d = new Array(width).fill('');
    v[HISTORICAL_COLS.DATE - 1]      = row.dateIso;
    v[HISTORICAL_COLS.AGENT - 1]     = row.agent;
    v[HISTORICAL_COLS.QUEUE_EXT - 1] = row.queueExt;
    d[HISTORICAL_COLS.DATE - 1]      = row.dateIso;
    d[HISTORICAL_COLS.AGENT - 1]     = row.agent;
    d[HISTORICAL_COLS.QUEUE_EXT - 1] = row.queueExt;
    const slots = row.slots || [];
    for (let c = 0; c < slots.length; c++) {
      d[HISTORICAL_COLS.TIME_SLOTS_START - 1 + c] = slots[c] || '';
    }
    d[HISTORICAL_COLS.ABANDONED_PARENT_IDS - 1]   = row.abandonedParentIds || '';
    d[HISTORICAL_COLS.ABANDONED_MISSED_TIMES - 1] = row.abandonedMissedTimes || '';
    values.push(v);
    displays.push(d);
  }
  return { values: values, displays: displays };
}

function computeMissedCallsReport_(dept, from, to, scope) {
  const roster = getRosterForDepartment_(dept);
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  // F-35: hard-require the DQE sheet only when it IS the read source. With
  // DQE_READ_SOURCE=neon the sheet may be trimmed/archived -- the old
  // unconditional check served the EMPTY report despite dqe_history being
  // fully populated (so the sheet could never actually be retired). If the
  // Neon read then fails or returns nothing, the sheet-fallback block below
  // returns the empty report rather than crashing on the missing sheet.
  const dqeSource = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  const neonCapable = (dqeSource === 'neon' && typeof neonFetchDqeRows_ === 'function');
  const lastRow = sheet ? sheet.getLastRow() : 0;
  if (!neonCapable) {
    if (!sheet) {
      throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
    }
    if (lastRow < 2) {
      return emptyMissedReport_(dept, from, to, scope, roster.names.length);
    }
  }

  const ssTZ = ss.getSpreadsheetTimeZone();

  // F1 DAL cutover: when DQE_READ_SOURCE=neon, fetch the windowed rows
  // (incl. the slot/abandoned detail columns) from dqe_history and adapt
  // them into the SAME values/displays grid shape the sheet read
  // produces, so the compute loop below runs UNCHANGED on either source.
  // The dept queue-ext set keeps its all-history derivation via
  // deptQueueExtsForNeonReader_ (the same helper computeSummary_'s
  // cutover uses). Fallback: any error or an empty result falls through
  // to the sheet read -- the default path is byte-identical to
  // pre-cutover behavior. Parity is pinned by tests/unit/dal-cutover.test.js.
  let values = null, displays = null, deptQueueExts = null;
  if (neonCapable) {
    try {
      const _t0 = Date.now();
      const dalRows = neonFetchDqeRows_(from, to, { includeMissedDetail: true });
      if (dalRows && dalRows.length) {
        const grids = missedGridsFromDal_(dalRows);
        values = grids.values;
        displays = grids.displays;
        deptQueueExts = deptQueueExtsForNeonReader_(dept, rosterSet, sheet, lastRow).exts;
        if (typeof logDqeReadTiming_ === 'function') logDqeReadTiming_('missedCalls', 'neon', _t0, dalRows.length);
      }
    } catch (e) {
      Logger.log('computeMissedCallsReport_: neon read failed, falling back to sheet: '
        + (e && e.message ? e.message : e));
      values = null; displays = null; deptQueueExts = null;
    }
  }
  if (!values) {
    if (!sheet || lastRow < 2) {   // F-35: neon empty AND no sheet to fall back to
      return emptyMissedReport_(dept, from, to, scope, roster.names.length);
    }
    // Read cols 1..AH. Need date (col 2) and agent (col 3) for filtering,
    // K-AC for missed times, AF for abandoned cross-reference.
    const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
    const range = sheet.getRange(2, 1, lastRow - 1, numCols);
    values = range.getValues();
    displays = range.getDisplayValues();

    // Shared with Data.gs queue-scope matching: override if set, else
    // derived from this dept's roster agents' col D values.
    deptQueueExts = getDeptQueueExts_(dept, rosterSet, values).exts;
  }

  // Chart buckets: 8 AM-5 PM CST in 30-min slots = 18 buckets
  const totalBuckets = (MISSED_CHART_END_HOUR - MISSED_CHART_START_HOUR)
                       * (60 / MISSED_BUCKET_MINUTES);
  const chartCounts = new Array(totalBuckets).fill(0);
  // Parallel per-bucket abandoned-ring count so the bar chart can color a
  // bucket that CONTAINS an abandoned call differently from an abandoned-free
  // one (solid vs faint). Incremented alongside chartCounts when the ring is
  // abandoned.
  const chartAbandoned = new Array(totalBuckets).fill(0);
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
  const abandonedDetailLostDates = {}; // dates whose AD/AF abandoned cells were corrupted/lost

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

    // Build the set of abandoned-missed timestamps (col AF). Normalize
    // the same way as slot times so AM/PM differences or 24-vs-12 hour
    // formatting in either column don't break the cross-reference.
    //
    // RPT-1: this AD/AF block runs BEFORE the zero-slot early-continue
    // below. F-2 legitimately emits rows whose AD is populated while
    // K-AC is empty (abandoned parents with no pairable missed leg are
    // appended to AD with no AE/AF partner; missed rings entirely
    // outside the 6:00-15:30 slot band produce no slot timestamps).
    // The old ordering silently dropped those parents from the dept-wide
    // unique-abandoned counts AND skipped the lost-detail flagging for
    // corrupted AD/AF cells on slot-less rows.
    //
    // Read-side guard (classifyAbandonedCell_): never split a coerced/lost
    // AD/AF cell into fake IDs/times. Recover lossless single-value coercions;
    // flag the date when the abandoned data was genuinely lost (then treat the
    // row as having no abandoned detail -- the missed timestamps still render).
    const afClass = classifyAbandonedCell_(rd[HISTORICAL_ABANDONED_MISSED_TIMES - 1]);
    const adClass = classifyAbandonedCell_(rd[HISTORICAL_ABANDONED_PARENT_IDS - 1]);
    if (afClass.lost || adClass.lost) abandonedDetailLostDates[dateIso] = true;
    const abandonedStr = afClass.lost ? '' : afClass.value;
    // Keep positions even for unparseable entries ('' key) so AF[i]
    // stays aligned with AD[i] for the positional pairing below.
    let abandonedTimeList = [];
    if (abandonedStr) {
      abandonedStr.split(',').forEach(function (t) {
        abandonedTimeList.push(normTimeKey_(t.trim()));
      });
    }
    const abandonedIdsCell = adClass.lost ? '' : adClass.value;
    const abandonedIdList = abandonedIdsCell
      ? abandonedIdsCell.split(',').map(function (s) { return s.trim(); })
                        .filter(function (s) { return !!s; })
      : [];
    // RPT-2 pairing: the source pipeline (F-2) emits AF[i] <-> AD[i] in
    // positional lockstep, chronologically sorted. Keying the pairing with a
    // single {timeKey -> parentId} map collapsed DUPLICATE timestamps -- two
    // missed legs in the same second both rendered the LAST parent's id,
    // re-introducing the wrong-journey drill F-2 fixed on the write side.
    // Instead keep a FIFO of parent ids per normalized time key; the slot
    // list and AF are both chronological, so consuming in order preserves
    // the positional pairing. Pair only up to the shorter list so a
    // malformed row doesn't throw -- it just shows missing IDs.
    const abandonedTimeToParents = {};  // timeKey -> [parentId, ...] (FIFO)
    const pairLen = Math.min(abandonedTimeList.length, abandonedIdList.length);
    for (let p = 0; p < pairLen; p++) {
      const tk = abandonedTimeList[p];
      if (!tk) continue;
      if (!abandonedTimeToParents[tk]) abandonedTimeToParents[tk] = [];
      abandonedTimeToParents[tk].push(abandonedIdList[p]);
    }

    // Col AD ("Abandoned Parent Call IDs") feeds dept-wide unique-
    // abandoned-call counts. Sentinel rows additionally feed
    // uniqueNoRingParents for the "No-ring abandons: K" breakdown.
    // Counted even when the row has no slot timestamps (RPT-1).
    abandonedIdList.forEach(function (id) {
      uniqueAbandonedParents[id] = true;
      if (isSentinel) uniqueNoRingParents[id] = true;
    });

    if (slotTimes.length === 0) continue;

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
      // RPT-2: one AF entry marks (at most) ONE ring at that second as
      // abandoned, carrying its OWN positionally-paired parent id.
      const pendingIds = abandonedTimeToParents[item.key];
      const isAbandoned = !!(pendingIds && pendingIds.length);

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
          if (isAbandoned) chartAbandoned[candidate]++;
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
        // Sourced from AF<->AD positional pairing within this row
        // (FIFO per time key -- duplicate seconds keep distinct ids).
        parentId: isAbandoned ? (pendingIds.shift() || null) : null,
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
        // F-34: abandonedRings is documented as AGENT rings only ("the
        // number of red rows in the agent grid") -- the old increment ran
        // for sentinel rows too, inflating the meta count.
        if (isAbandoned) abandonedRings++;
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
      // Dates whose AD/AF abandoned cells were corrupted by the number-coercion
      // bug and excluded from the counts above (rebuild from Raw Data). The
      // client surfaces a note so a lost row isn't mistaken for "0 abandoned".
      abandonedDetailLost: Object.keys(abandonedDetailLostDates).length > 0,
      abandonedDetailLostDates: Object.keys(abandonedDetailLostDates).sort(),
      generatedAt: new Date().toISOString(),
    },
    agents: agents,
    queueOnly: queueOnly,
    chart: {
      labels: chartLabels,
      counts: chartCounts,
      abandoned: chartAbandoned,
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
      abandonedDetailLost: false,
      abandonedDetailLostDates: [],
      generatedAt: new Date().toISOString(),
    },
    agents: [],
    queueOnly: [],
    chart: { labels: [], counts: [], abandoned: [] },
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
