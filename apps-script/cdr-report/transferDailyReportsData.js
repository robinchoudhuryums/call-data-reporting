function transferDailyReportsData() {
  const startTime = new Date(); 
  let updates = []; 

  try {
    // 1. Get Active Spreadsheet (Much faster/stable than openById)
    const reportSS = SpreadsheetApp.getActiveSpreadsheet();
    
    // --- Job Configuration Array ---
    const jobs = [
      {
        // --- Original Job: Sales Direct ---
        outputSheetName: "OBC Output",
        dataStartCell: "Y13",
        dataEndColumn: "AE",
        histSheetName: "Sales Direct HD",
        pasteStartCol: 4, // Column D
        dateCol: 3,       // Column C
        formulaRanges: []
      },
      {
        // --- New Job: OBC Data ---
        outputSheetName: "OBC Output",
        dataRange: "B2:X200",
        histSheetName: "OBC Historical Data",
        pasteStartCol: 5, // Column E
        dateCol: 3,       // Column C
        formulaRanges: [] 
      }
    ];

    // --- 2. Check Raw Data & Date ---
    const rawDataSheet = reportSS.getSheetByName("Raw Data");
    if (!rawDataSheet) throw new Error("'Raw Data' sheet not found.");

    // Force formulas to update before reading
    SpreadsheetApp.flush(); 

    // Safety Check: Verify formulas aren't currently loading or erroring
    // We check C2 (where the date usually is)
    const dateCheck = rawDataSheet.getRange("C2").getValue();
    if (dateCheck === "#N/A" || dateCheck === "Loading..." || dateCheck === "") {
      SpreadsheetApp.getUi().alert("⚠️ Formulas are still calculating.\n\nPlease wait a moment for the 'Raw Data' sheet to finish loading, then try again.");
      return;
    }

    // Get the valid date
    const validDateValues = rawDataSheet.getRange("C2:C").getValues().flat();
    const firstValidDate = new Date(validDateValues.find(d => d instanceof Date && !isNaN(d)));
    
    if (!firstValidDate || isNaN(firstValidDate.getTime())) { 
      throw new Error("No valid date found in 'Raw Data' column C."); 
    }
    
    const targetDateStr = Utilities.formatDate(firstValidDate, reportSS.getSpreadsheetTimeZone(), "MM/dd/yyyy");

    // --- 3. Process Jobs ---
    jobs.forEach(job => {
      const outputSheet = reportSS.getSheetByName(job.outputSheetName);
      const historicalSheet = reportSS.getSheetByName(job.histSheetName);

      if (!outputSheet || !historicalSheet) {
        updates.push(`SKIPPED: Sheet missing for job '${job.histSheetName}'.`);
        return;
      }

      // A. Check for Duplicates
      const lastHistRow = historicalSheet.getLastRow();
      if (lastHistRow > 1) {
        const lastHistDateVal = historicalSheet.getRange(2, job.dateCol, lastHistRow - 1).getValues().flat().filter(String).pop();
        if (lastHistDateVal) {
          const lastHistDateStr = Utilities.formatDate(new Date(lastHistDateVal), reportSS.getSpreadsheetTimeZone(), "MM/dd/yyyy");
          if (targetDateStr === lastHistDateStr) {
            updates.push(`${job.histSheetName}: Up-to-date (Date ${targetDateStr} already exists).`);
            return;
          }
        }
      }

      // B. Get Data (Handles both 'dataRange' and 'start/end cell' logic)
      let dataValues;
      if (job.dataRange) {
        // Fixed Range Logic (e.g. OBC Data)
        dataValues = outputSheet.getRange(job.dataRange).getDisplayValues()
          .filter(row => row.some(cell => cell.toString().trim() !== ""));
      } else {
        // Dynamic Column Logic (e.g. Sales Direct)
        const startRow = parseInt(job.dataStartCell.match(/\d+/)[0]);
        const startCol = letterToColumn(job.dataStartCell.match(/[A-Z]+/)[0]);
        const endCol = letterToColumn(job.dataEndColumn);
        const numCols = endCol - startCol + 1;
        const lastRow = outputSheet.getLastRow();
        
        if (lastRow < startRow) {
          dataValues = [];
        } else {
          const numRows = lastRow - startRow + 1;
          dataValues = outputSheet.getRange(startRow, startCol, numRows, numCols).getDisplayValues()
            .filter(row => row.some(cell => cell.toString().trim() !== ""));
        }
      }

      if (dataValues.length === 0) {
        updates.push(`${job.histSheetName}: No data found to transfer.`);
        return;
      }

      // C. Paste Data
      const dataRowCount = dataValues.length;
      const firstEmptyRow = historicalSheet.getLastRow() + 1;

      historicalSheet.getRange(firstEmptyRow, job.pasteStartCol, dataRowCount, dataValues[0].length).setValues(dataValues);
      
      const datesToPaste = Array(dataRowCount).fill([targetDateStr]);
      historicalSheet.getRange(firstEmptyRow, job.dateCol, dataRowCount, 1).setValues(datesToPaste);

      // D. Copy Formulas (if applicable)
      if (job.formulaRanges && job.formulaRanges.length > 0 && firstEmptyRow > 1) {
        job.formulaRanges.forEach(rangeInfo => {
          const sourceFormulaRange = historicalSheet.getRange(firstEmptyRow - 1, rangeInfo.startCol, 1, rangeInfo.numCols);
          const targetFormulaRange = historicalSheet.getRange(firstEmptyRow, rangeInfo.startCol, dataRowCount, rangeInfo.numCols);
          sourceFormulaRange.copyTo(targetFormulaRange, SpreadsheetApp.CopyPasteType.PASTE_FORMULA);
        });
      }

      updates.push(`${job.histSheetName}: Added ${dataRowCount} rows for ${targetDateStr}.`);
    });

    // --- 4. Completion Message ---
    const endTime = new Date();
    const durationMs = endTime.getTime() - startTime.getTime();
    const durationStr = formatDuration(durationMs);
    
    const finalMessage = `Transfer completed in ${durationStr}.\n\n` +
                         `--- Job Updates ---\n` +
                         updates.join("\n");
    
    SpreadsheetApp.getUi().alert("✅ Success", finalMessage, SpreadsheetApp.getUi().ButtonSet.OK);

  } catch (e) {
    // --- Error Handling ---
    Logger.log(e);
    SpreadsheetApp.getUi().alert("❌ Script Failed", `Error: ${e.message}\n\nCheck the execution log for details.`, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

/**
 * Helper function to convert column letters (e.g., "K", "AA") to a number.
 */
function letterToColumn(letter) {
  let column = 0, length = letter.length;
  for (let i = 0; i < length; i++) {
    column += (letter.charCodeAt(i) - 64) * Math.pow(26, length - i - 1);
  }
  return column;
}

/**
 * Helper function to format duration.
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  
  if (minutes > 0) {
    return `${minutes} minutes and ${seconds} seconds`;
  } else {
    return `${seconds} seconds`;
  }
}