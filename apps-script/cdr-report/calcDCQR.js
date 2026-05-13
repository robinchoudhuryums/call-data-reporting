function updateReportMetrics() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("Raw Data");
  const reportSheet = ss.getSheetByName("tester"); 
  
  const csrRange = ss.getRangeByName("csr_team").getValues();
  const csrTeamSet = new Set();
  csrRange.forEach(row => { if (row[0]) csrTeamSet.add(String(row[0]).split(",")[0].trim().toLowerCase()); });

  const exceptionRange = ss.getRangeByName("csr_exceptions");
  const csrExceptionsSet = new Set();
  if (exceptionRange) {
    exceptionRange.getValues().forEach(row => { 
      if (row[0]) csrExceptionsSet.add(String(row[0]).split(",")[0].trim().toLowerCase()); 
    });
  }

  const steeringSet = new Set();
  const steeringSheet = ss.getSheetByName("Steering Number");
  if (steeringSheet) {
    let sVals = steeringSheet.getRange("B51:H51").getValues()[0];
    sVals.forEach(v => { if (v) steeringSet.add(String(v).trim().toLowerCase()); });
  }

  const q40_name = String(reportSheet.getRange(40, 1).getValue()).trim().toLowerCase();

  const rawData = rawSheet.getDataRange().getValues();
  const rawDisplay = rawSheet.getDataRange().getDisplayValues();
  rawData.shift(); 
  rawDisplay.shift();
  
  const results = {};

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
    } else { let f = parseFloat(timeStr); if (!isNaN(f)) return f % 1; }
    return -1;
  }

  const time600AM = 6 / 24, time630AM = 6.5 / 24, time300PM = 15 / 24, time330PM = 15.5 / 24;
  const time1Min = 1 / 1440, time2Min = 2 / 1440, time20Sec = 20 / 86400;  

  let r34_abnd1m = 0, r34_abnd2m = 0;
  let r35_C_p1 = 0, r35_C_p2 = 0, r35_C_p3 = 0, r35_D_p2 = 0, r35_D_p3 = 0, r35_E_1m = 0, r35_E_2m = 0, r35_F_max = -1, r35_F_orig = null, r35_G_sum = 0, r35_G_count = 0;
  let r36_C_p1 = 0, r36_C_p2 = 0, r36_C_p3 = 0, r36_D_p2 = 0, r36_D_p3 = 0, r36_E_2m = 0, r36_F_max = -1, r36_F_orig = null, r36_G_sum = 0, r36_G_count = 0;
  let r37_C_p1 = 0, r37_C_p3 = 0, r37_E_1m = 0, r37_E_2m = 0, r37_F_max = -1, r37_F_orig = null, r37_G_sum = 0, r37_G_count = 0;
  let r40_tot1 = 0, r40_tot2 = 0, r40_tot3 = 0, r40_tot4 = 0, r40_tot5 = 0, r40_tot6 = 0;

  rawData.forEach((row, index) => {
    let status    = String(row[1]).trim();       
    let type      = String(row[5]).trim().toLowerCase();       
    let team      = String(row[9]).trim().toLowerCase(); 
    let queueName = String(row[11]).trim().toLowerCase(); 
    let dnisNum   = String(row[16]).trim();      
    let abandoned = String(row[24]).trim().toLowerCase();      
    let transfer  = String(row[26]).trim().toLowerCase();      
    
    let waitStr   = rawDisplay[index][7]; 
    let startDec  = parseTimeStr(rawDisplay[index][45]);
    let endDec    = parseTimeStr(rawDisplay[index][46]);
    let waitDec   = parseTimeStr(waitStr);
    let isColGPos = parseTimeStr(rawDisplay[index][6]) > 0;
    
    if (startDec <= time600AM || startDec === -1 || endDec === -1) return;

    let isCSR = csrTeamSet.has(team);
    let isAQ = (queueName === "a_q_csr" || queueName === "a_q_intake");
    
    let is630to1500 = (startDec > time630AM && startDec < time300PM && endDec < time300PM);
    
    if (is630to1500) {
      if (!results[queueName]) {
        results[queueName] = { 
          csrTransfers: 0, csrAbandoned: 0, csrAbandoned20s: 0, csrMaxWaitVal: -1, csrMaxWaitOrig: null, csrTransferWaitSumDec: 0, csrTransferCount: 0,
          nonCsrTransfers: 0, nonCsrAbandoned: 0, nonCsrAbnd20s: 0, nonCsrWaitSumDec: 0, nonCsrWaitCount: 0, nonCsrMaxWaitVal: -1, nonCsrMaxWaitOrig: null,
          stat3Transfers: 0, stat3Abandoned: 0, stat3MaxWaitVal: -1, stat3MaxWaitOrig: null, stat3WaitSumDec: 0, stat3WaitCount: 0,
          dnisNotAbnd: 0, dnisAbnd20s: 0, dnis2NotAbnd: 0, dnis2Abnd20s: 0, absMaxWaitVal: -1, absMaxWaitOrig: null, dnisWaitSumDec: 0, dnisWaitCount: 0, dnis2WaitSumDec: 0, dnis2WaitCount: 0,
          dnisMaxWaitVal: -1, dnisMaxWaitOrig: null, stat3NonDnisAbnd: 0, stat3NonDnisNotAbnd: 0, stat3NonDnisMaxWaitVal: -1, stat3NonDnisMaxWaitOrig: null, stat3NonDnisWaitSumDec: 0, stat3NonDnisWaitCount: 0
        };
      }

      if (waitDec > results[queueName].absMaxWaitVal) { results[queueName].absMaxWaitVal = waitDec; results[queueName].absMaxWaitOrig = waitStr; }

      if (status === "1") {
        if (isCSR && type === "internal") {
          if (transfer === "transfer") { results[queueName].csrTransfers++; if (waitDec >= 0) { results[queueName].csrTransferWaitSumDec += waitDec; results[queueName].csrTransferCount++; } }
          if (abandoned === "abandoned" && waitDec >= 0) { if (waitDec > time1Min) results[queueName].csrAbandoned++; if (waitDec > time20Sec) results[queueName].csrAbandoned20s++; }
          if (transfer === "transfer" || abandoned === "abandoned") { if (waitDec > results[queueName].csrMaxWaitVal) { results[queueName].csrMaxWaitVal = waitDec; results[queueName].csrMaxWaitOrig = waitStr; } }
        }
        if (!isCSR) {
          if (type === "internal") {
            if (transfer === "transfer") results[queueName].nonCsrTransfers++;
            if (abandoned === "abandoned") { if (waitDec > time1Min) results[queueName].nonCsrAbandoned++; if (waitDec > time20Sec) results[queueName].nonCsrAbnd20s++; }
          }
          if (abandoned !== "abandoned" && waitDec >= 0) { results[queueName].nonCsrWaitSumDec += waitDec; results[queueName].nonCsrWaitCount++; }
          if (waitDec > results[queueName].nonCsrMaxWaitVal) { results[queueName].nonCsrMaxWaitVal = waitDec; results[queueName].nonCsrMaxWaitOrig = waitStr; }
        }
      }

      if (status === "3") {
        if (transfer === "transfer") results[queueName].stat3Transfers++;
        if (abandoned === "abandoned" && waitDec > time1Min) results[queueName].stat3Abandoned++;
        if (waitDec > results[queueName].stat3MaxWaitVal) { results[queueName].stat3MaxWaitVal = waitDec; results[queueName].stat3MaxWaitOrig = waitStr; }
        if (abandoned !== "abandoned" && waitDec >= 0) { results[queueName].stat3WaitSumDec += waitDec; results[queueName].stat3WaitCount++; }

        if (dnisNum !== "18883645897") {
          if (abandoned === "abandoned" && waitDec > time1Min) results[queueName].stat3NonDnisAbnd++;
          else if (abandoned !== "abandoned" && waitDec >= 0) results[queueName].stat3NonDnisNotAbnd++;
          if (waitDec > results[queueName].stat3NonDnisMaxWaitVal) { results[queueName].stat3NonDnisMaxWaitVal = waitDec; results[queueName].stat3NonDnisMaxWaitOrig = waitStr; }
          if (abandoned !== "abandoned" && waitDec >= 0) { results[queueName].stat3NonDnisWaitSumDec += waitDec; results[queueName].stat3NonDnisWaitCount++; }
        }
      }

      if (dnisNum === "18883645897") {
        if (abandoned !== "abandoned") results[queueName].dnisNotAbnd++;
        if (abandoned === "abandoned" && waitDec > time20Sec) results[queueName].dnisAbnd20s++;
        if (abandoned !== "abandoned" && waitDec >= 0) { results[queueName].dnisWaitSumDec += waitDec; results[queueName].dnisWaitCount++; }
        if (waitDec > results[queueName].dnisMaxWaitVal) { results[queueName].dnisMaxWaitVal = waitDec; results[queueName].dnisMaxWaitOrig = waitStr; }
      }
      if (dnisNum === "18667759594") {
        if (abandoned !== "abandoned") results[queueName].dnis2NotAbnd++;
        if (abandoned === "abandoned" && waitDec > time20Sec) results[queueName].dnis2Abnd20s++;
        if (abandoned !== "abandoned" && waitDec >= 0) { results[queueName].dnis2WaitSumDec += waitDec; results[queueName].dnis2WaitCount++; }
      }

      if (queueName === q40_name) {
        if (status === "1" && type === "internal") {
          if (transfer === "transfer") r40_tot1++;
          if (abandoned === "abandoned" && waitDec > 0) r40_tot2++;
          if (abandoned === "abandoned" && waitDec > time1Min) r40_tot5++;
        }
        if (status !== "1" && type === "incoming") {
          if (transfer === "transfer") r40_tot3++;
          if (abandoned === "abandoned" && waitDec > 0) r40_tot4++;
          if (abandoned === "abandoned" && waitDec > time1Min) r40_tot6++;
        }
      }
    }

    // ============================================
    // THE METICULOUS TIME BOUNDARIES (34 - 37)
    // ============================================
    
    // ROW 34 - FIXED: Only checks Start < 15:00
    if (startDec > time600AM && startDec < time300PM) {
      if (abandoned === "abandoned" && !steeringSet.has(team) && isAQ) {
        if (waitDec > time1Min) r34_abnd1m++;
        if (waitDec > time2Min) r34_abnd2m++;
      }
    }

    let isCsrQ = csrTeamSet.has(queueName);
    let isExcQ = csrExceptionsSet.has(queueName);

    if (isAQ && status === "3" && abandoned === "abandoned" && waitDec > time1Min) {
      if (startDec > time600AM && startDec < time300PM && endDec < time300PM) r35_C_p1++;
      if (startDec > time600AM && startDec < time300PM) { r35_E_1m++; if (waitDec > time2Min) r35_E_2m++; }
    }
    if (startDec > time600AM && startDec < time300PM && endDec < time300PM && isAQ) {
      if (waitDec > r35_F_max) { r35_F_max = waitDec; r35_F_orig = waitStr; }
      if (abandoned !== "abandoned" && waitDec >= 0) { r35_G_sum += waitDec; r35_G_count++; }
    }

    if (type === "incoming") {
      let isStat4 = status === "4" && isCsrQ; 
      let isStat5 = status === "5" && isExcQ; 
      if (isStat4 || isStat5) {
        if (startDec > time600AM && startDec < time300PM && endDec < time330PM) {
          if (isStat4) r35_C_p2++;
          if (isStat5) r35_C_p3++;
        }
        if (startDec > time600AM && endDec < time330PM) {
          if (isStat4) r35_D_p2++;
          if (isStat5) r35_D_p3++;
        }
      }
    }

    if (isAQ && type !== "internal" && status !== "3" && abandoned === "abandoned") {
      if (startDec > time600AM && startDec < time300PM) {
        if (waitDec > time1Min) r36_C_p1++;
        if (waitDec > time2Min) r36_E_2m++; 
      }
    }
    if (startDec > time600AM && startDec < time300PM && endDec < time300PM && isAQ && type !== "internal" && status !== "3") {
      if (waitDec > r36_F_max) { r36_F_max = waitDec; r36_F_orig = waitStr; }
      if (queueName === "a_q_csr" && type === "incoming" && abandoned !== "abandoned" && waitDec >= 0) { r36_G_sum += waitDec; r36_G_count++; }
    }

    if (type === "incoming" && isColGPos) {
      let isNot4Main = status !== "4" && isCsrQ && !isExcQ;
      let isNot45Exc = status !== "4" && status !== "5" && isExcQ;
      if (isNot4Main || isNot45Exc) {
        if (startDec > time600AM && startDec < time330PM) {
          if (isNot4Main) r36_C_p2++;
          if (isNot45Exc) r36_C_p3++;
        }
        if (startDec > time600AM && endDec < time330PM) {
          if (isNot4Main) r36_D_p2++;
          if (isNot45Exc) r36_D_p3++;
        }
      }
    }

    if (type === "internal") {
      if (startDec > time600AM && startDec < time300PM && endDec < time300PM && isAQ && abandoned === "abandoned" && waitDec > time1Min && !isCSR) r37_C_p1++;
      if (startDec > time600AM && startDec < time300PM && endDec < time300PM && isColGPos && isCsrQ && !isCSR) r37_C_p3++;
      if (startDec > time600AM && startDec < time300PM && endDec < time300PM && isAQ && abandoned === "abandoned") {
        if (waitDec > time1Min) r37_E_1m++;
        if (waitDec > time2Min) r37_E_2m++;
      }
      if (startDec > time600AM && startDec < time300PM && endDec < time300PM && isAQ) {
        if (waitDec > r37_F_max) { r37_F_max = waitDec; r37_F_orig = waitStr; }
        if (queueName === "a_q_csr" && abandoned !== "abandoned" && waitDec >= 0) { r37_G_sum += waitDec; r37_G_count++; }
      }
    }
  });

  const rowAgg = {}; 
  const primaryRows = [3, 8, 11, 15, 18, 21, 24, 28, 32, 39, 42, 45, 48];
  primaryRows.forEach(r => {
    let ref = (r === 48) ? 47 : r; 
    let queue = String(reportSheet.getRange(ref, 1).getValue()).trim().toLowerCase(); 
    let res = results[queue] || { csrTransfers: 0, csrAbandoned: 0, csrMaxWaitOrig: null, csrTransferWaitSumDec: 0, csrTransferCount: 0 };

    if ([3, 8, 11, 15, 18, 21, 24, 28, 32, 39, 42, 45, 48].includes(r)) reportSheet.getRange(r, 3).setValue(res.csrTransfers + res.csrAbandoned); 
    reportSheet.getRange(r, 4).setValue(res.csrTransfers);
    reportSheet.getRange(r, 5).setValue(res.csrAbandoned);
    reportSheet.getRange(r, 6).setValue(res.csrMaxWaitOrig !== null ? res.csrMaxWaitOrig : 0);
    
    if ([3, 8, 11, 15, 18, 21, 24, 28, 32, 39, 42, 45, 48].includes(r)) { 
      reportSheet.getRange(r, 7).setValue(res.csrTransferCount > 0 ? (res.csrTransferWaitSumDec / res.csrTransferCount) : 0);
      rowAgg[r] = { sum: res.csrTransferWaitSumDec, count: res.csrTransferCount };
    }
  });

  const parentMap = { 6:3, 9:8, 12:11, 16:15, 19:18, 22:21, 25:24, 29:28, 33:32, 46:45, 49:48 };
  const cRows20s = [6, 9, 12, 16, 19, 22, 25, 29, 33];
  const cRows1m = [46, 49];

  Object.keys(parentMap).forEach(childStr => {
    let c = Number(childStr);
    let p = parentMap[c];
    let ref = (p === 48) ? 47 : p;
    let queue = String(reportSheet.getRange(ref, 1).getValue()).trim().toLowerCase(); 
    let res = results[queue] || { nonCsrTransfers: 0, nonCsrAbandoned: 0, nonCsrAbnd20s: 0, nonCsrWaitSumDec: 0, nonCsrWaitCount: 0, nonCsrMaxWaitOrig: null, csrAbandoned20s: 0, csrAbandoned: 0 };
    
    if (cRows20s.includes(c)) reportSheet.getRange(c, 3).setValue((res.nonCsrTransfers || 0) + (res.nonCsrAbnd20s || 0) + ((res.csrAbandoned20s || 0) - (res.csrAbandoned || 0))); 
    if (cRows1m.includes(c)) reportSheet.getRange(c, 3).setValue((res.nonCsrTransfers || 0) + (res.nonCsrAbandoned || 0)); 

    if ([6, 9, 12, 16, 19, 22, 25, 29, 33, 46, 49].includes(c)) reportSheet.getRange(c, 4).setValue(res.nonCsrTransfers || 0);
    if ([9, 12, 16, 19, 22, 25, 29, 33, 46, 49].includes(c)) reportSheet.getRange(c, 5).setValue(res.nonCsrAbandoned || 0);
    if (c === 6) reportSheet.getRange(c, 5).setValue(res.nonCsrAbnd20s || 0); 
    if ([6, 9, 12, 16, 19, 22, 25, 29, 33, 46, 49].includes(c)) reportSheet.getRange(c, 6).setValue(res.nonCsrMaxWaitOrig !== null && res.nonCsrMaxWaitOrig !== undefined ? res.nonCsrMaxWaitOrig : 0);
    
    if ([6, 9, 12, 16, 19, 22, 25, 29, 33, 46, 49].includes(c)) {
      reportSheet.getRange(c, 7).setValue(res.nonCsrWaitCount > 0 ? (res.nonCsrWaitSumDec / res.nonCsrWaitCount) : 0);
      rowAgg[c] = { sum: res.nonCsrWaitSumDec, count: res.nonCsrWaitCount };
    }
  });

  [13, 26, 30].forEach(r => {
    let queue = String(reportSheet.getRange(r, 1).getValue()).trim().toLowerCase();
    let res = results[queue] || { stat3Transfers: 0, stat3Abandoned: 0, stat3MaxWaitOrig: null, stat3WaitSumDec: 0, stat3WaitCount: 0 };
    reportSheet.getRange(r, 3).setValue(res.stat3Transfers + res.stat3Abandoned);
    reportSheet.getRange(r, 4).setValue(res.stat3Transfers);
    reportSheet.getRange(r, 5).setValue(res.stat3Abandoned);
    reportSheet.getRange(r, 6).setValue(res.stat3MaxWaitOrig !== null ? res.stat3MaxWaitOrig : 0);
    reportSheet.getRange(r, 7).setValue(res.stat3WaitCount > 0 ? (res.stat3WaitSumDec / res.stat3WaitCount) : 0);
    rowAgg[r] = { sum: res.stat3WaitSumDec, count: res.stat3WaitCount };
  });

  [4, 43].forEach(r => {
    let ref = (r === 4) ? 3 : r; 
    let queue = String(reportSheet.getRange(ref, 1).getValue()).trim().toLowerCase();
    let res = results[queue] || { dnisNotAbnd: 0, dnisAbnd20s: 0, dnis2NotAbnd: 0, dnis2Abnd20s: 0, dnisMaxWaitOrig: null, absMaxWaitOrig: null, dnisWaitSumDec: 0, dnisWaitCount: 0, dnis2WaitSumDec: 0, dnis2WaitCount: 0 };
    
    if (r === 4) {
      reportSheet.getRange(r, 3).setValue(res.dnisNotAbnd + res.dnisAbnd20s);
      reportSheet.getRange(r, 4).setValue(res.dnisNotAbnd);
      reportSheet.getRange(r, 5).setValue(res.dnisAbnd20s);
      reportSheet.getRange(r, 6).setValue(res.dnisMaxWaitOrig !== null ? res.dnisMaxWaitOrig : 0);
      reportSheet.getRange(r, 7).setValue(res.dnisWaitCount > 0 ? (res.dnisWaitSumDec / res.dnisWaitCount) : 0);
      rowAgg[4] = { sum: res.dnisWaitSumDec, count: res.dnisWaitCount };
    }
    if (r === 43) {
      reportSheet.getRange(r, 3).setValue(res.dnis2NotAbnd + res.dnis2Abnd20s);
      reportSheet.getRange(r, 4).setValue(res.dnis2NotAbnd);
      reportSheet.getRange(r, 5).setValue(res.dnis2Abnd20s);
      reportSheet.getRange(r, 6).setValue(res.absMaxWaitOrig !== null ? res.absMaxWaitOrig : 0);
      reportSheet.getRange(r, 7).setValue(res.dnis2WaitCount > 0 ? (res.dnis2WaitSumDec / res.dnis2WaitCount) : 0);
      rowAgg[43] = { sum: res.dnis2WaitSumDec, count: res.dnis2WaitCount };
    }
  });

  let q5 = String(reportSheet.getRange(3, 1).getValue()).trim().toLowerCase();
  let res5 = results[q5] || { stat3NonDnisAbnd: 0, stat3NonDnisNotAbnd: 0, stat3NonDnisMaxWaitOrig: null, stat3NonDnisWaitSumDec: 0, stat3NonDnisWaitCount: 0 };
  reportSheet.getRange(5, 3).setValue(res5.stat3NonDnisAbnd + res5.stat3NonDnisNotAbnd);
  reportSheet.getRange(5, 4).setValue(res5.stat3NonDnisNotAbnd);
  reportSheet.getRange(5, 5).setValue(res5.stat3NonDnisAbnd);
  reportSheet.getRange(5, 6).setValue(res5.stat3NonDnisMaxWaitOrig !== null ? res5.stat3NonDnisMaxWaitOrig : 0);
  reportSheet.getRange(5, 7).setValue(res5.stat3NonDnisWaitCount > 0 ? (res5.stat3NonDnisWaitSumDec / res5.stat3NonDnisWaitCount) : 0);
  rowAgg[5] = { sum: res5.stat3NonDnisWaitSumDec, count: res5.stat3NonDnisWaitCount };

  reportSheet.getRange(34, 5).setValue(r34_abnd1m + " | " + r34_abnd2m);
  
  reportSheet.getRange(35, 3).setValue(r35_C_p1 + r35_C_p2 + r35_C_p3);
  reportSheet.getRange(35, 4).setValue(r35_D_p2 + r35_D_p3); 
  reportSheet.getRange(35, 5).setValue(r35_E_1m + " | " + r35_E_2m);
  reportSheet.getRange(35, 6).setValue(r35_F_orig !== null ? r35_F_orig : 0);
  reportSheet.getRange(35, 7).setValue(r35_G_count > 0 ? (r35_G_sum / r35_G_count) : 0);
  rowAgg[35] = { sum: r35_G_sum, count: r35_G_count };

  reportSheet.getRange(36, 3).setValue(r36_C_p1 + r36_C_p2 + r36_C_p3);
  reportSheet.getRange(36, 4).setValue(r36_D_p2 + r36_D_p3); 
  reportSheet.getRange(36, 5).setValue(r36_C_p1 + " | " + r36_E_2m);
  reportSheet.getRange(36, 6).setValue(r36_F_orig !== null ? r36_F_orig : 0);
  reportSheet.getRange(36, 7).setValue(r36_G_count > 0 ? (r36_G_sum / r36_G_count) : 0);
  rowAgg[36] = { sum: r36_G_sum, count: r36_G_count };

  reportSheet.getRange(37, 3).setValue(r37_C_p1 + r37_C_p3);
  reportSheet.getRange(37, 4).setValue(r37_C_p3);
  reportSheet.getRange(37, 5).setValue(r37_E_1m + " | " + r37_E_2m);
  reportSheet.getRange(37, 6).setValue(r37_F_orig !== null ? r37_F_orig : 0);
  reportSheet.getRange(37, 7).setValue(r37_G_count > 0 ? (r37_G_sum / r37_G_count) : 0);
  rowAgg[37] = { sum: r37_G_sum, count: r37_G_count };

  let c39 = Number(reportSheet.getRange(39, 3).getValue()) || 0;
  let d39 = Number(reportSheet.getRange(39, 4).getValue()) || 0;
  let e39 = Number(reportSheet.getRange(39, 5).getValue()) || 0;
  reportSheet.getRange(40, 3).setValue((r40_tot1 + r40_tot2 + r40_tot3 + r40_tot4) - c39);
  reportSheet.getRange(40, 4).setValue((r40_tot1 + r40_tot3) - d39);
  reportSheet.getRange(40, 5).setValue((r40_tot5 + r40_tot6) - e39);
  
  let res40 = results[q40_name] || { nonCsrMaxWaitOrig: null, nonCsrWaitSumDec: 0, nonCsrWaitCount: 0 };
  reportSheet.getRange(40, 6).setValue(res40.nonCsrMaxWaitOrig !== null ? res40.nonCsrMaxWaitOrig : 0);
  reportSheet.getRange(40, 7).setValue(res40.nonCsrWaitCount > 0 ? (res40.nonCsrWaitSumDec / res40.nonCsrWaitCount) : 0);
  rowAgg[40] = { sum: res40.nonCsrWaitSumDec, count: res40.nonCsrWaitCount };

  const totalRowMap = { 2: [3, 4, 5, 6], 7: [8, 9], 10: [11, 12, 13], 14: [15, 16], 17: [18, 19], 20: [21, 22], 23: [24, 25], 27: [28, 29, 30], 31: [32, 33], 34: [35, 36, 37], 38: [39, 40], 41: [42, 43], 44: [45, 46], 47: [48, 49] };

  Object.keys(totalRowMap).forEach(totRowStr => {
    let totRow = Number(totRowStr);
    let children = totalRowMap[totRow];
    let tSum = 0;
    let tCount = 0;
    children.forEach(child => { if (rowAgg[child]) { tSum += rowAgg[child].sum; tCount += rowAgg[child].count; } });
    reportSheet.getRange(totRow, 7).setValue(tCount > 0 ? (tSum / tCount) : 0);
  });
}