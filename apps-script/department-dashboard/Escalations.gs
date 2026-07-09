/**
 * Escalations (Phase 1) — manager-facing escalation log.
 *
 * Managers view and "manage" (resolve + comment on) escalation calls for
 * their own department; an admin manually logs new escalations (and sees
 * every department). Backed by the Neon `escalations` table (NOT a sheet):
 * Phase 2 will let the external team-tools app INSERT `pending_review` rows
 * into the SAME table for an admin review queue, so Neon is the shared
 * substrate from the start. There is no sheet fallback (like inbound_calls /
 * Caller Lookup) — when Neon is unconfigured/unreachable the list renders an
 * "unavailable" state and writes throw a clear error.
 *
 * WRITE-PATH SECURITY (extends INV-01). Historically the only public
 * sheet-writers were admin-gated (OrphanFix / setup / DeptConfig). This is
 * the FIRST public PER-DEPT (non-admin) write path: a dept MANAGER may
 * resolve/comment/reopen escalations for THEIR OWN dept only. It carries the
 * same four mitigations the OrphanFix carve-out does, with the admin gate
 * swapped for the per-dept gate on the manager-reachable mutation paths:
 *   1. authorization — `createEscalation` / `updateEscalation` are admin-only
 *      (`assertAdmin_`); `resolveEscalation` / `updateEscalationComment` /
 *      `reopenEscalation` re-resolve the caller and
 *      `assertDeptAccess_(user, <the escalation's own department>)`, so a
 *      manager can only touch their own dept's rows (the dept is read from
 *      the row, never trusted from the request).
 *   2. input validation — required fields, length caps, known-dept check,
 *      and the business rules that a resolution requires non-empty text and a
 *      reopen requires a non-empty reason.
 *   3. `LockService` — serializes concurrent writes.
 *   4. audit — every row carries created_by/created_at + resolved_by/
 *      resolved_at/updated_at, AND every write appends an immutable row to the
 *      append-only `escalation_activity` trail (§5) in the SAME transaction as
 *      the primary write (true atomicity: see escWriteTxn_ / setAutoCommit).
 *      Each action is also Logger.log'd.
 * Bound prepared-statement params everywhere (no SQL injection); admin-/
 * manager-entered free text (reason, resolution, comments, names) is never
 * inlined into SQL.
 *
 * Requires the dashboard project's NEON_* Script Properties +
 * `script.external_request` scope (same as the F1 read-back / inbound report
 * / orphan-rename mirror). Both tables are created lazily via
 * CREATE TABLE IF NOT EXISTS on first write (like inbound_calls), so no
 * setup() change is needed.
 *
 * NEW-ESCALATION NOTIFICATION (§1) is flag-gated OFF by default
 * (`NOTIFY_ON_NEW_ESCALATION` Script Property). When enabled, a successful
 * createEscalation fires a best-effort email to the dept's managers
 * (`lookupDeptManagers_`, the Digest recipient resolver). It NEVER blocks or
 * fails the create — fire-and-log, mirroring `notifyDigestFailure_`. The email
 * carries full escalation detail (operator decision); this is a PII surface,
 * so it stays off until explicitly enabled.
 */

var ESC_MAX_TEXT = 4000;          // length cap on free-text fields
// F-46: cap the list fetch (newest first). The query was unbounded json_agg
// -- fine at today's volume, but Phase 2's external pending_review inserts
// make it an unbounded single-string JDBC fetch of PII (the failure mode
// INBOUND_TOP_N / CALLER_LOOKUP_MAX_CALLS cap elsewhere). meta.truncated
// tells the client when the cap was hit.
var ESC_MAX_ROWS = 500;
var ESC_STATUS_PENDING  = 'pending';
var ESC_STATUS_RESOLVED = 'resolved';

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Init payload for the Escalations modal: the viewer's role + the dept list
 * they may filter by (managers: their own dept only; admins: every dept).
 * Read-only; any authenticated (manager/admin) user may call it.
 */
function getEscalationsInit() {
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  var isAdmin = user.role === 'admin';
  return {
    role:        user.role,
    isAdmin:     isAdmin,
    department:  user.department || null,
    departments: isAdmin ? getAllDepartments_() : (user.department ? [user.department] : []),
    neonConfigured: !!PropertiesService.getScriptProperties().getProperty('NEON_HOST'),
    statuses:    ['pending', 'resolved', 'all'],
  };
}

/**
 * Lists escalations for a department (managers: forced to their own;
 * admins: the requested dept, or 'ALL'), filtered by status
 * (pending | resolved | all). Read-only. Returns
 * { available, rows, meta } -- available=false when Neon is unreachable
 * (NOT cached -- a transient outage shouldn't pin an empty list).
 */
function getEscalations(req) {
  req = req || {};
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');

  // Managers are pinned to their own dept; admins may pick a dept or 'ALL'.
  var department, scopeAll = false;
  if (user.role === 'admin') {
    var reqDept = String(req.department || '').trim();
    if (!reqDept || reqDept === 'ALL') { scopeAll = true; }
    else { assertDeptAccess_(user, reqDept); department = reqDept; }
  } else {
    department = user.department;
    if (!department) throw new Error('Not authorized.');
  }

  var status = String(req.status || 'pending').toLowerCase().trim();
  if (['pending', 'resolved', 'all'].indexOf(status) === -1) status = 'pending';

  var conn = getDashboardNeonConn_();
  if (!conn) return { available: false, rows: [], meta: { department: scopeAll ? 'ALL' : department, status: status } };
  try {
    escEnsureTable_(conn);
    var where = [];
    var params = [];
    if (!scopeAll) { where.push('department = ?'); params.push(department); }
    if (status !== 'all') { where.push('status = ?'); params.push(status); }
    var sql = "SELECT COALESCE(json_agg(t ORDER BY t.occurred_at DESC NULLS LAST, t.created_at DESC), '[]')::text AS j FROM ("
            + "SELECT id, department, occurred_at::text AS occurred_at, caller, patient_name, trx, area, reason, "
            + "status, resolution, comments, created_by, created_at::text AS created_at, "
            + "resolved_by, resolved_at::text AS resolved_at, source "
            + "FROM escalations"
            + (where.length ? (' WHERE ' + where.join(' AND ')) : '')
            // F-46: newest-first cap inside the subquery (json_agg re-sorts
            // the capped set with the same keys, so order is unchanged).
            + ' ORDER BY occurred_at DESC NULLS LAST, created_at DESC LIMIT ' + ESC_MAX_ROWS
            + ') t';
    var stmt = conn.prepareStatement(sql);
    for (var i = 0; i < params.length; i++) stmt.setString(i + 1, params[i]);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    var rows = JSON.parse(json || '[]');
    return { available: true, rows: rows,
             meta: { department: scopeAll ? 'ALL' : department, status: status,
                     count: rows.length,
                     truncated: rows.length >= ESC_MAX_ROWS } };   // F-46
  } catch (e) {
    Logger.log('getEscalations failed: ' + (e && e.message ? e.message : e));
    return { available: false, rows: [], meta: { department: scopeAll ? 'ALL' : department, status: status } };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

/**
 * Returns the append-only activity trail (§5) for one escalation, oldest
 * first. PER-DEPT gated (dept read from the row). Read-only; NOT cached.
 * Returns { available, rows:[{action, actor, at, detail}] }.
 */
function getEscalationActivity(req) {
  req = req || {};
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');

  var conn = getDashboardNeonConn_();
  if (!conn) return { available: false, rows: [] };
  try {
    escEnsureTable_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) return { available: true, rows: [] };
    escAssertRowAccess_(user, meta.department);   // F-45: row dept = data, not input
    var sql = "SELECT COALESCE(json_agg(t ORDER BY t.at ASC), '[]')::text AS j FROM ("
            + "SELECT action, actor, at::text AS at, detail FROM escalation_activity WHERE escalation_id = ?) t";
    var stmt = conn.prepareStatement(sql);
    stmt.setString(1, id);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    return { available: true, rows: JSON.parse(json || '[]') };
  } catch (e) {
    Logger.log('getEscalationActivity failed: ' + (e && e.message ? e.message : e));
    return { available: false, rows: [] };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

/**
 * Creates (logs) a new escalation. ADMIN-ONLY (the "I manually enter
 * escalations" flow). Assigned to a department; starts `pending`.
 * Fields: occurredAt (ISO datetime or ''), caller, patientName, trx,
 * area (optional), reason (required). Returns { id }.
 *
 * Writes the row + a 'created' activity entry atomically (§5), then fires
 * the best-effort new-escalation notification (§1, flag-gated) AFTER the
 * lock is released so the email never blocks the write.
 */
function createEscalation(req) {
  assertAdmin_();
  req = req || {};
  var department = String(req.department || '').trim();
  if (getAllDepartments_().indexOf(department) === -1) {
    throw new Error('Unknown department: ' + department);
  }
  var reason = escClean_(req.reason);
  if (!reason) throw new Error('Reason for escalation is required.');

  var rec = {
    id:          Utilities.getUuid(),
    department:  department,
    occurredAt:  escCleanDateTime_(req.occurredAt),
    caller:      escClean_(req.caller),
    patientName: escClean_(req.patientName),
    trx:         escClean_(req.trx),
    area:        escClean_(req.area),
    reason:      reason,
    createdBy:   (Session.getActiveUser().getEmail() || '').toLowerCase(),
  };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another escalation write is in progress — retry in a moment.');
  var conn = getDashboardNeonConn_();
  if (!conn) { lock.releaseLock(); throw new Error('Escalations storage (Neon) is not configured/reachable.'); }
  var txn = false;
  try {
    escEnsureTable_(conn);            // DDL auto-commits before the txn opens
    conn.setAutoCommit(false); txn = true;
    // NULLIF(?, '') so a blank optional field stores NULL without needing
    // JDBC setObject(null) (unreliable in Apps Script) and without binding
    // '' to a timestamptz (which errors). reason is required (non-empty).
    var stmt = conn.prepareStatement(
      'INSERT INTO escalations (id, department, occurred_at, caller, patient_name, trx, area, reason, '
      + "status, created_by, source) VALUES (?, ?, NULLIF(?, '')::timestamptz, NULLIF(?, ''), "
      + "NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, ?)");
    stmt.setString(1, rec.id);
    stmt.setString(2, rec.department);
    stmt.setString(3, rec.occurredAt);
    stmt.setString(4, rec.caller);
    stmt.setString(5, rec.patientName);
    stmt.setString(6, rec.trx);
    stmt.setString(7, rec.area);
    stmt.setString(8, rec.reason);
    stmt.setString(9, ESC_STATUS_PENDING);
    stmt.setString(10, rec.createdBy);
    stmt.setString(11, 'manual');
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, rec.id, 'created', rec.createdBy, rec.reason);
    conn.commit();
    Logger.log('createEscalation: %s logged escalation %s for %s', rec.createdBy, rec.id, rec.department);
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('createEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error('Could not save the escalation. ' + (e && e.message ? e.message : ''));
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }

  // §1: fire-and-log notification AFTER the write committed + lock released
  // (so a slow MailApp send never blocks the create response or holds the
  // lock). Best-effort: any failure is swallowed + logged inside the helper.
  escNotifyNewEscalation_(rec);
  return { id: rec.id };
}

/**
 * Admin-only correction of a PENDING escalation's fields (wrong dept /
 * patient / Trx / reason). Writes ONLY the existing data columns; never
 * touches status, resolution, or resolved_*. Resolved rows are out of scope
 * (pending-only). Appends an 'edited' activity row atomically (§5).
 * Returns { id }.
 */
function updateEscalation(req) {
  assertAdmin_();
  req = req || {};
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var department = String(req.department || '').trim();
  if (getAllDepartments_().indexOf(department) === -1) {
    throw new Error('Unknown department: ' + department);
  }
  var reason = escClean_(req.reason);
  if (!reason) throw new Error('Reason for escalation is required.');
  var fields = {
    occurredAt:  escCleanDateTime_(req.occurredAt),
    caller:      escClean_(req.caller),
    patientName: escClean_(req.patientName),
    trx:         escClean_(req.trx),
    area:        escClean_(req.area),
  };
  var actor = (Session.getActiveUser().getEmail() || '').toLowerCase();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another escalation write is in progress — retry in a moment.');
  var conn = getDashboardNeonConn_();
  if (!conn) { lock.releaseLock(); throw new Error('Escalations storage (Neon) is not configured/reachable.'); }
  var txn = false;
  try {
    escEnsureTable_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    if (meta.status !== ESC_STATUS_PENDING) {
      throw new Error('Only a pending escalation can be edited.');
    }
    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement(
      'UPDATE escalations SET department = ?, occurred_at = NULLIF(?, \'\')::timestamptz, '
      + "caller = NULLIF(?, ''), patient_name = NULLIF(?, ''), trx = NULLIF(?, ''), "
      + "area = NULLIF(?, ''), reason = ?, updated_at = now() WHERE id = ?");
    stmt.setString(1, department);
    stmt.setString(2, fields.occurredAt);
    stmt.setString(3, fields.caller);
    stmt.setString(4, fields.patientName);
    stmt.setString(5, fields.trx);
    stmt.setString(6, fields.area);
    stmt.setString(7, reason);
    stmt.setString(8, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'edited', actor, 'Edited escalation fields');
    conn.commit();
    Logger.log('updateEscalation: %s edited %s (%s)', actor, id, department);
    return { id: id };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('updateEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not update the escalation.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

/**
 * Resolves an escalation. PER-DEPT gated: the caller must manage the
 * escalation's OWN department (read from the row, not the request) -- or be
 * an admin. The business rule: a resolution REQUIRES non-empty resolution
 * text (you cannot mark resolved without explaining how). `comments` is
 * optional. Sets status=resolved + resolved_by/resolved_at, and appends a
 * 'resolved' activity row atomically (§5). Returns { id }.
 */
function resolveEscalation(req) {
  req = req || {};
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var resolution = escClean_(req.resolution);
  if (!resolution) throw new Error('A resolution note (what action was taken) is required to mark this resolved.');
  var comments = escClean_(req.comments);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another escalation write is in progress — retry in a moment.');
  var conn = getDashboardNeonConn_();
  if (!conn) { lock.releaseLock(); throw new Error('Escalations storage (Neon) is not configured/reachable.'); }
  var txn = false;
  try {
    escEnsureTable_(conn);
    // Authorize against the row's OWN department (never trust a dept from req).
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    var dept = meta.department;
    escAssertRowAccess_(user, dept);   // F-45: row dept = data, not input
    // F-43: pending-only, mirroring reopenEscalation's resolved-only guard.
    // Two managers racing from stale UIs previously last-write-wins
    // clobbered the first resolution note on the row itself (only the
    // activity trail preserved it).
    if (meta.status === ESC_STATUS_RESOLVED) {
      throw new Error('This escalation is already resolved. Reopen it first if the '
        + 'resolution needs to change (the existing note would otherwise be overwritten).');
    }

    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement(
      'UPDATE escalations SET status = ?, resolution = ?, comments = NULLIF(?, \'\'), '
      + 'resolved_by = ?, resolved_at = now(), updated_at = now() WHERE id = ?');
    stmt.setString(1, ESC_STATUS_RESOLVED);
    stmt.setString(2, resolution);
    stmt.setString(3, comments);
    stmt.setString(4, (user.email || '').toLowerCase());
    stmt.setString(5, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'resolved', user.email, resolution);
    conn.commit();
    Logger.log('resolveEscalation: %s resolved %s (%s)', user.email, id, dept);
    return { id: id };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('resolveEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not resolve the escalation.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

/**
 * Reopens a RESOLVED escalation (status -> pending). PER-DEPT gated like
 * resolveEscalation. A non-empty reason is REQUIRED (mirrors the resolve
 * guard). The prior resolved_by/resolved_at are RETAINED as history (the
 * card only renders them on resolved cards, so they're invisible while
 * pending and overwritten on the next resolve); the reason is captured in
 * the activity trail (§5). Returns { id }.
 */
function reopenEscalation(req) {
  req = req || {};
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var reason = escClean_(req.reason);
  if (!reason) throw new Error('A reason for reopening is required.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another escalation write is in progress — retry in a moment.');
  var conn = getDashboardNeonConn_();
  if (!conn) { lock.releaseLock(); throw new Error('Escalations storage (Neon) is not configured/reachable.'); }
  var txn = false;
  try {
    escEnsureTable_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    escAssertRowAccess_(user, meta.department);   // F-45: row dept = data, not input
    if (meta.status !== ESC_STATUS_RESOLVED) {
      throw new Error('Only a resolved escalation can be reopened.');
    }
    conn.setAutoCommit(false); txn = true;
    // Retain resolved_* (history); flip status + stamp updated_at only.
    var stmt = conn.prepareStatement('UPDATE escalations SET status = ?, updated_at = now() WHERE id = ?');
    stmt.setString(1, ESC_STATUS_PENDING);
    stmt.setString(2, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'reopened', user.email, reason);
    conn.commit();
    Logger.log('reopenEscalation: %s reopened %s (%s)', user.email, id, meta.department);
    return { id: id };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('reopenEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not reopen the escalation.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

/**
 * Updates the optional `comments` on an escalation WITHOUT resolving it
 * (lets a manager annotate a pending escalation). PER-DEPT gated like
 * resolveEscalation. Appends a 'comment' activity row atomically (§5).
 * Returns { id }.
 */
function updateEscalationComment(req) {
  req = req || {};
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var comments = escClean_(req.comments);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another escalation write is in progress — retry in a moment.');
  var conn = getDashboardNeonConn_();
  if (!conn) { lock.releaseLock(); throw new Error('Escalations storage (Neon) is not configured/reachable.'); }
  var txn = false;
  try {
    escEnsureTable_(conn);
    var dept = escRowDepartment_(conn, id);
    if (dept === null) throw new Error('Escalation not found.');
    escAssertRowAccess_(user, dept);   // F-45: row dept = data, not input
    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement("UPDATE escalations SET comments = NULLIF(?, ''), updated_at = now() WHERE id = ?");
    stmt.setString(1, comments);
    stmt.setString(2, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'comment', user.email, comments);
    conn.commit();
    Logger.log('updateEscalationComment: %s updated %s (%s)', user.email, id, dept);
    return { id: id };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('updateEscalationComment failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not update the comment.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

/**
 * §5 migration (editor-run, ADMIN-ONLY). Backfills seed activity rows for
 * escalations created before the activity trail existed, so their cards
 * aren't blank. Idempotent (NOT EXISTS guards): inserts a 'created' row for
 * every escalation with no activity yet, and a 'resolved' row for every
 * resolved escalation that has none. Safe to re-run. Returns a summary.
 */
function backfillEscalationActivity() {
  assertAdmin_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another escalation write is in progress — retry in a moment.');
  var conn = getDashboardNeonConn_();
  if (!conn) { lock.releaseLock(); throw new Error('Escalations storage (Neon) is not configured/reachable.'); }
  var txn = false;
  try {
    escEnsureTable_(conn);
    conn.setAutoCommit(false); txn = true;
    // 'created' seed for any escalation with NO activity at all.
    var s1 = conn.createStatement();
    var created = s1.executeUpdate(
      "INSERT INTO escalation_activity (id, escalation_id, action, actor, at, detail) "
      + "SELECT md5(random()::text || e.id || 'c'), e.id, 'created', e.created_by, "
      + "COALESCE(e.created_at, now()), e.reason "
      + "FROM escalations e "
      + "WHERE NOT EXISTS (SELECT 1 FROM escalation_activity a WHERE a.escalation_id = e.id)");
    s1.close();
    // 'resolved' seed for resolved escalations missing one.
    var s2 = conn.createStatement();
    var resolved = s2.executeUpdate(
      "INSERT INTO escalation_activity (id, escalation_id, action, actor, at, detail) "
      + "SELECT md5(random()::text || e.id || 'r'), e.id, 'resolved', e.resolved_by, "
      + "COALESCE(e.resolved_at, now()), e.resolution "
      + "FROM escalations e "
      + "WHERE e.resolved_at IS NOT NULL "
      + "AND NOT EXISTS (SELECT 1 FROM escalation_activity a WHERE a.escalation_id = e.id AND a.action = 'resolved')");
    s2.close();
    conn.commit();
    var summary = { createdSeeded: Number(created) || 0, resolvedSeeded: Number(resolved) || 0 };
    Logger.log('backfillEscalationActivity: created=%s resolved=%s', summary.createdSeeded, summary.resolvedSeeded);
    return summary;
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('backfillEscalationActivity failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Backfill failed.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

// ── Internals ───────────────────────────────────────────────────────────

/** Reads an escalation's department (the authorization key). null if absent. */
/**
 * F-45: authorization against a row's OWN stored department. Unlike
 * assertDeptAccess_ (whose admin branch validates the dept against the
 * CURRENT `DO NOT EDIT!` headers -- correct for REQUEST parameters), the
 * row's dept is authoritative DATA: if a dept column is ever renamed,
 * existing escalation rows still carry the old name, and the header check
 * made them un-resolvable/un-reopenable by EVERYONE including admins.
 * Managers stay pinned to their (current) dept name -- a manager of a
 * renamed dept needs an admin's help for pre-rename rows; admins always
 * pass. Throws on rejection.
 */
function escAssertRowAccess_(user, rowDept) {
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  if (user.role === 'manager' && rowDept !== user.department) {
    throw new Error('Not authorized for this department.');
  }
  // admins: entitled to every row, including rows whose stored dept no
  // longer matches a current roster header.
}

function escRowDepartment_(conn, id) {
  var stmt = conn.prepareStatement('SELECT department FROM escalations WHERE id = ?');
  stmt.setString(1, id);
  var rs = stmt.executeQuery();
  var dept = rs.next() ? rs.getString('department') : null;
  rs.close(); stmt.close();
  return dept;
}

/** Reads { status, department } for an escalation; null if absent. */
function escRowMeta_(conn, id) {
  var stmt = conn.prepareStatement('SELECT status, department FROM escalations WHERE id = ?');
  stmt.setString(1, id);
  var rs = stmt.executeQuery();
  var out = rs.next() ? { status: rs.getString('status'), department: rs.getString('department') } : null;
  rs.close(); stmt.close();
  return out;
}

/**
 * Appends one immutable row to the append-only activity trail (§5). MUST be
 * called inside an open transaction (the caller commits) so the activity row
 * lands atomically with its primary write. No commit here.
 */
function escAppendActivity_(conn, escId, action, actor, detail) {
  var stmt = conn.prepareStatement(
    'INSERT INTO escalation_activity (id, escalation_id, action, actor, detail) '
    + "VALUES (?, ?, ?, ?, NULLIF(?, ''))");
  stmt.setString(1, Utilities.getUuid());
  stmt.setString(2, escId);
  stmt.setString(3, action);
  stmt.setString(4, (actor || '').toLowerCase());
  stmt.setString(5, escClean_(detail || ''));
  stmt.execute();
  stmt.close();
}

/**
 * §1 best-effort new-escalation notification. Flag-gated OFF by default via
 * the `NOTIFY_ON_NEW_ESCALATION` Script Property. NEVER throws (mirrors
 * notifyDigestFailure_): any failure is swallowed + logged so it can't break
 * the create. Recipients are the dept's managers via the shared Digest
 * resolver `lookupDeptManagers_` (Access Control rows) -- no new address book.
 * Carries full escalation detail (operator decision): this is a PII surface,
 * which is why it stays off until explicitly enabled.
 */
function escNotifyNewEscalation_(rec) {
  try {
    var props = PropertiesService.getScriptProperties();
    var enabled = String(props.getProperty('NOTIFY_ON_NEW_ESCALATION') || '').toLowerCase() === 'true';
    if (!enabled) return;
    var recipients = (typeof lookupDeptManagers_ === 'function') ? lookupDeptManagers_(rec.department) : [];
    if (!recipients || !recipients.length) {
      Logger.log('escNotifyNewEscalation_: no managers mapped for %s; skipping.', rec.department);
      return;
    }
    var dashUrl = props.getProperty('DASHBOARD_URL') || '';
    var link = dashUrl ? (dashUrl + '#/escalations') : '';
    MailApp.sendEmail({
      to:       recipients.join(','),
      subject:  'New escalation logged — ' + rec.department,
      htmlBody: escNotifyHtml_(rec, link),
    });
    Logger.log('escNotifyNewEscalation_: emailed %s for escalation %s (%s)', recipients.join(','), rec.id, rec.department);
  } catch (e) {
    Logger.log('escNotifyNewEscalation_ failed (non-blocking): ' + (e && e.message ? e.message : e));
  }
}

/** Email-safe HTML for the new-escalation notification (table layout, inline styles). */
function escNotifyHtml_(rec, link) {
  var esc = (typeof escapeHtmlServer_ === 'function')
    ? escapeHtmlServer_
    : function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var row = function (label, val) {
    if (!val) return '';
    return '<tr>'
         +   '<td style="padding:5px 14px 5px 0;color:#667085;font:13px -apple-system,Segoe UI,Roboto,sans-serif;vertical-align:top;white-space:nowrap;">' + esc(label) + '</td>'
         +   '<td style="padding:5px 0;color:#101828;font:13px -apple-system,Segoe UI,Roboto,sans-serif;">' + esc(val) + '</td>'
         + '</tr>';
  };
  var btn = link
    ? '<tr><td colspan="2" style="padding:18px 0 2px;">'
      + '<a href="' + esc(link) + '" style="display:inline-block;background:#2f5b8f;color:#ffffff;text-decoration:none;'
      + 'font:600 13px -apple-system,Segoe UI,Roboto,sans-serif;padding:10px 18px;border-radius:4px;">Open in the dashboard &rsaquo;</a>'
      + '</td></tr>'
    : '';
  return '<div style="font:14px -apple-system,Segoe UI,Roboto,sans-serif;color:#101828;max-width:560px;">'
       +   '<p style="margin:0 0 4px;font-size:16px;font-weight:600;">New escalation — ' + esc(rec.department) + '</p>'
       +   '<p style="margin:0 0 14px;color:#667085;font-size:13px;">An escalation was just logged for your department.</p>'
       +   '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">'
       +     row('When', rec.occurredAt)
       +     row('Caller / relation', rec.caller)
       +     row('Patient', rec.patientName)
       +     row('Trx #', rec.trx)
       +     row('Area', rec.area)
       +     row('Reason', rec.reason)
       +     btn
       +   '</table>'
       + '</div>';
}

/** Idempotent table creation (lazy, like inbound_calls). */
function escEnsureTable_(conn) {
  var ddl = conn.createStatement();
  ddl.execute(
    'CREATE TABLE IF NOT EXISTS escalations ('
    + 'id text PRIMARY KEY, '
    + 'department text NOT NULL, '
    + 'occurred_at timestamptz, '
    + 'caller text, patient_name text, trx text, area text, '
    + 'reason text NOT NULL, '
    + "status text NOT NULL DEFAULT 'pending', "
    + 'resolution text, comments text, '
    + 'created_by text, created_at timestamptz DEFAULT now(), '
    + 'resolved_by text, resolved_at timestamptz, '
    + "source text DEFAULT 'manual', "
    + 'updated_at timestamptz DEFAULT now())');
  ddl.close();
  // Helps the dept+status list query at scale.
  try {
    var idx = conn.createStatement();
    idx.execute('CREATE INDEX IF NOT EXISTS idx_escalations_dept_status ON escalations (department, status)');
    idx.close();
  } catch (idxErr) { /* best-effort */ }
  // §5: append-only activity trail (create/comment/edit/resolve/reopen).
  // Rows are NEVER updated or deleted.
  try {
    var act = conn.createStatement();
    act.execute(
      'CREATE TABLE IF NOT EXISTS escalation_activity ('
      + 'id text PRIMARY KEY, '
      + 'escalation_id text NOT NULL, '
      + 'action text NOT NULL, '
      + 'actor text, '
      + 'at timestamptz DEFAULT now(), '
      + 'detail text)');
    act.close();
    var aidx = conn.createStatement();
    aidx.execute('CREATE INDEX IF NOT EXISTS idx_escalation_activity_eid ON escalation_activity (escalation_id, at)');
    aidx.close();
  } catch (actErr) { /* best-effort */ }
}

/** Trim + length-cap a free-text field; '' for null/blank. */
function escClean_(v) {
  var s = (v == null ? '' : String(v)).trim();
  if (s.length > ESC_MAX_TEXT) s = s.slice(0, ESC_MAX_TEXT);
  return s;
}

/**
 * Accepts a datetime-local string ('YYYY-MM-DDTHH:MM[:SS]') or ISO; returns
 * a string Postgres can cast via ?::timestamptz, or '' when blank/invalid
 * (stored NULL). Bound as a param, never inlined.
 */
function escCleanDateTime_(v) {
  var s = (v == null ? '' : String(v)).trim();
  if (!s) return '';
  // F-44: ANCHORED shape check + numeric range validation. The old regex
  // was unanchored at the end, so '2026-01-01T99:99' / '2026-01-01junk'
  // passed "validation" and died in Postgres's ::timestamptz cast as an
  // opaque "Could not save the escalation" instead of the documented
  // invalid -> stored-NULL behavior.
  var m = /^(\d{4})-(\d{2})-(\d{2})([ T](\d{2}):(\d{2})(:(\d{2}))?)?$/.exec(s);
  if (!m) return '';
  var mo = Number(m[2]), da = Number(m[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
  if (m[4]) {
    var hh = Number(m[5]), mi = Number(m[6]), se = m[8] ? Number(m[8]) : 0;
    if (hh > 23 || mi > 59 || se > 59) return '';
  }
  return s;
}
