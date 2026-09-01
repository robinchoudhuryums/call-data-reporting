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
// DATE SEMANTICS -- build parity, and the trap that broke the first version.
// 'Raw Data' holds ONE day's legs, and the build does not date-filter at all:
// it takes the date from the FIRST valid START_TIME and processes every row
// (buildDQEHistoricalData's "Detect call date" block). It cannot, because a
// day's legs include STRAY CARRY-OVER rows -- calls that crossed midnight --
// which the build's own F2 comment calls out by name.
//
// The first version of this diagnostic instead picked the MAXIMUM date in the
// sheet and analysed only rows matching it. On a real day that selected the
// handful of carry-over stragglers: 19 legs out of ~1000, and it then reported
// a confident "no queue overlap" from 2% of the data. Analysing all rows is
// both correct AND what makes these numbers reconcile with the build.
//
// The date DISTRIBUTION is now printed first, so a sheet holding something
// other than one clean day is visible immediately rather than silently
// halving the answer.
//
// Run:  queueOverlapAudit()          -- all of Raw Data (build parity)
//       QUEUE_OVERLAP_DATE (Script Property, 'M/D/YYYY' as Raw Data renders
//       it) restricts to one date -- a DEPARTURE from build parity, useful
//       only to isolate carry-over legs.
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

  // Build parity: the date is the FIRST valid START_TIME, not the maximum.
  var buildDate = '';
  for (var d1 = 0; d1 < data.length && !buildDate; d1++) {
    var v = dateOf(data[d1]);
    if (v && v.split('/').length === 3) buildDate = v;
  }
  if (!buildDate && histKeys.length) buildDate = histKeys[0];
  if (!buildDate) { Logger.log('queueOverlapAudit: could not determine a date.'); return; }
  var wanted = pinned || buildDate;

  var queueNameByExt = qoaQueueNameByExt_(data);

  // ---- Walk the day's legs once -------------------------------------------
  var callQueues = {};        // parentCallId -> { queueName: legCount }
  var queueLegs  = {};        // queueName -> leg count
  var agentQueue = {};        // agentLower -> { queueName: legCount }
  var legs = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    // Unpinned = every row, exactly as the build does. Pinned = one date.
    if (pinned && dateOf(row) !== pinned) continue;
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
    var agent = String(row[DQE_C.CALLEE_NAME]).trim();
    if (agent && agent !== 'N/A' && !/^(A_Q_[\w&]+|Backup CSR)$/.test(agent)) {
      var al = agent.toLowerCase();
      if (!agentQueue[al]) agentQueue[al] = {};
      agentQueue[al][q] = (agentQueue[al][q] || 0) + 1;
    }
  }

  var out = [];
  out.push('=== Queue-overlap audit -- ' + wanted
           + (pinned ? '  (PINNED to one date)' : '  (all of Raw Data -- build parity)') + ' ===');
  out.push('Queue legs: ' + legs + '   distinct calls: ' + Object.keys(callQueues).length
           + '   queues seen: ' + Object.keys(queueLegs).length);
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
    out.push('  PINNED to ' + pinned + ' (' + pinnedRows + ' of ' + data.length
             + ' rows). This is NOT build parity -- the build reads every row.');
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
