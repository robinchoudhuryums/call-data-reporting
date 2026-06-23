/**
 * Dept Config -- admin-authored, no-redeploy overrides for the three
 * per-dept maps that historically lived as frozen constants in
 * Config.gs / CompanyOverview.gs:
 *
 *   DEPT_QCD_QUEUES    -> dept's QCD queue names (the documented
 *                         footgun: a typo'd `A_Q_*` name renders an
 *                         empty QCD modal with no error).
 *   OVERVIEW_PARENT_OF -> sub-queue nesting on the Overview grid (a
 *                         key that doesn't match a DO NOT EDIT! header
 *                         byte-for-byte silently renders the child as
 *                         a standalone tile).
 *   TEAM_AVG_EXCLUDES  -> agents dropped from a dept's Individual
 *                         Report team average.
 *   DEPT_QUEUE_EXT_OVERRIDES -> queue extensions that count as this
 *                         dept's for scope/sentinel matching (replaces
 *                         the data-derived fallback when set).
 *
 * Before this engine, wiring a new dept/sub-queue meant editing a
 * constant + `clasp push -f` + a new deployment version, with no
 * validation and no review for the silent-failure modes above.
 *
 * After: admins open the Dept Config modal, pick from auto-discovered
 * queue names + real dept headers, and save to the `Dept Config`
 * sheet. The accessors below layer the sheet OVER the constants so
 * the change takes effect on the next request (after the relevant
 * cache TTL) with no redeploy.
 *
 * OVERRIDE SEMANTICS (uniform + deliberately safe):
 *   For a dept with an Active `Dept Config` row, each NON-EMPTY field
 *   overrides the matching constant for that dept; an EMPTY field
 *   falls back to the constant. So adding a row to set just the
 *   Overview Parent will not accidentally wipe the dept's QCD queues.
 *   The one thing you cannot do via the sheet is CLEAR a constant
 *   entry (constants seed the legacy depts; clearing one is a rare
 *   code edit). New depts have no constant, so the sheet fully
 *   defines them.
 *
 * NON-BREAKING ON PRE-SETUP INSTALLS:
 *   `readDeptConfigRows_` is best-effort -- a missing `Dept Config`
 *   sheet (setup() not yet re-run) yields an empty config and every
 *   accessor falls straight through to the frozen constant. Behavior
 *   is byte-identical to pre-feature until an admin saves a row.
 *
 * SECURITY MODEL (INV-01):
 *   This is a CONFIG write path, not a data-mutation path -- it never
 *   touches DQE Historical Data. Per INV-01 a config/creation path
 *   needs `assertAdmin_()` at minimum; every public callable here
 *   starts with it. We additionally validate inputs (the whole point)
 *   and serialize writes with `LockService`, and stamp Updated By /
 *   Updated At into the row for a lightweight audit trail. The read
 *   accessors (trailing underscore, RPC-unreachable) carry no admin
 *   gate -- they're called from manager-facing read paths (QCD report,
 *   Overview, Individual Report).
 *
 * Public entries (all admin-only, callable via google.script.run):
 *   getDeptConfigInit() ->
 *     { departments, rosterByDept, effective, rows, discoveredQueues,
 *       unmappedCount, spreadsheetUrl }
 *   saveDeptConfig({ dept, qcdQueues, overviewParent, teamAvgExcludes,
 *                    queueExtOverrides, active, notes }) -> { saved: true }
 *   removeDeptConfig({ dept }) -> { removed: N }   // soft (Active=FALSE)
 */

// Lookback window for queue auto-discovery + known-queue validation.
// Matches the Orphan Fix scan horizon so both admin tools reason over
// the same recent history.
const DEPT_CONFIG_QUEUE_LOOKBACK_DAYS = 180;
const DEPT_CONFIG_MAX_FIELD_LENGTH = 1000;

// Per-execution memo of the parsed Dept Config rows. Apps Script
// resets globals between executions, so this is request-scoped: one
// sheet read per execution no matter how many accessor calls fire
// (getCompanyOverview alone calls getDeptQcdQueues_ ~14x). Cleared
// after a write so a save+re-read within one execution sees fresh
// rows.
var DEPT_CONFIG_ROWS_MEMO_ = null;

// -- Read accessors (RPC-unreachable; layered over the constants) --

/**
 * Reads + parses the `Dept Config` sheet once per execution. Returns
 * an array of { dept, qcdQueues[], overviewParent, teamAvgExcludes[],
 * active, updatedBy, updatedAt, notes }. Best-effort: any failure
 * (missing sheet, read error) returns [] so callers fall back to the
 * frozen constants.
 */
function readDeptConfigRows_() {
  if (DEPT_CONFIG_ROWS_MEMO_) return DEPT_CONFIG_ROWS_MEMO_;
  const out = [];
  try {
    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.DEPT_CONFIG);
    if (sheet) {
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        const rows = sheet
          .getRange(2, 1, lastRow - 1, DEPT_CONFIG_HEADERS.length)
          .getValues();
        for (let i = 0; i < rows.length; i++) {
          const dept = String(rows[i][0] || '').trim();
          if (!dept) continue;
          out.push({
            dept:              dept,
            qcdQueues:         dcParseList_(rows[i][1]),
            overviewParent:    String(rows[i][2] || '').trim(),
            teamAvgExcludes:   dcParseList_(rows[i][3]),
            queueExtOverrides: dcParseList_(rows[i][4]),
            active:            dcIsActive_(rows[i][5]),
            updatedBy:         String(rows[i][6] || ''),
            updatedAt:         rows[i][7] instanceof Date
                                 ? Utilities.formatDate(rows[i][7], TZ, 'yyyy-MM-dd HH:mm')
                                 : String(rows[i][7] || ''),
            notes:             String(rows[i][8] || ''),
          });
        }
      }
    }
  } catch (e) {
    // Best-effort: leave `out` empty so constants win.
  }
  DEPT_CONFIG_ROWS_MEMO_ = out;
  return out;
}

/**
 * dept -> parsed Active config row (last write wins on duplicate
 * dept). Inactive rows are dropped so deactivating a row reverts the
 * dept to constant behavior.
 */
function getActiveDeptConfigMap_() {
  const map = {};
  readDeptConfigRows_().forEach(function (r) {
    if (r.active) map[r.dept] = r;
  });
  return map;
}

/**
 * Effective QCD queue list for `dept`: the Active config row's
 * QCD Queues if non-empty, else DEPT_QCD_QUEUES[dept], else [].
 * This is the ONLY queue source queuesForDept_ (and through it every
 * QCD reader) should consult.
 */
function getDeptQcdQueues_(dept) {
  const cfg = getActiveDeptConfigMap_()[dept];
  if (cfg && cfg.qcdQueues.length) return cfg.qcdQueues.slice();
  const c = (typeof DEPT_QCD_QUEUES !== 'undefined') && DEPT_QCD_QUEUES[dept];
  return Array.isArray(c) ? c.slice() : [];
}

/**
 * Merged child->parent map for Overview sub-queue nesting: the
 * OVERVIEW_PARENT_OF constant seeded first, then each Active config
 * row with a non-empty Overview Parent overriding its dept's key.
 */
function getOverviewParentMap_() {
  const map = {};
  if (typeof OVERVIEW_PARENT_OF !== 'undefined') {
    Object.keys(OVERVIEW_PARENT_OF).forEach(function (k) { map[k] = OVERVIEW_PARENT_OF[k]; });
  }
  readDeptConfigRows_().forEach(function (r) {
    if (r.active && r.overviewParent) map[r.dept] = r.overviewParent;
  });
  return map;
}

/**
 * Effective team-average exclusion list for `dept`: the Active config
 * row's Team Avg Excludes if non-empty, else TEAM_AVG_EXCLUDES[dept],
 * else [].
 */
function getTeamAvgExcludes_(dept) {
  const cfg = getActiveDeptConfigMap_()[dept];
  if (cfg && cfg.teamAvgExcludes.length) return cfg.teamAvgExcludes.slice();
  const c = (typeof TEAM_AVG_EXCLUDES !== 'undefined') && TEAM_AVG_EXCLUDES[dept];
  return Array.isArray(c) ? c.slice() : [];
}

/**
 * Effective queue-extension override list for `dept`: the Active
 * config row's Queue Ext Overrides if non-empty, else
 * DEPT_QUEUE_EXT_OVERRIDES[dept], else [] (caller's data-derived
 * fallback then applies). Consumed by Data.gs::getDeptQueueExts_,
 * which REPLACES its derived ext set when this returns non-empty --
 * so the override semantics match the constant it supersedes.
 */
function getDeptQueueExtsOverride_(dept) {
  const cfg = getActiveDeptConfigMap_()[dept];
  if (cfg && cfg.queueExtOverrides.length) return cfg.queueExtOverrides.slice();
  const c = (typeof DEPT_QUEUE_EXT_OVERRIDES !== 'undefined') && DEPT_QUEUE_EXT_OVERRIDES[dept];
  return Array.isArray(c) ? c.slice() : [];
}

// -- Auto-discovery -------------------------------------------------

/**
 * Scans `QCD Historical Data` (Total Calls rows within the lookback
 * window) and returns queue-name -> { rows, lastSeen }. The set of
 * distinct col-D values is the canonical list of queue names that
 * actually exist in the data -- the source of truth for both the
 * "unmapped queues" surface and save-time queue validation. Empty
 * map on a missing sheet.
 */
function scanQcdQueueNames_() {
  const out = {};
  try {
    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName('QCD Historical Data');
    if (!sheet) return out;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return out;
    const ssTZ = ss.getSpreadsheetTimeZone();
    const cutoff = new Date(Date.now() - DEPT_CONFIG_QUEUE_LOOKBACK_DAYS * 86400000);
    const cutoffIso = Utilities.formatDate(cutoff, TZ, 'yyyy-MM-dd');
    const values = sheet.getRange(2, 1, lastRow - 1, QCD_HISTORICAL_COLS.VIOLATIONS).getValues();
    for (let i = 0; i < values.length; i++) {
      const r = values[i];
      const source = String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim();
      if (source !== 'Total Calls') continue;
      const queue = String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim();
      if (!queue) continue;
      const dateIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], ssTZ);
      if (!dateIso || dateIso < cutoffIso) continue;
      let e = out[queue];
      if (!e) { e = { rows: 0, lastSeen: '' }; out[queue] = e; }
      e.rows++;
      if (dateIso > e.lastSeen) e.lastSeen = dateIso;
    }
  } catch (e) {
    // Best-effort.
  }
  return out;
}

/**
 * Builds the discovery list the modal renders: every distinct queue
 * name seen in recent QCD data, annotated with the dept it currently
 * maps to (via the effective queue lists) or null when unmapped.
 * Sorted unmapped-first, then by row count desc.
 */
function discoverQueues_(allDepts) {
  const scanned = scanQcdQueueNames_();
  // queue -> dept it's mapped to (first effective match wins). We use
  // the DIRECT effective list per dept (not queuesForDept_) so a
  // child's queue maps to the child, not also the parent -- the modal
  // reports the most specific owner.
  const queueToDept = {};
  allDepts.forEach(function (d) {
    getDeptQcdQueues_(d).forEach(function (q) {
      if (!queueToDept[q]) queueToDept[q] = d;
    });
  });
  const out = Object.keys(scanned).map(function (q) {
    return {
      queue:    q,
      rows:     scanned[q].rows,
      lastSeen: scanned[q].lastSeen,
      mappedTo: queueToDept[q] || null,
    };
  });
  out.sort(function (a, b) {
    const au = a.mappedTo ? 1 : 0;
    const bu = b.mappedTo ? 1 : 0;
    if (au !== bu) return au - bu;          // unmapped (0) first
    return b.rows - a.rows;                 // then busiest first
  });
  return out;
}

// -- Public RPCs (admin-only) ---------------------------------------

function getDeptConfigInit() {
  assertAdmin_();
  const allDepts = getAllDepartments_();
  const cfgMap = getActiveDeptConfigMap_();

  const rosterByDept = {};
  allDepts.forEach(function (d) {
    rosterByDept[d] = getRosterForDepartment_(d).names.slice();
  });

  // Effective (post-merge) view per dept, so the admin sees what is
  // actually in force -- and whether it comes from the sheet or the
  // constant.
  const effective = allDepts.map(function (d) {
    const row = cfgMap[d];
    return {
      dept:              d,
      qcdQueues:         getDeptQcdQueues_(d),
      overviewParent:    getOverviewParentMap_()[d] || '',
      teamAvgExcludes:   getTeamAvgExcludes_(d),
      queueExtOverrides: getDeptQueueExtsOverride_(d),
      hasRow:            !!row,
    };
  });

  const discovered = discoverQueues_(allDepts);
  let unmappedCount = 0;
  discovered.forEach(function (q) { if (!q.mappedTo) unmappedCount++; });

  return {
    departments:     allDepts,
    rosterByDept:    rosterByDept,
    effective:       effective,
    rows:            readDeptConfigRows_(),
    discoveredQueues: discovered,
    unmappedCount:   unmappedCount,
    spreadsheetUrl:  'https://docs.google.com/spreadsheets/d/' + getSpreadsheetId_() + '/edit',
  };
}

/**
 * Validates + upserts a single dept's config row. Validation is the
 * point of this engine -- it catches the silent-failure footguns that
 * the raw-constant edit path had no guard for:
 *   - Department must be a real DO NOT EDIT! header.
 *   - Every QCD queue token must be a queue name actually seen in
 *     QCD Historical Data (or already in the dept's constant) --
 *     blocks the typo'd-queue -> empty-modal footgun.
 *   - Overview Parent (if set) must be a real dept, differ from the
 *     dept, and not create a parent cycle.
 *   - Every Team Avg Exclude must be on the dept's roster.
 */
function saveDeptConfig(req) {
  assertAdmin_();
  const dept = String((req && req.dept) || '').trim();
  if (!dept) throw new Error('Department is required.');

  const allDepts = getAllDepartments_();
  if (allDepts.indexOf(dept) === -1) {
    throw new Error('"' + dept + '" is not a department. It must match a '
      + 'column header in the DO NOT EDIT! roster sheet exactly.');
  }

  const qcdQueues         = dcNormalizeList_(req && req.qcdQueues, 'QCD Queues');
  const overviewParent    = String((req && req.overviewParent) || '').trim();
  const teamAvgExcludes   = dcNormalizeList_(req && req.teamAvgExcludes, 'Team Avg Excludes');
  const queueExtOverrides = dcNormalizeList_(req && req.queueExtOverrides, 'Queue Ext Overrides');
  const active            = !(req && req.active === false);   // default TRUE
  const notes             = String((req && req.notes) || '').trim().slice(0, 500);

  // --- QCD queue validation: every token must exist in the data
  // (or already be in this dept's constant, so a seeded queue with no
  // recent rows stays valid). ---
  if (qcdQueues.length) {
    const known = scanQcdQueueNames_();
    const constSet = {};
    const constArr = (typeof DEPT_QCD_QUEUES !== 'undefined') && DEPT_QCD_QUEUES[dept];
    if (Array.isArray(constArr)) constArr.forEach(function (q) { constSet[q] = true; });
    const unknown = qcdQueues.filter(function (q) {
      return !known[q] && !constSet[q];
    });
    if (unknown.length) {
      const sample = Object.keys(known).sort().slice(0, 25);
      throw new Error('Unknown QCD queue name(s): ' + unknown.join(', ')
        + '. Queue names must match QCD Historical Data column D exactly. '
        + (sample.length
            ? 'Queues seen in the last ' + DEPT_CONFIG_QUEUE_LOOKBACK_DAYS
              + ' days: ' + sample.join(', ') + '.'
            : 'No QCD queues found in recent data.'));
    }
  }

  // --- M2 hardening: NON-BLOCKING warning when a saved queue is also
  // mapped to another dept. Double-mapping is tolerated downstream (the
  // Overview attributes a shared queue to EVERY dept that lists it --
  // companyOverview:v17 M2), so this is a heads-up, not a rejection: it's
  // almost always a config slip that would silently inflate two depts'
  // QCD numbers from the same queue. Computed against the OTHER depts'
  // current effective lists (this dept's new row isn't written yet). ---
  const queueWarnings = [];
  if (qcdQueues.length) {
    const otherDepts = allDepts.filter(function (d) { return d !== dept; });
    qcdQueues.forEach(function (q) {
      const owners = otherDepts.filter(function (d) {
        return getDeptQcdQueues_(d).indexOf(q) !== -1;
      });
      if (owners.length) {
        queueWarnings.push('Queue "' + q + '" is also mapped to: '
          + owners.join(', ') + '.');
      }
    });
  }

  // --- Overview Parent validation. ---
  if (overviewParent) {
    if (overviewParent === dept) {
      throw new Error('A department cannot be its own Overview parent.');
    }
    if (allDepts.indexOf(overviewParent) === -1) {
      throw new Error('Overview parent "' + overviewParent + '" is not a '
        + 'department. It must match a DO NOT EDIT! column header exactly.');
    }
    if (dcWouldCreateParentCycle_(dept, overviewParent)) {
      throw new Error('Setting "' + overviewParent + '" as the parent of "'
        + dept + '" would create a nesting cycle.');
    }
  }

  // --- Team Avg Excludes validation: each must be on the dept roster. ---
  if (teamAvgExcludes.length) {
    const roster = {};
    getRosterForDepartment_(dept).names.forEach(function (n) { roster[n] = true; });
    const offRoster = teamAvgExcludes.filter(function (n) { return !roster[n]; });
    if (offRoster.length) {
      throw new Error('Team-avg-exclude name(s) not on the ' + dept
        + ' roster: ' + offRoster.join(', ')
        + '. Names must match a DO NOT EDIT! roster entry exactly.');
    }
  }

  // --- Queue Ext Overrides validation: digit-only tokens (queue
  // extensions are numeric, per parseExtensions_ in Data.gs). ---
  if (queueExtOverrides.length) {
    const nonNumeric = queueExtOverrides.filter(function (x) { return !/^\d+$/.test(x); });
    if (nonNumeric.length) {
      throw new Error('Queue ext override(s) must be digits only: '
        + nonNumeric.join(', ') + '. These are numeric queue extensions '
        + '(e.g. 103, 108), not queue names.');
    }
  }

  const admin = Session.getActiveUser().getEmail();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  try {
    upsertDeptConfigRow_({
      dept:              dept,
      qcdQueues:         qcdQueues,
      overviewParent:    overviewParent,
      teamAvgExcludes:   teamAvgExcludes,
      queueExtOverrides: queueExtOverrides,
      active:            active,
      notes:             notes,
      admin:             admin,
    });
    dcBustCaches_();
  } finally {
    lock.releaseLock();
  }
  return { saved: true, warnings: queueWarnings };
}

/**
 * Soft-removes a dept's config row (Active=FALSE), reverting the dept
 * to pure constant behavior. Hard deletion is intentionally not
 * exposed via RPC -- edit the sheet directly. Returns the count of
 * rows deactivated.
 */
function removeDeptConfig(req) {
  assertAdmin_();
  const dept = String((req && req.dept) || '').trim();
  if (!dept) throw new Error('Department is required.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  let removed = 0;
  try {
    removed = deactivateDeptConfig_(dept);
    dcBustCaches_();
  } finally {
    lock.releaseLock();
  }
  return { removed: removed };
}

// -- Write helpers (trailing underscore; RPC-unreachable) ----------

function upsertDeptConfigRow_(rec) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.DEPT_CONFIG);
  if (!sheet) throw new Error('Dept Config sheet missing -- run setup().');
  const lastRow = sheet.getLastRow();
  const now = new Date();

  let existingRow = -1;
  if (lastRow >= 2) {
    const col = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < col.length; i++) {
      if (String(col[i][0] || '').trim() === rec.dept) { existingRow = i + 2; break; }
    }
  }
  const rowValues = [
    rec.dept,
    rec.qcdQueues.join(', '),
    rec.overviewParent || '',
    rec.teamAvgExcludes.join(', '),
    rec.queueExtOverrides.join(', '),
    rec.active ? 'TRUE' : 'FALSE',
    rec.admin || '',
    now,
    rec.notes || '',
  ];
  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
  DEPT_CONFIG_ROWS_MEMO_ = null;   // force fresh read next accessor call
}

function deactivateDeptConfig_(dept) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.DEPT_CONFIG);
  if (!sheet) return 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const range = sheet.getRange(2, 1, lastRow - 1, DEPT_CONFIG_HEADERS.length);
  const values = range.getValues();
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === dept && dcIsActive_(values[i][5])) {
      values[i][5] = 'FALSE';
      count++;
    }
  }
  if (count > 0) range.setValues(values);
  DEPT_CONFIG_ROWS_MEMO_ = null;
  return count;
}

/**
 * Busts the single fixed-key Overview cache so a config change shows
 * up on the landing page immediately (matches OrphanFix.gs). The
 * per-(dept, range) QCD / report caches are left to TTL out within
 * 30 minutes (REPORT_CACHE_TTL_SECONDS) -- enumerating their compound
 * keys isn't practical.
 */
function dcBustCaches_() {
  try { CacheService.getScriptCache().remove(COMPANY_OVERVIEW_CACHE_KEY); }
  catch (e) { /* best-effort */ }
}

// -- Validators / parsers ------------------------------------------

/**
 * Walks the merged parent map (with the proposed dept->parent edge
 * added) from `parent` upward and returns true if it reaches `dept`
 * -- i.e. the edit would create a cycle. Uses a visited-set so it
 * terminates even if the map already contains a cycle that does NOT
 * close back on `dept` (the old fixed 50-hop cap would spin to the cap
 * and wrongly return false in that case); any loop encountered is
 * treated as cyclic and rejected.
 */
function dcWouldCreateParentCycle_(dept, parent) {
  const map = getOverviewParentMap_();
  map[dept] = parent;
  let cur = parent;
  const seen = {};
  while (cur) {
    if (cur === dept) return true;   // proposed edge closes a cycle on dept
    if (seen[cur]) return true;      // hit a pre-existing loop -> reject as cyclic
    seen[cur] = true;
    cur = map[cur];
  }
  return false;
}

/** Splits a comma-separated cell into a trimmed, de-duped, order-preserving list. */
function dcParseList_(raw) {
  const s = String(raw == null ? '' : raw);
  const seen = {};
  const out = [];
  s.split(',').forEach(function (tok) {
    const t = tok.trim();
    if (t && !seen[t]) { seen[t] = true; out.push(t); }
  });
  return out;
}

/**
 * Normalizes a list input that may arrive as an array (from the
 * client) or a comma-separated string. Trims, de-dupes, length-caps,
 * and rejects oversized input. Returns a clean string[].
 */
function dcNormalizeList_(raw, label) {
  let list;
  if (Array.isArray(raw)) {
    const seen = {};
    list = [];
    raw.forEach(function (tok) {
      const t = String(tok == null ? '' : tok).trim();
      if (t && !seen[t]) { seen[t] = true; list.push(t); }
    });
  } else {
    list = dcParseList_(raw);
  }
  const joined = list.join(', ');
  if (joined.length > DEPT_CONFIG_MAX_FIELD_LENGTH) {
    throw new Error((label || 'Field') + ' is too long.');
  }
  return list;
}

/** TRUE unless the cell is an explicit falsey marker (mirrors readAgentAliases_). */
function dcIsActive_(raw) {
  return !(raw === false || raw === 'FALSE' || raw === 'false'
        || raw === 0 || raw === 'no' || raw === 'No');
}
