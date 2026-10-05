// Single onOpen for the CDR Report Apps Script project. Apps Script
// shares one global scope across all .gs files, so multiple top-level
// `function onOpen()` declarations silently override each other (last
// loaded wins). All menus this project installs are built here.
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  // Grouped submenus (2026-10-05 tidy): every item is one click deep. The two
  // "which rows produced this cell?" sidebars share one submenu -- the DQE
  // drill-down used to install its own one-item "DQE Tools" menu.
  // tests/unit/cdr-tools-menus.test.js pins that every item resolves.
  const reportsSubMenu = ui.createMenu('📬 Queue & DCTR Reports')
    .addItem('Send Daily Queue Report', 'emailDailyQueueReportPDF')
    .addItem('Send DCTR',               'emailDCTRPDF')
    .addSeparator()
    .addItem('Batch Queue Reports (ZIP)', 'batchSaveQueueReports')
    .addItem('Batch DCTRs (ZIP)',         'batchSaveDCTRs');

  const customSubMenu = ui.createMenu('📊 Custom Report')
    .addItem('Update Dashboard (Run Report)', 'generateCustomReport')
    .addItem('Run Diagnostics Only',          'runDiagnosticsOnly')
    .addSeparator()
    .addItem('Reset Dashboard UI (clears the tab)', 'createCustomReportDashboard');

  const traceSubMenu = ui.createMenu('🔎 Trace a Cell')
    .addItem('QCD/CDR cell → raw rows (Extraction Sidebar)', 'showSidebar')
    .addItem('DQE cell → source rows (select it first)',      'showDQEDrilldownSidebar');

  // The cdr-report safety-net DQE build (the integrated cdr-import path is primary).
  const dqeBuildSubMenu = ui.createMenu('⏰ Daily DQE Build Trigger')
    .addItem('Install (runs at 7 AM)', 'installDQEBuildTrigger')
    .addItem('Uninstall',              'uninstallDQEBuildTrigger');

  // Batch 4 / Phase 2: the nightly date-order check over the five historical
  // sheets (sheetRepairs.js). Install arms HISTORICAL_SORT_ENABLED; the outcome
  // lands as historicalSort:<sheet> Pipeline Health rows and on the dashboard
  // Health page (Operator State #61).
  const sortSubMenu = ui.createMenu('⏰ Nightly Historical Sort Check')
    .addItem('Install (runs ~3 AM, arms the flag)', 'installHistoricalSortTrigger')
    .addItem('Uninstall (clears the flag)',         'uninstallHistoricalSortTrigger')
    .addItem('Preview (read-only)',                  'previewHistoricalSortCheck')
    .addItem('Run now',                              'runHistoricalSortCheckNow');

  // The Inbound / Outbound Calls tabs: the sheet fallbacks for the heatmap and
  // the Outbound report (Operator State #49 / #50).
  const inboundSubMenu = ui.createMenu('📥 Inbound Calls Tab')
    .addItem('Install daily export (runs at 9 AM)', 'installInboundExportTrigger')
    .addItem('Uninstall daily export',              'uninstallInboundExportTrigger')
    .addItem('Refresh now',                         'runInboundCallsExportNow');
  const outboundSubMenu = ui.createMenu('📤 Outbound Calls Tab')
    .addItem('Install daily export (runs at 9 AM)', 'installOutboundExportTrigger')
    .addItem('Uninstall daily export',              'uninstallOutboundExportTrigger')
    .addItem('Refresh now',                         'runOutboundCallsExportNow');

  // R47: the 10M-cell workbook cap. Google counts the ALLOCATED grid, not the
  // cells holding data. Audit is read-only; the trim refuses when a named range
  // or data reaches past its vetted bounds (Operator State #62). The dashboard
  // Health page's hint names this submenu -- keep the label.
  const cellsSubMenu = ui.createMenu('🧮 Workbook Cell Space')
    .addItem('Audit (read-only)',                'auditSheetSpace')
    .addItem('Preview trim (read-only)',         'previewTrimVettedGrids')
    .addItem('APPLY trim (copy the file first)', 'applyTrimVettedGrids')
    .addItem('Conditional-format ranges…',       'showConditionalFormatRanges');

  // Read-only. Neon Read Volume: this project's month-to-date reads + the
  // per-surface ranking (neonEgress.js); the dashboard meters itself
  // separately -- add them for a total. Queue Overlap Audit: does one CALL get
  // counted by two queues (queueOverlapAudit.js; settled 2026-09-01, kept for
  // re-sizing).
  const diagSubMenu = ui.createMenu('🔍 Diagnostics (read-only)')
    .addItem('Neon Read Volume (this project)', 'showNeonEgress')
    .addItem('Queue Overlap Audit',             'queueOverlapAudit');

  ui.createMenu('CDR Tools')
    .addSubMenu(reportsSubMenu)
    .addSubMenu(customSubMenu)
    .addSubMenu(traceSubMenu)
    .addSeparator()
    .addSubMenu(dqeBuildSubMenu)
    .addSubMenu(sortSubMenu)
    .addSubMenu(inboundSubMenu)
    .addSubMenu(outboundSubMenu)
    .addSeparator()
    .addSubMenu(cellsSubMenu)
    .addSubMenu(diagSubMenu)
    //.addItem('Run Historical Transfer', 'transferDailyReportsData')
    //.addItem('Benchmark Calc Speed', 'measureCalculationSpeed')
    .addToUi();
}
