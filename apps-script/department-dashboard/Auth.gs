/**
 * Identity resolution.
 *
 * Hybrid model:
 *   - Admins are resolved at request time via getAdminEmails_
 *     (Config.gs) -- reads the ADMIN_EMAILS Script Property if set,
 *     else falls back to ADMIN_EMAILS_FALLBACK. Adding an admin is a
 *     Script Property edit; no redeploy required.
 *   - Managers are looked up in the Access Control sheet, which has
 *     columns: Email | Department | Notes. One row per manager. Email
 *     match is case-insensitive after trim.
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

  return { email: canonical, role: 'none', department: null, departments: [],
           assignedDepartments: [], allDepts: false };
}

function isAdmin_(normalizedEmail) {
  return getAdminEmails_().some(function (a) {
    return String(a || '').toLowerCase() === normalizedEmail;
  });
}

/**
 * Reads the Access Control sheet for ALL of a manager's departments. Returns
 * a distinct, sheet-order list of dept strings (empty if the email isn't a
 * manager). Tier C: multiple rows for one email are UNIONED (was: only the
 * first honored). Cached per email (JSON-encoded list; '__none__' sentinel
 * for no-match, matching the prior cache contract).
 */
function getManagerDepartments_(normalizedEmail) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'access:' + normalizedEmail;
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    if (cached === '__none__') return [];
    // JSON list (Tier C). A pre-deploy bare-string value (old format) fails
    // Array.isArray / JSON.parse and falls through to a fresh sheet read --
    // self-heals within the 60s TTL, no cache-key bump needed.
    try {
      const arr = JSON.parse(cached);
      if (Array.isArray(arr)) return arr;
    } catch (e) { /* fall through to re-read */ }
  }

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
  if (!sheet || sheet.getLastRow() < 2) {
    cache.put(cacheKey, '__none__', AUTH_CACHE_TTL_SECONDS);
    return [];
  }

  // Read just the Email + Department columns.
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    const rowEmail = String(rows[i][0] || '').toLowerCase().trim();
    const rowDept = String(rows[i][1] || '').trim();
    if (rowEmail === normalizedEmail && rowDept && matches.indexOf(rowDept) === -1) {
      matches.push(rowDept);
    }
  }
  if (matches.length) {
    cache.put(cacheKey, JSON.stringify(matches), AUTH_CACHE_TTL_SECONDS);
    return matches;
  }

  cache.put(cacheKey, '__none__', AUTH_CACHE_TTL_SECONDS);
  return [];
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

function getAccessControlInit() {
  assertAdmin_();
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
  const rows = [];
  if (sheet && sheet.getLastRow() >= 2) {
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, ACCESS_CONTROL_HEADERS.length).getValues();
    for (let i = 0; i < vals.length; i++) {
      const email = String(vals[i][0] || '').trim();
      if (!email) continue;
      rows.push({ email: email, department: String(vals[i][1] || '').trim(), notes: String(vals[i][2] || '').trim() });
    }
    rows.sort(function (a, b) { return a.email.toLowerCase().localeCompare(b.email.toLowerCase()); });
  }
  // Tier C: also return a GROUPED view (one entry per email with its full
  // dept list) so the editor can render + edit multi-department managers.
  // `rows` (raw, one per row) is kept unchanged for back-compat.
  const byEmail = {};
  const managers = [];
  rows.forEach(function (r) {
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
  return { rows: rows, managers: managers, departments: getAllDepartments_(), adminEmails: getAdminEmails_() };
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
  const normalized = email.toLowerCase();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  try {
    const ss = openSpreadsheet_();
    let sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
    if (!sheet) throw new Error('Access Control sheet missing -- run setup().');
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
      sheet.appendRow([sheetSafeCell_(email), sheetSafeCell_(d), sheetSafeCell_(notes)]);
    });
    CacheService.getScriptCache().remove('access:' + normalized);
    Logger.log('saveAccessControlRow: %s -> [%s] by %s', normalized, toStore.join(', '), Session.getActiveUser().getEmail());
  } finally {
    lock.releaseLock();
  }
  return { saved: true, departments: toStore };
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
  if (prev === undefined && Object.keys(store).length >= (maxKeys || LOGIN_NOTIFY_MAX_KEYS)) {
    // Store full: still notify (extra emails beat silent blindness), just
    // don't grow the property.
    return { notify: true, reason: reason, prev: prev, store: store };
  }
  store[emailLower] = outcomeKey;
  return { notify: true, reason: reason, prev: prev, store: store };
}

/** Maps a resolved user to the coarse outcome key the store compares. */
function loginNotifyOutcomeKey_(user) {
  if (!user || user.role === 'none') return 'denied';
  if (user.role === 'admin') return 'admin';
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
  props.setProperty('LOGIN_NOTIFY_SEEN', JSON.stringify(d.store));

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
  MailApp.sendEmail({ to: to, subject: subject, body: lines.join('\n') });
  Logger.log('notifyLoginEvent_: %s (%s, %s)', emailLower, outcomeKey, d.reason);
}
