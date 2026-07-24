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
 *   <?!= include_('styles') ?>
 * Lets us split CSS / JS / HTML into separate files without a build.
 */
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function renderDashboard_(user) {
  const tmpl = HtmlService.createTemplateFromFile('dashboard');
  // Trim user envelope before injection: don't leak admin email list,
  // and don't ship the full departments array to managers (they only
  // need their one).
  const userObj = {
    email: user.email,
    role: user.role,
    department: user.department,
    allDepts: !!user.allDepts,
    // #1: all-departments managers get the full dept list (for the header
    // selector) + the allDepts flag. Tier C: a MULTI-dept manager (>1 assigned
    // dept) also gets their dept list so the header selector can offer their
    // subset. Single-dept managers still get neither (they use `department`).
    departments: (user.role === 'admin' || user.allDepts
                  || (user.departments && user.departments.length > 1))
      ? user.departments : [],
  };
  // Pre-escape the JSON server-side and pass as a single template
  // string. Two reasons we do this here instead of inline in the
  // template scriptlet:
  //   1. Keeps any "<" character out of the .html file entirely, so
  //      there is zero possibility of an HTML parser closing the
  //      host <script> block early (an earlier inline version had
  //      that bug -- a comment literally contained the script-end
  //      pattern).
  //   2. The escape is the recommended JSON-in-script-tag pattern:
  //      replace "<" with its JSON unicode-escape form so the
  //      browser's JS parser turns it back into "<" at runtime.
  tmpl.userJson = JSON.stringify(userObj).replace(/</g, '\\u003c');
  // Pass the deployed web-app URL through to the client so the
  // "Open in new tab" buttons on each report modal can build a
  // shareable target URL. Reads the same DASHBOARD_URL Script
  // Property the alert emails already consume; if unset, the client
  // hides the Open-in-new-tab affordance gracefully.
  const dashboardUrl = PropertiesService.getScriptProperties()
    .getProperty('DASHBOARD_URL') || '';
  tmpl.dashboardUrlJson = JSON.stringify(dashboardUrl).replace(/</g, '\\u003c');
  // Work-window pill content (E2, Phase E). Server-side so a future
  // pipeline-side window change can be picked up by editing the
  // shared dashboard Config.gs constant rather than hand-syncing a
  // hardcoded HTML string.
  tmpl.workWindowJson = JSON.stringify(DASHBOARD_WORK_WINDOW).replace(/</g, '\\u003c');
  // S5: company-holiday ranges (COMPANY_HOLIDAYS Script Property, parsed
  // server-side) so the client form hints' working-day math
  // (workingDaysBetween_) agrees with the server's countWorkingDays_ --
  // otherwise a holiday-straddling window would show a balanced hint and
  // then a length-mismatch banner on the results. [] when unset.
  let holidayRanges = [];
  try { holidayRanges = getCompanyHolidayRanges_(); } catch (e) { holidayRanges = []; }
  tmpl.companyHolidaysJson = JSON.stringify(holidayRanges).replace(/</g, '\\u003c');
  // R7 (G-3): admin UI-surface toggles (UI_FLAGS Script Property, sanitized
  // against the Config.gs registry). [] when unset; best-effort.
  let uiFlags = [];
  try { uiFlags = getUiFlags_(); } catch (e) { uiFlags = []; }
  tmpl.uiFlagsJson = JSON.stringify(uiFlags).replace(/</g, '\\u003c');
  // Admin-tunable answer-rate standards (ANSWER_TARGETS Script Property,
  // Config.gs registry) so the client's benchmark tints / headline tones /
  // chart baseline agree with the server-side digest verdict. Seed default
  // on any failure; changes apply on each viewer's next page load.
  let answerTargets = { global: ANSWER_TARGET_DEFAULT };
  try { answerTargets = getAnswerTargets_(); } catch (e) { /* seed default */ }
  tmpl.answerTargetsJson = JSON.stringify(answerTargets).replace(/</g, '\\u003c');
  return tmpl.evaluate()
    .setTitle('Department Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function renderAccessDenied_(user) {
  const tmpl = HtmlService.createTemplateFromFile('access_denied');
  tmpl.visitorEmail = user.email || '';
  tmpl.adminContact = getAdminEmails_()[0] || '';
  return tmpl.evaluate()
    .setTitle('Access Required')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
