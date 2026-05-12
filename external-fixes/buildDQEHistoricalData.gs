// ============================================================================
// buildDQEHistoricalData.gs  (CORRECTED — see CHANGES below)
// ----------------------------------------------------------------------------
// Builds per-agent DQE metrics from Raw Data and writes them to the
// "DQE Historical Data" sheet. After successful sheet write, mirrors the
// same rows to the Neon dqe_history table (Phase 3).
//
// Lives in the CDR Report Apps Script project (NOT the Department Dashboard
// project). This file is a reference copy in the dashboard repo so the fix
// can be reviewed/diffed; paste into the CDR Report project to apply.
//
// Requires: neonWrite.gs (writeDQERowsToNeon, notifyNeonWriteFailure)
//           neonBackfill.gs (parseDateForNeon)
//
// CHANGES vs. the previous version (all in buildDQEHistoricalData):
//   1) Pass 2 loop is now indexed (for i ... rather than for ... of) so we
//      can read timeVals[i]. Each pushed queueLeg now carries its own
//      talkSec (the agent's own leg.talk_time).
//   2) Pass 3's TTT/ATT block now iterates windowLegs (in-window only) and
//      attributes the agent's own leg.talkSec per parent call -- not
//      parent.talkSec, which is max across all legs and was misattributing
//      another agent's talk time to this one.
//
// Effect of the fix on Sonia (03/09/2026) for example:
//   Before:  Answered=5,  TTT=0:23:17, ATT=0:03:53
//   After:   Answered=5,  TTT=0:15:03, ATT=0:03:01
//   - TTT/ATT no longer include the after-5pm call
//   - ATT denominator is now Answered (5), not the all-hours count (6)
//   - Call 1762242119044 attributes Sonia's 0:01:01 leg to her, not the
//     other agent's 0:01:58 leg
// ============================================================================

// ── Constants (module-level so they don't re-allocate on every call) ─────────

const DQE_EXCLUDED_AGENTS = [
  "Introduction - New", "Normal Call Menu - New", "Normal Call Menu", "A_Q_CSR",
  "Backup CSR", "A_Q_Intake", "A_Q_FieldOps", "A_Q_Sales", "A_Q_Manual_Mobility",
  "UDC_A_Q_Main", "Universal Dialysis Center", "N/A", "Phone Number Phase Out",
  "Website Introduction", "Website Normal Call Menu", "Rajesh Patel", "UUC_A_Q_Main",
  "A_Q_Denials", "A_Q_Service", "Universal Urgent Care", "PAP Advt", "A_Q_PAP",
  "A_Q_Billing", "Ryan Antao", "Sunil Kurian", "A_Q_PAK", "A_Q_AfterHours",
  "Normal Call Menu Hawaii", "Introduction Hawaii", "A_Q_FieldOps_Power", "Ripal Amin",
  "A_Q_Spanish", "Shagun Shastri", "A_Q_PowerChairs", "A_Q_Resupply",
  "A_Q_BackUp_FieldOps", "A_Q_Eligibility_MM&R"
];

const DQE_CSR_QUEUES = ["A_Q_CSR", "A_Q_Intake", "Backup CSR"];

// Raw Data column indices (0-based), new CDR dataset
const DQE_C = {
  CALL_ID:     0, LEG_ID:      1, START_TIME:  2,
  DIRECTION:   5, TALK_TIME:   6, CALL_TIME:   7,
  CALLER:      8, CALLER_NAME: 9, CALLEE:      10, CALLEE_NAME: 11,
  PARENT_CALL: 14, CALLER_ID:  22,
  MISSED:      23, ABANDONED:  24, ANSWERED:   25
};

const DQE_PST_TO_CST   = 7200;
const DQE_WINDOW_START = (6 * 60 + 30) * 60;
const DQE_WINDOW_END   = 15 * 60 * 60;

const DQE_TIME_SLOTS = Array.from({ length: 19 }, (_, i) => ({
  start: 6 * 3600 + i * 1800,
  end:   6 * 3600 + i * 1800 + 1800
}));


// ── Main DQE build function ───────────────────────────────────────────────────

function buildDQEHistoricalData(rawSheet, dqeSheet) {

  // ── Helpers ────────────────────────────────────────────────────────────────

  function timeToSec(val) {
    if (!val) return 0;
    const str = String(val).trim();
    if (!str || str === '0') return 0;
    const parts = str.split(':');
    if (parts.length < 2) return 0;
    return (parseInt(parts[0]) || 0) * 3600
         + (parseInt(parts[1]) || 0) * 60
         + (parseInt(parts[2]) || 0);
  }

  function displayToTimeSec(str) {
    if (!str) return null;
    const parts = String(str).trim().split(' ');
    if (parts.length < 2) return null;
    const t = parts[1].split(':');
    if (t.length < 2) return null;
    return (parseInt(t[0]) || 0) * 3600
         + (parseInt(t[1]) || 0) * 60
         + (parseInt(t[2]) || 0);
  }

  function displayToDateStr(str) {
    if (!str) return null;
    return String(str).trim().split(' ')[0] || null;
  }

  function displayToDate(str) {
    if (!str) return null;
    const datePart = String(str).trim().split(' ')[0];
    if (!datePart) return null;
    const p = datePart.split('/');
    if (p.length < 3) return null;
    const d = new Date(parseInt(p[2]), parseInt(p[0]) - 1, parseInt(p[1]));
    return isNaN(d.getTime()) ? null : d;
  }

  function pstToCSTStr(pstSec) {
    const cst = pstSec + DQE_PST_TO_CST;
    const h   = Math.floor(cst / 3600) % 24;
    const m   = Math.floor((cst % 3600) / 60);
    const s   = cst % 60;
    return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }

  function secToHMS(sec) {
    const s   = Math.max(0, Math.round(sec));
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    return h + ':' + String(m).padStart(2,'0') + ':' + String(rem).padStart(2,'0');
  }


  // ── Read raw data ──────────────────────────────────────────────────────────

  const lastRow = rawSheet.getLastRow();
  if (lastRow < 2) { Logger.log('DQE: Raw Data is empty.'); return; }

  const data     = rawSheet.getRange(2, 1, lastRow - 1, 26).getDisplayValues();
  const timeVals = rawSheet.getRange(2, 7, lastRow - 1, 2).getDisplayValues();


  // ── Detect call date ───────────────────────────────────────────────────────

  let callDateStr = null;
  let callDateObj = null;

  for (let i = 0; i < data.length; i++) {
    const val = data[i][DQE_C.START_TIME];
    if (val && val.trim()) {
      callDateStr = displayToDateStr(val);
      callDateObj = displayToDate(val);
      if (callDateObj) break;
    }
  }

  if (!callDateObj || !callDateStr) {
    Logger.log('DQE: No valid dates found in Raw Data.');
    return;
  }


  // ── Duplicate guard ────────────────────────────────────────────────────────

  const dqeLastRow = dqeSheet.getLastRow();
  if (dqeLastRow > 1) {
    const existing = dqeSheet
      .getRange(2, 2, dqeLastRow - 1, 1)
      .getDisplayValues().flat();
    for (const val of existing) {
      if (!val || !val.trim()) continue;
      const d = displayToDate(val);
      if (d && d.getTime() === callDateObj.getTime()) {
        Logger.log('DQE: Data for ' + callDateStr + ' already exists. Skipping.');
        return;
      }
    }
  }


  // ── Pass 1: Build parentMap ────────────────────────────────────────────────
  // Aggregates parent-row metadata used downstream for wait times and
  // abandoned-call tracking. parent.talkSec is no longer used for per-
  // agent TTT (the new Pass 3 uses the agent's own leg.talkSec instead),
  // but we keep computing it here in case other callers rely on it.

  const parentMap = {};

  for (let i = 0; i < data.length; i++) {
    const row      = data[i];
    const parentId = String(row[DQE_C.PARENT_CALL]).trim();
    if (parentId !== 'N/A' && parentId !== '') continue;

    const callId    = String(row[DQE_C.CALL_ID]).trim();
    const legId     = parseInt(row[DQE_C.LEG_ID]) || 0;
    const abandoned = String(row[DQE_C.ABANDONED]).trim() === 'Abandoned';

    const talkSec = timeToSec(timeVals[i] ? timeVals[i][0] : '');
    const callSec = timeToSec(timeVals[i] ? timeVals[i][1] : '');

    if (!parentMap[callId]) {
      parentMap[callId] = { legs: [], waitSec: 0, talkSec: 0, abandoned: false };
    }
    parentMap[callId].legs.push({ legId, talkSec, callSec });
    if (abandoned) parentMap[callId].abandoned = true;
  }

  for (const entry of Object.values(parentMap)) {
    if (!entry.legs.length) continue;
    entry.legs.sort((a, b) => a.legId - b.legId);
    entry.waitSec = entry.legs[0].callSec;
    entry.talkSec = Math.max.apply(null, entry.legs.map(function(l) { return l.talkSec; }));
  }

  const abandonedParentIds = new Set(
    Object.entries(parentMap)
      .filter(([, e]) => e.abandoned && e.waitSec > 60)
      .map(([id]) => id)
  );


  // ── Pass 2: Index queue legs ───────────────────────────────────────────────
  // FIX: indexed loop so we can read timeVals[i] for each leg's own
  // talk_time (added as queueLegs[].talkSec). Pass 3 then attributes
  // talk time using the agent's own leg, not parent.talkSec.

  const queueLegs = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    const callerIdRaw = String(row[DQE_C.CALLER_ID]).trim();
    const qnMatch     = callerIdRaw.match(/(A_Q_\w+|Backup CSR)/);
    if (!qnMatch) continue;
    const queueName = qnMatch[1];

    const calleeK = String(row[DQE_C.CALLEE]).trim();
    if (/^CallForking/i.test(calleeK)) continue;

    const agentName = String(row[DQE_C.CALLEE_NAME]).trim();
    if (!agentName || agentName === 'N/A') continue;
    if (DQE_EXCLUDED_AGENTS.indexOf(agentName) !== -1) continue;

    const caller   = String(row[DQE_C.CALLER]).trim();
    let queueExt   = null;
    const parenMatch = caller.match(/^CallQueue\s*\((\d+)\)$/i);
    if (parenMatch) {
      queueExt = parenMatch[1];
    } else if (/^\d+$/.test(caller)) {
      queueExt = caller;
    }

    const parentCallId = String(row[DQE_C.PARENT_CALL]).trim();
    const callId       = String(row[DQE_C.CALL_ID]).trim();
    const missed       = String(row[DQE_C.MISSED]).trim()   === 'Missed';
    const answered     = String(row[DQE_C.ANSWERED]).trim() === 'Answered';
    const startPST     = displayToTimeSec(row[DQE_C.START_TIME]);
    const legTalkSec   = timeToSec(timeVals[i] ? timeVals[i][0] : '');

    queueLegs.push({
      agentName, queueExt, queueName,
      parentCallId, callId,
      missed, answered,
      startPST,
      talkSec: legTalkSec
    });
  }


  // ── Pass 3: Aggregate per agent ────────────────────────────────────────────

  const agentNames = Array.from(new Set(queueLegs.map(l => l.agentName)));

  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  const monthYr = monthNames[callDateObj.getMonth()] + ' ' + callDateObj.getFullYear();

  const allAbanWaits = Array.from(abandonedParentIds)
    .map(id => parentMap[id] ? parentMap[id].waitSec : 0)
    .filter(w => w > 0);
  const avgAbanWaitSec = allAbanWaits.length
    ? allAbanWaits.reduce((a,b) => a+b, 0) / allAbanWaits.length : 0;

  const csrAbanIds = new Set();
  for (const leg of queueLegs) {
    if (leg.queueName && DQE_CSR_QUEUES.indexOf(leg.queueName) !== -1
        && abandonedParentIds.has(leg.parentCallId)) {
      csrAbanIds.add(leg.parentCallId);
    }
  }
  const csrAbanWaits = Array.from(csrAbanIds)
    .map(id => parentMap[id] ? parentMap[id].waitSec : 0)
    .filter(w => w > 0);
  const csrAvgAbanWaitSec = csrAbanWaits.length
    ? csrAbanWaits.reduce((a,b) => a+b, 0) / csrAbanWaits.length : 0;

  const outputRows = [];

  for (const agentName of agentNames) {
    const legs = queueLegs.filter(l => l.agentName === agentName);

    const queueExts = Array.from(new Set(legs.map(l => l.queueExt).filter(Boolean)));
    const uniqueParentCalls = new Set(legs.map(l => l.parentCallId).filter(Boolean));

    const windowLegs = legs.filter(l =>
      l.startPST !== null && l.startPST >= DQE_WINDOW_START && l.startPST < DQE_WINDOW_END
    );

    const totalRung     = windowLegs.length;
    const totalMissed   = windowLegs.filter(l => l.missed).length;
    const totalAnswered = windowLegs.filter(l => l.answered).length;

    // FIX: TTT/ATT use windowLegs only (was: legs), and attribute the
    // agent's OWN leg.talkSec per parent (was: parent.talkSec which
    // is max across all legs and misattributes another agent's talk
    // time to this one). If an agent had multiple legs on the same
    // parent call, use their longest leg.
    const agentTalkPerParent = {};
    for (const leg of windowLegs) {
      if (!leg.parentCallId || !leg.answered) continue;
      const prev = agentTalkPerParent[leg.parentCallId] || 0;
      if (leg.talkSec > prev) {
        agentTalkPerParent[leg.parentCallId] = leg.talkSec;
      }
    }

    let tttSec = 0;
    const talkTimes = [];
    for (const parentId in agentTalkPerParent) {
      const t = agentTalkPerParent[parentId];
      if (t > 0) {
        tttSec += t;
        talkTimes.push(t);
      }
    }

    const attSec = talkTimes.length
      ? talkTimes.reduce((a,b) => a+b, 0) / talkTimes.length : 0;

    const slotValues = DQE_TIME_SLOTS.map(slot => {
      const hits = windowLegs.filter(l =>
        l.missed && l.startPST !== null && l.startPST >= slot.start && l.startPST < slot.end
      );
      return hits.length ? hits.map(l => pstToCSTStr(l.startPST)).join(',') : '';
    });

    const agentParentIds    = new Set(legs.map(l => l.parentCallId).filter(Boolean));
    const agentAbandonedIds = Array.from(agentParentIds).filter(id => abandonedParentIds.has(id));
    const abanMissedLegs = legs.filter(l =>
      l.missed && l.parentCallId && abandonedParentIds.has(l.parentCallId)
    );

    const abanParentStr   = agentAbandonedIds.join(',');
    const abanMissedIds   = Array.from(new Set(abanMissedLegs.map(l => l.callId))).join(',');
    const abanMissedTimes = Array.from(new Set(
      abanMissedLegs
        .map(l => l.startPST !== null ? pstToCSTStr(l.startPST) : '')
        .filter(Boolean)
    )).join(',');

    outputRows.push([
      monthYr,                                  // A  Month Year
      callDateStr,                              // B  Date
      agentName,                                // C  Agent Name
      queueExts.join(','),                      // D  Queue Extensions
      uniqueParentCalls.size,                   // E  Total Unique
      totalRung,                                // F  Total Rung
      totalMissed,                              // G  Total Missed
      totalAnswered,                            // H  Total Answered
      secToHMS(tttSec),                         // I  TTT
      secToHMS(Math.round(attSec)),             // J  ATT
      ...slotValues,                            // K-AC (19 cols)
      abanParentStr,                            // AD Abandoned Parent IDs
      abanMissedIds,                            // AE Abandoned Missed Leg IDs
      abanMissedTimes,                          // AF Abandoned Missed Leg Times
      secToHMS(Math.round(avgAbanWaitSec)),     // AG Avg Abd Wait Time
      secToHMS(Math.round(csrAvgAbanWaitSec))   // AH CSR Avg Abd Wait Time
    ]);
  }

  if (!outputRows.length) {
    Logger.log('DQE: No agent rows produced for ' + callDateStr + '.');
    return;
  }

  // Force col D to plain text so "1003,183" isn't reformatted as a number
  dqeSheet.getRange(1, 4, dqeSheet.getMaxRows(), 1).setNumberFormat('@');

  const firstBlank = dqeSheet.getLastRow() + 1;
  dqeSheet.getRange(firstBlank, 1, outputRows.length, outputRows[0].length).setValues(outputRows);

  const newLastRow = dqeSheet.getLastRow();
  if (newLastRow > 2) {
    dqeSheet.getRange(2, 1, newLastRow - 1, dqeSheet.getLastColumn())
            .sort({ column: 2, ascending: true });
  }

  Logger.log('DQE: Wrote ' + outputRows.length + ' agent rows for ' + callDateStr + '.');

  // ── Phase 3 — Mirror to Neon ────────────────────────────────────────────────
  // Failure is logged + emailed via notifyNeonWriteFailure; sheet write stands.
  try {
    const neonRows = outputRows.map(function(r) {
      return {
        monthYear:        r[0],
        callDate:         r[1],
        agentName:        r[2],
        queueExtensions:  r[3],
        totalUnique:      r[4],
        totalRung:        r[5],
        totalMissed:      r[6],
        totalAnswered:    r[7],
        ttt:              r[8],
        att:              r[9],
        slots:            r.slice(10, 29),
        abParentIds:      r[29],
        abMissedIds:      r[30],
        abMissedTimes:    r[31],
        avgAbdWait:       r[32],
        csrAvgAbdWait:    r[33]
      };
    });
    writeDQERowsToNeon(neonRows);
    Logger.log('DQE: Mirrored ' + neonRows.length + ' rows to Neon.');
  } catch (neonErr) {
    notifyNeonWriteFailure('buildDQEHistoricalData (' + callDateStr + ')', neonErr.message);
  }
}


// ── Test function ─────────────────────────────────────────────────────────────

function testDQEBuild() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName('Raw Data');
  const dqeSheet = ss.getSheetByName('DQE Historical Data');

  if (!rawSheet) { Logger.log('ERROR: "Raw Data" sheet not found.');            return; }
  if (!dqeSheet) { Logger.log('ERROR: "DQE Historical Data" sheet not found.'); return; }

  buildDQEHistoricalData(rawSheet, dqeSheet);
}
