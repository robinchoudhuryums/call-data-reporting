// ============================================================================
// syncHistoricalData.gs (DQE migration version)
// ----------------------------------------------------------------------------
// Mirrors "DQE Historical Data" from CDR Report into this DQE Report ss.
// Uses smart sync (full / incremental / integrity-checked append) and applies
// surgical text patches to columns that contain comma-separated values which
// Sheets would otherwise reformat as numbers.
//
// Changes from previous version:
//   - Source: CDR Report (not DQE Master)
//   - Sheet: "DQE Historical Data" (not "Historical Data")
//   - Schema: 34 columns A-AH (was 38 cols B-AM)
//   - Source range starts at col A, not col B
//   - Text patches remapped: D, AE, AF (was I, AI, AJ)
// ============================================================================

function smartSyncHistoricalData() {
  // --- CONFIGURATION ---
  var sourceSpreadsheetId = "182KMgvrBefTv4vjqgrr2RwarNyOgooXOkbVJkY9hO5g";
  var sourceTabName       = "DQE Historical Data";
  var destinationTabName  = "DQE Historical Data";
  var startRow            = 2;
  var numCols             = 34; // A through AH
  // ---------------------

  var sourceSS    = SpreadsheetApp.openById(sourceSpreadsheetId);
  var sourceSheet = sourceSS.getSheetByName(sourceTabName);
  var destSheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(destinationTabName);

  if (!sourceSheet || !destSheet) {
    throw new Error("Could not find one of the tabs. Check names!");
  }

  var sourceLastRow = getRealLastRow(sourceSheet);
  var destLastRow   = getRealLastRow(destSheet);

  console.log("Status Check -> Source Rows: " + sourceLastRow + " | Dest Rows: " + destLastRow);

  // SCENARIO 1: Destination empty. Full Import.
  if (destLastRow < startRow) {
    console.log("Destination empty. Starting Full Import...");
    fullImport(sourceSheet, destSheet, startRow, sourceLastRow, numCols);
    return;
  }

  // SCENARIO 2: Source has fewer rows than dest (deletions or ghost rows). Full Sync.
  if (sourceLastRow < destLastRow) {
    console.warn("Source has fewer rows (" + sourceLastRow + ") than Dest (" + destLastRow + "). Triggering Full Sync.");
    fullImport(sourceSheet, destSheet, startRow, sourceLastRow, numCols);
    return;
  }

  // SCENARIO 3: Counts match. Paranoid check on last row.
  if (sourceLastRow == destLastRow) {
    // Both source and dest now use col A as the first column
    var destVal   = destSheet.getRange(destLastRow, 1).getValue().toString();
    var sourceVal = sourceSheet.getRange(sourceLastRow, 1).getValue().toString();

    if (destVal === sourceVal) {
      console.log("Data is up to date (counts and last value match).");
      runDependentFunction();
      return;
    } else {
      console.warn("Row counts match, but last row data differs. Triggering Full Sync.");
      console.warn("Dest: " + destVal + " | Source: " + sourceVal);
      fullImport(sourceSheet, destSheet, startRow, sourceLastRow, numCols);
      return;
    }
  }

  // SCENARIO 4: New data in source — integrity check the last existing dest row
  var destCheckRow   = destSheet.getRange(destLastRow, 1, 1, numCols).getValues()[0];
  var sourceCheckRow = sourceSheet.getRange(destLastRow, 1, 1, numCols).getValues()[0];

  var isAligned = JSON.stringify(destCheckRow) === JSON.stringify(sourceCheckRow);

  if (isAligned) {
    var newRowsCount = sourceLastRow - destLastRow;
    console.log("Integrity check passed. Appending " + newRowsCount + " new rows.");

    var firstNewRow = destLastRow + 1;
    var newData = sourceSheet.getRange(firstNewRow, 1, newRowsCount, numCols).getValues();

    applyTextPatches(sourceSheet, newData, firstNewRow, newRowsCount);

    destSheet.getRange(firstNewRow, 1, newData.length, newData[0].length).setValues(newData);

  } else {
    console.warn("History mismatch detected at row " + destLastRow + ". Triggering Full Sync.");
    fullImport(sourceSheet, destSheet, startRow, sourceLastRow, numCols);
  }

  runDependentFunction();
}


// HELPER: Find the last row that actually has content (ignores blank formatted rows)
function getRealLastRow(sheet) {
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    if (data[i].join("") !== "") {
      return i + 1;
    }
  }
  return 0;
}


// HELPER: Full import with column patching
function fullImport(sourceSheet, destSheet, startRow, sourceLastRow, numCols) {
  var dataLen = sourceLastRow - startRow + 1;
  if (dataLen <= 0) {
    console.log("No data rows in source. Skipping import.");
    return;
  }

  var data = sourceSheet.getRange(startRow, 1, dataLen, numCols).getValues();
  applyTextPatches(sourceSheet, data, startRow, dataLen);

  // Clear existing data (preserve headers) — clear extras to wipe ghost rows
  if (destSheet.getLastRow() > 1) {
    destSheet.getRange(2, 1, destSheet.getMaxRows() - 1, destSheet.getMaxColumns()).clearContent();
  }

  // Force col D to plain text on dest so "1003,183" stays unformatted
  destSheet.getRange(1, 4, destSheet.getMaxRows(), 1).setNumberFormat('@');

  destSheet.getRange(2, 1, data.length, data[0].length).setValues(data);
  console.log("Full import complete with text patch.");

  runDependentFunction();
}


// SUB-HELPER: Surgical swap for columns that need display-value preservation
//
// Columns needing patches (indices into the data block, which starts at col A):
//   D  = idx 3   Queue Extensions (e.g. "1003,183")
//   AE = idx 30  Abandoned Missed Leg IDs
//   AF = idx 31  Abandoned Missed Leg Times
function applyTextPatches(sourceSheet, dataArray, startRow, numRows) {
  if (numRows <= 0) return;

  var colD_Text  = sourceSheet.getRange(startRow, 4,  numRows, 1).getDisplayValues();
  var colAE_Text = sourceSheet.getRange(startRow, 31, numRows, 1).getDisplayValues();
  var colAF_Text = sourceSheet.getRange(startRow, 32, numRows, 1).getDisplayValues();

  for (var i = 0; i < dataArray.length; i++) {
    dataArray[i][3]  = colD_Text[i][0];
    dataArray[i][30] = colAE_Text[i][0];
    dataArray[i][31] = colAF_Text[i][0];
  }
}


function runDependentFunction() {
  console.log("Historical Data Sync Complete. Running dependent process...");
  try {
    if (typeof checkLowAnswerRate_MultiSheet === 'function') {
      checkLowAnswerRate_MultiSheet();
    } else {
      console.log("Dependent function checkLowAnswerRate_MultiSheet not found.");
    }
  } catch (e) {
    console.error("Error running dependent function: " + e.message);
  }
}