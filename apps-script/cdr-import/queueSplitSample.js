/**
 * Per-agent CALL ID sample for the DQE queue split. Read-only, editor-run.
 * cdr-import ONLY -- not an INV-16 byte-identical duplicated file.
 *
 * Why this exists: `DQE Historical Data` col AI stores per-queue COUNTS, not
 * call ids, so "CSR answered 269 on A_Q_CSR" cannot be spot-checked against the
 * phone system without re-deriving the underlying legs. This lists them.
 *
 * IT VERIFIES ITSELF, AND THAT IS THE POINT. The build's leg parser and its
 * helpers (`displayToTimeSec`, `canonicalizeAgentName`) are NESTED inside
 * `buildDQEHistoricalData`, so nothing outside that function can call them --
 * this file necessarily re-derives the legs. A second implementation you are
 * asked to trust is worth very little, so for every agent it recomputes the
 * split through the REAL `dqeQueueSplitForAgent_` (module-level, shared with
 * the build) and compares the result against what col AI actually stored. A
 * mismatch is printed as MISMATCH with both figures: either this tool's parse
 * drifted from the build's, or the sheet is stale relative to Raw Data. Only
 * agents marked OK can be sampled with confidence.
 *
 * SCOPE: reads the `Raw Data` tab, which holds the MOST RECENTLY IMPORTED
 * date. To sample an older date, re-import it first (its Call_Legs source must
 * still exist -- pruned at 14 days).
 *
 * Script Properties (all optional):
 *   SAMPLE_AGENT   -- limit to one agent (exact name as it appears in col C)
 *   SAMPLE_QUEUE   -- limit to one raw queue name, e.g. "Backup CSR"
 *   SAMPLE_MAX_IDS -- call ids printed per agent+queue (default 25)
 *
 * Writes nothing.
 */
function sampleQueueSplitCallIds() {
  var props = PropertiesService.getScriptProperties();
  var wantAgent = String(props.getProperty('SAMPLE_AGENT') || '').trim();
  var wantQueue = String(props.getProperty('SAMPLE_QUEUE') || '').trim().toLowerCase();
  var maxIds = parseInt(props.getProperty('SAMPLE_MAX_IDS'), 10);
  if (!maxIds || maxIds < 1) maxIds = 25;

  var targetSS = SpreadsheetApp.openById(getTargetSsId_());
  var raw = targetSS.getSheetByName('Raw Data');
  var dqe = targetSS.getSheetByName('DQE Historical Data');
  if (!raw) { Logger.log('No Raw Data tab.'); return; }
  if (raw.getLastRow() < 2) { Logger.log('Raw Data is empty.'); return; }

  var grid = raw.getDataRange().getDisplayValues();
  var body = grid.slice(1);

  // --- rebuild the queue legs, mirroring the build's parser -----------------
  // Kept deliberately literal rather than "improved": any divergence here is a
  // divergence from the numbers on the dashboard, which is the one thing this
  // tool must not introduce. The self-check below is what catches a slip.
  function timeSec(str) {
    if (!str) return null;
    var parts = String(str).trim().split(' ');
    if (parts.length < 2) return null;
    var t = parts[1].split(':');
    if (t.length < 2) return null;
    return (parseInt(t[0]) || 0) * 3600 + (parseInt(t[1]) || 0) * 60 + (parseInt(t[2]) || 0);
  }

  // ISO-normalize any M/D/YYYY-ish date so the two sides can be compared.
  //
  // THE TRAP, and it is a documented one (F-3 / F-10 in known-issues): the
  // build writes col B as the STRING "07/30/2026", but Sheets COERCES a
  // date-shaped string cell to a real Date, after which getDisplayValues
  // returns it in the cell's display format -- "7/30/2026", no leading zeros.
  // Comparing that to Raw Data's "07/30/2026" matches NOTHING, which is exactly
  // what happened on the first live run: all 73 agents reported "NO DQE ROW",
  // including plain names with no paren variant at all, and the tool blamed
  // canonicalization for it. The standing rule is to compare ISO-NORMALIZED
  // display values, never raw strings.
  function dateIso(v) {
    var t = String(v == null ? '' : v).trim().split(' ')[0];
    if (!t) return '';
    var m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;   // already ISO
    return t;                                        // unrecognized: compare as-is
  }

  var legsByAgent = {};
  var dateSeen = {};
  var skippedNoQueue = 0, skippedExcluded = 0;
  for (var i = 0; i < body.length; i++) {
    var row = body[i];
    var callerIdRaw = String(row[DQE_C.CALLER_ID]).trim();
    var qn = callerIdRaw.match(/(?:^|[^\w&])(A_Q_[\w&]+|Backup CSR)/);
    if (!qn) { skippedNoQueue++; continue; }
    if (/^CallForking/i.test(String(row[DQE_C.CALLEE]).trim())) continue;
    // NOTE: no canonicalizeAgentName here -- it is nested in the build and
    // needs the roster. A paren-variant name therefore groups under its RAW
    // spelling and will show as UNMATCHED below rather than being silently
    // folded into the wrong agent.
    var agent = String(row[DQE_C.CALLEE_NAME]).trim();
    if (!agent || agent === 'N/A') continue;
    if (DQE_EXCLUDED_AGENTS.indexOf(agent) !== -1) { skippedExcluded++; continue; }

    var startRaw = row[DQE_C.START_TIME];
    var d = dateIso(startRaw);
    if (d) dateSeen[d] = (dateSeen[d] || 0) + 1;

    (legsByAgent[agent] = legsByAgent[agent] || []).push({
      agentName: agent,
      queueName: qn[1],
      parentCallId: String(row[DQE_C.PARENT_CALL]).trim(),
      callId: String(row[DQE_C.CALL_ID]).trim(),
      missed: String(row[DQE_C.MISSED]).trim() === 'Missed',
      answered: String(row[DQE_C.ANSWERED]).trim() === 'Answered',
      startPST: timeSec(startRaw),
      startRaw: String(startRaw || '').trim(),
    });
  }

  var dates = Object.keys(dateSeen).sort();
  Logger.log('=== Queue-split call-id sample ===');
  Logger.log('Raw Data rows: %s   queue legs: %s   (skipped: no queue in caller-id %s, '
    + 'pseudo-agent %s)', body.length,
    Object.keys(legsByAgent).reduce(function (n, k) { return n + legsByAgent[k].length; }, 0),
    skippedNoQueue, skippedExcluded);
  Logger.log('Date(s) present in Raw Data: %s', dates.join(', ') || '(none)');
  if (dates.length > 1) {
    Logger.log('!! More than one date in Raw Data -- the build stamps ONE date per run, '
      + 'so these totals will not line up with a single DQE row set.');
  }
  Logger.log('Work window: legs from %s to %s PST count toward the totals; '
    + 'anything outside is listed as (out-of-window) and is EXCLUDED by INV-07.',
    Math.floor(DQE_WINDOW_START / 3600) + ':' + ('0' + ((DQE_WINDOW_START % 3600) / 60)).slice(-2),
    Math.floor(DQE_WINDOW_END / 3600) + ':00');

  // --- stored split, for the self-check ------------------------------------
  var storedByAgent = {};
  if (dqe && dqe.getLastRow() > 1 && dates.length === 1) {
    var width = Math.min(35, dqe.getMaxColumns());
    if (width >= 35) {
      var drows = dqe.getRange(2, 1, dqe.getLastRow() - 1, width).getDisplayValues();
      for (var r = 0; r < drows.length; r++) {
        if (dateIso(drows[r][1]) !== dates[0]) continue;
        storedByAgent[String(drows[r][2]).trim()] = String(drows[r][34] || '').trim();
      }
    } else {
      Logger.log('!! DQE Historical Data is %s cols wide -- col AI does not exist, so the '
        + 'self-check cannot run. Deploy the Phase 1 pipeline first.', width);
    }
  }

  var agents = Object.keys(legsByAgent).sort();
  if (wantAgent) agents = agents.filter(function (a) { return a === wantAgent; });
  if (!agents.length) {
    Logger.log('No agent matched%s.', wantAgent ? ' "' + wantAgent + '"' : '');
    return;
  }

  var unmatched = [];
  agents.forEach(function (agent) {
    var all = legsByAgent[agent];
    var inWin = all.filter(function (l) {
      return l.startPST !== null && l.startPST >= DQE_WINDOW_START && l.startPST < DQE_WINDOW_END;
    });

    // Recompute through the REAL function the build uses, so the numbers below
    // are the build's own arithmetic and not a paraphrase of it.
    var mineJson = dqeQueueSplitForAgent_(inWin,
      function () { return 0; },          // talk time is irrelevant to a call-id sample
      function (s) { return String(s); });
    var mine = JSON.parse(mineJson);

    var storedRaw = storedByAgent[agent];
    var verdict;
    if (storedRaw === undefined) {
      verdict = 'NO DQE ROW (name differs from col C after canonicalization?)';
      unmatched.push(agent);
    } else if (!storedRaw) {
      verdict = 'DQE row has NO split (pre-Phase-1 or the split threw)';
    } else {
      var stored = {};
      try { stored = JSON.parse(storedRaw); } catch (e) { stored = null; }
      if (!stored) {
        verdict = 'stored split is unparseable';
      } else {
        var diffs = [];
        var keys = {};
        Object.keys(mine).forEach(function (k) { keys[k] = true; });
        Object.keys(stored).forEach(function (k) { keys[k] = true; });
        Object.keys(keys).sort().forEach(function (k) {
          var a = mine[k] || { r: 0, m: 0, a: 0 }, b = stored[k] || { r: 0, m: 0, a: 0 };
          if ((a.r || 0) !== (b.r || 0) || (a.m || 0) !== (b.m || 0) || (a.a || 0) !== (b.a || 0)) {
            diffs.push(k + ' sample(r' + (a.r || 0) + '/m' + (a.m || 0) + '/a' + (a.a || 0)
              + ') vs sheet(r' + (b.r || 0) + '/m' + (b.m || 0) + '/a' + (b.a || 0) + ')');
          }
        });
        verdict = diffs.length ? ('MISMATCH -- ' + diffs.join('; ')) : 'OK (matches col AI)';
      }
    }

    Logger.log('');
    Logger.log('--- %s   [%s]', agent, verdict);
    Object.keys(mine).sort().forEach(function (q) {
      if (wantQueue && q.toLowerCase() !== wantQueue) return;
      var e = mine[q];
      var legs = inWin.filter(function (l) { return (l.queueName || '') === q; });
      // String() each count: Apps Script hands a JS number to Logger as a Java
      // Double, so a bare %s prints "5.0" where the sheet says 5.
      Logger.log('    %s  rung=%s missed=%s answered=%s  unique=%s',
        q, String(e.r), String(e.m), String(e.a), String(e.u));
      legs.slice(0, maxIds).forEach(function (l) {
        Logger.log('      %s  call=%s  parent=%s  %s',
          l.startRaw, l.callId, l.parentCallId || '(none)',
          l.answered ? 'ANSWERED' : (l.missed ? 'missed' : '(neither)'));
      });
      if (legs.length > maxIds) {
        Logger.log('      ... %s more (raise SAMPLE_MAX_IDS)', legs.length - maxIds);
      }
    });

    var out = all.filter(function (l) {
      return !(l.startPST !== null && l.startPST >= DQE_WINDOW_START && l.startPST < DQE_WINDOW_END);
    });
    if (out.length && !wantQueue) {
      Logger.log('    (out-of-window: %s leg(s) EXCLUDED from every total -- INV-07)', out.length);
      out.slice(0, Math.min(5, maxIds)).forEach(function (l) {
        Logger.log('      %s  call=%s  %s', l.startRaw || '(no start)', l.callId, l.queueName);
      });
    }
  });

  var storedCount = Object.keys(storedByAgent).length;
  if (unmatched.length) {
    Logger.log('');
    if (!storedCount) {
      // Distinguish a LOOKUP failure from per-agent name variance. If not one
      // DQE row was found for this date, blaming canonicalization sends the
      // reader after 73 imaginary problems -- which this tool did on its first
      // live run, before the date normalization above was fixed.
      Logger.log('!! NO DQE rows matched %s at all, so EVERY agent reports unmatched. '
        + 'That is a lookup failure, not 73 name variants. Either the date has not '
        + 'been built into DQE Historical Data yet, or col B\'s display format is '
        + 'something dateIso() does not recognize -- check col B for this date.', dates[0]);
    } else {
      Logger.log('!! %s of %s agent name(s) in Raw Data have no DQE row for this date '
        + '(%s DQE rows matched): %s',
        String(unmatched.length), String(agents.length), String(storedCount),
        unmatched.join(', '));
      Logger.log('   This tool does NOT canonicalize agent names (the build does, against '
        + 'the roster), so a paren variant like "Roman Paulose" vs "Roman (Robin) Paulose" '
        + 'shows up here rather than being folded in. Their calls DO count on the '
        + 'dashboard under the canonical name -- check the Outlier Fix modal if a name '
        + 'looks genuinely unmapped.');
    }
  }
}
