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
    const imported = [];
    
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
          
          // 3-4. ING-5: import (see importCallLegsCsv_ below).
          let csvText;
          try { csvText = file.getBlob().getDataAsString(); }
          catch (err) { console.error(`Failed to read ${fileName}: ${err.message}`); continue; }
          const outcome = importCallLegsCsv_(ss, newSheetName, csvText);
          if (outcome === 'imported') { imported.push(newSheetName); count++; console.log(`Imported ${fileName} as ${newSheetName}`); }
          else console.log(`${fileName}: ${outcome}`);
        } else {
          console.log(`Skipped ${fileName}: Could not find YYYY-MM-DD in filename.`);
        }
      }
    }
    
    // ING-5: hold the recreated tabs from the nightly prune -- they are
    // usually OLDER than the retention cutoff (that is why they are being
    // recovered) and would otherwise be deleted before the rebuild runs.
    if (imported.length) retentionHoldTabs_(imported, RETENTION_RECOVERY_HOLD_DAYS);
    ui.alert("Import Complete", `Successfully imported ${count} CSV files.`
      + (imported.length ? ` They are held from the retention prune for ${RETENTION_RECOVERY_HOLD_DAYS} days -- rebuild / backfill those dates before then.` : ''),
      ui.ButtonSet.OK);
    
  } catch (e) {
    ui.alert("Error", `Could not access folder: ${e.message}`, ui.ButtonSet.OK);
  }
}

/**
 * ING-5 (broad-scan 2026-09-23, Batch 8): one CSV -> one Call_Legs tab.
 * Returns 'imported' | 'skipped: <why>' | 'failed: <why>'.
 *
 * The old loop created the tab BEFORE writing it, so a failed write (a
 * ragged CSV row, a cell-ceiling refusal) left an EMPTY tab behind -- and
 * every later run then skipped that date as "already exists", so the
 * recovery could never complete. Now: an existing tab with DATA is still
 * skipped (never overwrite a real import), an existing EMPTY tab is treated
 * as a failed earlier import and filled, rows are padded to one width, and a
 * tab this call created is deleted again if the write fails.
 */
function importCallLegsCsv_(ss, sheetName, csvText) {
  let rows;
  try { rows = Utilities.parseCsv(csvText); }
  catch (err) { return 'failed: could not parse (' + err.message + ')'; }
  if (!rows || !rows.length) return 'skipped: empty CSV';
  const width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
  const grid = rows.map(function (r) {
    return r.length === width ? r : r.concat(new Array(width - r.length).fill(''));
  });
  let sheet = ss.getSheetByName(sheetName);
  let created = false;
  if (sheet) {
    if (sheet.getLastRow() > 0) return 'skipped: ' + sheetName + ' already exists with data';
  } else {
    sheet = ss.insertSheet(sheetName);
    created = true;
  }
  try {
    if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
    sheet.getRange(1, 1, grid.length, width).setValues(grid);
    return 'imported';
  } catch (err) {
    if (created) { try { ss.deleteSheet(sheet); } catch (de) { /* reported below */ } }
    return 'failed: ' + err.message + (created ? ' (the new tab was removed; re-run to retry)' : '');
  }
}

