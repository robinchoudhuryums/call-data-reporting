/**
 * -------------------------------------------------------------------------
 * CUSTOM REPORT BUILDER v9.0
 * -------------------------------------------------------------------------
 * Changelog from v8:
 *   • ATT Totals row now correctly uses dept TTT / dept Answered (not sum of per-agent ATTs)
 *   • Per-agent "Contacts" columns: collapsed name(count) lists per category
 *   • 🔍 Diagnostics panel written to column L on each run for data verification
 *   • Pie charts: agent share of Total calls per selected category
 *   • Menu item for standalone diagnostics run
 * -------------------------------------------------------------------------
 */

/* ═══════════════════════════════════════════
   MENU
   ═══════════════════════════════════════════ */

/**function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⭐ Admin Tools')
    .addItem('📊 Run Dashboard Report', 'generateCustomReport')
    .addSeparator()
    .addItem('🔍 Run Diagnostics Only', 'runDiagnosticsOnly')
    .addItem('🛠️ Reset Dashboard UI', 'createCustomReportDashboard')
    .addToUi();
}*/

/* ═══════════════════════════════════════════
   PALETTE & CONSTANTS
   ═══════════════════════════════════════════ */

const THEME = {
  primary:    '#1a73e8',
  dark:       '#202124',
  headerBg:   '#3c4043',
  headerFg:   'white',
  sectionBg:  '#e8eaed',
  controlBg:  '#f8f9fa',
  inputBg:    '#ffffff',
  border:     '#dadce0',
  labelFg:    '#5f6368',
  green:      '#188038',
  red:        '#d93025',
  totalsBg:   '#e8f0fe',
  totalsFg:   '#174ea6',
  bandLight:  '#f1f3f4',

  // Per-category header backgrounds
  catOBExt:   '#1a73e8',   // Blue
  catIBExt:   '#e8710a',   // Orange
  catOBInt:   '#9334e6',   // Purple
  catIBInt:   '#0d652d',   // Green

  // Lighter tints for contact columns
  catOBExtLight: '#d2e3fc',
  catIBExtLight: '#fce8cd',
  catOBIntLight: '#e9d5f5',
  catIBIntLight: '#ceead6',

  // Pie chart fills (matching category order)
  pieColors: ['#4285f4','#ea4335','#fbbc04','#34a853','#ff6d01','#46bdc6','#7baaf7','#f07b72'],
};

const REPORT_ANCHOR_ROW = 12;
const DIAG_COL          = 12;   // Column L for diagnostics
const SHEET_NAME        = 'Custom Report Builder';
const HIST_SHEET_NAME   = 'CDR Historical Data';
const CONFIG_SHEET_NAME = 'DO NOT EDIT!';
const CONTACT_CAP       = 15;   // Max unique contacts to show per cell before truncating

/* ═══════════════════════════════════════════
   SETUP: Create / Reset Dashboard UI
   ═══════════════════════════════════════════ */

function createCustomReportDashboard() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  let sheet  = ss.getSheetByName(SHEET_NAME);

  if (sheet) { sheet.clear(); } else { sheet = ss.insertSheet(SHEET_NAME); }

  sheet.setHiddenGridlines(true);
  sheet.getRange('A:Z')
    .setFontFamily('Roboto')
    .setVerticalAlignment('middle');

  // ── Section: Report Settings ──────────────────────────────────
  const settingsRange = sheet.getRange('A1:B8');
  settingsRange
    .setBackground(THEME.controlBg)
    .setBorder(null, true, null, true, null, null, THEME.border, SpreadsheetApp.BorderStyle.SOLID);

  sheet.getRange('A1')
    .setValue('REPORT SETTINGS')
    .setFontWeight('bold')
    .setFontSize(10)
    .setFontColor(THEME.dark);

  const labels = [
    ['DEPARTMENT'],
    ['CURRENT START'],
    ['CURRENT END'],
    ['COMPARE START (Opt)'],
    ['COMPARE END (Auto)'],
    ['AGENT FILTER (Opt)'],
  ];
  sheet.getRange('A2:A7').setValues(labels).setFontWeight('bold').setFontSize(9).setFontColor(THEME.labelFg);

  const inputs = sheet.getRange('B2:B7');
  inputs
    .setBackground(THEME.inputBg)
    .setBorder(true, true, true, true, null, null, THEME.border, SpreadsheetApp.BorderStyle.SOLID)
    .setFontWeight('bold')
    .setFontColor(THEME.dark);

  sheet.getRange('B6').setBackground('#f1f3f4').setFontColor(THEME.labelFg);

  const today    = new Date();
  const lastWeek = new Date(new Date().setDate(today.getDate() - 7));
  sheet.getRange('B3').setValue(lastWeek);
  sheet.getRange('B4').setValue(today);

  const configSheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (configSheet) {
    const deptRule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(configSheet.getRange('F1:S1'))
      .build();
    sheet.getRange('B2').setDataValidation(deptRule);
  }

  const histSheet = ss.getSheetByName(HIST_SHEET_NAME);
  if (histSheet) {
    const agentRule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(histSheet.getRange('E2:E'))
      .build();
    sheet.getRange('B7').setDataValidation(agentRule);
  }

  sheet.getRange('B8')
    .setValue('▶  GENERATE REPORT')
    .setFontWeight('bold')
    .setFontColor(THEME.primary)
    .setHorizontalAlignment('center');

  // ── Section: Category Checkboxes ──────────────────────────────
  sheet.getRange('D1')
    .setValue('DATA CATEGORIES')
    .setFontWeight('bold')
    .setFontSize(10)
    .setFontColor(THEME.dark);

  const categories = [
    [true,  'Outbound External'],
    [false, 'Inbound External'],
    [false, 'Outbound Internal'],
    [false, 'Inbound Internal'],
  ];
  sheet.getRange(2, 4, categories.length, 2).setValues(categories);
  sheet.getRange(2, 4, categories.length, 1).insertCheckboxes();

  sheet.getRange('D8')
    .setValue("ℹ️  'Compare End' auto-calculated  |  🔍 Diagnostics → column L")
    .setFontStyle('italic')
    .setFontSize(8)
    .setFontColor(THEME.labelFg);

  // ── Section: Report Output Placeholder ────────────────────────
  sheet.getRange('A' + REPORT_ANCHOR_ROW)
    .setValue('REPORT DATA')
    .setFontWeight('bold')
    .setFontSize(12)
    .setFontColor(THEME.dark);

  sheet.setColumnWidth(1, 180);
  for (let c = 2; c <= 26; c++) sheet.setColumnWidth(c, 115);

  SpreadsheetApp.getUi().alert('✅ Dashboard has been reset.');
}

/* ═══════════════════════════════════════════
   GENERATION ENGINE
   ═══════════════════════════════════════════ */

function generateCustomReport() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const dashSheet = ss.getSheetByName(SHEET_NAME);
  const histSheet = ss.getSheetByName(HIST_SHEET_NAME);

  if (!dashSheet || !histSheet) return;

  // ── 1. Read Inputs ────────────────────────────────────────────
  const dept          = dashSheet.getRange('B2').getValue();
  const start1        = new Date(dashSheet.getRange('B3').getValue());
  const end1          = new Date(dashSheet.getRange('B4').getValue());
  const cStartInput   = dashSheet.getRange('B5').getValue();
  const specificAgent = dashSheet.getRange('B7').getValue();

  if (!dept || !start1 || !end1) {
    SpreadsheetApp.getUi().alert('Please select a Department and Current date range.');
    return;
  }

  start1.setHours(0, 0, 0, 0);
  end1.setHours(23, 59, 59, 999);

  let useComp = false, start2, end2;
  if (cStartInput) {
    useComp = true;
    start2  = new Date(cStartInput);
    start2.setHours(0, 0, 0, 0);
    const durationMs = end1 - start1;
    end2 = new Date(start2.getTime() + durationMs);
    end2.setHours(23, 59, 59, 999);
    dashSheet.getRange('B6').setValue(end2);
  } else {
    dashSheet.getRange('B6').clearContent();
  }

  dashSheet.getRange('B8').setValue('⏳ Running…').setFontColor('orange');
  SpreadsheetApp.flush();

  // ── 2. Read Category Checkboxes ───────────────────────────────
  const catRows = dashSheet.getRange('D2:E5').getValues();
  const cats = {
    OB_EXT: catRows[0][0],
    IB_EXT: catRows[1][0],
    OB_INT: catRows[2][0],
    IB_INT: catRows[3][0],
  };

  if (!cats.OB_EXT && !cats.IB_EXT && !cats.OB_INT && !cats.IB_INT) {
    SpreadsheetApp.getUi().alert('Please select at least one Data Category.');
    dashSheet.getRange('B8').setValue('▶  GENERATE REPORT').setFontColor(THEME.primary);
    return;
  }

  // ── 3. Map Header Columns ────────────────────────────────────
  const histHeaders = histSheet.getRange(1, 1, 1, histSheet.getLastColumn()).getValues()[0];
  const colMap = {};
  histHeaders.forEach((h, i) => colMap[String(h).trim()] = i);
  const getIdx = (n) => colMap[n];

  const IDX = {
    DATE: getIdx('Date') || 2,
    DEPT: getIdx('Dept') || getIdx('Department') || 3,
    NAME: getIdx('AgentName') || 4,

    OB_EXT_TOT:      getIdx('OB External Total'),
    OB_EXT_ANS_LIST: getIdx('OB External List (Answered)'),
    OB_EXT_MIS_LIST: getIdx('OB External List (Missed)'),
    OB_EXT_DUR:      getIdx('OB External Total Duration') || getIdx('OB External TTT'),

    OB_INT_TOT: getIdx('OB List Total (Internal Direct)'),
    OB_INT_ANS: getIdx('OB List Answered (Internal Direct)'),

    IB_ANS_MIXED: getIdx('IB Answered List (Internal & External)') || getIdx('IB Answered List (Internal & External Direct)'),
    IB_MIS_MIXED: getIdx('IB Missed List (Internal & External)')  || getIdx('IB Missed List (Internal & External Direct)'),
  };

  // ── 4. Aggregate Data ────────────────────────────────────────
  const data   = histSheet.getDataRange().getValues();
  const agents = {};
  const top    = { obExtA: {}, obExtM: {}, obInt: {}, ibExt: {}, ibInt: {} };

  // Diagnostics accumulator: stores raw parsed items per category for verification
  const diag = { obExtAns: {}, obExtMis: {}, ibExtAns: {}, ibIntAns: {}, obIntAll: {} };

  const initStats = () => ({
    obExt: { t: 0, a: 0, d: 0 },
    ibExt: { t: 0, a: 0 },
    obInt: { t: 0, a: 0 },
    ibInt: { t: 0, a: 0 },
  });

  const initContacts = () => ({
    obExtAns: {},   // External numbers/names answered (outbound)
    obExtMis: {},   // External numbers/names missed   (outbound)
    ibExtAns: {},   // External callers answered        (inbound)
    ibIntAns: {},   // Internal contacts answered       (inbound)
    obIntAll: {},   // Internal contacts dialled        (outbound)
  });

  for (let i = 1; i < data.length; i++) {
    const row  = data[i];
    const d    = new Date(row[IDX.DATE]);
    const dStr = String(row[IDX.DEPT] || '');
    const name = row[IDX.NAME];

    if (!dStr.includes(dept)) continue;
    if (specificAgent && name !== specificAgent) continue;

    if (!agents[name]) agents[name] = { cur: initStats(), prev: initStats(), contacts: initContacts() };

    const obExtTot    = Number(row[IDX.OB_EXT_TOT] || 0);
    const obExtDur    = durationToSeconds(row[IDX.OB_EXT_DUR]);
    const obExtAnsStr = String(row[IDX.OB_EXT_ANS_LIST] || '');
    const obExtMisStr = String(row[IDX.OB_EXT_MIS_LIST] || '');
    const obExtAns    = countItemsInList(obExtAnsStr);

    const splitList = (str) => {
      const parts = str.split('|');
      return {
        int:    countItemsInList(parts[0] || ''),
        ext:    countItemsInList(parts[1] || ''),
        intRaw: parts[0] || '',
        extRaw: parts[1] || '',
      };
    };

    const ibAns = splitList(String(row[IDX.IB_ANS_MIXED] || ''));
    const ibMis = splitList(String(row[IDX.IB_MIS_MIXED] || ''));

    const ibExtTotVal = ibAns.ext + ibMis.ext;
    const ibIntTotVal = ibAns.int + ibMis.int;

    const obIntTotVal = countItemsInList(String(row[IDX.OB_INT_TOT] || ''));
    const obIntAnsVal = countItemsInList(String(row[IDX.OB_INT_ANS] || ''));

    const addToBucket = (b, trackTop) => {
      b.obExt.t += obExtTot;
      b.obExt.a += obExtAns;
      b.obExt.d += obExtDur;

      b.ibExt.t += ibExtTotVal;
      b.ibExt.a += ibAns.ext;

      b.obInt.t += obIntTotVal;
      b.obInt.a += obIntAnsVal;

      b.ibInt.t += ibIntTotVal;
      b.ibInt.a += ibAns.int;

      if (trackTop) {
        parseAndAggregate(obExtAnsStr, top.obExtA, 'EXT');
        parseAndAggregate(obExtMisStr, top.obExtM, 'EXT');
        parseAndAggregate(String(row[IDX.OB_INT_TOT] || ''), top.obInt, 'INT');
        parseAndAggregate(ibAns.extRaw, top.ibExt, 'EXT');
        parseAndAggregate(ibAns.intRaw, top.ibInt, 'INT');
      }
    };

    if (d >= start1 && d <= end1) {
      addToBucket(agents[name].cur, true);

      // Per-agent contact tracking (current period only)
      parseAndAggregate(obExtAnsStr, agents[name].contacts.obExtAns, 'EXT');
      parseAndAggregate(obExtMisStr, agents[name].contacts.obExtMis, 'EXT');
      parseAndAggregate(ibAns.extRaw, agents[name].contacts.ibExtAns, 'EXT');
      parseAndAggregate(ibAns.intRaw, agents[name].contacts.ibIntAns, 'INT');
      parseAndAggregate(String(row[IDX.OB_INT_TOT] || ''), agents[name].contacts.obIntAll, 'INT');

      // Global diagnostics (current period only)
      parseAndAggregate(obExtAnsStr, diag.obExtAns, 'EXT');
      parseAndAggregate(obExtMisStr, diag.obExtMis, 'EXT');
      parseAndAggregate(ibAns.extRaw, diag.ibExtAns, 'EXT');
      parseAndAggregate(ibAns.intRaw, diag.ibIntAns, 'INT');
      parseAndAggregate(String(row[IDX.OB_INT_TOT] || ''), diag.obIntAll, 'INT');
    }
    if (useComp && d >= start2 && d <= end2) {
      addToBucket(agents[name].prev, false);
    }
  }

  // ── 5. Build Dynamic Column Headers ──────────────────────────
  const tableHeaders = ['AGENT NAME'];
  const headerColors = [THEME.headerBg];
  const colFormats   = ['@'];

  const addBlock = (catName, hasDur, color, lightColor) => {
    if (useComp) {
      tableHeaders.push(
        `${catName} Total (C)`, `${catName} Total (P)`, 'Diff',
        `${catName} Ans (C)`,   `${catName} Ans (P)`,   'Diff',
        `${catName} Rate (C)`,  `${catName} Rate (P)`,  'Rate Diff',
      );
      for (let n = 0; n < 9; n++) headerColors.push(color);
      colFormats.push('#,##0', '#,##0', '#,##0', '#,##0', '#,##0', '#,##0', '0.0%', '0.0%', '+0.0%;-0.0%');

      if (hasDur) {
        tableHeaders.push('TTT (C)', 'TTT (P)', 'ATT (C)', 'ATT (P)');
        for (let n = 0; n < 4; n++) headerColors.push(color);
        colFormats.push('[h]:mm:ss', '[h]:mm:ss', '[h]:mm:ss', '[h]:mm:ss');
      }
    } else {
      tableHeaders.push(`${catName} Total`, `${catName} Ans`, `${catName} Rate`);
      for (let n = 0; n < 3; n++) headerColors.push(color);
      colFormats.push('#,##0', '#,##0', '0.0%');

      if (hasDur) {
        tableHeaders.push('TTT', 'ATT');
        for (let n = 0; n < 2; n++) headerColors.push(color);
        colFormats.push('[h]:mm:ss', '[h]:mm:ss');
      }
    }

    // Contacts column (always just 1, uses lighter tint)
    tableHeaders.push(`${catName} Contacts`);
    headerColors.push(lightColor);
    colFormats.push('@');
  };

  if (cats.OB_EXT) addBlock('OB Ext', true,  THEME.catOBExt, THEME.catOBExtLight);
  if (cats.IB_EXT) addBlock('IB Ext', false, THEME.catIBExt, THEME.catIBExtLight);
  if (cats.OB_INT) addBlock('OB Int', false, THEME.catOBInt, THEME.catOBIntLight);
  if (cats.IB_INT) addBlock('IB Int', false, THEME.catIBInt, THEME.catIBIntLight);

  // ── 6. Build Agent Rows ──────────────────────────────────────
  const tableRows = [];

  for (const [name, s] of Object.entries(agents)) {
    const anyActivity =
      s.cur.obExt.t + s.cur.ibExt.t + s.cur.obInt.t + s.cur.ibInt.t +
      s.prev.obExt.t + s.prev.ibExt.t + s.prev.obInt.t + s.prev.ibInt.t;
    if (anyActivity === 0) continue;

    const row = [name];

    const pushData = (c, p, hasDur, contactMap) => {
      const cRate = c.t > 0 ? c.a / c.t : 0;
      const cATT  = c.a > 0 ? c.d / c.a : 0;

      if (useComp) {
        const pRate = p.t > 0 ? p.a / p.t : 0;
        const pATT  = p.a > 0 ? p.d / p.a : 0;

        row.push(c.t, p.t, c.t - p.t);
        row.push(c.a, p.a, c.a - p.a);
        row.push(cRate, pRate, cRate - pRate);
        if (hasDur) {
          row.push(c.d / 86400, p.d / 86400);
          row.push(cATT / 86400, pATT / 86400);
        }
      } else {
        row.push(c.t, c.a, cRate);
        if (hasDur) {
          row.push(c.d / 86400, cATT / 86400);
        }
      }

      // Contacts cell
      row.push(mapToContactString(contactMap));
    };

    if (cats.OB_EXT) pushData(s.cur.obExt, s.prev.obExt, true,  mergeContactMaps(s.contacts.obExtAns, s.contacts.obExtMis));
    if (cats.IB_EXT) pushData(s.cur.ibExt, s.prev.ibExt, false, s.contacts.ibExtAns);
    if (cats.OB_INT) pushData(s.cur.obInt, s.prev.obInt, false, s.contacts.obIntAll);
    if (cats.IB_INT) pushData(s.cur.ibInt, s.prev.ibInt, false, s.contacts.ibIntAns);

    tableRows.push(row);
  }

  tableRows.sort((a, b) => (b[1] || 0) - (a[1] || 0));

  // ── 7. Render ────────────────────────────────────────────────
  const startRow = REPORT_ANCHOR_ROW;
  const lastRow  = dashSheet.getLastRow();

  if (lastRow >= startRow) {
    const clearRange = dashSheet.getRange(startRow, 1, Math.max(lastRow - startRow + 60, 60), 40);
    clearRange.clearContent().clearFormat().setNumberFormat('@');
    clearRange.setNumberFormat('');
    try { clearRange.getBandings().forEach(b => b.remove()); } catch (_) {}
  }

  // Remove any old charts
  dashSheet.getCharts().forEach(c => dashSheet.removeChart(c));

  const fmtDate = (d) => Utilities.formatDate(d, ss.getSpreadsheetTimeZone(), 'MMM d, yyyy');

  dashSheet.getRange(startRow, 1)
    .setValue('📊  ' + dept + '  |  ' + fmtDate(start1) + ' → ' + fmtDate(end1)
      + (useComp ? '  vs  ' + fmtDate(start2) + ' → ' + fmtDate(end2) : ''))
    .setFontWeight('bold')
    .setFontSize(11)
    .setFontColor(THEME.dark);

  dashSheet.getRange(startRow, tableHeaders.length)
    .setValue('Generated: ' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'MMM d, yyyy  h:mm a'))
    .setFontSize(8)
    .setFontColor(THEME.labelFg)
    .setHorizontalAlignment('right');

  const headerRow = startRow + 1;

  // Header bar
  const hdrRange = dashSheet.getRange(headerRow, 1, 1, tableHeaders.length);
  hdrRange.setValues([tableHeaders])
    .setFontColor(THEME.headerFg)
    .setFontWeight('bold')
    .setFontSize(9)
    .setHorizontalAlignment('center')
    .setWrap(true);
  hdrRange.getCell(1, 1).setHorizontalAlignment('left');

  headerColors.forEach((clr, i) => {
    dashSheet.getRange(headerRow, i + 1).setBackground(clr);
  });

  // Contact column headers get dark text on light backgrounds
  tableHeaders.forEach((h, i) => {
    if (h.includes('Contacts')) {
      dashSheet.getRange(headerRow, i + 1).setFontColor(THEME.dark);
    }
  });

  if (tableRows.length === 0) {
    dashSheet.getRange(headerRow + 1, 1)
      .setValue('No data found for the selected criteria.')
      .setFontStyle('italic')
      .setFontColor(THEME.labelFg);
    dashSheet.getRange('B8').setValue('▶  GENERATE REPORT').setFontColor(THEME.primary);
    return;
  }

  // Data rows
  const dataRange = dashSheet.getRange(headerRow + 1, 1, tableRows.length, tableHeaders.length);
  dataRange.setValues(tableRows);
  dataRange.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);

  // ── 8. Totals Row ───────────────────────────────────────────
  const totRow = headerRow + tableRows.length + 1;
  const totData = buildTotalsRow(tableHeaders, tableRows);

  const totRange = dashSheet.getRange(totRow, 1, 1, tableHeaders.length);
  totRange.setValues([totData])
    .setBackground(THEME.totalsBg)
    .setFontColor(THEME.totalsFg)
    .setFontWeight('bold');

  // ── 9. Formatting Pass ──────────────────────────────────────
  const dataRowCount = tableRows.length + 1;

  for (let i = 0; i < tableHeaders.length; i++) {
    const colIdx = i + 1;
    const r = dashSheet.getRange(headerRow + 1, colIdx, dataRowCount, 1);

    if (colFormats[i]) {
      r.setNumberFormat(colFormats[i]);
    }

    const h = tableHeaders[i];

    // Green/Red colouring for Diff columns
    if (h === 'Diff' || h === 'Rate Diff') {
      const vals = r.getValues();
      const fmts = vals.map(v => [v[0] >= 0 ? THEME.green : THEME.red]);
      r.setFontColors(fmts);
    }

    // Style contact columns: smaller font, wrap text, set width
    if (h.includes('Contacts')) {
      r.setFontSize(8).setWrap(true).setVerticalAlignment('top');
      dashSheet.setColumnWidth(colIdx, 200);
    }
  }

  dashSheet.setFrozenRows(headerRow);
  dashSheet.autoResizeColumn(1);

  // ── 10. Top 5 Lists ─────────────────────────────────────────
  const listStart = totRow + 2;
  dashSheet.getRange(listStart, 1, 30, 10).clearContent();
  try { dashSheet.getRange(listStart, 1, 30, 10).getBandings().forEach(b => b.remove()); } catch (_) {}

  const writeList = (title, map, col) => {
    const cell = dashSheet.getRange(listStart, col, 1, 2);
    cell.merge()
      .setValue(title)
      .setFontWeight('bold')
      .setFontSize(9)
      .setBackground(THEME.sectionBg)
      .setFontColor(THEME.dark);
    writeTop5(dashSheet, listStart + 1, col, map);
  };

  if (cats.OB_EXT) writeList('TOP 5 OB EXT (ANS)', top.obExtA, 1);
  if (cats.IB_EXT) writeList('TOP 5 IB EXT',        top.ibExt, 3);
  if (cats.OB_INT) writeList('TOP 5 OB INT',        top.obInt, 5);
  if (cats.IB_INT) writeList('TOP 5 IB INT',        top.ibInt, 7);

  // ── 11. Pie Charts ──────────────────────────────────────────
  const chartAnchorRow = listStart + 8;
  buildPieCharts(dashSheet, headerRow, tableRows, tableHeaders, cats, chartAnchorRow, useComp);

  // ── 12. Diagnostics Panel ───────────────────────────────────
  writeDiagnostics(dashSheet, diag, cats, agents, start1, end1);

  // ── Done ─────────────────────────────────────────────────────
  dashSheet.getRange('B8').setValue('▶  GENERATE REPORT').setFontColor(THEME.primary);
}

/* ═══════════════════════════════════════════
   TOTALS ROW BUILDER  (ATT fix)
   ═══════════════════════════════════════════ */

function buildTotalsRow(headers, rows) {
  const totals = new Array(headers.length).fill(0);
  totals[0] = '⬤  TOTALS';

  // Sum all numeric columns
  for (const row of rows) {
    for (let c = 1; c < row.length; c++) {
      if (typeof row[c] === 'number') totals[c] += row[c];
    }
  }

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];

    // Recalculate Rate columns: dept Ans / dept Total
    if (h.includes('Rate') && h !== 'Rate Diff' && h !== 'Diff') {
      const prefix = h.replace(/ Rate.*/, '');
      const suffix = h.replace(/.*Rate/, '');
      const totalIdx = headers.indexOf(prefix + ' Total' + suffix);
      const ansIdx   = headers.indexOf(prefix + ' Ans'   + suffix);
      totals[i] = (totalIdx !== -1 && ansIdx !== -1 && totals[totalIdx] > 0)
        ? totals[ansIdx] / totals[totalIdx]
        : 0;
    }

    // Recalculate ATT columns: dept TTT / dept Answered (NOT sum of per-agent ATTs)
    if (h.includes('ATT')) {
      const suffix  = h.replace(/.*ATT/, '');             // e.g. " (C)" or ""
      const tttIdx  = headers.indexOf('TTT' + suffix);    // Matching TTT column
      // Find the correct Answered column — check which category block we're in
      // by scanning backwards for the nearest "Ans" header
      let ansIdx = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (headers[j].includes('Ans') && headers[j].endsWith(suffix)) {
          ansIdx = j;
          break;
        }
      }
      if (tttIdx !== -1 && ansIdx !== -1 && totals[ansIdx] > 0) {
        // TTT is stored as day-fractions, Ans as integers
        // ATT = total seconds / total answered calls → convert back to day-fractions
        // TTT (day-frac) * 86400 = seconds;  / Ans = ATT seconds;  / 86400 = ATT day-frac
        totals[i] = totals[tttIdx] / totals[ansIdx];
      } else {
        totals[i] = 0;
      }
    }

    // Recalculate Diff columns
    if (h === 'Diff' || h === 'Rate Diff') {
      if (i >= 2 && typeof totals[i - 2] === 'number' && typeof totals[i - 1] === 'number') {
        totals[i] = totals[i - 2] - totals[i - 1];
      }
    }

    // Contact columns → blank in totals
    if (h.includes('Contacts')) {
      totals[i] = '';
    }
  }

  return totals;
}

/* ═══════════════════════════════════════════
   PIE CHARTS
   ═══════════════════════════════════════════ */

function buildPieCharts(sheet, headerRow, tableRows, tableHeaders, cats, anchorRow, useComp) {
  // For each active category, find the "Total (C)" or "Total" column and build a pie
  const catDefs = [];
  if (cats.OB_EXT) catDefs.push({ label: 'OB Ext', search: useComp ? 'OB Ext Total (C)' : 'OB Ext Total' });
  if (cats.IB_EXT) catDefs.push({ label: 'IB Ext', search: useComp ? 'IB Ext Total (C)' : 'IB Ext Total' });
  if (cats.OB_INT) catDefs.push({ label: 'OB Int', search: useComp ? 'OB Int Total (C)' : 'OB Int Total' });
  if (cats.IB_INT) catDefs.push({ label: 'IB Int', search: useComp ? 'IB Int Total (C)' : 'IB Int Total' });

  let chartCol = 1;
  catDefs.forEach((def, idx) => {
    const colIdx = tableHeaders.indexOf(def.search);
    if (colIdx === -1) return;

    // Build data for this chart: agent names (col 0) + this total column
    const chartData = tableRows
      .map(r => ({ name: r[0], val: r[colIdx] || 0 }))
      .filter(r => r.val > 0)
      .sort((a, b) => b.val - a.val);

    if (chartData.length === 0) return;

    // Write temporary data block for the chart (Sheets charts need cell ranges)
    const tmpRow = anchorRow;
    const tmpCol = chartCol;
    const labels = chartData.map(d => [d.name, d.val]);

    sheet.getRange(tmpRow, tmpCol).setValue(def.label + ' Agent').setFontWeight('bold').setFontSize(8);
    sheet.getRange(tmpRow, tmpCol + 1).setValue('Calls').setFontWeight('bold').setFontSize(8);
    sheet.getRange(tmpRow + 1, tmpCol, labels.length, 2).setValues(labels).setFontSize(8);

    // Create pie chart
    const dataRange  = sheet.getRange(tmpRow, tmpCol, labels.length + 1, 2);
    const chartBuilder = sheet.newChart()
      .setChartType(Charts.ChartType.PIE)
      .addRange(dataRange)
      .setPosition(anchorRow + labels.length + 2, tmpCol, 0, 0)
      .setOption('title', def.label + ' — Agent Share')
      .setOption('pieHole', 0.35)
      .setOption('legend', { position: 'right', textStyle: { fontSize: 9 } })
      .setOption('chartArea', { width: '85%', height: '80%' })
      .setOption('colors', THEME.pieColors)
      .setOption('width', 420)
      .setOption('height', 280);

    sheet.insertChart(chartBuilder.build());
    chartCol += 3;   // Space between charts
  });
}

/* ═══════════════════════════════════════════
   DIAGNOSTICS
   ═══════════════════════════════════════════ */

function writeDiagnostics(dashSheet, diag, cats, agents, start1, end1) {
  const col = DIAG_COL;
  const maxEntries = 25;   // Cap per category to avoid overwhelming the panel

  // Clear previous diagnostics
  dashSheet.getRange(1, col, 200, 3).clearContent().clearFormat();

  let r = 1;

  // Header
  dashSheet.getRange(r, col, 1, 3).merge()
    .setValue('🔍 DIAGNOSTICS  — Parsed Data Verification')
    .setFontWeight('bold')
    .setFontSize(10)
    .setFontColor(THEME.dark)
    .setBackground(THEME.sectionBg);
  r += 1;

  dashSheet.getRange(r, col).setValue('Date range: ' + start1.toLocaleDateString() + ' – ' + end1.toLocaleDateString())
    .setFontSize(8).setFontColor(THEME.labelFg);
  r += 1;

  // Summary counts
  dashSheet.getRange(r, col).setValue('CATEGORY').setFontWeight('bold').setFontSize(8);
  dashSheet.getRange(r, col + 1).setValue('UNIQUE').setFontWeight('bold').setFontSize(8);
  dashSheet.getRange(r, col + 2).setValue('TOTAL COUNT').setFontWeight('bold').setFontSize(8);
  r += 1;

  const writeSummary = (label, map) => {
    const entries = Object.entries(map);
    const totalCount = entries.reduce((s, e) => s + e[1], 0);
    dashSheet.getRange(r, col).setValue(label).setFontSize(8);
    dashSheet.getRange(r, col + 1).setValue(entries.length).setFontSize(8);
    dashSheet.getRange(r, col + 2).setValue(totalCount).setFontSize(8).setFontWeight('bold');
    r += 1;
  };

  if (cats.OB_EXT) {
    writeSummary('OB Ext Answered', diag.obExtAns);
    writeSummary('OB Ext Missed',   diag.obExtMis);
  }
  if (cats.IB_EXT) writeSummary('IB Ext Answered', diag.ibExtAns);
  if (cats.OB_INT) writeSummary('OB Int All',      diag.obIntAll);
  if (cats.IB_INT) writeSummary('IB Int Answered',  diag.ibIntAns);

  r += 1;

  // Per-category detail: top N names and their counts
  const writeDetail = (title, map, color) => {
    dashSheet.getRange(r, col, 1, 3).merge()
      .setValue(title)
      .setFontWeight('bold')
      .setFontSize(9)
      .setBackground(color)
      .setFontColor('white');
    r += 1;

    dashSheet.getRange(r, col).setValue('Name / Number').setFontWeight('bold').setFontSize(8);
    dashSheet.getRange(r, col + 1).setValue('Count').setFontWeight('bold').setFontSize(8);
    dashSheet.getRange(r, col + 2).setValue('% of Cat').setFontWeight('bold').setFontSize(8);
    r += 1;

    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    const total   = entries.reduce((s, e) => s + e[1], 0);
    const capped  = entries.slice(0, maxEntries);

    capped.forEach(([name, count]) => {
      dashSheet.getRange(r, col).setValue(name).setFontSize(8);
      dashSheet.getRange(r, col + 1).setValue(count).setFontSize(8);
      dashSheet.getRange(r, col + 2).setValue(total > 0 ? count / total : 0)
        .setNumberFormat('0.0%').setFontSize(8);
      r += 1;
    });

    if (entries.length > maxEntries) {
      dashSheet.getRange(r, col).setValue('… and ' + (entries.length - maxEntries) + ' more')
        .setFontStyle('italic').setFontSize(8).setFontColor(THEME.labelFg);
      r += 1;
    }
    r += 1;
  };

  if (cats.OB_EXT) {
    writeDetail('OB EXT — Answered Numbers', diag.obExtAns, THEME.catOBExt);
    writeDetail('OB EXT — Missed Numbers',   diag.obExtMis, THEME.catOBExt);
  }
  if (cats.IB_EXT) writeDetail('IB EXT — Answered Callers',    diag.ibExtAns, THEME.catIBExt);
  if (cats.OB_INT) writeDetail('OB INT — All Contacts Dialled', diag.obIntAll, THEME.catOBInt);
  if (cats.IB_INT) writeDetail('IB INT — Answered Contacts',    diag.ibIntAns, THEME.catIBInt);

  // Per-agent subtotals for quick cross-checking
  r += 1;
  dashSheet.getRange(r, col, 1, 3).merge()
    .setValue('AGENT SUBTOTALS (Current Period)')
    .setFontWeight('bold')
    .setFontSize(9)
    .setBackground(THEME.headerBg)
    .setFontColor('white');
  r += 1;

  dashSheet.getRange(r, col).setValue('Agent').setFontWeight('bold').setFontSize(8);
  dashSheet.getRange(r, col + 1).setValue('OB Ext A / IB Ext A').setFontWeight('bold').setFontSize(8);
  dashSheet.getRange(r, col + 2).setValue('OB Int T / IB Int A').setFontWeight('bold').setFontSize(8);
  r += 1;

  Object.entries(agents)
    .sort((a, b) => b[1].cur.obExt.t - a[1].cur.obExt.t)
    .forEach(([name, s]) => {
      dashSheet.getRange(r, col).setValue(name).setFontSize(8);
      dashSheet.getRange(r, col + 1).setValue(s.cur.obExt.a + ' / ' + s.cur.ibExt.a).setFontSize(8);
      dashSheet.getRange(r, col + 2).setValue(s.cur.obInt.t + ' / ' + s.cur.ibInt.a).setFontSize(8);
      r += 1;
    });
}

/**
 * Standalone diagnostics runner (from menu).
 */
function runDiagnosticsOnly() {
  SpreadsheetApp.getUi().alert(
    '🔍 Diagnostics are generated automatically with each report run.\n\n' +
    'Run "📊 Run Dashboard Report" and check column L for the diagnostics panel.'
  );
}

/* ═══════════════════════════════════════════
   HELPER FUNCTIONS
   ═══════════════════════════════════════════ */

function countItemsInList(str) {
  if (!str || !str.trim()) return 0;
  let total = 0;
  str.split(',').forEach(item => {
    item = item.trim();
    if (!item) return;
    const match = item.match(/\((\d+)\)/);
    total += match ? parseInt(match[1], 10) : 1;
  });
  return total;
}

function durationToSeconds(timeStr) {
  if (timeStr == null) return 0;
  if (timeStr instanceof Date) {
    return timeStr.getHours() * 3600 + timeStr.getMinutes() * 60 + timeStr.getSeconds();
  }
  if (typeof timeStr === 'number') return Math.round(timeStr * 86400);
  const parts = timeStr.toString().split(':');
  if (parts.length < 3) return 0;
  return (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
}

function parseAndAggregate(str, mapObj, type) {
  if (!str) return;
  str.split(',').forEach(item => {
    item = item.trim();
    if (!item) return;
    let count = 1;
    const countMatch = item.match(/\((\d+)\)$/);
    if (countMatch) count = parseInt(countMatch[1], 10);
    let clean = item.replace(/\s*\(\d+\)$/, '');
    if (type === 'EXT') clean = clean.replace(/\s+\d{1,2}:\d{2}:\d{2}.*$/, '');
    const key = clean.trim();
    if (key) mapObj[key] = (mapObj[key] || 0) + count;
  });
}

/**
 * Converts a frequency map { name: count } into a compact cell string.
 * e.g. "John Smith(3), Jane Doe(1), Acme Corp(5)"
 * Sorted by count descending. Capped at CONTACT_CAP unique entries.
 */
function mapToContactString(map) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';

  const capped = entries.slice(0, CONTACT_CAP);
  const parts = capped.map(([name, count]) => count > 1 ? `${name}(${count})` : name);

  let result = parts.join(', ');
  if (entries.length > CONTACT_CAP) {
    result += ` … +${entries.length - CONTACT_CAP} more`;
  }
  return result;
}

/**
 * Merges two frequency maps (e.g. answered + missed into one combined contact map).
 */
function mergeContactMaps(map1, map2) {
  const merged = {};
  for (const [k, v] of Object.entries(map1)) merged[k] = (merged[k] || 0) + v;
  for (const [k, v] of Object.entries(map2)) merged[k] = (merged[k] || 0) + v;
  return merged;
}

function writeTop5(sheet, row, col, map) {
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (sorted.length === 0) return;

  const range = sheet.getRange(row, col, sorted.length, 2);
  range.setValues(sorted);
  range.setFontSize(9);
  sheet.getRange(row, col + 1, sorted.length, 1)
    .setFontWeight('bold')
    .setFontColor(THEME.dark)
    .setHorizontalAlignment('center');
}