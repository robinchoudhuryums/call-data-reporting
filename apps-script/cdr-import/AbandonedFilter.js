/**
 * The Core Filter Engine mapped to the NEW CDR Import columns.
 */
function applyAbandonedFilter(departmentNames, waitThresholdStr) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const range = sheet.getDataRange();

  // Remove existing filters to start fresh
  if (sheet.getFilter()) sheet.getFilter().remove();
  const filter = range.createFilter();

  // --- NEW CDR COLUMN MAPPING ---
  const colQueue = 12;    // Column L: Callee Name / Queue Name
  const colWaitTime = 8;  // Column H: Wait Time
  const colAbandoned = 25; // Column Y: Abandoned Status

  // 1. Filter Y = "Abandoned" (Handles potential case variations)
  filter.setColumnFilterCriteria(colAbandoned, SpreadsheetApp.newFilterCriteria()
    .whenTextEqualTo("Abandoned")
    .build());

  // 2. Hide all queues EXCEPT the target departmentNames (Case-Insensitive)
  const targetQueuesLower = departmentNames.map(d => String(d).toLowerCase());
  
  const allValues = sheet.getRange(2, colQueue, sheet.getLastRow() - 1).getValues()
    .flat()
    .filter(String) // remove empty
    .filter((v, i, a) => a.indexOf(v) === i); // get unique values

  // Find which actual sheet values don't match our target list
  const toHide = allValues.filter(v => !targetQueuesLower.includes(String(v).toLowerCase()));

  if (toHide.length > 0) {
    filter.setColumnFilterCriteria(colQueue, SpreadsheetApp.newFilterCriteria()
      .setHiddenValues(toHide)
      .build());
  }

  // 3. Filter H (Wait Time) > threshold
  const threshold = timeToDecimal(waitThresholdStr);
  filter.setColumnFilterCriteria(colWaitTime, SpreadsheetApp.newFilterCriteria()
    .whenNumberGreaterThan(threshold)
    .build());
}

// -------------------------------------------------------------------------
// SPECIFIC FILTER TRIGGERS
// -------------------------------------------------------------------------

function filterCSRAbandoned() { applyAbandonedFilter(["A_Q_CSR", "A_Q_Intake"], "0:00:59"); }
function filterPowerAbandoned() { applyAbandonedFilter(["A_Q_PowerChairs"], "0:00:59"); }
function filterManualMobilityAbandoned() { applyAbandonedFilter(["A_Q_Manual_Mobility"], "0:00:59"); }
function filterResupplyAbandoned() { applyAbandonedFilter(["A_Q_Resupply"], "0:00:59"); }
function filterBillingAbandoned() { applyAbandonedFilter(["A_Q_Billing"], "0:00:59"); }
function filterServiceAbandoned() { applyAbandonedFilter(["A_Q_Service"], "0:00:59"); }
function filterFieldOpsAbandoned() { applyAbandonedFilter(["A_Q_FieldOps"], "0:00:59"); }
function filterFOPAbandoned() { applyAbandonedFilter(["A_Q_FieldOps_Power"], "0:00:59"); }
function filterSalesAbandoned() { applyAbandonedFilter(["A_Q_Sales"], "0:00:19"); }
function filterEligibilityMMRAbandoned() { applyAbandonedFilter(["A_Q_Eligibility_MM&R"], "0:00:59"); }
function filterDenialsAbandoned() { applyAbandonedFilter(["A_Q_Denials"], "0:00:59"); }
function filterSpanishAbandoned() { applyAbandonedFilter(["A_Q_Spanish"], "0:00:01"); }
function filterPAKAbandoned() { applyAbandonedFilter(["A_Q_PAK"], "0:00:59"); }
function filterPAPAbandoned() { applyAbandonedFilter(["A_Q_PAP"], "0:00:19"); }

function clearAllFilters() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (sheet.getFilter()) sheet.getFilter().remove();
}

// -------------------------------------------------------------------------
// HELPER FUNCTION
// -------------------------------------------------------------------------

/**
 * Safely converts a time string (e.g., "0:00:59") into a spreadsheet decimal.
 */
function timeToDecimal(timeStr) {
  if (!timeStr) return 0;
  const parts = String(timeStr).trim().split(':');
  let h = 0, m = 0, s = 0;
  
  if (parts.length === 3) {
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
    s = parseInt(parts[2], 10);
  } else if (parts.length === 2) {
    m = parseInt(parts[0], 10);
    s = parseInt(parts[1], 10);
  }
  
  return (h / 24) + (m / 1440) + (s / 86400);
}