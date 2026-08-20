/**
 * CDRTools.gs
 * Menu builder for CDR Tools.
 *
 * Changes in v28:
 * - Added "📋 View Pending Archive Status"  [IMPROVEMENT 4]
 * - Added "📊 Check Coverage Gaps"          [IMPROVEMENT 8]
 * - Added "Remove Duplicate CDR Rows"       [IMPROVEMENT 7]
 * - Added nested "🧹 Abandoned Filters" submenu
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

  // 2. Build the Main Menu and attach the Submenu
  ui.createMenu("CDR Tools")
    .addItem("Manual Export",            "runManualExport")
    
    .addSeparator()
    
    .addItem("Bulk Export",              "bulkHistoricalUpdate")
    .addItem("Resume Bulk Processing",   "processBulkQueue")
    
    .addSeparator()
    
    .addItem("📋 View Pending Archive Status", "viewPendingArchiveStatus") // [IMPROVEMENT 4]
    .addItem("Process Batch Archive",          "processBatchArchive")
    .addItem("Clear Pending Archive",          "clearPendingArchive")
    
    .addSeparator()

    // Attach the submenu right here
    .addSubMenu(filterSubMenu)

    .addSeparator()

    // Deferred Neon mirror (NeonMirror.js). Install the trigger once, then set
    // Script Property NEON_MIRROR_MODE=deferred to move the mirror off the
    // synchronous import path. "Run Neon Mirror Now" drains the queue on demand.
    .addItem("Install Neon Mirror Trigger",   "installNeonMirrorTrigger")
    .addItem("Uninstall Neon Mirror Trigger", "uninstallNeonMirrorTrigger")
    .addItem("Run Neon Mirror Now",           "runNeonMirrorNow")

    .addSeparator()

    // C-3: the Call_Legs_* retention prune (DeleteOldSheets.js). The ~14-day
    // window everything assumes (journey backfills, queue-split backfill,
    // pruned-sheet detection) now has an in-repo installer + telemetry
    // (`retentionPrune` Pipeline Health rows) -- Operator State #43.
    .addItem("Install Retention Prune Trigger (daily)", "installRetentionPruneTrigger")
    .addItem("Uninstall Retention Prune Trigger",       "uninstallRetentionPruneTrigger")
    .addItem("Run Retention Prune Now",                 "runRetentionPruneNow")

    .addSeparator()

    // Read-only transfer-path diagnostics (inboundCalls.js). Each prompts for
    // a Call_Legs date (blank = latest sheet); results in the execution log.
    .addItem("Preview transfer chains (pick date)…", "previewInternalTransferChainsForDate")
    .addItem("Preview transfer paths (pick date)…",  "previewInternalTransferPathsForDate")
    // Read-only row-34 double-count probe (owner request 2026-08-20): scans
    // every surviving Call_Legs_* sheet; results in the execution log.
    .addItem("Preview QCD row-34 overlap",           "previewRow34Overlap")

    // .addSeparator()
    // .addItem("Import Bulk CSVs from Drive", "importBulkCSVsFromDrive") // pending Drive permissions

    .addToUi();
}