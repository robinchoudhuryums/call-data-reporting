/**
 * RETIRED (F-25, legacy decommission prep). The manual low-answer-rate
 * alert was NEUTRALIZED: its hardcoded 13-manager recipient map and
 * per-queue thresholds had drifted from the live config, and the bare
 * global was runnable by ANY spreadsheet editor via the script editor
 * (the menu item was allowlisted; this function was not), mass-emailing
 * managers with stale numbers.
 *
 * The replacement is the Department Dashboard's Alerts engine
 * (Alerts.gs: admin-gated preview + send, Alert Config thresholds and
 * recipients, Alert Log audit). Use the dashboard's Alerts modal.
 *
 * This stub is kept (instead of deleting the file) because
 * `clasp push -f` does not delete remote files (INV-17) -- a deleted
 * local file would leave the old live code running in the Apps Script
 * project. Deploying this stub overwrites it.
 */
function sendManualAlert() {
  const msg = 'This legacy tool is retired. Low-answer-rate alerts now '
    + 'live in the Department Dashboard (Alerts modal): thresholds and '
    + 'recipients come from the Alert Config sheet there, not the stale '
    + 'hardcoded list this tool used. No emails were sent.';
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    // No UI context (script-editor run): surface it in the log instead.
    Logger.log('sendManualAlert: ' + msg);
  }
}
