/**
 * Transfer filter -- Phase 0: the READ-ONLY shape probe (owner request
 * 2026-10-05).
 *
 * The goal is a CDR Tools filter that narrows the active Call_Legs tab to calls
 * TRANSFERRED to a chosen department -- into one of its queues, or directly to
 * one of its employees. The CDR has no "transfer" field, so the definition has
 * to be read off the leg shapes, and this phase exists to CHECK that reading on
 * real calls before any filter is built on it. Nothing here writes anything.
 *
 * Owner rulings (2026-10-05), which the later phases implement:
 *   - target = the active Call_Legs tab;
 *   - QUEUE transfers count whether or not they link to a customer call, with a
 *     "customer-linked only" option;
 *   - DIRECT transfers default to customer-linked only (an unlinked
 *     employee-to-employee call is indistinguishable from a colleague calling a
 *     colleague), with an option to allow unlinked ones;
 *   - the filter shows the WHOLE call, with a transfer-legs-only option;
 *   - sub-queues are not folded in (tick the extra queues instead);
 *   - whole day by default, with a work-window option.
 *
 * What counts, as implemented by tfClassifyTransfers_ below:
 *   QUEUE transfer  -- a leg whose CALLEE NAME is one of the dept's queues and
 *                      whose CALLER is an internal party (an extension, not a
 *                      customer number and not a queue delivering a call). The
 *                      same rule the CSR Transfer report counts by
 *                      (calcCsrReport: caller name -> callee queue), one per
 *                      root call.
 *   DIRECT transfer -- a leg whose CALLEE is one of the dept's rostered
 *                      employees (extension or roster name) and whose CALLER is
 *                      a different internal party, the same exclusions.
 *   LINK            -- the customer call a transfer belongs to: the same leg
 *                      tree when it carries a customer leg ("tree"), else the
 *                      transferring employee's concurrent captured inbound call
 *                      or outbound call, by the capture's OWN rule
 *                      (icBusyIndexes_ / icConcurrentMatches_ in
 *                      inboundCalls.js -- never a copy), unique match only.
 *   POSSIBLE BLIND  -- probe-only: a customer's own legs re-entering a dept
 *                      queue, or ringing a dept employee, AFTER someone else
 *                      answered. Whether these are transfers is exactly what
 *                      the probe asks the owner to check.
 *
 * PHI: the report never prints an external number or a customer's caller-ID
 * name. Employees are named; customers are "customer".
 *
 * CDR Import editor / CDR Tools -> Diagnostics:
 *   previewTransferShapes('2026-10-02', 'CSR')                 // Dept Config queues
 *   previewTransferShapes('2026-10-02', 'CSR', 'A_Q_CSR,A_Q_Intake')
 *   previewTransferShapesForDate()                             // prompts
 */

var TF_SAMPLES_PER_KIND_ = 3;

// ---- roster -----------------------------------------------------------------

/**
 * PURE. The `DO NOT EDIT!` roster block (INV-03 cells, INV-11 layout) as
 * per-dept names + extensions. `header` = row 1 from col F; `block` = rows 2..
 * from col F. Stops at the first blank header (the documented block boundary,
 * which keeps the insurance block at cols X-AG out). An agent on two rosters is
 * in both depts.
 */
function tfRosterFromGrid_(header, block) {
  var out = { depts: [], byDept: {}, nameOfExt: {}, extsOfName: {}, names: {} };
  var n = 0;
  while (n < (header || []).length && String(header[n] == null ? '' : header[n]).trim()) n++;
  out.depts = (header || []).slice(0, n).map(function (h) { return String(h).trim(); });
  out.depts.forEach(function (d) { out.byDept[d] = { names: {}, exts: {} }; });
  (block || []).forEach(function (row) {
    for (var c = 0; c < n; c++) {
      var raw = String(row[c] == null ? '' : row[c]).trim();
      if (!raw) continue;
      var parts = raw.split(',');
      var name = parts[0].trim();
      if (!name) continue;
      var d = out.byDept[out.depts[c]];
      d.names[name] = true;
      out.names[name] = true;
      parts.slice(1).forEach(function (t) {
        var ext = String(t).trim();
        if (!/^\d+$/.test(ext)) return;     // INV-03: digit-only tokens are extensions
        d.exts[ext] = true;
        if (!out.nameOfExt[ext]) out.nameOfExt[ext] = name;
        var list = out.extsOfName[name] = out.extsOfName[name] || [];
        if (list.indexOf(ext) === -1) list.push(ext);
      });
    }
  });
  return out;
}

function tfReadRoster_(configSheet) {
  var lastRow = configSheet.getLastRow(), lastCol = configSheet.getLastColumn();
  if (lastRow < 1 || lastCol < 6) return tfRosterFromGrid_([], []);
  var header = configSheet.getRange(1, 6, 1, lastCol - 5).getValues()[0];
  var block = lastRow >= 2 ? configSheet.getRange(2, 6, lastRow - 1, lastCol - 5).getValues() : [];
  return tfRosterFromGrid_(header, block);
}

/**
 * PURE. A dept's queue names from its ACTIVE Dept Config row (INV-54): QCD
 * Queues (col 2) plus both sides of every Inbound Queue Aliases token (col 10)
 * -- the raw side is what a Call_Legs tab carries. A dept with no row yields []
 * (the dashboard's seed constants are not visible to this project), and the
 * caller says so rather than guessing.
 */
function tfDeptQueuesFromConfig_(dept, rows) {
  var out = [];
  var add = function (v) {
    var t = String(v == null ? '' : v).trim();
    if (t && !/^\d+$/.test(t) && out.indexOf(t) === -1) out.push(t);
  };
  (rows || []).forEach(function (r) {
    if (String(r[0] == null ? '' : r[0]).trim() !== dept) return;
    String(r[1] == null ? '' : r[1]).split(',').forEach(add);
    String(r[9] == null ? '' : r[9]).split(',').forEach(function (tok) {
      String(tok).split('=').forEach(add);
    });
  });
  return out;
}

// ---- classifier -------------------------------------------------------------

function tfStr_(v) { return String(v == null ? '' : v).trim(); }

function tfSecOfDay_(ts) {
  var m = /\s(\d{1,2}):(\d{2}):(\d{2})$/.exec(tfStr_(ts));
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : -1;
}

// The INV-06 work window for a leg starting at `sec`, floored by the queue
// that delivered it (R49 -- dqeWindowStartForQueue_, the pipeline's own rule).
function tfInWindow_(sec, queueName) {
  if (sec < 0) return false;
  var floor = (typeof dqeWindowStartForQueue_ === 'function')
    ? dqeWindowStartForQueue_(queueName || null) : 6.5 * 3600;
  var end = (typeof DQE_WINDOW_END !== 'undefined') ? DQE_WINDOW_END : 15 * 3600;
  return sec >= floor && sec < end;
}

/**
 * PURE. Classifies one Call_Legs tab's legs (display rows, NO header) against a
 * department.
 *
 * spec = {
 *   queues:    [queue names]  -- the dept's queues (matched case-insensitively),
 *   roster:    tfRosterFromGrid_ output,
 *   dept:      roster header of the target dept,
 *   canon:     fn(name) -> roster-canonical name (identity when absent),
 *   queueExts: { ext: true } -- optional, the DO NOT EDIT! queue extensions
 * }
 *
 * Returns { totals, queueTabCounts, queue: [T], direct: [T], blindQueue: [B],
 * blindDirect: [B] } where a transfer T = { root, callId, legId, time, sec,
 * inWindow, caller: {name, ext, rostered}, target, link: {kind, root, n},
 * outcome: {state, by} } and B = { root, legId, time, sec, inWindow, answeredBy,
 * target }.
 */
function tfClassifyTransfers_(rows, spec) {
  rows = rows || [];
  var canon = (spec && spec.canon) || function (n) { return n; };
  var roster = (spec && spec.roster) || tfRosterFromGrid_([], []);
  var member = roster.byDept[spec && spec.dept] || { names: {}, exts: {} };
  var qset = {};
  ((spec && spec.queues) || []).forEach(function (q) { var t = tfStr_(q).toLowerCase(); if (t) qset[t] = true; });

  var groups = icGroupLegsByRoot_(rows);
  var rootOf = function (l) {
    var p = tfStr_(l[IC_COL.PARENT_CALL_ID]);
    return (p && p.toUpperCase() !== 'N/A') ? p : tfStr_(l[IC_COL.CALL_ID]);
  };
  var captured = {};
  (buildInboundCallRecords_(rows) || []).forEach(function (r) { if (!r.isInternal) captured[r.callId] = true; });
  var busy = icBusyIndexes_(groups, captured);

  // Queue extensions: configured ones + every ext this tab shows answering to a
  // queue name. A ring leg a queue delivers carries that ext (or "CallQueue
  // (n)") as CALLER, and its CALLER NAME can be the CUSTOMER's caller-ID name
  // -- so it must never read as an employee placing a call.
  var queueExts = {};
  Object.keys((spec && spec.queueExts) || {}).forEach(function (e) { queueExts[e] = true; });
  var queueTabCounts = {};
  rows.forEach(function (l) {
    var cn = tfStr_(l[IC_COL.CALLEE_NAME]);
    if (!icIsQueueName_(cn)) return;
    queueTabCounts[cn] = (queueTabCounts[cn] || 0) + 1;
    var d = icDigits_(l[IC_COL.CALLEE]);
    if (d && d.length < 10) queueExts[d] = true;
  });

  // The internal party who PLACED a leg, or null (customer, queue delivery,
  // IVR / blank).
  var placedBy = function (l) {
    var raw = tfStr_(l[IC_COL.CALLER]);
    if (!raw || icExternalNumber_(raw) || /callqueue/i.test(raw)) return null;
    var ext = icDigits_(raw);
    if (!ext || ext.length >= 10 || ext !== raw || queueExts[ext]) return null;
    var nm = tfStr_(l[IC_COL.CALLER_NAME]);
    if (icIsQueueName_(nm)) return null;
    var rname = roster.nameOfExt[ext] || null;
    var name = rname || (nm && nm.toUpperCase() !== 'N/A' ? canon(nm) : '') || ('ext ' + ext);
    return { name: name, ext: ext, rostered: !!(rname || roster.names[name]) };
  };
  // The dept employee a leg rings, or null.
  var ringsMember = function (l) {
    var callee = tfStr_(l[IC_COL.CALLEE]);
    var cn = tfStr_(l[IC_COL.CALLEE_NAME]);
    if (icExternalNumber_(callee) || icIsQueueName_(cn)) return null;
    var ext = icDigits_(callee);
    if (ext && ext === callee && member.exts[ext]) return { name: roster.nameOfExt[ext] || cn, ext: ext };
    var c = cn ? canon(cn) : '';
    if (c && member.names[c]) return { name: c, ext: ext || '' };
    return null;
  };
  var isTalk = function (l) {
    return tfStr_(l[IC_COL.ANSWERED]) === 'Answered' && icTimeToSec_(l[IC_COL.TALK]) > 0;
  };
  var hasCustomerLeg = function (g) {
    return g.some(function (l) {
      var dir = tfStr_(l[IC_COL.DIRECTION]);
      return (dir === 'Incoming' && icExternalNumber_(l[IC_COL.CALLER]))
          || (dir === 'Outgoing' && icExternalNumber_(l[IC_COL.CALLEE]));
    });
  };
  var linkFor = function (root, ext, tMs) {
    if (hasCustomerLeg(groups[root] || [])) return { kind: 'tree', root: root, n: 1 };
    if (!ext || isNaN(tMs)) return { kind: 'none', root: null, n: 0 };
    var inRoots = icDistinctRoots_(icConcurrentMatches_(busy.agentBusy, ext, tMs, root));
    if (inRoots.length === 1) return { kind: 'inbound', root: inRoots[0], n: 1 };
    if (inRoots.length > 1) return { kind: 'ambiguous', root: null, n: inRoots.length };
    var ob = icConcurrentMatches_(busy.outboundBusy, ext, tMs, root);
    if (ob.length === 1) return { kind: 'outbound', root: ob[0].root, n: 1 };
    if (ob.length > 1) return { kind: 'ambiguous', root: null, n: ob.length };
    return { kind: 'none', root: null, n: 0 };
  };
  // What happened to the transferred call AFTER the transfer leg, inside its
  // own leg tree. Informational -- a shared tree can hold a sibling's legs.
  var outcomeFor = function (root, leg, by) {
    var t0 = icParseTs_(leg[IC_COL.START]);
    var g = groups[root] || [];
    for (var i = 0; i < g.length; i++) {
      var l = g[i];
      if (!isTalk(l) || icExternalNumber_(l[IC_COL.CALLEE])) continue;
      if (icParseTs_(l[IC_COL.START]) < t0) continue;
      var who = icDigits_(l[IC_COL.CALLEE]);
      if (by && who === by.ext) continue;
      return { state: 'answered', by: roster.nameOfExt[who] || tfStr_(l[IC_COL.CALLEE_NAME]) || ('ext ' + who) };
    }
    var ab = g.some(function (l) {
      return tfStr_(l[IC_COL.ABANDONED]) === 'Abandoned' && icParseTs_(l[IC_COL.START]) >= t0;
    });
    return { state: ab ? 'abandoned' : 'not answered', by: null };
  };

  var queue = [], direct = [], seen = {};
  var sorted = rows.slice().sort(function (a, b) {
    return (icParseTs_(a[IC_COL.START]) || 0) - (icParseTs_(b[IC_COL.START]) || 0)
      || (Number(a[IC_COL.LEG_ID]) || 0) - (Number(b[IC_COL.LEG_ID]) || 0);
  });
  sorted.forEach(function (l) {
    var by = placedBy(l);
    if (!by) return;
    var root = rootOf(l);
    if (!root) return;
    var cn = tfStr_(l[IC_COL.CALLEE_NAME]);
    var target = null, list = null;
    if (icIsQueueName_(cn) && qset[cn.toLowerCase()]) { target = cn; list = queue; }
    else {
      var m = ringsMember(l);
      if (m && m.ext !== by.ext && m.name !== by.name) { target = m.name; list = direct; }
    }
    if (!list) return;
    var key = (list === queue ? 'q|' : 'd|') + root + '|' + by.ext + '|' + target;
    if (seen[key]) return;          // one per root call, as calcCsrReport counts
    seen[key] = true;
    var sec = tfSecOfDay_(l[IC_COL.START]);
    list.push({
      root: root, callId: tfStr_(l[IC_COL.CALL_ID]), legId: tfStr_(l[IC_COL.LEG_ID]),
      time: icIsoTime_(icParseTs_(l[IC_COL.START])) || '--:--:--', sec: sec,
      inWindow: tfInWindow_(sec, list === queue ? target : null),
      caller: by, target: target,
      link: linkFor(root, by.ext, icParseTs_(l[IC_COL.START])),
      outcome: outcomeFor(root, l, by)
    });
  });

  // Possible BLIND transfers: inside a captured customer call, a later leg
  // (the customer still the caller) re-enters a dept queue, or rings a dept
  // employee with no queue in between, after SOMEONE ELSE answered.
  var blindQueue = [], blindDirect = [];
  Object.keys(captured).forEach(function (root) {
    var g = (groups[root] || []).slice().sort(function (a, b) {
      return (icParseTs_(a[IC_COL.START]) || 0) - (icParseTs_(b[IC_COL.START]) || 0)
        || (Number(a[IC_COL.LEG_ID]) || 0) - (Number(b[IC_COL.LEG_ID]) || 0);
    });
    var answeredBy = null, answeredExt = null, answeredAt = NaN, queueSince = false, doneQ = false, doneD = false;
    g.forEach(function (l) {
      var cn = tfStr_(l[IC_COL.CALLEE_NAME]);
      var fromCustomer = !!icExternalNumber_(l[IC_COL.CALLER]);
      // Strictly AFTER the answer connected: a queue rings its agents in the
      // same second it is answered, and those rings are not transfers.
      var after = answeredBy && icParseTs_(l[IC_COL.START]) > answeredAt + 1000;
      if (after && fromCustomer) {
        var sec = tfSecOfDay_(l[IC_COL.START]);
        if (!doneQ && icIsQueueName_(cn) && qset[cn.toLowerCase()]) {
          blindQueue.push({ root: root, legId: tfStr_(l[IC_COL.LEG_ID]), time: icIsoTime_(icParseTs_(l[IC_COL.START])),
                            sec: sec, inWindow: tfInWindow_(sec, cn), answeredBy: answeredBy, target: cn });
          doneQ = true;
        } else if (!doneD && !queueSince) {
          var m = ringsMember(l);
          if (m && m.ext !== answeredExt) {
            blindDirect.push({ root: root, legId: tfStr_(l[IC_COL.LEG_ID]), time: icIsoTime_(icParseTs_(l[IC_COL.START])),
                               sec: sec, inWindow: tfInWindow_(sec, null), answeredBy: answeredBy, target: m.name });
            doneD = true;
          }
        }
      }
      if (icIsQueueName_(cn)) { if (answeredBy) queueSince = true; return; }
      if (isTalk(l) && !icExternalNumber_(l[IC_COL.CALLEE])) {
        var who = icDigits_(l[IC_COL.CALLEE]);
        answeredBy = roster.nameOfExt[who] || tfStr_(l[IC_COL.CALLEE_NAME]) || ('ext ' + who);
        answeredExt = who;
        answeredAt = icParseTs_(l[IC_COL.CONNECTED]);
        if (isNaN(answeredAt)) answeredAt = icParseTs_(l[IC_COL.START]);
        queueSince = false;
      }
    });
  });

  return {
    totals: { legs: rows.length, calls: Object.keys(groups).length, customerCalls: Object.keys(captured).length },
    queueTabCounts: queueTabCounts,
    queue: queue, direct: direct, blindQueue: blindQueue, blindDirect: blindDirect
  };
}

// ---- report -------------------------------------------------------------------

function tfLinkTally_(list) {
  var t = { tree: 0, inbound: 0, outbound: 0, ambiguous: 0, none: 0, inWindow: 0 };
  list.forEach(function (x) { t[x.link.kind]++; if (x.inWindow) t.inWindow++; });
  return t;
}

// Up to TF_SAMPLES_PER_KIND_ per link kind, in time order, so every kind the
// owner has to judge is represented.
function tfPickSamples_(list) {
  var per = {}, out = [];
  list.forEach(function (x) {
    var k = x.link.kind;
    per[k] = (per[k] || 0) + 1;
    if (per[k] <= TF_SAMPLES_PER_KIND_) out.push(x);
  });
  return out;
}

function tfLinkText_(link) {
  switch (link.kind) {
    case 'tree':     return 'customer leg in the same call tree';
    case 'inbound':  return 'linked: inbound call ' + link.root;
    case 'outbound': return 'linked: outbound call ' + link.root;
    case 'ambiguous':return 'NOT linked: ' + link.n + ' concurrent customer calls (ambiguous)';
    default:         return 'NOT linked: no customer call at that moment';
  }
}

/** PURE. The probe's report, one string per line. Prints no customer data. */
function tfReportLines_(res, meta) {
  meta = meta || {};
  var L = [];
  var dept = meta.dept || '?';
  L.push('previewTransferShapes ' + (meta.date || '(tab)') + ' -- dept ' + dept + ' -- READ-ONLY, nothing was changed.');
  L.push('Tab: ' + res.totals.legs + ' legs, ' + res.totals.calls + ' call trees, '
    + res.totals.customerCalls + ' customer inbound calls.');
  L.push('Queues counted for ' + dept + ' (' + (meta.queueSource || 'given') + '): '
    + ((meta.queues || []).join(', ') || '(none -- pass them explicitly)'));
  var lc = {};
  (meta.queues || []).forEach(function (q) { lc[String(q).toLowerCase()] = true; });
  var seen = Object.keys(res.queueTabCounts || {}).sort();
  L.push('Queue names on this tab (* = counted): ' + (seen.map(function (q) {
    return q + (lc[q.toLowerCase()] ? '*' : '') + ' (' + res.queueTabCounts[q] + ')';
  }).join(', ') || '(none)'));
  if (meta.rosterCount != null) L.push('Roster ' + dept + ': ' + meta.rosterCount + ' employees, ' + meta.rosterExtCount + ' extensions.');
  L.push('');

  var section = function (title, list, targetLabel) {
    var t = tfLinkTally_(list);
    L.push(title + ': ' + list.length + ' call(s); ' + t.inWindow + ' in the work window.');
    L.push('   customer-linked: ' + (t.tree + t.inbound + t.outbound) + ' (same tree ' + t.tree
      + ', concurrent inbound ' + t.inbound + ', concurrent outbound ' + t.outbound + ')'
      + '; ambiguous ' + t.ambiguous + '; unlinked ' + t.none + '.');
    tfPickSamples_(list).forEach(function (x) {
      L.push('   ' + x.time + '  call ' + x.root + ' (leg ' + x.legId + ')  '
        + x.caller.name + ' (ext ' + x.caller.ext + (x.caller.rostered ? '' : ', not on roster') + ')'
        + ' -> ' + targetLabel + x.target + '  [' + tfLinkText_(x.link) + ']  '
        + x.outcome.state + (x.outcome.by ? ' by ' + x.outcome.by : '') + (x.inWindow ? '' : '  (outside window)'));
    });
    L.push('');
  };
  section('(1) QUEUE transfers into ' + dept + "'s queues, placed by an employee", res.queue, '');
  section('(2) DIRECT transfers to a ' + dept + ' employee, placed by another employee', res.direct, '');

  var blind = function (title, list) {
    L.push(title + ': ' + list.length + ' call(s); '
      + list.filter(function (b) { return b.inWindow; }).length + ' in the work window.');
    list.slice(0, TF_SAMPLES_PER_KIND_ * 2).forEach(function (b) {
      L.push('   ' + b.time + '  call ' + b.root + ' (leg ' + b.legId + ')  customer, answered by '
        + b.answeredBy + ', then -> ' + b.target + (b.inWindow ? '' : '  (outside window)'));
    });
    L.push('');
  };
  blind('(3a) POSSIBLE BLIND transfers: the customer re-entered a ' + dept + ' queue after someone answered', res.blindQueue);
  blind('(3b) POSSIBLE BLIND transfers: the customer rang a ' + dept + ' employee directly after someone else answered', res.blindDirect);

  L.push('WHAT TO CHECK (look the sample call ids up in the phone system):');
  L.push('   (1) and (2): was each one really a transfer? Was the "linked" customer call the right call?');
  L.push('   (2) unlinked rows: these are what the "allow unlinked" option would add -- colleague calls or real transfers?');
  L.push('   (3a)/(3b): are these blind transfers? If so, the filter should include them; if they are re-routes, it should not.');
  return L;
}

// ---- entry points -------------------------------------------------------------

function tfFindCallLegsSheet_(ss, dateIso) {
  if (dateIso) return ss.getSheetByName('Call_Legs_' + dateIso);
  var active = ss.getActiveSheet();
  if (active && /^Call_Legs_\d{4}-\d{2}-\d{2}$/i.test(active.getName())) return active;
  var best = null, iso = '';
  ss.getSheets().forEach(function (s) {
    var m = s.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
    if (m && m[1] > iso) { iso = m[1]; best = s; }
  });
  return best;
}

/**
 * Shared probe runner (editor function + dialog). `queues` = an array of names
 * to count, or empty/null for the dept's Dept Config queues. Returns
 * {error} or {res, meta}. Reads only.
 */
function tfRunProbe_(dateIso, dept, queues) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = tfFindCallLegsSheet_(ss, dateIso);
  if (!sheet) return { error: 'No Call_Legs sheet for ' + (dateIso || '(latest)') + '.' };
  var target = SpreadsheetApp.openById(getTargetSsId_());
  var cfg = target.getSheetByName('DO NOT EDIT!');
  if (!cfg) return { error: '"DO NOT EDIT!" not found in the CDR Report spreadsheet.' };
  var roster = tfReadRoster_(cfg);
  dept = tfStr_(dept);
  if (!roster.byDept[dept]) {
    return { error: '"' + dept + '" is not a roster department. Departments: ' + roster.depts.join(', ') };
  }

  icResetConfigMemos_();
  icLoadConfiguredQueueNames_();   // queue recognition exactly as the import run has it
  var list = (queues || []).map(tfStr_).filter(String), source = 'chosen';
  if (!list.length) {
    list = tfDeptQueuesFromConfig_(dept, icDeptConfigActiveRows_());
    source = 'Dept Config';
  }
  var queueExts = {};
  try {
    if (typeof dcBuildExtMaps_ === 'function') dcBuildExtMaps_(cfg).queueExtSet.forEach(function (e) { queueExts[e] = true; });
  } catch (e) { Logger.log('tfRunProbe_: queue-ext map unavailable (' + (e && e.message ? e.message : e) + ').'); }

  var rows = sheet.getDataRange().getDisplayValues();
  rows.shift();
  var res = tfClassifyTransfers_(rows, {
    queues: list, roster: roster, dept: dept, canon: icAgentCanonicalizer_(), queueExts: queueExts
  });
  var m = sheet.getName().match(/(\d{4}-\d{2}-\d{2})$/);
  return { res: res, meta: {
    date: m ? m[1] : sheet.getName(), dept: dept, queues: list, queueSource: source,
    rosterCount: Object.keys(roster.byDept[dept].names).length,
    rosterExtCount: Object.keys(roster.byDept[dept].exts).length
  } };
}

/**
 * READ-ONLY, editor entry point. Reports how the transfer filter would
 * classify one Call_Legs tab for one dept, with sample call ids to check. No
 * date -> the ACTIVE tab when it is a Call_Legs tab, else the most recent one.
 * `queuesCsv` overrides the dept's Dept Config queues. Returns the report lines.
 * (The menu opens the dialog instead: showTransferShapesDialog.)
 */
function previewTransferShapes(dateIso, dept, queuesCsv) {
  var r = tfRunProbe_(dateIso, dept, tfStr_(queuesCsv) ? tfStr_(queuesCsv).split(',') : null);
  if (r.error) { Logger.log('previewTransferShapes: ' + r.error); return [r.error]; }
  var lines = tfReportLines_(r.res, r.meta);
  lines.forEach(function (t) { Logger.log(t); });
  return lines;
}

// ---- the dialog (CDR Tools -> Diagnostics -> Transfer shapes for a dept…) ----

/** PURE. Queue names on a tab's CALLEE NAME column with their leg counts, sorted. */
function tfTabQueueCounts_(names) {
  var by = {};
  (names || []).forEach(function (n) {
    var q = tfStr_(Array.isArray(n) ? n[0] : n);
    if (q && icIsQueueName_(q)) by[q] = (by[q] || 0) + 1;
  });
  return Object.keys(by).sort().map(function (q) { return { name: q, legs: by[q] }; });
}

/**
 * PURE. The dialog's structured result: header facts, one section per
 * transfer kind (counts, the link breakdown and EVERY matching call, in time
 * order) and the possible-blind lists in full, plus the plain-text summary
 * for copying (that one keeps tfReportLines_' samples). Employees and call
 * ids only; customers are never named (the same contract as tfReportLines_).
 */
function tfDialogPayload_(res, meta) {
  meta = meta || {};
  var counted = {};
  (meta.queues || []).forEach(function (q) { counted[String(q).toLowerCase()] = true; });
  var section = function (key, title, list) {
    var t = tfLinkTally_(list);
    return {
      key: key, title: title, total: list.length, inWindow: t.inWindow,
      links: { tree: t.tree, inbound: t.inbound, outbound: t.outbound, ambiguous: t.ambiguous, none: t.none },
      rows: list.map(function (x) {
        return { time: x.time, root: x.root, leg: x.legId, from: x.caller.name, fromExt: x.caller.ext,
                 rostered: !!x.caller.rostered, to: x.target, linkKind: x.link.kind, linkText: tfLinkText_(x.link),
                 linkRoot: x.link.root || null, outcome: x.outcome.state, by: x.outcome.by || null, inWindow: !!x.inWindow };
      })
    };
  };
  var blind = function (key, title, list) {
    return {
      key: key, title: title, total: list.length,
      inWindow: list.filter(function (b) { return b.inWindow; }).length,
      rows: list.map(function (b) {
        return { time: b.time, root: b.root, leg: b.legId, answeredBy: b.answeredBy, target: b.target, inWindow: !!b.inWindow };
      })
    };
  };
  var dept = meta.dept || '?';
  return {
    header: {
      date: meta.date || '', dept: dept, queues: (meta.queues || []).slice(), queueSource: meta.queueSource || '',
      legs: res.totals.legs, calls: res.totals.calls, customerCalls: res.totals.customerCalls,
      rosterCount: meta.rosterCount, rosterExtCount: meta.rosterExtCount,
      tabQueues: Object.keys(res.queueTabCounts || {}).sort().map(function (q) {
        return { name: q, legs: res.queueTabCounts[q], counted: !!counted[q.toLowerCase()] };
      })
    },
    sections: [
      section('queue', 'Queue transfers into ' + dept + "'s queues", res.queue),
      section('direct', 'Direct transfers to a ' + dept + ' employee', res.direct)
    ],
    blind: [
      blind('blindQueue', 'Re-entered a ' + dept + ' queue after someone answered', res.blindQueue),
      blind('blindDirect', 'Rang a ' + dept + ' employee directly after someone else answered', res.blindDirect)
    ],
    checks: [
      'Queue and direct transfers: is each one really a transfer, and is the linked customer call the right one?',
      'Unlinked direct transfers are what the "allow unlinked" option would add -- colleague calls, or real transfers?',
      'Possible blind transfers: blind transfers (the filter should include them) or re-routes (it should not)?'
    ],
    text: tfReportLines_(res, meta).join('\n')
  };
}

/** Menu item: CDR Tools -> Diagnostics -> Transfer shapes for a dept… */
function showTransferShapesDialog() {
  var html = HtmlService.createHtmlOutputFromFile('TransferShapesDialog').setWidth(1060).setHeight(720);
  SpreadsheetApp.getUi().showModalDialog(html, 'CDR Tools');
}

/** Dialog init: the Call_Legs tabs (newest first), the default one, and the roster depts. */
function tfDialogInit() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dates = [];
  ss.getSheets().forEach(function (s) {
    var m = s.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
    if (m) dates.push(m[1]);
  });
  dates.sort().reverse();
  var active = ss.getActiveSheet();
  var am = active ? active.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i) : null;
  var depts = [];
  try {
    var cfg = SpreadsheetApp.openById(getTargetSsId_()).getSheetByName('DO NOT EDIT!');
    if (cfg) depts = tfReadRoster_(cfg).depts;
  } catch (e) { Logger.log('tfDialogInit: roster unavailable (' + (e && e.message ? e.message : e) + ').'); }
  return { dates: dates, defaultDate: am ? am[1] : (dates[0] || ''), depts: depts };
}

// The most tabs one dialog run reads (one server call per tab). The workbook
// keeps ~14 days of Call_Legs tabs (#43), so this only bounds a runaway.
var TF_DIALOG_MAX_TABS_ = 31;

/**
 * Dialog: the queue checklist for one tab or a range of tabs + a dept (the
 * dept's Dept Config queues pre-ticked). `dates` is one ISO date or an array;
 * leg counts are summed across the tabs. Reads only the CALLEE NAME column.
 */
function tfDialogQueues(dates, dept) {
  var list = (Array.isArray(dates) ? dates : [dates]).map(tfStr_).filter(String);
  if (!list.length) throw new Error('Choose a Call_Legs tab.');
  if (list.length > TF_DIALOG_MAX_TABS_) throw new Error('Choose ' + TF_DIALOG_MAX_TABS_ + ' tabs or fewer.');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  icResetConfigMemos_();
  icLoadConfiguredQueueNames_();
  var names = [];
  list.forEach(function (d) {
    var sheet = tfFindCallLegsSheet_(ss, d);
    if (!sheet) throw new Error('No Call_Legs sheet for ' + d + '.');
    var last = sheet.getLastRow();
    if (last >= 2) names = names.concat(sheet.getRange(2, IC_COL.CALLEE_NAME + 1, last - 1, 1).getDisplayValues());
  });
  return {
    configured: tfDeptQueuesFromConfig_(tfStr_(dept), icDeptConfigActiveRows_()),
    onTab: tfTabQueueCounts_(names)
  };
}

/**
 * Dialog: run the probe on ONE tab. req = {date, dept, queues: [...]}. A range
 * is run by the dialog one tab per call (and combined there), so no call reads
 * more than one tab and none comes near the execution ceiling (#70).
 */
function tfDialogRun(req) {
  req = req || {};
  var queues = Array.isArray(req.queues) ? req.queues.slice(0, 80) : [];
  var r = tfRunProbe_(tfStr_(req.date), req.dept, queues);
  if (r.error) throw new Error(r.error);
  return tfDialogPayload_(r.res, r.meta);
}

// ---- XB-0 (owner 2026-10-28): transfers that came back ---------------------
// The owner's 10/22 Sales call: a Sales rep sent the caller to CSR by mistake
// and the CSR rep sent them back to Sales. The path shows it -- answered in
// one department, moved to another, then returned to the first -- and the
// mistake belongs to the FIRST transfer (the sender), the return is the fix.
// This READ-ONLY pass sizes it over the held Call_Legs_* tabs, from the SAME
// journeys the capture stores (IXT-1's person transfers included). Steps:
//   * a queue the caller entered -> its department (the Dept Config rows; a
//     queue with no row, or on two depts' rows, is skipped and counted);
//   * an agent who answered (talk > 0) -> their roster department. An agent
//     on two rosters (XB-0b, after the first run skipped 676 such steps) goes
//     to the department of the QUEUE that just rang them when it is one of
//     theirs, else stays in the department the call is already in when that
//     is one of theirs (which can never make a move), else is skipped and
//     counted;
//   * NOT a missed ring, an attempt or a consult (IXT-1): the caller did not
//     move, so a consult that ends with the original agent is no transfer.
// Consecutive steps in one department are one stint; a BOUNCE is a stint A
// in which an agent answered, later followed by A again with another
// department in between. "Sent back" = an agent of the middle department
// answered and sent the caller back; "came back unanswered" = it returned
// before anyone there answered (an overflow, or A pulling the call back).

// XB-0c (owner 2026-10-29): queues that are a way IN, not a department -- the
// sister brands' main lines (Universal Dialysis Center, Universal Urgent Care)
// and the after-hours queue. A step through one is ignored and counted, never
// "skipped": nothing is missing from the reading.
var TF_BOUNCE_ENTRY_QUEUES_ = ['UDC_A_Q_Main', 'UUC_A_Q_Main', 'A_Q_AfterHours'];

/**
 * PURE. The XB-0 reading of one journey. `deptsOfQueue(name)` /
 * `deptsOfAgent(name)` return arrays of department names.
 * Returns { stints, interDept, bounce: null | {from, to, sender, returner,
 * kind: 'sentBack'|'returnedUnanswered'}, skipped: {unmappedQueue,
 * twoDeptQueue, unknownAgent, twoRosterAgent}, unmappedQueues: [names],
 * unknownAgents: [names; a 7+-digit one as '(a number)'],
 * resolved: {byQueue, byStint} (XB-0b's two-roster placements),
 * entryQueues (XB-0c: steps through TF_BOUNCE_ENTRY_QUEUES_, ignored) }.
 */
function tfBounceOfJourney_(journey, deptsOfQueue, deptsOfAgent) {
  var out = { stints: [], interDept: false, bounce: null,
    skipped: { unmappedQueue: 0, twoDeptQueue: 0, unknownAgent: 0, twoRosterAgent: 0 }, unmappedQueues: [],
    unknownAgents: [], resolved: { byQueue: 0, byStint: 0 }, entryQueues: 0 };
  var entry = {};
  TF_BOUNCE_ENTRY_QUEUES_.forEach(function (q) { entry[q.toLowerCase()] = true; });
  var ringingDept = null;   // the department of the queue that rang the next answerer
  (journey || []).forEach(function (ev) {
    if (!ev || ev.origin) return;
    if (ev.transfer && (ev.missed || ev.consult)) return;   // the caller did not move
    var isQ = ev.kind === 'queue';
    var isAns = ev.kind === 'answer' && (Number(ev.talk) || 0) > 0;
    if (!isQ && !isAns) return;
    var name = String(ev.name == null ? '' : ev.name).trim();
    if (isQ && entry[name.toLowerCase()]) { out.entryQueues++; ringingDept = null; return; }
    var ds = (isQ ? deptsOfQueue(name) : deptsOfAgent(name)) || [];
    var rang = ringingDept;
    if (isQ) ringingDept = ds.length === 1 ? ds[0] : null;
    else ringingDept = null;   // an answer consumes the ring; a later direct hand-over has no queue
    if (!ds.length) {
      if (isQ) { out.skipped.unmappedQueue++; if (out.unmappedQueues.indexOf(name) === -1) out.unmappedQueues.push(name); }
      else {
        out.skipped.unknownAgent++;
        var shown = /\d{7,}/.test(name.replace(/\D/g, '')) ? '(a number)' : name;   // never log a phone number
        if (out.unknownAgents.indexOf(shown) === -1) out.unknownAgents.push(shown);
      }
      return;
    }
    var last = out.stints[out.stints.length - 1];
    var dept = ds[0];
    if (ds.length > 1) {
      if (isQ) { out.skipped.twoDeptQueue++; return; }
      if (rang && ds.indexOf(rang) !== -1) { dept = rang; out.resolved.byQueue++; }
      else if (last && ds.indexOf(last.dept) !== -1) { dept = last.dept; out.resolved.byStint++; }
      else { out.skipped.twoRosterAgent++; return; }
    }
    if (!last || last.dept !== dept) out.stints.push(last = { dept: dept, agents: [] });
    if (isAns && last.agents[last.agents.length - 1] !== name) last.agents.push(name);
  });
  var st = out.stints;
  for (var i = 0; i < st.length && !out.bounce; i++) {
    if (!st[i].agents.length) continue;
    if (i + 1 < st.length) out.interDept = true;
    for (var k = i + 2; k < st.length; k++) {
      if (st[k].dept !== st[i].dept) continue;
      var middle = st.slice(i + 1, k);
      var midAgents = [];
      middle.forEach(function (m) { midAgents = midAgents.concat(m.agents); });
      out.bounce = {
        from: st[i].dept, to: middle[0].dept,
        sender: st[i].agents[st[i].agents.length - 1],
        returner: midAgents.length ? midAgents[midAgents.length - 1] : null,
        kind: midAgents.length ? 'sentBack' : 'returnedUnanswered'
      };
      break;
    }
  }
  return out;
}

/** PURE. Department lookups from the roster (tfRosterFromGrid_) + the Dept Config rows. */
function tfBounceLookups_(roster, configRows, canon) {
  // XB-0c (owner 2026-10-29: "PAP is a part of Sales"): a sub-queue folds into
  // the department its Dept Config row names as Overview Parent (col C), ONE
  // level, exactly as the dashboard nests it (INV-38) -- so Sales <-> PAP is
  // no move, and an agent on the Sales and PAP rosters is on one department.
  // A sub-queue with no row of its own keeps its own name (cdr-import cannot
  // read the dashboard's seed map).
  var parentOf = {};
  (configRows || []).forEach(function (r) {
    var d = String(r[0] == null ? '' : r[0]).trim(), p = String(r[2] == null ? '' : r[2]).trim();
    if (d && p && p !== d) parentOf[d] = p;
  });
  var fold = function (d) { return parentOf[d] || d; };
  var add = function (map, key, d) {
    var list = map[key] = map[key] || [];
    if (list.indexOf(fold(d)) === -1) list.push(fold(d));
  };
  var agentDepts = {};
  (roster.depts || []).forEach(function (d) {
    Object.keys((roster.byDept[d] || {}).names || {}).forEach(function (n) { add(agentDepts, n, d); });
  });
  var queueDepts = {};
  (roster.depts || []).forEach(function (d) {
    tfDeptQueuesFromConfig_(d, configRows).forEach(function (q) { add(queueDepts, q.toLowerCase(), d); });
  });
  var c = canon || function (n) { return n; };
  return {
    parentOf: parentOf,
    deptsOfAgent: function (n) { return agentDepts[n] || agentDepts[c(n)] || []; },
    deptsOfQueue: function (q) { return queueDepts[String(q || '').toLowerCase()] || []; }
  };
}

/** PURE. Folds one call's XB-0 reading into a stats object. */
function tfBounceFold_(st, b, callId) {
  st.calls = (st.calls || 0) + 1;
  if (b.interDept) st.interDept = (st.interDept || 0) + 1;
  st.skipped = st.skipped || { unmappedQueue: 0, twoDeptQueue: 0, unknownAgent: 0, twoRosterAgent: 0 };
  Object.keys(b.skipped).forEach(function (k) { st.skipped[k] += b.skipped[k]; });
  st.unmappedQueues = st.unmappedQueues || {};
  b.unmappedQueues.forEach(function (q) { st.unmappedQueues[q] = (st.unmappedQueues[q] || 0) + 1; });
  st.unknownAgents = st.unknownAgents || {};
  (b.unknownAgents || []).forEach(function (n) { st.unknownAgents[n] = (st.unknownAgents[n] || 0) + 1; });
  st.resolved = st.resolved || { byQueue: 0, byStint: 0 };
  Object.keys(b.resolved || {}).forEach(function (k) { st.resolved[k] += b.resolved[k]; });
  if (Object.keys(b.skipped).some(function (k) { return b.skipped[k] > 0; })) st.callsWithSkip = (st.callsWithSkip || 0) + 1;
  st.entryQueues = (st.entryQueues || 0) + (b.entryQueues || 0);
  st.sentBack = st.sentBack || 0; st.returnedUnanswered = st.returnedUnanswered || 0;
  st.pairs = st.pairs || {}; st.senders = st.senders || {}; st.samples = st.samples || [];
  if (!b.bounce) return st;
  st[b.bounce.kind]++;
  var pair = b.bounce.from + ' -> ' + b.bounce.to + ' -> ' + b.bounce.from;
  st.pairs[pair] = (st.pairs[pair] || 0) + 1;
  var who = b.bounce.sender + ' (' + b.bounce.from + ')';
  st.senders[who] = (st.senders[who] || 0) + 1;
  if (st.samples.length < 8) st.samples.push(callId + ' ' + pair + (b.bounce.returner ? ', sent back by ' + b.bounce.returner : ', came back unanswered'));
  return st;
}

/** PURE. Top-N "key: n" list of a count map. */
function tfTopCounts_(map, n) {
  return Object.keys(map || {}).sort(function (a, b) { return (map[b] - map[a]) || (a < b ? -1 : 1); })
    .slice(0, n).map(function (k) { return k + ': ' + map[k]; });
}

/** PURE over one grid (testable): XB-0 over the capture's own outside-call records. */
function tfBouncesForGrid_(grid, lookups) {
  var st = { captured: 0 };
  buildInboundCallRecords_(grid).forEach(function (r) {
    if (r.isInternal) return;
    st.captured++;
    tfBounceFold_(st, tfBounceOfJourney_(r.journey || [], lookups.deptsOfQueue, lookups.deptsOfAgent), r.callId);
  });
  return st;
}

/** PURE. XB-0's per-date / TOTAL line. */
function tfBounceLine_(st) {
  var sk = st.skipped || {};
  return String(st.captured || 0) + ' captured outside calls; moved to another department after being answered '
    + String(st.interDept || 0) + '; CAME BACK to the first department ' + String((st.sentBack || 0) + (st.returnedUnanswered || 0))
    + ' (sent back by the other department ' + String(st.sentBack || 0) + ', came back before anyone there answered '
    + String(st.returnedUnanswered || 0) + '); steps skipped -- queue on no Dept Config row ' + String(sk.unmappedQueue || 0)
    + ', queue on two depts\' rows ' + String(sk.twoDeptQueue || 0) + ', answerer not on the roster ' + String(sk.unknownAgent || 0)
    + ', answerer on two rosters ' + String(sk.twoRosterAgent || 0)
    + ' (calls with any step skipped ' + String(st.callsWithSkip || 0) + '); two-roster answerers placed -- by the queue that rang them '
    + String((st.resolved || {}).byQueue || 0) + ', in the department the call was already in ' + String((st.resolved || {}).byStint || 0)
    + '; steps through an entry queue (ignored) ' + String(st.entryQueues || 0);
}

/**
 * XB-0 (owner 2026-10-28): READ-ONLY. Over the held Call_Legs_* tabs
 * (`dateIso` = one date, 'all' = every held date, blank = the latest): how
 * many outside calls were moved to another department after being answered,
 * how many CAME BACK to the first one, by department trio and by the agent who
 * sent them out first, with call-id samples for Caller Lookup and the queues
 * the pass could not place (map them in Dept Config to count them). Employee
 * and queue names and call ids only, never a number. Writes nothing.
 */
function diagnoseTransferBounces(dateIso) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = [];
  ss.getSheets().forEach(function (s) {
    var m = s.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
    if (m) sheets.push({ iso: m[1], sheet: s });
  });
  sheets.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });
  if (dateIso && dateIso !== 'all') sheets = sheets.filter(function (x) { return x.iso === dateIso; });
  else if (!dateIso) sheets = sheets.slice(-1);
  if (!sheets.length) { Logger.log('[xb] no Call_Legs sheet for %s.', dateIso || '(latest)'); return null; }
  var target = SpreadsheetApp.openById(getTargetSsId_());
  var cfg = target.getSheetByName('DO NOT EDIT!');
  if (!cfg) { Logger.log('[xb] "DO NOT EDIT!" not found in the CDR Report spreadsheet.'); return null; }
  icResetConfigMemos_();
  icLoadConfiguredQueueNames_();
  var lookups = tfBounceLookups_(tfReadRoster_(cfg), icDeptConfigActiveRows_(), icAgentCanonicalizer_());
  var subs = Object.keys(lookups.parentOf).sort().map(function (d) { return d + ' -> ' + lookups.parentOf[d]; });
  Logger.log('[xb] sub-queues folded into their parent: %s', subs.length ? subs.join('; ')
    : 'none (no active Dept Config row names an Overview Parent)');
  Logger.log('[xb] entry queues ignored: %s', TF_BOUNCE_ENTRY_QUEUES_.join(', '));
  var total = { captured: 0, days: 0 };
  var t0 = Date.now();
  for (var i = 0; i < sheets.length; i++) {
    if (Date.now() - t0 > 4 * 60 * 1000) { Logger.log('[xb] stopped at the 4-minute budget before %s.', sheets[i].iso); break; }
    var grid = sheets[i].sheet.getDataRange().getDisplayValues();
    grid.shift();
    var st = tfBouncesForGrid_(grid, lookups);
    Logger.log('[xb] %s: %s', sheets[i].iso, tfBounceLine_(st));
    total.days++;
    total.captured += st.captured;
    ['calls', 'interDept', 'sentBack', 'returnedUnanswered', 'callsWithSkip', 'entryQueues'].forEach(function (k) { total[k] = (total[k] || 0) + (st[k] || 0); });
    total.resolved = total.resolved || { byQueue: 0, byStint: 0 };
    Object.keys(st.resolved || {}).forEach(function (k) { total.resolved[k] += st.resolved[k]; });
    total.skipped = total.skipped || { unmappedQueue: 0, twoDeptQueue: 0, unknownAgent: 0, twoRosterAgent: 0 };
    Object.keys(st.skipped || {}).forEach(function (k) { total.skipped[k] += st.skipped[k]; });
    ['pairs', 'senders', 'unmappedQueues', 'unknownAgents'].forEach(function (k) {
      total[k] = total[k] || {};
      Object.keys(st[k] || {}).forEach(function (x) { total[k][x] = (total[k][x] || 0) + st[k][x]; });
    });
    total.samples = (total.samples || []).concat((st.samples || [])).slice(0, 8);
  }
  Logger.log('[xb] TOTAL over %s date(s): %s', String(total.days), tfBounceLine_(total));
  var pairs = tfTopCounts_(total.pairs, 10), senders = tfTopCounts_(total.senders, 10), unq = tfTopCounts_(total.unmappedQueues, 8);
  if (pairs.length) Logger.log('[xb]   by department: %s', pairs.join('; '));
  if (senders.length) Logger.log('[xb]   by the agent who sent the caller out first: %s', senders.join('; '));
  if (total.samples && total.samples.length) Logger.log('[xb]   e.g.: %s', total.samples.join('; '));
  if (unq.length) Logger.log('[xb]   queues not placed (no Dept Config row -- calls entering them): %s', unq.join('; '));
  var unk = tfTopCounts_(total.unknownAgents, 10);
  if (unk.length) Logger.log('[xb]   answerers not on any roster (calls they answered): %s', unk.join('; '));
  return total;
}

/** Editor-run: every held date (the Run picker can't pass 'all'). */
function diagnoseTransferBouncesAllDates() { return diagnoseTransferBounces('all'); }
