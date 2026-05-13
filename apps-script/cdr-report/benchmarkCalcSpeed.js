function measureCalculationSpeed() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Raw Data");
  const formulaCell = sheet.getRange("A1"); // The cell driving your main data
  
  // 1. Get the current formula
  const originalFormula = formulaCell.getFormula();
  if (!originalFormula) {
    SpreadsheetApp.getUi().alert("Error: No formula found in Raw Data!A1");
    return;
  }

  // 2. Clear the cell to force a "reset"
  formulaCell.clearContent();
  SpreadsheetApp.flush(); // Force the sheet to recognize it's empty

  const ui = SpreadsheetApp.getUi();
  const startNotification = ui.alert(
    "Benchmark Ready", 
    "I will now restore the formula and measure how long it takes to calculate.\n\nClick OK to start.", 
    ui.ButtonSet.OK
  );

  if (startNotification !== ui.Button.OK) return;

  // 3. Restore formula and Start Timer
  const startTime = new Date().getTime();
  formulaCell.setFormula(originalFormula);
  
  // 4. Loop until data appears
  // We check a cell that usually loads LAST or relies on A1 (e.g., C2)
  const checkCell = sheet.getRange("C2"); 
  let isLoaded = false;
  let attempts = 0;
  
  while (!isLoaded && attempts < 120) { // Timeout after 120 seconds
    SpreadsheetApp.flush(); // Refresh the read
    const val = checkCell.getValue();
    
    // Check if the value is valid (Not Error, Not Loading, Not Empty)
    if (val !== "#N/A" && val !== "Loading..." && val !== "") {
      isLoaded = true;
    } else {
      Utilities.sleep(1000); // Wait 1 second
      attempts++;
    }
  }

  const endTime = new Date().getTime();
  const totalSeconds = (endTime - startTime) / 1000;

  if (isLoaded) {
    ui.alert(`✅ Calculation Complete\n\nIt took approximately ${totalSeconds} seconds for the data to reload.`);
  } else {
    ui.alert(`⚠️ Timeout\n\nThe sheet is taking longer than 2 minutes to calculate.`);
  }
}