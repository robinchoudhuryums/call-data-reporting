/* CONFIGURATION */
const CONFIG_MISSED = {
  HISTORY_SHEET: 'Historical Data',
  LOOKUP_SHEET: 'DO NOT EDIT!',
  COL_DATE: 5, COL_AGENT: 6, COL_EXTS: 7, COL_AI_TEXT: 35,
  COL_GHOST: 62, 
  COL_TIME_START: 14, COL_TIME_END: 32,   
  LOOKUP_NAME_COL: 0, LOOKUP_EXT_COL: 1,
  AGENT_LIST_HEADER: "Agent Name",
  PST_TO_CST_OFFSET: 2,
  CHART_START_HOUR: 8, CHART_END_HOUR: 17    
};

function openMissedReportTool() {
  const html = HtmlService.createHtmlOutputFromFile('MissedReportModal')
    .setWidth(1300).setHeight(900).setTitle('Missed Call Report');
  SpreadsheetApp.getUi().showModalDialog(html, 'Missed Call Report');
}

/* === 1. INITIALIZE (BLANK DATES) === */
function getMissedToolDefaults() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet(); 
  
  // Return empty strings to force "mm/dd/yyyy" placeholder
  return {
    defaultStart: "", 
    defaultEnd: "",
    extensions: String(sheet.getRange('B5').getValue()).trim()
  };
}

/* === 2. PROCESSOR === */
function processMissedReport(startStr, endStr, extString) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = ss.getActiveSheet(); 
  const tz = ss.getSpreadsheetTimeZone();

  const parseDate = (s) => { 
    if(!s) return new Date();
    const p = s.split('-'); return new Date(p[0], p[1]-1, p[2], 12, 0, 0); 
  };
  const startDate = parseDate(startStr);
  const endDate = parseDate(endStr);
  
  const dateRangeStr = `${Utilities.formatDate(startDate, tz, "MMM d, yyyy")} - ${Utilities.formatDate(endDate, tz, "MMM d, yyyy")}`;

  if (!extString) throw new Error("No Extension provided.");
  const validExtensions = extString.split(',').map(s => String(s).trim());
  const deptName = getDeptNameByExtension(ss, extString) || "Unknown Dept";

  const roster = getDeptRoster(activeSheet);
  const rosterSet = new Set(roster.map(a => a.toLowerCase()));

  const sheet = ss.getSheetByName(CONFIG_MISSED.HISTORY_SHEET);
  const data = sheet.getDataRange().getValues();
  const agentMap = {}; 
  
  const totalHours = CONFIG_MISSED.CHART_END_HOUR - CONFIG_MISSED.CHART_START_HOUR;
  const totalBuckets = totalHours * 2; 
  const chartCounts = new Array(totalBuckets).fill(0); 

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rawDateVal = new Date(row[CONFIG_MISSED.COL_DATE]);
    if (!(rawDateVal instanceof Date) || isNaN(rawDateVal)) continue;

    const rowDate = new Date(rawDateVal.getFullYear(), rawDateVal.getMonth(), rawDateVal.getDate(), 12, 0, 0);
    
    if (rowDate < startDate || rowDate > endDate) continue;

    const rowExtString = String(row[CONFIG_MISSED.COL_EXTS]); 
    const rowExts = rowExtString.split(',').map(s => String(s).trim());
    const isRowRelevant = rowExts.some(r => validExtensions.includes(r));
    
    if (isRowRelevant) {
      const agent = String(row[CONFIG_MISSED.COL_AGENT]).trim();
      if (!agent) continue;
      if (!rosterSet.has(agent.toLowerCase())) continue;

      if (!agentMap[agent]) agentMap[agent] = [];

      const timeData = extractTimesFromRow(row, rowDate, tz, validExtensions);
      agentMap[agent].push(...timeData.textLines);
      
      timeData.minutesFromStart.forEach(mins => {
        if (mins >= 0) {
          const bucketIndex = Math.floor(mins / 30);
          if (bucketIndex >= 0 && bucketIndex < totalBuckets) {
            chartCounts[bucketIndex]++;
          }
        }
      });
    }
  }

  const chartLabels = [];
  for (let i = 0; i < totalBuckets; i++) {
    const totalMinutes = (CONFIG_MISSED.CHART_START_HOUR * 60) + (i * 30);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const displayH = h > 12 ? h - 12 : h;
    chartLabels.push(`${displayH}:${m === 0 ? '00' : m} ${ampm}`);
  }

  return {
    deptName: deptName,
    dateLabel: dateRangeStr,
    agents: agentMap, 
    chartData: chartCounts,
    chartLabels: chartLabels,
    agentCount: Object.keys(agentMap).length
  };
}

/* === HELPERS === */
function getDeptRoster(sheet) {
  const searchRange = sheet.getRange(1, 20, 20, 7); 
  const values = searchRange.getValues();
  let startRow = -1; let colIndex = -1;
  for(let r=0; r<values.length; r++) {
    for(let c=0; c<values[0].length; c++) {
      if(String(values[r][c]).trim() === CONFIG_MISSED.AGENT_LIST_HEADER) {
        startRow = r + 1; colIndex = c; break;
      }
    }
    if (startRow !== -1) break;
  }
  const agents = [];
  if (startRow !== -1) {
    const actualCol = 20 + colIndex;
    const actualRow = startRow + 1; 
    const listValues = sheet.getRange(actualRow, actualCol, 50, 1).getValues();
    for(let i=0; i<listValues.length; i++) {
      const val = String(listValues[i][0]).trim();
      if(val && val !== "") agents.push(val);
      else if (agents.length > 0) break; 
    }
  }
  return agents;
}

function extractTimesFromRow(row, dateObj, timeZone, validExtensions) {
  const textLines = [];
  const minutesFromStart = []; 
  const dateStr = Utilities.formatDate(dateObj, timeZone, "M/d");
  const aiText = String(row[CONFIG_MISSED.COL_AI_TEXT]);

  let rawGhost = row[CONFIG_MISSED.COL_GHOST];
  let rawValues = [];
  let isGhostData = false;

  if (rawGhost && String(rawGhost).trim() !== "") {
    isGhostData = true;
    rawValues = String(rawGhost).split(',');
  } else {
    for (let c = CONFIG_MISSED.COL_TIME_START; c <= CONFIG_MISSED.COL_TIME_END; c++) {
      if (row[c]) rawValues.push(row[c]);
    }
  }

  rawValues.forEach(rawT => {
    let t = (typeof rawT === 'string') ? rawT.trim() : String(rawT).trim();
    if(!t) return;

    if (isGhostData && t.includes('[')) {
      const matchTag = t.match(/\[(\d+)\]/);
      if (matchTag) {
        if (!validExtensions.includes(String(matchTag[1]))) return; 
      }
      t = t.split('[')[0].trim();
    }

    let pstDate = null;
    if (Object.prototype.toString.call(rawT) === '[object Date]' && !isGhostData) {
      pstDate = new Date(rawT);
    } else {
      const d = new Date(dateObj.getTime());
      const match = String(t).match(/(\d+):(\d+)(?::(\d+))?\s*(AM|PM)?/i);
      if (match) {
        let hrs = parseInt(match[1]);
        const mins = parseInt(match[2]);
        const ampm = match[4] ? match[4].toUpperCase() : null;
        if (ampm === "PM" && hrs < 12) hrs += 12;
        if (ampm === "AM" && hrs === 12) hrs = 0;
        d.setHours(hrs, mins, 0);
        pstDate = d;
      }
    }

    if (pstDate) {
      let cstDate = new Date(pstDate.getTime());
      cstDate.setHours(cstDate.getHours() + CONFIG_MISSED.PST_TO_CST_OFFSET);
      const callHour = cstDate.getHours();
      const callMin = cstDate.getMinutes();
      const minutesPastMidnight = (callHour * 60) + callMin;
      const startMinutes = CONFIG_MISSED.CHART_START_HOUR * 60;
      minutesFromStart.push(minutesPastMidnight - startMinutes);

      const timeStr = Utilities.formatDate(cstDate, timeZone, "h:mm:ss a");
      const matchStr = Utilities.formatDate(pstDate, timeZone, "h:mm:ss"); 
      let alarm = aiText.includes(matchStr) ? " 🚨" : "";
      textLines.push(`${dateStr} - ${timeStr}${alarm}`);
    }
  });
  return { textLines, minutesFromStart };
}

function getDeptNameByExtension(ss, extString) {
  const sheet = ss.getSheetByName(CONFIG_MISSED.LOOKUP_SHEET);
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  const inputExt = extString.split(',')[0].trim();
  for (let i = 1; i < data.length; i++) {
    const dbExt = String(data[i][CONFIG_MISSED.LOOKUP_EXT_COL]).trim();
    if (dbExt === inputExt) return data[i][CONFIG_MISSED.LOOKUP_NAME_COL];
  }
  return null;
}

//function sendVisualMissedEmail(base64Data, deptName) {
//  const userEmail = Session.getActiveUser().getEmail();
//  const decoded = Utilities.base64Decode(base64Data.split(',')[1]);
//  const blob = Utilities.newBlob(decoded, 'image/png', 'Missed_Report.png');
//  MailApp.sendEmail({
//    to: userEmail,
//    subject: `Missed Call Report: ${deptName}`,
//    htmlBody: `<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">Here is the visual snapshot of the missed call report.</div><div style="text-align: center; border: 1px solid #eee; padding: 10px;"><img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;"></div>`,
//    inlineImages: { reportImg: blob }
//  });
//  return userEmail;
//}

function sendVisualMissedEmail(base64Data, deptName) {
  const userEmail = Session.getActiveUser().getEmail();
  
  // Handle both PNG and JPEG formats
  const isJPEG = base64Data.includes('data:image/jpeg');
  const mimeType = isJPEG ? 'image/jpeg' : 'image/png';
  const fileName = isJPEG ? 'Missed_Report.jpg' : 'Missed_Report.png';
  
  const decoded = Utilities.base64Decode(base64Data.split(',')[1]);
  const blob = Utilities.newBlob(decoded, mimeType, fileName);
  
  MailApp.sendEmail({
    to: userEmail,
    subject: `Missed Call Report: ${deptName}`,
    htmlBody: `<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">Here is the visual snapshot of the missed call report.</div><div style="text-align: center; border: 1px solid #eee; padding: 10px;"><img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;"></div>`,
    inlineImages: { reportImg: blob }
  });
  return userEmail;
}