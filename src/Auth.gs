/**
 * Identity resolution.
 *
 * Step A: admin check only. Returns 'admin' for ADMIN_EMAILS, 'none'
 * otherwise. Step B will add the manager path that reads from the
 * Access Control sheet.
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
  const isAdmin = ADMIN_EMAILS.some(function (a) {
    return a.toLowerCase() === normalized;
  });
  if (isAdmin) {
    return { email: normalized, role: 'admin', department: null, departments: [] };
  }
  // Manager lookup arrives in Step B.
  return { email: normalized, role: 'none', department: null, departments: [] };
}
