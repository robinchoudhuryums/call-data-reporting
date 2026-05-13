// --- CONFIGURATION ---
const LOW_ANS_CONFIG = {
  LOGO_URL: "https://cdn.jsdelivr.net/gh/robinchoudhuryums/marketing-images@main/UMS%20Presentation%20Logo.jpg",
  BACKGROUND_IMAGE_URL: "https://cdn.jsdelivr.net/gh/robinchoudhuryums/marketing-images@main/Patient%20Portal%20Background_portrait.png",
  ALERT_LOG_SHEET: "Alert Log",
  HISTORICAL_DATA_SHEET: "Historical Data",
  CC_EMAIL: "robin.choudhury@universalmedsupply.com"
};

/** 
// --- Main function to check answer rates across multiple sheets ---
function checkLowAnswerRate_MultiSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetEmailMap = {
    "CSR Q": "robin.choudhury@universalmedsupply.com", "Sales Q": "sam.roy@universalmedsupply.com,nathan.solanki@universalmedsupply.com",
    "Power Q": "rajdeep.thakar@universalmedsupply.com", "Manual Mobility Q": "parth.dave@universalmedsupply.com",
    "Resupply Q": "nikunj.solanki@universalmedsupply.com", "Field Ops Q": "mahesh.patel@universalmedsupply.com",
    "Field Ops Power Q": "ozaire.hawa@universalmedsupply.com", "Service Q": "arnav.pan@universalmedsupply.com",
    "Billing Q": "bhoj.bhatt@universalmedsupply.com", "Denials Q": "monil.shah@universalmedsupply.com",
    "PAK Q": "mary.carson@universalmedsupply.com", "PAP Q": "sam.roy@universalmedsupply.com",
    "Eligibility MM&R Q": "rakshit.shah@universalmedsupply.com"
  };

  const sheetThresholdMap = {
    "CSR Q": 0.90, "Sales Q": 0.67,
    "Field Ops Q": 0.67, "Field Ops Power Q": 0.67
  };

  const monitoredSheets = Object.keys(sheetEmailMap);
  const scriptProps = PropertiesService.getScriptProperties();
  const lastWorkday = getLastWorkday();
  const lastWorkdayStr = Utilities.formatDate(lastWorkday, Session.getScriptTimeZone(), "MM/dd/yyyy");

  // Update B1 on all monitored sheets
  const histSheet = ss.getSheetByName(LOW_ANS_CONFIG.HISTORICAL_DATA_SHEET);
  const dates = histSheet.getRange("F:F").getValues().flat().filter(v => v instanceof Date);
  if (dates.length > 0) {
    const latestDate = new Date(Math.max(...dates));
    monitoredSheets.forEach(sheetName => {
      const sheet = ss.getSheetByName(sheetName);
      if (sheet) sheet.getRange("B1").setValue(latestDate);
    });
  }

  monitoredSheets.forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    const toEmail = sheetEmailMap[sheetName];
    const c2 = sheet.getRange("C2").getValue();
    const g2 = sheet.getRange("G2").getValue();
    const b1 = sheet.getRange("B1").getValue();
    const b1DateStr = Utilities.formatDate(new Date(b1), Session.getScriptTimeZone(), "MM/dd/yyyy");
    const threshold = sheetThresholdMap[sheetName] || 0.33;
    const alertKey = `lastAlertDate_${sheetName}`;

    if (typeof c2 === 'number' && c2 < threshold && b1DateStr === lastWorkdayStr) {
      const lastAlertDate = scriptProps.getProperty(alertKey);
      if (lastAlertDate !== lastWorkdayStr) {

        const dataRange = sheet.getRange("A7:F20").getValues();
        const filteredRows = dataRange.filter((row, index) => index === 0 || (row[0] && typeof row[5] === 'number' && row[5] < 0.5));

        const subject = `Low Answer Rate Alert - ${sheetName}`;
        const htmlBody = buildLowAnswerRateEmailBody(sheetName, b1DateStr, c2, g2, filteredRows, ss.getUrl(), sheet.getSheetId());

        MailApp.sendEmail({
          to: toEmail,
          cc: LOW_ANS_CONFIG.CC_EMAIL,
          subject: subject,
          htmlBody: htmlBody
        });

        let logSheet = ss.getSheetByName(LOW_ANS_CONFIG.ALERT_LOG_SHEET);
        if (!logSheet) {
          logSheet = ss.insertSheet(LOW_ANS_CONFIG.ALERT_LOG_SHEET);
          logSheet.hideSheet();
          logSheet.appendRow(["Timestamp", "Sheet", "B1 Date", "Answer %", "Abandoned Calls"]);
        }
        logSheet.appendRow([new Date(), sheetName, b1DateStr, `${(c2 * 100).toFixed(1)}%`, g2]);
        scriptProps.setProperty(alertKey, lastWorkdayStr);
      }
    }
  });
}

function buildLowAnswerRateEmailBody(sheetName, date, answerRate, abandonedCalls, agentData, spreadsheetUrl, sheetId) {
  let tableHtml = "";
  if (agentData.length > 1) {
    tableHtml += `<h3 style="color: #333; border-top: 1px solid #eeeeee; padding-top: 15px; margin-top: 20px;">Agents with <50% Answer Rate</h3>`;
    tableHtml += `<table style="border-collapse: collapse; width: 100%; text-align: center;">`;
    agentData.forEach((row, rowIndex) => {
      const isHeader = rowIndex === 0;
      const style = isHeader ? 'background-color:#4A6D9E; color:#ffffff; font-weight:bold;' : `background-color:${rowIndex % 2 === 0 ? '#f7f7f7' : '#ffffff'};`;
      tableHtml += `<tr style="${style}">`;
      row.forEach((cell, colIndex) => {
        let display = (colIndex === 5 && typeof cell === 'number' && !isHeader) ? `${(cell * 100).toFixed(1)}%` : cell;
        tableHtml += `<td style="padding: 8px; border: 1px solid #ddd;">${display}</td>`;
      });
      tableHtml += `</tr>`;
    });
    tableHtml += `</table>`;
  }

  const c2Formatted = `<span style="color:red; font-weight:bold;">${(answerRate * 100).toFixed(1)}%</span>`;
  const abandonedLine = abandonedCalls > 0 ? `<p style="margin: 5px 0; font-size: 14px;"><strong>Abandoned Calls:</strong> <span style="color:red; font-weight:bold;">${abandonedCalls}</span></p>` : "";

  return `
    <div style="background-image: url('${LOW_ANS_CONFIG.BACKGROUND_IMAGE_URL}'); background-color: #e9ecef; background-size: cover; padding: 40px; font-family: sans-serif;">
      <div style="background-color: rgba(255, 255, 255, 0.85); padding: 25px; border-radius: 8px;">
        <table style="width:100%; border-collapse:collapse; margin-bottom:15px;">
          <tr>
            <td style="width:60px; vertical-align:middle;"><img src="${LOW_ANS_CONFIG.LOGO_URL}" alt="Company Logo" style="height:50px; display:block;"></td>
            <td style="vertical-align:middle; padding-left:15px;"><h2 style="margin:0; text-align:left; color:#d93025;">Low Answer Rate Alert</h2></td>
          </tr>
        </table>
        <div style="background-color: #f8f9fa; border: 1px solid #dee2e6; padding: 15px; border-radius: 4px;">
          <p style="margin: 5px 0; font-size: 14px;"><strong>Queue:</strong> ${sheetName}</p>
          <p style="margin: 5px 0; font-size: 14px;"><strong>Date:</strong> ${date}</p>
          <p style="margin: 5px 0; font-size: 14px;"><strong>Answer Rate:</strong> ${c2Formatted}</p>
          ${abandonedLine}
        </div>
        ${tableHtml}
        <div style="text-align: center; margin-top: 30px;">
          <a href="${spreadsheetUrl}#gid=${sheetId}" target="_blank" style="background-color: #4285F4; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">
            View in Spreadsheet
          </a>
        </div>
      </div>
    </div>
  `;
}

*/

// Helper function to get last workday (remains the same)
function getLastWorkday() {
  let date = new Date();
  date.setDate(date.getDate() - 1);
  while (date.getDay() === 0 || date.getDay() === 6) { date.setDate(date.getDate() - 1); }
  date.setHours(0, 0, 0, 0);
  return date;
}