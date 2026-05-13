/**
 * Configuration — update ranges and date cells here if the sheet layout changes.
 * No need to touch the functions below for routine adjustments.
 */
const CONFIG = {
  sheetName: "Daily Queue Report",
  queueReport: {
    range:    "B4:I70",
    dateCell: "B1",
    pdf: {
      portrait: true,
      size:     "letter",
      scale:    4,
      margins:  "0.25",
    }
  },
  dctr: {
    range:    "A83:O105",
    dateCell: "B80",
    pdf: {
      portrait: false,
      size:     "legal",
      scale:    2,
      margins:  "0",
    }
  }
};


// ─────────────────────────────────────────────
//  Script 1: Daily Queue Report (single)
// ─────────────────────────────────────────────

function emailDailyQueueReportPDF() {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const reportSheet = ss.getSheetByName(CONFIG.sheetName);

  if (!reportSheet) {
    SpreadsheetApp.getUi().alert(`Sheet not found: ${CONFIG.sheetName}`);
    return;
  }

  const dateFromCell = reportSheet.getRange(CONFIG.queueReport.dateCell).getValue();
  if (!(dateFromCell instanceof Date) || isNaN(dateFromCell.getTime())) {
    SpreadsheetApp.getUi().alert(
      `The date in cell ${CONFIG.queueReport.dateCell} is not valid. Please check the cell.`
    );
    return;
  }

  const timeZone      = ss.getSpreadsheetTimeZone();
  const formattedDate = Utilities.formatDate(dateFromCell, timeZone, "MM/dd/yyyy");
  const exportUrl     = buildExportUrl(ss, reportSheet, CONFIG.queueReport);

  try {
    const blob = fetchPdfBlob(exportUrl, `Daily Queue Report - ${formattedDate}.pdf`);

    MailApp.sendEmail({
      to:          "departmentleads@universalmedsupply.com",
      cc:          "routing@universalmedsupply.com,service@universalmedsupply.com,robin.choudhury@universalmedsupply.com",
      subject:     `Daily Call Queue Report - ${formattedDate}`,
      body:        `Attached is the daily call queue report for ${formattedDate}.`,
      attachments: [blob],
    });

    SpreadsheetApp.getUi().alert(`Daily Queue Report for ${formattedDate} emailed successfully!`);
  } catch (e) {
    SpreadsheetApp.getUi().alert(`Error sending Queue Report: ${e.toString()}`);
  }
}


// ─────────────────────────────────────────────
//  Script 2: DCTR (single)
// ─────────────────────────────────────────────

function emailDCTRPDF() {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const reportSheet = ss.getSheetByName(CONFIG.sheetName);

  if (!reportSheet) {
    SpreadsheetApp.getUi().alert(`Sheet not found: ${CONFIG.sheetName}`);
    return;
  }

  const dateFromCell = reportSheet.getRange(CONFIG.dctr.dateCell).getValue();
  if (!(dateFromCell instanceof Date) || isNaN(dateFromCell.getTime())) {
    SpreadsheetApp.getUi().alert(
      `The date in cell ${CONFIG.dctr.dateCell} is not valid. Please check the cell.`
    );
    return;
  }

  const timeZone      = ss.getSpreadsheetTimeZone();
  const formattedDate = Utilities.formatDate(dateFromCell, timeZone, "MM/dd/yyyy");
  const exportUrl     = buildExportUrl(ss, reportSheet, CONFIG.dctr);

  try {
    const blob = fetchPdfBlob(exportUrl, `DCTR - ${formattedDate}.pdf`);

    const ui             = SpreadsheetApp.getUi();
    const promptResponse = ui.prompt(
      'Additional Notes',
      'Enter any optional text to add to the email body (or leave blank):',
      ui.ButtonSet.OK_CANCEL
    );

    if (promptResponse.getSelectedButton() !== ui.Button.OK) {
      ui.alert('Email cancelled.');
      return;
    }

    const additionalText = promptResponse.getResponseText();
    let emailBody        = `Attached is the DCTR for ${formattedDate}.`;
    if (additionalText) emailBody += `\n\n${additionalText}`;

    MailApp.sendEmail({
      to:          "customersuccess@universalmedsupply.com",
      subject:     `DCTR - ${formattedDate}`,
      body:        emailBody,
      attachments: [blob],
    });

    SpreadsheetApp.getUi().alert(`DCTR for ${formattedDate} emailed successfully!`);
  } catch (e) {
    SpreadsheetApp.getUi().alert(`Error sending DCTR: ${e.toString()}`);
  }
}


// ─────────────────────────────────────────────
//  Script 3: Batch Queue Reports → Zip Email
// ─────────────────────────────────────────────

function batchSaveQueueReports() {
  runBatch(CONFIG.queueReport, "Daily Queue Report");
}


// ─────────────────────────────────────────────
//  Script 4: Batch DCTRs → Zip Email
// ─────────────────────────────────────────────

function batchSaveDCTRs() {
  runBatch(CONFIG.dctr, "DCTR");
}


// ─────────────────────────────────────────────
//  Batch core (FIXED VERSION)
// ─────────────────────────────────────────────

/**
 * Prompts for a date range, generates one PDF per weekday, zips them,
 * and emails the zip to the script runner's account.
 *
 * @param {Object} reportConfig - One of CONFIG.queueReport or CONFIG.dctr
 * @param {string} reportLabel  - Human-readable label for file naming
 */
function runBatch(reportConfig, reportLabel) {
  const ui          = SpreadsheetApp.getUi();
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const reportSheet = ss.getSheetByName(CONFIG.sheetName);

  if (!reportSheet) {
    ui.alert(`Sheet not found: ${CONFIG.sheetName}`);
    return;
  }

  // --- Prompt for start date
  const startPrompt = ui.prompt(
    `Batch: ${reportLabel}`,
    'Enter start date (MM/DD/YYYY):',
    ui.ButtonSet.OK_CANCEL
  );
  if (startPrompt.getSelectedButton() !== ui.Button.OK) return;

  // --- Prompt for end date
  const endPrompt = ui.prompt(
    `Batch: ${reportLabel}`,
    'Enter end date (MM/DD/YYYY):',
    ui.ButtonSet.OK_CANCEL
  );
  if (endPrompt.getSelectedButton() !== ui.Button.OK) return;

  const startDate = parseDateLocal(startPrompt.getResponseText());
  const endDate   = parseDateLocal(endPrompt.getResponseText());

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    ui.alert('One or both dates were not valid. Please use MM/DD/YYYY format.');
    return;
  }
  if (startDate > endDate) {
    ui.alert('Start date must be before or equal to end date.');
    return;
  }

  // --- Save the current date cell value to restore after batch
  const originalDate = reportSheet.getRange(reportConfig.dateCell).getValue();
  // Use the correct timezone for Dallas/Central Time instead of spreadsheet timezone
  const timeZone     = "America/Chicago"; // Override to ensure consistent timezone

  const blobs  = [];
  const errors = [];
  const debugLog = [];
  let skippedDays = 0;

  // --- Generate list of weekdays in range (FIXED: more robust date iteration)
  const weekdays = getWeekdaysInRange(startDate, endDate, timeZone);
  debugLog.push(`Total dates in range: ${getDaysInRange(startDate, endDate)}`);
  debugLog.push(`Weekdays found: ${weekdays.length}`);
  debugLog.push(`Weekend days skipped: ${getDaysInRange(startDate, endDate) - weekdays.length}`);

  // --- Process each weekday
  for (const currentDate of weekdays) {
    const formattedDate = Utilities.formatDate(currentDate, timeZone, "MM-dd-yy");
    const dayName = getDayName(currentDate.getDay());
    
    debugLog.push(`Processing ${formattedDate} (${dayName})`);

    try {
      // TIMEZONE FIX: Compensate for spreadsheet timezone vs our date timezone
      const compensatedDate = compensateForSpreadsheetTimezone(currentDate);
      
      reportSheet.getRange(reportConfig.dateCell).setValue(compensatedDate);
      SpreadsheetApp.flush();

      const exportUrl = buildExportUrl(ss, reportSheet, reportConfig);
      const blob      = fetchPdfBlob(exportUrl, `${reportLabel} - ${formattedDate}.pdf`);
      blobs.push(blob);
      debugLog.push(`✅ Generated: ${formattedDate} (cell shows ${Utilities.formatDate(compensatedDate, "America/Mexico_City", "MM/dd/yyyy")})`);
    } catch (e) {
      const errorMsg = `${formattedDate}: ${e.message}`;
      errors.push(errorMsg);
      debugLog.push(`❌ Failed: ${errorMsg}`);
    }

    Utilities.sleep(2000); // Pause between requests to avoid rate limiting
  }

  // --- Restore original date cell value
  reportSheet.getRange(reportConfig.dateCell).setValue(originalDate);
  SpreadsheetApp.flush();

  if (blobs.length === 0) {
    console.log('Debug Log:\n' + debugLog.join('\n'));
    ui.alert(
      `No files were generated.\n` +
      (errors.length > 0 ? `Errors:\n${errors.join('\n')}` : 'No weekday dates found in range.')
    );
    return;
  }

  // --- Zip all blobs and email to script runner
  try {
    const rangeLabel  = Utilities.formatDate(startDate, timeZone, "MM-dd-yyyy") +
                        " to " +
                        Utilities.formatDate(endDate,   timeZone, "MM-dd-yyyy");
    const zipFileName = `${reportLabel} Batch - ${rangeLabel}.zip`;
    const zipBlob     = Utilities.zip(blobs, zipFileName);
    const recipient   = Session.getActiveUser().getEmail();

    MailApp.sendEmail({
      to:          recipient,
      subject:     zipFileName,
      body:        `Attached is a batch of ${blobs.length} ${reportLabel} report(s) for ${rangeLabel}.` +
                   (errors.length > 0
                     ? `\n\nThe following dates failed to generate:\n${errors.join('\n')}`
                     : '') +
                   `\n\n--- Debug Log ---\n${debugLog.join('\n')}`,
      attachments: [zipBlob],
    });

    const weekendCount = getDaysInRange(startDate, endDate) - weekdays.length;
    let summary = `Batch complete.\n\n✅ Generated: ${blobs.length} file(s)\n📅 Weekends skipped: ${weekendCount}\n📧 Zip emailed to: ${recipient}`;
    if (errors.length > 0) {
      summary += `\n\n⚠️ Errors (${errors.length}):\n` + errors.join('\n');
    }

    console.log('Final Debug Log:\n' + debugLog.join('\n'));
    ui.alert(summary);

  } catch (e) {
    console.log('Debug Log:\n' + debugLog.join('\n'));
    ui.alert(`Files were generated but the zip/email step failed: ${e.toString()}`);
  }
}


// ─────────────────────────────────────────────
//  Helpers (FIXED & ENHANCED)
// ─────────────────────────────────────────────

/**
 * Builds the Google Sheets PDF export URL from a report config entry.
 * @param {Spreadsheet} ss
 * @param {Sheet}       sheet
 * @param {Object}      reportConfig - Has .range and .pdf properties
 */
function buildExportUrl(ss, sheet, reportConfig) {
  const base    = ss.getUrl().replace(/\/edit$/, '');
  const sheetId = sheet.getSheetId();
  const m       = reportConfig.pdf.margins;
  return `${base}/export?format=pdf&gid=${sheetId}` +
    `&range=${reportConfig.range}` +
    `&portrait=${reportConfig.pdf.portrait}` +
    `&size=${reportConfig.pdf.size}` +
    `&scale=${reportConfig.pdf.scale}` +
    `&top_margin=${m}&bottom_margin=${m}&left_margin=${m}&right_margin=${m}` +
    `&sheetnames=false&printtitle=false&pagenumbers=false&gridlines=false`;
}

/**
 * Fetches a PDF blob from a Google Sheets export URL using the script's OAuth token.
 * Constructs a fresh blob from raw bytes to avoid nested folder artifacts in zips.
 * @param  {string} exportUrl
 * @param  {string} fileName
 * @returns {Blob}
 */
function fetchPdfBlob(exportUrl, fileName) {
  const token    = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(exportUrl, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  return Utilities.newBlob(response.getBlob().getBytes(), 'application/pdf', fileName);
}

/**
 * Parses a MM/DD/YYYY date string as local midnight to avoid UTC offset shift.
 * Using new Date("MM/DD/YYYY") interprets the date as UTC, which causes a
 * one-day-back shift in negative-offset timezones (e.g. US Central).
 * @param  {string} dateStr - MM/DD/YYYY format
 * @returns {Date}
 */
function parseDateLocal(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return new Date(NaN);
  return new Date(
    parseInt(parts[2], 10),      // year
    parseInt(parts[0], 10) - 1,  // month (0-indexed)
    parseInt(parts[1], 10)       // day
  );
}

/**
 * Gets all weekdays (Mon-Fri) in a date range using timezone-consistent date arithmetic.
 * Creates each date using the same local-midnight approach as parseDateLocal to avoid timezone drift.
 * @param {Date} startDate
 * @param {Date} endDate 
 * @param {string} timeZone
 * @returns {Date[]} Array of Date objects for weekdays only
 */
function getWeekdaysInRange(startDate, endDate, timeZone) {
  const weekdays = [];
  
  // Extract year, month, day from start date to avoid timezone issues
  const startYear = startDate.getFullYear();
  const startMonth = startDate.getMonth();
  const startDay = startDate.getDate();
  
  // Iterate day by day using local date construction (same as parseDateLocal approach)
  let currentYear = startYear;
  let currentMonth = startMonth;
  let currentDay = startDay;
  
  let iterationCount = 0;
  while (iterationCount < 100) { // Safety limit to prevent infinite loop
    // Create date using same local midnight approach as parseDateLocal
    const currentDate = new Date(currentYear, currentMonth, currentDay);
    
    // Check if we've passed the end date
    if (currentDate > endDate) break;
    
    const dayOfWeek = currentDate.getDay(); // 0 = Sunday, 6 = Saturday
    
    // Include only Monday (1) through Friday (5)
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      weekdays.push(currentDate);
    }
    
    // Increment to next day using Date constructor (handles month/year rollovers automatically)
    currentDay++;
    const nextDate = new Date(currentYear, currentMonth, currentDay);
    currentYear = nextDate.getFullYear();
    currentMonth = nextDate.getMonth();
    currentDay = nextDate.getDate();
    
    iterationCount++;
  }
  
  return weekdays;
}

/**
 * Helper: Gets total number of days in a range (inclusive)
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {number}
 */
function getDaysInRange(startDate, endDate) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((endDate.getTime() - startDate.getTime()) / millisecondsPerDay) + 1;
}

/**
 * Helper: Gets human-readable day name from day number
 * @param {number} dayNum - 0=Sunday, 1=Monday, etc.
 * @returns {string}
 */
function getDayName(dayNum) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[dayNum] || 'Unknown';
}

function compensateForSpreadsheetTimezone(centralTimeDate) {
  // Based on debug logs: Central Time date shows 1 day earlier in Mexico City timezone
  // So we add 1 day to compensate
  return new Date(centralTimeDate.getTime() + (24 * 60 * 60 * 1000));
}
