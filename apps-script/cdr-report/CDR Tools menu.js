function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CDR Tools')
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
}
