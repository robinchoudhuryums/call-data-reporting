/* CONFIGURATION */
const CONFIG_INDIVIDUAL = {
  DATA_SHEET: "Historical Data",
  AGENT_LIST_HEADER: "Agent Name",
  DEPT_ROSTER_RANGE: "", 
  IGNORE_LIST: ["339", "Andy Abdullah"], 
  COL_DATE: 5, COL_AGENT: 6, COL_RUNG: 9, COL_MISSED: 10, COL_ANSWERED: 11, COL_TTT: 12, COL_ATT: 13
};

function openIndividualReportTool() {
  const html = HtmlService.createHtmlOutputFromFile('IndividualReportModal')
    .setWidth(1300).setHeight(900).setTitle('Individual & Peer Comparison Report');
  SpreadsheetApp.getUi().showModalDialog(html, 'Individual & Peer Comparison Report');
}

/* === 1. FETCH AGENTS & DEFAULTS === */
function getIndividualToolData(customStart, customEnd) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dashboard = ss.getActiveSheet();
  
  // Dynamic Date Force
  let originalX2, originalZ2;
  if (customStart && customEnd) {
    try {
      originalX2 = dashboard.getRange("X2").getValue();
      originalZ2 = dashboard.getRange("Z2").getValue();
      const parse = (dStr) => { const p = dStr.split('-'); return new Date(p[0], p[1]-1, p[2]); };
      dashboard.getRange("X2").setValue(parse(customStart));
      dashboard.getRange("Z2").setValue(parse(customEnd));
      SpreadsheetApp.flush(); 
    } catch (e) { console.error(e); }
  }

  const startVal = dashboard.getRange("X2").getValue();
  const endVal = dashboard.getRange("Z2").getValue();
  const formatDate = (d) => (d instanceof Date) ? Utilities.formatDate(d, ss.getSpreadsheetTimeZone(), "yyyy-MM-dd") : null;

  const searchRange = dashboard.getRange(1, 20, 20, 7); 
  const values = searchRange.getValues();
  let startRow = -1; let colIndex = -1;
  for(let r=0; r<values.length; r++) {
    for(let c=0; c<values[0].length; c++) {
      if(String(values[r][c]).trim() === CONFIG_INDIVIDUAL.AGENT_LIST_HEADER) {
        startRow = r + 1; colIndex = c; break;
      }
    }
    if (startRow !== -1) break;
  }
  
  const agents = [];
  if (startRow !== -1) {
    const actualCol = 20 + colIndex;
    const actualRow = startRow + 1; 
    const listValues = dashboard.getRange(actualRow, actualCol, 50, 1).getValues();
    for(let i=0; i<listValues.length; i++) {
      const val = String(listValues[i][0]).trim();
      if(val && val !== "") agents.push(val);
      else if (agents.length > 0) break; 
    }
  }

  // Revert Dates
  if (customStart && customEnd && originalX2) {
    dashboard.getRange("X2").setValue(originalX2);
    dashboard.getRange("Z2").setValue(originalZ2);
    SpreadsheetApp.flush();
  }

  return { agents: agents, defaultStart: formatDate(startVal), defaultEnd: formatDate(endVal) };
}

/* === 2. PROCESSOR === */
function processIndividualReport(startStr, endStr, selectedAgents) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dashboard = ss.getActiveSheet();
  const dataSheet = ss.getSheetByName(CONFIG_INDIVIDUAL.DATA_SHEET);
  const tz = ss.getSpreadsheetTimeZone(); 
  
  const sParts = startStr.split('-'); const eParts = endStr.split('-');
  const start = new Date(sParts[0], sParts[1]-1, sParts[2], 12, 0, 0);
  const end = new Date(eParts[0], eParts[1]-1, eParts[2], 12, 0, 0);
  const dateLabel = `${Utilities.formatDate(start, tz, "MMM d, yyyy")} - ${Utilities.formatDate(end, tz, "MMM d, yyyy")}`;

  // === FORCE TREND DATES ===
  let trendStartDate;
  const diffTime = Math.abs(end - start);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
  const isLastYear = (start.getMonth() === 0 && start.getDate() === 1 && end.getMonth() === 11 && end.getDate() === 31 && start.getFullYear() === end.getFullYear());

  if (diffDays > 366 || isLastYear) {
    trendStartDate = new Date(start); 
  } else {
    trendStartDate = new Date(end);
    trendStartDate.setMonth(trendStartDate.getMonth() - 12);
    trendStartDate.setDate(1); 
  }

  const originalX2 = dashboard.getRange("X2").getValue();
  const originalZ2 = dashboard.getRange("Z2").getValue();

  dashboard.getRange("X2").setValue(trendStartDate);
  dashboard.getRange("Z2").setValue(end);
  SpreadsheetApp.flush(); 

  const initData = getIndividualToolData(); 
  const fullRoster = new Set(initData.agents);
  const activeAgentCount = fullRoster.size || 1;
  
  dashboard.getRange("X2").setValue(originalX2);
  dashboard.getRange("Z2").setValue(originalZ2);
  SpreadsheetApp.flush(); 
  // =========================
  
  const masterMonthKeys = generateMonthList(trendStartDate, end, tz);

  // DATA FETCH
  const rawData = dataSheet.getDataRange().getValues();
  const rawDisplay = dataSheet.getDataRange().getDisplayValues(); 
  
  const aggregatedStats = {}; 
  const summaryStats = {}; 
  
  selectedAgents.forEach(agent => { 
    aggregatedStats[agent] = {}; 
    summaryStats[agent] = { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
  });

  const teamTotal = { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
  const activeDaySet = new Set(); // Track unique days for per-day calculation

  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    const rawDateVal = new Date(row[CONFIG_INDIVIDUAL.COL_DATE]);
    const rowDate = new Date(rawDateVal.getFullYear(), rawDateVal.getMonth(), rawDateVal.getDate(), 12, 0, 0);
    const rowAgent = String(row[CONFIG_INDIVIDUAL.COL_AGENT]).trim();

    const r = Number(row[CONFIG_INDIVIDUAL.COL_RUNG]) || 0;
    const m = Number(row[CONFIG_INDIVIDUAL.COL_MISSED]) || 0;
    const a = Number(row[CONFIG_INDIVIDUAL.COL_ANSWERED]) || 0;
    const tttSec = parseDurationString(rawDisplay[i][CONFIG_INDIVIDUAL.COL_TTT]);
    const attAvg = parseDurationString(rawDisplay[i][CONFIG_INDIVIDUAL.COL_ATT]);
    const attTotal = (a > 0) ? (attAvg * a) : 0;

    if (rowDate >= start && rowDate <= end && fullRoster.has(rowAgent)) {
      teamTotal.rung += r; teamTotal.missed += m; teamTotal.answered += a; teamTotal.ttt += tttSec; teamTotal.att_sum += attTotal;
      activeDaySet.add(rowDate.getTime()); // Count this day
    }

    if (aggregatedStats[rowAgent]) {
      if (rowDate >= trendStartDate && rowDate <= end) {
        const monthKey = Utilities.formatDate(rowDate, tz, "yyyy-MM"); 
        if (!aggregatedStats[rowAgent][monthKey]) aggregatedStats[rowAgent][monthKey] = { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
        const b = aggregatedStats[rowAgent][monthKey];
        b.rung += r; b.missed += m; b.answered += a; b.ttt += tttSec; b.att_sum += attTotal;
      }
      if (rowDate >= start && rowDate <= end) {
        const s = summaryStats[rowAgent];
        s.rung += r; s.missed += m; s.answered += a; s.ttt += tttSec; s.att_sum += attTotal;
      }
    }
  }

  // TEAM AVG (Per Agent)
  const teamAvg = {
    rung: Math.round(teamTotal.rung / activeAgentCount),
    missed: Math.round(teamTotal.missed / activeAgentCount),
    answered: Math.round(teamTotal.answered / activeAgentCount),
    pctAnswered: teamTotal.rung > 0 ? (teamTotal.answered / teamTotal.rung) * 100 : 0,
    ttt: teamTotal.answered > 0 ? (teamTotal.ttt / teamTotal.answered) : 0,
    att: teamTotal.answered > 0 ? (teamTotal.att_sum / teamTotal.answered) : 0
  };

  // DEPARTMENT DAILY STATS (Per Day)
  const dayCount = activeDaySet.size > 0 ? activeDaySet.size : 1;
  const deptStats = {
    dailyRung: (teamTotal.rung / dayCount).toFixed(1),
    dailyMissed: (teamTotal.missed / dayCount).toFixed(1),
    dailyAnswered: (teamTotal.answered / dayCount).toFixed(1),
    ansPct: (teamTotal.rung > 0 ? (teamTotal.answered / teamTotal.rung) * 100 : 0).toFixed(1) + "%" // Weighted Calc
  };

  // FORMAT TREND DATA
  const chartData = {
    labels: masterMonthKeys.map(m => {
      const parts = m.split('-');
      return Utilities.formatDate(new Date(parts[0], parts[1]-1, 1), tz, "MMM, yy");
    }),
    datasets: {}
  };

  selectedAgents.forEach(agent => {
    chartData.datasets[agent] = masterMonthKeys.map(m => {
      const bucket = aggregatedStats[agent][m] || { rung: 0, missed: 0, answered: 0, ttt: 0, att_sum: 0 };
      const pctAns = bucket.rung > 0 ? (bucket.answered / bucket.rung) * 100 : 0;
      const avgTTT = bucket.answered > 0 ? (bucket.ttt / bucket.answered) : 0; 
      const avgATT = bucket.answered > 0 ? (bucket.att_sum / bucket.answered) : 0; 
      return { rung: bucket.rung, missed: bucket.missed, answered: bucket.answered, pct: pctAns, ttt: avgTTT, att: avgATT };
    });
  });

  // SUMMARY DATA
  const finalSummary = selectedAgents.map(agent => {
    const s = summaryStats[agent];
    const agPct = s.rung > 0 ? (s.answered / s.rung) * 100 : 0;
    const agTTT = s.answered > 0 ? s.ttt / s.answered : 0;
    const agATT = s.answered > 0 ? s.att_sum / s.answered : 0;
    return {
      name: agent,
      stats: { rung: s.rung, missed: s.missed, answered: s.answered, pct: agPct.toFixed(1) + "%", ttt: formatSecondsToTime(agTTT), att: formatSecondsToTime(agATT) },
      raw: { rung: s.rung, missed: s.missed, answered: s.answered, pct: agPct, ttt: agTTT, att: agATT }
    };
  });

  return {
    dateLabel: dateLabel,
    trendData: chartData,
    summaryData: finalSummary,
    teamAvg: {
      rung: teamAvg.rung,
      missed: teamAvg.missed,
      answered: teamAvg.answered,
      pct: teamAvg.pctAnswered.toFixed(1) + "%",
      ttt: formatSecondsToTime(teamAvg.ttt),
      att: formatSecondsToTime(teamAvg.att),
      raw: teamAvg
    },
    deptStats: deptStats, // NEW: Dept Totals
    mode: selectedAgents.length > 1 ? 'comparison' : 'individual'
  };
}

/* === HELPERS === */
function generateMonthList(start, end, tz) {
  const list = [];
  let current = new Date(start);
  current.setDate(1); 
  const endMonth = new Date(end);
  endMonth.setDate(1); 
  while (current <= endMonth) {
    list.push(Utilities.formatDate(current, tz, "yyyy-MM"));
    current.setMonth(current.getMonth() + 1);
  }
  return list;
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

function formatSecondsToTime(totalSeconds) {
  if (!totalSeconds || totalSeconds === 0) return "0:00:00";
  totalSeconds = Math.round(totalSeconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function sendIndividualVisualEmail(base64Data, dateLabel) {
  const userEmail = Session.getActiveUser().getEmail();
  const decoded = Utilities.base64Decode(base64Data.split(',')[1]);
  const blob = Utilities.newBlob(decoded, 'image/png', 'Individual_Report.png');
  MailApp.sendEmail({
    to: userEmail,
    subject: `Individual Report: ${dateLabel}`,
    htmlBody: `<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">Here is the visual snapshot of the individual performance report.</div><div style="text-align: center; border: 1px solid #eee; padding: 10px;"><img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;"></div>`,
    inlineImages: { reportImg: blob }
  });
  return userEmail;
}