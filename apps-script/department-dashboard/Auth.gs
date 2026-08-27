/**
 * Identity resolution.
 *
 * Hybrid model:
 *   - Admins are resolved at request time via getAdminEmails_
 *     (Config.gs) -- reads the ADMIN_EMAILS Script Property if set,
 *     else falls back to ADMIN_EMAILS_FALLBACK. Adding an admin is a
 *     Script Property edit; no redeploy required.
 *   - Managers are looked up in the Access Control sheet, whose
 *     columns are Email | Department | Notes | Role | Agent Name
 *     (Role blank = manager; 'agent' = the fourth role). One row per
 *     manager per dept. Email match is case-insensitive after trim.
 *   - Anyone else gets role 'none' and the access-denied page.
 *
 * Access-control reads are cached for AUTH_CACHE_TTL_SECONDS (60s) so a
 * busy dashboard doesn't hammer the sheet, while keeping new-manager
 * onboarding nearly real-time.
 *
 * Shape:
 *   { email, role: 'admin'|'manager'|'none', department: string|null,
 *     departments: string[], allDepts: boolean }
 *
 * All-departments manager (#1): an Access Control row whose Department cell is
 * the sentinel "ALL" (or "*") grants a manager who sees EVERY department's
 * non-admin data -- the same data breadth as an admin, but NOT admin surfaces
 * (Alerts/Dept Config/Outlier Fix/etc. stay `role === 'admin'`-gated). It is
 * `role: 'manager'` with `allDepts: true`, so every admin-surface check keeps
 * excluding it automatically; data-breadth gates opt it in explicitly.
 *
 * MULTI-DEPARTMENT manager (Tier C): a manager may hold MORE THAN ONE Access
 * Control row (same email, different dept) -- e.g. someone who oversees two
 * teams. resolveUser_ now UNIONS those rows into `departments` (was: only the
 * first was honored, F13). `department` is the first (the default landing);
 * `allDepts` stays false (they see only their assigned depts, not every dept).
 * The security gates (assertDeptAccess_, escAssertRowAccess_) accept any dept
 * in `departments`, so single-dept managers -- whose `departments` is a
 * one-element list -- behave exactly as before (least-privilege preserved).
 *
 * ALIAS EMAILS (Tier C): in a Workspace, several addresses can route to one
 * person (e.g. john.doe@x = john@x). The optional `EMAIL_ALIASES` Script
 * Property maps `alias = canonical` pairs (comma-separated, tolerant grammar
 * like DIAL_IN_LABELS / COMPANY_HOLIDAYS); resolveUser_ canonicalizes the
 * signed-in address through it BEFORE the admin/manager lookup, so an alias
 * inherits the canonical user's role + departments. Unset = no aliasing =
 * pre-Tier-C behavior.
 */
function isAllDeptsSentinel_(s) {
  return /^(all|\*)$/i.test(String(s == null ? '' : s).trim());
}

// Memo for the parsed EMAIL_ALIASES map, KEYED on the raw property string so a
// changed property (or a fresh test) rebuilds it rather than serving a stale map.
var EMAIL_ALIASES_MEMO_ = null;
var EMAIL_ALIASES_MEMO_RAW_ = null;

/**
 * Parses the `EMAIL_ALIASES` Script Property into an { alias: canonical } map
 * (both sides lowercased/trimmed). Grammar: comma- or newline-separated
 * `alias@x = canonical@x` pairs. Tolerant (the DIAL_IN_LABELS / Skip-Dates
 * discipline): a token missing the `=`, or with a non-email-shaped side, or
 * that maps an address to itself, is silently dropped -- never throws, since
 * the property is admin-curated free text with no UI validator. Memoized per
 * execution.
 */
function parseEmailAliases_() {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty('EMAIL_ALIASES') || ''; } catch (e) { raw = ''; }
  if (EMAIL_ALIASES_MEMO_ && EMAIL_ALIASES_MEMO_RAW_ === raw) return EMAIL_ALIASES_MEMO_;
  var map = {};
  String(raw).split(/[,\n]/).forEach(function (tok) {
    var eq = tok.indexOf('=');
    if (eq === -1) return;
    var alias = tok.slice(0, eq).toLowerCase().trim();
    var canon = tok.slice(eq + 1).toLowerCase().trim();
    if (!acIsValidEmail_(alias) || !acIsValidEmail_(canon)) return;
    if (alias === canon) return;
    map[alias] = canon;
  });
  EMAIL_ALIASES_MEMO_ = map;
  EMAIL_ALIASES_MEMO_RAW_ = raw;
  return map;
}

/**
 * Resolves an alias address to its canonical form via EMAIL_ALIASES. Follows
 * at most a few hops (guarding a mis-entered A=B, B=A loop) and returns the
 * input unchanged when it isn't an alias. Input must already be normalized
 * (lowercased/trimmed).
 */
function canonicalizeEmail_(normalizedEmail) {
  var map = parseEmailAliases_();
  var cur = normalizedEmail;
  for (var hops = 0; hops < 5; hops++) {
    var next = map[cur];
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

function resolveUser_(email) {
  const normalized = (email || '').toLowerCase().trim();
  if (!normalized) {
    return { email: '', role: 'none', department: null, departments: [],
             assignedDepartments: [], allDepts: false };
  }
  // Tier C: resolve alias -> canonical BEFORE any lookup, so an alias address
  // inherits the canonical user's role + departments. The returned `email` is
  // the canonical identity (what logging / recipient lookups should use).
  const canonical = canonicalizeEmail_(normalized);

  if (isAdmin_(canonical)) {
    return {
      email: canonical,
      role: 'admin',
      department: null,
      departments: getAllDepartments_(),
      assignedDepartments: getAllDepartments_(),
      allDepts: false,
    };
  }

  const depts = getManagerDepartments_(canonical);
  if (depts.length) {
    // Any ALL/* sentinel row wins -> all-departments manager (data breadth of
    // an admin, no admin surfaces).
    if (depts.some(isAllDeptsSentinel_)) {
      return {
        email: canonical,
        role: 'manager',
        department: null,
        departments: getAllDepartments_(),
        assignedDepartments: getAllDepartments_(),
        allDepts: true,
      };
    }
    // One OR more specific depts: a single-dept manager is just the
    // one-element case (behaves exactly as before).
    //
    // SUB-QUEUE EXPANSION (Phase 0). `departments` is the EFFECTIVE list --
    // assigned depts plus their one-level sub-queues (Overview parent map) --
    // so every gate that already reads it (assertDeptAccess_,
    // escAssertRowAccess_, getEscalations' scoping, personalizeOverview_, the
    // client dept selector via canPickDept_) inherits the widening from one
    // place instead of six patched call sites. `assignedDepartments` keeps the
    // raw Access Control assignment for anything that needs the un-widened
    // identity. `department` stays the ASSIGNED dept, so the landing view is
    // unchanged. A dept with no children expands to itself, which makes this a
    // no-op for the 11 of 14 departments that have none.
    const effective = (typeof expandDeptsWithSubQueues_ === 'function')
      ? expandDeptsWithSubQueues_(depts)
      : depts;
    return {
      email: canonical,
      role: 'manager',
      department: depts[0],
      departments: effective,
      assignedDepartments: depts,
      allDepts: false,
    };
  }

  // Phase A (agent role, docs/agent-role-plan.md): an agent row resolves only
  // when AGENT_ROLE_ENABLED='true' (unset = denied, exactly the pre-agent
  // behavior -- the phase ships dark). MANAGER ROWS WIN: the branches above
  // returned already, so an email holding both manager and agent rows is a
  // manager. FAIL-CLOSED SHAPE: department stays null and departments stays
  // [] -- the agent's identity travels ONLY in agentDept/agentName, which no
  // pre-agent gate reads, so even a missed allowlist edit grants nothing.
  if (agentRoleEnabled_()) {
    const ag = getAgentAccessEntry_(canonical);
    if (ag) {
      return {
        email: canonical,
        role: 'agent',
        department: null,
        departments: [],
        assignedDepartments: [],
        allDepts: false,
        agentDept: ag.dept,
        agentName: ag.agentName,
      };
    }
  }

  return { email: canonical, role: 'none', department: null, departments: [],
           assignedDepartments: [], allDepts: false };
}

function isAdmin_(normalizedEmail) {
  return getAdminEmails_().some(function (a) {
    return String(a || '').toLowerCase() === normalizedEmail;
  });
}

/**
 * Reads ALL of an email's Access Control entries: [{dept, role, agentName}].
 * Phase A (agent role): the sheet now carries Role (col 4; blank = 'manager',
 * so every pre-existing 3-column row keeps meaning what it meant) and Agent
 * Name (col 5). An entry whose Role is neither manager nor agent is DROPPED
 * (fail closed -- a typo'd role grants nothing, never something unexpected).
 * Cached per email under the same 'access:' key as before; the value is now
 * a JSON list of entry objects -- a pre-deploy cached list of STRINGS fails
 * the shape check below and falls through to a fresh read (self-heals within
 * the 60s TTL, no key bump needed).
 */
function getAccessEntries_(normalizedEmail) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'access:' + normalizedEmail;
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    if (cached === '__none__') return [];
    try {
      const arr = JSON.parse(cached);
      if (Array.isArray(arr) && arr.every(function (e) { return e && typeof e === 'object' && 'dept' in e; })) {
        return arr;
      }
    } catch (e) { /* fall through to re-read */ }
  }

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
  if (!sheet || sheet.getLastRow() < 2) {
    cache.put(cacheKey, '__none__', AUTH_CACHE_TTL_SECONDS);
    return [];
  }

  // Read Email..Agent Name, bounded by the sheet's real width so a
  // pre-migration 3-column sheet reads cleanly (missing cols = '').
  const width = Math.min(Math.max(sheet.getLastColumn(), 2), ACCESS_CONTROL_HEADERS.length);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const entries = [];
  for (let i = 0; i < rows.length; i++) {
    const rowEmail = String(rows[i][0] || '').toLowerCase().trim();
    const rowDept = String(rows[i][1] || '').trim();
    if (rowEmail !== normalizedEmail || !rowDept) continue;
    const rawRole = String(rows[i][3] || '').toLowerCase().trim() || 'manager';
    if (rawRole !== 'manager' && rawRole !== 'agent') continue;   // unknown role: fail closed
    entries.push({
      dept: rowDept,
      role: rawRole,
      agentName: String(rows[i][4] || '').trim(),
    });
  }
  if (entries.length) {
    cache.put(cacheKey, JSON.stringify(entries), AUTH_CACHE_TTL_SECONDS);
    return entries;
  }

  cache.put(cacheKey, '__none__', AUTH_CACHE_TTL_SECONDS);
  return [];
}

/**
 * Distinct, sheet-order list of an email's MANAGER-role departments (empty
 * if none). Tier C union semantics unchanged -- now a filter over
 * getAccessEntries_ so manager and agent rows share one cached read.
 */
function getManagerDepartments_(normalizedEmail) {
  const matches = [];
  getAccessEntries_(normalizedEmail).forEach(function (e) {
    if (e.role === 'manager' && matches.indexOf(e.dept) === -1) matches.push(e.dept);
  });
  return matches;
}

/**
 * First VALID agent entry for an email (role 'agent' + non-empty Agent Name),
 * or null. One agent identity per email by design -- an agent belongs to one
 * roster row; a second agent row is ignored, not merged.
 */
function getAgentAccessEntry_(normalizedEmail) {
  const entries = getAccessEntries_(normalizedEmail);
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].role === 'agent' && entries[i].agentName
        && !isAllDeptsSentinel_(entries[i].dept)) {
      return entries[i];
    }
  }
  return null;
}

/** Phase A rollout gate: agents resolve only when this property is 'true'. */
function agentRoleEnabled_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty('AGENT_ROLE_ENABLED') || '') === 'true';
  } catch (e) { return false; }
}

/**
 * Returns all department names from the DO NOT EDIT! sheet's right
 * block. Headers are read from ROSTER.HEADER_ROW starting at
 * ROSTER.DEPT_FIRST_COL. The dept block ends at the first blank cell
 * -- anything past that gap (e.g., the unrelated reference data
 * currently in cols X-AG) is ignored.
 */
function getAllDepartments_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ROSTER);
  if (!sheet) return [];

  const lastCol = sheet.getLastColumn();
  if (lastCol < ROSTER.DEPT_FIRST_COL) return [];

  const headerRow = sheet
    .getRange(ROSTER.HEADER_ROW, ROSTER.DEPT_FIRST_COL,
              1, lastCol - ROSTER.DEPT_FIRST_COL + 1)
    .getValues()[0];

  const depts = [];
  for (let i = 0; i < headerRow.length; i++) {
    const v = String(headerRow[i] || '').trim();
    if (!v) break; // first blank ends the dept block
    depts.push(v);
  }
  return depts;
}

/**
 * Editor-only helper: clears a cached access lookup for a given email.
 * Useful if you just added someone to Access Control and don't want to
 * wait the 60s TTL. Run from the Apps Script editor.
 */
function invalidateAuthCache_(email) {
  const normalized = (email || '').toLowerCase().trim();
  if (!normalized) return;
  CacheService.getScriptCache().remove('access:' + normalized);
  Logger.log('Cleared auth cache for %s', normalized);
}

// -- Access Control admin editor (C1) ------------------------------------
// Manager onboarding used to mean hand-editing the Access Control SHEET
// ("add a row, wait 60 s"). These admin-only RPCs replace that with the
// Access Control modal. They write the SHEET (NOT Neon) deliberately:
// Access Control is the auth hot path read by resolveUser_ on every request,
// and the sheet -- in the dashboard's own spreadsheet -- is the most
// always-available store the script has (Neon free-tier can scale-to-zero),
// so it stays the source of truth for auth (see docs/ui-infra-roadmap.md C1).
// Managers only -- admins live in the ADMIN_EMAILS Script Property, so the
// editor can't lock an admin out. INV-01 config-write mitigations:
// assertAdmin_ + input validation + LockService (+ a Logger.log audit line);
// each write busts the per-email auth cache so the change is immediate.

/** Loose email shape check (presentation-layer guard; not RFC-complete). */
function acIsValidEmail_(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());
}

/**
 * Roster names for one department (INV-03: everything before the first comma
 * of each cell in that dept's DO NOT EDIT! column). Used to validate an agent
 * row's Agent Name at save time -- the name must match a roster entry EXACTLY
 * (INV-04), or the agent's own row lookup would silently never match.
 */
function acRosterNamesForDept_(dept) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ROSTER);
  if (!sheet) return [];
  const depts = getAllDepartments_();
  const idx = depts.indexOf(dept);
  if (idx === -1) return [];
  const col = ROSTER.DEPT_FIRST_COL + idx;
  const lastRow = sheet.getLastRow();
  if (lastRow < ROSTER.DATA_START_ROW) return [];
  const vals = sheet.getRange(ROSTER.DATA_START_ROW, col, lastRow - ROSTER.DATA_START_ROW + 1, 1).getValues();
  const names = [];
  for (let i = 0; i < vals.length; i++) {
    const cell = String(vals[i][0] || '').trim();
    if (!cell) continue;
    const name = cell.split(',')[0].trim();
    if (name && names.indexOf(name) === -1) names.push(name);
  }
  return names;
}

/**
 * Phase B: every dept's roster names in ONE sheet read (the modal's agent
 * picker source). {dept: [names]} -- INV-03 name-before-comma per cell.
 */
function acRosterNamesByDept_() {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ROSTER);
  const out = {};
  if (!sheet) return out;
  const depts = getAllDepartments_();
  if (!depts.length) return out;
  const lastRow = sheet.getLastRow();
  if (lastRow < ROSTER.DATA_START_ROW) { depts.forEach(function (d) { out[d] = []; }); return out; }
  const grid = sheet.getRange(ROSTER.DATA_START_ROW, ROSTER.DEPT_FIRST_COL,
    lastRow - ROSTER.DATA_START_ROW + 1, depts.length).getValues();
  depts.forEach(function (d, c) {
    const names = [];
    for (let r = 0; r < grid.length; r++) {
      const cell = String(grid[r][c] || '').trim();
      if (!cell) continue;
      const name = cell.split(',')[0].trim();
      if (name && names.indexOf(name) === -1) names.push(name);
    }
    out[d] = names;
  });
  return out;
}

/**
 * Phase A: heal a pre-agent Access Control sheet's header row in place --
 * installs created before the Role/Agent Name columns have a 3-header row,
 * and setup() only writes headers on CREATE. Widens the grid first (REP-10:
 * a getRange past getMaxColumns throws). Idempotent; called from the
 * admin-gated editor writes only.
 */
function acEnsureSchema_(sheet) {
  const want = ACCESS_CONTROL_HEADERS.length;
  if (sheet.getMaxColumns() < want) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), want - sheet.getMaxColumns());
  }
  const have = sheet.getRange(1, 1, 1, want).getValues()[0];
  for (let i = 0; i < want; i++) {
    if (String(have[i] || '').trim() !== ACCESS_CONTROL_HEADERS[i]) {
      sheet.getRange(1, 1, 1, want).setValues([ACCESS_CONTROL_HEADERS.slice()]);
      return;
    }
  }
}

function getAccessControlInit() {
  assertAdmin_();
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
  const rows = [];
  if (sheet && sheet.getLastRow() >= 2) {
    // Width-bounded read: a pre-agent 3-column sheet reads cleanly (Role /
    // Agent Name come back '' -> role defaults to 'manager').
    const width = Math.min(Math.max(sheet.getLastColumn(), 2), ACCESS_CONTROL_HEADERS.length);
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
    for (let i = 0; i < vals.length; i++) {
      const email = String(vals[i][0] || '').trim();
      if (!email) continue;
      rows.push({
        email: email,
        department: String(vals[i][1] || '').trim(),
        notes: String(vals[i][2] || '').trim(),
        role: String(vals[i][3] || '').toLowerCase().trim() || 'manager',
        agentName: String(vals[i][4] || '').trim(),
      });
    }
    rows.sort(function (a, b) { return a.email.toLowerCase().localeCompare(b.email.toLowerCase()); });
  }
  // Tier C: also return a GROUPED view (one entry per email with its full
  // dept list) so the editor can render + edit multi-department managers.
  // `rows` (raw, one per row) is kept unchanged for back-compat. Agent rows
  // (Phase A) are listed separately -- they are one-dept identities, not
  // dept-list managers, and the modal renders them as their own section.
  const byEmail = {};
  const managers = [];
  const agents = [];
  rows.forEach(function (r) {
    if (r.role === 'agent') {
      agents.push({ email: r.email, department: r.department, agentName: r.agentName, notes: r.notes });
      return;
    }
    if (r.role !== 'manager') return;   // unknown role: surfaced nowhere, grants nothing
    const key = r.email.toLowerCase();
    if (!byEmail[key]) {
      byEmail[key] = { email: r.email, departments: [], notes: r.notes || '' };
      managers.push(byEmail[key]);
    }
    if (r.department && byEmail[key].departments.indexOf(r.department) === -1) {
      byEmail[key].departments.push(r.department);
    }
    if (!byEmail[key].notes && r.notes) byEmail[key].notes = r.notes;
  });
  return { rows: rows, managers: managers, agents: agents,
           departments: getAllDepartments_(), adminEmails: getAdminEmails_(),
           agentRoleEnabled: agentRoleEnabled_(),
           // Phase B: the modal's agent-name picker source (one roster read).
           rosterNamesByDept: acRosterNamesByDept_() };
}

/**
 * Set a manager's departments (Tier C: replace-all by EMAIL). Accepts
 * `req.departments` (an array) OR the legacy single `req.department`. Every
 * dept must be a real roster header OR the "ALL"/"*" sentinel (stored
 * canonically as "ALL", which is EXCLUSIVE -- if present, the manager gets a
 * single ALL row). All of the email's existing rows are removed and one row
 * per resolved dept is appended, so re-saving can't silently collapse a
 * multi-dept manager (nor leave stray duplicates). Validates BEFORE any write.
 */
function saveAccessControlRow(req) {
  assertAdmin_();
  const email = String((req && req.email) || '').trim();
  const notes = String((req && req.notes) || '').trim().slice(0, 500);
  // Phase A: role defaults to 'manager' (every existing caller / row keeps
  // meaning what it meant); 'agent' rows carry an Agent Name.
  const role = String((req && req.role) || 'manager').toLowerCase().trim();
  if (role !== 'manager' && role !== 'agent') {
    throw new Error('Role must be "manager" or "agent".');
  }
  const agentName = String((req && req.agentName) || '').trim();
  // Accept an array (departments) or the legacy single department.
  let requested = [];
  if (req && Array.isArray(req.departments)) requested = req.departments;
  else if (req && req.department != null) requested = [req.department];
  requested = requested.map(function (d) { return String(d || '').trim(); }).filter(Boolean);

  if (!acIsValidEmail_(email)) throw new Error('Enter a valid email address.');
  if (!requested.length) throw new Error('Pick at least one department.');

  // Validate + canonicalize. ALL/* is the all-departments sentinel and is
  // EXCLUSIVE: if any requested value is the sentinel, the stored set is
  // exactly ["ALL"] (mixing ALL with specific depts is meaningless).
  const allDepts = getAllDepartments_();
  let toStore = [];
  const hasAll = requested.some(isAllDeptsSentinel_);
  if (hasAll) {
    toStore = ['ALL'];
  } else {
    requested.forEach(function (d) {
      if (allDepts.indexOf(d) === -1) {
        throw new Error('"' + d + '" is not a department. It must match a '
          + 'DO NOT EDIT! roster column header exactly, or be "ALL" for '
          + 'all-department (read-only, no admin surfaces) access.');
      }
      if (toStore.indexOf(d) === -1) toStore.push(d);
    });
  }

  // Agent rows: ONE real dept (an agent is one roster identity, never ALL),
  // and the Agent Name must exist on that dept's roster EXACTLY (INV-04) --
  // a near-miss name would silently never match a data row.
  if (role === 'agent') {
    if (hasAll) throw new Error('An agent row needs a specific department, not ALL.');
    if (toStore.length !== 1) throw new Error('An agent row needs exactly one department.');
    if (!agentName) throw new Error('An agent row needs the Agent Name (exact roster spelling).');
    const rosterNames = acRosterNamesForDept_(toStore[0]);
    if (rosterNames.indexOf(agentName) === -1) {
      throw new Error('"' + agentName + '" is not on the ' + toStore[0] + ' roster. '
        + 'The Agent Name must match the DO NOT EDIT! entry exactly (the part before the first comma).');
    }
  }
  const normalized = email.toLowerCase();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  try {
    const ss = openSpreadsheet_();
    let sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
    if (!sheet) throw new Error('Access Control sheet missing -- run setup().');
    acEnsureSchema_(sheet);   // Phase A: heal a pre-agent 3-column header row
    // Replace-all: delete every existing row for this email (bottom-up so
    // indices don't shift), then append one row per resolved dept.
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const col = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = col.length - 1; i >= 0; i--) {
        if (String(col[i][0] || '').toLowerCase().trim() === normalized) {
          sheet.deleteRow(i + 2);
        }
      }
    }
    // CORE-7 + L4: neutralize formula-leading values on ALL admin-entered
    // columns. Depts are roster-validated (real header / ALL, safe) but wrapped
    // for uniformity; `email` MUST be wrapped -- acIsValidEmail_'s regex
    // (`[^@\s]+@...`) admits a formula-leading address like `=cmd|'..'!A1@x.com`,
    // which under "Execute as: Me" would evaluate as a live cell in a sheet read
    // on every request. A normal email passes through unchanged.
    toStore.forEach(function (d) {
      sheet.appendRow([sheetSafeCell_(email), sheetSafeCell_(d), sheetSafeCell_(notes),
                       sheetSafeCell_(role), sheetSafeCell_(role === 'agent' ? agentName : '')]);
    });
    CacheService.getScriptCache().remove('access:' + normalized);
    Logger.log('saveAccessControlRow: %s -> [%s] role=%s%s by %s', normalized, toStore.join(', '),
      role, role === 'agent' ? (' agent=' + agentName) : '', Session.getActiveUser().getEmail());
  } finally {
    lock.releaseLock();
  }
  return { saved: true, departments: toStore, role: role };
}

/** Remove ALL Access Control rows for an email (revokes manager access). */
function removeAccessControlRow(req) {
  assertAdmin_();
  const email = String((req && req.email) || '').trim();
  if (!email) throw new Error('Email is required.');
  const normalized = email.toLowerCase();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  let removed = 0;
  try {
    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
    if (!sheet || sheet.getLastRow() < 2) return { removed: 0 };
    // Delete bottom-up so row indices don't shift mid-loop.
    const col = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (let i = col.length - 1; i >= 0; i--) {
      if (String(col[i][0] || '').toLowerCase().trim() === normalized) {
        sheet.deleteRow(i + 2);
        removed++;
      }
    }
    CacheService.getScriptCache().remove('access:' + normalized);
    Logger.log('removeAccessControlRow: removed %s row(s) for %s by %s', removed, normalized, Session.getActiveUser().getEmail());
  } finally {
    lock.releaseLock();
  }
  return { removed: removed };
}

// ── R18d: sign-in notifications (first sighting + outcome change) ──────────
//
// Emails the admins when an email address reaches doGet for the FIRST time,
// and again if that address's OUTCOME CLASS later changes (denied -> manager
// after an Access Control row is added; manager -> denied after removal; a
// role change). Repeat visits with an unchanged outcome are silent -- the
// point is "who showed up / who was turned away", not a page-view log.
//
// State: the LOGIN_NOTIFY_SEEN Script Property, JSON { emailLower: outcomeKey }.
// Outcome keys are COARSE on purpose ('admin' | 'manager' | 'denied' --
// manager keys carry the dept list so a dept reassignment notifies too).
// Capped so a scanner hammering the URL with junk identities cannot grow the
// property unboundedly: past LOGIN_NOTIFY_MAX_KEYS the store stops ADDING
// (existing users keep change-detection; brand-new addresses still email
// every visit rather than silently dropping -- the failure mode is extra
// signal, not lost signal).
//
// Gate: ON by default (the owner asked for it); set the LOGIN_NOTIFY_ENABLED
// Script Property to 'false' to silence it without a redeploy. Best-effort
// end to end: called inside doGet's try/catch, never blocks a render.
// INV-01 note: writes a Script Property only -- no spreadsheet write.

var LOGIN_NOTIFY_MAX_KEYS = 300;

/** Pure decision core (tests/unit/login-notify.test.js). */
function loginNotifyDecide_(storeJson, emailLower, outcomeKey, maxKeys) {
  var store = {};
  try { store = JSON.parse(storeJson || '{}') || {}; } catch (e) { store = {}; }
  var prev = store[emailLower];
  if (prev === outcomeKey) return { notify: false, reason: null, store: store };
  var reason = (prev === undefined) ? 'first' : 'changed';
  var cap = maxKeys || LOGIN_NOTIFY_MAX_KEYS;
  var evicted = null;
  if (prev === undefined && Object.keys(store).length >= cap) {
    // Store full. This used to notify WITHOUT recording, on the reasoning that
    // extra emails beat silent blindness -- but "don't record" means the same
    // address is a first sighting again on its very next visit, so the branch
    // emailed on EVERY page view, forever, for every address past the cap. The
    // MailApp daily quota is shared with alerts, digests and the queue report,
    // so the extra signal is paid for by the channel that carries the real
    // signal -- the failure mode it was trying to avoid, one level down.
    //
    // Evict the OLDEST entry instead (JS preserves string-key insertion order,
    // so the first key is the earliest recorded) and record the new address.
    // The store stays bounded, a new address still notifies exactly ONCE, and
    // known users keep change-detection.
    //
    // Trade-off, accepted: a long-dormant address evicted by churn re-notifies
    // as a "first sighting" on its next visit. That is one duplicate email per
    // eviction cycle, not one per page view, and the cap is 300 against a <20
    // user install -- reaching it at all means something unusual is happening,
    // which is itself worth an email.
    var oldest = Object.keys(store)[0];
    if (oldest !== undefined) { delete store[oldest]; evicted = oldest; }
  }
  store[emailLower] = outcomeKey;
  return { notify: true, reason: reason, prev: prev, store: store, evicted: evicted };
}

/** Maps a resolved user to the coarse outcome key the store compares. */
function loginNotifyOutcomeKey_(user) {
  if (!user || user.role === 'none') return 'denied';
  if (user.role === 'admin') return 'admin';
  if (user.role === 'agent') return 'agent:' + (user.agentDept || '?');
  var depts = (user.departments && user.departments.length)
    ? user.departments.slice().sort().join('+')
    : (user.department || '?');
  return 'manager:' + (user.allDepts ? 'ALL' : depts);
}

function notifyLoginEvent_(email, user) {
  var props = PropertiesService.getScriptProperties();
  if (String(props.getProperty('LOGIN_NOTIFY_ENABLED') || 'true') === 'false') return;
  var emailLower = String(email || '').trim().toLowerCase();
  if (!emailLower) return;   // no identity resolved -- nothing meaningful to report

  var outcomeKey = loginNotifyOutcomeKey_(user);
  var d = loginNotifyDecide_(props.getProperty('LOGIN_NOTIFY_SEEN'), emailLower, outcomeKey);
  if (!d.notify) return;

  // P14 (OPS-1): record the sighting as seen only AFTER a confirmed send.
  // The store was written first, so an empty admin list or a MailApp throw
  // (quota-exhausted morning) permanently burned the one-shot -- the
  // first-sighting / outcome-change / DENIED-attempt email for that address
  // was never retried. Leaving the store untouched means the next request
  // from that address re-decides and re-attempts. (Two concurrent doGets can
  // now both send -- a duplicate email is the accepted cost; the store's
  // unlocked read-modify-write already had that race.)
  var to = getAdminEmails_().join(',');
  if (!to) return;
  var denied = outcomeKey === 'denied';
  var subject = denied
    ? '[Dashboard] DENIED sign-in attempt: ' + emailLower
    : '[Dashboard] ' + (d.reason === 'first' ? 'First sign-in' : 'Access changed') + ': ' + emailLower;
  var lines = [
    'Address:  ' + emailLower,
    'Outcome:  ' + outcomeKey + (d.prev !== undefined ? '  (was: ' + d.prev + ')' : '  (first sighting)'),
    'Time:     ' + new Date(),
  ];
  if (denied) {
    lines.push('', 'To grant access: add an Access Control row for this address '
      + '(Admin ▸ Access) — the email match is case-insensitive here but the '
      + 'stored row is what resolveUser_ reads. If this address is an alias of an '
      + 'existing user, map it in the EMAIL_ALIASES Script Property instead '
      + '(Operator State #36).');
    lines.push('', 'Unrecognized addresses hitting this URL repeatedly without a grant '
      + 'may just be a crawler — the store notifies once per address, not per hit.');
  }
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: lines.join('\n') });
  } catch (e) {
    Logger.log('notifyLoginEvent_: send FAILED (%s) -- sighting NOT recorded, will retry on the next hit.',
      (e && e.message) || e);
    return;
  }
  props.setProperty('LOGIN_NOTIFY_SEEN', JSON.stringify(d.store));
  Logger.log('notifyLoginEvent_: %s (%s, %s)', emailLower, outcomeKey, d.reason);
}
