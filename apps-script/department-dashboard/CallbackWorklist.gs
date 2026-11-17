/**
 * P11 (owner decision 2026-11-17): the CALLBACK WORKLIST -- the callers nobody
 * has called back yet, with the ONE place in the dashboard where a caller's
 * phone number can be shown.
 *
 * Everywhere else a caller is a hash (inbound_calls.caller_hash): no report,
 * email, export, cache or log carries a number. This page is the exception
 * the owner approved, on five terms, each enforced HERE on the server:
 *
 *   1. WHO   -- admins; a manager only for their OWN department's callers, and
 *               only while the `CALLBACK_NUMBERS_MANAGERS` Script Property is
 *               exactly `true` (default off). The outbound vetting gate
 *               (outboundResolveRequest_) applies first, as it does to every
 *               callback surface.
 *   2. WHERE -- this page only. A number is never written to Neon, a sheet,
 *               the cache, an email or a log line; it exists in one RPC reply.
 *   3. HOW MUCH -- ONE call per request (revealCallbackNumber). The list
 *               endpoint never carries a number, and a per-user hourly cap
 *               (CBW_REVEAL_CAP_) stops the list being walked row by row.
 *   4. AUDIT -- every request is appended to the `Callback Number Log` sheet
 *               BEFORE the reply: who, when, department, call date, call id
 *               and how it ended -- never the number. If that row cannot be
 *               written the number is not returned.
 *   5. SCOPE -- only a call that is, right now, an attempt of an episode
 *               nobody has called back (re-derived per request from the same
 *               engine as the Not-called-back list), and only while its raw
 *               import tab still exists (about 14 days, Operator State #43).
 *
 * WHERE THE NUMBER COMES FROM: the day's `Call_Legs_<date>` tab in the CDR
 * Import workbook (`CDR_IMPORT_SS_ID`), the only place a raw number is held.
 * The call's legs are found by call id, the outside numbers on its incoming
 * legs are the candidates, and the one shown is the candidate whose HMAC
 * equals the call's stored `caller_hash` -- so a number on this page is
 * PROVEN to be the caller the capture hashed, whatever else is on the call.
 * No match (or no HMAC_SECRET / no Neon to check against) shows nothing.
 *
 * INV-01: revealCallbackNumber is a public, non-admin-capable function that
 * appends to a sheet -- an append-only AUDIT carve-out, the Report Usage
 * telemetry's class (docs/invariants.md INV-01). Nothing else here writes.
 */

// How far back the worklist looks: the raw tabs' retention (Operator State #43).
var CBW_DAYS_ = 14;
// Numbers one signed-in user may ask for per hour (failed tries count too).
var CBW_REVEAL_CAP_ = 40;
var CBW_REVEAL_WINDOW_S_ = 3600;
// A call's leg group is a handful of rows; refuse a runaway match.
var CBW_MAX_LEGS_ = 80;
// The raw tab's columns this reads (cdr-import's IC_COL; parity-pinned by
// callback-worklist.test.js -- a moved column there fails the suite here).
var CBW_COL_ = { CALL_ID: 0, DIRECTION: 5, CALLER: 8, CALLEE: 10, PARENT_CALL_ID: 14 };
var CBW_TAB_PREFIX_ = 'Call_Legs_';

/** Are managers allowed to ask for numbers? Off unless the property is exactly `true`. */
function cbwManagersMayReveal_() {
  try { return PropertiesService.getScriptProperties().getProperty('CALLBACK_NUMBERS_MANAGERS') === 'true'; }
  catch (e) { return false; }
}

/** May THIS user ask for a number? Admins; managers only while the switch is on. */
function cbwMayReveal_(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.role === 'manager' && cbwManagersMayReveal_();
}

/** The worklist's window: the last CBW_DAYS_ days, ending yesterday. */
function cbwWindow_() {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var shift = function (n) { var d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  return { from: shift(-CBW_DAYS_), to: shift(-1), today: today };
}

/**
 * PURE. The Not-called-back payload (getOutboundUncalled) -> worklist rows:
 * one per episode nobody has called back AT ALL (an episode called back or
 * got through late is no longer owed a call), pending first by days left,
 * then the missed ones newest first. `held` = { iso: true } of dates whose raw
 * tab exists, or null when that is not known.
 */
function cbwRowsFrom_(resp, held) {
  var byKey = {};
  ((resp && resp.calls) || []).forEach(function (c) { byKey[c.callDate + '|' + c.callId] = c; });
  var rows = [];
  ((resp && resp.episodes) || []).forEach(function (ep) {
    var late = ep.late || {};
    if (late.calledBack || late.gotThrough) return;
    var atts = ep.attempts || [];
    if (!atts.length) return;
    var last = atts[atts.length - 1];
    var d = byKey[last.callDate + '|' + last.callId] || {};
    rows.push({
      firstIso: ep.firstIso, attempts: atts.length,
      status: ep.status === 'pending' ? 'pending' : 'missed',
      daysLeft: ep.daysLeft == null ? null : ep.daysLeft, awaitingData: !!ep.awaitingData,
      callDate: last.callDate, callId: last.callId,
      cstStart: d.cstStart || '', entryQueue: d.entryQueue || null, dialIn: d.dialIn || null,
      waitSeconds: d.waitSeconds == null ? null : d.waitSeconds,
      // Every attempt of the episode is the same caller: any of them may be asked for.
      calls: atts.map(function (a) { return { callDate: a.callDate, callId: a.callId }; }),
      held: held ? !!held[last.callDate] : null
    });
  });
  rows.sort(function (a, b) {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    if (a.status === 'pending') {
      var da = a.daysLeft == null ? 99 : a.daysLeft, db = b.daysLeft == null ? 99 : b.daysLeft;
      if (da !== db) return da - db;
    }
    var ka = a.callDate + ' ' + a.cstStart, kb = b.callDate + ' ' + b.cstStart;
    return ka < kb ? 1 : (ka > kb ? -1 : (b.attempts - a.attempts));
  });
  return rows;
}

/** The CDR Import workbook (where the raw tabs live), or null when it is not configured / cannot be opened. */
function cbwOpenImport_() {
  var id = '';
  try { id = String(PropertiesService.getScriptProperties().getProperty('CDR_IMPORT_SS_ID') || '').trim(); } catch (e) { id = ''; }
  if (!id) return null;
  try { return SpreadsheetApp.openById(id); }
  catch (e2) {
    Logger.log('Callback worklist: the CDR Import workbook could not be opened: ' + (e2 && e2.message ? e2.message : e2));
    return null;
  }
}

/** { iso: true } for every date whose raw tab exists, or null when the workbook is not reachable. */
function cbwHeldDates_(ss) {
  if (!ss) return null;
  var out = {};
  ss.getSheets().forEach(function (s) {
    var m = /^Call_Legs_(\d{4}-\d{2}-\d{2})$/.exec(String(s.getName()));
    if (m) out[m[1]] = true;
  });
  return out;
}

/** PURE. The outside numbers ("+<digits>") on a call's INCOMING, non-recording legs, distinct, in leg order. */
function cbwCandidateNumbers_(legs) {
  var out = [], seen = {};
  (legs || []).forEach(function (l) {
    if (!l) return;
    if (String(l[CBW_COL_.DIRECTION] == null ? '' : l[CBW_COL_.DIRECTION]).trim() !== 'Incoming') return;
    if (/^CallRecording\b/i.test(String(l[CBW_COL_.CALLEE] == null ? '' : l[CBW_COL_.CALLEE]).trim())) return;   // NX-2
    var d = String(l[CBW_COL_.CALLER] == null ? '' : l[CBW_COL_.CALLER]).replace(/\D/g, '');
    if (d.length < 10 || seen[d]) return;
    seen[d] = true;
    out.push('+' + d);
  });
  return out;
}

/**
 * The legs of ONE call in a raw tab: every row whose own call id or parent
 * call id is `callId` (the capture's root grouping). Reads the two id columns,
 * then only the matched rows. Returns [] when the call is not in the tab.
 */
function cbwLegsOfCall_(sheet, callId) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var width = Math.min(sheet.getMaxColumns(), CBW_COL_.PARENT_CALL_ID + 1);
  if (width <= CBW_COL_.CALLEE) return [];
  var n = last - 1;
  var own = sheet.getRange(2, CBW_COL_.CALL_ID + 1, n, 1).getDisplayValues();
  var par = width > CBW_COL_.PARENT_CALL_ID ? sheet.getRange(2, CBW_COL_.PARENT_CALL_ID + 1, n, 1).getDisplayValues() : null;
  var id = String(callId);
  var hits = [];
  for (var i = 0; i < n; i++) {
    if (String(own[i][0]).trim() === id || (par && String(par[i][0]).trim() === id)) hits.push(i);
    if (hits.length > CBW_MAX_LEGS_) break;
  }
  return hits.slice(0, CBW_MAX_LEGS_).map(function (i) {
    return sheet.getRange(i + 2, 1, 1, width).getDisplayValues()[0];
  });
}

/** PURE. "+15551234567" -> "(555) 123-4567"; anything else as it is. */
function cbwFormatNumber_(n) {
  var d = String(n || '').replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return String(n || '');
}

/** The stored caller_hash of one inbound call, or null (no row / anonymous / unreadable). */
function cbwStoredHash_(callDate, callId) {
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return null;
    var stmt = conn.prepareStatement('SELECT caller_hash AS h FROM inbound_calls WHERE call_date = ?::date AND call_id = ?');
    stmt.setString(1, callDate); stmt.setString(2, callId);
    var rs = stmt.executeQuery();
    var h = rs.next() ? rs.getString('h') : null;
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(h ? String(h).length : 0, 'callback-worklist');
    rs.close(); stmt.close();
    return h ? String(h) : null;
  } catch (e) {
    Logger.log('Callback worklist: the stored caller hash could not be read: ' + (e && e.message ? e.message : e));
    return null;
  } finally {
    try { if (conn) conn.close(); } catch (ce) {}
  }
}

/**
 * Resolves ONE call's number, in memory. Returns { state, number? } where
 * state is: found | notConfigured | noTab | notFound | noNumber |
 * unconfirmed. `number` is set ONLY for `found`, and only when its HMAC
 * equals the call's stored caller_hash. Never logs or stores a number.
 */
function cbwResolveNumber_(callDate, callId, ss) {
  var book = ss || cbwOpenImport_();
  if (!book) return { state: 'notConfigured' };
  var sheet = book.getSheetByName(CBW_TAB_PREFIX_ + callDate);
  if (!sheet) return { state: 'noTab' };
  var legs = cbwLegsOfCall_(sheet, callId);
  if (!legs.length) return { state: 'notFound' };
  var cands = cbwCandidateNumbers_(legs);
  if (!cands.length) return { state: 'noNumber' };
  var secret = null;
  try { secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET'); } catch (e) { secret = null; }
  var stored = secret ? cbwStoredHash_(callDate, callId) : null;
  if (!secret || !stored) return { state: 'unconfirmed' };
  for (var i = 0; i < cands.length; i++) {
    if (callerLookupHashPhone_(cands[i], secret) === stored) return { state: 'found', number: cands[i] };
  }
  return { state: 'unconfirmed' };
}

/** The audit sheet, created on first use when setup() has not made it yet. */
function cbwLogSheet_() {
  var ss = openSpreadsheet_();
  var sheet = ss.getSheetByName(SHEETS.CALLBACK_NUMBER_LOG);
  if (!sheet && typeof ensureSheet_ === 'function') {
    ensureSheet_(ss, SHEETS.CALLBACK_NUMBER_LOG, CALLBACK_NUMBER_LOG_HEADERS, [5, 6]);
    sheet = ss.getSheetByName(SHEETS.CALLBACK_NUMBER_LOG);
  }
  if (!sheet) throw new Error('The Callback Number Log sheet is missing. Run setup().');
  return sheet;
}

/** Appends one audit row. THROWS when it cannot -- the caller then shows nothing. Never takes a number. */
function cbwLogReveal_(user, dept, callDate, callId, result) {
  cbwLogSheet_().appendRow([
    new Date(),
    (user && user.email) ? String(user.email) : '',
    (user && user.role) ? String(user.role) : '',
    sheetSafeCell_(String(dept || '(all departments)')),
    sheetSafeCell_(String(callDate || '')),
    sheetSafeCell_(String(callId || '')),
    String(result || '')
  ]);
}

/** Counts this request against the user's hourly cap; throws past it. */
function cbwAssertRevealCap_(email) {
  var who = String(email || '').trim().toLowerCase();
  if (!who) throw new Error('Not signed in.');
  withQuotaGuardLock_(function () {
    var key = 'cbwReveal:v1:' + who.slice(0, 200), now = Date.now(), stamps = [], cache = null;
    // Fail CLOSED (unlike the email throttle): a count that cannot be read or
    // kept is not a number that may be shown.
    try {
      cache = CacheService.getScriptCache();
      var raw = cache.get(key);
      stamps = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(stamps)) stamps = [];
    } catch (e) { throw new Error('The hourly limit could not be checked just now, so no number is shown. Try again.'); }
    var cutoff = now - CBW_REVEAL_WINDOW_S_ * 1000;
    stamps = stamps.filter(function (t) { return Number(t) > cutoff; });
    if (stamps.length >= CBW_REVEAL_CAP_) {
      throw new Error('You have asked for ' + stamps.length + ' phone numbers in the last hour, which is the limit. Try again later.');
    }
    stamps.push(now);
    try { cache.put(key, JSON.stringify(stamps), CBW_REVEAL_WINDOW_S_); }
    catch (e2) { throw new Error('The hourly limit could not be recorded just now, so no number is shown. Try again.'); }
  });
}

/** The gate + scope both endpoints share: the outbound resolver over the worklist window. */
function cbwScope_(req) {
  var w = cbwWindow_();
  var scope = outboundResolveRequest_({ from: w.from, to: w.to, department: String((req && req.department) || '').trim() });
  scope.today = w.today;
  return scope;
}

/**
 * The worklist: who is still owed a call back, most urgent first. NEVER
 * carries a number. req = { department? } (blank = every department, for an
 * admin / all-departments viewer; a manager is pinned to their own).
 */
function getCallbackWorklist(req) {
  var scope = cbwScope_(req);
  var user = scope.user;
  var out = {
    meta: { from: scope.from, to: scope.to, department: scope.dept || null, companyView: scope.companyView,
            available: true, canReveal: cbwMayReveal_(user), numbersConfigured: false,
            revealCap: CBW_REVEAL_CAP_, days: CBW_DAYS_, truncated: false, tzLabel: 'CST',
            callbackWindowDays: OUTBOUND_CALLBACK_WINDOW_DAYS,
            departments: (user.role === 'admin' || user.allDepts) ? getAllDepartments_() : (user.departments || []) },
    rows: []
  };
  if (user.role === 'admin') out.meta.managersMayReveal = cbwManagersMayReveal_();
  var resp = getOutboundUncalled({ from: scope.from, to: scope.to, department: scope.companyView ? 'ALL' : scope.dept });
  var m = (resp && resp.meta) || {};
  if (m.available === false) { out.meta.available = false; return out; }
  out.meta.truncated = !!m.truncated;
  if (m.exceptionDays) out.meta.exceptionDays = m.exceptionDays;
  if (m.dataThrough) out.meta.dataThrough = m.dataThrough;
  var held = cbwHeldDates_(cbwOpenImport_());
  out.meta.numbersConfigured = !!held;
  out.rows = cbwRowsFrom_(resp, held);
  try { logReportUsage_('callbacks:worklist', scope.dept || '(all)', user, false); } catch (eU) { /* best-effort */ }
  return out;
}

/**
 * ONE caller's number, for one call on the worklist. req = { department?,
 * callDate, callId }. Returns { ok, state, number? } -- `number` only when
 * ok. Every request that reaches the lookup is logged first (cbwLogReveal_);
 * an unlogged number is never returned. Not cached, not Logger-logged.
 */
function revealCallbackNumber(req) {
  var scope = cbwScope_(req);
  var user = scope.user;
  if (!cbwMayReveal_(user)) throw new Error('Showing phone numbers is not turned on for managers.');
  var callDate = String((req && req.callDate) || '').trim();
  var callId = String((req && req.callId) || '').trim();
  if (!isIsoDate_(callDate)) throw new Error('callDate must be YYYY-MM-DD.');
  if (!/^[A-Za-z0-9._\-]{1,64}$/.test(callId)) throw new Error('That call id is not valid.');
  cbwAssertRevealCap_(user.email);

  // SCOPE, re-derived now: the call must be an attempt of an episode nobody
  // has called back, in a department this user may see.
  var resp = getOutboundUncalled({ from: scope.from, to: scope.to, department: scope.companyView ? 'ALL' : scope.dept });
  if (resp && resp.meta && resp.meta.available === false) {
    throw new Error('The callback list could not be read just now, so no number can be shown.');
  }
  var listed = cbwRowsFrom_(resp, null).some(function (r) {
    return r.calls.some(function (c) { return c.callDate === callDate && c.callId === callId; });
  });
  var deptLabel = scope.dept || '';
  if (!listed) {
    cbwLogReveal_(user, deptLabel, callDate, callId, 'refused: not on the worklist');
    throw new Error('That call is not on the callback worklist any more (it may have been called back). Refresh the list.');
  }

  var res;
  try { res = cbwResolveNumber_(callDate, callId); }
  catch (e) {
    Logger.log('revealCallbackNumber: the lookup failed: ' + (e && e.message ? e.message : e));
    res = { state: 'error' };
  }
  // AUDIT BEFORE REPLY: a throw here returns nothing to the client.
  try { cbwLogReveal_(user, deptLabel, callDate, callId, res.state === 'found' ? 'shown' : 'not shown: ' + res.state); }
  catch (le) {
    Logger.log('revealCallbackNumber: the audit row could not be written, so nothing is shown: ' + (le && le.message ? le.message : le));
    throw new Error('This request could not be logged, so the number is not shown. Try again, or tell an admin.');
  }
  if (res.state !== 'found') return { ok: false, state: res.state };
  return { ok: true, state: 'found', number: cbwFormatNumber_(res.number) };
}

/**
 * ADMIN-ONLY: turn the managers' switch on or off (the Script Property is
 * past the settings page's 50-row cap, Operator State #53). Returns the state.
 */
function setCallbackNumbersForManagers(on) {
  assertAdmin_();
  var props = PropertiesService.getScriptProperties();
  if (on === true) props.setProperty('CALLBACK_NUMBERS_MANAGERS', 'true');
  else props.deleteProperty('CALLBACK_NUMBERS_MANAGERS');
  return logStatusReturn_({ managersMayReveal: cbwManagersMayReveal_() });
}

/**
 * P11 (Operator State #95): READ-ONLY, editor-run, admin-gated. Can a number
 * be reliably found for the calls on the worklist? Walks every department's
 * worklist (the latest call of each episode), looks each number up the way
 * the page does, and logs COUNTS ONLY -- no number, and no audit rows (nothing
 * is shown to anyone). Read the VERDICT first: GOOD (95%+ of the calls whose
 * raw tab exists were found AND confirmed against the stored hash), PARTIAL,
 * POOR, INCONCLUSIVE (under 10 such calls) or NOT CONFIGURED.
 */
function probeCallbackNumberLookup() {
  assertAdmin_();
  var w = cbwWindow_();
  var out = { from: w.from, to: w.to, verdict: 'FAILED', rows: 0, counts: {}, samples: {} };
  var ss = cbwOpenImport_();
  if (!ss) {
    out.verdict = 'NOT CONFIGURED';
    Logger.log('probeCallbackNumberLookup: set the CDR_IMPORT_SS_ID Script Property to the CDR Import workbook id (and check this account can open it).');
    return out;
  }
  var resp = getOutboundUncalled({ from: w.from, to: w.to, department: 'ALL' });
  if (resp && resp.meta && resp.meta.available === false) {
    Logger.log('probeCallbackNumberLookup: the callback list could not be read (Neon unreachable?).');
    return out;
  }
  var rows = cbwRowsFrom_(resp, cbwHeldDates_(ss));
  out.rows = rows.length;
  var bump = function (state, r) {
    out.counts[state] = (out.counts[state] || 0) + 1;
    if (state !== 'found') {
      var s = out.samples[state] || (out.samples[state] = []);
      if (s.length < 5) s.push(r.callDate + ' ' + r.callId);
    }
  };
  rows.forEach(function (r) {
    var res;
    try { res = cbwResolveNumber_(r.callDate, r.callId, ss); } catch (e) { res = { state: 'error' }; }
    bump(res.state, r);
  });
  var held = rows.length - (out.counts.noTab || 0);
  var found = out.counts.found || 0;
  out.held = held;
  out.ratePct = held ? Math.round(found / held * 1000) / 10 : null;
  out.verdict = held < 10 ? 'INCONCLUSIVE' : (found / held >= 0.95 ? 'GOOD' : (found / held >= 0.6 ? 'PARTIAL' : 'POOR'));
  var L = [];
  L.push('Callback worklist -- can a number be found? ' + w.from + ' to ' + w.to + ' (all departments). No number is logged.');
  L.push('VERDICT: ' + out.verdict + (out.ratePct == null ? '' : ' -- ' + out.ratePct + '% found and confirmed (' + found + ' of ' + held + ' calls whose raw tab exists).'));
  L.push('Worklist rows: ' + rows.length + '. Raw tab already gone: ' + (out.counts.noTab || 0) + ' (not counted in the rate).');
  L.push('Not shown: call not in its tab ' + (out.counts.notFound || 0) + ', no outside number on the call ' + (out.counts.noNumber || 0)
    + ', not confirmed against the stored hash ' + (out.counts.unconfirmed || 0) + ', lookup error ' + (out.counts.error || 0) + '.');
  Object.keys(out.samples).forEach(function (k) { L.push('  ' + k + ' samples (date, call id): ' + out.samples[k].join(' | ')); });
  if ((out.counts.unconfirmed || 0) === held && held) L.push('NOTE: nothing was confirmed -- check HMAC_SECRET on the dashboard matches cdr-import (Operator State #17).');
  Logger.log(L.join('\n'));
  return out;
}
