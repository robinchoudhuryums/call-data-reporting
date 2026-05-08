/**
 * Department Dashboard - web app entry point.
 *
 * Build is incremental:
 *   Step A (this file): doGet renders the resolved identity so the
 *     auth flow can be verified end-to-end before any UI.
 *   Step B: real Auth backed by Access Control sheet + access-denied page.
 *   Step C: dashboard shell with date picker and admin dept dropdown.
 *   Step D: real data layer (read, filter, aggregate, cache).
 *   Step E: roster vs queue scope toggle + diagnostics panel.
 */

function doGet(e) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);

  // Step A intentionally inlines a minimal page. Step C replaces this
  // with the real dashboard.html template via HtmlService.createTemplate.
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>Department Dashboard</title>',
    '<style>',
    'body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:640px;',
    'margin:40px auto;padding:0 20px;color:#1f2937;}',
    'h1{font-size:18px;margin:0 0 8px;}',
    'p{color:#4b5563;}',
    'pre{background:#f3f4f6;padding:14px;border-radius:6px;font-size:12px;',
    'border:1px solid #e5e7eb;overflow-x:auto;}',
    '.tag{display:inline-block;padding:2px 8px;border-radius:4px;',
    'font-size:11px;font-weight:600;margin-left:6px;vertical-align:middle;}',
    '.tag-admin{background:#dcfce7;color:#166534;}',
    '.tag-manager{background:#dbeafe;color:#1e40af;}',
    '.tag-none{background:#fee2e2;color:#991b1b;}',
    '</style></head><body>',
    '<h1>Department Dashboard',
    '<span class="tag tag-' + user.role + '">' + user.role + '</span></h1>',
    '<p>Step A identity check. If <code>email</code> below matches the ',
    'Google account you logged in with and <code>role</code> is correct, ',
    'the auth flow is wired. Step B replaces this page.</p>',
    '<pre>' + escapeHtml_(JSON.stringify(user, null, 2)) + '</pre>',
    '</body></html>',
  ].join('');

  return HtmlService
    .createHtmlOutput(html)
    .setTitle('Department Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
