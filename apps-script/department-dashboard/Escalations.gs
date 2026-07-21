/**
 * Escalations (Phases 1 + 2) — manager-facing escalation log + external
 * submission review queue.
 *
 * Managers view and "manage" (resolve + comment on) escalation calls for
 * their own department; an admin manually logs new escalations (and sees
 * every department). Backed by the Neon `escalations` table (NOT a sheet).
 * PHASE 2 (live): the external team-tools app INSERTs `pending_review` rows
 * into the SAME table (see the external-app INSERT contract below); the
 * dashboard surfaces them as a review queue — `approveEscalation` promotes a
 * submission into the dept worklist (re-validating it as untrusted input at
 * that trust boundary), `rejectEscalation` reviews it out (data retained,
 * terminal, reason required). There is no sheet fallback (like inbound_calls /
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
 *      `reopenEscalation` / `approveEscalation` / `rejectEscalation`
 *      re-resolve the caller and gate via
 *      `escAssertRowAccess_(user, <the escalation's own department>)`, so a
 *      manager can only touch their own dept's rows (the dept is read from
 *      the row, never trusted from the request).
 *   2. input validation — required fields, length caps, known-dept check,
 *      the business rules that a resolution requires non-empty text and a
 *      reopen/reject requires a non-empty reason, and Phase 2's
 *      approval-time re-normalization of externally-submitted fields.
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
// Phase 2: externally-submitted rows awaiting a manager/admin review before
// they enter the dept worklist, and reviewed-out rows (kept, never deleted).
var ESC_STATUS_PENDING_REVIEW = 'pending_review';
var ESC_STATUS_REJECTED       = 'rejected';
// C6: an escalation actively being worked (a real status transition, not a
// passive comment -- signals ownership + gets its own triage group). It slots
// into the existing chain: pending_review -> (approve) -> pending -> (start) ->
// in_progress -> (resolve) -> resolved; rejected stays the terminal branch off
// review. Started via startEscalation; the 'started' activity event records
// the owner. resolveEscalation accepts it (pending OR in_progress can resolve).
var ESC_STATUS_IN_PROGRESS = 'in_progress';

// ── Phase 2: the external-app INSERT contract ─────────────────────────────
//
// The team-tools app submits escalations by INSERTing DIRECTLY into the
// Neon `escalations` table (the shared substrate -- see escEnsureTable_ for
// the DDL). Contract for external writers:
//
//   INSERT INTO escalations
//     (id, department, occurred_at, caller, patient_name, trx, area,
//      reason, status, created_by, source)
//   VALUES
//     (<uuid>, <dept -- SHOULD match a dashboard dept header>, <timestamptz
//      or NULL>, ..., <non-empty reason>, 'pending_review',
//      <submitter email>, 'team-tools');
//
//   - status MUST be 'pending_review' -- rows inserted directly as
//     'pending' bypass the review gate and are a contract violation.
//   - source identifies the writer ('team-tools'); the dashboard's own
//     createEscalation writes 'manual'.
//   - Do NOT write escalation_activity -- the dashboard's review verbs
//     (approve/reject) own the trail from review onward; the row's
//     created_by/created_at cover submission provenance.
//   - Leave resolution/resolved_* NULL and never UPDATE a row after
//     insert; corrections happen by rejecting + resubmitting.
//
// The dashboard treats these rows as UNTRUSTED input at the review
// boundary: approveEscalation re-validates + normalizes (trim, ESC_MAX_TEXT
// caps, non-empty reason, known dept) before promoting to 'pending', and a
// mangled row can always be rejected. A dept string that matches no roster
// header is reviewable by ADMINS only (escAssertRowAccess_ pins managers to
// an exact dept match), so a typo'd dept can't orphan the row.

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
  // #1: an all-departments manager sees every dept's escalations (like admin
  // for data breadth), but createEscalation stays assertAdmin_-gated.
  var allDepts = !!user.allDepts;
  return {
    role:        user.role,
    isAdmin:     isAdmin,
    allDepts:    allDepts,
    department:  user.department || null,
    departments: (isAdmin || allDepts) ? getAllDepartments_() : (user.department ? [user.department] : []),
    neonConfigured: !!PropertiesService.getScriptProperties().getProperty('NEON_HOST'),
    statuses:    ['pending', 'pending_review', 'in_progress', 'resolved', 'rejected', 'all'],
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

  // Single-dept managers are pinned to their own dept; admins + all-dept
  // managers (#1) may pick a dept or 'ALL'.
  var department, scopeAll = false;
  if (user.role === 'admin' || user.allDepts) {
    var reqDept = String(req.department || '').trim();
    if (!reqDept || reqDept === 'ALL') { scopeAll = true; }
    else { assertDeptAccess_(user, reqDept); department = reqDept; }
  } else {
    department = user.department;
    if (!department) throw new Error('Not authorized.');
  }

  var status = String(req.status || 'pending').toLowerCase().trim();
  if (['pending', 'pending_review', 'in_progress', 'resolved', 'rejected', 'all'].indexOf(status) === -1) status = 'pending';

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
    // C1 triage band + Phase-2 review chip: ONE cheap aggregate over the SAME
    // viewer scope as the list (dept or ALL). Computed server-side, NOT from
    // the in-memory rows -- those are filtered to the active status, so the
    // band can't be derived from them (e.g. the In-progress count while
    // viewing Pending). Same connection, best-effort (band + chip just hide on
    // failure). Subsumes the old pending_review-only COUNT.
    var counts = { pending: 0, in_progress: 0, pending_review: 0, resolved: 0, rejected: 0 };
    var pendingReview = 0, resolvedLast7 = 0, oldestOpen = null, overdue = 0;
    try {
      // ESC_OVERDUE_DAYS(=3) mirrors the client's overdue threshold; calendar
      // days here (plain SQL interval) so the band's Overdue count and the
      // per-card age badge use the SAME definition (client uses calendar days
      // too -- see escDaysOpen_).
      var asql = 'SELECT '
        + "count(*) FILTER (WHERE status = 'pending') AS n_pending, "
        + "count(*) FILTER (WHERE status = 'in_progress') AS n_inprog, "
        + "count(*) FILTER (WHERE status = 'pending_review') AS n_review, "
        + "count(*) FILTER (WHERE status = 'resolved') AS n_resolved, "
        + "count(*) FILTER (WHERE status = 'rejected') AS n_rejected, "
        + "count(*) FILTER (WHERE status = 'resolved' AND resolved_at >= now() - interval '7 days') AS n_resolved7, "
        + "count(*) FILTER (WHERE status IN ('pending','in_progress') AND occurred_at < now() - interval '3 days') AS n_overdue, "
        + "min(occurred_at) FILTER (WHERE status IN ('pending','in_progress'))::text AS oldest_open "
        + 'FROM escalations' + (scopeAll ? '' : ' WHERE department = ?');
      var astmt = conn.prepareStatement(asql);
      if (!scopeAll) astmt.setString(1, department);
      var ars = astmt.executeQuery();
      if (ars.next()) {
        counts.pending        = Number(ars.getString('n_pending'))  || 0;
        counts.in_progress    = Number(ars.getString('n_inprog'))   || 0;
        counts.pending_review = Number(ars.getString('n_review'))   || 0;
        counts.resolved       = Number(ars.getString('n_resolved')) || 0;
        counts.rejected       = Number(ars.getString('n_rejected')) || 0;
        pendingReview = counts.pending_review;
        resolvedLast7 = Number(ars.getString('n_resolved7')) || 0;
        overdue       = Number(ars.getString('n_overdue'))   || 0;
        oldestOpen = ars.getString('oldest_open') || null;
      }
      ars.close(); astmt.close();
    } catch (ce2) { /* best-effort: band + chip just hide */ }
    return { available: true, rows: rows,
             meta: { department: scopeAll ? 'ALL' : department, status: status,
                     count: rows.length,
                     pendingReviewCount: pendingReview,      // back-compat (review chip)
                     statusCounts: counts,                    // C1 band
                     resolvedLast7: resolvedLast7,            // C1 "Resolved · 7d" tile
                     overdueCount: overdue,                   // C1 "Overdue >3d" tile
                     oldestOpenAt: oldestOpen,                // C1 "Oldest open" tile
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
    // L9: an access denial must be INDISTINGUISHABLE from not-found, else a
    // manager probing ids can tell "exists but another dept" apart from
    // "doesn't exist". Return the not-found shape on denial; keep the
    // {available:false} shape for a GENUINE outage (the outer catch).
    try {
      escAssertRowAccess_(user, meta.department);   // F-45: row dept = data, not input
    } catch (denied) {
      return { available: true, rows: [] };
    }
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
    // activity trail preserved it). NEO-1: the guard is status !== pending,
    // NOT merely "not resolved" -- a not-resolved-only guard let a
    // pending_review row be resolved WITHOUT passing approveEscalation (the
    // Phase-2 trust boundary: field re-normalization + empty-reason gate +
    // 'approved' provenance), and let a terminal rejected row be walked back
    // into the worklist via resolve -> reopen.
    // C6: an IN-PROGRESS row resolves directly too (pending -> resolved and
    // in_progress -> resolved are both valid worklist completions).
    if (meta.status !== ESC_STATUS_PENDING && meta.status !== ESC_STATUS_IN_PROGRESS) {
      if (meta.status === ESC_STATUS_RESOLVED) {
        throw new Error('This escalation is already resolved. Reopen it first if the '
          + 'resolution needs to change (the existing note would otherwise be overwritten).');
      }
      if (meta.status === ESC_STATUS_PENDING_REVIEW) {
        throw new Error('This escalation is still awaiting review. Approve it into the '
          + 'worklist before resolving it.');
      }
      throw new Error('Only a pending or in-progress escalation can be resolved (this one is "'
        + meta.status + '").');
    }

    conn.setAutoCommit(false); txn = true;
    // NEO-2: COALESCE keeps the row's EXISTING comment when the resolve
    // request carries a blank one (a stale UI / no-prefill client used to
    // silently NULL it; only the activity trail retained the text).
    var stmt = conn.prepareStatement(
      'UPDATE escalations SET status = ?, resolution = ?, '
      + 'comments = COALESCE(NULLIF(?, \'\'), comments), '
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
 * C6: STARTS work on an escalation (status 'pending' -> 'in_progress'),
 * signaling ownership so it moves to its own triage group. PER-DEPT gated
 * like resolveEscalation (escAssertRowAccess_ on the row's OWN dept). PENDING-
 * ONLY (an already in-progress / resolved / review / rejected row can't be
 * started). An optional note is captured in the activity trail (§5) as the
 * 'started' event; the actor IS the owner. Reuses the exact
 * lock + txn + escAppendActivity_ template as the other write verbs -- no new
 * permission path, no schema change (in_progress is just a status value, and
 * 'started' is just an action string on the existing append-only trail).
 * Returns { id }.
 */
function startEscalation(req) {
  req = req || {};
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var note = escClean_(req.note);

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
    if (meta.status !== ESC_STATUS_PENDING) {
      if (meta.status === ESC_STATUS_IN_PROGRESS) throw new Error('This escalation is already in progress.');
      throw new Error('Only a pending escalation can be started (this one is "' + meta.status + '").');
    }
    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement('UPDATE escalations SET status = ?, updated_at = now() WHERE id = ?');
    stmt.setString(1, ESC_STATUS_IN_PROGRESS);
    stmt.setString(2, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'started', user.email, note || 'Marked in progress');
    conn.commit();
    Logger.log('startEscalation: %s started %s (%s)', user.email, id, meta.department);
    return { id: id };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('startEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not start the escalation.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
}

/**
 * Phase 2: APPROVES an externally-submitted escalation (status
 * 'pending_review' -> 'pending'), admitting it into the dept worklist.
 * PER-DEPT gated like resolveEscalation (escAssertRowAccess_ on the row's
 * OWN dept -- a manager reviews only their dept's submissions; admins any).
 * The row is UNTRUSTED external input, so approval is the trust boundary:
 * fields are re-normalized (trim + ESC_MAX_TEXT caps) and a row whose
 * reason is empty after cleaning cannot be approved (reject it instead).
 * Appends an 'approved' activity row atomically (§5). Returns { id }.
 */
function approveEscalation(req) {
  req = req || {};
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another escalation write is in progress — retry in a moment.');
  var conn = getDashboardNeonConn_();
  if (!conn) { lock.releaseLock(); throw new Error('Escalations storage (Neon) is not configured/reachable.'); }
  var txn = false;
  var notifyRec = null;   // §1: populated on success, fired after the lock releases
  try {
    escEnsureTable_(conn);
    var row = escRowFull_(conn, id);
    if (!row) throw new Error('Escalation not found.');
    escAssertRowAccess_(user, row.department);   // F-45: row dept = data, not input
    if (row.status !== ESC_STATUS_PENDING_REVIEW) {
      throw new Error('Only a pending-review submission can be approved.');
    }
    var clean = escNormalizeReviewFields_(row);
    if (!clean.reason) {
      throw new Error('This submission has no reason text, so it cannot enter the '
        + 'worklist. Reject it and have it resubmitted with a reason.');
    }
    // A-4: a submission whose department matches no roster header would enter
    // a worklist NO manager can ever see (managers are pinned to exact dept
    // match; the admin dept filter validates against real depts, so the row
    // would be reachable only under the 'ALL' scope). The INSERT-contract
    // header anticipates this ("reject it") -- now enforced. Fail-open if the
    // roster read itself returns nothing, so a sheet hiccup can't block
    // legitimate approvals.
    var knownDeptsA4 = [];
    try { knownDeptsA4 = getAllDepartments_(); } catch (kdErr) { knownDeptsA4 = []; }
    if (knownDeptsA4.length && knownDeptsA4.indexOf(row.department) === -1) {
      throw new Error('Department "' + row.department + '" matches no roster (DO NOT EDIT!) '
        + 'header, so no manager could ever see this escalation. Reject it and have it '
        + 'resubmitted with the exact department name (case-sensitive).');
    }

    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement(
      "UPDATE escalations SET status = ?, caller = NULLIF(?, ''), "
      + "patient_name = NULLIF(?, ''), trx = NULLIF(?, ''), area = NULLIF(?, ''), "
      + 'reason = ?, updated_at = now() WHERE id = ?');
    stmt.setString(1, ESC_STATUS_PENDING);
    stmt.setString(2, clean.caller);
    stmt.setString(3, clean.patientName);
    stmt.setString(4, clean.trx);
    stmt.setString(5, clean.area);
    stmt.setString(6, clean.reason);
    stmt.setString(7, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'approved', user.email,
      'Accepted into the ' + row.department + ' worklist (submitted via ' + (row.source || 'unknown') + ')');
    conn.commit();
    Logger.log('approveEscalation: %s approved %s (%s)', user.email, id, row.department);
    // §1: an approved pending_review is a NEW escalation ENTERING the dept
    // worklist -- the event managers care about in Phase 2 (external inflow
    // arrives as pending_review, not createEscalation). Capture the notify
    // record here; fire it AFTER the lock releases (below), same as
    // createEscalation. Flag-gated + best-effort inside the helper.
    notifyRec = {
      id:          id,
      department:  row.department,
      occurredAt:  row.occurredAt,
      caller:      clean.caller,
      patientName: clean.patientName,
      trx:         clean.trx,
      area:        clean.area,
      reason:      clean.reason,
    };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('approveEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not approve the escalation.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
  // Fire-and-log AFTER the write committed + lock released (a slow MailApp
  // send never blocks the response or holds the lock).
  escNotifyNewEscalation_(notifyRec);
  return { id: id };
}

/**
 * Phase 2: REJECTS an externally-submitted escalation (status
 * 'pending_review' -> 'rejected'). PER-DEPT gated like approve. A
 * non-empty reason is REQUIRED (mirrors reopen) and lands in the activity
 * trail. The row's data is RETAINED (append-only house style -- rejected
 * rows stay queryable under the 'rejected'/'all' filters; a correction is
 * a fresh external resubmission). Terminal: there is no un-reject verb.
 * Returns { id }.
 */
function rejectEscalation(req) {
  req = req || {};
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var reason = escClean_(req.reason);
  if (!reason) throw new Error('A reason for rejecting is required.');

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
    if (meta.status !== ESC_STATUS_PENDING_REVIEW) {
      throw new Error('Only a pending-review submission can be rejected.');
    }
    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement('UPDATE escalations SET status = ?, updated_at = now() WHERE id = ?');
    stmt.setString(1, ESC_STATUS_REJECTED);
    stmt.setString(2, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'rejected', user.email, reason);
    conn.commit();
    Logger.log('rejectEscalation: %s rejected %s (%s)', user.email, id, meta.department);
    return { id: id };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('rejectEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not reject the escalation.');
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
  // NEO-2: an empty comment used to silently NULL the row's existing
  // comment (a destructive no-op from a stale UI). Clearing a comment is
  // not a supported operation -- the activity trail is append-only.
  if (!comments) throw new Error('A comment is required.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another escalation write is in progress — retry in a moment.');
  var conn = getDashboardNeonConn_();
  if (!conn) { lock.releaseLock(); throw new Error('Escalations storage (Neon) is not configured/reachable.'); }
  var txn = false;
  try {
    escEnsureTable_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    var dept = meta.department;
    escAssertRowAccess_(user, dept);   // F-45: row dept = data, not input
    // NEO-2: comments are for rows IN the worklist (pending or resolved).
    // A pending_review row is immutable external input until the approve/
    // reject trust boundary runs (the team-tools INSERT contract); a
    // rejected row is terminal.
    if (meta.status === ESC_STATUS_PENDING_REVIEW) {
      throw new Error('This escalation is still awaiting review — approve or reject it first.');
    }
    if (meta.status === ESC_STATUS_REJECTED) {
      throw new Error('This escalation was rejected (terminal); it cannot be annotated.');
    }
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
  // R8-4 (the R-3 class): an ALL-departments manager (allDepts:true,
  // department:null) is a DATA-BREADTH role and passes like an admin --
  // this row gate is data breadth, not an admin surface. Without the
  // branch, `rowDept !== null` threw on EVERY row: all six worklist verbs
  // failed and getEscalationActivity's not-found shape rendered every
  // activity timeline silently blank for the role.
  if (user.role === 'manager' && !user.allDepts && rowDept !== user.department) {
    throw new Error('Not authorized for this department.');
  }
  // admins + allDepts managers: entitled to every row, including rows
  // whose stored dept no longer matches a current roster header.
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
/** Reads the review-relevant columns of one escalation; null if absent. */
function escRowFull_(conn, id) {
  var stmt = conn.prepareStatement(
    // A-2: occurred_at was missing, so the approve-path notification email
    // (escNotifyNewEscalation_ builds its rec from THIS row) silently
    // dropped its "When" line on every approved submission.
    'SELECT status, department, caller, patient_name, trx, area, reason, source, '
    + 'occurred_at::text AS occurred_at '
    + 'FROM escalations WHERE id = ?');
  stmt.setString(1, id);
  var rs = stmt.executeQuery();
  var row = null;
  if (rs.next()) {
    row = {
      status:      rs.getString('status'),
      department:  rs.getString('department'),
      caller:      rs.getString('caller'),
      patientName: rs.getString('patient_name'),
      trx:         rs.getString('trx'),
      area:        rs.getString('area'),
      reason:      rs.getString('reason'),
      source:      rs.getString('source'),
      occurredAt:  rs.getString('occurred_at'),
    };
  }
  rs.close(); stmt.close();
  return row;
}

/**
 * Phase 2, pure (unit-tested): normalizes an externally-submitted row's
 * free-text fields at the approval trust boundary -- trim + ESC_MAX_TEXT
 * caps via the same escClean_ the dashboard's own create path applies.
 * (occurred_at is already a typed timestamptz column; department is
 * enforced by the review gate, not rewritten.)
 */
function escNormalizeReviewFields_(row) {
  return {
    caller:      escClean_(row.caller),
    patientName: escClean_(row.patientName),
    trx:         escClean_(row.trx),
    area:        escClean_(row.area),
    reason:      escClean_(row.reason),
  };
}

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
/**
 * Gap #3: count-only admin ping for NEW `pending_review` submissions.
 * team-tools INSERTs directly into Neon, so no dashboard code runs at
 * submission time -- the review queue is pull-only, and with
 * NOTIFY_ON_NEW_ESCALATION off (the PII default) external submissions can
 * sit unseen until an admin happens to open Escalations. This is the
 * POLLED complement: called from runPipelineWatch_'s hourly run (the
 * existing admin-push engine), gated by its OWN `NOTIFY_PENDING_REVIEW`
 * Script Property ('true' to enable; default OFF). PII-FREE by design --
 * the email carries a COUNT + dept names only, never caller/patient/
 * reason, so it composes safely with the PII flag staying off.
 *
 * Watermark discipline (OPS-1): `ESC_REVIEW_PING_WATERMARK` stores the max
 * created_at examined. First run BASELINES silently (no backlog blast);
 * later runs email once per new batch and advance the watermark only on a
 * CONFIRMED send (a mail failure retries next hour). Best-effort: never
 * throws into the caller; Neon-unreachable is a silent skip.
 */
function escPendingReviewPing_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('NOTIFY_PENDING_REVIEW') || '') !== 'true') return;
    var conn = getDashboardNeonConn_();
    if (!conn) return;   // Neon down -- next hourly run retries
    try {
      var watermark = props.getProperty('ESC_REVIEW_PING_WATERMARK') || '';
      if (!watermark) {
        // Baseline: record the newest row (ANY status -- simplest monotonic
        // clock) and never email the historical backlog.
        var bstmt = conn.createStatement();
        var brs = bstmt.executeQuery("SELECT COALESCE(MAX(created_at)::text, '') AS m FROM escalations");
        var base = brs.next() ? (brs.getString('m') || '') : '';
        brs.close(); bstmt.close();
        props.setProperty('ESC_REVIEW_PING_WATERMARK', base || '1970-01-01 00:00:00');
        return;
      }
      var stmt = conn.prepareStatement(
        'SELECT COALESCE(count(*), 0) AS n, '
        + "COALESCE(MAX(created_at)::text, '') AS maxts, "
        + "COALESCE(string_agg(DISTINCT department, ', '), '') AS depts "
        + "FROM escalations WHERE status = 'pending_review' AND created_at > ?::timestamptz");
      stmt.setString(1, watermark);
      var rs = stmt.executeQuery();
      var n = 0, maxts = '', depts = '';
      if (rs.next()) {
        n = Number(rs.getString('n')) || 0;
        maxts = rs.getString('maxts') || '';
        depts = rs.getString('depts') || '';
      }
      rs.close(); stmt.close();
      if (!n) return;
      var to = getAdminEmails_().join(',');
      if (!to) return;   // no recipients -- leave the watermark; retry later
      var url = props.getProperty('DASHBOARD_URL') || '';
      MailApp.sendEmail({
        to: to,
        subject: '[Dashboard] ' + n + ' escalation submission' + (n === 1 ? '' : 's') + ' awaiting review',
        body: n + ' new externally-submitted escalation' + (n === 1 ? ' is' : 's are')
          + ' awaiting review (department' + (depts.indexOf(',') !== -1 ? 's' : '') + ': '
          + (depts || 'unknown') + ').\n\n'
          + 'Review them under Escalations -> the "awaiting review" chip.\n'
          + (url ? '\nDashboard: ' + url + '#/escalations\n' : '')
          + '\nThis is a count-only notice (no call/patient detail). One email per new batch; '
          + 'enable NOTIFY_ON_NEW_ESCALATION for full-detail manager emails (PII surface).',
      });
      // OPS-1: advance only after the confirmed send above.
      if (maxts) props.setProperty('ESC_REVIEW_PING_WATERMARK', maxts);
    } finally {
      try { conn.close(); } catch (ce) {}
    }
  } catch (e) {
    Logger.log('escPendingReviewPing_ failed (best-effort): ' + (e && e.message ? e.message : e));
  }
}

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
  // L6: the 1-31 range check still let IMPOSSIBLE calendar dates through
  // (2026-02-31, 2026-04-31, non-leap 2026-02-29), which then died in
  // Postgres's ::timestamptz cast as the same opaque save error F-44 fixed for
  // out-of-range fields. Reject them here via a UTC round-trip (UTC avoids any
  // TZ day-shift; catches month length + leap years) so they store NULL too.
  var yr = Number(m[1]);
  var probe = new Date(Date.UTC(yr, mo - 1, da));
  if (probe.getUTCFullYear() !== yr || probe.getUTCMonth() !== (mo - 1) || probe.getUTCDate() !== da) return '';
  if (m[4]) {
    var hh = Number(m[5]), mi = Number(m[6]), se = m[8] ? Number(m[8]) : 0;
    if (hh > 23 || mi > 59 || se > 59) return '';
  }
  return s;
}
