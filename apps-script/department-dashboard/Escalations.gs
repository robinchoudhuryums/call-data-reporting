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
 * resolve/comment on escalations for THEIR OWN dept only. It carries the
 * same four mitigations the OrphanFix carve-out does, with the admin gate
 * swapped for the per-dept gate on the mutation paths:
 *   1. authorization — `createEscalation` is admin-only (`assertAdmin_`);
 *      `resolveEscalation` / `updateEscalationComment` re-resolve the caller
 *      and `assertDeptAccess_(user, <the escalation's own department>)`, so a
 *      manager can only touch their own dept's rows (the dept is read from
 *      the row, never trusted from the request).
 *   2. input validation — required fields, length caps, known-dept check,
 *      and the business rule that a resolution requires non-empty text.
 *   3. `LockService` — serializes concurrent writes.
 *   4. audit — every row carries created_by/created_at + resolved_by/
 *      resolved_at/updated_at (the immutable trail, queryable in Neon); each
 *      action is also Logger.log'd.
 * Bound prepared-statement params everywhere (no SQL injection); admin-/
 * manager-entered free text (reason, resolution, comments, names) is never
 * inlined into SQL.
 *
 * Requires the dashboard project's NEON_* Script Properties +
 * `script.external_request` scope (same as the F1 read-back / inbound report
 * / orphan-rename mirror). The `escalations` table is created lazily via
 * CREATE TABLE IF NOT EXISTS on first write (like inbound_calls), so no
 * setup() change is needed.
 */

var ESC_MAX_TEXT = 4000;          // length cap on free-text fields
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
            + ') t';
    var stmt = conn.prepareStatement(sql);
    for (var i = 0; i < params.length; i++) stmt.setString(i + 1, params[i]);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    var rows = JSON.parse(json || '[]');
    return { available: true, rows: rows, meta: { department: scopeAll ? 'ALL' : department, status: status, count: rows.length } };
  } catch (e) {
    Logger.log('getEscalations failed: ' + (e && e.message ? e.message : e));
    return { available: false, rows: [], meta: { department: scopeAll ? 'ALL' : department, status: status } };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

/**
 * Creates (logs) a new escalation. ADMIN-ONLY (the "I manually enter
 * escalations" flow). Assigned to a department; starts `pending`.
 * Fields: occurredAt (ISO datetime or ''), caller, patientName, trx,
 * area (optional), reason (required). Returns { id }.
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
  try {
    escEnsureTable_(conn);
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
    Logger.log('createEscalation: %s logged escalation %s for %s', rec.createdBy, rec.id, rec.department);
    return { id: rec.id };
  } catch (e) {
    Logger.log('createEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error('Could not save the escalation. ' + (e && e.message ? e.message : ''));
  } finally {
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

/**
 * Resolves an escalation. PER-DEPT gated: the caller must manage the
 * escalation's OWN department (read from the row, not the request) -- or be
 * an admin. The business rule: a resolution REQUIRES non-empty resolution
 * text (you cannot mark resolved without explaining how). `comments` is
 * optional. Sets status=resolved + resolved_by/resolved_at. Returns { id }.
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
  try {
    escEnsureTable_(conn);
    // Authorize against the row's OWN department (never trust a dept from req).
    var dept = escRowDepartment_(conn, id);
    if (dept === null) throw new Error('Escalation not found.');
    assertDeptAccess_(user, dept);

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
    Logger.log('resolveEscalation: %s resolved %s (%s)', user.email, id, dept);
    return { id: id };
  } catch (e) {
    Logger.log('resolveEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not resolve the escalation.');
  } finally {
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

/**
 * Updates the optional `comments` on an escalation WITHOUT resolving it
 * (lets a manager annotate a pending escalation). PER-DEPT gated like
 * resolveEscalation. Returns { id }.
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
  try {
    escEnsureTable_(conn);
    var dept = escRowDepartment_(conn, id);
    if (dept === null) throw new Error('Escalation not found.');
    assertDeptAccess_(user, dept);
    var stmt = conn.prepareStatement("UPDATE escalations SET comments = NULLIF(?, ''), updated_at = now() WHERE id = ?");
    stmt.setString(1, comments);
    stmt.setString(2, id);
    stmt.execute();
    stmt.close();
    Logger.log('updateEscalationComment: %s updated %s (%s)', user.email, id, dept);
    return { id: id };
  } catch (e) {
    Logger.log('updateEscalationComment failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not update the comment.');
  } finally {
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

// ── Internals ───────────────────────────────────────────────────────────

/** Reads an escalation's department (the authorization key). null if absent. */
function escRowDepartment_(conn, id) {
  var stmt = conn.prepareStatement('SELECT department FROM escalations WHERE id = ?');
  stmt.setString(1, id);
  var rs = stmt.executeQuery();
  var dept = rs.next() ? rs.getString('department') : null;
  rs.close(); stmt.close();
  return dept;
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
  // Loose shape check: YYYY-MM-DD optionally followed by T/space + time.
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(s)) return '';
  return s;
}
