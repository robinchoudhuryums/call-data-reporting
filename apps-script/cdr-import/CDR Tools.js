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
    .addItem('A_Q_Spanish (1s)', 'filterSpanishAbandoned')
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
    
    .addItem("🛠️ Sort Historical Data",     "sortHistoricalData")
    .addItem("Remove Duplicate CDR Rows",   "removeDuplicateCDRRows") // [IMPROVEMENT 7]
    .addItem("📊 Check Coverage Gaps",       "checkCoverageGaps")       // [IMPROVEMENT 8]
    
    .addSeparator()
    
    // Attach the submenu right here
    .addSubMenu(filterSubMenu) 
    
    // .addSeparator()
    // .addItem("Import Bulk CSVs from Drive", "importBulkCSVsFromDrive") // pending Drive permissions
    
    .addToUi();
}