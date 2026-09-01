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
// Run:  queueOverlapAudit()          -- most recent date in Raw Data
//       set QUEUE_OVERLAP_DATE (Script Property, 'M/D/YYYY' as Raw Data
//       renders it) to pin a specific day.
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
  var wanted = String(PropertiesService.getScriptProperties()
                        .getProperty('QUEUE_OVERLAP_DATE') || '').trim();

  // Raw Data start times render as "M/D/YYYY H:MM:SS"; the date is token 0.
  var dateOf = function (row) { return String(row[DQE_C.START_TIME]).trim().split(' ')[0]; };
  if (!wanted) {
    var seen = {};
    for (var d0 = 0; d0 < data.length; d0++) { var dv = dateOf(data[d0]); if (dv) seen[dv] = true; }
    var dates = Object.keys(seen).sort(function (a, b) {
      return new Date(a) - new Date(b);
    });
    wanted = dates.length ? dates[dates.length - 1] : '';
  }
  if (!wanted) { Logger.log('queueOverlapAudit: could not determine a date.'); return; }

  var queueNameByExt = qoaQueueNameByExt_(data);

  // ---- Walk the day's legs once -------------------------------------------
  var callQueues = {};        // parentCallId -> { queueName: legCount }
  var queueLegs  = {};        // queueName -> leg count
  var agentQueue = {};        // agentLower -> { queueName: legCount }
  var legs = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (dateOf(row) !== wanted) continue;
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
  out.push('=== Queue-overlap audit -- ' + wanted + ' ===');
  out.push('Queue legs: ' + legs + '   distinct calls: ' + Object.keys(callQueues).length
           + '   queues seen: ' + Object.keys(queueLegs).length);
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
  var parentMap = (typeof OVERVIEW_PARENT_OF !== 'undefined') ? OVERVIEW_PARENT_OF : null;
  if (!parentMap) {
    out.push('  OVERVIEW_PARENT_OF is not available in this project -- listing raw');
    out.push('  pairs only (section 1 above already shows every overlapping pair).');
  } else {
    var childrenOf = {};
    Object.keys(parentMap).forEach(function (child) {
      var p = parentMap[child];
      (childrenOf[p] = childrenOf[p] || []).push(child);
    });
    var anyParent = false;
    Object.keys(childrenOf).forEach(function (parent) {
      anyParent = true;
      out.push('  ' + parent + ' + [' + childrenOf[parent].join(', ') + ']');
      out.push('    (queue names below; a dept maps to queues via Dept Config --');
      out.push('     match these against the Queue Report rows you are comparing)');
    });
    if (!anyParent) out.push('  no parent/child pairs configured');
    out.push('  Use section 1: the overlap between a parent queue and a child');
    out.push('  queue IS the number the summed figure over-counts.');
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
