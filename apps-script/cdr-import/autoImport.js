/**
 * -------------------------------------------------------------------------
 * FINAL SYSTEM v30 (Integrated QCD & CSR Transfer Engines)
 * -------------------------------------------------------------------------
 *
 * BUG FIX: Reverted memory engines to use `simulateSplitCol2` on raw CSV 
 * columns C and E. The raw CSV array is capped at 44 columns, so pointing 
 * it to spreadsheet helper columns (AT/AU) resulted in out-of-bounds undefined 
 * errors. 
 */

// -------------------------------------------------------------------------
// CONFIGURATION CONSTANTS
// -------------------------------------------------------------------------
const TARGET_SS_ID = "15KgGg4ol_uSRGlUwLmUIRJ8fDlDqUcy2iQdnY9IbuE0";
const MAX_COLS = 44;

const DEPT_COLORS = {
  0: "#cfe2f3", 1: "#d9ead3", 2: "#f6b26b", 3: "#f4cccc",
  4: "#ead1dc", 5: "#fce5cd", 6: "#d0e0e3", 7: "#e6b8af",
  8: "#d9d2e9", 9: "#BDBDBD", 10: "#fff2cc"
};

const SALES_QUEUE_NUMBER = "18883645897";
const SALES_PATH_VM      = "192";                
const SALES_PATH_EXCLUDE = "1017";               
const SALES_PATH_DIRECT  = "165";                
const SALES_PATH_OPT1    = "1 (No Option Name)"; 


// -------------------------------------------------------------------------
// TRIGGERS
// -------------------------------------------------------------------------
function onChange(e) {
  if (e.changeType !== 'INSERT_GRID') return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log("onChange: Could not acquire lock — another instance is running. Skipping.");
    return;
  }
  try {
    const outcome = processNewImport();
    // processNewImport already shows step toasts and a Step 7 completion toast,
    // but those show on the source SS. This confirms the trigger fired and succeeded.
        if (outcome && outcome.startsWith("DONE")) {
        const time    = outcome.split(" | ")[0].split(": ")[1];
        const counts  = outcome.includes(" | ") ? outcome.split(" | ").slice(1).join(" | ") : "";
        const message = counts ? `Completed in ${time}\n${counts}` : `Completed in ${time}`;
        SpreadsheetApp.getActiveSpreadsheet().toast(message, "✅ Auto-Export", 10);
} else if (outcome === "ALREADY PROCESSED" || outcome === "ALREADY IN HISTORY") {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        "Sheet already processed — no action taken.", "ℹ️ Auto-Export", 5
      );
    }
  } finally {
    lock.releaseLock();
  }
}


// -------------------------------------------------------------------------
// MENU FUNCTIONS
// -------------------------------------------------------------------------

function runManualExport() {
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(
    "Manual Processing",
    "Leave empty for LATEST.\nOr enter YYYY-MM-DD:",
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() !== ui.Button.OK) return;

  const input = result.getResponseText().trim();
  let dateArg = null;

  if (input === "") {
    dateArg = null;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    dateArg = input;
  } else {
    ui.alert("Invalid format. Use YYYY-MM-DD.");
    return;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    ui.alert("⚠️ Busy", "Another export is already running. Please wait a moment and try again.", ui.ButtonSet.OK);
    return;
  }

  let outcome;
  try {
    outcome = processNewImport(true, dateArg, false);
  } finally {
    lock.releaseLock();
  }

  const label = dateArg || "latest available date";

  switch (outcome) {
    case "MISSING":
      ui.alert("⚠️ Not Found", `No sheet found for: ${label}.`, ui.ButtonSet.OK);
      break;
    case "ALREADY PROCESSED":
      ui.alert("ℹ️ Already Done", `${label} was already processed this session.`, ui.ButtonSet.OK);
      break;
    case "ALREADY IN HISTORY":
      ui.alert("ℹ️ Already in History", `${label} already exists in all historical sheets.`, ui.ButtonSet.OK);
      break;
    default:
      if (outcome && outcome.startsWith("DONE")) {
        const time = outcome.split(" | ")[0].split(": ")[1];
        const counts = outcome.includes(" | ") ? `\n\n${outcome.split(" | ").slice(1).join("\n")}` : "";
        ui.alert("✅ Complete", `${label} exported successfully in ${time}.${counts}`, ui.ButtonSet.OK);

      } else {
        ui.alert("⚠️ Unexpected Result", String(outcome), ui.ButtonSet.OK);
      }
  }
}


// -------------------------------------------------------------------------
// BULK QUEUE PROCESSING
// -------------------------------------------------------------------------

function bulkHistoricalUpdate() {
  const ui     = SpreadsheetApp.getUi();
  const result = ui.prompt("Bulk Update", "Enter date range:\n(e.g., 2025-11-01 to 2025-11-15)", ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() != ui.Button.OK) return;

  const input = result.getResponseText().trim();
  const match = input.match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    ui.alert("Invalid format. Use: YYYY-MM-DD to YYYY-MM-DD");
    return;
  }

  const dates = getDateRange(match[1], match[2]);
    if (dates[dates.length - 1] !== match[2]) {
    ui.alert("Range Too Large", `Date range exceeds 365 days and was not queued.\n\nRequested end: ${match[2]}\nMax reachable: ${dates[dates.length - 1]}\n\nPlease split into smaller ranges.`, ui.ButtonSet.OK);
    return;
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty("bulkQueue",  JSON.stringify(dates));
  props.setProperty("bulkIndex",  "0");
  props.setProperty("bulkReport", JSON.stringify([]));

  ui.alert("✅ Queue Created", `Ready to process ${dates.length} dates.\nStart: ${dates[0]}\nEnd: ${dates[dates.length - 1]}`, ui.ButtonSet.OK);
  processBulkQueue();
}

function processBulkQueue() {
  const ui    = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const queue  = JSON.parse(props.getProperty("bulkQueue")  || "[]");
  let   index  = parseInt(props.getProperty("bulkIndex")    || "0");
  const report = JSON.parse(props.getProperty("bulkReport") || "[]");

  if (queue.length === 0) {
    ui.alert("No Queue", "No active queue found.", ui.ButtonSet.OK);
    return;
  }

  const batchStartTime = Date.now();
  const TIME_LIMIT     = 240000; 

  let targetSS = null;
  try {
    targetSS = SpreadsheetApp.openById(TARGET_SS_ID);
  } catch (e) {
    ui.alert("Critical Error", "Could not open Target Spreadsheet. Aborting.", ui.ButtonSet.OK);
    return;
  }

  const histDateCache = {
    cdr:   buildHistoryDateSet(targetSS, "CDR Historical Data"),
    qpath: buildHistoryDateSet(targetSS, "Q Path Historical Data"),
    qcd:   buildHistoryDateSet(targetSS, "QCD Historical Data"),
    csr:   buildHistoryDateSet(targetSS, "CSR Transfer Historical Data")
  };

  while (index < queue.length) {
    if (Date.now() - batchStartTime > TIME_LIMIT) {
      const remaining = queue.length - index;
      props.setProperty("bulkIndex",  String(index));
      props.setProperty("bulkReport", JSON.stringify(report));
      ui.alert("⏳ Time Limit", `Paused to avoid timeout.\n${remaining} dates remaining.\n\nClick 'Resume Bulk Processing' to continue.`, ui.ButtonSet.OK);
      return;
    }

    const dateStr = queue[index];

    try {
      SpreadsheetApp.getActiveSpreadsheet().toast(`Processing ${dateStr} (${index + 1}/${queue.length})...`, "Bulk Progress", -1);

      const result = processNewImport(true, dateStr, true, targetSS, histDateCache);

      if (result === "MISSING") {
        report.push(`⚪ ${dateStr}: Skipped (No Sheet)`);
        } else if (result.startsWith("DONE")) {
        const time = result.split(" | ")[0].split(": ")[1];
        const counts = result.includes(" | ") ? ` — ${result.split(" | ").slice(1).join(" | ")}` : "";
        report.push(`✅ ${dateStr}: Success (${time}${counts})`);
        } else {
        report.push(`⚠️ ${dateStr}: ${result}`);
      }

    } catch (e) {
      const userChoice = ui.alert("❌ Error on " + dateStr, `${e.message}\n\nContinue?`, ui.ButtonSet.YES_NO);
      if (userChoice == ui.Button.YES) {
        report.push(`❌ ${dateStr}: Failed (${e.message})`);
      } else {
        props.setProperty("bulkIndex",  String(index));
        props.setProperty("bulkReport", JSON.stringify(report));
        ui.alert("⛔ Stopped", "Bulk processing stopped.", ui.ButtonSet.OK);
        return;
      }
    }

    index++;
    props.setProperty("bulkIndex",  String(index));
    props.setProperty("bulkReport", JSON.stringify(report));
  }

  SpreadsheetApp.getActiveSpreadsheet().toast("Archiving all dates...", "Final Step", -1);
  try {
    const archiveResult = processBatchArchive(true); 
    report.push("---");
    report.push(`✅ Batch archive complete (CDR: +${archiveResult.cdrCount}, QPath: +${archiveResult.qpathCount}, QCD: +${archiveResult.qcdCount}, CSR: +${archiveResult.csrCount})`);
    appendToAuditLog(targetSS, "processBulkQueue",
      `Processed ${queue.length} dates`,
      `CDR: +${archiveResult.cdrCount}, QPath: +${archiveResult.qpathCount}, QCD: +${archiveResult.qcdCount}, CSR: +${archiveResult.csrCount}`
    ); 
  } catch (e) {
    report.push("---");
    report.push(`⚠️ Archive failed: ${e.message}`);
    ui.alert("⚠️ Archive Warning", `Bulk processing complete, but archive failed:\n${e.message}\n\nYou can retry with 'Process Batch Archive' from the menu.`, ui.ButtonSet.OK);
  }

  ui.alert("Bulk Complete", report.join("\n"), ui.ButtonSet.OK);

  props.deleteProperty("bulkQueue");
  props.deleteProperty("bulkIndex");
  props.deleteProperty("bulkReport");
}

function getDateRange(startStr, endStr) {
  const dates      = [];
  const startParts = startStr.split('-').map(Number);
  let   current    = new Date(startParts[0], startParts[1] - 1, startParts[2], 12, 0, 0);

  let safety = 0;
  while (safety < 365) {
    const dString = Utilities.formatDate(current, Session.getScriptTimeZone(), "yyyy-MM-dd");
    dates.push(dString);
    if (dString === endStr) break;
    current.setDate(current.getDate() + 1);
    safety++;
  }
  return dates;
}


// -------------------------------------------------------------------------
// MAIN PROCESS
// -------------------------------------------------------------------------

function processNewImport(force = false, specificDateStr = null, silent = false, preOpenedTargetSS = null, histDateCache = null) {
  const sourceSS  = SpreadsheetApp.getActiveSpreadsheet();
  const ui        = SpreadsheetApp.getUi();
  const startTime = new Date().getTime();

  try {
    let targetSheetInfo;
    if (specificDateStr) {
      const specificName = `Call_Legs_${specificDateStr}`;
      const sheet        = sourceSS.getSheetByName(specificName);

      if (!sheet) {
        if (silent) {
          console.log(`Skipping ${specificDateStr}: Sheet not found.`);
          return "MISSING";
        } else {
          throw new Error(`Sheet '${specificName}' not found.`);
        }
      }

      const parts = specificDateStr.split('-');
      const d     = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
      targetSheetInfo = { name: specificName, dateObj: d };
    } else {
      targetSheetInfo = getLatestValidSheet(sourceSS);
    }

    if (!targetSheetInfo) { return "MISSING"; }

    const { name: latestName, dateObj } = targetSheetInfo;
    const props     = PropertiesService.getScriptProperties();
    const lastKnown = JSON.parse(props.getProperty("lastSheets") || "[]");
    const shouldRun = force || !lastKnown.includes(latestName);

    if (!shouldRun) { return "ALREADY PROCESSED"; }
    if (!silent) sourceSS.toast(`Processing: ${latestName}`, "Step 1/7", -1);

    const targetSS    = preOpenedTargetSS || SpreadsheetApp.openById(TARGET_SS_ID);
    const rawDataSheet = targetSS.getSheetByName("Raw Data");
    const outputSheet  = targetSS.getSheetByName("CDR Output");
    const configSheet  = targetSS.getSheetByName("DO NOT EDIT!");

    if (!rawDataSheet || !outputSheet || !configSheet) throw new Error("Target Sheets missing.");

    const dateKey     = dateObj.toDateString();
    let existsInCDR   = histDateCache ? histDateCache.cdr.has(dateKey)   : checkHistoryForDate(targetSS, "CDR Historical Data",    dateObj);
    let existsInQPath = histDateCache ? histDateCache.qpath.has(dateKey) : checkHistoryForDate(targetSS, "Q Path Historical Data", dateObj);
    let existsInQCD   = histDateCache ? histDateCache.qcd.has(dateKey)   : checkHistoryForDate(targetSS, "QCD Historical Data",    dateObj);
    let existsInCSR   = histDateCache ? histDateCache.csr.has(dateKey)   : checkHistoryForDate(targetSS, "CSR Transfer Historical Data", dateObj);

    if (existsInCDR && existsInQPath && existsInQCD && existsInCSR && !force) {
      if (!silent) ui.alert("❌ Aborted", `Data for ${dateObj.toDateString()} already exists.`, ui.ButtonSet.OK);
      return "ALREADY IN HISTORY";
    }

    if (force) {
      if (existsInCDR) {
        const obcHD = targetSS.getSheetByName("CDR Historical Data");
        if (obcHD) { deleteHistoricalRowsForDate(obcHD, dateObj, 3); if (histDateCache) histDateCache.cdr.delete(dateKey); }
        existsInCDR = false;
      }
      if (existsInQPath) {
        const salesHD = targetSS.getSheetByName("Q Path Historical Data");
        if (salesHD) { deleteHistoricalRowsForDate(salesHD, dateObj, 3); if (histDateCache) histDateCache.qpath.delete(dateKey); }
        existsInQPath = false;
      }
      if (existsInQCD) {
        const qcdHD = targetSS.getSheetByName("QCD Historical Data");
        if (qcdHD) { deleteHistoricalRowsForDate(qcdHD, dateObj, 3); if (histDateCache) histDateCache.qcd.delete(dateKey); }
        existsInQCD = false;
      }
      if (existsInCSR) {
        const csrHD = targetSS.getSheetByName("CSR Transfer Historical Data");
        if (csrHD) { deleteHistoricalRowsForDate(csrHD, dateObj, 3); if (histDateCache) histDateCache.csr.delete(dateKey); }
        existsInCSR = false;
      }
      SpreadsheetApp.flush();
    }

    const sourceSheet = sourceSS.getSheetByName(latestName);
    const sourceData  = sourceSheet.getDataRange().getDisplayValues();
    if (sourceData.length < 2) throw new Error("Source sheet empty.");
    const cleanData = sourceData.map(row => row.slice(0, MAX_COLS));

    const isHistoricalBackfill = silent && specificDateStr;

    if (!isHistoricalBackfill) {
      if (!silent) sourceSS.toast("Transferring...", "Step 2/7", -1);
      const valueData = cleanData.map(row => row.map(cell => {
        if (cell === "" || cell === null) return "";
        const num = Number(cell);
        return isNaN(num) ? cell : num;
      }));
      rawDataSheet.clearContents();
      const CHUNK_SIZE = 5000;
      for (let i = 0; i < valueData.length; i += CHUNK_SIZE) {
        const chunk = valueData.slice(i, i + CHUNK_SIZE);
        rawDataSheet.getRange(i + 1, 1, chunk.length, MAX_COLS).setValues(chunk);
      }
      SpreadsheetApp.flush(); 
    }

    if (!silent) sourceSS.toast("Calculating Core...", "Step 3/7", -1);
    const results = calculateMetricsInMemory(cleanData, configSheet);

    if (!silent) sourceSS.toast("Calculating Extra Reports...", "Step 4/7", -1);
    results.qcdData = calcQcdReport(cleanData, targetSS);
    results.csrData = calcCsrReport(cleanData, targetSS);

    if (!isHistoricalBackfill) {
      if (!silent) sourceSS.toast("Updating Reports...", "Step 5/7", -1);
      updateOutputSheet(outputSheet, results.Agents, dateObj);
      updateQcdrOutputSheet(targetSS, results.qcdData, results.csrData);
      SpreadsheetApp.flush();
    }

    let historyReport = [];
    if (!isHistoricalBackfill) {
      if (!silent) sourceSS.toast("Archiving...", "Step 6/7", -1);
      historyReport = processIntegratedHistory(targetSS, outputSheet, results, dateObj, existsInCDR, existsInQPath, existsInQCD, existsInCSR);
    } else {
      queueToPendingArchive(targetSS, results, dateObj, existsInCDR, existsInQPath, existsInQCD, existsInCSR);
      historyReport.push("- Queued for batch archive");
    }

    if (!lastKnown.includes(latestName)) {
      lastKnown.push(latestName);
      props.setProperty("lastSheets", JSON.stringify(lastKnown));
    }

    const endTime         = new Date().getTime();
    const durationSeconds = ((endTime - startTime) / 1000).toFixed(1);

      if (!isHistoricalBackfill && historyReport.counts) {
      const c = historyReport.counts;
      const countLine = `CDR: +${c.cdr} | QPath: +${c.qpath} | QCD: +${c.qcd} | CSR: +${c.csr}`;
      if (!silent) sourceSS.toast(countLine, `✅ Done in ${durationSeconds}s`, 8);
      return `DONE: ${durationSeconds}s | ${countLine}`;
    }
    if (!silent) sourceSS.toast(`Finished in ${durationSeconds}s`, "✅ Step 7/7 — Complete", 6);
    return `DONE: ${durationSeconds}s`;

  } catch (e) {
    console.error(e);
    if (silent) { throw e; }
    else { SpreadsheetApp.getUi().alert("❌ Process Failed", e.message, SpreadsheetApp.getUi().ButtonSet.OK); }
  }
}

// ─────────────────────────────────────────────
//  Pending Archive: Queue
// ─────────────────────────────────────────────

function queueToPendingArchive(targetSS, results, dateObj, skipCDR, skipQPath, skipQCD, skipCSR) {
  let pendingSheet = targetSS.getSheetByName("Pending Archive");

  if (!pendingSheet) {
    pendingSheet = targetSS.insertSheet("Pending Archive");
    pendingSheet.getRange("A1:AH1").setValues([[
      "Date", "Type", "AgentName", "Month", "Week", "Dept",
      "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W",
      "SalesPath", "Total", "VM", "NonVM", "Opt1", "NonOpt1", "Pct"
    ]]);
    SpreadsheetApp.flush();
  }

  // Store date as ISO string to prevent Date object formatting bleed
  // into adjacent numeric columns when Sheets reads the data back
  const dateStr  = Utilities.formatDate(dateObj, targetSS.getSpreadsheetTimeZone(), "yyyy-MM-dd");
  const monthStr = getMonthYearStr(dateObj);
  const weekStr  = getWeekOfMonthStr(dateObj);

  // Check for already-queued types for this date.
  // Uses parsePendingDate to handle both legacy Date objects and new ISO strings.
  const alreadyQueued  = new Set();
  const lastPendingRow = pendingSheet.getLastRow();
  if (lastPendingRow > 1) {
    const existingMeta = pendingSheet.getRange(2, 1, lastPendingRow - 1, 2).getValues();
    const targetStr    = dateObj.toDateString();
    existingMeta.forEach(row => {
      const d    = row[0];
      const type = String(row[1]);
      const dStr = parsePendingDate(d).toDateString();
      if (dStr === targetStr) alreadyQueued.add(type);
    });
  }

  const rowsToAdd = [];

  // 1. Add CDR
  if (!skipCDR && !alreadyQueued.has("CDR") && results.Agents) {
    results.Agents.Names.forEach((name, i) => {
      const dept = results.NameToDept[name] || "Unassigned";
      rowsToAdd.push([
        dateStr, "CDR", name, monthStr, weekStr, dept,
        results.Agents.CDE[i][0], results.Agents.CDE[i][1], results.Agents.CDE[i][2],
        results.Agents.FGH[i][0], results.Agents.FGH[i][1], results.Agents.FGH[i][2],
        results.Agents.IJK[i][0], results.Agents.IJK[i][1], results.Agents.IJK[i][2],
        results.Agents.LM[i][0],  results.Agents.LM[i][1],
        results.Agents.NOP[i][0], results.Agents.NOP[i][1], results.Agents.NOP[i][2],
        results.Agents.QR[i][0],  results.Agents.QR[i][1],
        results.Agents.ST[i][0],  results.Agents.ST[i][1],
        results.Agents.UVW[i][0], results.Agents.UVW[i][1], results.Agents.UVW[i][2],
        "", "", "", "", "", "", ""
      ]);
    });
  }

  // 2. Add QPATH
  if (!skipQPath && !alreadyQueued.has("QPATH")) {
    if (results.SalesStats && results.SalesStats.total > 0) {
      const pct          = results.SalesStats.nonOpt1 / results.SalesStats.total;
      const pObj         = results.SalesStats.paths;
      const salesPathStr = Object.keys(pObj).sort().map(k => {
        const c = pObj[k];
        return c > 1 ? `${k} [${c}]` : k;
      }).join(" | ");
      rowsToAdd.push([
        dateStr, "QPATH", "Sales", monthStr, weekStr, "",
        "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        salesPathStr, results.SalesStats.total, results.SalesStats.vm,
        results.SalesStats.nonVm, results.SalesStats.opt1, results.SalesStats.nonOpt1, pct
      ]);
    }
    if (results.DeptPaths) {
      results.DeptPaths.forEach(dp => {
        if (dp.dept !== "Sales") {
          rowsToAdd.push([
            dateStr, "QPATH", dp.dept, monthStr, weekStr, "",
            "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
            dp.path, "", "", "", "", "", ""
          ]);
        }
      });
    }
  }

  // 3. Add QCD
  if (!skipQCD && !alreadyQueued.has("QCD") && results.qcdData) {
    const out = results.qcdData.output;
    const lab = results.qcdData.labels;
    out.forEach((row, i) => {
      const c = row[0], d = row[1], e = row[2], f = row[3], g = row[4];
      if (c === "" && d === "" && e === "" && f === "" && g === "") return;
      rowsToAdd.push([
        dateStr, "QCD", lab[i][0], monthStr, weekStr, lab[i][1],
        c, d, e, f, g, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "", "", "", "", "", "", ""
      ]);
    });
  }

  // 4. Add CSR_TRANSFER
  if (!skipCSR && !alreadyQueued.has("CSR_TRANSFER") && results.csrData) {
    const ag = results.csrData.agents;
    const tc = results.csrData.totalCalls;
    const qu = results.csrData.queues;
    ag.forEach((row, i) => {
      const agent = String(row[0]).trim();
      if (!agent) return;
      const tCall = tc[i][0];
      const qArr  = qu[i];
      rowsToAdd.push([
        dateStr, "CSR_TRANSFER", agent, monthStr, weekStr, "",
        tCall, qArr[0], qArr[1], qArr[2], qArr[3], qArr[4], qArr[5], qArr[6], qArr[7], qArr[8], qArr[9], qArr[10], "", "", "", "", "", "", "", "", "",
        "", "", "", "", "", "", ""
      ]);
    });
  }

  if (rowsToAdd.length > 0) {
    const nextRow = pendingSheet.getLastRow() + 1;
    pendingSheet.getRange(nextRow, 1, rowsToAdd.length, 34).setValues(rowsToAdd);
  }
}

// -------------------------------------------------------------------------
// PENDING ARCHIVE FUNCTIONS
// -------------------------------------------------------------------------

function processBatchArchive(silent = false) {
  const ui           = SpreadsheetApp.getUi();
  const targetSS     = SpreadsheetApp.openById(TARGET_SS_ID);
  const pendingSheet = targetSS.getSheetByName("Pending Archive");

  if (!pendingSheet || pendingSheet.getLastRow() <= 1) {
    if (!silent) ui.alert("No Pending Data", "Pending Archive sheet is empty.", ui.ButtonSet.OK);
    return { cdrCount: 0, qpathCount: 0, qcdCount: 0, csrCount: 0 };
  }

  const obcHD   = targetSS.getSheetByName("CDR Historical Data");
  const salesHD = targetSS.getSheetByName("Q Path Historical Data");
  const qcdHD   = targetSS.getSheetByName("QCD Historical Data");
  const csrHD   = targetSS.getSheetByName("CSR Transfer Historical Data");

  const totalPendingRows = pendingSheet.getLastRow() - 1;
  if (!silent) SpreadsheetApp.getActiveSpreadsheet().toast(`Processing ${totalPendingRows} pending rows...`, "Batch Archive", -1);

  const dataRange      = pendingSheet.getRange(2, 1, totalPendingRows, 34);
  const pendingData    = dataRange.getValues();
  const pendingDisplay = dataRange.getDisplayValues();

  const cdrBatch      = [];
  const qPathBatch    = [];
  const qcdBatch      = [];
  const csrTransBatch = [];

  pendingData.forEach((row, index) => {
    const type    = row[1];
    const dispRow = pendingDisplay[index];

    if (type === "CDR") {
      cdrBatch.push([
        row[3], row[4], parsePendingDate(row[0]), row[5], row[2],
        Number(dispRow[6])||0,  Number(dispRow[7])||0,  Number(dispRow[8])||0,  // CDE
        row[9],  row[10], row[11],                                              // FGH (Text)
        Number(dispRow[12])||0, Number(dispRow[13])||0, Number(dispRow[14])||0, // IJK
        Number(dispRow[15])||0, Number(dispRow[16])||0,                         // LM
        row[17], row[18], row[19],                                              // NOP (Text)
        Number(dispRow[20])||0, Number(dispRow[21])||0,                         // QR
        row[22], row[23],                                                       // ST (Durations)
        row[24], row[25], row[26]                                               // UVW (Text)
      ]);
    } else if (type === "QPATH") {
      qPathBatch.push([
        row[3], row[4], parsePendingDate(row[0]), row[2], row[27],
        Number(dispRow[28])||0, Number(dispRow[29])||0, Number(dispRow[30])||0,
        Number(dispRow[31])||0, Number(dispRow[32])||0, Number(dispRow[33])||""
      ]);
    } else if (type === "QCD") {
      const total   = Number(dispRow[6]) || 0;
      const ans     = Number(dispRow[7]) || 0;
      const abnd    = Number(dispRow[8]) || 0;
      const abndPct = total > 0 ? (abnd / total) : 0;
      const viol    = abndPct > 0.05 ? 1 : 0;
      qcdBatch.push([
        row[3], row[4], parsePendingDate(row[0]), row[2], row[5],
        total, ans, abnd,
        row[9], row[10], // Wait times (Durations)
        abndPct, viol
      ]);
    } else if (type === "CSR_TRANSFER") {
      const totalCalls = Number(dispRow[6]) || 0;
      let transferred  = 0;
      const qCounts    = [];
      for (let i = 7; i <= 17; i++) {
        const count = Number(dispRow[i]) || 0;
        transferred += count;
        qCounts.push(count);
      }
      const transPct = totalCalls > 0 ? (transferred / totalCalls) : 0;
      csrTransBatch.push([
        row[3], row[4], parsePendingDate(row[0]), row[2], transPct, totalCalls, transferred, ...qCounts
      ]);
    }
  });

  if (cdrBatch.length > 0      && obcHD)   obcHD.getRange(obcHD.getLastRow()     + 1, 1, cdrBatch.length,      26).setValues(cdrBatch);
  if (qPathBatch.length > 0    && salesHD) salesHD.getRange(salesHD.getLastRow() + 1, 1, qPathBatch.length,    11).setValues(qPathBatch);

  if (qcdBatch.length > 0 && qcdHD) {
    qcdHD.getRange(qcdHD.getLastRow() + 1, 1, qcdBatch.length, 12).setValues(qcdBatch);

    // Mirror to Neon (Phase 3)
    try {
      var neonQcdRows = qcdBatch.map(function(r) {
        return {
          monthYear:     r[0],
          week:          r[1],
          callDate:      r[2],
          callQueue:     r[3],
          callSource:    r[4],
          totalCalls:    r[5],
          totalAnswered: r[6],
          abandoned:     r[7],
          longestWait:   r[8],
          avgAnswer:     r[9],
          abandonedPct:  r[10],
          violations:    r[11]
        };
      });
      writeQCDRowsToNeon(neonQcdRows);
    } catch (neonErr) {
      notifyNeonWriteFailure('processBatchArchive (bulk QCD)', neonErr.message);
    }
  }
  
  if (csrTransBatch.length > 0 && csrHD)   csrHD.getRange(csrHD.getLastRow()     + 1, 1, csrTransBatch.length, 18).setValues(csrTransBatch);

  // Ensure all writes are committed before sorting and clearing
  SpreadsheetApp.flush();

  // Sort all historical sheets by date column (col 3) after bulk write
  const sheetsToSort = [
    { sheet: obcHD,   label: "CDR" },
    { sheet: salesHD, label: "QPath" },
    { sheet: qcdHD,   label: "QCD" },
    { sheet: csrHD,   label: "CSR" }
  ];

  sheetsToSort.forEach(({ sheet, label }) => {
    if (!sheet || sheet.getLastRow() < 3) return;
    try {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
           .sort({ column: 3, ascending: true });
    } catch (e) {
      console.warn(`Sort failed for ${label} Historical Data: ${e.message}`);
    }
  });

  // Clear data rows only — preserves header without needing to rewrite it
  if (pendingSheet.getLastRow() > 1) {
    pendingSheet.getRange(2, 1, pendingSheet.getLastRow() - 1, 34).clearContent();
  }

  appendToAuditLog(targetSS, "processBatchArchive",
    `${totalPendingRows} pending rows committed`,
    `CDR: +${cdrBatch.length}, QPath: +${qPathBatch.length}, QCD: +${qcdBatch.length}, CSR: +${csrTransBatch.length}`
  );

  if (!silent) {
    ui.alert(
      "✅ Archive Complete",
      `CDR History: +${cdrBatch.length}\n` +
      `Q Path History: +${qPathBatch.length}\n` +
      `QCD History: +${qcdBatch.length}\n` +
      `CSR Transfer History: +${csrTransBatch.length}\n\n` +
      `Pending Archive cleared.`,
      ui.ButtonSet.OK
    );
  }

  return {
    cdrCount:   cdrBatch.length,
    qpathCount: qPathBatch.length,
    qcdCount:   qcdBatch.length,
    csrCount:   csrTransBatch.length
  };
}

function clearPendingArchive() {
  const ui     = SpreadsheetApp.getUi();
  const result = ui.alert("Clear Pending Archive?", "This will delete all pending archive data.\n\nAre you sure?", ui.ButtonSet.YES_NO);

  if (result == ui.Button.YES) {
    const targetSS    = SpreadsheetApp.openById(TARGET_SS_ID);
    const pendingSheet = targetSS.getSheetByName("Pending Archive");
    if (pendingSheet) targetSS.deleteSheet(pendingSheet);
    ui.alert("✅ Cleared", "Pending Archive sheet deleted.", ui.ButtonSet.OK);
  }
}

function viewPendingArchiveStatus() {
  const ui          = SpreadsheetApp.getUi();
  const targetSS    = SpreadsheetApp.openById(TARGET_SS_ID);
  const pendingSheet = targetSS.getSheetByName("Pending Archive");

  if (!pendingSheet || pendingSheet.getLastRow() <= 1) {
    ui.alert("Pending Archive Status", "No pending data found.", ui.ButtonSet.OK);
    return;
  }
  ui.alert("📋 Pending Archive Status", `Found ${pendingSheet.getLastRow() - 1} rows waiting to be archived.`, ui.ButtonSet.OK);
}


// -------------------------------------------------------------------------
// CALCULATION ENGINE
// -------------------------------------------------------------------------
function calculateMetricsInMemory(rawDisplayData, configSheet) {
  const idx = {
    CALL_ID: 0, LEG_ID: 1, DIRECTION: 5, DURATION: 6,
    COL_I_EXT: 8, COL_J_NAME: 9, COL_K_REMOTE: 10, COL_L_NAME: 11,
    CONTEXT: 13, STATUS_MIS: 23, STATUS_ANS: 25,
    COL_Q: 16, PATH: 43
  };
  const TIME_20S = 20 / 86400;
  const qRegex   = /CallQueue/i;
  const naRegex  = /N\/A/i;

  const extToAgent    = {};
  const deptList      = [];
  const agentsByDept  = {};
  const nameToDeptMap = {};

  const lastConfigRow = configSheet.getLastRow();
  const queueMap      = configSheet.getRange(2, 1, lastConfigRow - 1, 2).getValues();
  const deptQueues    = queueMap
    .filter(r => r[0] && r[1])
    .map(r => ({ dept: String(r[0]).trim(), ext: String(r[1]).trim() }));

  const deptHeaders = configSheet.getRange(1, 6, 1, 14).getValues()[0];
  const configRange = configSheet.getRange(2, 6, lastConfigRow - 1, 14).getValues();

  deptHeaders.forEach(d => {
    if (d && !deptList.includes(d)) {
      deptList.push(d);
      agentsByDept[d] = [];
    }
  });

  configRange.forEach(row => {
    row.forEach((cell, cIdx) => {
      const s = String(cell);
      if (s.includes(",")) {
        const p = s.split(",");
        if (p.length >= 2) {
          const name = p[0].trim();
          const ext  = p[1].trim();
          const dept = deptHeaders[cIdx] || "Unassigned";

          extToAgent[ext] = { name, dept };
          if (agentsByDept[dept] && !agentsByDept[dept].includes(name)) agentsByDept[dept].push(name);

          if (nameToDeptMap[name]) {
            if (!nameToDeptMap[name].includes(dept)) nameToDeptMap[name] += ", " + dept;
          } else {
            nameToDeptMap[name] = dept;
          }
        }
      }
    });
  });

  const exclusions        = new Set();
  const queueExtensionSet = new Set();

  queueMap.forEach(r => {
    if (r[0]) exclusions.add(String(r[0]).trim());
    if (r[1]) {
      const ext = String(r[1]).trim();
      exclusions.add(ext);
      queueExtensionSet.add(ext);
    }
  });

  const salesStats     = { total: 0, vm: 0, nonVm: 0, opt1: 0, nonOpt1: 0, paths: {} };
  const activeNamesSet = new Set();
  const deptPaths      = {};
  deptQueues.forEach(dq => deptPaths[dq.dept] = {});

  for (let i = 1; i < rawDisplayData.length; i++) {
    const rD = rawDisplayData[i];
    if (rD[idx.COL_J_NAME]) activeNamesSet.add(clean(rD[idx.COL_J_NAME]));
    if (rD[idx.COL_L_NAME]) activeNamesSet.add(clean(rD[idx.COL_L_NAME]));
  }

  const agentData = {};
  deptList.forEach(d => {
    agentsByDept[d].filter(n => activeNamesSet.has(n)).forEach(n => {
      agentData[n] = {
        c_set: new Set(), d_set: new Set(), e_set: new Set(),
        f: [], g: [], h: [],
        i_set: new Set(), j_set: new Set(), k_set: new Set(),
        l_set: new Set(), m_set: new Set(),
        n_int: [], n_ext: [], o_int: [], o_ext: [], p_int: [], p_ext: [],
        u: [], v: [], w: [],
        q: 0, r: 0, s_total: 0, t_cnt: 0
      };
    });
  });

  for (let i = 1; i < rawDisplayData.length; i++) {
    const rD      = rawDisplayData[i];
    const ctx     = String(rD[idx.CONTEXT]);
    const pathVal = String(rD[idx.PATH]).trim();
    const colQ    = String(rD[idx.COL_Q]).trim();
    const legId   = String(rD[idx.LEG_ID]).trim();

    if (colQ === SALES_QUEUE_NUMBER && pathVal !== "N/A") {
      const isVM   = pathVal.includes(SALES_PATH_VM);
      const isOpt1 = pathVal.includes(SALES_PATH_OPT1);
      const isLeg2 = (legId === "2");

      if (isLeg2)          salesStats.total++;
      if (isVM)            salesStats.vm++;
      if (isLeg2 && !isVM) salesStats.nonVm++;
      if (!isVM && isOpt1) salesStats.opt1++;
      if (!pathVal.includes(SALES_PATH_EXCLUDE) && !isVM && !isOpt1 &&
          (pathVal.includes(SALES_PATH_DIRECT) || pathVal.includes("Ext."))) {
        salesStats.nonOpt1++;
      }
      if (!pathVal.includes(SALES_PATH_EXCLUDE)) {
        salesStats.paths[pathVal] = (salesStats.paths[pathVal] || 0) + 1;
      }
    }

    if (pathVal) {
      const claimedDepts = new Set();
      deptQueues.forEach(dq => {
        if (new RegExp(dq.ext + "(?!\\d)").test(pathVal)) {
          deptPaths[dq.dept][pathVal] = (deptPaths[dq.dept][pathVal] || 0) + 1;
          claimedDepts.add(dq.dept);
        }
      });
      const extMatch = pathVal.match(/Ext\.\s*(\d+)/);
      if (extMatch) {
        const ext       = extMatch[1];
        const agentInfo = extToAgent[ext];
        if (agentInfo && agentInfo.dept && deptPaths[agentInfo.dept] && !claimedDepts.has(agentInfo.dept)) {
          deptPaths[agentInfo.dept][pathVal] = (deptPaths[agentInfo.dept][pathVal] || 0) + 1;
        }
      }
    }

    if (exclusions.has(ctx)) continue;

    const extI   = String(rD[idx.COL_I_EXT]).trim();
    const remK   = String(rD[idx.COL_K_REMOTE]).trim();
    const statZ  = String(rD[idx.STATUS_ANS]);
    const statX  = String(rD[idx.STATUS_MIS]);
    const dir    = String(rD[idx.DIRECTION]);
    const cid    = String(rD[idx.CALL_ID]).trim();
    const dur    = timeToDec(rD[idx.DURATION]);
    const isNumK = isValidPhone(remK);
    const isNumI = isValidPhone(extI);

    if (extToAgent[extI]) {
      const agName = extToAgent[extI].name;
      if (agentData[agName] && !exclusions.has(agName)) {
        const b = agentData[agName];
        if (!qRegex.test(ctx) && isNumK && extI !== "**********" && dir !== "Outgoing") {
          const callee = clean(rD[idx.COL_L_NAME]);
          b.c_set.add(cid);
          if (statX === "Missed")   b.d_set.add(cid);
          if (statZ === "Answered") b.e_set.add(cid);

          if (callee && !naRegex.test(callee) && !queueExtensionSet.has(remK)) {
            b.f.push(callee);
            if (statZ === "Answered") b.g.push(callee);
            if (statX === "Missed")   b.h.push(callee);
          }
        }
        if (naRegex.test(ctx) && legId == "1" && remK.includes("+")) {
          b.q++;
          if (dur >= TIME_20S) b.r++;
          const item = { p: remK, d: dur };
          b.u.push(item);
          if (dur > TIME_20S) b.v.push(item);
          if (dur < TIME_20S) b.w.push(item);
          b.s_total += dur;
          if (dur > 0) b.t_cnt++;
        }
      }
    }

    if (extToAgent[remK]) {
      const agName = extToAgent[remK].name;
      if (agentData[agName] && !qRegex.test(ctx) && !exclusions.has(agName)) {
        const b = agentData[agName];
        if (isNumI && !exclusions.has(extI) && extI !== "**********") {
          const caller = clean(rD[idx.COL_J_NAME]);
          b.i_set.add(cid);
          if (statX === "Missed") b.j_set.add(cid);
          if (statZ === "Answered") {
            b.k_set.add(cid);
            if (dir === "Internal") b.l_set.add(cid);
            if (dir === "Incoming") b.m_set.add(cid);
          }
          if (caller && !naRegex.test(caller)) {
            if (dir === "Internal") {
              b.n_int.push(caller);
              if (statZ === "Answered") b.o_int.push(caller);
              if (statX === "Missed")   b.p_int.push(caller);
            } else if (dir === "Incoming") {
              b.n_ext.push(caller);
              if (statZ === "Answered") b.o_ext.push(caller);
              if (statX === "Missed")   b.p_ext.push(caller);
            }
          }
        }
      }
    }
  }

  const finalNames = [];
  const layoutInfo = [];
  const resAgents  = { CDE:[], FGH:[], IJK:[], LM:[], NOP:[], QR:[], ST:[], UVW:[], Names:[], Layout:[] };
  const seenNames  = new Set();

  deptList.forEach(d => {
    const activeInDept = agentsByDept[d].filter(n => activeNamesSet.has(n) && !seenNames.has(n));
    if (activeInDept.length > 0) {
      layoutInfo.push({ dept: d, count: activeInDept.length });
      activeInDept.forEach(n => {
        seenNames.add(n);
        const b = agentData[n];
        finalNames.push(n);
        resAgents.CDE.push([b.c_set.size||0, b.e_set.size||0, b.d_set.size||0]);
        resAgents.FGH.push([agg(b.f), agg(b.g), agg(b.h)]);
        resAgents.IJK.push([b.i_set.size||0, b.k_set.size||0, b.j_set.size||0]);
        resAgents.LM.push([b.l_set.size||0, b.m_set.size||0]);
        resAgents.NOP.push([join(agg(b.n_int), agg(b.n_ext)), join(agg(b.o_int), agg(b.o_ext)), join(agg(b.p_int), agg(b.p_ext))]);
        resAgents.QR.push([b.q||"", (b.q>0 && b.r===0)?"0":b.r||""]);
        resAgents.ST.push([b.q>0?fmt(b.s_total):"", b.q>0?(b.t_cnt>0?fmt(b.s_total/b.t_cnt):"0:00:00"):""]);
        resAgents.UVW.push([aggC(b.u), aggC(b.v), aggC(b.w)]);
      });
    }
  });

  resAgents.Names  = finalNames;
  resAgents.Layout = layoutInfo;

  const resDeptPaths = [];
  deptQueues.forEach(dq => {
    const pObj = deptPaths[dq.dept];
    const keys = Object.keys(pObj);
    if (keys.length > 0) {
      const pathStr = keys.sort().map(k => {
        const c = pObj[k];
        return c > 1 ? `${k} [${c}]` : k;
      }).join(" | ");
      resDeptPaths.push({ dept: dq.dept, path: pathStr });
    }
  });

  return { Agents: resAgents, DeptPaths: resDeptPaths, SalesStats: salesStats, NameToDept: nameToDeptMap };
}


// -------------------------------------------------------------------------
// OUTPUT & ARCHIVE
// -------------------------------------------------------------------------

function updateOutputSheet(sheet, res, dateObj) {
  const lastRow = sheet.getLastRow();
  const maxRows = sheet.getMaxRows();

  if (maxRows > lastRow + 200) {
    try { sheet.deleteRows(lastRow + 21, maxRows - (lastRow + 20)); } catch(e) {}
  }

  if (lastRow > 1) {
    const colA = sheet.getRange(2, 1, Math.min(500, maxRows - 1), 1);
    colA.breakApart();
    const rangeToClear = sheet.getRange(2, 1, lastRow - 1, 23);
    rangeToClear.clearContent();
    rangeToClear.setBorder(false, false, false, false, false, false);
    rangeToClear.setBackground(null);
  }

  sheet.getRange("A1").setValue(dateObj);

  if (res.Names.length > 0) {
    sheet.getRange(2, 2,  res.Names.length, 1).setValues(res.Names.map(n => [n]));
    sheet.getRange(2, 3,  res.CDE.length,   3).setValues(res.CDE);
    sheet.getRange(2, 6,  res.FGH.length,   3).setValues(res.FGH);
    sheet.getRange(2, 9,  res.IJK.length,   3).setValues(res.IJK);
    sheet.getRange(2, 12, res.LM.length,    2).setValues(res.LM);
    sheet.getRange(2, 14, res.NOP.length,   3).setValues(res.NOP);
    sheet.getRange(2, 17, res.QR.length,    2).setValues(res.QR);
    sheet.getRange(2, 19, res.ST.length,    2).setValues(res.ST);
    sheet.getRange(2, 21, res.UVW.length,   3).setValues(res.UVW);
  }

  let currentRow = 2;
  res.Layout.forEach((grp, idx) => {
    if (grp.count > 0) {
      const color  = DEPT_COLORS[idx % 11] || "#ffffff";
      const rangeA = sheet.getRange(currentRow, 1, grp.count, 1);
      rangeA.merge().setValue(grp.dept).setHorizontalAlignment("center").setVerticalAlignment("middle").setBackground(color);
      sheet.getRange(currentRow, 1, grp.count, 23).setBorder(true, true, true, true, null, null, color, SpreadsheetApp.BorderStyle.SOLID_THICK);
      currentRow += grp.count;
      if (idx % 20 === 0) SpreadsheetApp.flush();
    }
  });
}

function processIntegratedHistory(targetSS, outputSheet, results, dateObj, skipCDR, skipQPath, skipQCD, skipCSR) {
  const summaryLog = [];
  const salesHD    = targetSS.getSheetByName("Q Path Historical Data");
  const obcHD      = targetSS.getSheetByName("CDR Historical Data");
  const qcdHD      = targetSS.getSheetByName("QCD Historical Data");
  const csrHD      = targetSS.getSheetByName("CSR Transfer Historical Data");
  const monthStr   = getMonthYearStr(dateObj);
  const weekStr    = getWeekOfMonthStr(dateObj);

  let cdrCount = 0, qpathCount = 0, qcdCount = 0, csrCount = 0;
  
  // 1. CDR History
if (!skipCDR && obcHD) {

  // -----------------------------------------------------------------------
  // EXPERIMENTAL FLAG — set to false to revert to original sheet read-back.
  // When true:  CDR rows are assembled from in-memory results.Agents,
  //             matching the same approach used by queueToPendingArchive.
  //             Avoids a round-trip API read of outputSheet immediately
  //             after writing it, and eliminates any flush-timing risk.
  // When false: Original behavior — reads display values back off outputSheet.
  // -----------------------------------------------------------------------
  const USE_IN_MEMORY_CDR = true;

  let raw;

  if (USE_IN_MEMORY_CDR) {
    // Build CDR rows directly from in-memory results, same structure the
    // sheet would have produced: [Name, C, D, E, F, G, H, I, K, J, L, M,
    //                              N, O, P, Q, R, S, T, U, V, W]
    raw = [];
    results.Agents.Names.forEach((name, i) => {
      raw.push([
        name,
        results.Agents.CDE[i][0], results.Agents.CDE[i][1], results.Agents.CDE[i][2],
        results.Agents.FGH[i][0], results.Agents.FGH[i][1], results.Agents.FGH[i][2],
        results.Agents.IJK[i][0], results.Agents.IJK[i][1], results.Agents.IJK[i][2],
        results.Agents.LM[i][0],  results.Agents.LM[i][1],
        results.Agents.NOP[i][0], results.Agents.NOP[i][1], results.Agents.NOP[i][2],
        results.Agents.QR[i][0],  results.Agents.QR[i][1],
        results.Agents.ST[i][0],  results.Agents.ST[i][1],
        results.Agents.UVW[i][0], results.Agents.UVW[i][1], results.Agents.UVW[i][2]
      ]);
    });
  } else {
    // ORIGINAL: read display values back off the output sheet
    if (outputSheet.getLastRow() >= 2) {
      raw = outputSheet.getRange(2, 2, outputSheet.getLastRow() - 1, 22)
                       .getDisplayValues()
                       .filter(r => r[0]);
    }
  }

  if (raw && raw.length) {

    // -----------------------------------------------------------------------
    // EXPERIMENTAL FLAG — set to false to revert to five separate setValues
    // calls (original behavior). When true, assembles each row completely in
    // memory first and writes the entire block in a single call.
    // -----------------------------------------------------------------------
    const USE_SINGLE_WRITE_CDR = true;

    const next = obcHD.getLastRow() + 1;

    if (USE_SINGLE_WRITE_CDR) {
      // Build complete rows in memory: [Month, Week, Date, Dept, Name, ...22 metric cols]
      const fullRows = raw.map(r => [
        monthStr,
        weekStr,
        dateObj,
        results.NameToDept[r[0]] || "Unassigned",
        ...r  // name + all 21 metric columns
      ]);
      obcHD.getRange(next, 1, fullRows.length, 26).setValues(fullRows);
    } else {
      // ORIGINAL: five separate range writes
      obcHD.getRange(next, 3,  raw.length, 1).setValues(raw.map(() => [dateObj]));
      obcHD.getRange(next, 5,  raw.length, 22).setValues(raw);
      obcHD.getRange(next, 1,  raw.length, 1).setValues(raw.map(() => [monthStr]));
      obcHD.getRange(next, 2,  raw.length, 1).setValues(raw.map(() => [weekStr]));
      obcHD.getRange(next, 4,  raw.length, 1).setValues(raw.map(r => [results.NameToDept[r[0]] || "Unassigned"]));
    }

    if (next > 2) {
      const lastHistDate = obcHD.getRange(next - 1, 3).getValue();
      if (lastHistDate && dateObj < new Date(lastHistDate)) {
        obcHD.getRange(2, 1, obcHD.getLastRow() - 1, obcHD.getLastColumn())
             .sort({ column: 3, ascending: true });
      }
    }
    cdrCount = raw.length;
    summaryLog.push(`- CDR HD: Archived ${cdrCount} Rows`);
  }
}

// 2. Q Path History
  if (!skipQPath && salesHD) {
    const finalRows     = [];
    const salesDeptName = "Sales";
    if (results.SalesStats.total > 0) {
      const pct          = results.SalesStats.nonOpt1 / results.SalesStats.total;
      const pObj         = results.SalesStats.paths;
      const salesPathStr = Object.keys(pObj).sort().map(k => {
        const c = pObj[k]; return c > 1 ? `${k} [${c}]` : k;
      }).join(" | ");
      finalRows.push([
        monthStr, weekStr, dateObj, salesDeptName, salesPathStr,
        results.SalesStats.total, results.SalesStats.vm, results.SalesStats.nonVm,
        results.SalesStats.opt1,  results.SalesStats.nonOpt1, pct
      ]);
    }
    results.DeptPaths.forEach(dp => {
      if (dp.dept === salesDeptName) return;
      finalRows.push([monthStr, weekStr, dateObj, dp.dept, dp.path, "", "", "", "", "", ""]);
    });

    if (finalRows.length > 0) {
      const next = salesHD.getLastRow() + 1;
      salesHD.getRange(next, 1, finalRows.length, 11).setValues(finalRows);
      qpathCount = finalRows.length;
      summaryLog.push(`- Q Path HD: Appended ${qpathCount} Summary Rows`);
    }
  }

  // 3. QCD History
  if (!skipQCD && qcdHD && results.qcdData) {
    const qcdBatch = [];
    results.qcdData.output.forEach((r, i) => {
      if (r[0] === "" && r[1] === "" && r[2] === "" && r[3] === "" && r[4] === "") return;
      const total = Number(r[0]) || 0;
      const abnd  = Number(r[2]) || 0;
      const abndPct = total > 0 ? (abnd / total) : 0;
      const viol    = abndPct > 0.05 ? 1 : 0;
      qcdBatch.push([
        monthStr, weekStr, dateObj, results.qcdData.labels[i][0], results.qcdData.labels[i][1],
        r[0], r[1], r[2], r[3], r[4], abndPct, viol
      ]);
    });
    if (qcdBatch.length > 0) {
      qcdHD.getRange(qcdHD.getLastRow() + 1, 1, qcdBatch.length, 12).setValues(qcdBatch);
      qcdCount = qcdBatch.length;
      summaryLog.push(`- QCD HD: Archived ${qcdCount} Rows`);

            // Phase 3: mirror to Neon. Failure is logged + emailed; sheet write stands.
      try {
        const neonQcdRows = qcdBatch.map(function(r) {
          return {
            monthYear:     r[0],
            week:          r[1],
            callDate:      r[2],
            callQueue:     r[3],
            callSource:    r[4],
            totalCalls:    r[5],
            totalAnswered: r[6],
            abandoned:     r[7],
            longestWait:   r[8],
            avgAnswer:     r[9],
            abandonedPct:  r[10],
            violations:    r[11]
          };
        });
        writeQCDRowsToNeon(neonQcdRows);
        console.log('processIntegratedHistory: mirrored ' + neonQcdRows.length + ' QCD rows to Neon.');
      } catch (neonErr) {
        notifyNeonWriteFailure('processIntegratedHistory (' + dateObj.toDateString() + ')', neonErr.message);
      }
    }
  }

  // 4. CSR Transfer History
  if (!skipCSR && csrHD && results.csrData) {
    const csrBatch = [];
    results.csrData.agents.forEach((row, i) => {
      const agent = String(row[0]).trim();
      if (!agent) return;
      const totalCalls = Number(results.csrData.totalCalls[i][0]) || 0;
      let transferred = 0;
      results.csrData.queues[i].forEach(q => transferred += (Number(q) || 0));
      const transPct = totalCalls > 0 ? (transferred / totalCalls) : 0;
      csrBatch.push([
        monthStr, weekStr, dateObj, agent, transPct, totalCalls, transferred, ...results.csrData.queues[i]
      ]);
    });
    if (csrBatch.length > 0) {
      csrHD.getRange(csrHD.getLastRow() + 1, 1, csrBatch.length, 18).setValues(csrBatch);
      csrCount = csrBatch.length;
      summaryLog.push(`- CSR Transfer HD: Archived ${csrCount} Rows`);
    }
  }

  return {
  summaryLog,
  counts: { cdr: cdrCount, qpath: qpathCount, qcd: qcdCount, csr: csrCount }
  };
}


// -------------------------------------------------------------------------
// HELPERS
// -------------------------------------------------------------------------

/**
 * Parses a date value from Pending Archive column A.
 * Handles both ISO string ("yyyy-MM-dd") and legacy Date objects
 * for backward compatibility with any rows written before this fix.
 * Uses local midnight (noon) to avoid UTC offset shift.
 * @param  {string|Date} val
 * @returns {Date}
 */
function parsePendingDate(val) {
  if (val instanceof Date) return val; // backward compat for pre-fix rows
  const parts = String(val).split('-');
  if (parts.length === 3) return new Date(+parts[0], +parts[1] - 1, +parts[2], 12, 0, 0);
  return new Date(val);
}

function checkHistoryForDate(targetSS, sheetName, importDateObj) {
  const histSheet = targetSS.getSheetByName(sheetName);
  if (!histSheet || histSheet.getLastRow() < 2) return false;
  const dates     = histSheet.getRange(2, 3, histSheet.getLastRow() - 1, 1).getValues().flat();
  const targetStr = importDateObj.toDateString();
  return dates.some(d => {
    if (d instanceof Date) return d.toDateString() === targetStr;
    const parsed = new Date(d);
    if (!isNaN(parsed.getTime())) return parsed.toDateString() === targetStr;
    return false;
  });
}

function buildHistoryDateSet(targetSS, sheetName) {
  const sheet  = targetSS.getSheetByName(sheetName);
  const result = new Set();
  if (!sheet || sheet.getLastRow() < 2) return result;

  const dates = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues().flat();
  dates.forEach(d => {
    if (d instanceof Date && !isNaN(d.getTime())) {
      result.add(d.toDateString());
    } else {
      const parsed = new Date(d);
      if (!isNaN(parsed.getTime())) result.add(parsed.toDateString());
    }
  });
  return result;
}

function deleteHistoricalRowsForDate(sheet, dateObj, dateColIndex) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const lastCol   = sheet.getLastColumn();
  const targetStr = dateObj.toDateString();

  const allRows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const kept = [];
  let   removedCount = 0;

  allRows.forEach(row => {
    const d = row[dateColIndex - 1]; 
    let match = false;
    if (d instanceof Date) {
      match = d.toDateString() === targetStr;
    } else if (d) {
      const parsed = new Date(d);
      if (!isNaN(parsed.getTime())) match = parsed.toDateString() === targetStr;
    }
    if (match) { removedCount++; }
    else       { kept.push(row); }
  });

  if (removedCount === 0) return 0;

  console.log(
    `deleteHistoricalRowsForDate [${sheet.getName()}]: ` +
    `removing ${removedCount} rows for ${targetStr}, ` +
    `keeping ${kept.length} rows. Clearing and rewriting now.`
  );

  sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();

  if (kept.length > 0) {
    sheet.getRange(2, 1, kept.length, lastCol).setValues(kept);
  }

  return removedCount;
}

function getLatestValidSheet(ss) {
  const regex      = /^Call_Legs_(\d{4}-\d{2}-\d{2})$/i;
  const candidates = [];
  ss.getSheets().forEach(s => {
    const match = s.getName().match(regex);
    if (match) {
      const parts   = match[1].split('-');
      const dateObj = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
      candidates.push({ name: s.getName(), dateObj, time: dateObj.getTime() });
    }
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.time - a.time);
  return candidates[0];
}

function clean(n) { return String(n).trim(); }

function agg(l) {
  if (!l.length) return "";
  const c = {};
  l.forEach(n => { if (n !== "" && n !== null && n !== undefined) c[n] = (c[n] || 0) + 1; });
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([n, k]) => k > 1 ? `${n} (${k})` : n).join(", ");
}

function join(a, b) { const r = []; if (a) r.push(a); if (b) r.push(b); return r.join("\n|\n"); }

function fmt(d) {
  if (!d) return "0:00:00";
  const t = Math.round(d * 86400);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
}

function aggC(l) {
  if (!l.length) return "";
  const m = {};
  l.forEach(i => { const k = i.p; if (!m[k]) m[k] = { c: 0, d: 0 }; m[k].c++; m[k].d += i.d; });
  return Object.entries(m).sort((a, b) => b[1].c - a[1].c)
    .map(([p, d]) => `${p} ${fmt(d.d)}${d.c > 1 ? ` (${d.c})` : ""}`).join(", ");
}

function timeToDec(v) {
  if (typeof v === 'number') return v;
  const s = String(v || "").trim().split(":");
  if (s.length < 2) return 0;
  let h = 0, m = 0, x = 0;
  if (s.length === 3) { h = +s[0]; m = +s[1]; x = +s[2]; }
  else                { m = +s[0]; x = +s[1]; }
  return (h * 3600 + m * 60 + x) / 86400;
}

function isValidPhone(v) {
  if (typeof v === 'number') return true;
  if (!v) return false;
  const s = String(v).replace(/[+,\-() ]/g, "").trim();
  return s !== "" && !isNaN(Number(s));
}

function getMonthYearStr(dateObj) {
  const months = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  const yy = dateObj.getFullYear().toString().substr(-2);
  return `${months[dateObj.getMonth()]}, ${yy}`;
}

function getWeekOfMonthStr(dateObj) {
  const firstDay  = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
  const dayOfWeek = firstDay.getDay();
  const totalDays = dateObj.getDate() + dayOfWeek - 1;
  const weekNum   = Math.floor(totalDays / 7) + 1;
  return `Week ${weekNum}`;
}

function appendToAuditLog(targetSS, fnName, details, outcome) {
  try {
    let auditSheet = targetSS.getSheetByName("Audit Log");
    if (!auditSheet) {
      auditSheet = targetSS.insertSheet("Audit Log");
      auditSheet.getRange("A1:D1").setValues([["Timestamp", "Function", "Details", "Outcome"]]);
      auditSheet.setFrozenRows(1);
    }
    const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
    auditSheet.appendRow([ts, fnName, details, outcome]);
  } catch (e) {
    console.warn(`Audit log append failed (non-critical): ${e.message}`);
  }
}

// -------------------------------------------------------------------------
// --- NEW REPORT ENGINES (Tester Dashboard & Archives) ---
// -------------------------------------------------------------------------

function updateQcdrOutputSheet(targetSS, qcdData, csrData) {
  const tester = targetSS.getSheetByName("QCDR Output");
  if (qcdData) tester.getRange(2, 3, qcdData.output.length, 5).setValues(qcdData.output);
  if (csrData && csrData.agents.length > 0) {
    // Optional but recommended: Clear the old CSR block to prevent leftovers if the team shrinks
    const maxClear = Math.max(csrData.agents.length + 20, 100);
    tester.getRange(2, 10, maxClear, 15).clearContent();
    tester.getRange(2, 10, csrData.agents.length, 1).setValues(csrData.agents);
    tester.getRange(2, 11, csrData.transPct.length, 1).setValues(csrData.transPct);
    tester.getRange(2, 12, csrData.totalCalls.length, 1).setValues(csrData.totalCalls);
    tester.getRange(2, 13, csrData.totalTransferred.length, 1).setValues(csrData.totalTransferred);
    tester.getRange(2, 14, csrData.queues.length, 11).setValues(csrData.queues);
  }
}

// Helper for strict Time simulation matching old formulas
function simulateSplitCol2(val) {
  if (!val) return -1;
  let str = String(val).trim();
  let parts = str.split(/\s+/); 
  if (parts.length < 2) return -1; 
  
  let timePart = parts[1];
  let ampm = parts.length > 2 ? parts[2].toLowerCase() : "";
  
  let match = timePart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    let h = parseInt(match[1], 10);
    let m = parseInt(match[2], 10);
    let s = match[3] ? parseInt(match[3], 10) : 0;
    
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    
    return (h / 24) + (m / 1440) + (s / 86400);
  }
  return -1;
}

function parseDurationDecimal(val) {
  if (!val) return 0;
  let str = String(val).trim();
  let match = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    let h = parseInt(match[1], 10);
    let m = parseInt(match[2], 10);
    let s = match[3] ? parseInt(match[3], 10) : 0;
    return (h / 24) + (m / 1440) + (s / 86400);
  }
  let num = parseFloat(str);
  return isNaN(num) ? 0 : num % 1;
}

// Memory Calculator for the Dashboard Engine (QCD Report)
function calcQcdReport(cleanData, targetSS) {
  const rawDisplay = cleanData.slice(1);
  const testerSheet = targetSS.getSheetByName("QCDR Output");
  const staticLabels = testerSheet.getRange("A2:B49").getValues();

  const csrRange = targetSS.getRangeByName("csr_team").getValues();
  const csrTeamSet = new Set();
  csrRange.forEach(row => { if (row[0]) csrTeamSet.add(String(row[0]).split(",")[0].trim().toLowerCase()); });

  const exceptionRange = targetSS.getRangeByName("csr_exceptions");
  const csrExceptionsSet = new Set();
  if (exceptionRange) {
    exceptionRange.getValues().forEach(row => { 
      if (row[0]) csrExceptionsSet.add(String(row[0]).split(",")[0].trim().toLowerCase()); 
    });
  }

  const steeringSet = new Set();
  const steeringSheet = targetSS.getSheetByName("Steering Number");
  if (steeringSheet) {
    let sVals = steeringSheet.getRange("B51:H51").getValues()[0];
    sVals.forEach(v => { if (v) steeringSet.add(String(v).trim().toLowerCase()); });
  }

  const qcdOutput = new Array(48).fill(null).map(() => ["", "", "", "", ""]);
  
  const mockSheet = {
    getRange: function(r, c) {
      return {
        setValue: function(val) { if (c >= 3 && c <= 7) qcdOutput[r - 2][c - 3] = val; },
        getValue: function() {
          if (c === 1) return staticLabels[r - 2][0];
          if (c >= 3 && c <= 7) return qcdOutput[r - 2][c - 3] || 0;
          return 0;
        }
      };
    }
  };

  const q40_name = String(mockSheet.getRange(40, 1).getValue()).trim().toLowerCase();
  const results = {};

  const time600AM = 6 / 24, time630AM = 6.5 / 24, time300PM = 15 / 24, time330PM = 15.5 / 24;
  const time1Min = 1 / 1440, time2Min = 2 / 1440, time20Sec = 20 / 86400;  

  let r34_abnd1m = 0, r34_abnd2m = 0;
  let r35_C_p1 = 0, r35_C_p2 = 0, r35_C_p3 = 0, r35_D_p2 = 0, r35_D_p3 = 0, r35_E_1m = 0, r35_E_2m = 0, r35_F_max = -1, r35_F_orig = null, r35_G_sum = 0, r35_G_count = 0;
  let r36_C_p1 = 0, r36_C_p2 = 0, r36_C_p3 = 0, r36_D_p2 = 0, r36_D_p3 = 0, r36_E_2m = 0, r36_F_max = -1, r36_F_orig = null, r36_G_sum = 0, r36_G_count = 0;
  let r37_C_p1 = 0, r37_C_p3 = 0, r37_E_1m = 0, r37_E_2m = 0, r37_F_max = -1, r37_F_orig = null, r37_G_sum = 0, r37_G_count = 0;
  let r40_tot1 = 0, r40_tot2 = 0, r40_tot3 = 0, r40_tot4 = 0, r40_tot5 = 0, r40_tot6 = 0;

  rawDisplay.forEach(row => {
    let status    = String(row[1]).trim();       
    let type      = String(row[5]).trim().toLowerCase();       
    let team      = String(row[9]).trim().toLowerCase(); 
    let queueName = String(row[11]).trim().toLowerCase(); 
    let dnisNum   = String(row[16]).trim();      
    let abandoned = String(row[24]).trim().toLowerCase();      
    let transfer  = String(row[26]).trim().toLowerCase();      
    
    let startDec  = simulateSplitCol2(row[2]); 
    let endDec    = simulateSplitCol2(row[4]); 
    let waitStr   = row[7];                    
    let waitDec   = parseDurationDecimal(waitStr);
    let isColGPos = parseDurationDecimal(row[6]) > 0; 
    
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
          if (isStat4) { r35_C_p2++; r35_D_p2++; }
          if (isStat5) { r35_C_p3++; r35_D_p3++; }
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
    let queue = String(mockSheet.getRange(ref, 1).getValue()).trim().toLowerCase(); 
    let res = results[queue] || { csrTransfers: 0, csrAbandoned: 0, csrMaxWaitOrig: null, csrTransferWaitSumDec: 0, csrTransferCount: 0 };

    if ([3, 8, 11, 15, 18, 21, 24, 28, 32, 39, 42, 45, 48].includes(r)) mockSheet.getRange(r, 3).setValue(res.csrTransfers + res.csrAbandoned); 
    mockSheet.getRange(r, 4).setValue(res.csrTransfers);
    mockSheet.getRange(r, 5).setValue(res.csrAbandoned);
    mockSheet.getRange(r, 6).setValue(res.csrMaxWaitOrig !== null ? res.csrMaxWaitOrig : 0);
    
    if ([3, 8, 11, 15, 18, 21, 24, 28, 32, 39, 42, 45, 48].includes(r)) { 
      mockSheet.getRange(r, 7).setValue(res.csrTransferCount > 0 ? (res.csrTransferWaitSumDec / res.csrTransferCount) : 0);
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
    let queue = String(mockSheet.getRange(ref, 1).getValue()).trim().toLowerCase(); 
    let res = results[queue] || { nonCsrTransfers: 0, nonCsrAbandoned: 0, nonCsrAbnd20s: 0, nonCsrWaitSumDec: 0, nonCsrWaitCount: 0, nonCsrMaxWaitOrig: null, csrAbandoned20s: 0, csrAbandoned: 0 };
    
    if (cRows20s.includes(c)) mockSheet.getRange(c, 3).setValue((res.nonCsrTransfers || 0) + (res.nonCsrAbnd20s || 0) + ((res.csrAbandoned20s || 0) - (res.csrAbandoned || 0))); 
    if (cRows1m.includes(c)) mockSheet.getRange(c, 3).setValue((res.nonCsrTransfers || 0) + (res.nonCsrAbandoned || 0)); 

    if ([6, 9, 12, 16, 19, 22, 25, 29, 33, 46, 49].includes(c)) mockSheet.getRange(c, 4).setValue(res.nonCsrTransfers || 0);
    if ([9, 12, 16, 19, 22, 25, 29, 33, 46, 49].includes(c)) mockSheet.getRange(c, 5).setValue(res.nonCsrAbandoned || 0);
    if (c === 6) mockSheet.getRange(c, 5).setValue(res.nonCsrAbnd20s || 0); 
    if ([6, 9, 12, 16, 19, 22, 25, 29, 33, 46, 49].includes(c)) mockSheet.getRange(c, 6).setValue(res.nonCsrMaxWaitOrig !== null && res.nonCsrMaxWaitOrig !== undefined ? res.nonCsrMaxWaitOrig : 0);
    
    if ([6, 9, 12, 16, 19, 22, 25, 29, 33, 46, 49].includes(c)) {
      mockSheet.getRange(c, 7).setValue(res.nonCsrWaitCount > 0 ? (res.nonCsrWaitSumDec / res.nonCsrWaitCount) : 0);
      rowAgg[c] = { sum: res.nonCsrWaitSumDec, count: res.nonCsrWaitCount };
    }
  });

  [13, 26, 30].forEach(r => {
    let queue = String(mockSheet.getRange(r, 1).getValue()).trim().toLowerCase();
    let res = results[queue] || { stat3Transfers: 0, stat3Abandoned: 0, stat3MaxWaitOrig: null, stat3WaitSumDec: 0, stat3WaitCount: 0 };
    mockSheet.getRange(r, 3).setValue(res.stat3Transfers + res.stat3Abandoned);
    mockSheet.getRange(r, 4).setValue(res.stat3Transfers);
    mockSheet.getRange(r, 5).setValue(res.stat3Abandoned);
    mockSheet.getRange(r, 6).setValue(res.stat3MaxWaitOrig !== null ? res.stat3MaxWaitOrig : 0);
    mockSheet.getRange(r, 7).setValue(res.stat3WaitCount > 0 ? (res.stat3WaitSumDec / res.stat3WaitCount) : 0);
    rowAgg[r] = { sum: res.stat3WaitSumDec, count: res.stat3WaitCount };
  });

  [4, 43].forEach(r => {
    let ref = (r === 4) ? 3 : r; 
    let queue = String(mockSheet.getRange(ref, 1).getValue()).trim().toLowerCase();
    let res = results[queue] || { dnisNotAbnd: 0, dnisAbnd20s: 0, dnis2NotAbnd: 0, dnis2Abnd20s: 0, dnisMaxWaitOrig: null, absMaxWaitOrig: null, dnisWaitSumDec: 0, dnisWaitCount: 0, dnis2WaitSumDec: 0, dnis2WaitCount: 0 };
    
    if (r === 4) {
      mockSheet.getRange(r, 3).setValue(res.dnisNotAbnd + res.dnisAbnd20s);
      mockSheet.getRange(r, 4).setValue(res.dnisNotAbnd);
      mockSheet.getRange(r, 5).setValue(res.dnisAbnd20s);
      mockSheet.getRange(r, 6).setValue(res.dnisMaxWaitOrig !== null ? res.dnisMaxWaitOrig : 0);
      mockSheet.getRange(r, 7).setValue(res.dnisWaitCount > 0 ? (res.dnisWaitSumDec / res.dnisWaitCount) : 0);
      rowAgg[4] = { sum: res.dnisWaitSumDec, count: res.dnisWaitCount };
    }
    if (r === 43) {
      mockSheet.getRange(r, 3).setValue(res.dnis2NotAbnd + res.dnis2Abnd20s);
      mockSheet.getRange(r, 4).setValue(res.dnis2NotAbnd);
      mockSheet.getRange(r, 5).setValue(res.dnis2Abnd20s);
      mockSheet.getRange(r, 6).setValue(res.absMaxWaitOrig !== null ? res.absMaxWaitOrig : 0);
      mockSheet.getRange(r, 7).setValue(res.dnis2WaitCount > 0 ? (res.dnis2WaitSumDec / res.dnis2WaitCount) : 0);
      rowAgg[43] = { sum: res.dnis2WaitSumDec, count: res.dnis2WaitCount };
    }
  });

  let q5 = String(mockSheet.getRange(3, 1).getValue()).trim().toLowerCase();
  let res5 = results[q5] || { stat3NonDnisAbnd: 0, stat3NonDnisNotAbnd: 0, stat3NonDnisMaxWaitOrig: null, stat3NonDnisWaitSumDec: 0, stat3NonDnisWaitCount: 0 };
  mockSheet.getRange(5, 3).setValue(res5.stat3NonDnisAbnd + res5.stat3NonDnisNotAbnd);
  mockSheet.getRange(5, 4).setValue(res5.stat3NonDnisNotAbnd);
  mockSheet.getRange(5, 5).setValue(res5.stat3NonDnisAbnd);
  mockSheet.getRange(5, 6).setValue(res5.stat3NonDnisMaxWaitOrig !== null ? res5.stat3NonDnisMaxWaitOrig : 0);
  mockSheet.getRange(5, 7).setValue(res5.stat3NonDnisWaitCount > 0 ? (res5.stat3NonDnisWaitSumDec / res5.stat3NonDnisWaitCount) : 0);
  rowAgg[5] = { sum: res5.stat3NonDnisWaitSumDec, count: res5.stat3NonDnisWaitCount };

  mockSheet.getRange(35, 3).setValue(r35_C_p1 + r35_C_p2 + r35_C_p3);
  mockSheet.getRange(35, 4).setValue(r35_D_p2 + r35_D_p3); 
  mockSheet.getRange(35, 5).setValue(r35_E_1m); 
  mockSheet.getRange(35, 6).setValue(r35_F_orig !== null ? r35_F_orig : 0);
  mockSheet.getRange(35, 7).setValue(r35_G_count > 0 ? (r35_G_sum / r35_G_count) : 0);
  rowAgg[35] = { sum: r35_G_sum, count: r35_G_count };

  mockSheet.getRange(36, 3).setValue(r36_C_p1 + r36_C_p2 + r36_C_p3);
  mockSheet.getRange(36, 4).setValue(r36_D_p2 + r36_D_p3); 
  mockSheet.getRange(36, 5).setValue(r36_C_p1);
  mockSheet.getRange(36, 6).setValue(r36_F_orig !== null ? r36_F_orig : 0);
  mockSheet.getRange(36, 7).setValue(r36_G_count > 0 ? (r36_G_sum / r36_G_count) : 0);
  rowAgg[36] = { sum: r36_G_sum, count: r36_G_count };

  mockSheet.getRange(37, 3).setValue(r37_C_p1 + r37_C_p3);
  mockSheet.getRange(37, 4).setValue(r37_C_p3);
  mockSheet.getRange(37, 5).setValue(r37_E_1m);
  mockSheet.getRange(37, 6).setValue(r37_F_orig !== null ? r37_F_orig : 0);
  mockSheet.getRange(37, 7).setValue(r37_G_count > 0 ? (r37_G_sum / r37_G_count) : 0);
  rowAgg[37] = { sum: r37_G_sum, count: r37_G_count };

  let c39 = Number(mockSheet.getRange(39, 3).getValue()) || 0;
  let d39 = Number(mockSheet.getRange(39, 4).getValue()) || 0;
  let e39 = Number(mockSheet.getRange(39, 5).getValue()) || 0;
  mockSheet.getRange(40, 3).setValue((r40_tot1 + r40_tot2 + r40_tot3 + r40_tot4) - c39);
  mockSheet.getRange(40, 4).setValue((r40_tot1 + r40_tot3) - d39);
  mockSheet.getRange(40, 5).setValue((r40_tot5 + r40_tot6) - e39);
  
  let res40 = results[q40_name] || { nonCsrMaxWaitOrig: null, nonCsrWaitSumDec: 0, nonCsrWaitCount: 0 };
  mockSheet.getRange(40, 6).setValue(res40.nonCsrMaxWaitOrig !== null ? res40.nonCsrMaxWaitOrig : 0);
  mockSheet.getRange(40, 7).setValue(res40.nonCsrWaitCount > 0 ? (res40.nonCsrWaitSumDec / res40.nonCsrWaitCount) : 0);
  rowAgg[40] = { sum: res40.nonCsrWaitSumDec, count: res40.nonCsrWaitCount };

  // =========================================================================
  // UPDATED: MASTER SUM/MAX ENGINE FOR PARENT ROWS
  // Iterates through all parent rows and dynamically calculates 
  // the SUM for C, D, E and the MAX for F.
  // =========================================================================
  const totalRowMap = {
  2: [3, 4, 5, 6], 7: [8, 9], 10: [11, 12, 13], 14: [15, 16],
  17: [18, 19], 20: [21, 22], 23: [24, 25, 26], 27: [28, 29, 30],
  31: [32, 33], 34: [35, 36, 37], 38: [39, 40], 41: [42, 43],
  44: [45, 46], 47: [48, 49]
};

  Object.keys(totalRowMap).forEach(totRowStr => {
    let totRow = Number(totRowStr);
    let children = totalRowMap[totRow];
    
    let tSumC = 0, tSumD = 0, tSumE = 0;
    let maxF_Dec = -1, maxF_Orig = 0;
    let tSumG_Sum = 0, tSumG_Count = 0;

    children.forEach(child => {
      // 1. Calculate SUM for C, D, and E
      tSumC += Number(mockSheet.getRange(child, 3).getValue()) || 0;
      tSumD += Number(mockSheet.getRange(child, 4).getValue()) || 0;
      
      let valE = mockSheet.getRange(child, 5).getValue();
      if (typeof valE === 'string' && valE.includes('|')) {
          tSumE += parseFloat(valE) || 0; // Failsafes against formatted text
      } else {
          tSumE += Number(valE) || 0;
      }
      
      // 2. Calculate MAX for F 
      let valF_Orig = mockSheet.getRange(child, 6).getValue();
      let valF_Dec = parseDurationDecimal(valF_Orig);
      if (valF_Dec > maxF_Dec) {
        maxF_Dec = valF_Dec;
        maxF_Orig = valF_Orig;
      }

      // 3. Prepare SUMs for the Average Answer Time in G
      if (rowAgg[child]) { 
        tSumG_Sum += rowAgg[child].sum; 
        tSumG_Count += rowAgg[child].count; 
      }
    });

    // Write all calculated totals directly to the parent row
    mockSheet.getRange(totRow, 3).setValue(tSumC);
    mockSheet.getRange(totRow, 4).setValue(tSumD);
    mockSheet.getRange(totRow, 5).setValue(tSumE);
    mockSheet.getRange(totRow, 6).setValue(maxF_Dec !== -1 ? maxF_Orig : 0);
    mockSheet.getRange(totRow, 7).setValue(tSumG_Count > 0 ? (tSumG_Sum / tSumG_Count) : 0);
  });

  return { output: qcdOutput, labels: staticLabels };
}


// Memory Calculator for the Transfer Engine (CSR Report)
function calcCsrReport(cleanData, targetSS) {
  const rawDisplay = cleanData.slice(1);
  const reportSheet = targetSS.getSheetByName("QCDR Output"); 
  
  const queueHeadersRaw = reportSheet.getRange("N1:X1").getValues()[0];
  const queueHeaders = queueHeadersRaw.map(h => String(h).trim().toLowerCase());
  
  const agentMetrics = {}; 
  
  const time600AM = 6 / 24;
  const time330PM = 15.5 / 24;
  
  rawDisplay.forEach(row => {
    let startDec = simulateSplitCol2(row[2]); // Col C
    let stopDec  = simulateSplitCol2(row[4]); // Col E
    let talkDec  = parseDurationDecimal(row[6]);  
    
    let callerName = String(row[9]).trim().toLowerCase(); 
    let calleeName = String(row[11]).trim().toLowerCase(); 
    
    if (startDec === -1 || stopDec === -1) return;
    
    if (calleeName && startDec > time600AM && stopDec < time330PM && talkDec > 0) {
      if (!agentMetrics[calleeName]) agentMetrics[calleeName] = { totalCalls: 0, queues: {} };
      agentMetrics[calleeName].totalCalls++;
    }
    
    if (callerName && calleeName && startDec > time600AM && stopDec < time330PM) {
      if (!agentMetrics[callerName]) agentMetrics[callerName] = { totalCalls: 0, queues: {} };
      if (!agentMetrics[callerName].queues[calleeName]) agentMetrics[callerName].queues[calleeName] = 0;
      agentMetrics[callerName].queues[calleeName]++;
    }
  });
  
  const csrRange = targetSS.getRangeByName("csr_team").getValues();
  const csrNames = [];
  
  csrRange.forEach(row => {
    if (row[0]) {
      // Splits "Name, Ext" by the comma, takes the first part, and removes extra spaces
      const rawName = String(row[0]).split(",")[0].trim();
      csrNames.push(rawName);
    }
  });

 const colJ_Values = []; // Agent Names
  const colK_Values = []; // Transfer %
  const colL_Values = []; // Total Calls
  const colM_Values = []; // Total Transferred
  const colN_X_Values = []; // Queues
  
  // FIX: Loop through the new csrNames array, not the deleted reportData
csrNames.forEach(agentName => {
    let lowerAgent = agentName.toLowerCase();
    
    // NEW FIX: If the agent has no data logged in the memory bank, skip them completely!
    if (!agentMetrics[lowerAgent]) return; 
    
    // Push the properly capitalized name for Column J
    colJ_Values.push([agentName]);
    
    let tCalls = agentMetrics[lowerAgent] ? agentMetrics[lowerAgent].totalCalls : 0;
    colL_Values.push([tCalls]); 
    
    let queueRow = [];
    let tTransferred = 0; 
    
    queueHeaders.forEach(qHead => {
      let count = 0;
      if (agentMetrics[lowerAgent] && agentMetrics[lowerAgent].queues[qHead]) {
        count = agentMetrics[lowerAgent].queues[qHead];
      }
      queueRow.push(count);
      tTransferred += count; 
    });
    colN_X_Values.push(queueRow);
    
    colM_Values.push([tTransferred]);
    
    let tPct = tCalls > 0 ? (tTransferred / tCalls) : 0;
    colK_Values.push([tPct]);
  });

  return { 
    agents: colJ_Values, 
    transPct: colK_Values, 
    totalCalls: colL_Values, 
    totalTransferred: colM_Values, 
    queues: colN_X_Values 
  };
}