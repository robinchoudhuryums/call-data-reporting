/**
 * Escalations (Phases 1 + 2) — manager-facing escalation log + external
 * submission review queue.
 *
 * Managers view and "manage" (resolve + comment on) escalation calls for
 * their own department; an admin manually logs new escalations (and sees
 * every department). Backed by the Neon `escalations` table (NOT a sheet).
 * PHASE 2 (DESIGNED, UNBUILT — H3, 2026-09): the design has an external app
 * (team-tools) INSERT `pending_review` rows into the SAME table under the
 * INSERT contract below, and the dashboard's review queue is BUILT for that
 * inflow — but NO external writer exists yet: as of 2026-09 team-tools has
 * no Neon connection and no escalations writer, so `pending_review` rows can
 * only come from a hand INSERT. The contract stays as the spec any future
 * writer must meet. The queue side is live — `approveEscalation` promotes a
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
 *   1. authorization — `createEscalation` / `updateEscalation` / `moveEscalation` (ESC-R1) /
 *      `linkEscalationDepartment` / `removeEscalationDepartment` (ESC-L2) /
 *      `restoreEscalationDepartment` (ESC-L3) /
 *      `deleteEscalation` are admin-only
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

// ESC-DDL / ESC-U1 (reflect 207-211): the schema the linked-copy verbs depend
// on. escEnsureTable_ adds it best-effort; escSchemaVerdict_ is what the
// Health page reads to say whether it actually landed. EVERY column
// escEnsureTable_ adds with ADD COLUMN belongs in this list, or esc-schema
// can read ok while a column the verbs read is missing (ESC-DDL2:
// escalations-hardening.test.js fails on one that is not).
var ESC_REQUIRED_COLUMNS_ = ['group_id', 'removed_by', 'removed_at', 'removed_reason', 'status_before_removal'];
// ESC-D1 (broad-scan 2026-10-01): escalation_activity's own added columns --
// checked by the esc-schema Health row exactly like the list above.
var ESC_REQUIRED_ACTIVITY_COLUMNS_ = ['department'];
var ESC_GROUP_DEPT_INDEX_ = 'idx_escalations_group_dept';

// ESC-L1: the OTHER copies of a linked escalation, as [{department, status}]
// (NULL for a standalone row). Correlated on the outer alias `e`; the
// sibling's department + status is all a viewer of one copy learns about the
// others on the LIST (owner-approved); the shared thread (ESC-L2) is the one
// other cross-copy read, via getEscalationActivity.
var ESC_LINKED_SQL_ = "CASE WHEN e.group_id IS NULL THEN NULL ELSE ("
  + "SELECT json_agg(json_build_object('department', s.department, 'status', s.status) ORDER BY s.department) "
  + "FROM escalations s WHERE s.group_id = e.group_id AND s.id <> e.id) END";
// F-46: cap the list fetch (newest first). The query was unbounded json_agg
// -- fine at today's volume, but Phase 2's external pending_review inserts
// make it an unbounded single-string JDBC fetch of PII (the failure mode
// INBOUND_TOP_N / CALLER_LOOKUP_MAX_CALLS cap elsewhere). meta.truncated
// tells the client when the cap was hit.
var ESC_MAX_ROWS = 500;

// ── E2 (broad-scan Batch E): the OUTAGE SNAPSHOT ────────────────────────────
//
// Escalations is 100% Neon-backed with no sheet twin (owner ruling: dual-
// source drift cost > outage-window benefit -- for WRITES, which this does
// not touch). During the 2026-08 transfer-cap outage the entire worklist was
// invisible for two weeks, including READ-ONLY viewing of items managers were
// mid-way through working. This snapshot closes that: after a successful
// list read, the OPEN rows (pending / in_progress / pending_review) are
// stored -- chunked -- in Script Properties (max ~9KB per value, hence the
// chunks), and when Neon is unreachable getEscalations serves them back,
// scoped to the SAME viewer rules as the live path, with meta.snapshotAsOf
// set so the client shows a read-only banner. Writes still hard-fail (INV-55
// untouched); a snapshot cannot drift because nothing can change while the
// only writer is down. Properties are engine-written outcome state (the
// *_LAST class) -- deliberately NOT an Operator State item. SEC-6: the rows
// carry PHI (patient / caller / Trx / reason), so this puts PHI in plain
// Script Properties -- ACCEPTED by owner ruling (inside the Workspace
// tenancy), conditional on Apps Script being a covered service; see
// docs/operator-state.md #24(c) before widening what the snapshot stores.
var ESC_SNAPSHOT_MAX_ROWS = 150;      // open rows kept (newest first)
// ESC-D6 (broad-scan 2026-10-01): measured in UTF-8 BYTES -- the ~9KB
// per-property cap is bytes, and 8000 CHARS of accented names / emoji in a
// comment can be ~24KB. escChunkUtf8_ never splits a surrogate pair.
var ESC_SNAPSHOT_CHUNK_BYTES = 8000;  // under the ~9KB per-property cap
var ESC_SNAPSHOT_MAX_CHUNKS = 6;      // hard ceiling ~48KB of the 500KB store
var ESC_SNAPSHOT_REFRESH_MIN = 30;    // at most one refresh query per this
// ESC-S1 (2026-09-30, owner ask): the ACTIVITY THREADS of the snapshot's open
// rows ride alongside it under ESC_SNAPSHOT_ACT_*, so Activity still opens
// (read-only) while Neon is down. Its own ceiling, so threads can never crowd
// out the rows; each entry's detail is shortened past ESC_SNAPSHOT_ACT_DETAIL
// chars (flagged, so the client can say so); a thread is stored WHOLE or not
// at all -- never a silently partial conversation. SEC-6 covers it: comments
// can carry PHI exactly as the rows do (docs/operator-state.md #24(c)).
var ESC_SNAPSHOT_ACT_MAX_CHUNKS = 6;  // ~48KB, beside the rows' ~48KB
var ESC_SNAPSHOT_ACT_DETAIL = 600;    // chars of each entry's detail kept

/** ESC-D6: UTF-8 byte length of a JS string (surrogate pair = 4 bytes). */
function escUtf8Len_(str) {
  var n = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** ESC-D6: splits `str` into pieces of at most `maxBytes` UTF-8 bytes each,
 *  never between the two halves of a surrogate pair. Pure. */
function escChunkUtf8_(str, maxBytes) {
  var out = [], start = 0, bytes = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    var pair = c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length;
    var w = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + w > maxBytes) { out.push(str.slice(start, i)); start = i; bytes = 0; }
    bytes += w;
    if (pair) i++;
  }
  if (start < str.length) out.push(str.slice(start));
  return out;
}

/**
 * Pure: rows -> { chunks, count, truncated }. Drops TAIL rows (the list is
 * newest-first) until the serialized form fits the chunk ceiling, so the
 * store can never overflow the property quota however escalation volume
 * grows. tests/unit/escalations-snapshot.test.js pins the boundary.
 */
function escSnapshotChunk_(rows) {
  rows = (rows || []).slice(0, ESC_SNAPSHOT_MAX_ROWS);
  var truncated = false;
  var json = JSON.stringify(rows);
  var chunks = escChunkUtf8_(json, ESC_SNAPSHOT_CHUNK_BYTES);
  while (chunks.length > ESC_SNAPSHOT_MAX_CHUNKS && rows.length) {
    rows = rows.slice(0, rows.length - 1);
    truncated = true;
    json = JSON.stringify(rows);
    chunks = escChunkUtf8_(json, ESC_SNAPSHOT_CHUNK_BYTES);
  }
  return { chunks: chunks, count: rows.length,
           truncated: truncated || (rows.length >= ESC_SNAPSHOT_MAX_ROWS) };
}

/** Stores rows + META (written LAST, so a half-write reads as absent). */
function escSnapshotStore_(rows) {
  try {
    var props = PropertiesService.getScriptProperties();
    var packed = escSnapshotChunk_(rows);
    for (var i = 0; i < packed.chunks.length; i++) {
      props.setProperty('ESC_SNAPSHOT_' + (i + 1), packed.chunks[i]);
    }
    // Drop stale higher chunks from a previously-larger snapshot BEFORE the
    // meta write points readers at the new count.
    for (var j = packed.chunks.length + 1; j <= ESC_SNAPSHOT_MAX_CHUNKS; j++) {
      props.deleteProperty('ESC_SNAPSHOT_' + j);
    }
    props.setProperty('ESC_SNAPSHOT_META', JSON.stringify({
      at: new Date().toISOString(), chunks: packed.chunks.length,
      count: packed.count, truncated: packed.truncated,
    }));
  } catch (e) {
    // Best-effort -- a failed snapshot must never cost the live read. ESC-D6:
    // but say so; an empty catch hid an over-cap write (the store keeps the
    // PREVIOUS snapshot, which then ages silently).
    Logger.log('escSnapshotStore_: snapshot NOT stored: ' + (e && e.message ? e.message : e));
  }
}

/** { rows, at, truncated } or null (absent / torn / unparseable). */
function escSnapshotLoad_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var meta = JSON.parse(props.getProperty('ESC_SNAPSHOT_META') || 'null');
    if (!meta || !meta.chunks) return null;
    var json = '';
    for (var i = 1; i <= meta.chunks; i++) {
      var c = props.getProperty('ESC_SNAPSHOT_' + i);
      if (c == null) return null;   // torn write -> treat as no snapshot
      json += c;
    }
    var rows = JSON.parse(json);
    if (!Array.isArray(rows)) return null;
    return { rows: rows, at: meta.at || null, truncated: !!meta.truncated };
  } catch (e) { return null; }
}

/**
 * PCR-8 (broad-scan 2026-09-23): refresh the outage snapshot right after a
 * committed mutation. Only the delete did (2a); every other write left the
 * snapshot up to ESC_SNAPSHOT_REFRESH_MIN stale, so an outage in that window
 * served a just-resolved row as still open, or hid a just-created one. The
 * connection leaves its transaction first (the refresh is a plain read).
 * Best-effort: a failure here never fails the write that already committed.
 */
function escSnapshotAfterWrite_(conn) {
  try { conn.setAutoCommit(true); } catch (ae) { /* best-effort */ }
  try { escSnapshotMaybeRefresh_(conn, /*force=*/true); } catch (e) { /* best-effort */ }
}

/**
 * Refreshes the snapshot from a LIVE connection, at most once per
 * ESC_SNAPSHOT_REFRESH_MIN (age-gated on the stored meta). One bounded query
 * for the open statuses, UNSCOPED -- the snapshot must serve every viewer, so
 * it stores the full open set and the SERVE path re-applies the viewer's
 * dept scope. Best-effort throughout.
 */
function escSnapshotMaybeRefresh_(conn, force) {
  try {
    var props = PropertiesService.getScriptProperties();
    var meta = null;
    try { meta = JSON.parse(props.getProperty('ESC_SNAPSHOT_META') || 'null'); } catch (e) { meta = null; }
    // 2a: a delete refreshes UNCONDITIONALLY, so an outage read served from
    // the snapshot cannot resurrect a row the admin just removed -- and since
    // PCR-8 so does every other committed write (escSnapshotAfterWrite_).
    if (!force && meta && meta.at) {
      var ageMin = (Date.now() - new Date(meta.at).getTime()) / 60000;
      if (isFinite(ageMin) && ageMin >= 0 && ageMin < ESC_SNAPSHOT_REFRESH_MIN) return;
    }
    var sql = "SELECT COALESCE(json_agg(t ORDER BY t.occurred_at DESC NULLS LAST, t.created_at DESC), '[]')::text AS j FROM ("
            + 'SELECT id, department, occurred_at::text AS occurred_at, caller, patient_name, trx, area, reason, '
            + 'status, resolution, comments, created_by, created_at::text AS created_at, '
            + 'resolved_by, resolved_at::text AS resolved_at, source, group_id, '
            + ESC_LINKED_SQL_ + ' AS linked FROM escalations e '
            + "WHERE status IN ('pending','in_progress','pending_review') "
            + 'ORDER BY occurred_at DESC NULLS LAST, created_at DESC LIMIT ' + ESC_SNAPSHOT_MAX_ROWS
            + ') t';
    var stmt = conn.prepareStatement(sql);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'escalations');
    rs.close(); stmt.close();
    var snapRows = JSON.parse(json || '[]');
    escSnapshotStore_(snapRows);
    // ESC-S1: the threads of those rows, from the same connection. Its own
    // try: a failure here costs the offline threads, never the rows.
    try { escSnapshotActRefresh_(conn, snapRows); } catch (eAct) { /* best-effort */ }
  } catch (e) { /* best-effort */ }
}

/**
 * ESC-S1: reads the activity of every thread the snapshot rows belong to --
 * a standalone row's own trail, a linked row's WHOLE group (removed copies'
 * entries included, as the live thread shows them) -- and stores it packed.
 * One bounded query: the thread keys are bound as parameters, capped by the
 * snapshot's own row cap.
 */
function escSnapshotActRefresh_(conn, rows) {
  var ids = [], groups = [];
  (rows || []).forEach(function (r) {
    if (!r) return;
    if (r.group_id) { if (groups.indexOf(String(r.group_id)) === -1) groups.push(String(r.group_id)); }
    else ids.push(String(r.id));
  });
  var entries = [];
  if (ids.length || groups.length) {
    var where = [];
    if (ids.length) where.push('(e.group_id IS NULL AND a.escalation_id IN (' + ids.map(function () { return '?'; }).join(',') + '))');
    if (groups.length) where.push('e.group_id IN (' + groups.map(function () { return '?'; }).join(',') + ')');
    var sql = "SELECT COALESCE(json_agg(t ORDER BY t.at ASC), '[]')::text AS j FROM ("
      + 'SELECT a.escalation_id AS e, e.group_id AS g, a.action, a.actor, a.at::text AS at, '
      + 'left(a.detail, ' + ESC_SNAPSHOT_ACT_DETAIL + ') AS detail, '
      + '(length(a.detail) > ' + ESC_SNAPSHOT_ACT_DETAIL + ') AS cut, '
      + "COALESCE(a.department, e.department) AS department, (e.status = 'removed') AS removed "   // ESC-D1
      + 'FROM escalation_activity a JOIN escalations e ON e.id = a.escalation_id WHERE '
      + where.join(' OR ') + ') t';
    var stmt = conn.prepareStatement(sql);
    var params = ids.concat(groups);
    for (var i = 0; i < params.length; i++) stmt.setString(i + 1, params[i]);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'escalations');
    rs.close(); stmt.close();
    entries = JSON.parse(json || '[]');
    if (!Array.isArray(entries)) entries = [];
  }
  escSnapshotActStore_(escSnapshotActPack_(rows, entries));
}

/**
 * ESC-S1 (PURE): rows (newest first) + activity entries -> { threads,
 * count, truncated }. `threads` maps a thread KEY (the group_id of a linked
 * row, else the row's id) to its entries, oldest first, in the compact shape
 * the serve path expands. Threads are added in row order and a thread that
 * would push past the ceiling is skipped WHOLE (truncated = true).
 */
function escSnapshotActPack_(rows, entries) {
  var byKey = {};
  (entries || []).forEach(function (x) {
    if (!x) return;
    var k = x.g ? String(x.g) : String(x.e);
    (byKey[k] = byKey[k] || []).push({ a: x.action, u: x.actor || null, t: x.at || null,
      d: x.detail == null ? null : x.detail, c: x.cut ? 1 : 0,
      dp: x.g ? (x.department || null) : null, r: (x.g && x.removed) ? 1 : 0 });
  });
  // ESC-D6: a BYTE budget. A chunk boundary strands at most 3 bytes (a
  // multi-byte character never splits), so N chunks always hold N*(B-3).
  var cap = ESC_SNAPSHOT_ACT_MAX_CHUNKS * (ESC_SNAPSHOT_CHUNK_BYTES - 3);
  var threads = {}, size = 2, count = 0, truncated = false, seen = {};
  (rows || []).forEach(function (r) {
    if (!r) return;
    var k = r.group_id ? String(r.group_id) : String(r.id);
    if (seen[k]) return;
    seen[k] = true;
    var list = byKey[k] || [];
    var add = escUtf8Len_(JSON.stringify(k)) + escUtf8Len_(JSON.stringify(list)) + 2;
    if (size + add > cap) { truncated = true; return; }
    threads[k] = list;
    size += add;
    count++;
  });
  return { threads: threads, count: count, truncated: truncated };
}

/** ESC-S1: stores the packed threads, META last (a torn write reads absent). */
function escSnapshotActStore_(packed) {
  try {
    var props = PropertiesService.getScriptProperties();
    var json = JSON.stringify(packed.threads || {});
    var chunks = escChunkUtf8_(json, ESC_SNAPSHOT_CHUNK_BYTES);   // ESC-D6
    if (chunks.length > ESC_SNAPSHOT_ACT_MAX_CHUNKS) {   // cannot happen past the packer; never overflow the store
      Logger.log('escSnapshotActStore_: ' + chunks.length + ' chunks exceed the ceiling -- threads NOT stored.');
      return;
    }
    for (var c = 0; c < chunks.length; c++) props.setProperty('ESC_SNAPSHOT_ACT_' + (c + 1), chunks[c]);
    for (var j = chunks.length + 1; j <= ESC_SNAPSHOT_ACT_MAX_CHUNKS; j++) props.deleteProperty('ESC_SNAPSHOT_ACT_' + j);
    props.setProperty('ESC_SNAPSHOT_ACT_META', JSON.stringify({
      at: new Date().toISOString(), chunks: chunks.length, threads: packed.count || 0, truncated: !!packed.truncated,
    }));
  } catch (e) {
    Logger.log('escSnapshotActStore_: threads NOT stored: ' + (e && e.message ? e.message : e));   // ESC-D6
  }
}

/** ESC-S1: { threads, at, truncated } or null (absent / torn / unparseable). */
function escSnapshotActLoad_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var meta = JSON.parse(props.getProperty('ESC_SNAPSHOT_ACT_META') || 'null');
    if (!meta || !meta.chunks) return null;
    var json = '';
    for (var i = 1; i <= meta.chunks; i++) {
      var c = props.getProperty('ESC_SNAPSHOT_ACT_' + i);
      if (c == null) return null;
      json += c;
    }
    var threads = JSON.parse(json);
    if (!threads || typeof threads !== 'object') return null;
    return { threads: threads, at: meta.at || null, truncated: !!meta.truncated };
  } catch (e) { return null; }
}

/**
 * ESC-S1: getEscalationActivity's outage path. Authorizes EXACTLY like the
 * live path -- against the requested copy's department, found in the ROWS
 * snapshot (L9: a denial returns the offline not-found shape, ESC-D5) -- then serves that
 * row's thread from the thread snapshot, marked `snapshotAsOf`. A row the
 * snapshot does not hold (a closed or removed copy) or a thread that did not
 * fit keeps the plain unavailable shape (+ `snapshotMissing` for the latter).
 */
function escSnapshotActServe_(user, id) {
  var snap = escSnapshotLoad_();
  var row = snap ? snap.rows.filter(function (r) { return r && String(r.id) === String(id); })[0] : null;
  if (!row) return { available: false, rows: [] };
  // ESC-D5 (broad-scan 2026-10-01): a denial returns EXACTLY the not-in-
  // snapshot shape above. It returned the live path's {available:true} instead,
  // so offline a manager probing ids could tell "exists in another dept"
  // (true) from "no such id" (false) -- the L9 leak, on the outage path.
  try { escAssertRowAccess_(user, row.department); } catch (denied) { return { available: false, rows: [] }; }
  var act = escSnapshotActLoad_();
  var k = row.group_id ? String(row.group_id) : String(row.id);
  var list = act && act.threads && Object.prototype.hasOwnProperty.call(act.threads, k) ? act.threads[k] : null;
  if (!list) return { available: false, rows: [], snapshotMissing: !!act };
  return {
    available: true, linked: !!row.group_id, snapshotAsOf: act.at,
    rows: list.map(function (x) {
      var out = { action: x.a, actor: x.u, at: x.t, detail: x.d, shortened: !!x.c };
      if (row.group_id) { out.department = x.dp; out.removed = !!x.r; }
      return out;
    }),
  };
}

/**
 * Serves the snapshot under the SAME viewer scope the live path computed
 * (scopeAll / deptList / department -- already authorization-checked by the
 * caller before Neon was ever touched). Returns null when no snapshot exists
 * -- the caller falls back to the plain unavailable shape. The payload is
 * shaped exactly like the live one so every client renderer works unchanged;
 * meta.snapshotAsOf is the one addition (the client banner keys on it).
 * Closed statuses (resolved / rejected) are NOT in the snapshot -- requesting
 * them serves an empty list with the banner explaining why. The C1 band
 * counts come from the snapshot's open rows in scope; resolved / rejected /
 * MTD / overdue are unknowable from a snapshot and stay 0.
 */
function escSnapshotServe_(scopeAll, deptList, department, status, metaDept) {
  var snap = escSnapshotLoad_();
  if (!snap) return null;
  var inScope = snap.rows.filter(function (r) {
    if (scopeAll) return true;
    var d = String((r && r.department) || '');
    if (deptList) return deptList.indexOf(d) !== -1;
    return d === department;
  });
  var counts = { pending: 0, in_progress: 0, pending_review: 0, resolved: 0, rejected: 0, removed: 0 };
  var oldestOpen = null;
  inScope.forEach(function (r) {
    var st = String((r && r.status) || '');
    if (counts.hasOwnProperty(st)) counts[st]++;
    var occ = (r && (r.occurred_at || r.created_at)) || null;
    if (occ && (!oldestOpen || occ < oldestOpen)) oldestOpen = occ;
  });
  var rows = (status === 'all') ? inScope
    : inScope.filter(function (r) { return String((r && r.status) || '') === status; });
  return { available: true, rows: rows,
           meta: { department: metaDept, status: status, count: rows.length,
                   pendingReviewCount: counts.pending_review,
                   statusCounts: counts,
                   resolvedMTD: 0, overdueCount: 0, oldestOpenAt: oldestOpen,
                   truncated: false,
                   snapshotAsOf: snap.at, snapshotTruncated: snap.truncated } };
}
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
// ESC-L2 (Step 2b, owner decision (b) 2026-09-30): a department REMOVED from
// a linked escalation. Not a delete: the copy + its trail stay in the shared
// thread, labelled, and the removed dept's managers can still OPEN it
// read-only to see the outcome. Every write verb refuses it
// (escAssertNotRemoved_); it leaves the open worklist, the badge and the
// snapshot because each of those lists open statuses explicitly.
var ESC_STATUS_REMOVED = 'removed';

// F3: the overdue threshold, in CALENDAR DAYS. One definition, one place.
// The client's escDaysOpen_ (script.html) computes a DATE-ONLY difference and
// flags `>= ESC_OVERDUE_DAYS`; the two aggregate queries below previously used
// `occurred_at < now() - interval '3 days'`, a 72-HOUR comparison, so an
// escalation 71 hours old on its 3rd calendar day was flagged ⚑ on its card but
// NOT counted by the band tile / nav badge. Both now compare calendar dates
// (`CURRENT_DATE - occurred_at::date >= N`) so the count always matches the
// flags. NULL occurred_at yields NULL -> not counted, matching the client
// (escDaysOpen_ returns null -> no badge). Residual: CURRENT_DATE is the DB's
// date and the client's is the browser's, so they can differ for a few hours
// around midnight across timezones -- bounded and self-correcting, versus the
// old always-on 1-day skew.
var ESC_OVERDUE_DAYS = 3;
var ESC_OVERDUE_SQL_ = "(CURRENT_DATE - occurred_at::date) >= " + ESC_OVERDUE_DAYS;

// ── Phase 2: the external-app INSERT contract (SPEC -- no writer yet, H3) ──
//
// DESIGN: an external app (team-tools) submits escalations by INSERTing
// DIRECTLY into the Neon `escalations` table (the shared substrate -- see
// escEnsureTable_ for the DDL). As of 2026-09 that writer is UNBUILT --
// team-tools has no Neon connection -- so this block is the contract a
// future writer must meet, not a description of live traffic. Contract for
// external writers:
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
  assertManagerOrAdmin_(user);   // Phase A: escalations are a manager/admin worklist
  var isAdmin = user.role === 'admin';
  // #1: an all-departments manager sees every dept's escalations (like admin
  // for data breadth), but createEscalation stays assertAdmin_-gated.
  var allDepts = !!user.allDepts;
  return {
    role:        user.role,
    isAdmin:     isAdmin,
    allDepts:    allDepts,
    department:  user.department || null,
    // Tier C: a multi-dept manager gets their assigned list (for the esc dept
    // picker); single-dept managers get their one dept; admins/all-dept get all.
    departments: (isAdmin || allDepts) ? getAllDepartments_()
      : ((user.departments && user.departments.length) ? user.departments
         : (user.department ? [user.department] : [])),
    neonConfigured: !!PropertiesService.getScriptProperties().getProperty('NEON_HOST'),
    statuses:    ['pending', 'pending_review', 'in_progress', 'resolved', 'rejected', 'removed', 'all'],
  };
}

/**
 * Lists escalations for a department (managers: forced to their own;
 * admins: the requested dept, or 'ALL'), filtered by status
 * (pending | resolved | all). Read-only. Returns
 * { available, rows, meta } -- available=false when Neon is unreachable
 * (NOT cached -- a transient outage shouldn't pin an empty list).
 */
/**
 * R12-20 (#1): lightweight per-viewer escalation counts for the landing
 * chrome (nav-tab badge + Overview strip). READ-ONLY; same signed-in gate +
 * dept scoping as getEscalations, aggregate query only. Best-effort: any
 * failure (incl. a not-yet-created table) returns { available: false }.
 */
function getEscalationsBadge() {
  var user = resolveUser_(Session.getActiveUser().getEmail());
  assertManagerOrAdmin_(user);   // Phase A: escalations are a manager/admin worklist
  var conn = null;
  try {
    conn = getDashboardNeonConn_();
    if (!conn) return { available: false };
    var clause = '', params = [];
    if (!(user.role === 'admin' || user.allDepts)) {
      var mine = (user.departments && user.departments.length) ? user.departments
        : (user.department ? [user.department] : []);
      if (!mine.length) return { available: false };
      clause = ' WHERE department IN (' + mine.map(function () { return '?'; }).join(',') + ')';
      params = mine;
    }
    // R20 (owner): grouped by department so the Overview strip + Company
    // snapshot line can name WHICH depts carry the open count, not just the
    // total. Totals are summed from the groups, so the two can never disagree.
    // ESC-L1: n_linked counts the open rows that are one copy of a linked
    // escalation -- a company total counts each copy (each dept owes work),
    // so the strip labels how many of them are linked. The badge never runs
    // escEnsureTable_, so on a table the Step-2a DDL has not reached yet the
    // group_id column is missing: fall back to the pre-2a query (linked 0).
    var buildSql = function (withLinked) {
      return 'SELECT department, '
        + "count(*) FILTER (WHERE status IN ('pending','in_progress')) AS n_open, "
        + "count(*) FILTER (WHERE status = 'pending_review') AS n_review, "
        + (withLinked ? "count(*) FILTER (WHERE status IN ('pending','in_progress') AND group_id IS NOT NULL) AS n_linked, " : '')
        + "count(*) FILTER (WHERE status IN ('pending','in_progress') AND "
          + ESC_OVERDUE_SQL_ + ') AS n_overdue '
        + 'FROM escalations' + clause + ' GROUP BY department';
    };
    var stmt = null, rs = null, withLinked = true;
    try {
      stmt = conn.prepareStatement(buildSql(true));
      for (var i = 0; i < params.length; i++) stmt.setString(i + 1, params[i]);
      rs = stmt.executeQuery();
    } catch (colErr) {
      try { if (stmt) stmt.close(); } catch (ce) {}
      withLinked = false;
      stmt = conn.prepareStatement(buildSql(false));
      for (var i2 = 0; i2 < params.length; i2++) stmt.setString(i2 + 1, params[i2]);
      rs = stmt.executeQuery();
    }
    var out = { available: true, open: 0, review: 0, overdue: 0, linked: 0, byDept: [] };
    while (rs.next()) {
      var dOpen    = Number(rs.getString('n_open'))    || 0;
      var dReview  = Number(rs.getString('n_review'))  || 0;
      var dOverdue = Number(rs.getString('n_overdue')) || 0;
      out.open    += dOpen;
      out.review  += dReview;
      out.overdue += dOverdue;
      if (withLinked) out.linked += Number(rs.getString('n_linked')) || 0;
      if (dOpen > 0) {
        out.byDept.push({ dept: String(rs.getString('department') || ''), open: dOpen, overdue: dOverdue });
      }
    }
    rs.close(); stmt.close();
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(JSON.stringify(out).length, 'escalations');   // OD-3
    out.byDept.sort(function (a, b) { return b.open - a.open || (a.dept < b.dept ? -1 : 1); });
    return out;
  } catch (e) {
    return { available: false };
  } finally {
    if (conn) { try { conn.close(); } catch (e2) {} }
  }
}

function getEscalations(req) {
  req = req || {};
  var user = resolveUser_(Session.getActiveUser().getEmail());
  assertManagerOrAdmin_(user);   // AC-3: allowlist, never a bare role-none check

  // Single-dept managers are pinned to their own dept; admins + all-dept
  // managers (#1) may pick a dept or 'ALL'. Tier C: a MULTI-dept manager may
  // pick any of their assigned depts, or (default) see all of them (deptList).
  var department = null, scopeAll = false, deptList = null;
  if (user.role === 'admin' || user.allDepts) {
    var reqDept = String(req.department || '').trim();
    if (!reqDept || reqDept === 'ALL') { scopeAll = true; }
    else { assertDeptAccess_(user, reqDept); department = reqDept; }
  } else {
    var mine = (user.departments && user.departments.length) ? user.departments
      : (user.department ? [user.department] : []);
    if (!mine.length) throw new Error('Not authorized.');
    var reqDept2 = String(req.department || '').trim();
    if (reqDept2 && reqDept2 !== 'ALL') { assertDeptAccess_(user, reqDept2); department = reqDept2; }
    else if (mine.length === 1) { department = mine[0]; }
    else { deptList = mine; }   // all of the manager's assigned depts
  }
  // R19: page-view telemetry. The client passes pageView:true only on page
  // ENTRY (setPage / the Overview strip link) -- filter changes, refreshes
  // and the post-mutation reloads pass nothing, so 'escalations' rows in
  // Report Usage count visits, not list re-fetches.
  if (req.pageView) {
    logReportUsage_('escalations',
      department || (deptList ? deptList.join('+') : '(all)'), user, false);
  }

  // Dept predicate shared by the list + aggregate queries.
  var escDeptWhere_ = function () {
    if (scopeAll) return { clause: '', params: [] };
    if (deptList) return {
      clause: 'department IN (' + deptList.map(function () { return '?'; }).join(',') + ')',
      params: deptList.slice(),
    };
    return { clause: 'department = ?', params: [department] };
  };
  var metaDept = scopeAll ? 'ALL' : (deptList ? deptList.join(', ') : department);

  var status = String(req.status || 'pending').toLowerCase().trim();
  if (['pending', 'pending_review', 'in_progress', 'resolved', 'rejected', 'removed', 'all'].indexOf(status) === -1) status = 'pending';

  var conn = escTimed_(getDashboardNeonConn_());   // ESC-D2: bounded statements
  if (!conn) {
    // E2: Neon down/unconfigured -- serve the read-only snapshot if one
    // exists (scoped identically; the client banners on meta.snapshotAsOf).
    var snapServe = escSnapshotServe_(scopeAll, deptList, department, status, metaDept);
    if (snapServe) return snapServe;
    return { available: false, rows: [], meta: { department: metaDept, status: status } };
  }
  try {
    escEnsureTableOnce_(conn);
    var where = [];
    var params = [];
    var dw = escDeptWhere_();
    if (dw.clause) { where.push(dw.clause); params = params.concat(dw.params); }
    if (status !== 'all') { where.push('status = ?'); params.push(status); }
    var sql = "SELECT COALESCE(json_agg(t ORDER BY t.occurred_at DESC NULLS LAST, t.created_at DESC), '[]')::text AS j FROM ("
            + "SELECT id, department, occurred_at::text AS occurred_at, caller, patient_name, trx, area, reason, "
            + "status, resolution, comments, created_by, created_at::text AS created_at, "
            + "resolved_by, resolved_at::text AS resolved_at, source, group_id, "
            + "removed_by, removed_at::text AS removed_at, removed_reason, "   // ESC-L2
            + ESC_LINKED_SQL_ + " AS linked "
            + "FROM escalations e"
            + (where.length ? (' WHERE ' + where.join(' AND ')) : '')
            // F-46: newest-first cap inside the subquery (json_agg re-sorts
            // the capped set with the same keys, so order is unchanged).
            // A-4: fetch cap+1 then slice (the CallerLookup NEO-4/R-2
            // pattern) so `truncated` distinguishes "exactly the cap" from
            // "more than the cap" -- LIMIT = cap flagged a false positive at
            // the boundary.
            + ' ORDER BY occurred_at DESC NULLS LAST, created_at DESC LIMIT ' + (ESC_MAX_ROWS + 1)
            + ') t';
    var stmt = conn.prepareStatement(sql);
    for (var i = 0; i < params.length; i++) stmt.setString(i + 1, params[i]);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    // F5: meter the bytes this read actually pulled (NeonRead.gs;
    // typeof-guarded like every other cross-file call here).
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'escalations');
    rs.close(); stmt.close();
    var rows = JSON.parse(json || '[]');
    var escTruncated = rows.length > ESC_MAX_ROWS;   // A-4
    if (escTruncated) rows = rows.slice(0, ESC_MAX_ROWS);
    // C1 triage band + Phase-2 review chip: ONE cheap aggregate over the SAME
    // viewer scope as the list (dept or ALL). Computed server-side, NOT from
    // the in-memory rows -- those are filtered to the active status, so the
    // band can't be derived from them (e.g. the In-progress count while
    // viewing Pending). Same connection, best-effort (band + chip just hide on
    // failure). Subsumes the old pending_review-only COUNT.
    var counts = { pending: 0, in_progress: 0, pending_review: 0, resolved: 0, rejected: 0, removed: 0 };
    var pendingReview = 0, resolvedMTD = 0, oldestOpen = null, overdue = 0;
    try {
      // F3: ESC_OVERDUE_SQL_ is the SINGLE definition of "overdue" (calendar
      // days, matching the client's escDaysOpen_) -- this used to be an inline
      // 72-hour interval that disagreed with the ⚑ badges it was counting.
      var asql = 'SELECT '
        + "count(*) FILTER (WHERE status = 'pending') AS n_pending, "
        + "count(*) FILTER (WHERE status = 'in_progress') AS n_inprog, "
        + "count(*) FILTER (WHERE status = 'pending_review') AS n_review, "
        + "count(*) FILTER (WHERE status = 'resolved') AS n_resolved, "
        + "count(*) FILTER (WHERE status = 'rejected') AS n_rejected, "
        + "count(*) FILTER (WHERE status = 'removed') AS n_removed, "   // ESC-L2
        + "count(*) FILTER (WHERE status = 'resolved' AND resolved_at >= date_trunc('month', now())) AS n_resolved_mtd, "
        + "count(*) FILTER (WHERE status IN ('pending','in_progress') AND "
          + ESC_OVERDUE_SQL_ + ') AS n_overdue, '
        + "min(occurred_at) FILTER (WHERE status IN ('pending','in_progress'))::text AS oldest_open "
        + 'FROM escalations' + (dw.clause ? (' WHERE ' + dw.clause) : '');
      var astmt = conn.prepareStatement(asql);
      for (var ai = 0; ai < dw.params.length; ai++) astmt.setString(ai + 1, dw.params[ai]);
      var ars = astmt.executeQuery();
      if (ars.next()) {
        counts.pending        = Number(ars.getString('n_pending'))  || 0;
        counts.in_progress    = Number(ars.getString('n_inprog'))   || 0;
        counts.pending_review = Number(ars.getString('n_review'))   || 0;
        counts.resolved       = Number(ars.getString('n_resolved')) || 0;
        counts.rejected       = Number(ars.getString('n_rejected')) || 0;
        counts.removed        = Number(ars.getString('n_removed'))  || 0;
        pendingReview = counts.pending_review;
        resolvedMTD = Number(ars.getString('n_resolved_mtd')) || 0;
        overdue       = Number(ars.getString('n_overdue'))   || 0;
        oldestOpen = ars.getString('oldest_open') || null;
      }
      ars.close(); astmt.close();
      if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(JSON.stringify(counts).length + 40, 'escalations');   // OD-3
    } catch (ce2) { /* best-effort: band + chip just hide */ }
    // E2: keep the outage snapshot warm (age-gated to one bounded query per
    // ESC_SNAPSHOT_REFRESH_MIN; same connection; best-effort).
    try { escSnapshotMaybeRefresh_(conn); } catch (eSnap) { /* never costs the read */ }
    return { available: true, rows: rows,
             meta: { department: metaDept, status: status,
                     count: rows.length,
                     pendingReviewCount: pendingReview,      // back-compat (review chip)
                     statusCounts: counts,                    // C1 band
                     resolvedMTD: resolvedMTD,                // C1 "Resolved · MTD" tile (R11-H)
                     overdueCount: overdue,                   // C1 "Overdue >3d" tile
                     oldestOpenAt: oldestOpen,                // C1 "Oldest open" tile
                     truncated: escTruncated } };   // F-46 / A-4
  } catch (e) {
    Logger.log('getEscalations failed: ' + (e && e.message ? e.message : e));
    // E2: a mid-query failure (conn opened, then Neon died) serves the
    // snapshot too -- same fallback as the no-conn path.
    var snapServe2 = escSnapshotServe_(scopeAll, deptList, department, status, metaDept);
    if (snapServe2) return snapServe2;
    return { available: false, rows: [], meta: { department: metaDept, status: status } };
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
  assertManagerOrAdmin_(user);   // AC-3: allowlist, never a bare role-none check
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');

  var conn = escTimed_(getDashboardNeonConn_());   // ESC-D2: bounded statements
  if (!conn) return escSnapshotActServe_(user, id);   // ESC-S1: the offline thread
  try {
    escEnsureTableOnce_(conn);
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
    // ESC-L2 (Step 2b, owner decision 1): a LINKED copy's trail is the WHOLE
    // group's thread -- every copy's entries, each tagged with its department
    // and whether that copy was removed -- so the departments respond on one
    // chain. The gate above is still on the REQUESTED copy: a manager reaches
    // the thread only through a copy of their own dept (a removed one
    // included -- read-only, to see the outcome). A standalone row keeps the
    // single-row query (no department tag).
    var sql = meta.groupId
      ? "SELECT COALESCE(json_agg(t ORDER BY t.at ASC), '[]')::text AS j FROM ("
        + "SELECT a.action, a.actor, a.at::text AS at, a.detail, "
        + "COALESCE(a.department, e.department) AS department, "
        + "(e.status = 'removed') AS removed, (a.escalation_id = ?) AS own "
        + "FROM escalation_activity a JOIN escalations e ON e.id = a.escalation_id "
        + "WHERE e.group_id = ?) t"
      : "SELECT COALESCE(json_agg(t ORDER BY t.at ASC), '[]')::text AS j FROM ("
        + "SELECT action, actor, at::text AS at, detail FROM escalation_activity WHERE escalation_id = ?) t";
    var stmt = conn.prepareStatement(sql);
    stmt.setString(1, id);
    if (meta.groupId) stmt.setString(2, meta.groupId);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    // F5: meter the bytes this read actually pulled (NeonRead.gs;
    // typeof-guarded like every other cross-file call here).
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'escalations');
    rs.close(); stmt.close();
    return { available: true, rows: JSON.parse(json || '[]'), linked: !!meta.groupId };
  } catch (e) {
    Logger.log('getEscalationActivity failed: ' + (e && e.message ? e.message : e));
    // ESC-S1: a mid-query Neon death serves the offline thread too.
    try { return escSnapshotActServe_(user, id); } catch (eSnap) { return { available: false, rows: [] }; }
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
  // ESC-L1 (Step 2a): `departments` (array) creates one LINKED COPY per
  // department, sharing a group_id; the legacy single `department` still
  // works. De-duplicated, order kept; every name must be a real department.
  var depts = escRequestedDepts_(req);
  var known = getAllDepartments_();
  depts.forEach(function (d) {
    if (known.indexOf(d) === -1) throw new Error('Unknown department: ' + d);
  });
  var reason = escClean_(req.reason);
  if (!reason) throw new Error('Reason for escalation is required.');

  var groupId = depts.length > 1 ? Utilities.getUuid() : null;
  var base = {
    occurredAt:  escCleanDateTime_(req.occurredAt),
    caller:      escClean_(req.caller),
    patientName: escClean_(req.patientName),
    trx:         escClean_(req.trx),
    area:        escClean_(req.area),
    reason:      reason,
    createdBy:   (Session.getActiveUser().getEmail() || '').toLowerCase(),
  };
  var recs = depts.map(function (d) {
    var r = { id: Utilities.getUuid(), department: d, groupId: groupId };
    for (var k in base) r[k] = base[k];
    return r;
  });
  var rec = recs[0];

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  try {
    escEnsureTableOnce_(conn);            // DDL auto-commits before the txn opens
    conn.setAutoCommit(false); txn = true;
    // NULLIF(?, '') so a blank optional field stores NULL without needing
    // JDBC setObject(null) (unreliable in Apps Script) and without binding
    // '' to a timestamptz (which errors). reason is required (non-empty).
    // ESC-L1: every copy + its 'created' trail row in ONE transaction, so a
    // failure leaves no half-linked group.
    recs.forEach(function (r) {
      var stmt = conn.prepareStatement(
        'INSERT INTO escalations (id, department, occurred_at, caller, patient_name, trx, area, reason, '
        + "status, created_by, source, group_id) VALUES (?, ?, NULLIF(?, '')::timestamptz, NULLIF(?, ''), "
        + "NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, ?, NULLIF(?, ''))");
      stmt.setString(1, r.id);
      stmt.setString(2, r.department);
      stmt.setString(3, r.occurredAt);
      stmt.setString(4, r.caller);
      stmt.setString(5, r.patientName);
      stmt.setString(6, r.trx);
      stmt.setString(7, r.area);
      stmt.setString(8, r.reason);
      stmt.setString(9, ESC_STATUS_PENDING);
      stmt.setString(10, r.createdBy);
      stmt.setString(11, 'manual');
      stmt.setString(12, r.groupId || '');
      stmt.execute();
      stmt.close();
      escAppendActivity_(conn, r.id, 'created', r.createdBy, r.reason);
    });
    conn.commit();
    Logger.log('createEscalation: %s logged escalation %s for %s', rec.createdBy, rec.id, escDeptListLabel_(recs, groupId));
    escSnapshotAfterWrite_(conn);   // PCR-8
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
  if (recs.length > 1) escNotifyLinkedGroup_(recs);
  else escNotifyNewEscalation_(rec);
  return { id: rec.id, ids: recs.map(function (r) { return r.id; }), groupId: groupId };
}

/** ESC-L1 (PURE): the request's department list -- `departments` (array)
 *  or the legacy single `department`; trimmed, de-duplicated, order kept.
 *  Throws when none is given. */
function escRequestedDepts_(req) {
  var raw = Array.isArray(req && req.departments) ? req.departments : [req && req.department];
  var out = [];
  raw.forEach(function (d) {
    d = String(d == null ? '' : d).trim();
    if (d && out.indexOf(d) === -1) out.push(d);
  });
  if (!out.length) throw new Error('Pick at least one department.');
  return out;
}

/** ESC-L1 (PURE): "CSR + Sales (linked group <id>)" for the create log line. */
function escDeptListLabel_(recs, groupId) {
  return recs.map(function (r) { return r.department; }).join(' + ')
    + (groupId ? ' (linked group ' + groupId + ')' : '');
}

/**
 * Admin-only correction of a PENDING escalation's fields (patient / caller /
 * Trx / area / reason / time). Writes ONLY those data columns; never touches
 * status, resolution, resolved_* -- or the DEPARTMENT: ESC-R1 moved that to
 * moveEscalation, so a department change is always its own recorded
 * `reassigned` action (req.department is ignored here). Resolved rows are out
 * of scope (pending-only). Appends an 'edited' activity row atomically (§5).
 * Returns { id }.
 */
function updateEscalation(req) {
  assertAdmin_();
  req = req || {};
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
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

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  try {
    escEnsureTableOnce_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    escAssertNotRemoved_(meta);        // ESC-L2
    if (meta.status !== ESC_STATUS_PENDING) {
      throw new Error('Only a pending escalation can be edited.');
    }
    // ESC-D3 (broad-scan 2026-10-01): the edit lands on EVERY copy, so the
    // pending-only guard must hold for every copy too -- it checked only the
    // clicked one, and editing a pending sibling rewrote a copy another
    // department had already started or resolved. Removed copies are exempt:
    // they are read-only history that the owner ruled the edit still reaches.
    if (meta.groupId) {
      var notPending = escGroupNotPendingDepts_(conn, meta.groupId, id);
      if (notPending.length) {
        throw new Error('Only a pending escalation can be edited, and a linked copy is no longer pending: '
          + notPending.join(', ') + '. The edit would rewrite that copy too.');
      }
    }
    // ESC-L2 (owner decision 2): the shared fields are ONE record across a
    // linked group, so an edit lands on EVERY copy (removed ones included --
    // they are part of the thread) in the same statement. Each copy keeps its
    // own status / resolution / comments. One 'edited' entry, on the edited
    // copy: the shared thread shows it to every department once.
    var linkedN = meta.groupId ? escGroupSize_(conn, meta.groupId) : 1;
    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement(
      'UPDATE escalations SET occurred_at = NULLIF(?, \'\')::timestamptz, '
      + "caller = NULLIF(?, ''), patient_name = NULLIF(?, ''), trx = NULLIF(?, ''), "
      + "area = NULLIF(?, ''), reason = ?, updated_at = now() WHERE "
      + (meta.groupId ? 'group_id = ?' : 'id = ?'));
    stmt.setString(1, fields.occurredAt);
    stmt.setString(2, fields.caller);
    stmt.setString(3, fields.patientName);
    stmt.setString(4, fields.trx);
    stmt.setString(5, fields.area);
    stmt.setString(6, reason);
    stmt.setString(7, meta.groupId || id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'edited', actor, 'Edited escalation fields'
      + (linkedN > 1 ? ' (applied to all ' + linkedN + ' linked copies)' : ''));
    conn.commit();
    Logger.log('updateEscalation: %s edited %s (%s)', actor, id, meta.department);
    escSnapshotAfterWrite_(conn);   // PCR-8
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
 * ESC-R1 (owner ruling 2026-09-30): MOVES an escalation to another
 * department. ADMIN-ONLY (`assertAdmin_`) -- managers cannot reassign, so it
 * is an admin SURFACE and the all-departments manager is refused too.
 *
 * Allowed on PENDING and IN-PROGRESS rows (the open worklist). A resolved or
 * rejected row must be reopened first (so the move lands on live work), and
 * a pending_review submission goes through approve/reject. The status is
 * kept: an in-progress escalation stays in progress in its new department.
 *
 * The row's department changes, so access follows it at once: the old
 * dept's managers lose the row (escAssertRowAccess_ reads the stored dept),
 * the new dept's gain it with the whole activity trail. A 'reassigned'
 * activity row "<from> -> <to>" (+ the optional note) records who moved it,
 * atomically with the move (§5). After the lock is released the new dept's
 * managers get the new-escalation email, under the same
 * NOTIFY_ON_NEW_ESCALATION flag and ALL_DEPT_NOTIFY_OPT_IN rule (EML-1).
 * Returns { id, from, to }.
 */
function moveEscalation(req) {
  assertAdmin_();
  req = req || {};
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var to = String(req.department || '').trim();
  if (getAllDepartments_().indexOf(to) === -1) throw new Error('Unknown department: ' + to);
  var note = escClean_(req.note);
  var actor = (Session.getActiveUser().getEmail() || '').toLowerCase();

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  var notifyRec = null;
  var from = null;
  try {
    escEnsureTableOnce_(conn);
    var row = escRowFull_(conn, id);
    if (!row) throw new Error('Escalation not found.');
    from = row.department;
    escAssertNotRemoved_(row);         // ESC-L2
    if (row.status === ESC_STATUS_PENDING_REVIEW) {
      throw new Error('This escalation is still awaiting review — approve or reject it first.');
    }
    if (row.status !== ESC_STATUS_PENDING && row.status !== ESC_STATUS_IN_PROGRESS) {
      throw new Error('Only a pending or in-progress escalation can be moved (this one is "'
        + row.status + '") — reopen it first.');
    }
    if (from === to) throw new Error('This escalation is already assigned to ' + to + '.');
    // ESC-L1: a linked group holds at most one copy per department.
    var heldM = row.groupId ? escGroupHasDept_(conn, row.groupId, to, id) : null;
    if (heldM) {
      throw new Error(heldM === ESC_STATUS_REMOVED
        ? to + ' was removed from this escalation — use Restore on its card instead.'   // ESC-L3
        : to + ' already has a linked copy of this escalation.');
    }
    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement('UPDATE escalations SET department = ?, updated_at = now() WHERE id = ?');
    stmt.setString(1, to);
    stmt.setString(2, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'reassigned', actor, from + ' \u2192 ' + to + (note ? ': ' + note : ''));
    conn.commit();
    Logger.log('moveEscalation: %s moved %s from %s to %s', actor, id, from, to);
    escSnapshotAfterWrite_(conn);   // PCR-8
    notifyRec = { id: id, department: to, occurredAt: row.occurredAt || '', caller: row.caller,
                  patientName: row.patientName, trx: row.trx, area: row.area, reason: row.reason };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('moveEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not move the escalation.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
  // Fire-and-log AFTER the commit + lock release (the create/approve rule).
  if (notifyRec) escNotifyNewEscalation_(notifyRec, { movedFrom: from });
  return { id: id, from: from, to: to };
}

/**
 * ESC-L2 (Step 2b): LINK ANOTHER DEPARTMENT to an escalation. ADMIN-ONLY
 * (the ESC-R1 rule: managers never reassign). Adds a new PENDING copy for
 * `department` carrying the source's shared fields (copied in SQL, so the
 * fields cannot drift in transit) and the source's group_id -- minting one,
 * and stamping it on the source, when the source was standalone. The source
 * must be in the worklist or resolved (pending / in_progress / resolved);
 * awaiting-review, rejected and removed copies cannot seed a link. A
 * department already holding a copy (removed included) is refused. The new
 * copy's 'linked' trail row names who added it and why; its managers get the
 * new-escalation email (NOTIFY_ON_NEW_ESCALATION, EML-1 rule), naming the
 * other departments. Returns { id, newId, groupId }.
 */
function linkEscalationDepartment(req) {
  assertAdmin_();
  req = req || {};
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var to = String(req.department || '').trim();
  if (getAllDepartments_().indexOf(to) === -1) throw new Error('Unknown department: ' + to);
  var note = escClean_(req.note);
  var actor = (Session.getActiveUser().getEmail() || '').toLowerCase();

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  var notifyRec = null, others = [];
  var newId = Utilities.getUuid(), groupId = null;
  try {
    escEnsureTableOnce_(conn);
    var row = escRowFull_(conn, id);
    if (!row) throw new Error('Escalation not found.');
    escAssertNotRemoved_(row);
    if ([ESC_STATUS_PENDING, ESC_STATUS_IN_PROGRESS, ESC_STATUS_RESOLVED].indexOf(row.status) === -1) {
      throw new Error(row.status === ESC_STATUS_PENDING_REVIEW
        ? 'This escalation is still awaiting review — approve or reject it first.'
        : 'Only a pending, in-progress or resolved escalation can be shared with another department (this one is "'
          + row.status + '").');
    }
    if (row.department === to) throw new Error('This escalation is already assigned to ' + to + '.');
    groupId = row.groupId || Utilities.getUuid();
    var held = row.groupId ? escGroupHasDept_(conn, row.groupId, to, id) : null;
    if (held) {
      // ESC-L3: a department that was REMOVED comes back through Restore, so
      // its earlier comments and the removal stay on the same copy.
      throw new Error(held === ESC_STATUS_REMOVED
        ? to + ' was removed from this escalation — use Restore on its card instead.'
        : to + ' already has a linked copy of this escalation.');
    }
    others = row.groupId ? escGroupDepts_(conn, row.groupId) : [row.department];
    conn.setAutoCommit(false); txn = true;
    if (!row.groupId) {
      var g = conn.prepareStatement('UPDATE escalations SET group_id = ?, updated_at = now() WHERE id = ?');
      g.setString(1, groupId); g.setString(2, id); g.execute(); g.close();
    }
    var ins = conn.prepareStatement(
      'INSERT INTO escalations (id, department, occurred_at, caller, patient_name, trx, area, reason, '
      + 'status, created_by, source, group_id) '
      + 'SELECT ?, ?, occurred_at, caller, patient_name, trx, area, reason, ?, ?, ?, ? FROM escalations WHERE id = ?');
    ins.setString(1, newId);
    ins.setString(2, to);
    ins.setString(3, ESC_STATUS_PENDING);
    ins.setString(4, actor);
    ins.setString(5, 'manual');
    ins.setString(6, groupId);
    ins.setString(7, id);
    ins.execute();
    ins.close();
    escAppendActivity_(conn, newId, 'linked', actor,
      to + ' added to this escalation (linked from ' + row.department + ')' + (note ? ': ' + note : ''));
    conn.commit();
    Logger.log('linkEscalationDepartment: %s linked %s to %s as %s (group %s)', actor, id, to, newId, groupId);
    escSnapshotAfterWrite_(conn);   // PCR-8
    notifyRec = { id: newId, department: to, occurredAt: row.occurredAt || '', caller: row.caller,
                  patientName: row.patientName, trx: row.trx, area: row.area, reason: row.reason };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('linkEscalationDepartment failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not link the department.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
  if (notifyRec) escNotifyNewEscalation_(notifyRec, { alsoDepts: others });
  return { id: id, newId: newId, groupId: groupId };
}

/**
 * ESC-L3 (2026-09-30): RESTORE a department that was removed from a linked
 * escalation -- the undo of removeEscalationDepartment (a dispute reversed,
 * or a removal made in error). ADMIN-ONLY. The copy returns to the status it
 * had when it was removed (status_before_removal; 'pending' when unknown),
 * so a resolved copy comes back resolved and an open one re-enters its
 * department's worklist. The removal record is cleared from the row but
 * stays in the shared thread, and the restore is its own 'restored' thread
 * entry (an optional note). Only a REMOVED copy can be restored. When it
 * comes back OPEN, its managers get the escalation email again
 * (NOTIFY_ON_NEW_ESCALATION, the EML-1 rule). Returns { id, department, status }.
 */
function restoreEscalationDepartment(req) {
  assertAdmin_();
  req = req || {};
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var note = escClean_(req.note);
  var actor = (Session.getActiveUser().getEmail() || '').toLowerCase();

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  var notifyRec = null, others = [], dept = null, back = null;
  try {
    escEnsureTableOnce_(conn);
    var row = escRowFull_(conn, id);
    if (!row) throw new Error('Escalation not found.');
    dept = row.department;
    if (row.status !== ESC_STATUS_REMOVED) throw new Error(dept + ' is not removed from this escalation — nothing to restore.');
    back = escRestoreStatus_(row.statusBeforeRemoval);
    others = row.groupId ? escGroupDepts_(conn, row.groupId) : [];
    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement(
      'UPDATE escalations SET status = ?, removed_by = NULL, removed_at = NULL, removed_reason = NULL, '
      + 'status_before_removal = NULL, updated_at = now() WHERE id = ?');
    stmt.setString(1, back);
    stmt.setString(2, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'restored', actor,
      dept + ' restored to this escalation (back to ' + back.replace('_', ' ') + ')' + (note ? ': ' + note : ''));
    conn.commit();
    Logger.log('restoreEscalationDepartment: %s restored %s to %s as %s', actor, dept, row.groupId || '(standalone)', back);
    escSnapshotAfterWrite_(conn);   // PCR-8
    if (back === ESC_STATUS_PENDING || back === ESC_STATUS_IN_PROGRESS) {
      notifyRec = { id: id, department: dept, occurredAt: row.occurredAt || '', caller: row.caller,
                    patientName: row.patientName, trx: row.trx, area: row.area, reason: row.reason };
    }
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('restoreEscalationDepartment failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not restore the department.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae) {}
    try { conn.close(); } catch (ce) {}
    lock.releaseLock();
  }
  if (notifyRec) escNotifyNewEscalation_(notifyRec, { restored: true, alsoDepts: others });
  return { id: id, department: dept, status: back };
}

/** ESC-L3 (PURE): the status a restored copy returns to -- the recorded one
 *  when it is a real worklist/closed state, else 'pending'. */
function escRestoreStatus_(before) {
  var ok = [ESC_STATUS_PENDING, ESC_STATUS_IN_PROGRESS, ESC_STATUS_RESOLVED];
  return ok.indexOf(String(before || '')) !== -1 ? String(before) : ESC_STATUS_PENDING;
}

/**
 * ESC-L2 (Step 2b, owner decision (b) 2026-09-30): REMOVE a department from a
 * linked escalation. ADMIN-ONLY. NOT a delete -- a removal covers disputes
 * ("this is not ours", upheld by the admin) as much as mis-assignment, so
 * the copy is kept with status 'removed' + removed_by / removed_at /
 * removed_reason, its comments and updates STAY in the shared thread (tagged
 * as that department, marked removed), and the REQUIRED reason is itself a
 * 'removed' thread entry. The removed department's managers can still open
 * it read-only (the Removed filter) to see the outcome; it leaves their open
 * worklist and counts. Refused for a standalone escalation (delete or
 * resolve it instead) and for the LAST active copy of a group -- an
 * escalation always has at least one department working it. Returns
 * { id, department }.
 */
function removeEscalationDepartment(req) {
  assertAdmin_();
  req = req || {};
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var reason = escClean_(req.reason);
  if (!reason) throw new Error('A reason for removing this department is required (it goes into the thread).');
  var actor = (Session.getActiveUser().getEmail() || '').toLowerCase();

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  var dept = null;
  try {
    escEnsureTableOnce_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    dept = meta.department;
    if (meta.status === ESC_STATUS_REMOVED) throw new Error(dept + ' was already removed from this escalation.');
    if (!meta.groupId) {
      throw new Error('This escalation is assigned to one department only — resolve it, move it, or delete it instead.');
    }
    if (escGroupActiveOthers_(conn, meta.groupId, id) < 1) {
      throw new Error(dept + ' is the last department still on this escalation — link another department first, '
        + 'or resolve or delete it.');
    }
    conn.setAutoCommit(false); txn = true;
    var stmt = conn.prepareStatement(
      'UPDATE escalations SET status = ?, removed_by = ?, removed_at = now(), removed_reason = ?, '
      + 'status_before_removal = ?, updated_at = now() WHERE id = ?');
    stmt.setString(1, ESC_STATUS_REMOVED);
    stmt.setString(2, actor);
    stmt.setString(3, reason);
    stmt.setString(4, meta.status);   // ESC-L3: what a restore returns it to
    stmt.setString(5, id);
    stmt.execute();
    stmt.close();
    escAppendActivity_(conn, id, 'removed', actor, dept + ' removed from this escalation (was ' + meta.status + '): ' + reason);
    conn.commit();
    Logger.log('removeEscalationDepartment: %s removed %s from group %s (%s)', actor, dept, meta.groupId, id);
    escSnapshotAfterWrite_(conn);   // PCR-8
    return { id: id, department: dept };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('removeEscalationDepartment failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not remove the department.');
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
  assertManagerOrAdmin_(user);   // AC-3: allowlist, never a bare role-none check
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var resolution = escClean_(req.resolution);
  if (!resolution) throw new Error('A resolution note (what action was taken) is required to mark this resolved.');
  var comments = escClean_(req.comments);

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  try {
    escEnsureTableOnce_(conn);
    // Authorize against the row's OWN department (never trust a dept from req).
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    var dept = meta.department;
    escAssertRowAccess_(user, dept);   // F-45: row dept = data, not input
    escAssertNotRemoved_(meta);        // ESC-L2
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
    escSnapshotAfterWrite_(conn);   // PCR-8
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
  assertManagerOrAdmin_(user);   // AC-3: allowlist, never a bare role-none check
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var reason = escClean_(req.reason);
  if (!reason) throw new Error('A reason for reopening is required.');

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  try {
    escEnsureTableOnce_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    escAssertRowAccess_(user, meta.department);   // F-45: row dept = data, not input
    escAssertNotRemoved_(meta);        // ESC-L2
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
    escSnapshotAfterWrite_(conn);   // PCR-8
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
  assertManagerOrAdmin_(user);   // AC-3: allowlist, never a bare role-none check
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var note = escClean_(req.note);

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  try {
    escEnsureTableOnce_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    escAssertRowAccess_(user, meta.department);   // F-45: row dept = data, not input
    escAssertNotRemoved_(meta);        // ESC-L2
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
    escSnapshotAfterWrite_(conn);   // PCR-8
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
  assertManagerOrAdmin_(user);   // AC-3: allowlist, never a bare role-none check
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  var notifyRec = null;   // §1: populated on success, fired after the lock releases
  try {
    escEnsureTableOnce_(conn);
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
    escSnapshotAfterWrite_(conn);   // PCR-8
    // §1: an approved pending_review is a NEW escalation ENTERING the dept
    // worklist -- the event managers care about once Phase 2's external
    // inflow exists (it arrives as pending_review, not createEscalation --
    // H3: no writer yet, so today this fires only for hand-inserted rows).
    // Capture the notify
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
  assertManagerOrAdmin_(user);   // AC-3: allowlist, never a bare role-none check
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var reason = escClean_(req.reason);
  if (!reason) throw new Error('A reason for rejecting is required.');

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  try {
    escEnsureTableOnce_(conn);
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
    escSnapshotAfterWrite_(conn);   // PCR-8
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
  assertManagerOrAdmin_(user);   // AC-3: allowlist, never a bare role-none check
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');
  var comments = escClean_(req.comments);
  // NEO-2: an empty comment used to silently NULL the row's existing
  // comment (a destructive no-op from a stale UI). Clearing a comment is
  // not a supported operation -- the activity trail is append-only.
  if (!comments) throw new Error('A comment is required.');

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  try {
    escEnsureTableOnce_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) throw new Error('Escalation not found.');
    var dept = meta.department;
    escAssertRowAccess_(user, dept);   // F-45: row dept = data, not input
    escAssertNotRemoved_(meta);        // ESC-L2: read-only once removed
    // NEO-2: comments are for rows IN the worklist (pending or resolved).
    // A pending_review row is immutable external input until the approve/
    // reject trust boundary runs (the external INSERT contract); a
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
    escSnapshotAfterWrite_(conn);   // PCR-8
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
 * Roadmap 2a (owner ask, 2026-09-11): an ADMIN permanently deletes an
 * escalation that was logged by mistake or for testing.
 *
 * ADMIN-ONLY (`assertAdmin_`): a delete is an admin SURFACE, not data
 * breadth, so the all-departments manager cannot reach it either (the
 * role-model rule in CLAUDE.md). HARD delete of the row AND its
 * escalation_activity trail in ONE transaction -- a soft delete would add a
 * predicate to six readers, the badge, the outage snapshot and the digests to
 * preserve rows that by definition have no value. Idempotent: an unknown id
 * returns { deleted: 0 } rather than throwing, so a double click or a stale
 * card is harmless. The audit that SURVIVES the deletion is a Report Usage
 * row ('escalations:delete', the INV-01 append-only carve-out -- report code +
 * department only, never the id or any caller / patient / trx field: PHI stays
 * out of the usage sheet) plus a Logger line naming the id and prior status.
 * The E2 outage snapshot is refreshed (forced) after the commit so a
 * Neon-down read cannot resurrect the row; the client's escLoad_ then reloads
 * the list and the badge (the F10 rule).
 */
function deleteEscalation(req) {
  assertAdmin_();
  var user = resolveUser_(Session.getActiveUser().getEmail());
  req = req || {};
  var id = String(req.id || '').trim();
  if (!id) throw new Error('Missing escalation id.');

  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 15000);
  var txn = false;
  try {
    escEnsureTableOnce_(conn);
    var meta = escRowMeta_(conn, id);
    if (!meta) {
      Logger.log('deleteEscalation: %s -- no row with id %s; nothing deleted', user.email, id);
      return { id: id, deleted: 0 };
    }
    // ESC-L2 (owner decision 4): the DEFAULT deletes this one copy (the
    // rest of a linked group stays, still linked to each other);
    // `allLinked: true` deletes EVERY copy of the group + their trails, in
    // the same single transaction.
    var all = !!req.allLinked && !!meta.groupId;
    // ESC-D4 (broad-scan 2026-10-01): deleting the LAST active copy of a group
    // that still holds REMOVED copies would leave a group with no active copy
    // -- the state Remove's own last-active guard exists to prevent. Refuse
    // and point at "delete all linked copies". (A removed copy, or a copy with
    // an active sibling, deletes alone as before.)
    if (!all && meta.groupId && meta.status !== ESC_STATUS_REMOVED
        && escGroupActiveOthers_(conn, meta.groupId, id) === 0
        && escGroupSize_(conn, meta.groupId) > 1) {
      throw new Error('This is the last active copy of a linked escalation; the other copies were removed. '
        + 'Delete all linked copies instead.');
    }
    // ESC-D4: the audit names EVERY deleted copy's department -- removed ones
    // included (the not-removed list undercounted a delete-all).
    var depts = all ? escGroupDepts_(conn, meta.groupId, /*includeRemoved=*/true) : [meta.department];
    if (all && depts.indexOf(meta.department) === -1) depts.push(meta.department);   // belt and braces
    var n = all ? escGroupSize_(conn, meta.groupId) : 1;
    conn.setAutoCommit(false); txn = true;
    var a = conn.prepareStatement(all
      ? 'DELETE FROM escalation_activity WHERE escalation_id IN (SELECT id FROM escalations WHERE group_id = ?)'
      : 'DELETE FROM escalation_activity WHERE escalation_id = ?');
    a.setString(1, all ? meta.groupId : id); a.execute(); a.close();
    var d = conn.prepareStatement(all ? 'DELETE FROM escalations WHERE group_id = ?' : 'DELETE FROM escalations WHERE id = ?');
    d.setString(1, all ? meta.groupId : id); d.execute(); d.close();
    conn.commit();
    txn = false;
    try { conn.setAutoCommit(true); } catch (ae) {}
    Logger.log('deleteEscalation: %s deleted %s (%s, was %s) with its activity trail%s',
      user.email, id, meta.department, meta.status, all ? (' + every linked copy (' + n + ', group ' + meta.groupId + ')') : '');
    try { logReportUsage_('escalations:delete', depts.join(' + '), user, false); } catch (eu) {}
    try { escSnapshotMaybeRefresh_(conn, /*force=*/true); } catch (eSnap) { /* best-effort */ }
    return { id: id, deleted: n, allLinked: all };
  } catch (e) {
    if (txn) { try { conn.rollback(); } catch (rb) {} }
    Logger.log('deleteEscalation failed: ' + (e && e.message ? e.message : e));
    throw new Error(e && e.message ? e.message : 'Could not delete the escalation.');
  } finally {
    try { if (txn) conn.setAutoCommit(true); } catch (ae2) {}
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
  var conn = escOpenWriteConn_();                 // ESC-D2: connect + schema BEFORE the lock
  var lock = escTakeWriteLock_(conn, 30000);
  var txn = false;
  try {
    escEnsureTableOnce_(conn);
    conn.setAutoCommit(false); txn = true;
    // 'created' seed for any escalation with NO activity at all.
    var s1 = conn.createStatement();
    var created = s1.executeUpdate(
      "INSERT INTO escalation_activity (id, escalation_id, action, actor, at, detail, department) "
      + "SELECT md5(random()::text || e.id || 'c'), e.id, 'created', e.created_by, "
      + "COALESCE(e.created_at, now()), e.reason, e.department "
      + "FROM escalations e "
      + "WHERE NOT EXISTS (SELECT 1 FROM escalation_activity a WHERE a.escalation_id = e.id)");
    s1.close();
    // 'resolved' seed for resolved escalations missing one.
    var s2 = conn.createStatement();
    var resolved = s2.executeUpdate(
      "INSERT INTO escalation_activity (id, escalation_id, action, actor, at, detail, department) "
      + "SELECT md5(random()::text || e.id || 'r'), e.id, 'resolved', e.resolved_by, "
      + "COALESCE(e.resolved_at, now()), e.resolution, e.department "
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
  // Phase A (agent role): allowlist, mirroring assertDeptAccess_ -- the
  // manager-pinning branch below only fires for role==='manager', so an
  // unrecognized role would otherwise pass this row gate UNPINNED.
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    throw new Error('Not authorized.');
  }
  // R8-4 (the R-3 class): an ALL-departments manager (allDepts:true,
  // department:null) is a DATA-BREADTH role and passes like an admin --
  // this row gate is data breadth, not an admin surface. Without the
  // branch, `rowDept !== null` threw on EVERY row: all six worklist verbs
  // failed and getEscalationActivity's not-found shape rendered every
  // activity timeline silently blank for the role.
  // Tier C: a manager may hold MORE THAN ONE dept -- accept a row in any of
  // them. `departments` is a one-element list for single-dept managers, so
  // this is byte-equivalent to the old `rowDept !== user.department` check.
  if (user.role === 'manager' && !user.allDepts) {
    var mine = (user.departments && user.departments.length) ? user.departments : [user.department];
    if (mine.indexOf(rowDept) === -1) throw new Error('Not authorized for this department.');
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
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(String(dept || '').length + 8, 'escalations');   // OD-3
  return dept;
}

/** Reads { status, department, groupId } for an escalation; null if absent.
 *  Every caller runs escEnsureTable_ first, so group_id always exists. */
function escRowMeta_(conn, id) {
  var stmt = conn.prepareStatement('SELECT status, department, group_id FROM escalations WHERE id = ?');
  stmt.setString(1, id);
  var rs = stmt.executeQuery();
  var out = rs.next() ? { status: rs.getString('status'), department: rs.getString('department'),
                          groupId: rs.getString('group_id') || null } : null;   // ESC-L2
  rs.close(); stmt.close();
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(out ? JSON.stringify(out).length : 8, 'escalations');   // OD-3
  return out;
}

/** ESC-L2: how many copies (any status) a linked group holds. */
function escGroupSize_(conn, groupId) {
  var stmt = conn.prepareStatement('SELECT count(*) AS n FROM escalations WHERE group_id = ?');
  stmt.setString(1, groupId);
  var rs = stmt.executeQuery();
  var n = rs.next() ? (Number(rs.getString('n')) || 0) : 0;
  rs.close(); stmt.close();
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(8, 'escalations');   // OD-3
  return n;
}

/** ESC-L2: copies OTHER than `exceptId` in the group that are not removed. */
function escGroupActiveOthers_(conn, groupId, exceptId) {
  var stmt = conn.prepareStatement(
    "SELECT count(*) AS n FROM escalations WHERE group_id = ? AND id <> ? AND status <> 'removed'");
  stmt.setString(1, groupId);
  stmt.setString(2, exceptId);
  var rs = stmt.executeQuery();
  var n = rs.next() ? (Number(rs.getString('n')) || 0) : 0;
  rs.close(); stmt.close();
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(8, 'escalations');   // OD-3
  return n;
}

/** ESC-L2: the departments of a group's NOT-removed copies, sorted.
 *  ESC-D4: `includeRemoved` lists EVERY copy's dept (the delete-all audit). */
function escGroupDepts_(conn, groupId, includeRemoved) {
  var stmt = conn.prepareStatement(
    "SELECT department FROM escalations WHERE group_id = ?"
    + (includeRemoved ? '' : " AND status <> 'removed'") + ' ORDER BY department');
  stmt.setString(1, groupId);
  var rs = stmt.executeQuery();
  var out = [];
  while (rs.next()) out.push(String(rs.getString('department') || ''));
  rs.close(); stmt.close();
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(JSON.stringify(out).length, 'escalations');   // OD-3
  return out;
}

/** ESC-D3: the OTHER copies of a group that are neither pending nor removed,
 *  as "Dept (status)" labels -- the copies a shared-field edit must not rewrite. */
function escGroupNotPendingDepts_(conn, groupId, exceptId) {
  var stmt = conn.prepareStatement(
    "SELECT department, status FROM escalations WHERE group_id = ? AND id <> ? "
    + "AND status NOT IN ('pending', 'removed') ORDER BY department");
  stmt.setString(1, groupId);
  stmt.setString(2, exceptId);
  var rs = stmt.executeQuery();
  var out = [];
  while (rs.next()) out.push(String(rs.getString('department') || '') + ' (' + String(rs.getString('status') || '') + ')');
  rs.close(); stmt.close();
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(JSON.stringify(out).length, 'escalations');   // OD-3
  return out;
}

/** ESC-L2: a REMOVED copy is read-only -- every write verb refuses it.
 *  ESC-G1: escalations-hardening.test.js fails when a public verb that
 *  commits a write neither calls this nor is a named, reasoned exemption. */
function escAssertNotRemoved_(meta) {
  if (meta && meta.status === ESC_STATUS_REMOVED) {
    throw new Error((meta.department || 'This department') + ' was removed from this escalation; '
      + 'it stays in the thread read-only.');
  }
}

/** ESC-L1: does another copy in `groupId` already sit in `dept`? Returns
 *  that copy's STATUS (truthy -- ESC-L3 tells a removed one apart) or null. */
function escGroupHasDept_(conn, groupId, dept, exceptId) {
  var stmt = conn.prepareStatement('SELECT status FROM escalations WHERE group_id = ? AND department = ? AND id <> ? LIMIT 1');
  stmt.setString(1, groupId);
  stmt.setString(2, dept);
  stmt.setString(3, exceptId);
  var rs = stmt.executeQuery();
  var hit = rs.next() ? (rs.getString('status') || 'unknown') : null;
  rs.close(); stmt.close();
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(8, 'escalations');   // OD-3
  return hit;
}

/** Reads the review-relevant columns of one escalation; null if absent. */
function escRowFull_(conn, id) {
  var stmt = conn.prepareStatement(
    // A-2: occurred_at was missing, so the approve-path notification email
    // (escNotifyNewEscalation_ builds its rec from THIS row) silently
    // dropped its "When" line on every approved submission.
    'SELECT status, department, caller, patient_name, trx, area, reason, source, '
    + 'occurred_at::text AS occurred_at, group_id, status_before_removal '
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
      groupId:     rs.getString('group_id') || null,   // ESC-L1
      statusBeforeRemoval: rs.getString('status_before_removal') || null,   // ESC-L3
    };
  }
  rs.close(); stmt.close();
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(row ? JSON.stringify(row).length : 8, 'escalations');   // OD-3
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

/**
 * Appends one immutable row to the append-only activity trail (§5). MUST be
 * called inside an open transaction (the caller commits) so the activity row
 * lands atomically with its primary write. No commit here.
 *
 * ESC-D1 (broad-scan 2026-10-01): the row records the copy's department AT
 * WRITE TIME (read in the same statement, inside the caller's transaction).
 * The thread used to tag every entry with the copy's CURRENT department, so
 * after a Move every earlier comment, start and resolve by CSR read as written
 * by the new department -- in exactly the dispute workflow Move exists for. A
 * `reassigned` entry is written after the UPDATE, so it carries the new dept
 * (its detail names both).
 */
function escAppendActivity_(conn, escId, action, actor, detail) {
  var stmt = conn.prepareStatement(
    'INSERT INTO escalation_activity (id, escalation_id, action, actor, detail, department) '
    + "VALUES (?, ?, ?, ?, NULLIF(?, ''), (SELECT department FROM escalations WHERE id = ?))");
  stmt.setString(1, Utilities.getUuid());
  stmt.setString(2, escId);
  stmt.setString(3, action);
  stmt.setString(4, (actor || '').toLowerCase());
  stmt.setString(5, escClean_(detail || ''));
  stmt.setString(6, escId);
  stmt.execute();
  stmt.close();
}

/**
 * §1 best-effort new-escalation notification. Flag-gated OFF by default via
 * the `NOTIFY_ON_NEW_ESCALATION` Script Property. NEVER throws (mirrors
 * notifyDigestFailure_): any failure is swallowed + logged so it can't break
 * the create. Recipients are the dept's managers via the shared Digest
 * resolver `lookupDeptManagers_` (Access Control rows) -- no new address book.
 * ALL/'*' managers are included only when opted in via ALL_DEPT_NOTIFY_OPT_IN (EML-1).
 * Carries full escalation detail (operator decision): this is a PII surface,
 * which is why it stays off until explicitly enabled.
 */
/**
 * Gap #3: count-only admin ping for NEW `pending_review` submissions.
 * The designed external writer INSERTs directly into Neon, so no dashboard
 * code would run at submission time -- the review queue is pull-only, and with
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
 *
 * H3 (2026-09): no external writer exists yet (see the contract block), so
 * the flag has nothing to wait on -- leave `NOTIFY_PENDING_REVIEW` unset
 * until a writer ships; enabled early it only ever baselines.
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
      if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(maxts.length + depts.length + 8, 'escalations');   // OD-3
      if (!n) return;
      var to = getAdminEmails_().join(',');
      if (!to) return;   // no recipients -- leave the watermark; retry later
      var url = props.getProperty('DASHBOARD_URL') || '';
      sendAppEmail_({
        to: to,
        subject: '[Dashboard] ' + n + ' escalation submission' + (n === 1 ? '' : 's') + ' awaiting review',
        notice: {
          tone: 'neutral', kicker: 'Admin notice · Escalations',
          title: n + ' escalation submission' + (n === 1 ? '' : 's') + ' awaiting review',
          subtitle: 'Externally submitted · count only, no call or patient detail',
          tiles: [{ label: 'Awaiting review', value: String(n) },
                  { label: 'Department' + (depts.indexOf(',') !== -1 ? 's' : ''), value: depts || 'unknown' }],
          callout: { kicker: 'Where', html: 'Escalations → the <strong>awaiting review</strong> chip. One email per new batch; '
            + 'enable NOTIFY_ON_NEW_ESCALATION for full-detail manager emails (a PII surface).', tone: 'neutral' },
          ctaUrl: appDashUrl_('#/escalations'), ctaLabel: 'Open Escalations',
          footerHtml: 'Sent by the pending-review ping (NOTIFY_PENDING_REVIEW).',
        },
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

function escNotifyNewEscalation_(rec, opts) {
  var movedFrom = (opts && opts.movedFrom) ? String(opts.movedFrom) : '';   // ESC-R1
  var alsoDepts = (opts && opts.alsoDepts) ? opts.alsoDepts : [];            // ESC-L2 link
  var restored = !!(opts && opts.restored);                                  // ESC-L3
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
    sendAppEmail_({
      to:       recipients.join(','),
      subject:  (restored ? 'Escalation returned to ' : movedFrom ? 'Escalation moved to ' : 'New escalation logged — ') + rec.department,
      htmlBody: escNotifyHtml_(rec, link, movedFrom, alsoDepts, restored),
    });
    Logger.log('escNotifyNewEscalation_: emailed %s for escalation %s (%s)', recipients.join(','), rec.id, rec.department);
  } catch (e) {
    Logger.log('escNotifyNewEscalation_ failed (non-blocking): ' + (e && e.message ? e.message : e));
  }
}

/**
 * ESC-L1 (Step 2a): the new-escalation email for a LINKED create. Same flag
 * and recipient rule as escNotifyNewEscalation_ (NOTIFY_ON_NEW_ESCALATION;
 * lookupDeptManagers_, ALL managers only when opted in -- EML-1), but ONE
 * email per manager across the group: a manager of two linked departments
 * gets one message naming both, and every message names the other linked
 * departments. Recipients with the same department set share a message.
 * Best-effort; never throws.
 */
function escNotifyLinkedGroup_(recs) {
  try {
    var props = PropertiesService.getScriptProperties();
    var enabled = String(props.getProperty('NOTIFY_ON_NEW_ESCALATION') || '').toLowerCase() === 'true';
    if (!enabled || !recs || !recs.length) return;
    var groups = escLinkedRecipientGroups_(recs.map(function (r) { return r.department; }),
      (typeof lookupDeptManagers_ === 'function') ? lookupDeptManagers_ : function () { return []; });
    if (!groups.length) {
      Logger.log('escNotifyLinkedGroup_: no managers mapped for %s; skipping.', recs.map(function (r) { return r.department; }).join(' + '));
      return;
    }
    var dashUrl = props.getProperty('DASHBOARD_URL') || '';
    var link = dashUrl ? (dashUrl + '#/escalations') : '';
    var all = recs.map(function (r) { return r.department; });
    groups.forEach(function (g) {
      var rec = {};
      for (var k in recs[0]) rec[k] = recs[0][k];
      rec.department = g.depts.join(' + ');
      var others = all.filter(function (d) { return g.depts.indexOf(d) === -1; });
      sendAppEmail_({
        to:       g.emails.join(','),
        subject:  'New escalation logged — ' + rec.department,
        htmlBody: escNotifyHtml_(rec, link, '', others),
      });
      Logger.log('escNotifyLinkedGroup_: emailed %s for %s (linked: %s)', g.emails.join(','), rec.department, all.join(' + '));
    });
  } catch (e) {
    Logger.log('escNotifyLinkedGroup_ failed (non-blocking): ' + (e && e.message ? e.message : e));
  }
}

/** ESC-L1 (PURE): depts + a dept->manager-emails resolver -> one entry per
 *  distinct department SET: [{ depts: [...], emails: [...] }] (a manager of
 *  two of the depts appears once, under both). Emails compared lowercase. */
function escLinkedRecipientGroups_(depts, managersOf) {
  var byEmail = {}, order = [];
  depts.forEach(function (d) {
    (managersOf(d) || []).forEach(function (e) {
      var k = String(e || '').trim().toLowerCase();
      if (!k) return;
      if (!byEmail[k]) { byEmail[k] = { email: String(e).trim(), depts: [] }; order.push(k); }
      if (byEmail[k].depts.indexOf(d) === -1) byEmail[k].depts.push(d);
    });
  });
  var groups = [], byKey = {};
  order.forEach(function (k) {
    var key = byEmail[k].depts.join('\u0001');
    if (!byKey[key]) { byKey[key] = { depts: byEmail[k].depts.slice(), emails: [] }; groups.push(byKey[key]); }
    byKey[key].emails.push(byEmail[k].email);
  });
  return groups;
}

/** Email-safe HTML for the new-escalation notification -- the EmailKit house
 * style since Round-16 (shell + a label/value detail card + the shell CTA). */
function escNotifyHtml_(rec, link, movedFrom, alsoDepts, restored) {
  var esc = ekEsc_;
  var C = EK_C_, sans = EK_SANS_;
  var row = function (label, val) {
    if (!val) return '';
    return '<tr>'
         +   '<td style="padding:6px 14px 6px 12px;color:' + C.mut + ';font:12px ' + sans + ';vertical-align:top;white-space:nowrap;border-top:1px solid ' + C.rowline + ';">' + esc(label) + '</td>'
         +   '<td style="padding:6px 12px 6px 0;color:' + C.ink + ';font:13px ' + sans + ';border-top:1px solid ' + C.rowline + ';">' + esc(val) + '</td>'
         + '</tr>';
  };
  return ekShellHtml_({
    band: { tone: 'neutral', glyph: '&#9873;' },   // R30: uniform banded header
    kicker: 'Call Data · Escalations',
    title: (restored ? 'Escalation returned to ' : movedFrom ? 'Escalation moved to ' : 'New escalation — ') + rec.department,
    subtitle: (restored ? 'Your department was removed from this escalation earlier and has now been restored to it.'
               : movedFrom ? ('An escalation was moved to your department from ' + movedFrom + '.')
                           : 'An escalation was just logged for your department.')
      + ((alsoDepts && alsoDepts.length) ? ' It is also assigned to ' + alsoDepts.join(', ')
          + ' — each department works its own copy.' : ''),
    preheader: 'New escalation for ' + rec.department + (rec.area ? ' · ' + rec.area : ''),
    rowsHtml: ekRow_(
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ' + C.line + ';border-radius:10px;border-collapse:separate;overflow:hidden;">'
      + row('When', rec.occurredAt)
      + row('Caller / relation', rec.caller)
      + row('Patient', rec.patientName)
      + row('Trx #', rec.trx)
      + row('Area', rec.area)
      + row('Reason', rec.reason)
      + '</table>', '18px 26px 6px'),
    ctaUrl: link || '',
    ctaLabel: 'Open the worklist',
    footerHtml: 'Sent because NOTIFY_ON_NEW_ESCALATION is enabled for your department. '
      + 'Manage escalations from the dashboard’s Escalations page.',
  });
}

/** Idempotent table creation (lazy, like inbound_calls). */
/**
 * ESC-DDL (reflect 207-211): one round trip -- the escalations table's live
 * columns and index names. { columns: [], indexes: [] }; an empty columns
 * list means the table does not exist yet. Read-only.
 */
function escSchemaRead_(conn) {
  var sql = "SELECT json_build_object("
    + "'cols', COALESCE((SELECT json_agg(column_name::text) FROM information_schema.columns "
    +   "WHERE table_schema = current_schema() AND table_name = 'escalations'), '[]'::json), "
    + "'idx', COALESCE((SELECT json_agg(indexname::text) FROM pg_indexes "
    +   "WHERE schemaname = current_schema() AND tablename = 'escalations'), '[]'::json), "
    // ESC-D1: escalation_activity's columns too.
    + "'acols', COALESCE((SELECT json_agg(column_name::text) FROM information_schema.columns "
    +   "WHERE table_schema = current_schema() AND table_name = 'escalation_activity'), '[]'::json))::text AS j";
  var stmt = conn.createStatement();
  var rs = stmt.executeQuery(sql);
  var json = rs.next() ? rs.getString('j') : '';
  rs.close(); stmt.close();
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'escalations');   // OD-3
  var parsed = JSON.parse(json || '{}') || {};
  return { columns: (parsed.cols || []).map(String), indexes: (parsed.idx || []).map(String),
           activityColumns: (parsed.acols || []).map(String) };
}

/**
 * ESC-DDL / ESC-U1 (PURE): a schema read -> the Health row's
 * { status, value, hint }. Missing linked-copy COLUMNS are the outage case
 * (every escalation save and live Activity fail); a missing unique index is
 * the softer one (the code still refuses a second copy, the database does
 * not), and its usual cause is duplicate copies already in the table.
 */
function escSchemaVerdict_(read) {
  var cols = (read && read.columns) || [], idx = (read && read.indexes) || [];
  if (!cols.length) {
    return { status: 'muted', value: 'escalations table not created yet',
             hint: 'It is created on the first escalation write.' };
  }
  var missing = ESC_REQUIRED_COLUMNS_.filter(function (c) { return cols.indexOf(c) === -1; });
  // ESC-D1: the activity table's columns (only once that table exists -- an
  // install with escalations but no trail yet creates it on the next write).
  var acols = (read && read.activityColumns) || [];
  if (acols.length) {
    ESC_REQUIRED_ACTIVITY_COLUMNS_.forEach(function (c) {
      if (acols.indexOf(c) === -1) missing.push('escalation_activity.' + c);
    });
  }
  if (missing.length) {
    return { status: 'warn', value: 'missing column(s): ' + missing.join(', '),
      hint: 'The linked-copy migration in escEnsureTable_ has not taken effect, so EVERY escalation save and '
        + 'live Activity fail with "column ... does not exist". Each escalation write retries it and logs the '
        + 'cause ("escEnsureTable_: ..." in the Apps Script executions log); if it keeps failing, run the '
        + 'ALTER TABLE escalations / escalation_activity ADD COLUMN ... statements in the Neon console as the table owner (Operator State #24).' };
  }
  if (idx.indexOf(ESC_GROUP_DEPT_INDEX_) === -1) {
    return { status: 'warn', value: 'one-copy-per-department index missing (' + ESC_GROUP_DEPT_INDEX_ + ')',
      hint: 'The database is not enforcing one copy per department in a linked group (the code still refuses '
        + 'one). The build fails when duplicates already exist -- find them with SELECT group_id, department, '
        + 'count(*) FROM escalations WHERE group_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1, delete or '
        + 'remove the extras, and an escalation write builds it within the hour (the AC-5 schema-check flag; INV-55; Operator State #24).' };
  }
  return { status: 'ok', value: 'linked-copy columns + one-copy-per-department index present', hint: '' };
}


// AC-5 (broad-scan 2026-10-01): escEnsureTable_ ran on EVERY escalation call
// -- each list load and each card expand -- ~11 DDL round trips, five of them
// `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which takes an ACCESS EXCLUSIVE
// lock even when the column exists, from a manager-callable READ. The verbs and
// readers now go through this memo: once per execution, and once per
// ESC_SCHEMA_TTL_S_ across executions via a cache flag whose key carries
// ESC_REQUIRED_COLUMNS_ (adding a column re-runs the DDL immediately). The flag
// is set only when the load-bearing DDL (the columns + the activity table)
// succeeded; a failed unique-index build (duplicate copies) does not block it
// -- the Health page's esc-schema row reports that index. escEnsureTable_
// itself still runs everything on every call (its own suites pin that).
var ESC_SCHEMA_TTL_S_ = 3600;
var ESC_SCHEMA_ENSURED_ = false;
// v2 (ESC-D1): + the activity table's columns -- escAppendActivity_ writes
// `department`, so a pre-deploy v1 flag must not skip the ADD COLUMN for an hour.
function escSchemaCacheKey_() {
  return 'escSchema:v2:' + ESC_REQUIRED_COLUMNS_.join(',') + '|' + ESC_REQUIRED_ACTIVITY_COLUMNS_.join(',');
}
function escEnsureTableOnce_(conn) {
  if (ESC_SCHEMA_ENSURED_) return;
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  try { if (cache && cache.get(escSchemaCacheKey_())) { ESC_SCHEMA_ENSURED_ = true; return; } } catch (e) { /* recheck */ }
  var res = escEnsureTable_(conn) || {};
  if (res.columnsOk !== false && res.activityOk !== false) {
    ESC_SCHEMA_ENSURED_ = true;
    try { if (cache) cache.put(escSchemaCacheKey_(), '1', ESC_SCHEMA_TTL_S_); } catch (e) { /* best-effort */ }
  }
}

// ESC-D2 (broad-scan 2026-10-01): every escalation statement is BOUNDED. The
// connect itself cannot be (Apps Script's JDBC refuses connectTimeout & co --
// see getDashboardNeonConn_), but a statement can, via setQueryTimeout; this
// wrapper sets it on every statement the escalation paths create, so a lock
// wait or a cold compute fails in ESC_QUERY_TIMEOUT_S_ instead of running to
// the execution ceiling. Forwards exactly the six methods those paths use.
var ESC_QUERY_TIMEOUT_S_ = 30;
function escTimed_(conn) {
  if (!conn || conn.__escTimed) return conn;
  var bound = function (stmt) {
    try { if (stmt && typeof stmt.setQueryTimeout === 'function') stmt.setQueryTimeout(ESC_QUERY_TIMEOUT_S_); } catch (e) { /* best-effort */ }
    return stmt;
  };
  return {
    __escTimed: true,
    prepareStatement: function (sql) { return bound(conn.prepareStatement(sql)); },
    createStatement: function () { return bound(conn.createStatement()); },
    setAutoCommit: function (v) { return conn.setAutoCommit(v); },
    commit: function () { return conn.commit(); },
    rollback: function () { return conn.rollback(); },
    close: function () { return conn.close(); },
  };
}

// ESC-D2: a write verb opens its connection and ensures the schema BEFORE it
// takes the project-wide script lock. The old order (lock, then connect, then
// ~11 DDL statements) held the lock across an UNBOUNDED connect: one hung
// connect froze the alerts / digest / coaching runs and every admin save until
// the execution was killed.
function escOpenWriteConn_() {
  var conn = escTimed_(getDashboardNeonConn_());
  if (!conn) throw new Error('Escalations storage (Neon) is not configured/reachable.');
  try {
    escEnsureTableOnce_(conn);   // DDL auto-commits; every verb opens its txn later
  } catch (e) {
    try { conn.close(); } catch (ce) {}
    throw new Error('Escalations storage schema check failed. ' + (e && e.message ? e.message : ''));
  }
  return conn;
}
function escTakeWriteLock_(conn, waitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) {
    try { conn.close(); } catch (ce) {}
    throw new Error('Another escalation write is in progress — retry in a moment.');
  }
  return lock;
}

function escEnsureTable_(conn) {
  var columnsOk = true, activityOk = true;   // AC-5: what escEnsureTableOnce_ may cache
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
  // ESC-L1 (Step 2a): linked department COPIES share a group_id (NULL =
  // standalone). Nullable + idempotent, so an existing table, an old backup
  // (json_populate_recordset leaves it NULL) and the external INSERT contract
  // (which never sets it) are all unaffected.
  try {
    var grp = conn.createStatement();
    grp.execute('ALTER TABLE escalations ADD COLUMN IF NOT EXISTS group_id text');
    grp.execute('CREATE INDEX IF NOT EXISTS idx_escalations_group ON escalations (group_id) WHERE group_id IS NOT NULL');
    // ESC-L2: who removed a department's copy, when, and why (all nullable).
    grp.execute('ALTER TABLE escalations ADD COLUMN IF NOT EXISTS removed_by text');
    grp.execute('ALTER TABLE escalations ADD COLUMN IF NOT EXISTS removed_at timestamptz');
    grp.execute('ALTER TABLE escalations ADD COLUMN IF NOT EXISTS removed_reason text');
    // ESC-L3: the status a removed copy returns to when it is RESTORED.
    grp.execute('ALTER TABLE escalations ADD COLUMN IF NOT EXISTS status_before_removal text');
    grp.close();
  } catch (grpErr) {
    // ESC-DDL (reflect 207-211): still best-effort -- but no longer SILENT.
    // Every verb now reads these columns, so a failure here breaks the whole
    // write path with "column ... does not exist"; the log line names the
    // cause and the Health page's esc-schema row (escSchemaVerdict_) shows it.
    columnsOk = false;
    Logger.log('escEnsureTable_: linked-copy column DDL failed: ' + (grpErr && grpErr.message ? grpErr.message : grpErr));
  }
  // ESC-U1 (reflect 207-211): the DATABASE enforces one copy per department
  // per linked group (INV-57) -- the verbs' checks stay as the readable
  // refusals; this makes a slipped check impossible. Partial (standalone rows
  // carry NULL group_id) and non-concurrent, so a build that hits existing
  // duplicates rolls back whole instead of leaving an invalid index. Its own
  // try: duplicate data must not block the columns above.
  try {
    var uq = conn.createStatement();
    uq.execute('CREATE UNIQUE INDEX IF NOT EXISTS ' + ESC_GROUP_DEPT_INDEX_
      + ' ON escalations (group_id, department) WHERE group_id IS NOT NULL');
    uq.close();
  } catch (uqErr) {
    Logger.log('escEnsureTable_: unique (group_id, department) index not built (duplicate copies?): '
      + (uqErr && uqErr.message ? uqErr.message : uqErr));
  }
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
    // ESC-D1: the department the entry was written under (escAppendActivity_).
    var adep = conn.createStatement();
    adep.execute('ALTER TABLE escalation_activity ADD COLUMN IF NOT EXISTS department text');
    adep.close();
  } catch (actErr) {
    activityOk = false;
    Logger.log('escEnsureTable_: activity table DDL failed: ' + (actErr && actErr.message ? actErr.message : actErr));
  }
  // ESC-D1 backfill, idempotent (only NULL rows; ~free once filled): an entry
  // written before the column existed takes the dept its copy had THEN -- the
  // `from` side of the earliest LATER `reassigned` entry ("<from> → <to>",
  // moveEscalation's detail) -- or, with no later move, the copy's current
  // dept. Its own try: a failed backfill only leaves the read-time fallback.
  if (activityOk) {
    try {
      var bf = conn.createStatement();
      bf.execute("UPDATE escalation_activity a SET department = COALESCE("
        + "(SELECT split_part(r.detail, ' \u2192 ', 1) FROM escalation_activity r "
        + "WHERE r.escalation_id = a.escalation_id AND r.action = 'reassigned' AND r.at > a.at "
        + "ORDER BY r.at ASC LIMIT 1), "
        + "(SELECT e.department FROM escalations e WHERE e.id = a.escalation_id)) "
        + "WHERE a.department IS NULL");
      bf.close();
    } catch (bfErr) {
      Logger.log('escEnsureTable_: activity department backfill failed: ' + (bfErr && bfErr.message ? bfErr.message : bfErr));
    }
  }
  return { columnsOk: columnsOk, activityOk: activityOk };
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
