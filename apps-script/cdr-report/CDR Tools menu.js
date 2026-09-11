// Single onOpen for the CDR Report Apps Script project. Apps Script
// shares one global scope across all .gs files, so multiple top-level
// `function onOpen()` declarations silently override each other (last
// loaded wins). All menus this project installs are built here.
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu('CDR Tools')
    .addItem('Open Extraction Sidebar', 'showSidebar')
    .addItem('📬 Send Daily Queue Report', 'emailDailyQueueReportPDF')
    .addItem('📬 Send DCTR',               'emailDCTRPDF')
    .addItem('📦 Batch Queue Reports (ZIP)', 'batchSaveQueueReports')
    .addItem('📦 Batch DCTRs (ZIP)', 'batchSaveDCTRs')
    .addSeparator()
    .addItem('📊 Update Dashboard (Run Report)', 'generateCustomReport')
    .addItem('🔍 Run Diagnostics Only', 'runDiagnosticsOnly')
    .addItem('🛠️ Reset Dashboard UI', 'createCustomReportDashboard')
    .addSeparator()
    .addSubMenu(ui.createMenu('⏰ Daily DQE Build Trigger')
      .addItem('Install (runs at 7 AM)', 'installDQEBuildTrigger')
      .addItem('Uninstall',              'uninstallDQEBuildTrigger'))
    // Batch 4 / Phase 2: the nightly date-order check over the five
    // historical sheets (sheetRepairs.js). Install arms HISTORICAL_SORT_ENABLED;
    // the outcome lands as historicalSort:<sheet> Pipeline Health rows and on
    // the dashboard Health page (Operator State #61).
    .addSubMenu(ui.createMenu('⏰ Nightly Historical Sort Check')
      .addItem('Install (runs ~3 AM, arms the flag)', 'installHistoricalSortTrigger')
      .addItem('Uninstall (clears the flag)',         'uninstallHistoricalSortTrigger')
      .addItem('Preview (read-only)',                  'previewHistoricalSortCheck')
      .addItem('Run now',                              'runHistoricalSortCheckNow'))
    .addSubMenu(ui.createMenu('⏰ Daily Inbound Export Trigger')
      .addItem('Install (runs at 9 AM)', 'installInboundExportTrigger')
      .addItem('Uninstall',              'uninstallInboundExportTrigger'))
    .addItem('📥 Refresh Inbound Calls Tab Now', 'runInboundCallsExportNow')
    .addSubMenu(ui.createMenu('⏰ Daily Outbound Export Trigger')
      .addItem('Install (runs at 9 AM)', 'installOutboundExportTrigger')
      .addItem('Uninstall',              'uninstallOutboundExportTrigger'))
    .addItem('📤 Refresh Outbound Calls Tab Now', 'runOutboundCallsExportNow')
    // Month-to-date Neon read volume for THIS project + the per-surface
    // ranking (neonEgress.js). The dashboard meters itself separately under
    // the same key; add them for a total.
    .addItem('📈 Neon Read Volume (this project)', 'showNeonEgress')
    // Read-only: does one CALL get counted by two queues? (queueOverlapAudit.js)
    .addItem('🔀 Queue Overlap Audit', 'queueOverlapAudit')
    //.addSeparator()
    //.addItem('Run Historical Transfer', 'transferDailyReportsData')
    //.addItem('Benchmark Calc Speed', 'measureCalculationSpeed')
    .addToUi();

  // DQE drill-down menu — installed via a helper in DQEdrilldown.js
  // (which used to declare its own onOpen and collide with this one).
  if (typeof installDQEDrilldownMenu_ === 'function') {
    installDQEDrilldownMenu_(ui);
  }
}
