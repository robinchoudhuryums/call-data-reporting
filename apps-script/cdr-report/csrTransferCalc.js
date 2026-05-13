function updateAgentTransferReport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("Raw Data");
  
  // Now pointing to your main dashboard sheet!
  const reportSheet = ss.getSheetByName("tester"); 
  
  const rawData = rawSheet.getDataRange().getValues();
  const rawDisplay = rawSheet.getDataRange().getDisplayValues();
  rawData.shift(); 
  rawDisplay.shift();
  
  // Dynamically grab the headers from N1:X1 (Columns 14 to 24)
  const queueHeadersRaw = reportSheet.getRange("N1:X1").getValues()[0];
  const queueHeaders = queueHeadersRaw.map(h => String(h).trim().toLowerCase());
  
  const agentMetrics = {}; 
  
  // The exact indestructible time parser
  function parseTimeStr(str) {
    if (!str) return -1;
    let timeStr = String(str).trim();
    if (timeStr.includes(" ")) {
      let spaceParts = timeStr.split(" ");
      if (spaceParts[0].includes("/")) { spaceParts.shift(); timeStr = spaceParts.join(" "); }
    }
    let isPM = timeStr.toLowerCase().includes("pm"), isAM = timeStr.toLowerCase().includes("am");
    timeStr = timeStr.replace(/am|pm/gi, "").trim();
    if (timeStr.includes(":")) {
      let p = timeStr.split(":");
      let h = parseInt(p[0], 10) || 0, m = parseInt(p[1], 10) || 0, s = parseFloat(p[2]) || 0;
      if (isPM && h < 12) h += 12; if (isAM && h === 12) h = 0;
      return (h / 24) + (m / 1440) + (s / 86400);
    } else { 
      let f = parseFloat(timeStr); 
      if (!isNaN(f)) return f % 1; 
    }
    return -1;
  }
  
  const time600AM = 6 / 24;
  const time330PM = 15.5 / 24;
  
  // --- SCAN THE RAW DATA ---
  rawDisplay.forEach(row => {
    let startDec = parseTimeStr(row[45]); // AT
    let stopDec  = parseTimeStr(row[46]); // AU
    let talkDec  = parseTimeStr(row[6]);  // G
    
    // Caller = Index 9 (J), Callee = Index 11 (L)
    let callerName = String(row[9]).trim().toLowerCase(); 
    let calleeName = String(row[11]).trim().toLowerCase(); 
    
    if (startDec === -1 || stopDec === -1) return;
    
    // 1. Logic for Total Calls: Agent is the CALLEE, TalkTime > 0
    if (calleeName && startDec > time600AM && stopDec < time330PM && talkDec > 0) {
      if (!agentMetrics[calleeName]) agentMetrics[calleeName] = { totalCalls: 0, queues: {} };
      agentMetrics[calleeName].totalCalls++;
    }
    
    // 2. Logic for Queues: Agent is the CALLER, Queue is the CALLEE
    if (callerName && calleeName && startDec > time600AM && stopDec < time330PM) {
      if (!agentMetrics[callerName]) agentMetrics[callerName] = { totalCalls: 0, queues: {} };
      
      if (!agentMetrics[callerName].queues[calleeName]) {
        agentMetrics[callerName].queues[calleeName] = 0;
      }
      agentMetrics[callerName].queues[calleeName]++;
    }
  });
  
  // --- PASTE TO THE SHEET ---
  const lastRow = reportSheet.getLastRow();
  if (lastRow < 2) return; 
  
  // Now reading the Agent Names from Column J (J2:J)
  const reportData = reportSheet.getRange("J2:J" + lastRow).getValues();
  const colL_Values = [];
  const colN_X_Values = [];
  
  reportData.forEach(row => {
    let agent = String(row[0]).trim().toLowerCase();
    
    if (agent === "") {
      colL_Values.push([""]); 
      colN_X_Values.push(new Array(11).fill("")); 
    } else {
      // Pull Total Calls (for Column L)
      let tCalls = agentMetrics[agent] ? agentMetrics[agent].totalCalls : 0;
      colL_Values.push([tCalls]); 
      
      // Pull Queues (for Columns N through X)
      let queueRow = [];
      queueHeaders.forEach(qHead => {
        let count = 0;
        if (agentMetrics[agent] && agentMetrics[agent].queues[qHead]) {
          count = agentMetrics[agent].queues[qHead];
        }
        queueRow.push(count);
      });
      colN_X_Values.push(queueRow);
    }
  });
  
  // Writes Total Calls to Column L (Column index 12)
  reportSheet.getRange(2, 12, colL_Values.length, 1).setValues(colL_Values);
  
  // Writes Queues to Columns N through X (Column index 14, width of 11 columns)
  reportSheet.getRange(2, 14, colN_X_Values.length, 11).setValues(colN_X_Values);
}