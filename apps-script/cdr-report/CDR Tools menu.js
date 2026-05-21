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
