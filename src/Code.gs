/**
 * Department Dashboard - web app entry point.
 *
 * Build is incremental:
 *   Step A: doGet renders resolved identity (admin check only).
 *   Step B (this file): doGet branches on role:
 *     - admin / manager  -> identity confirmation + dept summary stub
 *     - none             -> access-denied page with their email
 *   Step C: dashboard shell with date picker and admin dept dropdown.
 *   Step D: real data layer (read, filter, aggregate, cache).
 *   Step E: roster vs queue scope toggle + diagnostics panel.
 */

function doGet(e) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);

  if (user.role === 'none') {
    return renderAccessDenied_(user);
  }
  return renderIdentityStub_(user);
}

/**
 * Step B placeholder for the dashboard. Confirms role + department
 * resolution worked end-to-end against the Access Control sheet.
 * Replaced by the real dashboard.html template in Step C.
 */
function renderIdentityStub_(user) {
  const deptLine = user.role === 'admin'
    ? 'Admin - all departments visible (' + user.departments.length + ' found)'
    : 'Department: ' + (user.department || '(none)');

  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>Department Dashboard</title>',
    '<style>',
    BASE_STYLES_,
    '.tag-admin{background:#dcfce7;color:#166534;}',
    '.tag-manager{background:#dbeafe;color:#1e40af;}',
    '</style></head><body>',
    '<div class="card">',
    '<h1>Department Dashboard',
    '<span class="tag tag-' + user.role + '">' + user.role + '</span></h1>',
    '<p class="muted">Step B identity check. Role and department resolved ',
    'from the Access Control sheet (or the admin allowlist).</p>',
    '<p><strong>' + escapeHtml_(deptLine) + '</strong></p>',
    '<pre>' + escapeHtml_(JSON.stringify(user, null, 2)) + '</pre>',
    '<p class="muted">Step C will replace this with the real dashboard ',
    '(date picker, agent table, totals).</p>',
    '</div></body></html>',
  ].join('');

  return HtmlService
    .createHtmlOutput(html)
    .setTitle('Department Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Access-denied page. Shows the visitor's email and an admin contact
 * so they can request access without leaving the page guessing. No
 * sensitive data is leaked: we don't list who else has access, what
 * departments exist, or expose any spreadsheet contents.
 */
function renderAccessDenied_(user) {
  const adminContact = ADMIN_EMAILS[0] || '';
  const visitorEmail = user.email || '(not detected)';

  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>Access Required - Department Dashboard</title>',
    '<style>',
    BASE_STYLES_,
    '.denied{border-left:4px solid #ef4444;}',
    '.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;',
    'margin:16px 0;font-size:13px;}',
    '.kv dt{color:#6b7280;font-weight:500;}',
    '.kv dd{margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;}',
    '.btn{display:inline-block;padding:8px 14px;background:#1f2937;',
    'color:#fff;text-decoration:none;border-radius:6px;font-size:13px;',
    'font-weight:500;}',
    '.btn:hover{background:#111827;}',
    '</style></head><body>',
    '<div class="card denied">',
    '<h1>Access required</h1>',
    '<p>Your Google account isn\'t mapped to a department in the ',
    'dashboard\'s access list. To request access, send your email ',
    'address (below) to your admin.</p>',
    '<dl class="kv">',
    '<dt>Your email</dt><dd>' + escapeHtml_(visitorEmail) + '</dd>',
    (adminContact
      ? '<dt>Admin contact</dt><dd>' + escapeHtml_(adminContact) + '</dd>'
      : ''),
    '</dl>',
    (adminContact
      ? '<p><a class="btn" href="mailto:' + escapeHtml_(adminContact) +
        '?subject=' + encodeURIComponent('Department Dashboard access request') +
        '&body=' + encodeURIComponent(
          'Please add ' + visitorEmail + ' to the dashboard access list.'
        ) + '">Email admin</a></p>'
      : ''),
    (visitorEmail === '(not detected)'
      ? '<p class="muted small">Note: your email could not be detected. ' +
        'This usually means the web app deployment is not restricted to ' +
        'a Google Workspace domain, or you\'re signed in with a personal ' +
        'Google account outside the deployer\'s domain.</p>'
      : ''),
    '</div></body></html>',
  ].join('');

  return HtmlService
    .createHtmlOutput(html)
    .setTitle('Access Required')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Shared baseline styles used by Step A/B inline pages. Step C moves
// styling into the styles.html include.
const BASE_STYLES_ = [
  'body{font:14px/1.55 -apple-system,system-ui,Segoe UI,sans-serif;',
  'background:#f9fafb;color:#1f2937;margin:0;padding:40px 20px;}',
  '.card{max-width:640px;margin:0 auto;background:#fff;padding:28px 32px;',
  'border:1px solid #e5e7eb;border-radius:10px;',
  'box-shadow:0 1px 2px rgba(0,0,0,.04);}',
  'h1{font-size:18px;margin:0 0 10px;}',
  '.muted{color:#6b7280;}',
  '.small{font-size:12px;}',
  'pre{background:#f3f4f6;padding:12px;border-radius:6px;font-size:12px;',
  'border:1px solid #e5e7eb;overflow-x:auto;margin:12px 0;}',
  '.tag{display:inline-block;padding:2px 8px;border-radius:4px;',
  'font-size:11px;font-weight:600;margin-left:6px;vertical-align:middle;',
  'text-transform:uppercase;letter-spacing:.5px;}',
].join('');

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
