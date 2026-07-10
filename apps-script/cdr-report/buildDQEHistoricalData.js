// ============================================================================
// buildDQEHistoricalData.gs
// ----------------------------------------------------------------------------
// Builds per-agent DQE metrics from Raw Data and writes them to the
// "DQE Historical Data" sheet. After successful sheet write, mirrors the
// same rows to the Neon dqe_history table (Phase 3).
//
// Lives in the CDR Report Apps Script project.
// Requires: neonWrite.gs (writeDQERowsToNeon, notifyNeonWriteFailure,
//           parseDateForNeon — inlined in neonWrite.gs per INV-16)
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


// ── F2 dup-guard re-mirror helper ─────────────────────────────────────────────
// Re-mirrors the already-present DQE Historical Data rows for one date into
// Neon's dqe_history. Called from the duplicate guard so a date whose first
// import couldn't reach Neon (transient outage) isn't left permanently stale.
// The sheet is authoritative; this just re-pushes what's already there, using
// the SAME positional column->field map the main build's Neon mirror uses.
//
// INV-02: read via getDisplayValues so the duration columns (I/J/AG/AH) come
// back as H:MM:SS strings -- getValues would apply the spreadsheet-vs-script
// TZ shift to those cells. The numeric count columns (E-H) are Number()-coerced
// because display values are strings. Idempotent via writeDQERowsToNeon's
// ON CONFLICT DO UPDATE.
function remirrorExistingDqeDate_(dqeSheet, offsets, callDateStr) {
  if (!offsets || !offsets.length) return;
  const firstRow = 2 + offsets[0];                       // sheet row of first match
  const lastRow  = 2 + offsets[offsets.length - 1];      // sheet row of last match
  const block = dqeSheet.getRange(firstRow, 1, lastRow - firstRow + 1, 34).getDisplayValues();
  const matched = {};
  offsets.forEach(function (o) { matched[o] = true; });   // absolute data-region offsets
  // F-16: route the coercion-prone abandoned ID/time cells (AD/AE/AF)
  // through the SAME sanitizer every other sheet->Neon path uses (the
  // backfills + the deferred mirror), so a non-force re-import of an old
  // date whose sheet rows still carry pre-protection coerced cells writes
  // the #REBUILD sentinel / recovered value instead of overwriting clean
  // dqe_history values with coerced garbage via ON CONFLICT DO UPDATE.
  // typeof-guarded because the sanitizer lives outside this INV-16 pair:
  // neonbackfill.js (cdr-report) / NeonMirror.js (cdr-import) -- present
  // in BOTH projects. Null (genuinely empty) coerces to '' to match what
  // the inline daily writer sends for empty cells.
  const saneAb = (typeof sanitizeAbandonedCellForNeon_ === 'function')
    ? function (v) { const r = sanitizeAbandonedCellForNeon_(v); return r == null ? '' : r; }
    : function (v) { return v; };
  // F-51: same treatment for the 19 slot columns (they coerce like AF).
  const saneSlot = (typeof sanitizeSlotCellForNeon_ === 'function')
    ? function (v) { const r = sanitizeSlotCellForNeon_(v); return r == null ? '' : r; }
    : function (v) { return v; };
  const neonRows = [];
  for (let i = 0; i < block.length; i++) {
    // The [first..last] window can include other-date stragglers if the
    // sheet wasn't sorted; only re-push rows that actually matched the date.
    if (!matched[offsets[0] + i]) continue;
    const r = block[i];
    neonRows.push({
      monthYear:       r[0],
      callDate:        r[1],
      agentName:       r[2],
      queueExtensions: r[3],
      totalUnique:     Number(r[4]) || 0,
      totalRung:       Number(r[5]) || 0,
      totalMissed:     Number(r[6]) || 0,
      totalAnswered:   Number(r[7]) || 0,
      ttt:             r[8],
      att:             r[9],
      slots:           r.slice(10, 29).map(saneSlot),   // F-51
      abParentIds:     saneAb(r[29]),
      abMissedIds:     saneAb(r[30]),
      abMissedTimes:   saneAb(r[31]),
      avgAbdWait:      r[32],
      csrAvgAbdWait:   r[33]
    });
  }
  if (!neonRows.length) return;
  // IMP-5: the re-mirror carries the COMPLETE sheet set for this date --
  // authoritative replace clears phantom Neon rows the sheet no longer has.
  const res = writeDQERowsToNeon(neonRows, { authoritative: true });
  if (res && res.skipped) {
    Logger.log('DQE: dup-guard re-mirror skipped (' + res.skipped
      + ' rows — Neon unreachable) for ' + callDateStr + '.');
  } else {
    Logger.log('DQE: dup-guard re-mirrored ' + neonRows.length
      + ' existing rows to Neon for ' + callDateStr + '.');
  }
}


// ── Main DQE build function ───────────────────────────────────────────────────

function buildDQEHistoricalData(rawSheet, dqeSheet, opts) {
  // Wall-clock start used by the Pipeline Health log entry below.
  const __pipelineStartMs = Date.now();

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Roster-driven agent-name canonicalization. The CDR feed sometimes
  // spells an agent's name without their parenthesized nickname (e.g.
  // "Roman Robin Paulose" instead of "Roman (Robin) Paulose"), which
  // produces split daily rows for the same person. We treat the
  // roster sheet (DO NOT EDIT! in the same spreadsheet) as the source
  // of canonical names and rewrite any raw name whose paren-stripped
  // form unambiguously matches a roster entry.
  //
  // Edge cases:
  //   - Raw name already matches a roster entry exactly  -> no-op.
  //   - Stripped form matches >1 roster entry            -> no-op
  //     (ambiguous; preserve raw rather than guess).
  //   - Raw name not on roster at all                    -> no-op
  //     (new hire not yet rostered; same behavior as before).
  //
  // Soft coupling: this read pulls from a sheet whose schema is owned
  // by the Department Dashboard project (DO NOT EDIT!, agent cells
  // formatted "Name, ext1, ext2"). Keep in mind if changing the
  // roster layout there.
  const ROSTER_CANONICAL = loadRosterCanonicalNames_(rawSheet);

  function stripParens_(name) {
    return String(name || '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  }

  function canonicalizeAgentName(rawName) {
    if (!rawName) return rawName;
    // Admin-curated overrides (Agent Alias Overrides sheet) take
    // precedence over both the roster-exact match and the paren
    // strip. Lets an admin rename a typo-orphan like "Sarah Q. Smith"
    // -> "Sarah Smith" without having to add the orphan form into
    // the roster cell. Loaded inside ROSTER_CANONICAL.aliasMap.
    if (ROSTER_CANONICAL.aliasMap && ROSTER_CANONICAL.aliasMap[rawName]) {
      return ROSTER_CANONICAL.aliasMap[rawName];
    }
    if (ROSTER_CANONICAL.canonicalSet[rawName]) return rawName;
    const stripped = stripParens_(rawName);
    if (!stripped) return rawName;
    const matches = ROSTER_CANONICAL.strippedMap[stripped];
    if (matches && matches.length === 1) return matches[0];
    return rawName;
  }

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

  // F2: refuse to write when the build's detected date disagrees with the
  // date the caller expected. The force re-import deletes DQE rows for the
  // IMPORTER's date (the source sheet name, via deleteHistoricalRowsForDate
  // matching col B by toDateString); this build independently re-derives its
  // date from Raw Data's first valid START_TIME. If a stray carry-over leg
  // makes them disagree, writing would stamp rows under a DIFFERENT day than
  // was just cleared -- leaving the intended day's old rows un-deleted AND a
  // mis-dated duplicate set (the dup-guard below keys off THIS build's date,
  // so it can't catch it). opts.expectedDate is a Date; we compare calendar
  // day via toDateString (same basis the deletion uses). Callers that derive
  // their own date -- the standalone runDailyDQEBuild_ / testDQEBuild trigger
  // -- omit opts.expectedDate, so their behavior is unchanged.
  if (opts && opts.expectedDate) {
    const exp = opts.expectedDate;
    const expDayOk = exp && typeof exp.toDateString === 'function'
                  && !isNaN(exp.getTime());
    if (!expDayOk || exp.toDateString() !== callDateObj.toDateString()) {
      const expLabel = expDayOk ? exp.toDateString() : String(exp);
      Logger.log('DQE: expected date ' + expLabel + ' but Raw Data resolves to '
        + callDateStr + ' -- refusing to write (avoids a mis-dated/duplicate set).');
      try {
        logPipelineHealth_(dqeSheet.getParent(), {
          step:       'buildDQE',
          status:     'failure',
          rows:       0,
          durationMs: Date.now() - __pipelineStartMs,
          notes:      'date mismatch: expected=' + expLabel + ' rawData=' + callDateStr
                    + ' -- build skipped, no rows written',
        });
      } catch (pipelineLogErr) {
        Logger.log('buildDQE: pipeline-health log failed (non-fatal): %s', pipelineLogErr);
      }
      // IMP-7: THROW rather than silently return. On the force re-import
      // path the caller has ALREADY DELETED the expected date's DQE rows,
      // so a silent refusal leaves that date's data GONE while the daily
      // block logs `processIntegratedHistory:DQE` success rows:0 and no
      // email fires (notifyDqeBuildFailure_ requires a throw). Throwing
      // routes the refusal into each caller's existing failure plumbing:
      // daily -> `:DQE` failure row + notifyDqeBuildFailure_ email;
      // bulk -> `bulkBackfill:DQE` failure row, loop continues (no
      // per-date email, by design). The standalone cdr-report trigger
      // omits expectedDate and never reaches this branch.
      throw new Error('DQE build refused: expected ' + expLabel + ' but Raw Data resolves to '
        + callDateStr + ' -- no rows written. If this was a force re-import, the expected '
        + 'date\'s DQE rows were already cleared: fix Raw Data (stray carry-over leg?) and '
        + 'force re-import that date to rebuild it.');
    }
  }


  // ── Duplicate guard ────────────────────────────────────────────────────────

  const dqeLastRow = dqeSheet.getLastRow();
  if (dqeLastRow > 1) {
    const existing = dqeSheet
      .getRange(2, 2, dqeLastRow - 1, 1)
      .getDisplayValues().flat();
    const matchedOffsets = [];   // 0-based offsets into the data region (sheet row 2 + offset)
    for (let i = 0; i < existing.length; i++) {
      const val = existing[i];
      if (!val || !val.trim()) continue;
      const d = displayToDate(val);
      if (d && d.getTime() === callDateObj.getTime()) matchedOffsets.push(i);
    }
    if (matchedOffsets.length) {
      Logger.log('DQE: Data for ' + callDateStr + ' already exists. Skipping rebuild.');
      // F2: the date is already in the SHEET, but a prior run's Neon mirror
      // may have failed (Neon unreachable that day) -- in which case the
      // dup-guard would otherwise leave dqe_history permanently stale, since
      // a non-force re-import bails here before the mirror runs. Re-mirror the
      // existing sheet rows so a transient outage self-heals on the next
      // import of the same date. Best-effort + idempotent (writeDQERowsToNeon
      // upserts ON CONFLICT); skipped on the bulk path (opts.skipNeon defers
      // the mirror to backfillDQEHistoryUpsert()).
      if (!(opts && opts.skipNeon)) {
        try { remirrorExistingDqeDate_(dqeSheet, matchedOffsets, callDateStr); }
        catch (e) {
          Logger.log('DQE: dup-guard re-mirror failed (best-effort): '
            + (e && e.message ? e.message : e));
        }
      }
      return;
    }
  }


  // ── Pass 1: Build parentMap ────────────────────────────────────────────────
  // Each parent leg captures calleeName (col L) so Pass 3 can look up the
  // specific leg where THIS agent talked, instead of taking the max across
  // all legs (which incorrectly attributed other agents' talk time).

  const parentMap = {};

  for (let i = 0; i < data.length; i++) {
    const row      = data[i];
    const parentId = String(row[DQE_C.PARENT_CALL]).trim();
    if (parentId !== 'N/A' && parentId !== '') continue;

    const callId      = String(row[DQE_C.CALL_ID]).trim();
    const legId       = parseInt(row[DQE_C.LEG_ID]) || 0;
    const abandoned   = String(row[DQE_C.ABANDONED]).trim() === 'Abandoned';
    const calleeName  = canonicalizeAgentName(String(row[DQE_C.CALLEE_NAME]).trim());

    const talkSec = timeToSec(timeVals[i] ? timeVals[i][0] : '');
    const callSec = timeToSec(timeVals[i] ? timeVals[i][1] : '');
    const startPST = displayToTimeSec(row[DQE_C.START_TIME]);

    if (!parentMap[callId]) {
      parentMap[callId] = { legs: [], waitSec: 0, talkSec: 0, abandoned: false };
    }
    // Store the per-leg `abandoned` flag too. IVR-routed calls have
    // the actual abandoned event on leg 3+ (after menu navigation),
    // not leg 0 -- so we need to know which leg was abandoned, not
    // just whether ANY leg of the parent was. See finalization
    // below for how this drives waitSec. Also store startPST so we
    // can timestamp queue-only abandoned events (no agent rang).
    parentMap[callId].legs.push({ legId, talkSec, callSec, calleeName, abandoned, startPST });
    if (abandoned) parentMap[callId].abandoned = true;
  }

  for (const entry of Object.values(parentMap)) {
    if (!entry.legs.length) continue;
    entry.legs.sort((a, b) => a.legId - b.legId);
    // waitSec semantics: the wait time of the *abandoned event*, not
    // necessarily leg 0. For IVR-routed calls, leg 0 is the menu
    // interaction (typically <15s) while the queue-ring leg that
    // actually got abandoned is leg 3+ (with the real hold duration).
    // Single-leg / non-routed cases: legs.find returns leg 0 = same
    // as before; no behavior change for that shape.
    const abandonedLeg = entry.legs.find(function (l) { return l.abandoned; });
    entry.waitSec = abandonedLeg ? abandonedLeg.callSec : entry.legs[0].callSec;
  }

  const abandonedParentIds = new Set(
    Object.entries(parentMap)
      .filter(([, e]) => e.abandoned && e.waitSec > 60)
      .map(([id]) => id)
  );


  // ── Pass 2: Index queue legs ───────────────────────────────────────────────
  // Note: queue legs themselves don't carry talk-time duration (col G = 0).
  // The agent's actual conversation duration lives on a separate parent-level
  // leg where col L = agent name — captured in Pass 1's parentMap. Pass 3
  // looks up the right talk time by matching agent name on parent legs.

  // F9: count queue legs whose START_TIME is present but UNPARSEABLE (a CDR
  // timestamp-format drift). Such legs get startPST=null and are silently
  // dropped from windowLegs -- i.e. from the in-window Rung/Missed/Answered +
  // slot counts -- with no prior signal. Surfaced in the final buildDQE
  // Pipeline Health note so a format drift is visible, not silent shrinkage.
  let unparsedStartCount = 0;
  const queueLegs = [];

  for (let i = 0; i < data.length; i++) {
    const row         = data[i];
    const callerIdRaw = String(row[DQE_C.CALLER_ID]).trim();
    const qnMatch     = callerIdRaw.match(/(A_Q_\w+|Backup CSR)/);
    if (!qnMatch) continue;
    const queueName = qnMatch[1];

    const calleeK = String(row[DQE_C.CALLEE]).trim();
    if (/^CallForking/i.test(calleeK)) continue;

    const agentName = canonicalizeAgentName(String(row[DQE_C.CALLEE_NAME]).trim());
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
    const startRaw     = row[DQE_C.START_TIME];
    const startPST     = displayToTimeSec(startRaw);
    if (startPST === null && startRaw && String(startRaw).trim()) unparsedStartCount++;  // F9

    queueLegs.push({
      agentName, queueExt, queueName,
      parentCallId, callId,
      missed, answered,
      startPST
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

    const windowLegs = legs.filter(l =>
      l.startPST !== null && l.startPST >= DQE_WINDOW_START && l.startPST < DQE_WINDOW_END
    );

    const uniqueParentCalls = new Set(windowLegs.map(l => l.parentCallId).filter(Boolean));

    const totalRung     = windowLegs.length;
    const totalMissed   = windowLegs.filter(l => l.missed).length;
    const totalAnswered = windowLegs.filter(l => l.answered).length;

    // TTT/ATT computation — fixes three bugs from the prior implementation:
    //   - Bug 1: iterated `legs` (all-day) instead of `windowLegs`
    //   - Bug 2: ATT denominator was unique answered parents across all hours
    //   - Bug 3: used parent.talkSec (max across all legs of all agents on
    //            the parent) instead of the agent's own leg's talk time
    //
    // The agent's actual conversation duration lives on a parent-level leg
    // where col L matches the agent's name. We look that up for each parent
    // call this agent had an answered queue leg on within the window.

    function findAgentTalkOnParent(parentCallId, agent) {
      const parent = parentMap[parentCallId];
      if (!parent) return 0;
      // If an agent has multiple parent legs on the same call, take the
      // longest (handles rare transfer-back or re-pickup scenarios).
      let maxTalk = 0;
      for (const leg of parent.legs) {
        if (leg.calleeName === agent && leg.talkSec > maxTalk) {
          maxTalk = leg.talkSec;
        }
      }
      return maxTalk;
    }

    const agentTalkPerParent = {};
    for (const leg of windowLegs) {
      if (!leg.parentCallId || !leg.answered) continue;
      const t = findAgentTalkOnParent(leg.parentCallId, agentName);
      if (t > (agentTalkPerParent[leg.parentCallId] || 0)) {
        agentTalkPerParent[leg.parentCallId] = t;
      }
    }
    let tttSec = 0;
    const talkTimes = [];
    for (const pid in agentTalkPerParent) {
      const t = agentTalkPerParent[pid];
      if (t > 0) { tttSec += t; talkTimes.push(t); }
    }
    const attSec = talkTimes.length
      ? talkTimes.reduce((a, b) => a + b, 0) / talkTimes.length : 0;

    const slotValues = DQE_TIME_SLOTS.map(slot => {
      const hits = windowLegs.filter(l =>
        l.missed && l.startPST !== null && l.startPST >= slot.start && l.startPST < slot.end
      );
      return hits.length ? hits.map(l => pstToCSTStr(l.startPST)).join(',') : '';
    });

    const agentParentIds    = new Set(legs.map(l => l.parentCallId).filter(Boolean));
    const agentAbandonedIds = Array.from(agentParentIds).filter(id => abandonedParentIds.has(id));
    // AD/AE/AF are consumed POSITIONALLY by the dashboard's Missed Calls
    // report: AF[i] is the i-th abandoned missed-ring time and AD[i] is
    // its parent call id -- the {time -> parent} pairing behind each 🚨
    // timestamp's "↳ path" journey drill. Build all three columns from
    // the SAME chronologically-sorted missed-leg list so the pairing is
    // exact: one AD/AE/AF entry per missed leg on an abandoned parent
    // (a parent that re-rang this agent appears once per ring -- the
    // read side dedups ids for its unique-abandoned counts). Legs with
    // an unparseable start time can't render a timestamp, so they're
    // excluded from the paired section. Abandoned parents the agent
    // touched WITHOUT a pairable missed leg (answered/unflagged leg, or
    // unparseable time) are APPENDED to AD after the paired section --
    // no AE/AF partner -- so the dept-wide unique-abandoned counts
    // (which read AD as a set) keep the exact same id set as before.
    const abanMissedLegs = legs
      .filter(l =>
        l.missed && l.parentCallId && abandonedParentIds.has(l.parentCallId)
        && l.startPST !== null
      )
      .sort((a, b) => a.startPST - b.startPST);

    const pairedParentIds   = abanMissedLegs.map(l => l.parentCallId);
    const pairedParentSet   = new Set(pairedParentIds);
    const unpairedParentIds = agentAbandonedIds.filter(id => !pairedParentSet.has(id));

    const abanParentStr   = pairedParentIds.concat(unpairedParentIds).join(',');
    const abanMissedIds   = abanMissedLegs.map(l => l.callId).join(',');
    const abanMissedTimes = abanMissedLegs.map(l => pstToCSTStr(l.startPST)).join(',');

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


  // ── Pass 4: Queue-only abandoned sentinel rows ─────────────────────────────
  // An abandoned call can hit a queue without ringing any agent (all agents
  // busy). These events have no agent row, so they're invisible to the
  // dashboard via the per-agent path. We emit ONE sentinel row per queue
  // per day with:
  //   - Col C (Agent Name)   = the queue name itself ("A_Q_CSR", "Backup CSR")
  //   - Col D (Queue Exts)   = the queue's extensions (so dept-by-extension
  //                            filtering in the dashboard still works)
  //   - Cols K-AC            = the no-ring abandoned timestamps bucketed
  //                            into 30-min slots (CST), same shape as agent
  //                            rows so the Missed Calls Report reads them
  //                            with the same code path
  //   - Col AD               = the no-ring parent call IDs (drives unique-
  //                            call counts in the dashboard's summary)
  //   - Col AF               = same timestamps as K-AC flattened (all of
  //                            them are abandoned by definition, so the
  //                            existing abandoned-cross-reference logic
  //                            in the dashboard naturally flags them)
  //   - Cols E-J / AG-AH     = 0 / "0:00:00" (these are queue-level, not
  //                            agent-level)
  //
  // Sentinel rows are filtered out by the main dashboard's per-agent table
  // (Data.gs) and by the whyNoMatches diagnostic (Diagnostics.gs) via an
  // agent-name regex; only the Missed Calls Report consumes them as queue-
  // only entries.

  function buildQueueNameToExts_() {
    const map = {};

    // Primary: today's queue legs already give us queue-name -> extension
    // pairs we actually observed in raw data.
    queueLegs.forEach(function (leg) {
      if (leg.queueName && leg.queueExt) {
        if (!map[leg.queueName]) map[leg.queueName] = {};
        map[leg.queueName][leg.queueExt] = true;
      }
    });

    // Fallback: read DO NOT EDIT! sheet's left block (cols A-B) so we have
    // extension info even for queues with zero agent rings today.
    try {
      const ss = dqeSheet.getParent();
      const lookup = ss.getSheetByName('DO NOT EDIT!');
      if (lookup) {
        const lastRow = lookup.getLastRow();
        if (lastRow >= 2) {
          const rows = lookup.getRange(2, 1, lastRow - 1, 2).getValues();
          rows.forEach(function (r) {
            const qn  = String(r[0]).trim();
            const exs = String(r[1]).trim();
            if (!qn || !exs) return;
            if (!map[qn]) map[qn] = {};
            exs.split(',').forEach(function (e) {
              const t = e.trim();
              if (t) map[qn][t] = true;
            });
          });
        }
      }
    } catch (e) {
      Logger.log('DQE: queue->ext lookup from DO NOT EDIT! failed: ' + e.message);
    }

    const out = {};
    for (const qn in map) {
      out[qn] = Object.keys(map[qn]).sort();
    }
    return out;
  }

  const queueNameToExts = buildQueueNameToExts_();

  // queueName -> { parentIds: Set, events: [{ startPST, callSec }] }
  const queueOnlyByQueue = {};

  abandonedParentIds.forEach(function (parentId) {
    const parent = parentMap[parentId];
    if (!parent || !parent.legs.length) return;

    // Which queue(s) did this parent hit? Collected from parent legs
    // whose calleeName contains a queue identifier (A_Q_* or
    // "Backup CSR"). The regex is intentionally NOT anchored so we
    // match even when the calleeName has surrounding text (display
    // names, domain suffixes, etc.) -- same shape as Pass 2's
    // queue-name detection on caller_id.
    const queueNamesHit = {};   // queueName -> the parent leg that hit it
    parent.legs.forEach(function (l) {
      const m = String(l.calleeName || '').match(/(A_Q_\w+|Backup CSR)/);
      if (!m) return;
      const name = m[1];
      // Keep the FIRST leg that hit this queue (lowest legId, since
      // parent.legs was sorted in the Pass 1 finalization step).
      if (!queueNamesHit[name]) queueNamesHit[name] = l;
    });
    if (!Object.keys(queueNamesHit).length) return;

    // For each queue hit by this parent, did any agent leg ring it?
    // queueLegs is the agent-ring list (one entry per ring event).
    const ringedQueues = {};
    queueLegs.forEach(function (l) {
      if (l.parentCallId === parentId && l.queueName) {
        ringedQueues[l.queueName] = true;
      }
    });

    Object.keys(queueNamesHit).forEach(function (queueName) {
      if (ringedQueues[queueName]) return;  // already covered by per-agent rows

      // Use the timestamp + wait of the parent leg that hit THIS
      // queue, not the abandoned leg. A multi-queue call (CSR ->
      // Backup CSR) needs each queue's sentinel timestamped at its
      // own ring time so chart placement is correct.
      const queueLeg = queueNamesHit[queueName];
      if (queueLeg.startPST == null) return;

      if (!queueOnlyByQueue[queueName]) {
        queueOnlyByQueue[queueName] = { parentIds: [], events: [] };
      }
      queueOnlyByQueue[queueName].parentIds.push(parentId);
      queueOnlyByQueue[queueName].events.push({
        startPST: queueLeg.startPST,
        callSec:  queueLeg.callSec
      });
    });
  });

  Object.keys(queueOnlyByQueue).sort().forEach(function (queueName) {
    const data = queueOnlyByQueue[queueName];
    if (!data.events.length) return;

    const exts = queueNameToExts[queueName] || [];

    const slotValues = DQE_TIME_SLOTS.map(function (slot) {
      const hits = data.events.filter(function (e) {
        return e.startPST !== null && e.startPST >= slot.start && e.startPST < slot.end;
      });
      return hits.length ? hits.map(function (e) { return pstToCSTStr(e.startPST); }).join(',') : '';
    });

    const allTimesCST = data.events
      .filter(function (e) { return e.startPST !== null; })
      .map(function (e) { return pstToCSTStr(e.startPST); })
      .join(',');

    outputRows.push([
      monthYr,                                  // A  Month Year
      callDateStr,                              // B  Date
      queueName,                                // C  Agent Name (queue sentinel)
      exts.join(','),                           // D  Queue Extensions
      0,                                        // E  Total Unique
      0,                                        // F  Total Rung
      0,                                        // G  Total Missed
      0,                                        // H  Total Answered
      '0:00:00',                                // I  TTT
      '0:00:00',                                // J  ATT
      ...slotValues,                            // K-AC (19 cols)
      data.parentIds.join(','),                 // AD Abandoned Parent IDs
      '',                                       // AE Abandoned Missed Leg IDs (n/a for queue-only)
      allTimesCST,                              // AF Abandoned Missed Leg Times
      '0:00:00',                                // AG Avg Abd Wait Time (queue-level not meaningful here)
      '0:00:00'                                 // AH CSR Avg Abd Wait Time
    ]);
  });

  if (!outputRows.length) {
    Logger.log('DQE: No agent rows produced for ' + callDateStr + '.');
    return;
  }

  // Force col D to plain text so "1003,183" isn't reformatted as a number
  dqeSheet.getRange(1, 4, dqeSheet.getMaxRows(), 1).setNumberFormat('@');

  // Same treatment for cols AD/AE/AF: these store comma-joined parent
  // IDs / leg IDs / timestamps. Without plain-text format, Sheets
  // coerces multi-value strings like "1776834710895,1776834710896" to
  // a Number, loses precision past 2^53, and re-renders the value with
  // thousand separators -- which downstream code then splits on the
  // commas as if they were ID separators. Single-value rows happened
  // to escape the bug.
  dqeSheet.getRange(1, 30, dqeSheet.getMaxRows(), 3).setNumberFormat('@');

  // Same category as AD-AF: cols K-AC (the 19 half-hour slot columns) carry
  // comma-joined CST missed-time strings. A SINGLE-timestamp cell (e.g.
  // "10:23:33") gets coerced by Sheets into a time VALUE unless the column is
  // plain text -- it then renders as the epoch date "12/30/1899" (or a raw
  // serial decimal), and getDisplayValues returns that garbage instead of the
  // time. Multi-value cells escape (not a parseable single time). Plain-text
  // the whole slot block so single- and multi-value rows are both stored as text.
  dqeSheet.getRange(1, 11, dqeSheet.getMaxRows(), 19).setNumberFormat('@');

  const firstBlank = dqeSheet.getLastRow() + 1;
  // The whole-column setNumberFormat('@') calls above only reach the prior
  // getMaxRows(); an append that SPILLS PAST it (the sheet auto-expands during
  // setValues) would land multi-value AD/AE/AF + K-AC cells in default-formatted
  // rows and re-coerce them (the abParentIds / slot-timestamp coercion bug).
  // Plain-text the EXACT rows we're about to write first, so spilled rows are
  // protected too (getRange auto-expands the sheet, then formats).
  dqeSheet.getRange(firstBlank, 4,  outputRows.length, 1).setNumberFormat('@');
  dqeSheet.getRange(firstBlank, 11, outputRows.length, 19).setNumberFormat('@');
  dqeSheet.getRange(firstBlank, 30, outputRows.length, 3).setNumberFormat('@');
  dqeSheet.getRange(firstBlank, 1, outputRows.length, outputRows[0].length).setValues(outputRows);

  const newLastRow = dqeSheet.getLastRow();
  if (newLastRow > 2) {
    dqeSheet.getRange(2, 1, newLastRow - 1, dqeSheet.getLastColumn())
            .sort({ column: 2, ascending: true });
  }

  Logger.log('DQE: Wrote ' + outputRows.length + ' agent rows for ' + callDateStr + '.');

  // ── Phase 3 — Mirror to Neon ────────────────────────────────────────────────
  // Failure is logged + emailed via notifyNeonWriteFailure; sheet write stands.
  // skipNeon (bulk rebuild path, opts.skipNeon=true): defer the per-date Neon
  // mirror -- its JDBC latency is the dominant per-date cost in a force-rebuild.
  // The bulk caller runs ONE batched DO-UPDATE pass (backfillDQEHistoryUpsert,
  // cdr-report) after the whole rebuild instead. Daily / standalone callers
  // omit opts so the real-time mirror is unchanged.
  if (opts && opts.skipNeon) {
    Logger.log('DQE: skipNeon=true — deferring Neon mirror (run '
      + 'backfillDQEHistoryUpsert() after the rebuild).');
  } else {
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
    // IMP-5: the build's rows are the COMPLETE set for callDate --
    // authoritative replace, so a force re-import whose rebuilt set is a
    // SUBSET (e.g. an agent consolidated under an alias) removes the
    // stale rows from dqe_history instead of leaving a phantom split.
    var neonResult = writeDQERowsToNeon(neonRows, { authoritative: true });
    if (neonResult && neonResult.skipped) {
      Logger.log('DQE: Neon write skipped (%s rows — Neon unreachable).', neonResult.skipped);
      // F4: a mirror-only skip (Neon unreachable, sheet write OK) does NOT
      // throw, so the daily toast's unified Neon flag can read "Neon ✓" while
      // dqe_history wasn't refreshed. Per CLAUDE.md the DQE mirror status is
      // intentionally NOT folded into that toast -- instead it's meant to
      // surface in Pipeline Health. Log that row here so the divergence is
      // actually visible to admins (and the F2 re-mirror heals it next run).
      try {
        logPipelineHealth_(dqeSheet.getParent(), {
          step:       'buildDQE:neon',
          status:     'failure',
          rows:       neonResult.skipped,
          durationMs: null,
          notes:      'callDate=' + callDateStr + ' | Neon unreachable; dqe_history NOT refreshed',
        });
      } catch (pipelineLogErr) { /* best-effort */ }
    } else {
      Logger.log('DQE: Mirrored ' + neonRows.length + ' rows to Neon.');
    }
  } catch (neonErr) {
    notifyNeonWriteFailure('buildDQEHistoricalData (' + callDateStr + ')', neonErr.message);
    // F4: also leave a Pipeline Health row (see the skip branch above) so a
    // DQE->Neon write error is visible in the admin panel, not only in the
    // notify email -- the toast's Neon flag stays green for this case.
    try {
      logPipelineHealth_(dqeSheet.getParent(), {
        step:       'buildDQE:neon',
        status:     'failure',
        rows:       null,
        durationMs: null,
        notes:      'callDate=' + callDateStr + ' | Neon write error: ' + neonErr.message,
      });
    } catch (pipelineLogErr) { /* best-effort */ }
  }
  }  // end else (skipNeon)

  // Pipeline Health: append a success row so the admin can see at a
  // glance "the daily DQE rebuild ran for 2026-05-19 and wrote 240
  // rows in 4.2s". Best-effort; a logging failure must not affect
  // the build's success.
  try {
    logPipelineHealth_(dqeSheet.getParent(), {
      step:       'buildDQE',
      status:     'success',
      rows:       outputRows.length,
      durationMs: Date.now() - __pipelineStartMs,
      notes:      'callDate=' + callDateStr + (unparsedStartCount
                    ? ' | WARN: ' + unparsedStartCount + ' leg(s) had unparseable START_TIME (dropped from in-window counts)'
                    : ''),
    });
  } catch (pipelineLogErr) {
    Logger.log('buildDQE: pipeline-health log failed (non-fatal): %s', pipelineLogErr);
  }
}

/**
 * Appends a row to the Pipeline Health sheet in the supplied
 * spreadsheet. Best-effort: any failure (missing sheet, schema
 * change, etc.) is logged and swallowed -- pipeline-health logging
 * must never block or fail the pipeline. Schema is owned by the
 * Department Dashboard's Config.gs PIPELINE_HEALTH_HEADERS; if that
 * changes, this writer's column ordering must change in lockstep.
 */
function logPipelineHealth_(ss, event) {
  try {
    if (!ss) return;
    const sheet = ss.getSheetByName('Pipeline Health');
    if (!sheet) return;   // setup() in the dashboard creates this
    sheet.appendRow([
      new Date(),
      event && event.step       ? String(event.step)   : '',
      event && event.status     ? String(event.status) : '',
      event && event.rows       != null ? event.rows       : '',
      event && event.durationMs != null ? event.durationMs : '',
      event && event.notes      ? String(event.notes)  : '',
    ]);
  } catch (e) {
    try { Logger.log('logPipelineHealth_ failed: %s', e); } catch (e2) {}
  }
}


// ── Roster canonical-name loader ──────────────────────────────────────────────
// Reads the "DO NOT EDIT!" roster sheet (Department Dashboard's
// roster) from the same spreadsheet that holds Raw Data, builds two
// lookups used to canonicalize agent names in the build:
//   canonicalSet[name]              -> true if name is on the roster exactly
//   strippedMap[strippedName]       -> array of canonical roster names whose
//                                      paren-stripped form equals strippedName
//
// Returns empty maps if the roster sheet is missing or empty so the
// build still runs (just without name canonicalization).
//
// Roster layout pinned by the dashboard's Config.gs ROSTER constants:
//   HEADER_ROW=1, DATA_START_ROW=2, DEPT_FIRST_COL=6 (F).
// Dept block ends at the first blank cell in the header row; columns
// past that are unrelated reference data and must be ignored.
// Agent cells are formatted "Name, ext1, ext2" -- name is everything
// before the first comma.
function loadRosterCanonicalNames_(anySheet) {
  const empty = { canonicalSet: {}, strippedMap: {}, aliasMap: {} };
  try {
    const ss = anySheet ? anySheet.getParent() : SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName('DO NOT EDIT!');
    if (!sheet) return empty;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const DEPT_FIRST_COL = 6;
    if (lastRow < 2 || lastCol < DEPT_FIRST_COL) return empty;

    const headerRow = sheet.getRange(1, DEPT_FIRST_COL, 1, lastCol - DEPT_FIRST_COL + 1)
                           .getValues()[0];
    let deptColCount = 0;
    for (let i = 0; i < headerRow.length; i++) {
      if (!String(headerRow[i] || '').trim()) break;
      deptColCount++;
    }
    if (deptColCount === 0) return empty;

    const block = sheet.getRange(2, DEPT_FIRST_COL, lastRow - 1, deptColCount).getValues();
    const canonicalSet = {};
    const strippedMap = {};

    for (let r = 0; r < block.length; r++) {
      for (let c = 0; c < block[r].length; c++) {
        const raw = String(block[r][c] || '').trim();
        if (!raw) continue;
        const name = (raw.split(',')[0] || '').trim();
        if (!name) continue;
        if (canonicalSet[name]) continue;
        canonicalSet[name] = true;
        const stripped = name.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
        if (!stripped) continue;
        if (!strippedMap[stripped]) strippedMap[stripped] = [];
        if (strippedMap[stripped].indexOf(name) === -1) {
          strippedMap[stripped].push(name);
        }
      }
    }

    // Admin-curated alias overrides. Schema owned by the dashboard's
    // Config.gs AGENT_ALIAS_OVERRIDES_HEADERS: Old Name | Canonical
    // Name | Active | Added By | Added At | Notes. The dashboard's
    // Orphan Fix modal writes here; we read at build time so future
    // imports get canonicalized without further admin action.
    // Best-effort: missing or empty sheet leaves aliasMap = {} and
    // the build behaves exactly as before this feature shipped.
    const aliasMap = {};
    try {
      const aliasSheet = ss.getSheetByName('Agent Alias Overrides');
      if (aliasSheet) {
        const aLastRow = aliasSheet.getLastRow();
        if (aLastRow >= 2) {
          const aRows = aliasSheet.getRange(2, 1, aLastRow - 1, 3).getValues();
          for (let i = 0; i < aRows.length; i++) {
            const oldName = String(aRows[i][0] || '').trim();
            const canonical = String(aRows[i][1] || '').trim();
            if (!oldName || !canonical) continue;
            const rawActive = aRows[i][2];
            const active = !(rawActive === false || rawActive === 'FALSE'
                          || rawActive === 'false' || rawActive === 0
                          || rawActive === 'no' || rawActive === 'No');
            if (!active) continue;
            // First write wins on duplicate oldName entries.
            if (!aliasMap[oldName]) aliasMap[oldName] = canonical;
          }
        }
      }
    } catch (aliasErr) {
      Logger.log('loadRosterCanonicalNames_: alias overrides read failed: %s', aliasErr);
    }

    return { canonicalSet: canonicalSet, strippedMap: strippedMap, aliasMap: aliasMap };
  } catch (e) {
    Logger.log('loadRosterCanonicalNames_ failed: %s', e);
    return empty;
  }
}

// ── Test function ─────────────────────────────────────────────────────────────
// WARNING: testDQEBuild, installDQEBuildTrigger, and runDailyDQEBuild_ below
// are designed for the cdr-report project only. In cdr-import they appear
// because INV-16 requires this file to be byte-identical across both projects.
// Do NOT create a trigger for runDailyDQEBuild_ in the cdr-import project --
// it would target the wrong spreadsheet. Use processIntegratedHistory instead.

function testDQEBuild() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName('Raw Data');
  const dqeSheet = ss.getSheetByName('DQE Historical Data');

  if (!rawSheet) { Logger.log('ERROR: "Raw Data" sheet not found.');            return; }
  if (!dqeSheet) { Logger.log('ERROR: "DQE Historical Data" sheet not found.'); return; }

  buildDQEHistoricalData(rawSheet, dqeSheet);
}

// ── Daily trigger ─────────────────────────────────────────────────────────────
// The daily DQE rebuild used to live as a time trigger created by hand
// in the Apps Script editor -- invisible to the repo and easy to lose
// on a fresh deploy.  Install / uninstall functions below let an
// admin manage it from the CDR Tools menu (or by running these
// functions directly from the editor).
//
// The trigger fires at DQE_DAILY_TRIGGER_HOUR each morning, runs the
// build against the active spreadsheet, and emails the configured
// alert address on failure (reuses NEON_WRITE_CONFIG.alertEmail from
// neonWrite.js -- same Apps Script project, shared global scope).
// Weekend skip is intentional: matches the alert engine's behavior
// (INV-33) since there's no upstream raw data on Sat / Sun.

const DQE_DAILY_TRIGGER_HOUR = 7;   // 7 AM script TZ (America/Chicago)

function runDailyDQEBuild_() {
  const startMs = Date.now();
  try {
    const now = new Date();
    const dow = now.getDay();   // 0 = Sun, 6 = Sat
    if (dow === 0 || dow === 6) {
      Logger.log('runDailyDQEBuild_: skipping weekend (%s)', now);
      return;
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rawSheet = ss.getSheetByName('Raw Data');
    const dqeSheet = ss.getSheetByName('DQE Historical Data');
    if (!rawSheet || !dqeSheet) {
      throw new Error('Raw Data or DQE Historical Data sheet missing.');
    }
    buildDQEHistoricalData(rawSheet, dqeSheet);
  } catch (e) {
    Logger.log('runDailyDQEBuild_ failed: %s', e);
    // Pipeline Health entry first (cheap; happens locally) so the
    // failure is visible in the admin UI even if the email path
    // also fails.
    try {
      logPipelineHealth_(SpreadsheetApp.getActiveSpreadsheet(), {
        step:       'buildDQE',
        status:     'failure',
        rows:       null,
        durationMs: Date.now() - startMs,
        notes:      (e && e.message) ? e.message : String(e),
      });
    } catch (logErr) { /* best-effort */ }

    const to = (typeof NEON_WRITE_CONFIG !== 'undefined' && NEON_WRITE_CONFIG.alertEmail)
      ? NEON_WRITE_CONFIG.alertEmail : null;
    if (to) {
      try {
        MailApp.sendEmail(
          to,
          '[CDR Report] Daily DQE build failed',
          'runDailyDQEBuild_ threw while rebuilding DQE Historical Data.\n\n'
          + 'Time: ' + new Date() + '\n\n'
          + 'Error: ' + ((e && e.message) ? e.message : String(e)) + '\n\n'
          + 'Stack:\n' + ((e && e.stack) ? e.stack : '(no stack)') + '\n\n'
          + 'The Department Dashboard will keep serving the previous '
          + 'day\'s data until the next successful build.'
        );
      } catch (mailErr) {
        Logger.log('Also failed to email failure: ' + (mailErr && mailErr.message ? mailErr.message : mailErr));
      }
    }
  }
}

function installDQEBuildTrigger_() {
  uninstallDQEBuildTrigger_();
  ScriptApp.newTrigger('runDailyDQEBuild_')
    .timeBased()
    .everyDays(1)
    .atHour(DQE_DAILY_TRIGGER_HOUR)
    .create();
  Logger.log('DQE daily build trigger installed (runs at %s:00 script-TZ).',
             DQE_DAILY_TRIGGER_HOUR);
}

function uninstallDQEBuildTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDailyDQEBuild_') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('DQE daily build trigger: removed %s existing trigger(s).', removed);
}

// Editor-callable wrappers (no trailing underscore so they appear in
// the Apps Script editor's Run dropdown and can be invoked from the
// CDR Tools menu).  All they do is delegate.
function installDQEBuildTrigger()   { installDQEBuildTrigger_(); }
function uninstallDQEBuildTrigger() { uninstallDQEBuildTrigger_(); }