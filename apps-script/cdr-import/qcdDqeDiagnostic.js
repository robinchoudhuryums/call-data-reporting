/**
 * qcdDqeDiagnostic.js  —  READ-ONLY reconciliation between the QCD "CSR block"
 * (QCDR Output rows 34–37) and the per-agent DQE answered counts the dashboard's
 * My Department table sums.
 *
 * WHY THIS EXISTS (owner question 2026-09-16). For 09/14 the CSR "Queue Calls"
 * answered read 414 (Call Menu 369 + Misc 9 + Internal 36 — row 34 is the ruled
 * `totalRowMap` SUM of its children) while the dept table's CSR subtotal read
 * 380. Both numbers are computed from the SAME raw legs and keyed on the SAME
 * person (the CALLEE), so the entire gap is "which legs does each side admit":
 *
 *   QCD rows 35/36/37 (calcQcdReport)     | DQE per-agent (buildDQEHistoricalData)
 *   --------------------------------------|---------------------------------------
 *   callee ∈ csr_team named range         | canonicalized callee, any dept roster
 *   NO queue gate — status/type only      | caller-ID must carry an A_Q_ or
 *                                         |   "Backup CSR" token, or CALLER
 *                                         |   must read "CallQueue (ext)"
 *   35: status 4/5; 36/37: talk > 0       | col Z === 'Answered'
 *   start > 6:00, per-row end < 15:00/30  | start ∈ [6:30, 15:00), no end clause
 *   one queue block                       | every queue the agent worked
 *
 * This tool classifies every leg against BOTH rule sets and prints, per agent,
 * what each side counted and — for each leg one side counts and the other does
 * not — WHICH gate decided it.
 *
 * TRUST MODEL. The QCD-side predicates below are a FIFTH hand-mirror of
 * calcQcdReport's rules (after dataFilters.js and DQEdrilldown.js), which is the
 * repo's recurring defect class — the verification tool contradicting the build
 * during the very investigation it exists to serve. So this tool does not ask to
 * be trusted: every run RECONCILES itself against both authorities before it
 * reports anything, and REFUSES (verdict INCONCLUSIVE) when either check fails.
 *   - QCD side: the real `calcQcdReport(grid, targetSS)` is called on the same
 *     grid and its row 35/36/37 col-D cells must equal this tool's per-leg tally.
 *   - DQE side: the already-written `DQE Historical Data` rows for the date must
 *     equal this tool's per-agent recomputation.
 * A mismatch means the mirror drifted, not that the pipeline is wrong.
 *
 * WRITES NOTHING to any data sheet and sets no Script Properties. The optional
 * detail tab (`QCD-DQE Diagnostic`) is created/cleared by this tool alone.
 *
 * Entry points (CDR Tools menu, or the editor's Run picker):
 *   diagnoseQcdVsDqe()                    — prompts for a date + dept column
 *   diagnoseQcdVsDqeForDate(iso, opts)    — same, callable; opts { dept, toSheet }
 */

/** The three CSR-block child rows, by QCDR Output row number. */
const QDD_CSR_ROWS_ = Object.freeze([35, 36, 37]);

/** Labels are sheet-authored (QCDR Output col B); these are the fallbacks. */
const QDD_ROW_LABELS_ = Object.freeze({ 35: 'Call Menu', 36: 'Misc', 37: 'Internal' });

/** Roster layout (INV-11): dept columns start at F on `DO NOT EDIT!`. */
const QDD_DEPT_FIRST_COL_ = 6;

/** Detail rows are capped so a pathological day cannot blow the cell budget. */
const QDD_DETAIL_CAP_ = 500;

/** Per-orphan sibling legs listed on the detail tab. */
const QDD_SIBLING_CAP_ = 8;


// ─────────────────────────────────────────────────────────────────────────────
// PURE CORE  (unit-tested in tests/unit/qcd-dqe-diagnostic.test.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify every leg of one day against both rule sets.
 *
 * @param {Array<Array<string>>} grid  Call_Legs display values INCLUDING the
 *        header row, sliced to MAX_COLS — exactly what calcQcdReport is fed.
 * @param {Object} ctx
 *        - canonicalize {function(string):string}  DQE name canonicalization
 *        - csrTeamSet {Set<string>}        lowercased `csr_team` names
 *        - csrExceptionsSet {Set<string>}  lowercased `csr_exceptions` names
 *        - deptOfAgent {Object}            canonical name -> [dept, ...]
 *        - excludedAgents {Array<string>}  DQE_EXCLUDED_AGENTS
 * @return {Object} tallies, per-agent cross-tab and per-leg detail.
 */
function qddAnalyzeDay_(grid, ctx) {
  const body = grid.slice(1);
  const time600AM = 6 / 24, time300PM = 15 / 24, time330PM = 15.5 / 24;

  // R18e fallback map: queue EXTENSION -> queue NAME, from the same day's
  // queue-callee legs. Copied from buildDQEHistoricalData's own builder so a
  // leg the real build recovers is recovered here too.
  const queueNameByExt = {};
  for (let i = 0; i < body.length; i++) {
    const calleeExt  = String(body[i][DQE_C.CALLEE]).trim();
    const calleeName = String(body[i][DQE_C.CALLEE_NAME]).trim();
    if (!/^\d+$/.test(calleeExt)) continue;
    if (!/^(A_Q_[\w&]+|Backup CSR)$/.test(calleeName)) continue;
    queueNameByExt[calleeExt] = calleeName;
  }

  const out = {
    rows: body.length,
    qcdD: { 35: 0, 36: 0, 37: 0 },
    byAgent: {},                  // canonical name -> counters
    detail: [],                   // QCD-counted, DQE-missed legs
    detailTruncated: 0,
    qcdAlsoDqe: 0,               // CSR-block legs DQE counts too (the agreeing set)
    // PARENT JOIN (the 2026-09-16 finding): the two sides turned out to be
    // DISJOINT leg sets -- 0 of 414 legs in both -- so "which calls are
    // missing" is the wrong question until we know whether a CSR-block leg
    // and a DQE-counted leg belong to the SAME CALL. A CDR root is a leg
    // tree, so legs of one call share a parent key.
    parentJoin: { sameAgent: 0, otherAgent: 0, none: 0 },
    orphanCauses: {},            // why each no-DQE-leg call has none
    orphanSample: [],            // CSR-block legs whose call has no DQE leg at all
    reasons: {},                  // reason -> count
    dqeOnlyByQueue: {},           // queue name -> count (DQE counted, QCD block did not)
    dqeAnsweredAllAgents: 0
  };

  // agent -> { parentKey: true } for DQE-counted legs, plus the any-agent union.
  const dqeParentsByAgent = {};
  const dqeParentsAny = {};
  const qcdLegs = [];          // every CSR-block leg: { agent, parentKey, detail, ... }
  // Every call id and every parent key SEEN AT ALL, DQE-counted or not. An
  // orphan whose call is absent from this day's sheet entirely is a different
  // finding from one whose call is present but whose other legs DQE skipped --
  // the first is a dangling reference, the second is a gate question.
  const allCallIds = {};
  const legsPerParentKey = {};

  const bump = function (name) {
    if (!out.byAgent[name]) {
      out.byAgent[name] = {
        q35: 0, q36: 0, q37: 0, qTotal: 0,
        dqeAnswered: 0,
        depts: ctx.deptOfAgent[name] || []
      };
    }
    return out.byAgent[name];
  };

  for (let i = 0; i < body.length; i++) {
    const row = body[i];

    // ---- QCD-side field derivation (calcQcdReport's own column map) --------
    const status     = String(row[1]).trim();
    const type       = String(row[5]).trim().toLowerCase();
    const callerName = String(row[9]).trim().toLowerCase();    // "team"
    const calleeRaw  = String(row[11]).trim();                 // "queueName"
    const calleeLc   = calleeRaw.toLowerCase();
    const startDec   = simulateSplitCol2(row[2]);
    const endDec     = simulateSplitCol2(row[4]);
    const waitDec    = parseDurationDecimal(row[7]);
    const isColGPos  = parseDurationDecimal(row[6]) > 0;

    // calcQcdReport's global guard — legs failing it reach NO row counter.
    const qcdEligible = !(startDec <= time600AM || startDec === -1 || endDec === -1);

    const isCSR   = ctx.csrTeamSet.has(callerName);
    const isCsrQ  = ctx.csrTeamSet.has(calleeLc);
    const isExcQ  = ctx.csrExceptionsSet.has(calleeLc);

    // Answered (col D) predicates, verbatim from calcQcdReport's r*_D_* /
    // r37_C_p3 counters. Reconciled against the real function every run.
    let qcdRow = 0;
    if (qcdEligible) {
      if (type === 'incoming'
          && startDec > time600AM && startDec < time300PM && endDec < time330PM
          && ((status === '4' && isCsrQ) || (status === '5' && isExcQ))) {
        qcdRow = 35;
      } else if (type === 'incoming' && isColGPos
          && startDec > time600AM && endDec < time330PM
          && ((status !== '4' && isCsrQ && !isExcQ)
              || (status !== '4' && status !== '5' && isExcQ))) {
        qcdRow = 36;
      } else if (type === 'internal'
          && startDec > time600AM && startDec < time300PM && endDec < time300PM
          && isColGPos && isCsrQ && !isCSR) {
        qcdRow = 37;
      }
    }

    // ---- DQE-side gate (buildDQEHistoricalData's queueLegs filter) ---------
    const callerIdRaw = String(row[DQE_C.CALLER_ID]).trim();
    const qnMatch     = callerIdRaw.match(/(?:^|[^\w&])(A_Q_[\w&]+|Backup CSR)/);
    let queueName     = qnMatch ? qnMatch[1] : null;
    if (!queueName) {
      const cqMatch = String(row[DQE_C.CALLER]).trim().match(/^CallQueue\s*\((\d+)\)$/i);
      if (cqMatch) queueName = queueNameByExt[cqMatch[1]] || null;
    }
    const calleeK   = String(row[DQE_C.CALLEE]).trim();
    const canonical = ctx.canonicalize(String(row[DQE_C.CALLEE_NAME]).trim());
    const answered  = String(row[DQE_C.ANSWERED]).trim() === 'Answered';
    const startPST  = qddDisplayToTimeSec_(row[DQE_C.START_TIME]);
    const inWindow  = startPST !== null
                   && startPST >= DQE_WINDOW_START && startPST < DQE_WINDOW_END;

    // WHY a leg the QCD block counted is absent from DQE — evaluated in the
    // build's own short-circuit order, so the reason named is the gate that
    // actually fired first. The `answered` flag is checked LAST because the
    // four gates above drop the leg from the build's universe entirely.
    let gateReason = '';
    if (!queueName)                                        gateReason = 'no-queue-token';
    else if (/^CallForking/i.test(calleeK))                gateReason = 'callforking-callee';
    else if (!canonical || canonical === 'N/A')            gateReason = 'no-agent-name';
    else if (ctx.excludedAgents.indexOf(canonical) !== -1) gateReason = 'excluded-agent';
    else if (!inWindow)                                    gateReason = 'outside-dqe-window';

    const dqeCountsIt = !gateReason && answered;
    const dqeReason   = gateReason || (answered ? '' : 'not-flagged-answered');
    const key = canonical || calleeRaw;

    const parentRaw = String(row[DQE_C.PARENT_CALL]).trim();
    const parentKey = qddParentKeyOf_(row);

    const ownCallId = String(row[DQE_C.CALL_ID]).trim();
    if (ownCallId) allCallIds[ownCallId] = true;
    if (parentKey) legsPerParentKey[parentKey] = (legsPerParentKey[parentKey] || 0) + 1;

    if (dqeCountsIt) {
      out.dqeAnsweredAllAgents++;
      bump(key).dqeAnswered++;
      if (parentKey) {
        if (!dqeParentsByAgent[key]) dqeParentsByAgent[key] = {};
        dqeParentsByAgent[key][parentKey] = true;
        dqeParentsAny[parentKey] = true;
      }
    }

    if (qcdRow) {
      out.qcdD[qcdRow]++;
      const a = bump(key);
      a['q' + qcdRow]++;
      a.qTotal++;
      if (dqeCountsIt) out.qcdAlsoDqe++;
      let detailRow = null;
      if (!dqeCountsIt) {
        out.reasons[dqeReason] = (out.reasons[dqeReason] || 0) + 1;
        if (out.detail.length < QDD_DETAIL_CAP_) {
          detailRow = {
            sheetRow: i + 2,              // +1 header, +1 to 1-index
            qcdRow: qcdRow,
            agent: key,
            rawCallee: calleeRaw,
            caller: String(row[DQE_C.CALLER]).trim(),
            callerName: String(row[9]).trim(),
            callerId: callerIdRaw,
            direction: type,
            status: status,
            start: String(row[2]).trim(),
            end: String(row[4]).trim(),
            answeredFlag: String(row[DQE_C.ANSWERED]).trim(),
            reason: dqeReason,
            sibling: ''
          };
          out.detail.push(detailRow);
        } else {
          out.detailTruncated++;
        }
      }
      qcdLegs.push({
        agent: key, parentKey: parentKey, detail: detailRow,
        parentRaw: parentRaw, callId: ownCallId, sheetRow: i + 2,
        qcdRow: qcdRow, status: status, direction: type, startPST: startPST,
        start: String(row[2]).trim(), end: String(row[4]).trim(),
        caller: String(row[DQE_C.CALLER]).trim(),
        callerName: String(row[9]).trim(),
        callerId: callerIdRaw,
        calleeName: calleeRaw,
        calleeExt: String(row[DQE_C.CALLEE]).trim(),
        talk: String(row[DQE_C.TALK_TIME]).trim(),
        wait: String(row[DQE_C.CALL_TIME]).trim(),
        missedFlag: String(row[DQE_C.MISSED]).trim(),
        abandonedFlag: String(row[DQE_C.ABANDONED]).trim(),
        answeredFlag: String(row[DQE_C.ANSWERED]).trim()
      });
    } else if (dqeCountsIt && ctx.csrTeamSet.has(calleeLc)) {
      // The mirror image: a CSR-roster agent's answered queue leg that the CSR
      // block does NOT count. This is the term that pushes the table UP.
      const q = queueName || '(unknown)';
      out.dqeOnlyByQueue[q] = (out.dqeOnlyByQueue[q] || 0) + 1;
    }
  }

  // ── The parent join ───────────────────────────────────────────────────────
  // For each CSR-block leg, does the CALL it belongs to also carry a leg the
  // DQE build counted? `sameAgent` means this agent was credited for this call
  // on its queue-delivered leg -- the CSR-block leg is a SECOND VIEW of a call
  // already in their numbers, not a missing one. `otherAgent` means the call is
  // in the dept's numbers under someone else. `none` means neither, and only
  // `none` can be an under-credited call.
  for (let n = 0; n < qcdLegs.length; n++) {
    const leg = qcdLegs[n];
    let cls;
    if (leg.parentKey && dqeParentsByAgent[leg.agent] && dqeParentsByAgent[leg.agent][leg.parentKey]) {
      cls = 'sameAgent';
    } else if (leg.parentKey && dqeParentsAny[leg.parentKey]) {
      cls = 'otherAgent';
    } else {
      cls = 'none';
      // WHY this call has no DQE leg. The work window comes FIRST: a call that
      // started before 6:30 PST is outside the per-agent window by design
      // (INV-06) while QCD's CSR block floors at 6:00, so it is a window
      // difference, not a lost call -- and reading it as one would put a
      // deliberate design decision on the under-credited pile.
      const cause = (leg.startPST === null) ? 'unparsed-start'
        : (leg.startPST < DQE_WINDOW_START) ? 'starts-before-dqe-window'
        : (leg.startPST >= DQE_WINDOW_END) ? 'starts-after-dqe-window'
        : (leg.direction === 'internal') ? 'internal-direct-to-agent'
        : 'in-window-non-queue';
      out.orphanCauses[cause] = (out.orphanCauses[cause] || 0) + 1;
      if (out.orphanSample.length < 25) {
        out.orphanSample.push({
          agent: leg.agent, parentKey: leg.parentKey,
          // 'N/A' means the leg IS the call root, so its key is its own id.
          cause: cause,
          parentRaw: leg.parentRaw, callId: leg.callId, sheetRow: leg.sheetRow,
          qcdRow: leg.qcdRow, status: leg.status, direction: leg.direction,
          start: leg.start, end: leg.end,
          caller: leg.caller, callerName: leg.callerName, callerId: leg.callerId,
          calleeName: leg.calleeName, calleeExt: leg.calleeExt,
          talk: leg.talk, wait: leg.wait,
          missedFlag: leg.missedFlag, abandonedFlag: leg.abandonedFlag,
          answeredFlag: leg.answeredFlag,
          siblings: [],
          // Is the call it names present in THIS day's sheet at all?
          callIdSeenToday: !!allCallIds[leg.parentKey],
          legsOnThisCall: legsPerParentKey[leg.parentKey] || 0
        });
      }
    }
    out.parentJoin[cls]++;
    if (leg.detail) leg.detail.sibling = cls;
  }

  // SECOND PASS -- the other legs of each orphaned call. "The call is present
  // but DQE counted none of its legs" and "the call does not exist today" need
  // opposite follow-ups, and only the leg list tells them apart: an orphan whose
  // call has a full ring tree is a gate question, one with no siblings at all is
  // a dangling reference.
  const wanted = {};
  for (let q = 0; q < out.orphanSample.length; q++) {
    const k = out.orphanSample[q].parentKey;
    if (k) { if (!wanted[k]) wanted[k] = []; wanted[k].push(out.orphanSample[q]); }
  }
  if (Object.keys(wanted).length) {
    for (let i = 0; i < body.length; i++) {
      const row = body[i];
      const pk = qddParentKeyOf_(row);
      if (!wanted[pk]) continue;
      const ownId = String(row[DQE_C.CALL_ID]).trim();
      for (let w = 0; w < wanted[pk].length; w++) {
        const o = wanted[pk][w];
        // Exclude the orphan leg BY ROW. Legs of one call SHARE DQE_C.CALL_ID,
        // so it is not a per-leg identity: excluding by it silently drops every
        // sibling, and a call with a full ring tree reports as dangling --
        // measured on 2026-09-14, where legsOnCall read 3..10 while siblings
        // read 0. The sheet row is the only always-unique per-leg identity.
        if (i + 2 === o.sheetRow) continue;
        if (o.siblings.length >= QDD_SIBLING_CAP_) continue;
        o.siblings.push({
          sheetRow: i + 2,
          callee: String(row[DQE_C.CALLEE_NAME]).trim(),
          calleeExt: String(row[DQE_C.CALLEE]).trim(),
          caller: String(row[DQE_C.CALLER]).trim(),
          callerName: String(row[9]).trim(),
          callerId: String(row[DQE_C.CALLER_ID]).trim(),
          direction: String(row[5]).trim(),
          status: String(row[1]).trim(),
          start: String(row[2]).trim(),
          talk: String(row[DQE_C.TALK_TIME]).trim(),
          answeredFlag: String(row[DQE_C.ANSWERED]).trim(),
          missedFlag: String(row[DQE_C.MISSED]).trim()
        });
      }
    }
  }

  // Id-space comparison. Call ids here look like epoch milliseconds, so a set
  // of orphans whose ids sit far from the day's own range is a DANGLING or
  // carried-over reference, not a call this day mislaid.
  out.idRange = {
    dqeMin: '', dqeMax: '', orphanMin: '', orphanMax: ''
  };
  const anyKeys = Object.keys(dqeParentsAny).sort();
  if (anyKeys.length) {
    out.idRange.dqeMin = anyKeys[0];
    out.idRange.dqeMax = anyKeys[anyKeys.length - 1];
  }
  const orphKeys = out.orphanSample.map(function (o) { return o.parentKey; })
                                   .filter(Boolean).sort();
  if (orphKeys.length) {
    out.idRange.orphanMin = orphKeys[0];
    out.idRange.orphanMax = orphKeys[orphKeys.length - 1];
  }

  return out;
}

/**
 * A leg's CALL identity: its parent's id, or its own when it IS the root. The
 * build excludes a literal 'N/A' parent the same way (REP-4). Both passes go
 * through here so a root leg can never key differently between them.
 */
function qddParentKeyOf_(row) {
  const p = String(row[DQE_C.PARENT_CALL]).trim();
  return (p && p !== 'N/A') ? p : String(row[DQE_C.CALL_ID]).trim();
}

/**
 * PHI: the orphan rows carry the raw caller fields, which is safe on the DETAIL
 * TAB -- it lives in the same workbook as Raw Data, so nothing new is exposed.
 * The execution LOG is different: it gets copied into tickets and chats, so a
 * phone-shaped value is reduced to its shape there. Never widen this.
 */
function qddLogSafe_(v) {
  const str = String(v == null ? '' : v);
  const digits = str.replace(/\D/g, '');
  return digits.length >= 7 ? '(' + digits.length + '-digit number)' : str;
}

/**
 * buildDQEHistoricalData's `displayToTimeSec`, copied because it is nested
 * inside that function and so is not reachable from another file. Pinned
 * byte-for-byte against the original by tests/unit/qcd-dqe-diagnostic.test.js.
 */
function qddDisplayToTimeSec_(str) {
  if (!str) return null;
  const parts = String(str).trim().split(' ');
  if (parts.length < 2) return null;
  const t = parts[1].split(':');
  if (t.length < 2) return null;
  return (parseInt(t[0]) || 0) * 3600
       + (parseInt(t[1]) || 0) * 60
       + (parseInt(t[2]) || 0);
}

/**
 * Roster reader: canonical agent name -> the dept columns it appears in, plus
 * the ordered dept header list. INV-03 cell format, INV-11 layout.
 */
function qddReadRoster_(targetSS) {
  const sheet = targetSS.getSheetByName('DO NOT EDIT!');
  if (!sheet) throw new Error('qddReadRoster_: "DO NOT EDIT!" sheet not found in the target spreadsheet.');
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  const out = { depts: [], deptOfAgent: {}, byDept: {} };
  if (lastRow < 2 || lastCol < QDD_DEPT_FIRST_COL_) return out;

  const header = sheet.getRange(1, QDD_DEPT_FIRST_COL_, 1, lastCol - QDD_DEPT_FIRST_COL_ + 1)
                      .getValues()[0];
  let deptCount = 0;
  for (let i = 0; i < header.length; i++) {
    if (!String(header[i] || '').trim()) break;
    deptCount++;
  }
  if (!deptCount) return out;
  out.depts = header.slice(0, deptCount).map(function (h) { return String(h).trim(); });

  const block = sheet.getRange(2, QDD_DEPT_FIRST_COL_, lastRow - 1, deptCount).getValues();
  out.depts.forEach(function (d) { out.byDept[d] = []; });
  for (let r = 0; r < block.length; r++) {
    for (let c = 0; c < deptCount; c++) {
      const raw = String(block[r][c] || '').trim();
      if (!raw) continue;
      const name = (raw.split(',')[0] || '').trim();
      if (!name) continue;
      const dept = out.depts[c];
      if (out.byDept[dept].indexOf(name) === -1) out.byDept[dept].push(name);
      if (!out.deptOfAgent[name]) out.deptOfAgent[name] = [];
      if (out.deptOfAgent[name].indexOf(dept) === -1) out.deptOfAgent[name].push(dept);
    }
  }
  return out;
}

/**
 * The DQE canonicalizer, rebuilt over `loadRosterCanonicalNames_` (which IS
 * global). Same two-key strip/flatten union + unique-match rule as INV-24.
 */
function qddMakeCanonicalizer_(rosterCanonical) {
  const stripParens  = function (n) { return String(n || '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(); };
  const flattenParens = function (n) { return String(n || '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim(); };
  return function (rawName) {
    if (!rawName) return rawName;
    if (rosterCanonical.aliasMap && rosterCanonical.aliasMap[rawName]) {
      return rosterCanonical.aliasMap[rawName];
    }
    if (rosterCanonical.canonicalSet[rawName]) return rawName;
    const keys = [stripParens(rawName), flattenParens(rawName)];
    const seen = {}, cands = [];
    for (let k = 0; k < keys.length; k++) {
      const list = keys[k] && rosterCanonical.strippedMap[keys[k]];
      if (!list) continue;
      for (let j = 0; j < list.length; j++) {
        if (!seen[list[j]]) { seen[list[j]] = true; cands.push(list[j]); }
      }
    }
    return cands.length === 1 ? cands[0] : rawName;
  };
}

/** Read the already-written DQE Historical Data answered counts for one date. */
function qddStoredDqeAnswered_(targetSS, iso) {
  const sheet = targetSS.getSheetByName('DQE Historical Data');
  const out = {};
  if (!sheet) return out;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  // Cols B (Date) / C (Agent) / H (Total Answered). Display values: the date
  // cell renders as plain text or as a Date, so both sides go through the
  // ISO normalizer before they are compared.
  const grid = sheet.getRange(2, 2, lastRow - 1, 7).getDisplayValues();
  const want = qddNormalizeDateStr_(iso);
  for (let i = 0; i < grid.length; i++) {
    if (qddNormalizeDateStr_(grid[i][0]) !== want) continue;
    const agent = String(grid[i][1] || '').trim();
    if (!agent) continue;
    out[agent] = (out[agent] || 0) + (Number(grid[i][6]) || 0);
  }
  return out;
}

/** "2026-09-14" | "9/14/2026" | "09/14/2026 ..." -> "2026-09-14". */
function qddNormalizeDateStr_(v) {
  const s = String(v || '').trim().split(' ')[0];
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + qddPad2_(m[2]) + '-' + qddPad2_(m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + qddPad2_(m[1]) + '-' + qddPad2_(m[2]);
  return s;
}

function qddPad2_(n) { return String(n).length < 2 ? '0' + String(n) : String(n); }


/**
 * Find the legs for one date. Looks for a `Call_Legs_<iso>` tab in the active
 * workbook AND in the target one (cdr-import is bound to the workbook holding
 * the dated tabs, but the two projects may share a workbook), then falls back
 * to the shared `Raw Data` tab, which holds the most recently imported date.
 * The fallback matters because `Raw Data` often outlives the ~14-day
 * `Call_Legs_*` retention for the latest date.
 */
function qddResolveLegsSheet_(sourceSS, targetSS, dateIso) {
  const books = [sourceSS];
  if (targetSS && targetSS.getId() !== sourceSS.getId()) books.push(targetSS);

  if (dateIso) {
    for (let i = 0; i < books.length; i++) {
      const sh = books[i].getSheetByName('Call_Legs_' + dateIso);
      if (sh) return { sheet: sh, dateIso: dateIso, source: sh.getName() };
    }
  } else {
    let best = null;
    books.forEach(function (ss) {
      ss.getSheets().forEach(function (sh) {
        const m = /^Call_Legs_(\d{4}-\d{2}-\d{2})$/i.exec(sh.getName());
        if (m && (!best || m[1] > best.dateIso)) {
          best = { sheet: sh, dateIso: m[1], source: sh.getName() };
        }
      });
    });
    if (best) return best;
  }

  const raw = targetSS.getSheetByName('Raw Data');
  if (raw && raw.getLastRow() > 1) {
    // Raw Data holds ONE date's legs (col C is the leg start).
    const rawIso = qddNormalizeDateStr_(raw.getRange(2, 3).getDisplayValue());
    if (!dateIso) return { sheet: raw, dateIso: rawIso, source: 'Raw Data' };
    if (rawIso === qddNormalizeDateStr_(dateIso)) {
      return { sheet: raw, dateIso: dateIso, source: 'Raw Data' };
    }
    throw new Error('diagnoseQcdVsDqe: no "Call_Legs_' + dateIso + '" tab survives, and '
      + '"Raw Data" currently holds ' + rawIso + '. Re-run a Manual Export for '
      + dateIso + ' first, or pick a date whose Call_Legs tab is still present.');
  }
  throw new Error('diagnoseQcdVsDqe: found neither a Call_Legs tab for '
    + (dateIso || '(latest)') + ' nor a populated "Raw Data" sheet.');
}


// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

/** Menu entry: prompts for a date (blank = latest Call_Legs) and a dept column. */
function diagnoseQcdVsDqe() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('QCD vs DQE diagnostic',
    'Date to analyze (YYYY-MM-DD). Blank = the most recent Call_Legs_* sheet.',
    ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return null;
  const iso = String(r1.getResponseText() || '').trim();

  const r2 = ui.prompt('QCD vs DQE diagnostic',
    'Dashboard dept column to cross-tab against (blank = CSR).',
    ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return null;
  const dept = String(r2.getResponseText() || '').trim() || 'CSR';

  const res = diagnoseQcdVsDqeForDate(iso, { dept: dept, toSheet: true });
  ui.alert('QCD vs DQE diagnostic',
    res.verdict + '\n\nFull detail: the "' + res.tabName + '" tab (and the execution log).',
    ui.ButtonSet.OK);
  return res;
}

/**
 * READ-ONLY. Classifies one day's legs against both rule sets, reconciles
 * itself against calcQcdReport AND the stored DQE rows, and reports.
 *
 * @param {string} iso   'YYYY-MM-DD'; blank/omitted = latest Call_Legs_* sheet.
 * @param {Object} opts  { dept: 'CSR', toSheet: true }
 */
function diagnoseQcdVsDqeForDate(iso, opts) {
  opts = opts || {};
  const dept = opts.dept || 'CSR';
  const sourceSS = SpreadsheetApp.getActiveSpreadsheet();
  const targetSS = SpreadsheetApp.openById(getTargetSsId_());

  // --- locate the day's legs ------------------------------------------------
  const src = qddResolveLegsSheet_(sourceSS, targetSS, String(iso || '').trim());
  const sheet = src.sheet, dateIso = src.dateIso;

  const grid = sheet.getDataRange().getDisplayValues().map(function (r) { return r.slice(0, MAX_COLS); });
  if (grid.length < 2) throw new Error('diagnoseQcdVsDqe: "' + sheet.getName() + '" is empty.');

  // --- context --------------------------------------------------------------
  const csrTeamRange = targetSS.getRangeByName('csr_team');
  if (!csrTeamRange) {
    throw new Error('diagnoseQcdVsDqe: the "csr_team" named range is missing — the QCD side cannot be reproduced.');
  }
  const csrTeamSet = new Set();
  csrTeamRange.getValues().forEach(function (r) {
    if (r[0]) csrTeamSet.add(String(r[0]).split(',')[0].trim().toLowerCase());
  });
  const csrExceptionsSet = new Set();
  const excRange = targetSS.getRangeByName('csr_exceptions');
  if (excRange) {
    excRange.getValues().forEach(function (r) {
      if (r[0]) csrExceptionsSet.add(String(r[0]).split(',')[0].trim().toLowerCase());
    });
  }

  const roster = qddReadRoster_(targetSS);
  // loadRosterCanonicalNames_ resolves the workbook from the sheet it is given,
  // so hand it a sheet from targetSS — `DO NOT EDIT!` lives there, not
  // necessarily in the workbook holding the Call_Legs tabs.
  const canonicalize = qddMakeCanonicalizer_(loadRosterCanonicalNames_(targetSS.getSheets()[0]));

  const res = qddAnalyzeDay_(grid, {
    canonicalize: canonicalize,
    csrTeamSet: csrTeamSet,
    csrExceptionsSet: csrExceptionsSet,
    deptOfAgent: roster.deptOfAgent,
    excludedAgents: DQE_EXCLUDED_AGENTS
  });

  // --- RECONCILIATION 1: the real calcQcdReport ------------------------------
  const real = calcQcdReport(grid, targetSS);
  const realD = {};
  QDD_CSR_ROWS_.forEach(function (r) { realD[r] = Number(real.output[r - 2][1]) || 0; });
  const qcdOk = QDD_CSR_ROWS_.every(function (r) { return realD[r] === res.qcdD[r]; });

  // --- RECONCILIATION 2: the stored DQE Historical Data rows -----------------
  const stored = qddStoredDqeAnswered_(targetSS, dateIso);
  const dqeMismatches = [];
  Object.keys(res.byAgent).forEach(function (name) {
    const mine = res.byAgent[name].dqeAnswered;
    const theirs = stored[name];
    if (theirs === undefined) { if (mine > 0) dqeMismatches.push([name, mine, 'no stored row']); return; }
    if (theirs !== mine) dqeMismatches.push([name, mine, theirs]);
  });
  Object.keys(stored).forEach(function (name) {
    if (res.byAgent[name] === undefined && stored[name] > 0) {
      dqeMismatches.push([name, 0, stored[name]]);
    }
  });
  const dqeOk = dqeMismatches.length === 0;

  // --- roll up --------------------------------------------------------------
  const rosterNames = roster.byDept[dept] || [];
  let deptQcd = 0, deptDqe = 0, deptStored = 0;
  const rows = [];
  Object.keys(res.byAgent).forEach(function (name) {
    const a = res.byAgent[name];
    if (a.qTotal === 0 && a.dqeAnswered === 0) return;
    const onDept = rosterNames.indexOf(name) !== -1;
    if (onDept) { deptQcd += a.qTotal; deptDqe += a.dqeAnswered; deptStored += (stored[name] || 0); }
    rows.push({
      agent: name, onDept: onDept, depts: a.depts.join(' / ') || '(not on any roster)',
      q35: a.q35, q36: a.q36, q37: a.q37, qTotal: a.qTotal,
      dqe: a.dqeAnswered, storedDqe: stored[name] === undefined ? '' : stored[name],
      delta: a.qTotal - a.dqeAnswered
    });
  });
  rows.sort(function (x, y) { return (y.qTotal - x.qTotal) || (x.agent < y.agent ? -1 : 1); });

  const verdict = (!qcdOk || !dqeOk)
    ? ('INCONCLUSIVE — this tool\'s mirror disagrees with the authority it checks against ('
        + (!qcdOk ? 'QCD' : '') + (!qcdOk && !dqeOk ? ' + ' : '') + (!dqeOk ? 'DQE' : '')
        + '). Do NOT read the gap analysis below; fix the mirror first.')
    : ('ok — mirror reconciles with calcQcdReport and the stored DQE rows. '
        + 'CSR block answered=' + (res.qcdD[35] + res.qcdD[36] + res.qcdD[37])
        + ' (35/36/37 = ' + res.qcdD[35] + '/' + res.qcdD[36] + '/' + res.qcdD[37] + '); '
        + dept + '-roster DQE answered=' + deptDqe + '. '
        + qddParentJoinReading_(res.parentJoin));

  const report = {
    date: dateIso, dept: dept, rows: res.rows, verdict: verdict, source: src.source,
    qcdReconciled: qcdOk, dqeReconciled: dqeOk,
    qcdD: res.qcdD, realD: realD, dqeMismatches: dqeMismatches,
    deptQcd: deptQcd, deptDqe: deptDqe, deptStored: deptStored,
    reasons: res.reasons, dqeOnlyByQueue: res.dqeOnlyByQueue,
    qcdAlsoDqe: res.qcdAlsoDqe, dqeAnsweredAllAgents: res.dqeAnsweredAllAgents,
    parentJoin: res.parentJoin, orphanSample: res.orphanSample, idRange: res.idRange,
    orphanCauses: res.orphanCauses,
    detail: res.detail, detailTruncated: res.detailTruncated,
    agents: rows, tabName: 'QCD-DQE Diagnostic'
  };

  qddLogReport_(report);
  if (opts.toSheet !== false) qddWriteReportTab_(sourceSS, report);
  return report;
}

function qddLogReport_(rep) {
  Logger.log('QCD vs DQE diagnostic — %s (dept %s, %s legs, read from "%s")',
    rep.date, rep.dept, rep.rows, rep.source);
  Logger.log('VERDICT: %s', rep.verdict);
  Logger.log('QCD row-D mirror vs calcQcdReport: mine=%s real=%s -> %s',
    JSON.stringify(rep.qcdD), JSON.stringify(rep.realD), rep.qcdReconciled ? 'OK' : 'MISMATCH');
  Logger.log('DQE per-agent mirror vs stored DQE Historical Data: %s',
    rep.dqeReconciled ? 'OK' : ('MISMATCH on ' + rep.dqeMismatches.length + ' agent(s): '
      + JSON.stringify(rep.dqeMismatches.slice(0, 10))));
  Logger.log('%s roster: QCD-block answered=%s, DQE answered (recomputed)=%s, stored=%s',
    rep.dept, rep.deptQcd, rep.deptDqe, rep.deptStored);
  Logger.log('CSR-block answered legs DQE ALSO counts: %s of %s', rep.qcdAlsoDqe,
    rep.qcdD[35] + rep.qcdD[36] + rep.qcdD[37]);
  Logger.log('Legs the CSR block counted that DQE does NOT, by reason: %s', JSON.stringify(rep.reasons));
  Logger.log('Legs DQE counted for csr_team agents that the CSR block does NOT, by queue: %s',
    JSON.stringify(rep.dqeOnlyByQueue));
  Logger.log('PARENT JOIN -- of the %s CSR-block legs, the CALL they belong to also has a '
    + 'DQE-counted leg for: the SAME agent=%s, a DIFFERENT agent=%s, NOBODY=%s. %s',
    rep.parentJoin.sameAgent + rep.parentJoin.otherAgent + rep.parentJoin.none,
    rep.parentJoin.sameAgent, rep.parentJoin.otherAgent, rep.parentJoin.none,
    qddParentJoinReading_(rep.parentJoin));
  if (rep.parentJoin.none) {
    Logger.log('Why those %s calls have no DQE leg: %s', rep.parentJoin.none,
      JSON.stringify(rep.orphanCauses));
  }
  if (rep.orphanSample.length) {
    Logger.log('Call-id range -- DQE-counted calls %s..%s, orphan calls %s..%s '
      + '(ids look like epoch ms; an orphan range far from the day\'s own is a '
      + 'carried-over reference, not a call this day mislaid)',
      rep.idRange.dqeMin, rep.idRange.dqeMax, rep.idRange.orphanMin, rep.idRange.orphanMax);
    Logger.log('Calls with NO DQE leg at all (these, and only these, can be '
      + 'under-credited) -- caller fields reduced to their SHAPE here, the full '
      + 'values are on the detail tab: %s',
      JSON.stringify(rep.orphanSample.map(function (o) {
        return {
          agent: o.agent, key: o.parentKey, parentCell: o.parentRaw, callId: o.callId,
          row: o.sheetRow, qcdRow: o.qcdRow, status: o.status, dir: o.direction,
          start: o.start, talk: o.talk,
          caller: qddLogSafe_(o.caller), callerName: qddLogSafe_(o.callerName),
          callerId: qddLogSafe_(o.callerId),
          keySeenToday: o.callIdSeenToday, legsOnCall: o.legsOnThisCall,
          siblings: o.siblings.length
        };
      })));
  }
}

/**
 * Turn the parent join into the sentence an operator should act on. The whole
 * point of the join is that a leg count difference and an under-credited AGENT
 * are different findings, and only `none` is the second one.
 */
function qddParentJoinReading_(j) {
  const total = j.sameAgent + j.otherAgent + j.none;
  if (!total) return 'no CSR-block legs to join.';
  if (j.none === 0) {
    return 'EVERY CSR-block leg belongs to a call DQE already counted -- the two figures '
      + 'are two VIEWS of the same calls (different legs of one call tree), not one set '
      + 'missing the other\'s calls. No agent is under-credited by this gap.';
  }
  if (j.none === total) {
    return 'NO CSR-block leg belongs to a call DQE counted -- these are genuinely separate '
      + 'calls the per-agent numbers never see. This IS under-crediting; drill the sample.';
  }
  return j.none + ' of ' + total + ' CSR-block legs belong to a call with NO DQE leg -- '
    + 'those are the only candidates for under-crediting; the rest are a second view of '
    + 'calls already counted.';
}

/** Writes the detail tab. The ONLY sheet this tool touches; created + cleared here. */
function qddWriteReportTab_(ss, rep) {
  const WIDTH = 14;
  let sheet = ss.getSheetByName(rep.tabName);
  if (!sheet) sheet = ss.insertSheet(rep.tabName);
  else sheet.clear();

  const pad = function (arr) {
    const r = arr.slice(0, WIDTH);
    while (r.length < WIDTH) r.push('');
    return r.map(function (v) { return v === null || v === undefined ? '' : v; });
  };
  const out = [];
  out.push(pad(['QCD vs DQE diagnostic', rep.date, 'dept: ' + rep.dept,
    rep.rows + ' legs scanned', 'source: ' + rep.source]));
  out.push(pad(['VERDICT', rep.verdict]));
  out.push(pad([]));
  out.push(pad(['RECONCILIATION']));
  out.push(pad(['QCD rows 35/36/37 col D — this tool',
    rep.qcdD[35], rep.qcdD[36], rep.qcdD[37], 'sum', rep.qcdD[35] + rep.qcdD[36] + rep.qcdD[37]]));
  out.push(pad(['QCD rows 35/36/37 col D — calcQcdReport',
    rep.realD[35], rep.realD[36], rep.realD[37], 'sum', rep.realD[35] + rep.realD[36] + rep.realD[37],
    rep.qcdReconciled ? 'OK' : 'MISMATCH']));
  out.push(pad(['DQE per-agent vs stored DQE Historical Data',
    rep.dqeReconciled ? 'OK' : (rep.dqeMismatches.length + ' agent(s) differ')]));
  rep.dqeMismatches.slice(0, 20).forEach(function (m) {
    out.push(pad(['  differs', m[0], 'recomputed=' + m[1], 'stored=' + m[2]]));
  });
  out.push(pad([]));
  out.push(pad(['TOTALS', rep.dept + ' roster', 'QCD block=' + rep.deptQcd,
    'DQE answered=' + rep.deptDqe, 'stored=' + rep.deptStored,
    'gap=' + (rep.deptQcd - rep.deptDqe)]));
  out.push(pad([]));
  out.push(pad(['CSR-block answered legs DQE also counts', rep.qcdAlsoDqe,
    'of', rep.qcdD[35] + rep.qcdD[36] + rep.qcdD[37]]));
  out.push(pad(['PARENT JOIN -- does the CSR-block leg belong to a call DQE already counted?']));
  out.push(pad(['  same agent (already in this agent\'s numbers)', rep.parentJoin.sameAgent]));
  out.push(pad(['  a different agent (in the dept\'s numbers, credited elsewhere)', rep.parentJoin.otherAgent]));
  out.push(pad(['  NOBODY -- no DQE leg on this call at all', rep.parentJoin.none]));
  out.push(pad(['  reading', qddParentJoinReading_(rep.parentJoin)]));
  Object.keys(rep.orphanCauses).sort().forEach(function (k) {
    out.push(pad(['    no-DQE-leg cause: ' + k, rep.orphanCauses[k]]));
  });
  out.push(pad(['  call-id range', 'DQE ' + rep.idRange.dqeMin + '..' + rep.idRange.dqeMax,
    'orphans ' + rep.idRange.orphanMin + '..' + rep.idRange.orphanMax]));
  if (rep.orphanSample.length) {
    out.push(pad(['  no-DQE-leg', 'Agent', 'Call key', 'Parent cell', 'Own call id',
      'Sheet row', 'QCD row', 'Status', 'Direction', 'Start', 'Cause',
      'Key seen as a call id today?', 'Legs on this call']));
  }
  rep.orphanSample.forEach(function (o) {
    out.push(pad(['  no-DQE-leg', o.agent, o.parentKey, o.parentRaw, o.callId,
      o.sheetRow, o.qcdRow, o.status, o.direction, o.start, o.cause,
      o.callIdSeenToday ? 'yes' : 'NO', o.legsOnThisCall]));
    out.push(pad(['    identity', 'caller: ' + o.caller, 'caller name: ' + o.callerName,
      'caller-ID (col W): ' + o.callerId, 'callee: ' + o.calleeName + ' (' + o.calleeExt + ')',
      'talk: ' + o.talk, 'wait: ' + o.wait,
      'flags: ' + [o.answeredFlag, o.missedFlag, o.abandonedFlag].join('/')]));
    if (!o.siblings.length) {
      out.push(pad(['    other legs on this call', 'NONE -- the call id resolves to '
        + 'nothing else in this sheet (a dangling reference, not a mislaid call)']));
    } else {
      out.push(pad(['    other legs on this call', 'Sheet row', 'Callee', 'Ext',
        'Caller', 'Caller name', 'Caller-ID (col W)', 'Direction', 'Status', 'Start',
        'Talk', 'Answered', 'Missed']));
      o.siblings.forEach(function (sib) {
        out.push(pad(['      leg', sib.sheetRow, sib.callee, sib.calleeExt, sib.caller,
          sib.callerName, sib.callerId, sib.direction, sib.status, sib.start, sib.talk,
          sib.answeredFlag, sib.missedFlag]));
      });
    }
  });
  out.push(pad([]));
  out.push(pad(['WHY THE CSR BLOCK COUNTED A LEG DQE DOES NOT']));
  Object.keys(rep.reasons).sort().forEach(function (k) { out.push(pad(['  ' + k, rep.reasons[k]])); });
  if (!Object.keys(rep.reasons).length) out.push(pad(['  (none — every CSR-block leg is also a DQE answered leg)']));
  out.push(pad([]));
  out.push(pad(['WHY DQE COUNTED A LEG THE CSR BLOCK DOES NOT (by queue)']));
  Object.keys(rep.dqeOnlyByQueue).sort().forEach(function (k) { out.push(pad(['  ' + k, rep.dqeOnlyByQueue[k]])); });
  if (!Object.keys(rep.dqeOnlyByQueue).length) out.push(pad(['  (none)']));
  out.push(pad([]));

  out.push(pad(['PER-AGENT CROSS-TAB']));
  out.push(pad(['Agent', 'On ' + rep.dept + ' roster', 'Roster dept(s)',
    QDD_ROW_LABELS_[35] + ' (r35)', QDD_ROW_LABELS_[36] + ' (r36)', QDD_ROW_LABELS_[37] + ' (r37)',
    'QCD block total', 'DQE answered (recomputed)', 'DQE answered (stored)', 'QCD - DQE']));
  rep.agents.forEach(function (a) {
    out.push(pad([a.agent, a.onDept ? 'YES' : 'no', a.depts,
      a.q35, a.q36, a.q37, a.qTotal, a.dqe, a.storedDqe, a.delta]));
  });
  out.push(pad([]));

  out.push(pad(['LEG DETAIL — counted by the CSR block, NOT counted by DQE'
    + (rep.detailTruncated ? ('  (+' + rep.detailTruncated + ' more, capped)') : '')]));
  out.push(pad(['Call_Legs row', 'QCD row', 'Agent (callee)', 'Raw callee', 'Caller',
    'Caller name', 'Caller-ID (col W)', 'Direction', 'Status', 'Start', 'End',
    'Answered flag', 'DQE gate that dropped it', 'Same call already counted?']));
  rep.detail.forEach(function (d) {
    out.push(pad([d.sheetRow, d.qcdRow, d.agent, d.rawCallee, d.caller, d.callerName,
      d.callerId, d.direction, d.status, d.start, d.end, d.answeredFlag, d.reason,
      d.sibling]));
  });

  sheet.getRange(1, 1, out.length, WIDTH).setValues(out);
  sheet.setFrozenRows(2);
  return sheet;
}
