/**
 * CDRTools.gs
 * Menu builder for CDR Tools.
 *
 * Top level: Manual Export plus one submenu per job (bulk export, abandoned
 * filters, Neon mirror, retention prune, per-call agent names, diagnostics).
 * tests/unit/cdr-tools-menus.test.js pins that every item names a function
 * this project defines.
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();

  // 1. Build the Submenu first
  const filterSubMenu = ui.createMenu('🧹 Abandoned Filters')
    .addItem('A_Q_CSR & Intake (59s)', 'filterCSRAbandoned')
    .addItem('A_Q_PowerChairs (59s)', 'filterPowerAbandoned')
    .addItem('A_Q_Manual_Mobility (59s)', 'filterManualMobilityAbandoned')
    .addItem('A_Q_Resupply (59s)', 'filterResupplyAbandoned')
    .addItem('A_Q_Billing (59s)', 'filterBillingAbandoned')
    .addItem('A_Q_Service (59s)', 'filterServiceAbandoned')
    .addItem('A_Q_FieldOps (59s)', 'filterFieldOpsAbandoned')
    .addItem('A_Q_FieldOps_Power (59s)', 'filterFOPAbandoned')
    .addItem('A_Q_Sales (19s)', 'filterSalesAbandoned')
    .addItem('A_Q_Eligibility_MM&R (59s)', 'filterEligibilityMMRAbandoned')
    .addItem('A_Q_Denials (59s)', 'filterDenialsAbandoned')
    .addItem('A_Q_Spanish (59s)', 'filterSpanishAbandoned')
    .addItem('A_Q_PAK (59s)', 'filterPAKAbandoned')
    .addItem('A_Q_PAP (19s)', 'filterPAPAbandoned')
    .addSeparator()
    .addItem('❌ Clear Filters', 'clearAllFilters');

  // 2. Grouped submenus (2026-10-05 tidy). Every item is one click deep; the
  // read-only diagnostics share one submenu. Retired from the menu but still
  // EDITOR-runnable (Run picker): previewInternalTransferChainsForDate /
  // previewInternalTransferPathsForDate (R11-N, closed by R11-N5),
  // previewCallLegShapesForDate (S2C-1/S2C-5, answered 2026-09-28),
  // previewRow34Overlap (closed 2026-08-21 at zero), and
  // installExecCeilingProbeTrigger / readExecCeilingProbe (measured 2026-09-21,
  // Operator State #70).
  const bulkSubMenu = ui.createMenu('📦 Bulk Export')
    .addItem('Bulk Export',                     'bulkHistoricalUpdate')
    .addItem('Resume Bulk Processing',          'processBulkQueue')
    .addSeparator()
    .addItem('📋 View Pending Archive Status',  'viewPendingArchiveStatus')
    .addItem('Process Batch Archive',           'processBatchArchive')
    .addItem('Clear Pending Archive',           'clearPendingArchive');

  // Deferred Neon mirror (NeonMirror.js, Operator State #22). Install the
  // trigger once, then set NEON_MIRROR_MODE=deferred to move the mirror off the
  // synchronous import path. "Run now" drains the queue on demand.
  const neonSubMenu = ui.createMenu('🔁 Neon Mirror')
    .addItem('Install trigger',   'installNeonMirrorTrigger')
    .addItem('Uninstall trigger', 'uninstallNeonMirrorTrigger')
    .addItem('Run now',           'runNeonMirrorNow');

  // C-3: the Call_Legs_* retention prune (DeleteOldSheets.js, Operator State
  // #43) -- the ~14-day window everything assumes rests on it.
  const pruneSubMenu = ui.createMenu('🗑️ Retention Prune')
    .addItem('Install trigger (daily)', 'installRetentionPruneTrigger')
    .addItem('Uninstall trigger',       'uninstallRetentionPruneTrigger')
    .addItem('Run now',                 'runRetentionPruneNow');

  // PC-1: stored per-call agent names -> roster-canonical (Operator State #72).
  // Preview is read-only; take a Neon backup before the rewrite. Re-run after
  // adding an Agent Alias Override.
  const namesSubMenu = ui.createMenu('🪪 Per-call Agent Names')
    .addItem('Preview rewrite (read-only)', 'previewPerCallAgentNameRewrite')
    .addItem('Rewrite in Neon',             'rewritePerCallAgentNames');

  // Read-only diagnostics. The "(pick date)" ones prompt for a Call_Legs date
  // (blank = latest). QCD vs DQE writes only its own detail tab.
  const diagSubMenu = ui.createMenu('🔍 Diagnostics (read-only)')
    .addItem('QCD vs DQE diagnostic (pick date)…',               'diagnoseQcdVsDqe')
    .addItem('Work-window edge census',                          'runWorkWindowCensus')
    .addItem('Outbound assist links (pick date)…',               'previewOutboundAssistLinksForDate')
    .addItem('Transfer shapes for a dept (pick date)…',          'previewTransferShapesForDate');

  ui.createMenu("CDR Tools")
    .addItem("Manual Export", "runManualExport")
    .addSubMenu(bulkSubMenu)
    .addSubMenu(filterSubMenu)
    .addSeparator()
    .addSubMenu(neonSubMenu)
    .addSubMenu(pruneSubMenu)
    .addSubMenu(namesSubMenu)
    .addSeparator()
    .addSubMenu(diagSubMenu)

    // .addSeparator()
    // .addItem("Import Bulk CSVs from Drive", "importBulkCSVsFromDrive") // pending Drive permissions

    .addToUi();
}