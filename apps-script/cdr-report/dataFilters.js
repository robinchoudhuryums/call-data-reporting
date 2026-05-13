// NOTE: simulateSplitCol2 and parseDurationDecimal below are duplicates of the
// identically named functions in the main pipeline script (CDR Pipeline v31).
// If those functions are ever updated there, this file must be updated to match,
// or extraction results may silently diverge from dashboard values.

function showSidebar() {
  const htmlString = `
    <!DOCTYPE html>
    <html>
      <head>
        <base target="_top">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          html, body {
            height: 100%;
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
            background-color: #f8f9fa;
            overflow: hidden;
          }

          #layout {
            display: flex;
            flex-direction: column;
            height: 100vh;
          }

          #top-panel {
            flex-shrink: 0;
            padding: 10px 12px 8px;
            background: #f8f9fa;
            border-bottom: 1px solid #ddd;
          }

          #content {
            flex: 1;
            overflow: auto;
            padding: 10px 12px;
            font-size: 11px;
          }

          button {
            width: 100%;
            padding: 9px;
            background-color: #1a73e8;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: bold;
            transition: background-color 0.2s;
            margin-bottom: 6px;
          }
          button:hover { background-color: #1557b0; }
          button:disabled { background-color: #ccc; cursor: not-allowed; }

          .secondary-btn {
            background-color: #e8eaed;
            color: #3c4043;
            border: 1px solid #dadce0;
            padding: 4px 8px;
            font-size: 11px;
            font-weight: normal;
            width: auto;
            margin-bottom: 0;
          }
          .secondary-btn:hover { background-color: #d5d5d5; }

          details {
            background: white;
            border: 1px solid #dadce0;
            border-radius: 4px;
            padding: 6px 8px;
            margin-top: 6px;
            font-size: 12px;
          }
          summary {
            font-weight: bold;
            cursor: pointer;
            outline: none;
            user-select: none;
          }

          .checkbox-list {
            max-height: 150px;
            overflow-y: auto;
            margin-top: 6px;
          }
          .checkbox-group-label {
            font-size: 10px;
            color: #888;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin: 7px 0 3px;
            font-weight: bold;
          }
          .checkbox-item {
            margin-bottom: 3px;
            display: flex;
            align-items: center;
            line-height: 1.4;
          }
          .checkbox-item input { margin-right: 6px; flex-shrink: 0; }
          .diag-label { color: #888; font-style: italic; }

          #context-bar {
            background: #e8f0fe;
            border: 1px solid #c5d5f8;
            border-radius: 4px;
            padding: 6px 8px;
            font-size: 11px;
            color: #1a5ca8;
            margin-bottom: 8px;
            line-height: 1.5;
            word-break: break-word;
          }
          #context-bar strong { display: block; font-size: 12px; }

          .result-header {
            margin: 0 0 8px;
            font-size: 12px;
            font-weight: bold;
          }
          .match-ok   { color: #1e8e3e; }
          .match-warn { color: #c5221f; }
          .match-avg  { color: #5f6368; }

          table { border-collapse: collapse; width: 100%; white-space: nowrap; }
          th, td { border: 1px solid #ddd; padding: 4px 7px; text-align: left; }
          th { background-color: #e3e3e3; position: sticky; top: 0; z-index: 1; font-size: 11px; }
          td { font-size: 11px; }

          .error { color: #d93025; font-weight: bold; font-size: 12px; line-height: 1.5; }
          .instructions { color: #5f6368; font-style: italic; line-height: 1.8; font-size: 12px; }
        </style>
      </head>
      <body>
        <div id="layout">

          <div id="top-panel">
            <button id="runBtn" onclick="fetchData()">&#9654; Run for Selected Cell</button>

            <details id="colFilter">
              <summary>Filter Columns</summary>
              <div style="display:flex; gap:4px; margin-top:6px; flex-wrap:wrap;">
                <button class="secondary-btn" onclick="toggleAll(true,  false)" title="Check all columns">All</button>
                <button class="secondary-btn" onclick="toggleAll(false, false)" title="Uncheck all columns">None</button>
                <button class="secondary-btn" onclick="toggleAll(true,  true)"  title="Also check diagnostic columns">+ Diag</button>
              </div>
              <div class="checkbox-list" id="checkboxes">
                <span style="color:#888; font-size:11px;">Loading headers...</span>
              </div>
            </details>
          </div>

          <div id="content">
            <p class="instructions">
              1. Click a metric cell in your dashboard.<br>
              2. Choose columns to display.<br>
              3. Click <strong>Run</strong> to view the source rows.
            </p>
          </div>

        </div>
        <script>
          window.onload = function() {
            google.script.run
              .withSuccessHandler(renderCheckboxes)
              .withFailureHandler(function() {
                document.getElementById('checkboxes').innerHTML =
                  '<span class="error">Failed to load headers.</span>';
              })
              .getRawHeaders();
          };

          function renderCheckboxes(headersList) {
            const container  = document.getElementById('checkboxes');
            container.innerHTML = '';
            const defaults   = headersList.filter(h =>  h.checked);
            const diags      = headersList.filter(h => !h.checked);

            defaults.forEach(item => {
              container.innerHTML +=
                '<label class="checkbox-item">' +
                '<input type="checkbox" class="col-check" value="' + item.index + '" data-diag="false" checked> ' +
                item.name + '</label>';
            });

            if (diags.length > 0) {
              container.innerHTML += '<div class="checkbox-group-label">Diagnostic</div>';
              diags.forEach(item => {
                container.innerHTML +=
                  '<label class="checkbox-item">' +
                  '<input type="checkbox" class="col-check" value="' + item.index + '" data-diag="true"> ' +
                  '<span class="diag-label">' + item.name + '</span></label>';
              });
            }
          }

          function toggleAll(state, diagOnly) {
            document.querySelectorAll('.col-check').forEach(cb => {
              if (!diagOnly || cb.dataset.diag === 'true') cb.checked = state;
            });
          }

          function fetchData() {
            const btn     = document.getElementById('runBtn');
            const content = document.getElementById('content');
            btn.disabled    = true;
            btn.innerText   = 'Extracting\u2026';
            content.innerHTML = '<p class="instructions">Scanning rows\u2026</p>';

            google.script.run
              .withSuccessHandler(function(jsonString) {
                try {
                  const result = JSON.parse(jsonString);
                  if (result.error) {
                    content.innerHTML = '<p class="error">&#9888; ' + result.error + '</p>';
                  } else {
                    buildTable(result.headers, result.rows, result.context);
                  }
                } catch(e) {
                  content.innerHTML = '<p class="error">Failed to parse response.</p>';
                }
                btn.disabled  = false;
                btn.innerText = '\u25B6 Run for Selected Cell';
              })
              .withFailureHandler(function(err) {
                content.innerHTML = '<p class="error">Error: ' + err.message + '</p>';
                btn.disabled  = false;
                btn.innerText = '\u25B6 Run for Selected Cell';
              })
              .getExtractionDataJSON();
          }

          function buildTable(headers, rows, context) {
            const checked = [];
            document.querySelectorAll('.col-check').forEach(cb => {
              if (cb.checked) checked.push(parseInt(cb.value));
            });

            if (checked.length === 0) {
              document.getElementById('content').innerHTML =
                '<p class="error">Select at least one column to display.</p>';
              return;
            }

            let html = '';

            // Context bar
            if (context) {
              html += '<div id="context-bar">' +
                      '<strong>' + context.rowLabel + '</strong>' +
                      context.colLabel +
                      '</div>';
            }

            // Result summary with match indicator
            if (context && !context.isAverage) {
              const dashVal = parseInt(context.dashboardValue);
              const found   = rows.length;
              if (!isNaN(dashVal)) {
                const match = (found === dashVal);
                const icon  = match ? '&#10003;' : '&#10007;';
                const cls   = match ? 'match-ok' : 'match-warn';
                html += '<p class="result-header ' + cls + '">' +
                        (match ? '&#9989;' : '&#9888;') + ' Found ' + found +
                        ' row' + (found !== 1 ? 's' : '') +
                        ' &mdash; Dashboard: ' + dashVal +
                        ' <span style="font-size:13px;">' + icon + '</span></p>';
              } else {
                html += '<p class="result-header match-ok">&#9989; Found ' + rows.length + ' rows.</p>';
              }
            } else if (context && context.isAverage) {
              html += '<p class="result-header match-avg">&#8505; ' + rows.length +
                      ' row' + (rows.length !== 1 ? 's' : '') +
                      ' used in average &mdash; Dashboard: ' + context.dashboardValue + '</p>';
            } else {
              html += '<p class="result-header match-ok">&#9989; Found ' + rows.length + ' rows.</p>';
            }

            // Table
            html += '<table><thead><tr>';
            checked.forEach(i => {
              html += '<th>' + (headers[i] || 'Col ' + (i + 1)) + '</th>';
            });
            html += '</tr></thead><tbody>';
            rows.forEach(row => {
              html += '<tr>';
              checked.forEach(i => {
                html += '<td>' + (row[i] !== undefined && row[i] !== null ? row[i] : '') + '</td>';
              });
              html += '</tr>';
            });
            html += '</tbody></table>';

            document.getElementById('content').innerHTML = html;
          }
        </script>
      </body>
    </html>
  `;

  const htmlOutput = HtmlService.createHtmlOutput(htmlString).setTitle('Extraction Tool');
  SpreadsheetApp.getUi().showSidebar(htmlOutput);
}


// =========================================================================
// BACKEND LOGIC ENGINE
// =========================================================================

function getRawHeaders() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("Raw Data");
  if (!rawSheet) return [];

  const lastCol    = rawSheet.getLastColumn();
  const rawHeaders = rawSheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];

  // Default columns: shown pre-checked
  const defaultAllowed = new Set([
    "call id", "leg id", "start time", "stop time", "talk time",
    "caller", "caller name", "callee", "callee name",
    "last re-direct address", "last re-direct number",
    "dial-in number", "missed", "abandoned", "answered"
  ]);

  // Diagnostic columns: always included but pre-unchecked.
  // Identified by index (1=status, 5=type, 9=team, 11=queue name) to avoid
  // depending on exact header name strings which may vary by export format.
  const diagnosticIndices = new Set([1, 5, 9, 11]);

  const result     = [];
  const seenNames  = new Set();
  const seenIdx    = new Set();

  rawHeaders.forEach((h, i) => {
    const clean       = String(h).toLowerCase().trim();
    const isDefault   = defaultAllowed.has(clean) && !seenNames.has(clean);
    const isDiagnostic = diagnosticIndices.has(i) && !seenIdx.has(i);

    if (isDefault || isDiagnostic) {
      result.push({
        name:    h || `Col ${i + 1}`,
        index:   i,
        checked: isDefault  // diagnostics start unchecked
      });
      if (isDefault)   seenNames.add(clean);
      if (isDiagnostic) seenIdx.add(i);
    }
  });

  // Default columns first, then diagnostic
  result.sort((a, b) => {
    if (a.checked && !b.checked) return -1;
    if (!a.checked && b.checked) return 1;
    return a.index - b.index;
  });

  return result;
}


function getExtractionDataJSON() {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = ss.getActiveSheet();
  const activeCell  = activeSheet.getActiveCell();
  const reportSheetName = "QCDR Output";

  if (activeSheet.getName() !== reportSheetName) {
    return JSON.stringify({ error: "Please click a cell in your dashboard and try again." });
  }

  const targetRow   = activeCell.getRow();
  const targetCol   = activeCell.getColumn();
  const targetValue = String(activeCell.getValue()).trim();

  const totalRows = [2, 7, 10, 14, 17, 20, 23, 27, 31, 38, 41, 44, 47];
  if (totalRows.includes(targetRow)) {
    return JSON.stringify({ error: "This is a total row. Select a child metric row to drill into." });
  }

  if (targetCol < 3 || targetCol > 7 || targetCol === 6) {
    return JSON.stringify({ error: "Select a count or average wait cell. Labels and max wait (Col F) cannot be drilled into." });
  }

  if (targetValue === "" || targetValue === "0" || targetValue === "0 | 0" || targetValue === "0.00") {
    return JSON.stringify({ error: "This cell has a value of 0 — no rows to extract." });
  }

  // --- Batch dashboard reads into as few getRange calls as possible ---
  // Read row label (cols A+B) and q40 label in two calls total.
  const labelVals = activeSheet.getRange(targetRow, 1, 1, 2).getValues()[0];
  const rowLabel  = String(labelVals[0]).trim() || String(labelVals[1]).trim() || `Row ${targetRow}`;
  const colLabels = { 3: "Total (C)", 4: "Transfers (D)", 5: "Abandoned (E)", 7: "Avg Wait (G)" };
  const colLabel  = colLabels[targetCol] || `Col ${targetCol}`;

  const q40_name = String(activeSheet.getRange(40, 1).getValue()).trim().toLowerCase();

  // --- Single sheet read: display values only ---
  // getValues() is no longer needed — all logic fields are strings or coerce
  // cleanly from display values, and display values are required for output anyway.
  const rawSheet   = ss.getSheetByName("Raw Data");
  const rawDisplay = rawSheet.getDataRange().getDisplayValues();
  const headers    = rawDisplay.shift(); // removes and returns the header row

  // --- Config sets ---
  const csrRange   = ss.getRangeByName("csr_team").getValues();
  const csrTeamSet = new Set();
  csrRange.forEach(row => {
    if (row[0]) csrTeamSet.add(String(row[0]).split(",")[0].trim().toLowerCase());
  });

  const exceptionRange   = ss.getRangeByName("csr_exceptions");
  const csrExceptionsSet = new Set();
  if (exceptionRange) {
    exceptionRange.getValues().forEach(row => {
      if (row[0]) csrExceptionsSet.add(String(row[0]).split(",")[0].trim().toLowerCase());
    });
  }

  const steeringSet   = new Set();
  const steeringSheet = ss.getSheetByName("Steering Number");
  if (steeringSheet) {
    steeringSheet.getRange("B51:H51").getValues()[0].forEach(v => {
      if (v) steeringSet.add(String(v).trim().toLowerCase());
    });
  }

  // --- Row classification ---
  const parentMap = { 6:3, 9:8, 12:11, 16:15, 19:18, 22:21, 25:24, 29:28, 33:32, 46:45, 49:48 };

  let refRow = parentMap[targetRow] || targetRow;
  if (refRow === 48) refRow = 47;
  if (targetRow === 4) refRow = 3;
  if (targetRow === 5) refRow = 3;

  const targetQueue    = String(activeSheet.getRange(refRow, 1).getValue()).trim().toLowerCase();
  const isPrimaryRow   = [3, 8, 11, 15, 18, 21, 24, 28, 32, 39, 42, 45, 48].includes(targetRow);
  const isChildRow     = Object.keys(parentMap).map(Number).includes(targetRow);
  const isStat3Row     = [13, 26, 30].includes(targetRow);
  const isDnisRow      = [4, 43].includes(targetRow);
  const isGlobalExcRow = [34, 35, 36, 37, 40].includes(targetRow);

  // --- Parsing helpers (must stay in sync with CDR Pipeline v31) ---
  function simulateSplitCol2(val) {
    if (!val) return -1;
    let str   = String(val).trim();
    let parts = str.split(/\s+/);
    if (parts.length < 2) return -1;
    let timePart = parts[1];
    let ampm     = parts.length > 2 ? parts[2].toLowerCase() : "";
    let match    = timePart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
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
    let str   = String(val).trim();
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

  const time600AM  = 6 / 24, time630AM = 6.5 / 24, time300PM = 15 / 24, time330PM = 15.5 / 24;
  const time1Min   = 1 / 1440, time20Sec = 20 / 86400;

  // --- Main extraction loop (single pass over display values) ---
  const extractedRows = [];

  rawDisplay.forEach(dispRow => {
    // All fields now read directly from display values
    const status    = String(dispRow[1]).trim();
    const type      = String(dispRow[5]).trim().toLowerCase();
    const team      = String(dispRow[9]).trim().toLowerCase();
    const queueName = String(dispRow[11]).trim().toLowerCase();
    const dnisNum   = String(dispRow[16]).trim();
    const abandoned = String(dispRow[24]).trim().toLowerCase();
    const transfer  = String(dispRow[26]).trim().toLowerCase();

    const waitStr   = dispRow[7];
    const startDec  = simulateSplitCol2(dispRow[2]);
    const endDec    = simulateSplitCol2(dispRow[4]);
    const waitDec   = parseDurationDecimal(waitStr);
    const isColGPos = parseDurationDecimal(dispRow[6]) > 0;

    if (startDec <= time600AM || startDec === -1 || endDec === -1) return;

    const isCSR  = csrTeamSet.has(team);
    const isAQ   = (queueName === "a_q_csr" || queueName === "a_q_intake");
    const isCsrQ = csrTeamSet.has(queueName);
    const isExcQ = csrExceptionsSet.has(queueName);
    const is630to1500 = (startDec > time630AM && startDec < time300PM && endDec < time300PM);

    let includeRow = false;

    // Queue-based rows
    if (is630to1500 && queueName === targetQueue && !isGlobalExcRow) {

      if (isPrimaryRow && status === "1" && type === "internal" && isCSR) {
        if (targetCol === 3 && (transfer === "transfer" || (abandoned === "abandoned" && waitDec > time1Min))) includeRow = true;
        if (targetCol === 4 && transfer === "transfer") includeRow = true;
        if (targetCol === 5 && abandoned === "abandoned" && waitDec > time1Min) includeRow = true;
        if (targetCol === 7 && transfer === "transfer" && waitDec >= 0) includeRow = true;
      }

      if (isChildRow) {
        const is20sRow = [6, 9, 12, 16, 19, 22, 25, 29, 33].includes(targetRow);
        const is1mRow  = [46, 49].includes(targetRow);

        if (targetCol === 3 && status === "1" && type === "internal") {
          if (is20sRow) {
            if (isCSR  && abandoned === "abandoned" && waitDec > time20Sec && waitDec <= time1Min) includeRow = true;
            if (!isCSR && transfer === "transfer") includeRow = true;
            if (!isCSR && abandoned === "abandoned" && waitDec > time20Sec) includeRow = true;
          }
          if (is1mRow) {
            if (!isCSR && (transfer === "transfer" || (abandoned === "abandoned" && waitDec > time1Min))) includeRow = true;
          }
        }

        if (status === "1" && !isCSR) {
          if (targetCol === 4 && type === "internal" && transfer === "transfer") includeRow = true;
          if (targetCol === 5 && type === "internal" && abandoned === "abandoned") {
            if (targetRow === 6 && waitDec > time20Sec)  includeRow = true;
            if (targetRow !== 6 && waitDec > time1Min)   includeRow = true;
          }
          if (targetCol === 7 && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
        }
      }

      if (isStat3Row && status === "3") {
        if (targetCol === 3 && (transfer === "transfer" || (abandoned === "abandoned" && waitDec > time1Min))) includeRow = true;
        if (targetCol === 4 && transfer === "transfer") includeRow = true;
        if (targetCol === 5 && abandoned === "abandoned" && waitDec > time1Min) includeRow = true;
        if (targetCol === 7 && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
      }

      if (targetRow === 5 && status === "3" && dnisNum !== "18883645897") {
        if (targetCol === 3 && ((abandoned !== "abandoned" && waitDec >= 0) || (abandoned === "abandoned" && waitDec > time1Min))) includeRow = true;
        if (targetCol === 4 && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
        if (targetCol === 5 && abandoned === "abandoned" && waitDec > time1Min) includeRow = true;
        if (targetCol === 7 && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
      }

      if (isDnisRow && targetRow === 4 && dnisNum === "18883645897") {
        if (targetCol === 3 && (abandoned !== "abandoned" || (abandoned === "abandoned" && waitDec > time20Sec))) includeRow = true;
        if (targetCol === 4 && abandoned !== "abandoned") includeRow = true;
        if (targetCol === 5 && abandoned === "abandoned" && waitDec > time20Sec) includeRow = true;
        if (targetCol === 7 && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
      }

      if (isDnisRow && targetRow === 43 && dnisNum === "18667759594") {
        if (targetCol === 3 && (abandoned !== "abandoned" || (abandoned === "abandoned" && waitDec > time20Sec))) includeRow = true;
        if (targetCol === 4 && abandoned !== "abandoned") includeRow = true;
        if (targetCol === 5 && abandoned === "abandoned" && waitDec > time20Sec) includeRow = true;
        if (targetCol === 7 && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
      }
    }

    // Global exception rows
    if (targetRow === 34 && startDec > time600AM && startDec < time300PM &&
        abandoned === "abandoned" && !steeringSet.has(team) && isAQ) {
      if (targetCol === 5 && waitDec > time1Min) includeRow = true;
    }

    if (targetRow === 35) {
      const p1  = startDec > time600AM && startDec < time300PM && endDec < time300PM && isAQ && status === "3" && abandoned === "abandoned" && waitDec > time1Min;
      const p2  = startDec > time600AM && startDec < time300PM && endDec < time330PM && type === "incoming" && status === "4" && isCsrQ;
      const p3  = startDec > time600AM && startDec < time300PM && endDec < time330PM && type === "incoming" && status === "5" && isExcQ;
      const dp2 = startDec > time600AM && endDec < time330PM   && type === "incoming" && status === "4" && isCsrQ;
      const dp3 = startDec > time600AM && endDec < time330PM   && type === "incoming" && status === "5" && isExcQ;
      const e1  = startDec > time600AM && startDec < time300PM && isAQ && status === "3" && abandoned === "abandoned" && waitDec > time1Min;

      if (targetCol === 3 && (p1 || p2 || p3))  includeRow = true;
      if (targetCol === 4 && (dp2 || dp3))        includeRow = true;
      if (targetCol === 5 && e1)                  includeRow = true;
      if (targetCol === 7 && startDec > time600AM && startDec < time300PM && endDec < time300PM && isAQ && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
    }

    if (targetRow === 36) {
      const p1  = startDec > time600AM && startDec < time300PM && isAQ && type !== "internal" && status !== "3" && abandoned === "abandoned" && waitDec > time1Min;
      const p2  = startDec > time600AM && startDec < time330PM && type === "incoming" && isColGPos && status !== "4" && isCsrQ && !isExcQ;
      const p3  = startDec > time600AM && startDec < time330PM && type === "incoming" && isColGPos && status !== "4" && status !== "5" && isExcQ;
      const dp2 = startDec > time600AM && endDec < time330PM   && type === "incoming" && isColGPos && status !== "4" && isCsrQ && !isExcQ;
      const dp3 = startDec > time600AM && endDec < time330PM   && type === "incoming" && isColGPos && status !== "4" && status !== "5" && isExcQ;

      if (targetCol === 3 && (p1 || p2 || p3))  includeRow = true;
      if (targetCol === 4 && (dp2 || dp3))        includeRow = true;
      if (targetCol === 5 && p1)                  includeRow = true;
      if (targetCol === 7 && startDec > time600AM && startDec < time300PM && endDec < time300PM && queueName === "a_q_csr" && type === "incoming" && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
    }

    if (targetRow === 37) {
      const p1  = startDec > time600AM && startDec < time300PM && endDec < time300PM && isAQ && type === "internal" && abandoned === "abandoned" && waitDec > time1Min && !isCSR;
      const p3  = startDec > time600AM && startDec < time300PM && endDec < time300PM && type === "internal" && isColGPos && isCsrQ && !isCSR;
      const e1m = startDec > time600AM && startDec < time300PM && endDec < time300PM && isAQ && type === "internal" && abandoned === "abandoned" && waitDec > time1Min;

      if (targetCol === 3 && (p1 || p3))  includeRow = true;
      if (targetCol === 4 && p3)           includeRow = true;
      if (targetCol === 5 && e1m)          includeRow = true;
      if (targetCol === 7 && startDec > time600AM && startDec < time300PM && endDec < time300PM && queueName === "a_q_csr" && type === "internal" && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
    }

    if (targetRow === 40 && is630to1500 && queueName === q40_name) {
      const isRow39Match = (status === "1" && type === "internal" && isCSR);
      const t1 = (status === "1" && type === "internal"  && transfer === "transfer");
      const t2 = (status === "1" && type === "internal"  && abandoned === "abandoned" && waitDec > 0);
      const t3 = (status !== "1" && type === "incoming"  && transfer === "transfer");
      const t4 = (status !== "1" && type === "incoming"  && abandoned === "abandoned" && waitDec > 0);
      const t5 = (status === "1" && type === "internal"  && abandoned === "abandoned" && waitDec > time1Min);
      const t6 = (status !== "1" && type === "incoming"  && abandoned === "abandoned" && waitDec > time1Min);

      if (targetCol === 3 && (t1 || t2 || t3 || t4) && !(isRow39Match && (transfer === "transfer" || (abandoned === "abandoned" && waitDec > time1Min)))) includeRow = true;
      if (targetCol === 4 && (t1 || t3) && !(isRow39Match && transfer === "transfer")) includeRow = true;
      if (targetCol === 5 && (t5 || t6) && !(isRow39Match && abandoned === "abandoned" && waitDec > time1Min)) includeRow = true;
      if (targetCol === 7 && !isCSR && abandoned !== "abandoned" && waitDec >= 0) includeRow = true;
    }

    if (includeRow) extractedRows.push(dispRow);
  });

  if (extractedRows.length === 0) {
    return JSON.stringify({ error: "No matching rows found. This cell's logic may not yet be supported by the Extraction Tool." });
  }

  return JSON.stringify({
    headers: headers,
    rows:    extractedRows,
    context: {
      rowLabel:       rowLabel,
      colLabel:       colLabel,
      dashboardValue: targetValue,
      isAverage:      targetCol === 7
    }
  });
}