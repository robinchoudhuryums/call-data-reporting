function updateDateRangeAndDropdown(startDate, endDate) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  sheet.getRange("X2").setValue(startDate);
  sheet.getRange("Z2").setValue(endDate);

  SpreadsheetApp.flush(); // force recalculation
  autoDropdown();
}

function setLast30Days() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);

  updateDateRangeAndDropdown(thirtyDaysAgo, yesterday);
}

function setLast60Days() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sixtyDaysAgo = new Date(today);
  sixtyDaysAgo.setDate(today.getDate() - 60);

  updateDateRangeAndDropdown(sixtyDaysAgo, yesterday);
}

function setLast90Days() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const ninetyDaysAgo = new Date(today);
  ninetyDaysAgo.setDate(today.getDate() - 90);

  updateDateRangeAndDropdown(ninetyDaysAgo, yesterday);
}

function setAllTime() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const historySheet = ss.getSheetByName("Historical Data");
  
  if (!historySheet) {
    SpreadsheetApp.getUi().alert("Error: 'Historical Data' sheet not found.");
    return;
  }

  // Assumes Date is in Column F (Index 6, derived from previous context)
  // If your date column is different, change this index (A=1, B=2, etc.)
  const DATE_COLUMN_INDEX = 6; 
  
  const lastRow = historySheet.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert("No data found in Historical Data.");
    return;
  }

  // Get the entire column of dates
  // skip header row (start at row 2)
  const dateValues = historySheet.getRange(2, DATE_COLUMN_INDEX, lastRow - 1, 1).getValues();
  
  // Flatten array and filter out non-dates or empty cells
  const validDates = dateValues.flat().filter(d => d instanceof Date && !isNaN(d));

  if (validDates.length === 0) {
    SpreadsheetApp.getUi().alert("No valid dates found in Column F.");
    return;
  }

  // Calculate Min and Max
  // We use Math.min/max on the timestamps (getTime())
  const minTimestamp = Math.min(...validDates.map(d => d.getTime()));
  const maxTimestamp = Math.max(...validDates.map(d => d.getTime()));

  const startDate = new Date(minTimestamp);
  const endDate = new Date(maxTimestamp);

  updateDateRangeAndDropdown(startDate, endDate);
}