function deleteOldCDRSheets() {
  const sheetNamePrefix = "Call_Legs_";
  const cutoffDays = 14; // Sheets older than 30 days will be deleted.

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();

  // Create a "today" date and normalize it to midnight for consistent comparison.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Use a reverse for loop to safely delete items from the array.
  for (let i = sheets.length - 1; i >= 0; i--) {
    const sheet = sheets[i];
    const name = sheet.getName();

    // Check if the sheet name has the correct prefix
    if (name.startsWith(sheetNamePrefix)) {
      // Extract the date in YYYY-MM-DD format
      const dateMatch = name.match(/Call_Legs_(\d{4}-\d{2}-\d{2})/);

      if (dateMatch) {
        const dateStr = dateMatch[1]; // e.g., "2025-08-20"
        
        // This method of creating a date is fine, as it's interpreted at midnight.
        // new Date("2025-08-20") can be unreliable, but this is better.
        const parts = dateStr.split("-");
        const sheetDate = new Date(parts[0], parts[1] - 1, parts[2]);

        // Calculate the difference in days.
        const timeDiff = today.getTime() - sheetDate.getTime();
        const dayDiff = timeDiff / (1000 * 3600 * 24);

        // If the sheet's date is older than the cutoff, delete it.
        if (dayDiff > cutoffDays) {
          ss.deleteSheet(sheet);
          Logger.log(`Deleted old sheet: ${name}`);
        }
      }
    }
  }
}