/**
 * TR-1 (owner 2026-11-02): TRANSFER RETRIES -- the admin list behind
 * Admin ▾ → Transfer retries.
 *
 * "CSR calls Power rep #1, rep #1 rejects, and CSR ends up calling Power rep
 * #2 while on the same call": the list to check for incorrect transfer
 * rejections. It reads the person-transfer events the capture already stores
 * on each call's journey (IXT-1 inbound, OXT-1 outbound -- a missed ring
 * `{missed, transfer}`, `voicemail` when it fell to voicemail, or an answered
 * consult `{consult, transfer}`), so it needs no new capture and sees exactly
 * what Caller Lookup's path shows.
 *
 * P3 (owner 2026-11-13) adds a SECOND list, `redirects`: the first person
 * tried in D ANSWERED and talked, and the sender then went to someone else in
 * D on the same call ("X answers and they discuss, then the CSR calls Y, and Y
 * takes the call") -- with how long X talked and who in D took the caller.
 * It is kept apart from `cases`, so every figure built on `cases` is unchanged.
 *
 * A RETRY is a missed attempt to X in department D (not the sender's own),
 * followed later on the SAME call by an attempt to Y (not X) in D -- one case
 * per call per department. The sender is the agent who last answered (or took
 * a hand-over) before the attempt on an inbound call, the dialling agent on an
 * outbound one. Departments come from the roster (`buildDeptsByAgent_`), with
 * a sub-queue folded into its Overview Parent one level (INV-38's map), so
 * Sales -> PAP is no move.
 *
 * THE RULE IS cdr-import's `tfRetriesOfJourney_` (transferFilter.js, TR-0's
 * diagnostic) -- the same reading on the same journeys. It is mirrored here,
 * not called (two Apps Script projects), and PINNED BEHAVIOURALLY:
 * tests/unit/transfer-retries.test.js drives both copies over one set of
 * journeys and fails on any difference. Change one, change both.
 *
 * P10 (owner 2026-11-13) adds WAS THE PERSON FREE? to a retry's first attempt.
 * A person-transfer attempt is its own internal call, and the per-call direct
 * list (`direct_calls`, AC-6) already holds it as an inbound internal direct
 * call to X -- with `missed_free` / `missed_busy` and who the blocking call
 * was with (ADT-2). The journey event carries NO call id for it, so the two
 * are matched on date + person + time (+ the sender's name when the record
 * names one): trAvailMatch_. A case shows "free" / "on a call" ONLY on a
 * confident match; everything else says why it is not known, and the payload
 * counts each reason -- so the match rate is on the page, and
 * probeTransferRetryAvailability() logs it with samples. Attached AFTER the
 * rule (trRetriesOfJourney_ is untouched, so cdr-import parity stands).
 *
 * Admin-only (assertAdmin_), read-only, Neon-only: the journey JSON lives in
 * inbound_calls / outbound_calls (the export tabs carry it too, but a sheet
 * fallback is not built -- an unreachable Neon reads "unavailable"). Employee
 * names and call ids only: no caller number is selected.
 */

var TR_MAX_RANGE_DAYS_ = 92;
var TR_MAX_CASES_ = 500;
// A missed attempt that rang this many seconds or fewer reads as a DECLINE.
// Mirrors cdr-import's TF_RETRY_QUICK_SECS_ (parity-pinned).
var TR_QUICK_SECS_ = 8;

// P10: how far an attempt's time may sit outside its direct-call record's ring
// (both come from the same leg's START cell, so 0 is the expected offset).
var TR_AVAIL_SLACK_SECS_ = 3;
// P10: the probe's SECOND, wide pass -- what a looser rule would add.
var TR_AVAIL_WIDE_SECS_ = 30;
var TR_AVAIL_SAMPLES_ = 5;

/** PURE. "HH:MM:SS" -> seconds (NaN when not that shape). */
function trHmsToSec_(t) {
  var m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(t || ''));
  return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : NaN;
}

/** PURE. How a person-transfer attempt ended: answered / voicemail / quickDecline / rangOut / unknown. */
function trRetryOutcome_(ev) {
  if (ev.consult) return 'answered';
  // TR-2 (owner 2026-11-04, from the TR-0 census): ring time decides BEFORE
  // voicemail. A miss that rang TR_QUICK_SECS_ (8) s or less was sent away by the person
  // (decline, often straight to voicemail -- 20 of 61 first attempts did,
  // all labelled voicemail before); "voicemail" now means the ring ran out
  // to it (~12-17 s here). 8x8's Cause cannot tell the two apart.
  var secs = (ev.secs == null || isNaN(Number(ev.secs))) ? null : Number(ev.secs);
  if (secs != null && secs <= TR_QUICK_SECS_) return 'quickDecline';
  if (ev.voicemail) return 'voicemail';
  if (secs == null) return 'unknown';
  return 'rangOut';
}

/**
 * PURE. The TR-0 reading of one call's journey (cdr-import's
 * tfRetriesOfJourney_, mirrored). `sender0` = the dialling agent of an
 * OUTBOUND call, null for inbound. Returns { attempts, cases: [...],
 * skipped: { senderUnknown, targetUnknown, targetTwoDepts } }.
 */
function trRetriesOfJourney_(journey, deptsOfAgent, sender0) {
  var out = { attempts: 0, cases: [], redirects: [], skipped: { senderUnknown: 0, targetUnknown: 0, targetTwoDepts: 0 } };
  var sender = sender0 || null;
  var senderAt = null;   // P3: when the sender answered the caller (inbound; an outbound call has no such event)
  var queue = null;      // P3: the first queue the call came in on
  var att = [], hands = [];
  var secsBetween = function (from, to) {
    var d = trHmsToSec_(to) - trHmsToSec_(from);
    return isNaN(d) || d < 0 ? null : d;
  };
  (journey || []).forEach(function (ev) {
    if (!ev || ev.origin) return;
    if (ev.kind === 'queue' && queue == null) queue = String(ev.name || '').trim() || null;
    // P3: who TOOK the call -- the colleague's leg with the caller (IXT-1's hand-over).
    if (ev.handover) hands.push({ name: String(ev.name || '').trim(), t: ev.t });
    if (ev.kind === 'answer' && (!ev.transfer || ev.handover) && (Number(ev.talk) || 0) > 0 && !sender0) {
      sender = String(ev.name || '').trim() || sender;
      senderAt = ev.t || null;
      return;
    }
    if (!ev.transfer || !(ev.missed || ev.consult)) return;
    out.attempts++;
    var sd = sender ? (deptsOfAgent(sender) || []) : [];
    if (!sd.length) { out.skipped.senderUnknown++; return; }
    var name = String(ev.name || '').trim();
    var td = deptsOfAgent(name) || [];
    if (!td.length) { out.skipped.targetUnknown++; return; }
    if (td.length > 1) { out.skipped.targetTwoDepts++; return; }
    if (sd.indexOf(td[0]) !== -1) return;   // a colleague in the sender's own department
    att.push({ ev: ev, name: name, dept: td[0], senderName: sender, senderDept: sd[0], senderAt: senderAt, queue: queue });
  });
  var done = {};
  for (var i = 0; i < att.length; i++) {
    var a = att[i];
    if (done[a.dept] || !a.ev.missed) continue;
    for (var j = i + 1; j < att.length; j++) {
      var b = att[j];
      if (b.dept !== a.dept || b.name === a.name) continue;
      var more = 0;
      for (var k = j + 1; k < att.length; k++) if (att[k].dept === a.dept) more++;
      // The gap runs to the retry's own event: a missed ring's start, or an
      // answered consult's CONNECT (the time it was picked up).
      var gap = trHmsToSec_(b.ev.t) - trHmsToSec_(a.ev.t);
      out.cases.push({
        senderName: a.senderName, senderDept: a.senderDept, dept: a.dept,
        // P3: when the sender answered the caller, the queue it came in on, and
        // how long they had been on the call when they first tried.
        senderAt: a.senderAt, queue: a.queue, beforeSecs: a.senderAt ? secsBetween(a.senderAt, a.ev.t) : null,
        first: { name: a.name, t: a.ev.t, secs: a.ev.secs, outcome: trRetryOutcome_(a.ev) },
        second: { name: b.name, t: b.ev.t, secs: b.ev.secs, outcome: trRetryOutcome_(b.ev) },
        gapSecs: isNaN(gap) || gap < 0 ? null : gap, moreInDept: more
      });
      done[a.dept] = true;
      break;
    }
  }
  // P3 (owner 2026-11-13): ANSWERED, THEN REDIRECTED. The first person tried in
  // department D picked up and talked (a consult), and the sender then went to
  // someone ELSE in D on the same call -- "X answers and they discuss, then the
  // CSR has to call Y, and Y takes the call". One per call per department, kept
  // apart from `cases` (whose first attempt was NOT answered), so every figure
  // built on `cases` is what it was. `takenBy` is who in D took the caller (a
  // hand-over at or after the first consult), or null when nobody in D did.
  var doneR = {};
  for (var x = 0; x < att.length; x++) {
    var p = att[x];
    if (doneR[p.dept] || !p.ev.consult) continue;
    for (var y = x + 1; y < att.length; y++) {
      var n2 = att[y];
      if (n2.dept !== p.dept || n2.name === p.name) continue;
      var moreR = 0;
      for (var z = y + 1; z < att.length; z++) if (att[z].dept === p.dept) moreR++;
      var took = null;
      for (var hi = 0; hi < hands.length && took === null; hi++) {
        if (trHmsToSec_(hands[hi].t) < trHmsToSec_(p.ev.t)) continue;   // a hand-over before the consult is not about it
        if ((deptsOfAgent(hands[hi].name) || []).indexOf(p.dept) !== -1) took = hands[hi].name;
      }
      out.redirects.push({
        senderName: p.senderName, senderDept: p.senderDept, dept: p.dept,
        senderAt: p.senderAt, queue: p.queue, beforeSecs: p.senderAt ? secsBetween(p.senderAt, p.ev.t) : null,
        first: { name: p.name, t: p.ev.t, talk: Number(p.ev.talk) || 0 },
        second: { name: n2.name, t: n2.ev.t, secs: n2.ev.secs, outcome: trRetryOutcome_(n2.ev),
                  talk: n2.ev.consult ? (Number(n2.ev.talk) || 0) : null },
        gapSecs: secsBetween(p.ev.t, n2.ev.t), moreInDept: moreR, takenBy: took
      });
      doneR[p.dept] = true;
      break;
    }
  }
  return out;
}

/**
 * PURE. name -> [folded depts] from a { name: [depts] } map and a
 * { child: parent } map (one level, deduped) -- the same lookup shape the
 * cdr-import side builds (tfBounceLookups_).
 */
function trDeptsOfAgentFn_(byAgent, parentOf) {
  var memo = {};
  return function (n) {
    if (memo[n]) return memo[n];
    var out = [];
    ((byAgent || {})[n] || []).forEach(function (d) {
      var f = (parentOf && parentOf[d]) || d;
      if (out.indexOf(f) === -1) out.push(f);
    });
    memo[n] = out;
    return out;
  };
}

/** PURE (NUM-5). A department as the cases name it: its one-level parent, or itself. */
function trFoldDept_(dept, parentOf) {
  var d = String(dept || '');
  return (d && parentOf && parentOf[d]) || d;
}

/**
 * PURE (P10). The direct-call record of ONE transfer attempt, among the
 * person's inbound internal direct calls of that date (`rows`: [{ start, ring,
 * outcome, other, busyWith }], times on the journey's own clock).
 *
 * A record FITS when the attempt's time sits inside its ring, give or take
 * `slack` seconds, and it does not name a DIFFERENT caller than the sender. A
 * record naming the sender beats one naming nobody; among several, the ring
 * that started closest wins, and a tie is `ambiguous` (never a guess).
 * Returns { state: 'free' | 'busy' | 'noRow' | 'ambiguous' | 'conflict',
 * with?, off?, bySender? } -- `conflict` = the record says the call was
 * answered (or carries no outcome), which the journey's missed ring denies.
 */
function trAvailMatch_(rows, t, senderName, slack) {
  var ts = trHmsToSec_(t);
  if (isNaN(ts)) return { state: 'noRow' };
  var sl = (slack == null) ? TR_AVAIL_SLACK_SECS_ : Number(slack) || 0;
  var sender = String(senderName || '').trim();
  var named = [], blank = [];
  (rows || []).forEach(function (r) {
    var s0 = trHmsToSec_(r && r.start);
    if (isNaN(s0)) return;
    var ring = Math.max(0, Number(r.ring) || 0);
    if (ts < s0 - sl || ts > s0 + ring + sl) return;
    var other = String(r.other == null ? '' : r.other).trim();
    if (other && sender && other === sender) named.push({ r: r, off: ts - s0 });
    else if (!other || !sender) blank.push({ r: r, off: ts - s0 });
    // a record naming someone else is another colleague's call: never ours
  });
  var pool = named.length ? named : blank;
  if (!pool.length) return { state: 'noRow' };
  pool.sort(function (x, y) { return Math.abs(x.off) - Math.abs(y.off); });
  if (pool.length > 1 && Math.abs(pool[0].off) === Math.abs(pool[1].off)) return { state: 'ambiguous' };
  var hit = pool[0], oc = String(hit.r.outcome || '');
  var out = { off: hit.off, bySender: !!named.length };
  if (oc === 'missed_free') out.state = 'free';
  else if (oc === 'missed_busy') { out.state = 'busy'; out.with = String(hit.r.busyWith || '').trim() || null; }
  else out.state = 'conflict';
  return out;
}

/**
 * PURE (P10; mutates `cases`). Sets each case's `first.avail` = { state, with? }
 * and returns the tally the page and the probe print. `direct` = { rows: [{
 * date, agent, start, ring, outcome, other, busyWith }], days: [iso...] } --
 * `days` are the dates that hold ANY direct-call record, so a date the per-call
 * list never covered reads `noDay`, apart from a ring it could not find.
 */
function trAttachAvailability_(cases, direct, slack) {
  var tally = { attempts: 0, known: 0, free: 0, busy: 0, noDay: 0, noRow: 0, ambiguous: 0, conflict: 0,
                bySender: 0, offsets: { exact: 0, near: 0, inRing: 0 }, samples: { noRow: [], ambiguous: [], conflict: [] } };
  var days = {}, byKey = {};
  ((direct && direct.days) || []).forEach(function (d) { days[String(d)] = true; });
  ((direct && direct.rows) || []).forEach(function (r) {
    if (!r) return;
    var k = String(r.date) + '|' + String(r.agent);
    (byKey[k] = byKey[k] || []).push(r);
  });
  (cases || []).forEach(function (c) {
    if (!c || !c.first) return;
    tally.attempts++;
    var m = days[c.date] ? trAvailMatch_(byKey[c.date + '|' + c.first.name], c.first.t, c.senderName, slack) : { state: 'noDay' };
    c.first.avail = { state: m.state };
    if (m.state === 'busy' && m.with) c.first.avail.with = m.with;
    tally[m.state]++;
    if (m.state === 'free' || m.state === 'busy') {
      tally.known++;
      if (m.bySender) tally.bySender++;
      var ao = Math.abs(m.off);
      tally.offsets[ao === 0 ? 'exact' : (ao <= TR_AVAIL_SLACK_SECS_ ? 'near' : 'inRing')]++;
    } else if (tally.samples[m.state] && tally.samples[m.state].length < TR_AVAIL_SAMPLES_) {
      tally.samples[m.state].push(c.date + ' ' + c.callId + ' ' + c.first.name + ' ' + (c.first.t || ''));
    }
  });
  return tally;
}

/**
 * PURE (testable). Rows [{ kind, date, callId, start, agent, journey }] ->
 * the payload's cases + summary, optionally kept to cases whose TRIED
 * department is `dept`. P10: `opts.attach(cases)` (optional) runs over EVERY
 * case before the tallies and the cap, and returns the availability tally
 * (trAttachAvailability_) -- so the callee counts stay exact past the cap.
 */
function trBuildFromRows_(rows, deptsOfAgent, dept, opts) {
  var cases = [], redirects = [], calls = 0, attempts = 0;
  var skipped = { senderUnknown: 0, targetUnknown: 0, targetTwoDepts: 0 };
  (rows || []).forEach(function (r) {
    var j = r.journey;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { return; } }   // an unreadable journey is no call
    if (!Array.isArray(j)) return;
    calls++;
    var res = trRetriesOfJourney_(j, deptsOfAgent, r.kind === 'outbound' ? (r.agent || null) : null);
    attempts += res.attempts;
    Object.keys(skipped).forEach(function (k) { skipped[k] += res.skipped[k]; });
    res.cases.forEach(function (c) {
      if (dept && c.dept !== dept) return;
      cases.push({ kind: r.kind, date: r.date, callId: r.callId, start: r.start || '',
        senderName: c.senderName, senderDept: c.senderDept, dept: c.dept,
        senderAt: c.senderAt, queue: c.queue, beforeSecs: c.beforeSecs,   // P3
        first: c.first, second: c.second, gapSecs: c.gapSecs, moreInDept: c.moreInDept });
    });
    // P3: answered, then redirected -- its own list (see trRetriesOfJourney_).
    (res.redirects || []).forEach(function (c) {
      if (dept && c.dept !== dept) return;
      redirects.push({ kind: r.kind, date: r.date, callId: r.callId, start: r.start || '',
        senderName: c.senderName, senderDept: c.senderDept, dept: c.dept,
        senderAt: c.senderAt, queue: c.queue, beforeSecs: c.beforeSecs,
        first: c.first, second: c.second, gapSecs: c.gapSecs, moreInDept: c.moreInDept, takenBy: c.takenBy });
    });
  });
  var newestFirst = function (x, y) {
    return (x.date < y.date ? 1 : x.date > y.date ? -1 : 0) || (x.first.t < y.first.t ? 1 : x.first.t > y.first.t ? -1 : 0);
  };
  redirects.sort(newestFirst);
  // Who is most often the person who answered and was then passed over, with
  // how long they talked and how often a colleague ended up taking the call.
  var byFirst = {};
  redirects.forEach(function (c) {
    var fk = c.first.name + '|' + c.dept;
    if (!byFirst[fk]) byFirst[fk] = { name: c.first.name, dept: c.dept, n: 0, talkSecs: 0, tookByOther: 0 };
    byFirst[fk].n++;
    byFirst[fk].talkSecs += Number(c.first.talk) || 0;
    if (c.takenBy && c.takenBy !== c.first.name) byFirst[fk].tookByOther++;
  });
  var redirectFirsts = Object.keys(byFirst).map(function (k) { return byFirst[k]; })
    .sort(function (x, y) { return (y.n - x.n) || (y.tookByOther - x.tookByOther) || String(x.name).localeCompare(String(y.name)); });
  var redirectTotal = redirects.length;
  cases.sort(function (x, y) {
    return (x.date < y.date ? 1 : x.date > y.date ? -1 : 0) || (x.first.t < y.first.t ? 1 : x.first.t > y.first.t ? -1 : 0);
  });
  // P10: was the person free? Attached to every case BEFORE the tallies.
  var avail = (opts && typeof opts.attach === 'function') ? opts.attach(cases) : null;
  var byOutcome = {}, byCallee = {}, byPair = {};
  cases.forEach(function (c) {
    byOutcome[c.first.outcome] = (byOutcome[c.first.outcome] || 0) + 1;
    var ck = c.first.name + '|' + c.dept;
    if (!byCallee[ck]) {
      byCallee[ck] = { name: c.first.name, dept: c.dept, n: 0, quickDecline: 0 };
      if (avail) { byCallee[ck].free = 0; byCallee[ck].busy = 0; }
    }
    byCallee[ck].n++;
    if (c.first.outcome === 'quickDecline') byCallee[ck].quickDecline++;
    if (avail && c.first.avail && (c.first.avail.state === 'free' || c.first.avail.state === 'busy')) byCallee[ck][c.first.avail.state]++;
    var pk = c.senderDept + ' → ' + c.dept;
    byPair[pk] = (byPair[pk] || 0) + 1;
  });
  var callees = Object.keys(byCallee).map(function (k) { return byCallee[k]; })
    .sort(function (x, y) { return (y.n - x.n) || (y.quickDecline - x.quickDecline) || String(x.name).localeCompare(String(y.name)); });
  var pairs = Object.keys(byPair).map(function (k) { return { pair: k, n: byPair[k] }; })
    .sort(function (x, y) { return (y.n - x.n) || (x.pair < y.pair ? -1 : 1); });
  var total = cases.length;
  var summary0 = avail ? { avail: avail } : {};
  return {
    summary: Object.assign(summary0, { calls: calls, attempts: attempts, cases: total, byOutcome: byOutcome, skipped: skipped,
               callees: callees.slice(0, 25), pairs: pairs.slice(0, 15),
               redirects: redirectTotal, redirectFirsts: redirectFirsts.slice(0, 25),
               redirectsTaken: redirects.filter(function (c) { return c.takenBy && c.takenBy !== c.first.name; }).length }),
    cases: cases.slice(0, TR_MAX_CASES_),
    truncated: total > TR_MAX_CASES_,
    redirects: redirects.slice(0, TR_MAX_CASES_),
    redirectsTruncated: redirectTotal > TR_MAX_CASES_
  };
}

/**
 * The journeys that can hold a case, both captures, one statement (metered).
 * Only journeys with a person-transfer event AND a missed ring (a retry) or an
 * answered consult (P3: answered, then redirected) can carry one: a text
 * prefilter keeps the read to a few percent of calls.
 */
function trFetchJourneyRows_(conn, from, to) {
  var pre = " AND journey LIKE '%\"transfer\":true%'"
    + " AND (journey LIKE '%\"missed\":true%' OR journey LIKE '%\"consult\":true%')";
  var sql = "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
    + "SELECT 'inbound' AS kind, call_date::text AS date, call_id AS \"callId\", call_start AS start, NULL::text AS agent, journey "
    + "FROM inbound_calls WHERE call_date BETWEEN ?::date AND ?::date AND COALESCE(is_internal, false) = false" + pre
    + " UNION ALL "
    + "SELECT 'outbound', call_date::text, call_id, call_start, agent_name, journey "
    + "FROM outbound_calls WHERE call_date BETWEEN ?::date AND ?::date" + pre
    + ") t";
  var stmt = conn.prepareStatement(sql);
  stmt.setString(1, from); stmt.setString(2, to); stmt.setString(3, from); stmt.setString(4, to);
  var rs = stmt.executeQuery();
  var json = rs.next() ? rs.getString('j') : '[]';
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'transfer-retries');
  rs.close(); stmt.close();
  var rows = JSON.parse(json || '[]');
  return Array.isArray(rows) ? rows : [];
}

/**
 * P10: the direct-call records the cases' first attempts can match -- the
 * inbound INTERNAL direct calls of each (date, person tried first), plus which
 * of those dates hold any direct-call record at all. One statement, metered;
 * employee names only (no hash, no number, no dial-in). `busy_with` is read
 * through to_jsonb so a table without that column still answers.
 */
function trFetchDirectFor_(conn, cases) {
  var seen = {}, pairs = [];
  (cases || []).forEach(function (c) {
    if (!c || !c.first || !c.first.name || !c.date) return;
    var k = c.date + '|' + c.first.name;
    if (seen[k]) return;
    seen[k] = true;
    pairs.push([c.date, c.first.name]);
  });
  if (!pairs.length) return { rows: [], days: [] };
  var p = "(SELECT DISTINCT (x->>0)::date AS dt, x->>1 AS ag FROM json_array_elements(?::json) x)";
  var sql = "SELECT json_build_object("
    + "'rows', (SELECT COALESCE(json_agg(t), '[]'::json) FROM ("
    +   "SELECT d.call_date::text AS date, d.agent_name AS agent, d.call_start AS start, d.ring_sec AS ring, "
    +   "d.outcome, d.other_name AS other, to_jsonb(d)->>'busy_with' AS \"busyWith\" "
    +   "FROM direct_calls d JOIN " + p + " p ON d.call_date = p.dt AND d.agent_name = p.ag "
    +   "WHERE d.direction = 'in' AND d.side = 'int') t), "
    + "'days', (SELECT COALESCE(json_agg(q.dt::text), '[]'::json) FROM (SELECT DISTINCT dt FROM " + p + " p2) q "
    +   "WHERE EXISTS (SELECT 1 FROM direct_calls e WHERE e.call_date = q.dt))"
    + ")::text AS j";
  var pj = JSON.stringify(pairs);
  var stmt = conn.prepareStatement(sql);
  stmt.setString(1, pj); stmt.setString(2, pj);
  var rs = stmt.executeQuery();
  var json = rs.next() ? rs.getString('j') : '';
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'transfer-retries');
  rs.close(); stmt.close();
  var o = JSON.parse(json || '{}');
  return { rows: (o && Array.isArray(o.rows)) ? o.rows : [], days: (o && Array.isArray(o.days)) ? o.days : [] };
}

/**
 * P10: the `attach` callback for trBuildFromRows_. A failed direct-call read
 * (the table not created yet, a timeout) NEVER costs the list: no case gets an
 * `avail`, and the tally says the read failed.
 */
function trAvailAttacher_(conn, slack) {
  return function (cases) {
    if (!cases || !cases.length) return null;
    try {
      return trAttachAvailability_(cases, trFetchDirectFor_(conn, cases), slack);
    } catch (e) {
      Logger.log('Transfer retries: the direct-call read failed (free / on a call not shown): ' + (e && e.message ? e.message : e));
      return { unavailable: true, attempts: cases.length, known: 0 };
    }
  };
}

/**
 * ADMIN-ONLY, read-only. req = { from, to, dept? } -- dept keeps the cases
 * whose TRIED department is that one (blank = every department).
 */
function getTransferRetries(req) {
  assertAdmin_();
  var user = resolveUser_(Session.getActiveUser().getEmail());
  var from = String((req && req.from) || '').trim();
  var to = String((req && req.to) || '').trim();
  var dept = String((req && req.dept) || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');
  assertReportRangeCap_(from, to, TR_MAX_RANGE_DAYS_, 'Transfer retries');
  var depts = getAllDepartments_();
  if (dept && depts.indexOf(dept) === -1) throw new Error('Unknown department: ' + dept);
  var out = { meta: { from: from, to: to, dept: dept, available: true, quickSecs: TR_QUICK_SECS_,
                      truncated: false, generatedAt: new Date().toISOString() },
              summary: null, cases: [], redirects: [] };
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { out.meta.available = false; return out; }
    var rows = trFetchJourneyRows_(conn, from, to);
    var parentOf = getOverviewParentMap_() || {};
    var fn = trDeptsOfAgentFn_(buildDeptsByAgent_(), parentOf);
    // NUM-5: every case's department is FOLDED to its parent (a sub-queue is
    // the same team for this question), so the filter folds too -- picking a
    // sub-queue used to match nothing and read as "no retries". The payload
    // says which department was counted.
    var filterDept = dept ? trFoldDept_(dept, parentOf) : '';
    if (filterDept !== dept) { out.meta.deptAsked = dept; out.meta.dept = filterDept; }
    var built = trBuildFromRows_(rows, fn, filterDept, { attach: trAvailAttacher_(conn) });   // P10
    out.summary = built.summary;
    out.cases = built.cases;
    out.meta.truncated = built.truncated;
    out.redirects = built.redirects;                         // P3
    out.meta.redirectsTruncated = built.redirectsTruncated;
    try { logReportUsage_('transfer-retries', dept || '(all)', user, false); } catch (eU) { /* best-effort */ }
    return out;
  } catch (e) {
    Logger.log('getTransferRetries failed: ' + (e && e.message ? e.message : e));
    out.meta.available = false;
    out.meta.error = 'Transfer retries could not be read just now.';
    return out;
  } finally {
    try { if (conn) conn.close(); } catch (ce) {}
  }
}

/** ADMIN-ONLY: the department list the modal's picker offers. */
function getTransferRetriesInit() {
  assertAdmin_();
  return { departments: getAllDepartments_(), maxDays: TR_MAX_RANGE_DAYS_, quickSecs: TR_QUICK_SECS_ };
}

/**
 * P10 (Operator State #89): READ-ONLY, editor-run, admin-gated. How often can
 * a retry's first attempt be matched to its direct-call record -- the check
 * behind the list's "free / on a call" column, over the last 30 days ending
 * yesterday, every department. Runs the SAME rule the list uses, then a second
 * pass with a wide (30 s) allowance to show what a looser rule would add.
 * Read the VERDICT first: GOOD (90%+ of attempts on covered dates matched),
 * PARTIAL, POOR, or INCONCLUSIVE (under 20 attempts on covered dates -- widen
 * the dates by waiting, never by guessing). Writes nothing.
 */
function probeTransferRetryAvailability() {
  assertAdmin_();
  var todayIso = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var shift = function (iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  var to = shift(todayIso, -1), from = shift(todayIso, -30);
  var out = { from: from, to: to, verdict: 'FAILED', tally: null, wide: null };
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { Logger.log('probeTransferRetryAvailability: Neon is unreachable -- nothing read.'); return out; }
    var rows = trFetchJourneyRows_(conn, from, to);
    var fn = trDeptsOfAgentFn_(buildDeptsByAgent_(), getOverviewParentMap_() || {});
    var direct = null;
    var built = trBuildFromRows_(rows, fn, '', { attach: function (cases) {
      direct = trFetchDirectFor_(conn, cases);
      return trAttachAvailability_(cases, direct, TR_AVAIL_SLACK_SECS_);
    } });
    var t = built.summary.avail || trAttachAvailability_([], null);
    out.tally = t;
    // The wide pass re-reads the SAME records over the capped list (a probe window rarely reaches the cap).
    out.wide = direct ? trAttachAvailability_(JSON.parse(JSON.stringify(built.cases)), direct, TR_AVAIL_WIDE_SECS_) : null;
    var covered = t.attempts - t.noDay;
    var rate = covered ? t.known / covered : 0;
    out.covered = covered;
    out.ratePct = covered ? Math.round(rate * 1000) / 10 : null;
    out.verdict = covered < 20 ? 'INCONCLUSIVE' : (rate >= 0.9 ? 'GOOD' : (rate >= 0.6 ? 'PARTIAL' : 'POOR'));
    var L = [];
    L.push('Transfer retries -- was the person free? Match check, ' + from + ' to ' + to + ' (all departments).');
    L.push('VERDICT: ' + out.verdict + (out.ratePct == null ? '' : ' -- ' + out.ratePct + '% of first attempts on covered dates matched (' + t.known + ' of ' + covered + ').'));
    L.push('Retries read: ' + t.attempts + '. On dates with no direct-call records: ' + t.noDay + ' (not counted in the rate).');
    L.push('Matched: ' + t.known + ' (' + t.free + ' free, ' + t.busy + ' on a call). The record named the sender in ' + t.bySender + '.');
    L.push('  time offset: same second ' + t.offsets.exact + ', within ' + TR_AVAIL_SLACK_SECS_ + ' s ' + t.offsets.near + ', later in the ring ' + t.offsets.inRing + '.');
    L.push('Not matched: no record found ' + t.noRow + ', more than one fits ' + t.ambiguous + ', record disagrees (answered) ' + t.conflict + '.');
    if (out.wide) L.push('With a ' + TR_AVAIL_WIDE_SECS_ + ' s allowance instead: ' + out.wide.known + ' matched, ' + out.wide.noRow + ' not found, ' + out.wide.ambiguous + ' with more than one fit.');
    ['noRow', 'ambiguous', 'conflict'].forEach(function (k) {
      if (t.samples[k].length) L.push('  ' + k + ' samples (date, call id, person, Pacific time): ' + t.samples[k].join(' | '));
    });
    if (built.truncated) L.push('NOTE: more than ' + TR_MAX_CASES_ + ' retries in the window; the wide pass read the newest ' + TR_MAX_CASES_ + '.');
    Logger.log(L.join('\n'));
    return out;
  } catch (e) {
    Logger.log('probeTransferRetryAvailability failed: ' + (e && e.message ? e.message : e));
    out.error = String(e && e.message ? e.message : e);
    return out;
  } finally {
    try { if (conn) conn.close(); } catch (ce) {}
  }
}
