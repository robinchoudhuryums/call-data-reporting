/**
 * Transfers daily report data from output sheets to historical data sheets.
 * Includes full try/catch logging for manual and triggered runs.
 */
function transferDailyReportsData() {
  const startTime = new Date(); // Log start time
  let updates = []; // To collect status messages from each job

  try {
    // --- Your script logic starts here ---
    const reportSpreadsheetId = "1VSkHRPN4bwj2UcdbGnLizTZ8qCSFs8MMzkjRbXju4Aw";
    const reportSS = SpreadsheetApp.openById(reportSpreadsheetId);

    // --- Job Configuration Array ---
    const jobs = [
      {
        outputSheetName: "OBC Output",
        dataStartCell: "Y13",
        dataEndColumn: "AE", 
        histSheetName: "Sales Direct HD",
        pasteStartCol: 4,
        dateCol: 3,       
        formulaRanges: []
      },
      {
        outputSheetName: "OBC Output",
        dataRange: "B2:X200",
        histSheetName: "OBC Historical Data",
        pasteStartCol: 5,
        dateCol: 3,      
        formulaRanges: [] 
      }
    ];

    // --- 1. Determine date from Raw Data (Source of Truth) ---
    const rawDataSheet = reportSS.getSheetByName("Raw Data");
    if (!rawDataSheet) { throw new Error("'Raw Data' sheet not found."); }
    
    // Find the first valid date object in column C
    const firstValidDate = new Date(rawDataSheet.getRange("C2:C").getValues().flat().find(d => d instanceof Date && !isNaN(d)));
    if (!firstValidDate.getTime()) { throw new Error("No valid date found in 'Raw Data'."); }
    
    // Format the target date using the Spreadsheet's Timezone to align with the duplicate check later
    const targetDateStr = Utilities.formatDate(firstValidDate, reportSS.getSpreadsheetTimeZone(), "MM/dd/yyyy");

    // --- Loop through and process each job ---
    jobs.forEach(job => {
      const outputSheet = reportSS.getSheetByName(job.outputSheetName);
      const historicalSheet = reportSS.getSheetByName(job.histSheetName);
      if (!outputSheet || !historicalSheet) {
        updates.push(`SKIPPED: Sheet missing for job '${job.histSheetName}'.`);
        return; 
      }

      // --- 2. Check ALL dates in Historical Data to prevent duplicates ---
      const lastHistRow = historicalSheet.getLastRow();
      if (lastHistRow > 1) {
        // Get ALL dates from the historical sheet to ensure we don't miss out-of-order duplicates
        const allHistDates = historicalSheet.getRange(2, job.dateCol, lastHistRow - 1, 1)
          .getValues()
          .flat()
          .filter(d => d instanceof Date || (d && !isNaN(new Date(d).getTime())))
          .map(d => {
            const dateObj = d instanceof Date ? d : new Date(d);
            // Format existing history to exact string match (removes timezone ambiguity)
            return Utilities.formatDate(dateObj, reportSS.getSpreadsheetTimeZone(), "MM/dd/yyyy");
          });
          
        // Check if target date already exists
        if (allHistDates.includes(targetDateStr)) {
          updates.push(`${job.histSheetName}: Up-to-date. Data for ${targetDateStr} already exists.`);
          return; // Skip this job
        }
      }
      
      // --- 3. Get the data to be transferred ---
      let dataValues;
      if (job.dataRange) {
        // Logic for jobs with a fixed dataRange
        dataValues = outputSheet.getRange(job.dataRange).getDisplayValues()
          .filter(row => row.some(cell => cell.toString().trim() !== "")); 
      } else {
        // Logic for jobs with start/end columns
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
        updates.push(`${job.outputSheetName}: No new data found to transfer.`);
        return;
      }

      const dataRowCount = dataValues.length;
      const firstEmptyRow = historicalSheet.getLastRow() + 1;

      // --- 4. Paste the new data and the correct date ---
      historicalSheet.getRange(firstEmptyRow, job.pasteStartCol, dataRowCount, dataValues[0].length).setValues(dataValues);
      
      const datesToPaste = Array(dataRowCount).fill([targetDateStr]);
      historicalSheet.getRange(firstEmptyRow, job.dateCol, dataRowCount, 1).setValues(datesToPaste);

      // --- 5. Copy formulas if they are defined for the job ---
      if (job.formulaRanges && job.formulaRanges.length > 0 && firstEmptyRow > 1) {
        job.formulaRanges.forEach(rangeInfo => {
          const sourceFormulaRange = historicalSheet.getRange(firstEmptyRow - 1, rangeInfo.startCol, 1, rangeInfo.numCols);
          const targetFormulaRange = historicalSheet.getRange(firstEmptyRow, rangeInfo.startCol, dataRowCount, rangeInfo.numCols);
          sourceFormulaRange.copyTo(targetFormulaRange, SpreadsheetApp.CopyPasteType.PASTE_FORMULA);
        });
      }

      updates.push(`${job.histSheetName}: Added ${dataRowCount} rows for ${targetDateStr}.`);
    });

    // --- 6. SCRIPT SUCCEEDED ---
    const endTime = new Date();
    const durationMs = endTime.getTime() - startTime.getTime();
    const durationStr = formatDuration(durationMs); 
    
    const finalMessage = `Transfer completed successfully in ${durationStr}.\n\n` +
                         `--- Job Updates ---\n` +
                         updates.join("\n");
    
    try {
      SpreadsheetApp.getUi().alert(finalMessage);
    } catch (uiError) {
      const userEmail = Session.getActiveUser().getEmail();
      if (userEmail) {
        MailApp.sendEmail(
          userEmail, 
          "Apps Script: CDR Daily Data Transfer SUCCESS", 
          finalMessage
        );
      }
    }

  } catch (e) {
    // --- 7. SCRIPT FAILED ---
    Logger.log(e); 
    const userEmail = Session.getActiveUser().getEmail();
    if (userEmail) {
      const errorMessage = `The 'transferDailyReportsData' script FAILED.\n\n` +
                           `Error: ${e.message}\n` +
                           `Stack Trace:\n${e.stack}`;
      MailApp.sendEmail(
        userEmail, 
        "Apps Script: Daily Report Transfer FAILED", 
        errorMessage
      );
    }
  }
}

function letterToColumn(letter) {
  let column = 0, length = letter.length;
  for (let i = 0; i < length; i++) {
    column += (letter.charCodeAt(i) - 64) * Math.pow(26, length - i - 1);
  }
  return column;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} minutes and ${seconds} seconds` : `${seconds} seconds`;
}