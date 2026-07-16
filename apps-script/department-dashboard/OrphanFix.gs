/**
 * Orphan Fix engine -- the dashboard's ONLY public write path.
 *
 * Background. The pipeline (`buildDQEHistoricalData`) canonicalizes
 * raw CDR agent names against the roster (INV-24) using a
 * paren-stripping heuristic. Names that don't paren-match (typos,
 * marriages, hyphenations, exotic spellings) land in DQE Historical
 * Data under the orphan form -- they're real activity but they
 * don't show up under any roster.
 *
 * Before this engine: an admin had to either edit the roster cell
 * to add the orphan as an alias, or wait for the orphan to recur
 * and manually rename rows by hand in the spreadsheet. Neither
 * scales.
 *
 * After: admins open the Orphan Fix modal (Admin menu), see the
 * list of orphans across all depts, pick a canonical roster name
 * for each, and optionally backfill the rename across past data.
 *
 * SECURITY MODEL -- read carefully before editing.
 *
 * This file holds the FIRST AND ONLY public functions in the
 * dashboard that write to a sheet. Everywhere else, INV-01 keeps
 * the surface area read-only. Two reasons we accepted the
 * exception here:
 *   (a) The action is genuinely useful and infrequent; there's no
 *       sensible read-only alternative.
 *   (b) The blast radius is bounded: alias adds touch ONE row in
 *       Agent Alias Overrides; backfill renames touch exactly the
 *       Agent Name column of DQE Historical Data for rows where
 *       Agent Name === fromName.
 *
 * Mitigations (all four must stay in place):
 *   1. Every public callable starts with `assertAdmin_()` -- the
 *      same check Alerts.gs and Digest.gs use. Non-admin RPCs are
 *      rejected before any input is touched.
 *   2. Inputs are validated to reject queue-sentinel names
 *      (`A_Q_*`, `Backup CSR`), empty strings, oversized strings,
 *      and self-renames. `toName` for a rename MUST be on at
 *      least one dept's roster -- you can't rename to a brand-new
 *      name without first adding it to the roster.
 *   3. `LockService.getScriptLock()` serializes writes so a daily
 *      build + concurrent admin rename can't race on the Agent
 *      column.
 *   4. Every write -- alias add OR backfill rename -- appends a
 *      row to `Orphan Fix Log` BEFORE returning to the client.
 *      The log is append-only and idempotently created by setup().
 *
 * The downstream cache layers (companyOverview:v20, summary:v12,
 * individual:v11, etc.; see INV-30 for the canonical list) will
 * hold stale data for up to 30 minutes (REPORT_CACHE_TTL_SECONDS)
 * after a rename. We invalidate the single fixed-key
 * `companyOverview:` entry on every successful write; the
 * per-(dept, range) caches are left to TTL out naturally.
 *
 * Public entries (all admin-only, all callable via
 * google.script.run):
 *   getOrphanFixInit() ->
 *     { orphans: [{ name, rows, lastSeen, sampleExts }],
 *       rosterNames: [...],   // sorted union across all depts
 *       aliases:     [...],   // current Agent Alias Overrides rows
 *       log:         [...],   // last 20 Orphan Fix Log rows
 *       spreadsheetUrl: string }
 *   addAgentAlias({ oldName, canonicalName, notes? }) -> { added: 1 }
 *   removeAgentAlias({ oldName }) -> { removed: N }
 *   applyOrphanRename({ fromName, toName, alsoAddAlias?, notes? })
 *     -> { renamed: N, aliasAdded: boolean }
 *   addOrphanToRoster({ name, department, extensions, notes? })
 *     -> { added: 1, cell: 'A1-notation' }
 *     The "orphan is actually a NEW EMPLOYEE" flow: appends one
 *     "Name, ext1, ext2" cell to the bottom of the chosen dept's
 *     DO NOT EDIT! column. Extensions are REQUIRED (operator
 *     decision) -- the roster cell format embeds them (INV-03) and
 *     queue matching depends on them. The column is located by the
 *     same first-blank-terminated header scan getAllDepartments_
 *     uses, so the write is structurally confined to the dept block
 *     (the insurance block in cols X-AG sits past the blank column
 *     and is unreachable). The new entry takes effect everywhere on
 *     the next cache TTL, and the pipeline canonicalizes incoming
 *     CDR names against it from the next build (INV-24) -- which is
 *     why the name pre-fills byte-exact from the orphan.
 */

const ORPHAN_FIX_MAX_NAME_LENGTH = 200;

// Batch 1 (item 6): the Outlier Fix modal's init blob is expensive to build
// -- computeOrphans_ scans up to ORPHAN_LOOKBACK_DAYS of DQE Historical Data.
// Cache the whole blob so re-opening the modal is instant. Every write path
// busts it via bustOrphanFixCache_() (and the client updates in place per
// item 5a, so the bust only matters for the NEXT cold open). Admin-only
// surface, so the shared script cache is safe (no per-viewer personalization).
const ORPHAN_FIX_INIT_CACHE_KEY = 'orphanFix:init:v1';

function getOrphanFixInit() {
  assertAdmin_();
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get(ORPHAN_FIX_INIT_CACHE_KEY);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* best-effort: fall through to a fresh build */ }
  const init = {
    orphans:        computeOrphans_(),
    rosterNames:    collectAllRosterNames_(),
    departments:    getAllDepartments_(),   // for the add-to-roster dept picker
    aliases:        readAgentAliases_(),
    log:            readOrphanFixLog_(20),
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + getSpreadsheetId_() + '/edit',
  };
  try { cache.put(ORPHAN_FIX_INIT_CACHE_KEY, JSON.stringify(init), REPORT_CACHE_TTL_SECONDS); }
  catch (e) { /* best-effort */ }
  return init;
}

/**
 * Bust the cached init blob. Called from every public write path so a
 * subsequent cold modal open recomputes orphans / aliases / log. Best-effort.
 */
function bustOrphanFixCache_() {
  try { CacheService.getScriptCache().remove(ORPHAN_FIX_INIT_CACHE_KEY); }
  catch (e) { /* best-effort */ }
}

/**
 * Adds (or re-activates) an entry in Agent Alias Overrides. The
 * CDR pipeline reads this sheet at the start of every build and
 * folds it into the canonical-name map.
 *
 * Does NOT touch DQE Historical Data -- existing orphan rows stay
 * orphaned until the build re-runs OR an admin chooses backfill
 * rename. Use `applyOrphanRename` with `alsoAddAlias=true` for
 * the combined "fix everywhere" workflow.
 */
function addAgentAlias(req) {
  assertAdmin_();
  const oldName = sanitizeAgentName_((req && req.oldName) || '');
  const canonicalName = sanitizeAgentName_((req && req.canonicalName) || '');
  const notes = String((req && req.notes) || '').trim().slice(0, 500);

  if (oldName === canonicalName) {
    throw new Error('Old name and canonical name must differ.');
  }
  assertOnSomeRoster_(canonicalName);
  assertOrphanFixLogExists_();   // F1/F2: refuse to write without an audit trail

  const admin = Session.getActiveUser().getEmail();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  try {
    upsertAgentAlias_(oldName, canonicalName, admin, notes);
    appendOrphanFixLog_({
      admin:    admin,
      action:   'alias-add',
      fromName: oldName,
      toName:   canonicalName,
      affected: 0,
      notes:    notes,
    });
    bustOrphanFixCache_();
  } finally {
    lock.releaseLock();
  }
  // Item 5a: return the refreshed aliases + log so the client can update in
  // place without a full re-fetch (which would recompute the orphan scan).
  return { added: 1, aliases: readAgentAliases_(), log: readOrphanFixLog_(20) };
}

/**
 * Soft-removes (Active=FALSE) an alias by oldName. Hard deletion
 * is intentionally not exposed via RPC -- if you want to delete
 * the row, edit the sheet directly. Returns the count of rows
 * deactivated (typically 0 or 1; >1 means the sheet has dupe
 * entries for the same oldName, which is itself worth surfacing).
 */
function removeAgentAlias(req) {
  assertAdmin_();
  const oldName = sanitizeAgentName_((req && req.oldName) || '');
  assertOrphanFixLogExists_();   // F1/F2: refuse to write without an audit trail
  const admin = Session.getActiveUser().getEmail();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  let removed = 0;
  try {
    removed = deactivateAgentAlias_(oldName);
    appendOrphanFixLog_({
      admin:    admin,
      action:   'alias-remove',
      fromName: oldName,
      toName:   '',
      affected: removed,
      notes:    '',
    });
    bustOrphanFixCache_();
  } finally {
    lock.releaseLock();
  }
  // Item 5a: return refreshed aliases + log for in-place client update.
  return { removed: removed, aliases: readAgentAliases_(), log: readOrphanFixLog_(20) };
}

/**
 * Backfill rename: walks DQE Historical Data's Agent Name column
 * and rewrites every cell where `agent === fromName` to `toName`.
 * Optionally also adds an Agent Alias Overrides entry so the next
 * pipeline build doesn't re-introduce the orphan.
 *
 * This is THE write path that motivates the security model above.
 * Belt-and-suspenders:
 *   - assertAdmin_ rejects non-admins.
 *   - sanitizeAgentName_ rejects queue sentinels, empty strings,
 *     oversized values.
 *   - fromName must currently exist in DQE Historical Data (no
 *     wasted rewrites; also catches typo'd fromName values).
 *   - toName must be on at least one dept's roster (prevents the
 *     "rename everything to garbage" footgun).
 *   - LockService.tryLock serializes concurrent admin / build.
 *   - All writes happen in a single setValues() call so a partial
 *     failure doesn't leave the column half-renamed.
 *   - Every successful run appends to Orphan Fix Log BEFORE
 *     returning.
 */
function applyOrphanRename(req) {
  assertAdmin_();
  const fromName = sanitizeAgentName_((req && req.fromName) || '');
  const toName = sanitizeAgentName_((req && req.toName) || '');
  const alsoAddAlias = !!(req && req.alsoAddAlias);
  const notes = String((req && req.notes) || '').trim().slice(0, 500);

  if (fromName === toName) {
    throw new Error('fromName and toName must differ.');
  }
  assertOnSomeRoster_(toName);
  // F1/F2: pre-flight the audit sheet BEFORE the irreversible
  // renameHistoricalAgent_ below, so a missing Orphan Fix Log can never
  // leave a bulk DQE Agent-column rewrite with no audit record.
  assertOrphanFixLogExists_();

  const admin = Session.getActiveUser().getEmail();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Could not acquire script lock; try again.');

  let affected = 0;
  let aliasAdded = false;
  let neonRename = null;
  try {
    affected = renameHistoricalAgent_(fromName, toName);
    if (affected === 0) {
      throw new Error('No rows in DQE Historical Data have agent name "'
                      + fromName + '". Nothing renamed.');
    }
    if (alsoAddAlias) {
      upsertAgentAlias_(fromName, toName, admin, notes);
      aliasAdded = true;
    }
    // Best-effort: mirror the rename into Neon's dqe_history so it isn't
    // lost once aged rows drop from the sheet. Never throws -- the sheet
    // rename above is the authoritative action today. null = Neon not
    // configured on this project, or the write failed (logged inside).
    neonRename = renameAgentInNeon_(fromName, toName);
    const neonNote = neonRename
      ? (' | Neon: ' + neonRename.renamed + ' renamed'
         + (neonRename.skipped ? ', ' + neonRename.skipped + ' conflict-skipped' : ''))
      : (PropertiesService.getScriptProperties().getProperty('NEON_HOST')
          ? ' | Neon: write failed (see log)'
          : '');
    appendOrphanFixLog_({
      admin:    admin,
      action:   alsoAddAlias ? 'rename+alias' : 'rename',
      fromName: fromName,
      toName:   toName,
      affected: affected,
      notes:    notes + neonNote,
    });
    // Bust the single fixed-key Overview cache so the change shows
    // up immediately on the landing page. Per-(dept, range) caches
    // are TTL'd out naturally within 30 min (REPORT_CACHE_TTL_SECONDS).
    try { CacheService.getScriptCache().remove(overviewCacheKey_()); }
    catch (e) { /* best-effort */ }
    bustOrphanFixCache_();
  } finally {
    lock.releaseLock();
  }
  return {
    renamed: affected,
    aliasAdded: aliasAdded,
    // Forward-looking Neon mirror result (null when Neon isn't configured
    // on this project). neonSkipped > 0 = conflict rows left for later
    // reconciliation (see renameAgentInNeon_).
    neonRenamed: neonRename ? neonRename.renamed : null,
    neonSkipped: neonRename ? neonRename.skipped : null,
    // Item 5a: refreshed aliases + log so the client updates in place
    // (removes the fixed orphan, refreshes the aliases/log panels) without
    // a full re-fetch that would recompute the orphan scan.
    aliases: readAgentAliases_(),
    log:     readOrphanFixLog_(20),
  };
}

/**
 * Adds an orphan to a dept's DO NOT EDIT! roster column as a NEW
 * employee ("Name, ext1, ext2" cell appended below the column's last
 * entry). Full INV-01 data-mutation treatment: admin gate, validation,
 * LockService, audit row (action 'roster-add').
 *
 * Validation:
 *   - name: sanitizeAgentName_ (non-empty, length cap, no queue
 *     sentinels) + no comma (the cell format is comma-delimited,
 *     INV-03) + must NOT already be on any roster (that case is a
 *     rename/alias, not an add).
 *   - department: must match a real roster column header byte-exact.
 *   - extensions: REQUIRED, one or more digit-only tokens.
 */
function addOrphanToRoster(req) {
  assertAdmin_();
  const name = sanitizeAgentName_((req && req.name) || '');
  if (name.indexOf(',') !== -1) {
    throw new Error('Agent name cannot contain a comma — the roster cell format is "Name, ext1, ext2".');
  }
  const department = String((req && req.department) || '').trim();
  if (!department) throw new Error('Pick a department.');
  if (getAllDepartments_().indexOf(department) === -1) {
    throw new Error('Unknown department: "' + department + '".');
  }
  const rawExts = (req && req.extensions) || '';
  const exts = (Array.isArray(rawExts) ? rawExts : String(rawExts).split(','))
    .map(function (s) { return String(s).trim(); })
    .filter(function (s) { return !!s; });
  if (!exts.length) {
    throw new Error('At least one extension is required — queue matching depends on it.');
  }
  exts.forEach(function (e) {
    if (!/^\d+$/.test(e)) {
      throw new Error('Extensions must be digits only ("' + e + '" is not).');
    }
  });
  if (collectAllRosterNames_().indexOf(name) !== -1) {
    throw new Error('"' + name + '" is already on a roster. Use the rename/alias flow instead.');
  }
  const notes = String((req && req.notes) || '').trim().slice(0, 500);
  assertOrphanFixLogExists_();   // audit trail is mandatory on every write path

  const admin = Session.getActiveUser().getEmail();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  let cell = '';
  try {
    cell = appendRosterEntry_(department, name, exts);
    appendOrphanFixLog_({
      admin:    admin,
      action:   'roster-add',
      fromName: name,
      toName:   department,
      affected: 0,
      notes:    ('exts: ' + exts.join(', ') + (notes ? ' | ' + notes : '')).slice(0, 500),
    });
    // New roster member changes dept rosters / active counts on the
    // Overview immediately; per-(dept, range) caches TTL out.
    try { CacheService.getScriptCache().remove(overviewCacheKey_()); }
    catch (e) { /* best-effort */ }
    bustOrphanFixCache_();
  } finally {
    lock.releaseLock();
  }
  // Item 5a: refreshed log so the client updates in place (the newly-rostered
  // agent drops off the orphan list, the log panel refreshes) without a full
  // re-fetch. rosterNames also changes -- return it so the roster picker /
  // "already on roster" guard stay current in the open modal.
  return {
    added:       1,
    cell:        cell,
    rosterNames: collectAllRosterNames_(),
    log:         readOrphanFixLog_(20),
  };
}

// -- Read helpers (read-only; trailing underscore) ----------------

/**
 * Walks DQE Historical Data, returns one entry per agent name that
 * (a) is not a queue sentinel, (b) is not on any dept's roster.
 * Each entry includes the row count + last-seen date + up to 3
 * sample dept queue-extensions observed (helps the admin figure
 * out which roster the orphan likely belongs on).
 *
 * Bounded to the last ORPHAN_LOOKBACK_DAYS to keep the scan cheap
 * on large history sheets.
 */
const ORPHAN_LOOKBACK_DAYS = 180;

function computeOrphans_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const ssTZ = ss.getSpreadsheetTimeZone();

  const rosterSet = {};
  collectAllRosterNames_().forEach(function (n) { rosterSet[n] = true; });

  // Cutoff iso = today - ORPHAN_LOOKBACK_DAYS in script TZ.
  const cutoff = new Date(Date.now() - ORPHAN_LOOKBACK_DAYS * 86400000);
  const cutoffIso = Utilities.formatDate(cutoff, TZ, 'yyyy-MM-dd');

  // Read Date + Agent + QueueExt cols only.
  const numCols = Math.max(
    HISTORICAL_COLS.DATE, HISTORICAL_COLS.AGENT, HISTORICAL_COLS.QUEUE_EXT
  );
  const values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  const byName = {};   // name -> { rows, lastSeen, exts: { ext: true } }
  for (let i = 0; i < values.length; i++) {
    const dateIso = rowDateIso_(values[i][HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < cutoffIso) continue;
    const agent = String(values[i][HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;
    if (rosterSet[agent]) continue;
    let e = byName[agent];
    if (!e) {
      e = { rows: 0, lastSeen: '', exts: {} };
      byName[agent] = e;
    }
    e.rows++;
    if (dateIso > e.lastSeen) e.lastSeen = dateIso;
    const exts = parseExtensions_(values[i][HISTORICAL_COLS.QUEUE_EXT - 1]);
    for (let j = 0; j < exts.length && Object.keys(e.exts).length < 3; j++) {
      e.exts[exts[j]] = true;
    }
  }
  return Object.keys(byName).sort().map(function (name) {
    return {
      name:       name,
      rows:       byName[name].rows,
      lastSeen:   byName[name].lastSeen,
      sampleExts: Object.keys(byName[name].exts).sort(),
    };
  });
}

function collectAllRosterNames_() {
  const seen = {};
  const out = [];
  getAllDepartments_().forEach(function (d) {
    getRosterForDepartment_(d).names.forEach(function (n) {
      if (!seen[n]) { seen[n] = true; out.push(n); }
    });
  });
  return out.sort();
}

function readAgentAliases_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.AGENT_ALIAS_OVERRIDES);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, AGENT_ALIAS_OVERRIDES_HEADERS.length).getValues();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const oldName = String(rows[i][0] || '').trim();
    const canonicalName = String(rows[i][1] || '').trim();
    if (!oldName || !canonicalName) continue;
    const rawActive = rows[i][2];
    const active = !(rawActive === false || rawActive === 'FALSE' || rawActive === 'false'
                  || rawActive === 0 || rawActive === 'no' || rawActive === 'No');
    out.push({
      oldName:       oldName,
      canonicalName: canonicalName,
      active:        active,
      addedBy:       String(rows[i][3] || ''),
      addedAt:       rows[i][4] instanceof Date
                       ? Utilities.formatDate(rows[i][4], TZ, 'yyyy-MM-dd HH:mm')
                       : String(rows[i][4] || ''),
      notes:         String(rows[i][5] || ''),
    });
  }
  return out;
}

function readOrphanFixLog_(maxRows) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ORPHAN_FIX_LOG);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const startRow = Math.max(2, lastRow - maxRows + 1);
  const rows = sheet.getRange(startRow, 1, lastRow - startRow + 1,
                              ORPHAN_FIX_LOG_HEADERS.length).getValues();
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    out.push({
      timestamp: r[0] instanceof Date
        ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd HH:mm')
        : String(r[0] || ''),
      admin:        String(r[1] || ''),
      action:       String(r[2] || ''),
      fromName:     String(r[3] || ''),
      toName:       String(r[4] || ''),
      affectedRows: r[5] === '' || r[5] == null ? null : r[5],
      notes:        String(r[6] || ''),
    });
  }
  return out;
}

// -- Write helpers (trailing underscore; RPC-unreachable) ---------

/**
 * Renames every row in DQE Historical Data whose Agent Name
 * column matches fromName. Single bulk read + single bulk write
 * so the column is atomic from any reader's perspective.
 * Returns the number of rows changed.
 *
 * F-22 (rename-vs-build race): LockService is PER-SCRIPT-PROJECT, so
 * this write cannot be serialized against the cdr-import / cdr-report
 * daily builds (other projects, same workbook). A force re-import
 * DELETES a date's rows mid-flight -- rows below shift up, and writing
 * this function's stale column snapshot back would misalign agent
 * names against every shifted row's other columns. Mitigation:
 * RE-VERIFY immediately before writing -- if the sheet's row count or
 * ANY cell of the agent column changed since the snapshot, abort with
 * a retry message instead of writing. This shrinks the unguarded
 * window from read -> compute -> write to the back-to-back re-read ->
 * write RPCs; it is a mitigation, not a serialization.
 */
function renameHistoricalAgent_(fromName, toName) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) throw new Error('Historical sheet not found.');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const range = sheet.getRange(2, HISTORICAL_COLS.AGENT, lastRow - 1, 1);
  const original = range.getValues();
  const updated = new Array(original.length);
  let affected = 0;
  for (let i = 0; i < original.length; i++) {
    if (String(original[i][0] || '').trim() === fromName) {
      updated[i] = [toName];
      affected++;
    } else {
      updated[i] = [original[i][0]];
    }
  }
  if (affected === 0) return 0;

  const raceMsg = 'DQE Historical Data changed while preparing the rename — '
    + 'a build or import is likely running (the daily builds live in other '
    + 'script projects, so the lock here cannot serialize against them). '
    + 'Nothing was written; retry in a minute.';
  if (sheet.getLastRow() !== lastRow) throw new Error(raceMsg);
  const recheck = range.getValues();
  for (let i = 0; i < recheck.length; i++) {
    if (String(recheck[i][0] || '') !== String(original[i][0] || '')) {
      throw new Error(raceMsg);
    }
  }

  range.setValues(updated);
  return affected;
}

/**
 * Appends "Name, ext1, ext2" to the bottom of `department`'s roster
 * column. Column located by the SAME first-blank-terminated header scan
 * the readers use (getAllDepartments_ / getRosterForDepartment_), so a
 * write can never land outside the dept block. The target row is the
 * first row after the column's LAST non-empty cell (other columns may
 * be longer or shorter; row position is per-column). Returns the A1
 * notation of the written cell for the audit trail / client toast.
 */
function appendRosterEntry_(department, name, exts) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ROSTER);
  if (!sheet) throw new Error('Roster sheet (DO NOT EDIT!) not found.');
  const lastCol = sheet.getLastColumn();
  if (lastCol < ROSTER.DEPT_FIRST_COL) throw new Error('Roster sheet has no dept columns.');

  const headerRow = sheet
    .getRange(ROSTER.HEADER_ROW, ROSTER.DEPT_FIRST_COL,
              1, lastCol - ROSTER.DEPT_FIRST_COL + 1)
    .getValues()[0];
  let col = -1;
  for (let i = 0; i < headerRow.length; i++) {
    const v = String(headerRow[i] || '').trim();
    if (!v) break;   // first blank ends the dept block (insurance block is past it)
    if (v === department) { col = ROSTER.DEPT_FIRST_COL + i; break; }
  }
  if (col === -1) throw new Error('Department column "' + department + '" not found on the roster sheet.');

  // First row below the column's last non-empty cell.
  const lastRow = Math.max(sheet.getLastRow(), ROSTER.DATA_START_ROW);
  const colValues = sheet.getRange(ROSTER.DATA_START_ROW, col,
                                   lastRow - ROSTER.DATA_START_ROW + 1, 1).getValues();
  let writeRow = ROSTER.DATA_START_ROW;
  for (let r = colValues.length - 1; r >= 0; r--) {
    if (String(colValues[r][0] || '').trim() !== '') {
      writeRow = ROSTER.DATA_START_ROW + r + 1;
      break;
    }
  }
  const target = sheet.getRange(writeRow, col);
  // CORE-7: neutralize a formula-leading name -- this cell lands on the
  // roster every dashboard consumer parses (parseRosterCell_ reads the
  // stored string back unchanged; the apostrophe is formatting only).
  target.setValue(sheetSafeCell_(name + ', ' + exts.join(', ')));
  return target.getA1Notation();
}

/**
 * Best-effort mirror of a rename into Neon's `dqe_history` so the change
 * isn't lost once aged rows are dropped from the sheet (forward-looking
 * for the Neon read-back). This is the dashboard's ONLY Neon write path;
 * it needs the `script.external_request` OAuth scope (appsscript.json) and
 * the NEON_HOST/NEON_DB/NEON_USER/NEON_PASS Script Properties on THIS
 * project (same values the import/report projects use).
 *
 * Conflict handling: `dqe_history` has a unique constraint that includes
 * (call_date, agent_name), so renaming a row to a name that ALREADY has a
 * row that same day would violate it (the sheet tolerates the dual rows by
 * summing; Neon can't). We rename only rows whose (call_date, toName) slot
 * is free and LEAVE the conflicting rows under `fromName`, returning the
 * skipped count. Those few are reconciled later (Phase 3.3) or by a manual
 * merge -- not silently destroyed.
 *
 * Never throws: a missing config, an unreachable Neon, or any SQL error
 * returns null so the sheet rename (the authoritative action today) still
 * succeeds. Returns { renamed, skipped } on success, or null when Neon
 * isn't configured / the write failed.
 */
function renameAgentInNeon_(fromName, toName) {
  var props = PropertiesService.getScriptProperties();
  var host = props.getProperty('NEON_HOST');
  if (!host) {
    Logger.log('renameAgentInNeon_: NEON_HOST not set on the dashboard project — skipping Neon rename.');
    return null;
  }
  var conn;
  try {
    var url = 'jdbc:postgresql://' + host + '/' + props.getProperty('NEON_DB');
    conn = Jdbc.getConnection(url, props.getProperty('NEON_USER'), props.getProperty('NEON_PASS'));
    if (!conn) return null;

    // F11: run the conflict-safe rename AND the skip-count inside ONE
    // transaction so the rename is atomic (all-or-nothing on error -- no
    // half-renamed mirror) and the counts come from a consistent snapshot
    // rather than a separate pre-count a concurrent import insert could skew.
    conn.setAutoCommit(false);
    try {
      // Conflict-skip rename (see docstring). NOT EXISTS keyed on
      // (call_date, agent_name) -- the near-certain uq_dqe_history columns;
      // if the real key is broader this just skips a little more, never errors.
      var upStmt = conn.prepareStatement(
        'UPDATE dqe_history t SET agent_name = ? ' +
        'WHERE t.agent_name = ? ' +
        'AND NOT EXISTS (SELECT 1 FROM dqe_history x ' +
        'WHERE x.call_date = t.call_date AND x.agent_name = ?)');
      upStmt.setString(1, toName);
      upStmt.setString(2, fromName);
      upStmt.setString(3, toName);
      upStmt.execute();
      var renamed = upStmt.getUpdateCount();
      upStmt.close();
      if (renamed < 0) renamed = 0;

      // EXACT conflict-skip count: rows STILL carrying the orphan name after
      // the rename are precisely the ones the NOT EXISTS guard skipped (a
      // (call_date, toName) row already existed). Counted inside the same
      // transaction -- no pre-count/subtraction, so it can't be skewed by a
      // concurrent insert between two statements.
      var skipStmt = conn.prepareStatement(
        'SELECT COUNT(*) FROM dqe_history WHERE agent_name = ?');
      skipStmt.setString(1, fromName);
      var srs = skipStmt.executeQuery();
      var skipped = srs.next() ? srs.getInt(1) : 0;
      srs.close(); skipStmt.close();

      conn.commit();
      Logger.log('renameAgentInNeon_: %s -> %s | renamed %s, conflict-skipped %s',
        fromName, toName, renamed, skipped);
      return { renamed: renamed, skipped: skipped };
    } catch (txErr) {
      try { conn.rollback(); } catch (rbErr) {}
      throw txErr;   // surface to the outer best-effort catch (returns null)
    }
  } catch (e) {
    Logger.log('renameAgentInNeon_ failed (best-effort): ' + (e && e.message ? e.message : e));
    return null;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

/**
 * Appends or re-activates an alias row. If `oldName` already
 * exists in the sheet, the existing row is updated (canonical /
 * active / metadata refreshed); otherwise a new row is appended.
 * Idempotent on repeat calls with the same args.
 */
function upsertAgentAlias_(oldName, canonicalName, admin, notes) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.AGENT_ALIAS_OVERRIDES);
  if (!sheet) throw new Error('Agent Alias Overrides sheet missing -- run setup().');
  const lastRow = sheet.getLastRow();
  const now = new Date();

  // Find existing row with matching oldName.
  let existingRow = -1;
  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim() === oldName) {
        existingRow = i + 2;   // 1-indexed sheet row
        break;
      }
    }
  }
  // CORE-7: oldName comes from the CDR feed (an orphan spelling), notes
  // are free text -- neutralize formula-leading values. The apostrophe is
  // a Sheets text marker, not content, so loadRosterCanonicalNames_ reads
  // the original string back and alias matching is unaffected.
  const rowValues = [
    sheetSafeCell_(oldName), sheetSafeCell_(canonicalName), 'TRUE',
    admin, now, sheetSafeCell_(notes || ''),
  ];
  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}

function deactivateAgentAlias_(oldName) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.AGENT_ALIAS_OVERRIDES);
  if (!sheet) return 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const range = sheet.getRange(2, 1, lastRow - 1, AGENT_ALIAS_OVERRIDES_HEADERS.length);
  const values = range.getValues();
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === oldName) {
      values[i][2] = 'FALSE';
      count++;
    }
  }
  if (count > 0) range.setValues(values);
  return count;
}

/**
 * Pre-flight (F1/F2): every public write callable asserts the Orphan
 * Fix Log sheet exists BEFORE it mutates anything, so a missing audit
 * sheet (e.g. setup() not re-run after a fresh pull) can never produce
 * an un-audited DQE Agent-column rewrite. Audit logging on a
 * data-mutation path is a hard requirement (INV-01), not best-effort
 * telemetry -- so this throws rather than silently no-opping.
 */
function assertOrphanFixLogExists_() {
  const ss = openSpreadsheet_();
  if (!ss.getSheetByName(SHEETS.ORPHAN_FIX_LOG)) {
    throw new Error(
      'Orphan Fix Log sheet missing -- run setup() before applying fixes. '
      + 'The audit trail is required for every orphan-fix write.');
  }
}

function appendOrphanFixLog_(rec) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ORPHAN_FIX_LOG);
  // Hard-fail (not silent) if the audit sheet vanished after the
  // pre-flight: an audit row is mandatory on every write path (INV-01).
  if (!sheet) {
    throw new Error('Orphan Fix Log sheet missing -- run setup(). Audit row not written.');
  }
  // CORE-7: fromName originates in the external CDR feed and notes are
  // admin free text -- neutralize formula-leading values so the audit log
  // can never carry an executing cell (admin/action are code-controlled).
  sheet.appendRow([
    new Date(),
    rec.admin    || '',
    rec.action   || '',
    sheetSafeCell_(rec.fromName || ''),
    sheetSafeCell_(rec.toName   || ''),
    rec.affected == null ? '' : rec.affected,
    sheetSafeCell_(rec.notes    || ''),
  ]);
}

// -- Validators ---------------------------------------------------

/**
 * Common defenses on every name input to a public callable:
 *  - String, trimmed.
 *  - Non-empty.
 *  - Length <= ORPHAN_FIX_MAX_NAME_LENGTH.
 *  - Not a queue-sentinel pattern (`A_Q_*` or `Backup CSR`).
 * Throws an Error with a user-facing message on rejection.
 */
function sanitizeAgentName_(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('Agent name is required.');
  if (s.length > ORPHAN_FIX_MAX_NAME_LENGTH) {
    throw new Error('Agent name is too long.');
  }
  if (/^A_Q_/.test(s) || s === 'Backup CSR') {
    throw new Error('Queue-sentinel names cannot be renamed or used as a canonical name.');
  }
  return s;
}

/**
 * Verifies `name` is on at least one dept's roster. This is the
 * guard rail against "rename everything to Garbage Name" -- the
 * canonical destination must already exist as a real roster
 * entry. To rename to a brand-new agent, add them to DO NOT EDIT!
 * first.
 */
function assertOnSomeRoster_(name) {
  const rosterNames = collectAllRosterNames_();
  if (rosterNames.indexOf(name) === -1) {
    throw new Error('"' + name + '" is not on any dept roster. '
      + 'Add them to the DO NOT EDIT! sheet first, then re-try.');
  }
}
