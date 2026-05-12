/**
 * Identity resolution.
 *
 * Hybrid model:
 *   - Admins are baked into ADMIN_EMAILS (Config.gs). They see all
 *     departments (admin dropdown in Step C).
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
  return ADMIN_EMAILS.some(function (a) {
    return a.toLowerCase() === normalizedEmail;
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
  for (let i = 0; i < rows.length; i++) {
    const rowEmail = String(rows[i][0] || '').toLowerCase().trim();
    const rowDept = String(rows[i][1] || '').trim();
    if (rowEmail === normalizedEmail && rowDept) {
      cache.put(cacheKey, rowDept, AUTH_CACHE_TTL_SECONDS);
      return rowDept;
    }
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
function invalidateAuthCache(email) {
  const normalized = (email || '').toLowerCase().trim();
  if (!normalized) return;
  CacheService.getScriptCache().remove('access:' + normalized);
  Logger.log('Cleared auth cache for %s', normalized);
}
