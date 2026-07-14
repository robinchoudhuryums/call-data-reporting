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
 *     departments: string[] }
 */
function resolveUser_(email) {
  const normalized = (email || '').toLowerCase().trim();
  if (!normalized) {
    return { email: '', role: 'none', department: null, departments: [] };
  }

  if (isAdmin_(normalized)) {
    return {
      email: normalized,
      role: 'admin',
      department: null,
      departments: getAllDepartments_(),
    };
  }

  const dept = getManagerDepartment_(normalized);
  if (dept) {
    return {
      email: normalized,
      role: 'manager',
      department: dept,
      departments: [dept],
    };
  }

  return { email: normalized, role: 'none', department: null, departments: [] };
}

function isAdmin_(normalizedEmail) {
  return getAdminEmails_().some(function (a) {
    return String(a || '').toLowerCase() === normalizedEmail;
  });
}

/**
 * Reads the Access Control sheet for a manager's department. Returns
 * the department string or null. Cached per email.
 */
function getManagerDepartment_(normalizedEmail) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'access:' + normalizedEmail;
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    return cached === '__none__' ? null : cached;
  }

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
  if (!sheet || sheet.getLastRow() < 2) {
    cache.put(cacheKey, '__none__', AUTH_CACHE_TTL_SECONDS);
    return null;
  }

  // Read just the Email + Department columns.
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    const rowEmail = String(rows[i][0] || '').toLowerCase().trim();
    const rowDept = String(rows[i][1] || '').trim();
    if (rowEmail === normalizedEmail && rowDept) matches.push(rowDept);
  }
  if (matches.length) {
    // F13: the schema is one row per manager, and the dashboard pins a
    // manager to a single department (assertDeptAccess_ + the UI use the
    // singular dept). If a manager matches MULTIPLE rows with DIFFERENT
    // depts, only the first is honored -- log a warning so the ignored
    // row(s) are detectable rather than silently dropped (the operator may
    // have assumed multi-row = multi-dept).
    const distinct = matches.filter(function (d, i) { return matches.indexOf(d) === i; });
    if (distinct.length > 1) {
      Logger.log('getManagerDepartment_: %s matches %s Access Control depts (%s); using the '
        + 'first (%s). Managers are pinned to one dept -- remove the extra row(s), or grant '
        + 'admin for cross-dept access.', normalizedEmail, distinct.length,
        distinct.join(', '), matches[0]);
    }
    cache.put(cacheKey, matches[0], AUTH_CACHE_TTL_SECONDS);
    return matches[0];
  }

  cache.put(cacheKey, '__none__', AUTH_CACHE_TTL_SECONDS);
  return null;
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
  return { rows: rows, departments: getAllDepartments_(), adminEmails: getAdminEmails_() };
}

/**
 * Upsert a manager keyed by EMAIL (lowercased). A manager is pinned to one
 * dept, so save sets that email's single row -- updating the FIRST matching
 * row's dept/notes if present (logging if there were stray duplicates),
 * else appending. Validates email shape + a real department.
 */
function saveAccessControlRow(req) {
  assertAdmin_();
  const email = String((req && req.email) || '').trim();
  const department = String((req && req.department) || '').trim();
  const notes = String((req && req.notes) || '').trim().slice(0, 500);
  if (!acIsValidEmail_(email)) throw new Error('Enter a valid email address.');
  if (!department) throw new Error('Department is required.');
  if (getAllDepartments_().indexOf(department) === -1) {
    throw new Error('"' + department + '" is not a department. It must match a '
      + 'DO NOT EDIT! roster column header exactly.');
  }
  const normalized = email.toLowerCase();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Could not acquire script lock; try again.');
  try {
    const ss = openSpreadsheet_();
    let sheet = ss.getSheetByName(SHEETS.ACCESS_CONTROL);
    if (!sheet) throw new Error('Access Control sheet missing -- run setup().');
    const lastRow = sheet.getLastRow();
    let firstMatch = -1, dupes = 0;
    if (lastRow >= 2) {
      const col = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < col.length; i++) {
        if (String(col[i][0] || '').toLowerCase().trim() === normalized) {
          if (firstMatch === -1) firstMatch = i + 2; else dupes++;
        }
      }
    }
    // CORE-7 + L4: neutralize formula-leading values on ALL three admin-entered
    // columns. `department` is roster-validated (real header, safe) but wrapped
    // for uniformity; `email` MUST be wrapped -- acIsValidEmail_'s regex
    // (`[^@\s]+@...`) admits a formula-leading address like `=cmd|'..'!A1@x.com`,
    // which under "Execute as: Me" would evaluate as a live cell in a sheet read
    // on every request. A normal email passes through unchanged.
    if (firstMatch > 0) {
      sheet.getRange(firstMatch, 1, 1, 3).setValues([[sheetSafeCell_(email), sheetSafeCell_(department), sheetSafeCell_(notes)]]);
      if (dupes > 0) Logger.log('saveAccessControlRow: %s had %s duplicate row(s); updated the first only.', normalized, dupes);
    } else {
      sheet.appendRow([sheetSafeCell_(email), sheetSafeCell_(department), sheetSafeCell_(notes)]);
    }
    CacheService.getScriptCache().remove('access:' + normalized);
    Logger.log('saveAccessControlRow: %s -> %s by %s', normalized, department, Session.getActiveUser().getEmail());
  } finally {
    lock.releaseLock();
  }
  return { saved: true };
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
