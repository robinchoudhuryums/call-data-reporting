// ============================================================================
// queueOverlapAudit.js — READ-ONLY. Does a CALL get counted by two queues?
// ----------------------------------------------------------------------------
// The question this answers: the Daily Call Queue Report sums a parent dept's
// queues with its sub-queue's (CSR 418 + Spanish 18 = 436). Those two counters
// key on DIFFERENT raw queue names, so they never count the same LEG twice --
// but they are per-LEG, and one CALL can ring through more than one queue. A
// call that entered A_Q_Spanish and overflowed into a CSR queue contributes a
// leg to each, so the SUM over-counts it even though neither counter is wrong.
//
// The DQE per-queue split does not have this problem: it assigns parent-level
// figures to the queue of the parent's EARLIEST leg
// (`dqeQueueSplitForAgent_`'s parentOwner), precisely so an overflow call is
// not counted twice. `calcQcdReport` has no equivalent rule. So the two
// reports can legitimately disagree, and the size of the disagreement is a
// measurable property of the day's data rather than a matter of opinion.
//
// Queue derivation MIRRORS the DQE build exactly -- the same col-W IMP-8
// regex, the same R18e CallQueue-extension fallback, the same CallForking
// skip -- so these numbers reconcile with `auditQueueSplitAttribution()` in
// the dashboard rather than forming a third opinion. If you change the
// build's derivation, change it here too.
//
// Writes nothing. Reads 'Raw Data' + 'DO NOT EDIT!' from THIS spreadsheet.
//
// DATE SEMANTICS -- build parity, and the two traps behind it.
// 'Raw Data' holds ONE day's legs plus a few STRAY CARRY-OVER rows (calls that
// crossed midnight). The daily build takes the TAB's date -- the sheet's
// majority day, which PIPE-3 enforces -- and, since P-7 (broad-scan 2026-09-17), DROPS every
// leg on another calendar day before any pass sees it. This audit does the
// same (F13, broad-scan 2026-10-14): until then it still counted the strays,
// on a premise ("the build does not date-filter at all") that P-7 had made
// false -- so its "build parity" label promised a reconciliation it no longer
// delivered. Strays are counted and named, never analysed.
//
// The first version of this diagnostic made the opposite mistake: it picked
// the MAXIMUM date in the sheet and analysed only rows matching it. On a real
// day that selected the handful of carry-over stragglers -- 19 legs out of
// ~1000 -- and reported a confident "no queue overlap" from 2% of the data.
// ST2 (broad-scan 259, E4): the day is the MAJORITY date through the one rule
// every stray-aware reader shares (rawGridDay_, duplicated from cdr-import and
// guarded by scripts/check-duplicated-files.sh) -- not the first valid row,
// which a carry-over leg can be.
//
// AGENT NAMES are canonicalized with the build's own INV-24 rule
// (canonicalizeAgentNameWith_ over loadRosterCanonicalNames_, F13) before they
// meet the roster -- a feed spelling the build rewrites to its roster name
// used to fall out of sections 3 and 4 here.
//
// The date DISTRIBUTION is printed first, so a sheet holding something other
// than one clean day is visible immediately rather than silently halving the
// answer.
//
// Run:  queueOverlapAudit()          -- the build's date (build parity)
//       QUEUE_OVERLAP_DATE (Script Property, 'M/D/YYYY' as Raw Data renders
//       it) restricts to one date -- the build's own is the same set; any
//       other is a DEPARTURE from build parity, useful only to isolate
//       carry-over legs.
//
// Sections:
//   1. CROSS-QUEUE CALL OVERLAP -- calls whose legs span two queues, ranked.
//      This is the per-leg double-count exposure, pair by pair.
//   2. PARENT/SUB-QUEUE SUMMATION -- for each Overview parent/child pair, the
//      exact number of calls a naive queue-sum counts twice.
//   3. ROSTER -> QUEUES ACTUALLY WORKED -- which queues each dept's rostered
//      agents actually took legs on. Answers "what queue does this dept use?"
//      for a dept whose mapping is empty or suspected wrong.
//   4. CROSSOVER AGENTS -- agents on more than one dept roster, with their
//      per-queue leg split. This is the DQE inflation, per agent, in calls.
// ============================================================================

var QOA_ROSTER_FIRST_COL_ = 6;   // INV-11: dept columns start at F

/** Mirrors the DQE build's per-leg queue derivation. Returns null to SKIP. */
function qoaQueueForRow_(row, queueNameByExt) {
  var callerIdRaw = String(row[DQE_C.CALLER_ID]).trim();
  // IMP-8 boundary regex -- do NOT widen; a prefixed token must not match.
  var m = callerIdRaw.match(/(?:^|[^\w&])(A_Q_[\w&]+|Backup CSR)/);
  var queueName = m ? m[1] : null;
  if (!queueName) {                                   // R18e fallback
    var cq = String(row[DQE_C.CALLER]).trim().match(/^CallQueue\s*\((\d+)\)$/i);
    if (cq) queueName = queueNameByExt[cq[1]] || null;
  }
  if (!queueName) return null;
  if (/^CallForking/i.test(String(row[DQE_C.CALLEE]).trim())) return null;
  return queueName;
}

/** The ext -> queue-name map the R18e fallback needs (build parity). */
function qoaQueueNameByExt_(data) {
  var out = {};
  for (var i = 0; i < data.length; i++) {
    var ext = String(data[i][DQE_C.CALLEE]).trim();
    var nm  = String(data[i][DQE_C.CALLEE_NAME]).trim();
    if (!/^\d+$/.test(ext)) continue;
    if (!/^(A_Q_[\w&]+|Backup CSR)$/.test(nm)) continue;
    out[ext] = nm;
  }
  return out;
}

/** dept -> {agentNameLower: true} from 'DO NOT EDIT!' (INV-03/INV-11). */
function qoaRostersByDept_(ss) {
  var out = {};
  var sheet = ss.getSheetByName('DO NOT EDIT!');
  if (!sheet) return out;
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < QOA_ROSTER_FIRST_COL_) return out;
  var width = lastCol - QOA_ROSTER_FIRST_COL_ + 1;
  var headers = sheet.getRange(1, QOA_ROSTER_FIRST_COL_, 1, width).getValues()[0];
  var body = sheet.getRange(2, QOA_ROSTER_FIRST_COL_, lastRow - 1, width).getValues();
  for (var c = 0; c < width; c++) {
    var dept = String(headers[c] || '').trim();
    if (!dept) continue;
    var names = {};
    for (var r = 0; r < body.length; r++) {
      // INV-03: "Name, ext1, ext2" -- the name is everything before the first comma.
      var cell = String(body[r][c] == null ? '' : body[r][c]).trim();
      if (!cell) continue;
      var nm = cell.split(',')[0].trim();
      if (nm) names[nm.toLowerCase()] = true;
    }
    if (Object.keys(names).length) out[dept] = names;
  }
  return out;
}

/**
 * Parent/child + queue mapping from the 'Dept Config' sheet, which lives in
 * THIS workbook (the dashboard's SPREADSHEET_ID points at the CDR Report
 * spreadsheet, so its config sheets sit beside Raw Data). Columns per
 * DeptConfig.gs::sheetReadDeptConfigRows_: 0 Department, 1 QCD Queues,
 * 2 Overview Parent, 5 Active, 9 Inbound queue aliases.
 * Returns { parentOf:{child:parent}, queuesOf:{dept:[names]} }; empty when the
 * sheet is absent, which is a clean degradation, not an error.
 */
function qoaDeptConfig_(ss) {
  var out = { parentOf: {}, queuesOf: {} };
  try {
    var sheet = ss.getSheetByName('Dept Config');
    if (!sheet) return out;
    var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
    if (lastRow < 2) return out;
    var rows = sheet.getRange(2, 1, lastRow - 1, Math.max(lastCol, 10)).getValues();
    var list = function (v) {
      return String(v == null ? '' : v).split(',').map(function (x) { return x.trim(); })
             .filter(function (x) { return x; });
    };
    for (var i = 0; i < rows.length; i++) {
      var dept = String(rows[i][0] || '').trim();
      if (!dept) continue;
      var active = String(rows[i][5] == null ? '' : rows[i][5]).trim().toLowerCase();
      if (active === 'false' || active === 'no' || active === '0') continue;
      var parent = String(rows[i][2] || '').trim();
      if (parent) out.parentOf[dept] = parent;
      var qs = list(rows[i][1]).concat(list(rows[i][9]));   // QCD queues + inbound aliases
      if (qs.length) out.queuesOf[dept] = qs;
    }
  } catch (e) { /* best-effort -- a diagnostic must not throw */ }
  return out;
}

/** F13. A 'M/D/YYYY' date as a padding-free day key ('3/9/2026' == '03/09/2026'); '' if malformed. */
/**
 * ST2 (broad-scan 259, E4): THE calendar day of one leg's START_TIME display
 * cell (col C) -- "M/D/YYYY ...", "M/D/YY ..." or ISO -- as 'YYYY-MM-DD';
 * null when the cell is empty or unrecognized (such a row is UNDATED, never a
 * stray). PURE. Duplicated byte-for-byte in cdr-report/queueOverlapAudit.js;
 * scripts/check-duplicated-files.sh fails on drift.
 */
function rawGridDayIso_(cell) {
  var v = String(cell == null ? '' : cell).trim();
  if (!v) return null;
  var datePart = v.split(/\s+/)[0];
  var m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var p = datePart.split('/');
  if (p.length === 3 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && /^\d+$/.test(p[2])) {
    var y = p[2].length === 2 ? 2000 + Number(p[2]) : Number(p[2]);
    return y + '-' + ('0' + Number(p[0])).slice(-2) + '-' + ('0' + Number(p[1])).slice(-2);
  }
  return null;
}

/**
 * ST2 (broad-scan 259, E4): THE day of a Raw Data / Call_Legs display grid
 * (header row first; col C = leg START_TIME). A source tab holds one day's
 * legs plus a few carry-over legs from the day before (P-7), which may sort
 * FIRST (the ING-7 shape) -- so the grid's day is the MAJORITY date, never
 * the first row's. Ties go to the later date. Returns { dateIso, rows (the
 * header, every row on dateIso and every undated row), strays, strayByDay
 * {iso: n}, counts {iso: n}, total (dated rows) }. PURE.
 *
 * One rule for every reader that asks "which day is this grid, and which legs
 * are strays": PIPE-3's tab-date check (sourceCallDateCounts_), the CSR daily
 * engine and its repair (csrRepairDayRows_), and the read-only diagnostics --
 * diagnoseQcdVsDqe, queueSplitSample and (its cdr-report copy) the overlap
 * audit. Deliberately NOT here (owner ruling 2026-10-15, E4): CDR Output, QCD
 * and Q Path still COUNT carry-over legs, and the builders that drop them
 * (DQE, Direct, the per-call writers) keep their own per-record date checks,
 * so no stored figure changes. Duplicated in cdr-report/queueOverlapAudit.js.
 */
function rawGridDay_(grid) {
  var counts = {}, rowIso = [], total = 0;
  for (var i = 1; i < (grid || []).length; i++) {
    var iso = rawGridDayIso_((grid[i] || [])[2]);
    rowIso.push(iso);
    if (iso) { counts[iso] = (counts[iso] || 0) + 1; total++; }
  }
  var best = null;
  Object.keys(counts).forEach(function (k) {
    if (best === null || counts[k] > counts[best] || (counts[k] === counts[best] && k > best)) best = k;
  });
  var rows = (grid && grid.length) ? [grid[0]] : [], strays = 0, strayByDay = {};
  for (var j = 1; j < (grid || []).length; j++) {
    var ri = rowIso[j - 1];
    if (!ri || ri === best) rows.push(grid[j]);
    else { strays++; strayByDay[ri] = (strayByDay[ri] || 0) + 1; }
  }
  return { dateIso: best, rows: rows, strays: strays, strayByDay: strayByDay, counts: counts, total: total };
}

function qoaDayKey_(s) {
  var p = String(s || '').trim().split('/');
  if (p.length !== 3 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1]) || !/^\d+$/.test(p[2])) return '';
  return Number(p[2]) + '-' + Number(p[0]) + '-' + Number(p[1]);
}

function qoaPad_(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

function queueOverlapAudit() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var raw = ss.getSheetByName('Raw Data');
  if (!raw) { Logger.log('queueOverlapAudit: no "Raw Data" sheet.'); return; }
  var lastRow = raw.getLastRow();
  if (lastRow < 2) { Logger.log('queueOverlapAudit: Raw Data is empty.'); return; }

  var data = raw.getRange(2, 1, lastRow - 1, 26).getDisplayValues();
  var pinned = String(PropertiesService.getScriptProperties()
                        .getProperty('QUEUE_OVERLAP_DATE') || '').trim();

  // Same extraction as the build's displayToDateStr: token 0 of START_TIME.
  var dateOf = function (row) { return String(row[DQE_C.START_TIME]).trim().split(' ')[0]; };

  // Row counts per date -- printed up front. A sheet that is not one clean
  // day is the single thing most likely to make every number below wrong.
  var dateHist = {};
  for (var d0 = 0; d0 < data.length; d0++) {
    var dv = dateOf(data[d0]);
    if (dv) dateHist[dv] = (dateHist[dv] || 0) + 1;
  }
  var histKeys = Object.keys(dateHist).sort(function (a, b) { return dateHist[b] - dateHist[a]; });

  // Build parity: the sheet's MAJORITY day through the one shared rule
  // (rawGridDay_, ST2) -- the daily build is pinned to the tab's date, which
  // PIPE-3 proves is the majority. The first valid row is NOT safe: in the
  // ING-7 shape a carry-over leg sorts first. `buildDate` stays the display
  // token the histogram keys on.
  var day = rawGridDay_([[]].concat(data.map(function (r) { return ['', '', r[DQE_C.START_TIME]]; })));
  var buildDate = '';
  histKeys.forEach(function (k) { if (!buildDate && day.dateIso && rawGridDayIso_(k) === day.dateIso) buildDate = k; });
  if (!buildDate) { Logger.log('queueOverlapAudit: could not determine a date.'); return; }
  var wanted = pinned || buildDate;

  var queueNameByExt = qoaQueueNameByExt_(data);
  // F13: the build's INV-24 canonicalizer (same project), not a copy of it.
  var rosterCanon = (typeof loadRosterCanonicalNames_ === 'function') ? loadRosterCanonicalNames_(ss) : null;
  var canon = function (name) {
    return (rosterCanon && typeof canonicalizeAgentNameWith_ === 'function')
      ? canonicalizeAgentNameWith_(rosterCanon, name) : name;
  };
  var buildKey = qoaDayKey_(buildDate);
  var strays = 0;

  // ---- Walk the day's legs once -------------------------------------------
  var callQueues = {};        // parentCallId -> { queueName: legCount }
  var queueLegs  = {};        // queueName -> leg count
  var agentQueue = {};        // agentLower -> { queueName: legCount }
  var legs = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    // Unpinned = the build's date, exactly as the build reads it since P-7
    // (a row with no START_TIME is kept, as the build keeps it). Pinned = one date.
    if (pinned) {
      if (dateOf(row) !== pinned) continue;
    } else {
      var rowIso = rawGridDayIso_(row[DQE_C.START_TIME]);   // ST2: undated rows are kept, as the build keeps them
      if (rowIso && rowIso !== day.dateIso) { strays++; continue; }
    }
    var q = qoaQueueForRow_(row, queueNameByExt);
    if (!q) continue;
    legs++;
    queueLegs[q] = (queueLegs[q] || 0) + 1;

    // Group by the PARENT call so "one call, two queues" is detectable.
    // REP-4: a literal 'N/A' parent is not a real id -- such a leg is its own
    // call, keyed on its own call id, exactly as the rollup treats it.
    var pid = String(row[DQE_C.PARENT_CALL]).trim();
    if (!pid || pid === 'N/A') pid = 'self:' + String(row[DQE_C.CALL_ID]).trim();
    if (!callQueues[pid]) callQueues[pid] = {};
    callQueues[pid][q] = (callQueues[pid][q] || 0) + 1;

    // INV-23 sentinel rows carry a queue id where an agent name goes. The
    // filter below is belt-and-braces: `agentQueue` is only ever read through
    // ROSTER names (sections 3 and 4) and a sentinel is never on a roster, so
    // dropping it changes no output today. Kept for a future consumer that
    // iterates the map directly -- and deliberately not unit-pinned, since a
    // test for it would pass with it deleted.
    var agent = canon(String(row[DQE_C.CALLEE_NAME]).trim());   // F13: INV-24, as the build
    if (agent && agent !== 'N/A' && !/^(A_Q_[\w&]+|Backup CSR)$/.test(agent)) {
      var al = agent.toLowerCase();
      if (!agentQueue[al]) agentQueue[al] = {};
      agentQueue[al][q] = (agentQueue[al][q] || 0) + 1;
    }
  }

  var out = [];
  out.push('=== Queue-overlap audit -- ' + wanted
           + (pinned ? '  (PINNED to one date)' : '  (the build\'s date -- build parity)') + ' ===');
  out.push('Queue legs: ' + legs + '   distinct calls: ' + Object.keys(callQueues).length
           + '   queues seen: ' + Object.keys(queueLegs).length);
  if (!pinned && strays) {
    out.push('Skipped ' + strays + ' stray leg(s) on other dates -- the build drops them too (P-7).');
  }
  out.push('');
  out.push('Raw Data rows by date (the sheet should hold ONE day plus a few');
  out.push('carry-over legs; anything else makes every number below suspect):');
  histKeys.slice(0, 8).forEach(function (k) {
    out.push('  ' + qoaPad_(k, 14) + dateHist[k] + ' row(s)'
             + (k === buildDate ? '   <- the build dates this sheet here' : ''));
  });
  if (histKeys.length > 8) out.push('  ... and ' + (histKeys.length - 8) + ' more date(s)');
  if (pinned) {
    var pinnedRows = dateHist[pinned] || 0;
    out.push('  PINNED to ' + pinned + ' (' + pinnedRows + ' of ' + data.length + ' rows). '
             + (qoaDayKey_(pinned) === buildKey
                 ? 'That is the build\'s date -- the same rows the build reads.'
                 : 'This is NOT build parity -- the build reads only ' + buildDate + '\'s rows (P-7).'));
    if (pinnedRows * 5 < data.length) {
      out.push('  !! That is under a fifth of the sheet. If you meant the whole');
      out.push('     day, clear QUEUE_OVERLAP_DATE -- a pin this narrow usually');
      out.push('     selects carry-over legs and makes the overlap read as zero.');
    }
  }
  out.push('');
  out.push('Queue derivation mirrors the DQE build, so these reconcile with');
  out.push('auditQueueSplitAttribution() in the dashboard project.');
  out.push('');

  // ---- 1. Cross-queue call overlap ----------------------------------------
  var pairCount = {};
  var multiQueueCalls = 0;
  Object.keys(callQueues).forEach(function (pid) {
    var qs = Object.keys(callQueues[pid]).sort();
    if (qs.length < 2) return;
    multiQueueCalls++;
    for (var a = 0; a < qs.length; a++) {
      for (var b = a + 1; b < qs.length; b++) {
        var key = qs[a] + '  +  ' + qs[b];
        pairCount[key] = (pairCount[key] || 0) + 1;
      }
    }
  });

  out.push('--- 1. Calls whose legs span TWO queues (the per-leg double-count) ---');
  out.push('Calls touching more than one queue: ' + multiQueueCalls
           + ' of ' + Object.keys(callQueues).length);
  var pairs = Object.keys(pairCount).sort(function (a, b) { return pairCount[b] - pairCount[a]; });
  if (!pairs.length) {
    out.push('  NONE -- every call stayed within a single queue. A queue-sum');
    out.push('  cannot double-count on this date.');
  } else {
    pairs.forEach(function (k) {
      out.push('  ' + qoaPad_(k, 52) + ' ' + pairCount[k] + ' call(s) counted by BOTH');
    });
  }
  out.push('');

  // ---- 2. Parent/sub-queue summation impact -------------------------------
  // The Daily Call Queue Report sums a parent's queues with its children's.
  // For each parent/child pair, how many calls does that sum count twice?
  out.push('--- 2. Parent + sub-queue summation (what the Queue Report adds up) ---');
  var cfg = qoaDeptConfig_(ss);
  var childrenOf = {};
  Object.keys(cfg.parentOf).forEach(function (child) {
    var p = cfg.parentOf[child];
    (childrenOf[p] = childrenOf[p] || []).push(child);
  });
  var parents = Object.keys(childrenOf).sort();
  if (!parents.length) {
    out.push('  No parent/child pairs found in the "Dept Config" sheet.');
    out.push('  (Section 1 above still lists every overlapping queue pair.)');
  } else {
    parents.forEach(function (parent) {
      var pq = cfg.queuesOf[parent] || [];
      var kids = childrenOf[parent];
      var kq = [];
      kids.forEach(function (k) { kq = kq.concat(cfg.queuesOf[k] || []); });
      var lower = function (a) { return a.map(function (x) { return x.toLowerCase(); }); };
      var pl = lower(pq), kl = lower(kq);

      // How many CALLS have a leg on a parent queue AND a leg on a child
      // queue? That is exactly what a parent+child queue-sum counts twice.
      var dbl = 0;
      Object.keys(callQueues).forEach(function (pid) {
        var qs = Object.keys(callQueues[pid]).map(function (x) { return x.toLowerCase(); });
        var hitsP = qs.some(function (q) { return pl.indexOf(q) !== -1; });
        var hitsK = qs.some(function (q) { return kl.indexOf(q) !== -1; });
        if (hitsP && hitsK) dbl++;
      });

      out.push('  ' + parent + ' [' + (pq.join(', ') || 'no queues mapped') + ']');
      out.push('    + ' + kids.join(', ') + ' [' + (kq.join(', ') || 'no queues mapped') + ']');
      if (!pq.length || !kq.length) {
        out.push('    -> cannot assess: one side has no mapped queues');
      } else if (dbl === 0) {
        out.push('    -> 0 calls touch both sides. Summing the two is EXACT for'
                 + ' this day.');
      } else {
        out.push('    -> ' + dbl + ' call(s) touch BOTH sides, so a queue-sum'
                 + ' over-counts by ' + dbl + '.');
      }
    });
  }
  out.push('');

  // ---- 3. Roster -> queues actually worked --------------------------------
  out.push('--- 3. Which queues each dept\'s ROSTERED agents actually worked ---');
  out.push('(Answers "what queue does this dept use?" when its mapping is empty)');
  var rosters = qoaRostersByDept_(ss);
  var deptNames = Object.keys(rosters).sort();
  if (!deptNames.length) out.push('  no roster columns found in "DO NOT EDIT!"');
  deptNames.forEach(function (dept) {
    var tally = {};
    Object.keys(rosters[dept]).forEach(function (al) {
      var qs = agentQueue[al];
      if (!qs) return;
      Object.keys(qs).forEach(function (q) { tally[q] = (tally[q] || 0) + qs[q]; });
    });
    var ks = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; });
    if (!ks.length) { out.push('  ' + qoaPad_(dept, 22) + '(no queue legs today)'); return; }
    out.push('  ' + qoaPad_(dept, 22) + ks.map(function (q) {
      return q + '=' + tally[q];
    }).join('  '));
  });
  out.push('');

  // ---- 4. Crossover agents ------------------------------------------------
  out.push('--- 4. CROSSOVER agents (on more than one dept roster) ---');
  out.push('Each one\'s whole-day figures are claimed IN FULL by every dept below');
  out.push('unless QUEUE_SPLIT_SCOPE=dept. The per-queue split is the true share.');
  var homesOf = {};
  deptNames.forEach(function (dept) {
    Object.keys(rosters[dept]).forEach(function (al) {
      (homesOf[al] = homesOf[al] || []).push(dept);
    });
  });
  var crossovers = Object.keys(homesOf).filter(function (al) { return homesOf[al].length > 1; }).sort();
  if (!crossovers.length) {
    out.push('  NONE -- no agent is on two rosters, so the DQE crossover');
    out.push('  inflation cannot occur on this roster.');
  } else {
    out.push('  ' + crossovers.length + ' crossover agent(s):');
    crossovers.forEach(function (al) {
      var qs = agentQueue[al] || {};
      var ks = Object.keys(qs).sort(function (a, b) { return qs[b] - qs[a]; });
      var total = ks.reduce(function (n, q) { return n + qs[q]; }, 0);
      out.push('  ' + qoaPad_(al, 26) + 'rosters=[' + homesOf[al].join(', ') + ']');
      out.push('  ' + qoaPad_('', 26) + (ks.length
        ? ks.map(function (q) { return q + '=' + qs[q]; }).join('  ') + '   (total legs ' + total + ')'
        : '(no queue legs today)'));
    });
  }
  out.push('');
  out.push('=== end ===');

  var msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg.slice(0, 8000)); } catch (e) { /* editor-run */ }
  return msg;
}
