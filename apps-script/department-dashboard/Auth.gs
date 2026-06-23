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
