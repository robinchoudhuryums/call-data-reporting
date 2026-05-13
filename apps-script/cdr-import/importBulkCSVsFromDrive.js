/**
 * BULK CSV IMPORTER
 * Imports all CSV files from a specific Drive Folder into this spreadsheet.
 */
function importBulkCSVsFromDrive() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Ask for Folder ID
  const prompt = ui.prompt("Bulk Import CSVs", "Enter the Google Drive Folder ID containing your CSV files:", ui.ButtonSet.OK_CANCEL);
  if (prompt.getSelectedButton() != ui.Button.OK) return;
  
  const folderId = prompt.getResponseText().trim();
  if (!folderId) { ui.alert("Invalid Folder ID"); return; }
  
  try {
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFiles();
    let count = 0;
    
    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();
      
      // Basic check: is it a CSV?
      if (file.getMimeType() === MimeType.CSV || fileName.endsWith(".csv")) {
        
        // 2. Parse Filename to get Date (Expects: "Call_Legs_YYYY-MM-DD" or similar)
        // Adjust this regex if your actual filenames look different!
        // This looks for a date pattern YYYY-MM-DD anywhere in the filename
        const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/);
        
        if (dateMatch) {
          const dateStr = dateMatch[1];
          const newSheetName = `Call_Legs_${dateStr}`;
          
          // 3. Create Sheet if it doesn't exist
          let sheet = ss.getSheetByName(newSheetName);
          if (sheet) {
            console.log(`Skipped ${fileName}: Sheet ${newSheetName} already exists.`);
            continue; 
          }
          
          try {
            // 4. Import Data
            const csvData = Utilities.parseCsv(file.getBlob().getDataAsString());
            if (csvData.length > 0) {
              sheet = ss.insertSheet(newSheetName);
              // Write data in one batch
              sheet.getRange(1, 1, csvData.length, csvData[0].length).setValues(csvData);
              console.log(`Imported ${fileName} as ${newSheetName}`);
              count++;
            }
          } catch (err) {
            console.error(`Failed to parse ${fileName}: ${err.message}`);
          }
        } else {
          console.log(`Skipped ${fileName}: Could not find YYYY-MM-DD in filename.`);
        }
      }
    }
    
    ui.alert("Import Complete", `Successfully imported ${count} CSV files.`, ui.ButtonSet.OK);
    
  } catch (e) {
    ui.alert("Error", `Could not access folder: ${e.message}`, ui.ButtonSet.OK);
  }
}