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
 * CDR Import editor / CDR Tools menu:
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
 * READ-ONLY. Reports how the transfer filter would classify one Call_Legs tab
 * for one dept, with sample call ids to check. No arg date -> the ACTIVE tab
 * when it is a Call_Legs tab, else the most recent one. `queuesCsv` overrides
 * the dept's Dept Config queues. Returns the report lines.
 */
function previewTransferShapes(dateIso, dept, queuesCsv) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = tfFindCallLegsSheet_(ss, dateIso);
  if (!sheet) { Logger.log('previewTransferShapes: no Call_Legs sheet for ' + (dateIso || '(latest)') + '.'); return null; }
  var target = SpreadsheetApp.openById(getTargetSsId_());
  var cfg = target.getSheetByName('DO NOT EDIT!');
  if (!cfg) throw new Error('previewTransferShapes: "DO NOT EDIT!" not found in the CDR Report spreadsheet.');
  var roster = tfReadRoster_(cfg);
  dept = tfStr_(dept);
  if (!roster.byDept[dept]) {
    var msg = 'previewTransferShapes: "' + dept + '" is not a roster department. Departments: ' + roster.depts.join(', ');
    Logger.log(msg);
    return [msg];
  }

  icResetConfigMemos_();
  icLoadConfiguredQueueNames_();   // queue recognition exactly as the import run has it
  var queues, source;
  if (tfStr_(queuesCsv)) {
    queues = tfStr_(queuesCsv).split(',').map(tfStr_).filter(String);
    source = 'given';
  } else {
    queues = tfDeptQueuesFromConfig_(dept, icDeptConfigActiveRows_());
    source = 'Dept Config';
  }
  var queueExts = {};
  try {
    if (typeof dcBuildExtMaps_ === 'function') dcBuildExtMaps_(cfg).queueExtSet.forEach(function (e) { queueExts[e] = true; });
  } catch (e) { Logger.log('previewTransferShapes: queue-ext map unavailable (' + (e && e.message ? e.message : e) + ').'); }

  var rows = sheet.getDataRange().getDisplayValues();
  rows.shift();
  var res = tfClassifyTransfers_(rows, {
    queues: queues, roster: roster, dept: dept, canon: icAgentCanonicalizer_(), queueExts: queueExts
  });
  var m = sheet.getName().match(/(\d{4}-\d{2}-\d{2})$/);
  var lines = tfReportLines_(res, {
    date: m ? m[1] : sheet.getName(), dept: dept, queues: queues, queueSource: source,
    rosterCount: Object.keys(roster.byDept[dept].names).length,
    rosterExtCount: Object.keys(roster.byDept[dept].exts).length
  });
  lines.forEach(function (t) { Logger.log(t); });
  return lines;
}

/** Menu wrapper: prompts for the date, the dept and an optional queue list. */
function previewTransferShapesForDate() {
  var arg = icPreviewDateArg_();
  if (arg.cancelled) return;
  var ui = SpreadsheetApp.getUi();
  var depts = [];
  try {
    var cfg = SpreadsheetApp.openById(getTargetSsId_()).getSheetByName('DO NOT EDIT!');
    if (cfg) depts = tfReadRoster_(cfg).depts;
  } catch (e) { /* the run below reports it */ }
  var d = ui.prompt('Transfer shapes -- department',
    'Roster department (exactly as its header):\n' + depts.join(', '), ui.ButtonSet.OK_CANCEL);
  if (d.getSelectedButton() !== ui.Button.OK) return;
  var q = ui.prompt('Transfer shapes -- queues (optional)',
    "Comma-separated queue names to count for that department.\nLeave blank to use its Dept Config queues.",
    ui.ButtonSet.OK_CANCEL);
  if (q.getSelectedButton() !== ui.Button.OK) return;
  var lines = previewTransferShapes(arg.dateIso, d.getResponseText(), q.getResponseText()) || ['No Call_Legs sheet for that date.'];
  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var html = HtmlService.createHtmlOutput(
    '<textarea readonly style="width:100%;height:520px;font:12px monospace;white-space:pre">'
    + esc(lines.join('\n')) + '</textarea>').setWidth(1000).setHeight(580);
  ui.showModalDialog(html, 'Transfer shapes (read-only)');
}
