// ============================================================================
// DQE Drill-Down Tool
// ----------------------------------------------------------------------------
// Adds a "DQE Tools -> Show source rows for selection" menu item that opens
// a sidebar showing the Raw Data rows contributing to a selected metric in
// the DQE Historical Data sheet.
//
// Features:
//   - Refresh button (re-reads current selection)
//   - Search box (highlights matching rows without hiding others)
//   - Filter buttons (All / Missed / Answered / With talk time)
//   - Sort dropdown (Time / Talk time / Caller name)
//   - Aggregate summary at top of results
//   - Grouping by parent Call ID (with cross-group sort support)
//   - "Outside hours" near-miss rows shown dimmed by default
//   - "Show rejected rows" mode showing all rows that almost matched
// ============================================================================


// -- Window constants (PST seconds since midnight) ---------------------------
// 6:30 AM-3:00 PM PST = 8:30 AM-5:00 PM CST
var DQE_DD_WINDOW_START = (6 * 60 + 30) * 60;
var DQE_DD_WINDOW_END   = 15 * 60 * 60;


// -- Menu installation -------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('DQE Tools')
    .addItem('Show source rows for selection', 'showDQEDrilldownSidebar')
    .addToUi();
}


// -- Entry point: open sidebar -----------------------------------------------

function showDQEDrilldownSidebar() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var ui    = SpreadsheetApp.getUi();

  if (sheet.getName() !== 'DQE Historical Data') {
    ui.alert('Please select a cell in the "DQE Historical Data" sheet first.');
    return;
  }

  var html = HtmlService.createTemplateFromFile('DQEDrilldownSidebar')
    .evaluate()
    .setTitle('DQE Drill-Down')
    .setWidth(400);

  SpreadsheetApp.getUi().showSidebar(html);
}


// -- Read current selection (called from sidebar Refresh button) -------------

function getCurrentSelectionContext() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();

  if (sheet.getName() !== 'DQE Historical Data') {
    return { error: 'Please select a cell in the "DQE Historical Data" sheet.' };
  }

  var cell = sheet.getActiveCell();
  var row  = cell.getRow();
  var col  = cell.getColumn();

  if (row < 2) {
    return { error: 'Please select a data cell, not the header row.' };
  }

  var rowVals     = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var dateStr     = rowVals[1];
  var agentName   = rowVals[2];
  var metricLabel = sheet.getRange(1, col).getValue();
  var metricValue = cell.getDisplayValue();

  if (!dateStr || !agentName) {
    return { error: 'Selected row is missing date or agent name.' };
  }

  return {
    dateStr:     dateStr,
    agentName:   agentName,
    column:      col,
    metricLabel: metricLabel,
    metricValue: metricValue
  };
}


// -- Server-side data fetcher ------------------------------------------------

function getDQEDrilldownRows(params) {
  var dateStr     = params.dateStr;
  var agentName   = params.agentName;
  var column      = params.column;
  var showAllRejects = !!params.showAllRejects;

  var ss       = SpreadsheetApp.getActiveSpreadsheet();
  var rawSheet = ss.getSheetByName('Raw Data');
  if (!rawSheet) return { error: '"Raw Data" sheet not found.' };

  var lastRow = rawSheet.getLastRow();
  if (lastRow < 2) return { error: 'Raw Data is empty.' };

  var data     = rawSheet.getRange(2, 1, lastRow - 1, 26).getDisplayValues();
  var timeVals = rawSheet.getRange(2, 7, lastRow - 1, 2).getDisplayValues();

  var metricType = columnToMetric(column);
  if (!metricType) return { error: 'This column is not drillable.' };

  // Does this metric apply a time window?
  var usesWindow = (metricType === 'rung' || metricType === 'missed' || metricType === 'answered');

  // Build parentMap with calleeName per leg so we can compute agent-specific
  // talk time (instead of parent.talkSec which is max across all legs and
  // incorrectly attributes other agents' time to whoever is being drilled into).
  var parentMap = {};
  for (var p = 0; p < data.length; p++) {
    var pid = String(data[p][14]).trim();
    if (pid !== 'N/A' && pid !== '') continue;
    var pcid       = String(data[p][0]).trim();
    var plid       = parseInt(data[p][1]) || 0;
    var ptalk      = timeToSecLocal(timeVals[p] ? timeVals[p][0] : '');
    var pcall      = timeToSecLocal(timeVals[p] ? timeVals[p][1] : '');
    var pabn       = String(data[p][24]).trim() === 'Abandoned';
    var pCalleeNm  = String(data[p][11]).trim();
    if (!parentMap[pcid]) parentMap[pcid] = { legs: [], abandoned: false };
    parentMap[pcid].legs.push({ legId: plid, talkSec: ptalk, callSec: pcall, calleeName: pCalleeNm });
    if (pabn) parentMap[pcid].abandoned = true;
  }
  for (var pk in parentMap) {
    var entry = parentMap[pk];
    entry.legs.sort(function(a, b) { return a.legId - b.legId; });
    entry.waitSec = entry.legs.length ? entry.legs[0].callSec : 0;
    entry.talkSec = entry.legs.length
      ? Math.max.apply(null, entry.legs.map(function(l) { return l.talkSec; }))
      : 0;
  }

  // Helper: find this specific agent's actual talk time on a parent call
  // by matching col L (callee name) on the parent legs.
  function findAgentTalkOnParent(parentCallId, agent) {
    var parent = parentMap[parentCallId];
    if (!parent) return 0;
    var maxTalk = 0;
    for (var i = 0; i < parent.legs.length; i++) {
      var leg = parent.legs[i];
      if (leg.calleeName === agent && leg.talkSec > maxTalk) {
        maxTalk = leg.talkSec;
      }
    }
    return maxTalk;
  }

  // Walk every row, applying filters
  var matches       = [];   // rows that count toward the metric
  var nearMisses    = [];   // rows rejected only by time window (shown dimmed by default)
  var rejected      = [];   // all other rejected rows (only shown in showAllRejects mode)
  var rejectReasons = {};

  for (var i = 0; i < data.length; i++) {
    var row = data[i];

    var rowDateStr = String(row[2]).trim().split(' ')[0];
    if (rowDateStr !== dateStr) continue;

    var rowAgent = String(row[11]).trim();
    if (rowAgent !== agentName) continue;

    var partial = buildRowEntry(row, timeVals[i], i);

    var w = String(row[22]).trim();
    var hasQueue = /A_Q_\w+|Backup CSR/.test(w);
    if (!hasQueue) {
      addRejected(rejected, rejectReasons, partial, 'No queue context (col W)');
      continue;
    }

    var k = String(row[10]).trim();
    if (/^CallForking/i.test(k)) {
      addRejected(rejected, rejectReasons, partial, 'CallForking duplicate leg (col K)');
      continue;
    }

    var missed   = String(row[23]).trim() === 'Missed';
    var answered = String(row[25]).trim() === 'Answered';

    // Status check (depends on metric type)
    var statusOK = true;
    var statusReason = null;
    if (metricType === 'missed' && !missed) {
      statusOK = false;
      statusReason = 'Not missed (col X)';
    } else if (metricType === 'answered' && !answered) {
      statusOK = false;
      statusReason = 'Not answered (col Z)';
    } else if ((metricType === 'ttt' || metricType === 'att') && !answered) {
      statusOK = false;
      statusReason = 'Not answered (col Z)';
    }

    if (!statusOK) {
      addRejected(rejected, rejectReasons, partial, statusReason);
      continue;
    }

    // Time window check (only for window-based metrics)
    if (usesWindow) {
      var startPST = displayToTimeSecLocal(partial.startTime);
      if (startPST !== null && (startPST < DQE_DD_WINDOW_START || startPST >= DQE_DD_WINDOW_END)) {
        // Near-miss: passes everything except time window
        partial._outsideWindow = true;
        nearMisses.push(partial);
        continue;
      }
    }

    matches.push(partial);
  }

  // Dedupe by parent for unique/ttt/att (only matches, not near-misses)
  if (metricType === 'unique' || metricType === 'ttt' || metricType === 'att') {
    matches = dedupeByParent(matches);
  }

  // Abandoned filter
  if (metricType === 'abandoned') {
    matches = matches.filter(function(m) {
      var pm = parentMap[m.parentCallId];
      return pm && pm.abandoned && pm.waitSec > 60;
    });
  }

  // Compute summary based on matches only (agent-specific talk time)
  var summary = computeSummary(matches, parentMap, agentName, findAgentTalkOnParent);

  // Group by parent for normal display (matches + near-misses combined),
  // attaching agent-specific talk time to each group header
  var displayRows = showAllRejects
    ? rejected
    : matches.concat(nearMisses);

  var groups = groupByParent(displayRows, parentMap, agentName, findAgentTalkOnParent);

  return {
    metricType:       metricType,
    rowCount:         matches.length,
    nearMissCount:    nearMisses.length,
    rejectedCount:    rejected.length,
    rejectReasons:    rejectReasons,
    summary:          summary,
    groups:           groups,
    showAllRejects:   showAllRejects,
    usesWindow:       usesWindow
  };
}


// -- Helpers used by the fetcher ---------------------------------------------

function addRejected(rejected, reasonMap, row, reason) {
  row._rejectReason = reason;
  rejected.push(row);
  reasonMap[reason] = (reasonMap[reason] || 0) + 1;
}

function dedupeByParent(rows) {
  var seen = {};
  return rows.filter(function(r) {
    var key = r.parentCallId || ('row_' + r.rowNum);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function buildRowEntry(row, timeRow, idx) {
  var missed    = String(row[23]).trim() === 'Missed';
  var answered  = String(row[25]).trim() === 'Answered';
  var talkTimeS = timeRow ? timeRow[0] : '';
  var talkSec   = timeToSecLocal(talkTimeS);

  return {
    rowNum:         idx + 2,
    callId:         String(row[0]),
    legId:          String(row[1]),
    startTime:      String(row[2]),
    direction:      String(row[5]),
    callerI:        String(row[8]),
    callerName:     String(row[9]),
    calleeK:        String(row[10]),
    calleeName:     String(row[11]),
    parentCallId:   String(row[14]).trim(),
    callerIdW:      String(row[22]),
    missed:         missed,
    answered:       answered,
    talkTime:       talkTimeS,
    talkSec:        talkSec,
    _outsideWindow: false,
    _rejectReason:  null
  };
}


// -- Aggregate summary computation -------------------------------------------

function computeSummary(matches, parentMap, agentName, findAgentTalkOnParent) {
  if (!matches.length) return null;

  var totalTalk     = 0;
  var answeredCount = 0;
  var missedCount   = 0;
  var queueExts     = {};
  var hourBuckets   = {};
  var talkSeenPids  = {}; // dedupe per parent so multi-leg agents aren't double-counted

  matches.forEach(function(m) {
    if (m.answered) {
      answeredCount++;
      if (m.parentCallId && !talkSeenPids[m.parentCallId]) {
        var agentTalk = findAgentTalkOnParent(m.parentCallId, agentName);
        if (agentTalk > 0) {
          totalTalk += agentTalk;
          talkSeenPids[m.parentCallId] = true;
        }
      }
    }
    if (m.missed) missedCount++;

    var ext = null;
    var paren = m.callerI.match(/^CallQueue\s*\((\d+)\)$/i);
    if (paren) ext = paren[1];
    else if (/^\d+$/.test(m.callerI.trim())) ext = m.callerI.trim();
    if (ext) queueExts[ext] = (queueExts[ext] || 0) + 1;

    var timePart = m.startTime.split(' ')[1];
    if (timePart) {
      var hour = parseInt(timePart.split(':')[0]) || 0;
      var cstHour = (hour + 2) % 24;
      hourBuckets[cstHour] = (hourBuckets[cstHour] || 0) + 1;
    }
  });

  var hourList = Object.keys(hourBuckets)
    .map(function(h) { return { hour: parseInt(h), count: hourBuckets[h] }; })
    .sort(function(a, b) { return a.hour - b.hour; });

  var extList = Object.keys(queueExts)
    .map(function(e) { return { ext: e, count: queueExts[e] }; })
    .sort(function(a, b) { return b.count - a.count; });

  return {
    totalRows:     matches.length,
    answeredCount: answeredCount,
    missedCount:   missedCount,
    totalTalkSec:  totalTalk,
    totalTalkStr:  secToHMSLocal(totalTalk),
    queueExts:     extList,
    hourBuckets:   hourList
  };
}


// -- Group rows by parent Call ID --------------------------------------------

function groupByParent(matches, parentMap, agentName, findAgentTalkOnParent) {
  var groups  = {};
  var ordered = [];

  matches.forEach(function(m) {
    var pid = m.parentCallId || ('(none)_' + m.callId);
    if (!groups[pid]) {
      var pm = parentMap[pid];
      // Agent-specific talk time for this parent call
      var agentTalkSec = (pm && m.parentCallId)
        ? findAgentTalkOnParent(m.parentCallId, agentName) : 0;
      groups[pid] = {
        parentCallId:    m.parentCallId || '(no parent)',
        parentExists:    !!pm,
        parentTalkSec:   pm ? pm.talkSec : 0,
        parentTalkStr:   pm ? secToHMSLocal(pm.talkSec) : '',
        agentTalkSec:    agentTalkSec,
        agentTalkStr:    secToHMSLocal(agentTalkSec),
        parentWaitSec:   pm ? pm.waitSec : 0,
        parentWaitStr:   pm ? secToHMSLocal(pm.waitSec) : '',
        parentAbandoned: pm ? pm.abandoned : false,
        legs:            []
      };
      ordered.push(pid);
    }
    groups[pid].legs.push(m);
  });

  return ordered.map(function(pid) { return groups[pid]; });
}


// -- Jump to specific Raw Data row -------------------------------------------

function jumpToRawDataRow(rowNum) {
  var ss       = SpreadsheetApp.getActiveSpreadsheet();
  var rawSheet = ss.getSheetByName('Raw Data');
  if (!rawSheet) return;
  ss.setActiveSheet(rawSheet);
  rawSheet.setActiveRange(rawSheet.getRange(rowNum, 1));
}


// -- Local helpers -----------------------------------------------------------

function timeToSecLocal(val) {
  if (!val) return 0;
  var str = String(val).trim();
  if (!str || str === '0') return 0;
  var parts = str.split(':');
  if (parts.length < 2) return 0;
  return (parseInt(parts[0]) || 0) * 3600
       + (parseInt(parts[1]) || 0) * 60
       + (parseInt(parts[2]) || 0);
}

function displayToTimeSecLocal(str) {
  if (!str) return null;
  var parts = String(str).trim().split(' ');
  if (parts.length < 2) return null;
  var t = parts[1].split(':');
  if (t.length < 2) return null;
  return (parseInt(t[0]) || 0) * 3600
       + (parseInt(t[1]) || 0) * 60
       + (parseInt(t[2]) || 0);
}

function secToHMSLocal(sec) {
  var s   = Math.max(0, Math.round(sec));
  var h   = Math.floor(s / 3600);
  var m   = Math.floor((s % 3600) / 60);
  var rem = s % 60;
  return h + ':' + String(m).padStart(2,'0') + ':' + String(rem).padStart(2,'0');
}

function columnToMetric(col) {
  col = parseInt(col, 10);
  if (isNaN(col)) return null;
  if (col === 4)                              return 'queue_exts';
  if (col === 5)                              return 'unique';
  if (col === 6)                              return 'rung';
  if (col === 7)                              return 'missed';
  if (col === 8)                              return 'answered';
  if (col === 9)                              return 'ttt';
  if (col === 10)                             return 'att';
  if (col >= 11 && col <= 29)                 return 'missed';
  if (col === 30 || col === 31 || col === 32) return 'abandoned';
  return null;
}