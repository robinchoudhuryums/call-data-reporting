/**
 * Department Dashboard - web app entry point.
 *
 * Build is incremental:
 *   Step A: doGet renders resolved identity (admin check only).
 *   Step B: real Auth + Access Control sheet + access-denied page.
 *   Step C (this file): dashboard.html template with date picker,
 *     admin dept dropdown, sortable agent table; data wired to
 *     getDepartmentSummary (mocked in Data.gs for Step C).
 *   Step D: real data layer (read, filter, aggregate, cache).
 *   Step E: roster vs queue scope toggle + diagnostics panel.
 */

function doGet(e) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);

  if (user.role === 'none') {
    return renderAccessDenied_(user);
  }
  return renderDashboard_(user);
}

/**
 * HtmlService template include helper. Used in templates as:
 *   <?!= include('styles') ?>
 * Lets us split CSS / JS / HTML into separate files without a build.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function renderDashboard_(user) {
  const tmpl = HtmlService.createTemplateFromFile('dashboard');
  // Trim user envelope before injection: don't leak admin email list,
  // and don't ship the full departments array to managers (they only
  // need their one).
  tmpl.user = {
    email: user.email,
    role: user.role,
    department: user.department,
    departments: user.role === 'admin' ? user.departments : [],
  };
  return tmpl.evaluate()
    .setTitle('Department Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function renderAccessDenied_(user) {
  const tmpl = HtmlService.createTemplateFromFile('access_denied');
  tmpl.visitorEmail = user.email || '';
  tmpl.adminContact = ADMIN_EMAILS[0] || '';
  return tmpl.evaluate()
    .setTitle('Access Required')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
