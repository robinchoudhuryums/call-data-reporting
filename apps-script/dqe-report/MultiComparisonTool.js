/* CONFIGURATION - COMPARISON TOOL */
const CONFIG_COMP = {
  DATA_SHEET: "Historical Data",
  AGENT_LIST_HEADER: "Agent Name", 
  COL_DATE: 5, COL_AGENT: 6, COL_RUNG: 9, COL_MISSED: 10, COL_ANSWERED: 11, COL_TTT: 12, COL_ATT: 13 
};

function openMultiComparisonTool() {
  const html = HtmlService.createHtmlOutputFromFile('MultiCompModal')
    .setWidth(1300).setHeight(900).setTitle('Comparison Range Report');
  SpreadsheetApp.getUi().showModalDialog(html, 'Comparison Range Report');
}

/* === 1. FETCH AGENTS === */
function getCompToolData(customStart, customEnd) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet(); 
  
  let originalX2, originalZ2;
  if (customStart && customEnd) {
    try {
      originalX2 = sheet.getRange("X2").getValue();
      originalZ2 = sheet.getRange("Z2").getValue();
      const parse = (dStr) => { const p = dStr.split('-'); return new Date(p[0], p[1]-1, p[2]); };
      sheet.getRange("X2").setValue(parse(customStart));
      sheet.getRange("Z2").setValue(parse(customEnd));
      SpreadsheetApp.flush(); 
    } catch (e) { console.error(e); }
  }

  const searchRange = sheet.getRange(1, 20, 20, 7); 
  const values = searchRange.getValues();
  let startRow = -1; let colIndex = -1;

  for(let r=0; r<values.length; r++) {
    for(let c=0; c<values[0].length; c++) {
      if(String(values[r][c]).trim() === CONFIG_COMP.AGENT_LIST_HEADER) {
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
  
  if (customStart && customEnd && originalX2) {
    sheet.getRange("X2").setValue(originalX2);
    sheet.getRange("Z2").setValue(originalZ2);
    SpreadsheetApp.flush();
  }
  
  return { agents: agents };
}

/* === 2. PROCESSOR === */
function processComparison(start1Str, end1Str, start2Str, end2Str, selectedAgents) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(CONFIG_COMP.DATA_SHEET);
  if (!dataSheet) throw new Error(`Sheet "${CONFIG_COMP.DATA_SHEET}" not found.`);
  const tz = ss.getSpreadsheetTimeZone();

  const parseDate = (s) => { 
    if(!s) return new Date();
    const p = s.split('-'); 
    return new Date(p[0], p[1]-1, p[2], 12, 0, 0); 
  };
  
  const start1 = parseDate(start1Str); const end1 = parseDate(end1Str);
  const start2 = parseDate(start2Str); const end2 = parseDate(end2Str);

  const fmt = "MMM d, yyyy";
  const label1 = `${Utilities.formatDate(start1, tz, fmt)} - ${Utilities.formatDate(end1, tz, fmt)}`;
  const label2 = `${Utilities.formatDate(start2, tz, fmt)} - ${Utilities.formatDate(end2, tz, fmt)}`;

  const range = dataSheet.getDataRange();
  const data = range.getValues();
  const displayData = range.getDisplayValues();

  const reportData = [];

  selectedAgents.forEach(agent => {
    const p1Stats = calculateCompPeriod(data, displayData, agent, start1, end1, tz);
    const p2Stats = calculateCompPeriod(data, displayData, agent, start2, end2, tz);

    const delta = {
      // Return objects for volume metrics to allow dual display
      rung: {
        daily: getPct(p1Stats.rungPerDay, p2Stats.rungPerDay),
        total: getPct(p1Stats.rung, p2Stats.rung)
      },
      missed: {
        daily: getPct(p1Stats.missedPerDay, p2Stats.missedPerDay),
        total: getPct(p1Stats.missed, p2Stats.missed)
      },
      answered: {
        daily: getPct(p1Stats.answeredPerDay, p2Stats.answeredPerDay),
        total: getPct(p1Stats.answeredCount, p2Stats.answeredCount)
      },
      // Averages/Efficiency remain single values
      pctAnswered: getPct(p1Stats.pctAnsweredVal, p2Stats.pctAnsweredVal), 
      ttt: getPct(p1Stats.tttSeconds, p2Stats.tttSeconds),
      att: getPct(p1Stats.attSeconds, p2Stats.attSeconds)
    };

    reportData.push({
      name: agent,
      dates: { p1: label1, p2: label2 }, 
      p1: { raw: p1Stats, formatted: formatCompData(p1Stats) },
      p2: { raw: p2Stats, formatted: formatCompData(p2Stats) },
      delta: delta
    });
  });

  return reportData;
}

/* === CALCULATION LOGIC === */
function calculateCompPeriod(data, displayData, agentName, startDate, endDate, tz) {
  let stats = { rung: 0, missed: 0, answeredCount: 0, tttSeconds: 0, attSum: 0 };
  const activeDays = new Set();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rawDateVal = new Date(row[CONFIG_COMP.COL_DATE]);
    if (!(rawDateVal instanceof Date) || isNaN(rawDateVal)) continue;
    
    const rowDate = new Date(rawDateVal.getFullYear(), rawDateVal.getMonth(), rawDateVal.getDate(), 12, 0, 0);
    const rowAgent = String(row[CONFIG_COMP.COL_AGENT]).trim();

    if (rowAgent === agentName && rowDate >= startDate && rowDate <= endDate) {
      activeDays.add(rowDate.getTime());
      const ans = Number(row[CONFIG_COMP.COL_ANSWERED]) || 0;
      stats.rung += Number(row[CONFIG_COMP.COL_RUNG]) || 0;
      stats.missed += Number(row[CONFIG_COMP.COL_MISSED]) || 0;
      stats.answeredCount += ans;
      stats.tttSeconds += parseDurationString(displayData[i][CONFIG_COMP.COL_TTT]);
      const dailyAtt = parseDurationString(displayData[i][CONFIG_COMP.COL_ATT]);
      if(ans > 0) stats.attSum += (dailyAtt * ans);
    }
  }
  
  const dayCount = activeDays.size > 0 ? activeDays.size : 1;
  
  stats.attSeconds = stats.answeredCount > 0 ? (stats.attSum / stats.answeredCount) : 0;
  stats.pctAnsweredVal = stats.rung > 0 ? (stats.answeredCount / stats.rung) : 0;
  
  // Daily Averages
  stats.rungPerDay = stats.rung / dayCount;
  stats.missedPerDay = stats.missed / dayCount;
  stats.answeredPerDay = stats.answeredCount / dayCount; // Added Answered
  stats.daysActive = activeDays.size;

  return stats;
}

function parseDurationString(timeStr) {
  if (!timeStr) return 0;
  const parts = String(timeStr).split(':');
  let totalSeconds = 0;
  if (parts.length === 3) {
    totalSeconds = (parseInt(parts[0]) * 3600) + (parseInt(parts[1]) * 60) + parseInt(parts[2]);
  } else if (parts.length === 2) {
    totalSeconds = (parseInt(parts[0]) * 60) + parseInt(parts[1]); 
  }
  return isNaN(totalSeconds) ? 0 : totalSeconds;
}

function formatCompData(stats) {
  return {
    rung: stats.rung,
    rungPerDay: stats.rungPerDay.toFixed(1),
    missed: stats.missed,
    missedPerDay: stats.missedPerDay.toFixed(1),
    answered: stats.answeredCount,
    answeredPerDay: stats.answeredPerDay.toFixed(1),
    pctAnswered: (stats.pctAnsweredVal * 100).toFixed(1) + "%",
    ttt: formatSecondsToTime(stats.tttSeconds),
    att: formatSecondsToTime(stats.attSeconds)
  };
}

function formatSecondsToTime(totalSeconds) {
  if (!totalSeconds || totalSeconds === 0) return "0:00:00";
  totalSeconds = Math.round(totalSeconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function getPct(oldVal, newVal) {
  if (oldVal === 0 && newVal === 0) return "-";    
  if (oldVal === 0) return "N/A";                  
  if (newVal === 0) return "-100%";                
  const pct = (newVal - oldVal) / oldVal;
  const sign = pct > 0 ? "+" : "";
  return sign + (pct * 100).toFixed(1) + "%";
}

function sendVisualComparisonEmail(base64Data) {
  const userEmail = Session.getActiveUser().getEmail();
  const decoded = Utilities.base64Decode(base64Data.split(',')[1]);
  const blob = Utilities.newBlob(decoded, 'image/png', 'Comparison_Report.png');
  MailApp.sendEmail({
    to: userEmail,
    subject: "Comparison Range Report",
    htmlBody: `<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">Here is the visual snapshot of the comparison report.</div><div style="text-align: center; border: 1px solid #eee; padding: 10px;"><img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;"></div>`,
    inlineImages: { reportImg: blob }
  });
  return userEmail;
}