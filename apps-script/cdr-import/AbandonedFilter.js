/**
 * The Core Filter Engine mapped to the NEW CDR Import columns.
 */
function applyAbandonedFilter(departmentNames, waitThresholdStr) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const range = sheet.getDataRange();

  // Remove existing filters to start fresh
  if (sheet.getFilter()) sheet.getFilter().remove();
  const filter = range.createFilter();

  // --- NEW CDR COLUMN MAPPING ---
  const colQueue = 12;    // Column L: Callee Name / Queue Name
  const colWaitTime = 8;  // Column H: Wait Time
  const colAbandoned = 25; // Column Y: Abandoned Status

  // 1. Filter Y = "Abandoned" (Handles potential case variations)
  filter.setColumnFilterCriteria(colAbandoned, SpreadsheetApp.newFilterCriteria()
    .whenTextEqualTo("Abandoned")
    .build());

  // 2. Hide all queues EXCEPT the target departmentNames (Case-Insensitive)
  const targetQueuesLower = departmentNames.map(d => String(d).toLowerCase());
  
  const allValues = sheet.getRange(2, colQueue, sheet.getLastRow() - 1).getValues()
    .flat()
    .filter(String) // remove empty
    .filter((v, i, a) => a.indexOf(v) === i); // get unique values

  // Find which actual sheet values don't match our target list
  const toHide = allValues.filter(v => !targetQueuesLower.includes(String(v).toLowerCase()));

  if (toHide.length > 0) {
    filter.setColumnFilterCriteria(colQueue, SpreadsheetApp.newFilterCriteria()
      .setHiddenValues(toHide)
      .build());
  }

  // 3. Filter H (Wait Time) > threshold
  const threshold = timeToDecimal(waitThresholdStr);
  filter.setColumnFilterCriteria(colWaitTime, SpreadsheetApp.newFilterCriteria()
    .whenNumberGreaterThan(threshold)
    .build());
}

// -------------------------------------------------------------------------
// SPECIFIC FILTER TRIGGERS
// -------------------------------------------------------------------------

function filterCSRAbandoned() { applyAbandonedFilter(["A_Q_CSR", "A_Q_Intake"], "0:00:59"); }
function filterPowerAbandoned() { applyAbandonedFilter(["A_Q_PowerChairs"], "0:00:59"); }
function filterManualMobilityAbandoned() { applyAbandonedFilter(["A_Q_Manual_Mobility"], "0:00:59"); }
function filterResupplyAbandoned() { applyAbandonedFilter(["A_Q_Resupply"], "0:00:59"); }
function filterBillingAbandoned() { applyAbandonedFilter(["A_Q_Billing"], "0:00:59"); }
function filterServiceAbandoned() { applyAbandonedFilter(["A_Q_Service"], "0:00:59"); }
function filterFieldOpsAbandoned() { applyAbandonedFilter(["A_Q_FieldOps"], "0:00:59"); }
function filterFOPAbandoned() { applyAbandonedFilter(["A_Q_FieldOps_Power"], "0:00:59"); }
function filterSalesAbandoned() { applyAbandonedFilter(["A_Q_Sales"], "0:00:19"); }
function filterEligibilityMMRAbandoned() { applyAbandonedFilter(["A_Q_Eligibility_MM&R"], "0:00:59"); }
function filterDenialsAbandoned() { applyAbandonedFilter(["A_Q_Denials"], "0:00:59"); }
function filterSpanishAbandoned() { applyAbandonedFilter(["A_Q_Spanish"], "0:00:59"); }
function filterPAKAbandoned() { applyAbandonedFilter(["A_Q_PAK"], "0:00:59"); }
function filterPAPAbandoned() { applyAbandonedFilter(["A_Q_PAP"], "0:00:19"); }

function clearAllFilters() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (sheet.getFilter()) sheet.getFilter().remove();
}

// -------------------------------------------------------------------------
// HELPER FUNCTION
// -------------------------------------------------------------------------

/**
 * Safely converts a time string (e.g., "0:00:59") into a spreadsheet decimal.
 */
function timeToDecimal(timeStr) {
  if (!timeStr) return 0;
  const parts = String(timeStr).trim().split(':');
  let h = 0, m = 0, s = 0;
  
  if (parts.length === 3) {
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
    s = parseInt(parts[2], 10);
  } else if (parts.length === 2) {
    m = parseInt(parts[0], 10);
    s = parseInt(parts[1], 10);
  }
  
  return (h / 24) + (m / 1440) + (s / 86400);
}
// =========================================================================
// AF-1 (owner request 2026-10-05): ONE "Filter abandoned calls…" dialog in
// place of the fourteen per-queue menu items above.
//
// The fourteen items stay on the menu until the owner has checked the dialog
// side by side with them on a real tab (Regression Scenario S55); retiring
// them -- items AND wrappers -- is the next step, and the dialog's Transfers
// mode (transferFilter.js) comes after that.
//
// What it filters, the old engine's rule exactly:
//   Abandoned (col Y) = "Abandoned"            (case-insensitive)
//   queue name (col L) is a ticked queue       (case-insensitive)
//   call time (col H) is MORE THAN that queue's threshold
// as ONE custom-formula criterion, so ticked queues can carry different
// thresholds (Sales and PAP 19 s beside everyone else's 59 s), plus an
// optional work-window clause (the pipeline's own INV-06 / R49 floor per
// queue). The thresholds are this tool's own: the pipeline's QCD rule is
// "more than 60 s" and the two differ by one second ON PURPOSE (autoImport.js,
// row 40) -- do not "sync" them.
//
// AF_PRESETS_ carries today's fourteen items verbatim (queues + threshold,
// and the wrapper each one replaces); abandoned-filter.test.js runs every old
// wrapper through the OLD engine and fails if a preset stops matching it.
// =========================================================================

var AF_DEFAULT_THRESHOLD_SEC_ = 59;
var AF_MAX_QUEUES_ = 60;
var AF_COL_ = { START: 3, CALL_TIME: 8, QUEUE: 12, ABANDONED: 25 };   // 1-based, as above

var AF_PRESETS_ = [
  { id: 'csr',       label: 'CSR',              fn: 'filterCSRAbandoned',            queues: ['A_Q_CSR', 'A_Q_Intake'], threshold: '0:00:59', backup: ['Backup CSR'] },
  { id: 'power',     label: 'Power',            fn: 'filterPowerAbandoned',          queues: ['A_Q_PowerChairs'],        threshold: '0:00:59' },
  { id: 'mm',        label: 'Manual Mobility',  fn: 'filterManualMobilityAbandoned', queues: ['A_Q_Manual_Mobility'],    threshold: '0:00:59' },
  { id: 'resupply',  label: 'Resupply',         fn: 'filterResupplyAbandoned',       queues: ['A_Q_Resupply'],           threshold: '0:00:59' },
  { id: 'billing',   label: 'Billing',          fn: 'filterBillingAbandoned',        queues: ['A_Q_Billing'],            threshold: '0:00:59' },
  { id: 'service',   label: 'Service',          fn: 'filterServiceAbandoned',        queues: ['A_Q_Service'],            threshold: '0:00:59' },
  { id: 'fieldops',  label: 'Field Ops',        fn: 'filterFieldOpsAbandoned',       queues: ['A_Q_FieldOps'],           threshold: '0:00:59', backup: ['A_Q_BackUp_FieldOps'] },
  { id: 'fop',       label: 'Field Ops Power',  fn: 'filterFOPAbandoned',            queues: ['A_Q_FieldOps_Power'],     threshold: '0:00:59' },
  { id: 'sales',     label: 'Sales',            fn: 'filterSalesAbandoned',          queues: ['A_Q_Sales'],              threshold: '0:00:19' },
  { id: 'elig',      label: 'Eligibility MM&R', fn: 'filterEligibilityMMRAbandoned', queues: ['A_Q_Eligibility_MM&R'],   threshold: '0:00:59' },
  { id: 'denials',   label: 'Denials',          fn: 'filterDenialsAbandoned',        queues: ['A_Q_Denials'],            threshold: '0:00:59' },
  { id: 'spanish',   label: 'Spanish',          fn: 'filterSpanishAbandoned',        queues: ['A_Q_Spanish'],            threshold: '0:00:59' },
  { id: 'pak',       label: 'PAK',              fn: 'filterPAKAbandoned',            queues: ['A_Q_PAK'],                threshold: '0:00:59' },
  { id: 'pap',       label: 'PAP',              fn: 'filterPAPAbandoned',            queues: ['A_Q_PAP'],                threshold: '0:00:19' }
];

/** PURE. "0:00:59" -> 59 (whole seconds; the old engine's timeToDecimal * 86400). */
function afThresholdSec_(str) {
  return Math.round(timeToDecimal(str) * 86400);
}

/** PURE. lower-cased queue name -> its preset's default threshold (backup queues included). */
function afDefaultThresholds_() {
  var out = {};
  AF_PRESETS_.forEach(function (p) {
    var t = afThresholdSec_(p.threshold);
    p.queues.concat(p.backup || []).forEach(function (q) {
      var k = String(q).toLowerCase();
      if (!(k in out)) out[k] = t;
    });
  });
  return out;
}

/**
 * PURE. Validates a dialog request into {queues: [{name, thresholdSec}],
 * workWindow}. Throws a plain-language Error on anything malformed -- the
 * values end up inside a sheet formula.
 */
function afNormalizeSpec_(spec) {
  spec = spec || {};
  var list = Array.isArray(spec.queues) ? spec.queues : [];
  if (!list.length) throw new Error('Tick at least one queue.');
  if (list.length > AF_MAX_QUEUES_) throw new Error('Too many queues (' + list.length + '); the limit is ' + AF_MAX_QUEUES_ + '.');
  var seen = {}, out = [];
  list.forEach(function (q) {
    var name = String((q && q.name != null) ? q.name : '').trim();
    if (!name || name.length > 100) throw new Error('Invalid queue name: "' + name.slice(0, 40) + '".');
    var t = Number(q.thresholdSec);
    if (!isFinite(t) || t < 0 || t > 86399 || Math.floor(t) !== t) {
      throw new Error('Threshold for ' + name + ' must be a whole number of seconds (0-86399).');
    }
    var k = name.toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    out.push({ name: name, thresholdSec: t });
  });
  return { queues: out, workWindow: !!spec.workWindow };
}

// The work window for a leg delivered by `queueName`: the pipeline's own
// per-queue floor (R49, dqeWindowStartForQueue_) and INV-06 end.
function afWindowFor_(queueName) {
  var start = (typeof dqeWindowStartForQueue_ === 'function') ? dqeWindowStartForQueue_(queueName) : 6.5 * 3600;
  var end = (typeof DQE_WINDOW_END !== 'undefined') ? DQE_WINDOW_END : 15 * 3600;
  return { start: start, end: end };
}

/**
 * PURE. The one custom-formula criterion, written for data row 2 with
 * relative rows. The start time-of-day reads a Date cell or the CDR's
 * "MM/DD/YYYY HH:MM:SS" text; an unreadable one fails the window clause.
 */
function afBuildFormula_(spec) {
  var s = afNormalizeSpec_(spec);
  var col = function (n) {
    var a = '';
    while (n > 0) { var m = (n - 1) % 26; a = String.fromCharCode(65 + m) + a; n = Math.floor((n - 1) / 26); }
    return '$' + a + '2';
  };
  var Y = col(AF_COL_.ABANDONED), L = col(AF_COL_.QUEUE), H = col(AF_COL_.CALL_TIME), C = col(AF_COL_.START);
  // Whole seconds, as the pipeline compares them, so an edge leg cannot flip
  // on floating point. (The call-time test keeps the old engine's exact
  // decimal comparison, for parity with the fourteen items.)
  var tod = 'ROUND(IFERROR(IF(ISNUMBER(' + C + '),MOD(' + C + ',1),TIMEVALUE(MID(' + C + ',FIND(" ",' + C + ')+1,8))),-1)*86400)';
  var arms = s.queues.map(function (q) {
    var parts = ['LOWER(' + L + ')="' + q.name.toLowerCase().replace(/"/g, '""') + '"',
                 H + '>' + q.thresholdSec + '/86400'];
    if (s.workWindow) {
      var w = afWindowFor_(q.name);
      parts.push(tod + '>=' + w.start, tod + '<' + w.end);
    }
    return 'AND(' + parts.join(',') + ')';
  });
  return '=AND(LOWER(' + Y + ')="abandoned",ISNUMBER(' + H + '),OR(' + arms.join(',') + '))';
}

/**
 * PURE mirror of the formula over DISPLAY rows (no header) -- the dialog's
 * expected row count, and what the parity test compares with the old engine.
 * Sheets evaluates the real formula; S55 is the side-by-side check of that.
 */
function afRowVisible_(row, spec) {
  var s = afNormalizeSpec_(spec);
  if (String(row[AF_COL_.ABANDONED - 1] == null ? '' : row[AF_COL_.ABANDONED - 1]).toLowerCase() !== 'abandoned') return false;
  var h = String(row[AF_COL_.CALL_TIME - 1] == null ? '' : row[AF_COL_.CALL_TIME - 1]).trim();
  if (!/^\d+:\d{2}:\d{2}$/.test(h)) return false;          // ISNUMBER: a duration cell
  var hSec = icTimeToSec_(h);
  var qn = String(row[AF_COL_.QUEUE - 1] == null ? '' : row[AF_COL_.QUEUE - 1]).toLowerCase();
  var m = /\s(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(row[AF_COL_.START - 1] == null ? '' : row[AF_COL_.START - 1]).trim());
  var tod = m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : -1;
  return s.queues.some(function (q) {
    if (qn !== q.name.toLowerCase() || !(hSec > q.thresholdSec)) return false;
    if (!s.workWindow) return true;
    var w = afWindowFor_(q.name);
    return tod >= w.start && tod < w.end;
  });
}

// ---- dialog entry points ---------------------------------------------------

/** Menu item: CDR Tools -> Abandoned Filters -> Filter abandoned calls… */
function showAbandonedFilterDialog() {
  var html = HtmlService.createHtmlOutputFromFile('AbandonedFilterDialog').setWidth(620).setHeight(660);
  SpreadsheetApp.getUi().showModalDialog(html, 'Filter abandoned calls');
}

/** PURE. Queue names on a tab (display rows, no header) with their abandoned-leg counts. */
function afTabQueues_(rows) {
  var by = {};
  (rows || []).forEach(function (r) {
    var q = String(r[AF_COL_.QUEUE - 1] == null ? '' : r[AF_COL_.QUEUE - 1]).trim();
    if (!q || !icIsQueueName_(q)) return;
    var e = by[q] = by[q] || { name: q, legs: 0, abandoned: 0 };
    e.legs++;
    if (String(r[AF_COL_.ABANDONED - 1] == null ? '' : r[AF_COL_.ABANDONED - 1]).toLowerCase() === 'abandoned') e.abandoned++;
  });
  return Object.keys(by).sort().map(function (k) { return by[k]; });
}

function afActiveRows_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var last = sheet.getLastRow();
  if (sheet.getLastColumn() < AF_COL_.ABANDONED) {
    throw new Error('"' + sheet.getName() + '" has fewer than ' + AF_COL_.ABANDONED + ' columns -- open a Call_Legs tab first.');
  }
  var rows = last >= 2 ? sheet.getRange(2, 1, last - 1, AF_COL_.ABANDONED).getDisplayValues() : [];
  return { sheet: sheet, rows: rows };
}

/** Dialog init: the active tab, the presets and the queues found on it. */
function afGetDialogState() {
  try { icLoadConfiguredQueueNames_(); } catch (e) { /* patterns still recognize A_Q_* / Backup CSR */ }
  var a = afActiveRows_();
  var w = afWindowFor_(null), early = (typeof DQE_EARLY_QUEUES !== 'undefined') ? DQE_EARLY_QUEUES : [];
  return {
    sheetName: a.sheet.getName(),
    isCallLegs: /^Call_Legs_\d{4}-\d{2}-\d{2}$/i.test(a.sheet.getName()),
    presets: AF_PRESETS_.map(function (p) {
      return { id: p.id, label: p.label, queues: p.queues.slice(), backup: (p.backup || []).slice(),
               thresholdSec: afThresholdSec_(p.threshold) };
    }),
    defaults: afDefaultThresholds_(),
    defaultThresholdSec: AF_DEFAULT_THRESHOLD_SEC_,
    tabQueues: afTabQueues_(a.rows),
    window: { start: w.start, end: w.end, earlyQueues: early.slice() }
  };
}

/** Dialog apply: replaces the active tab's filter with the one criterion. */
function afApplyFromDialog(spec) {
  var s = afNormalizeSpec_(spec);
  var formula = afBuildFormula_(s);
  var a = afActiveRows_();
  if (a.sheet.getFilter()) a.sheet.getFilter().remove();
  var filter = a.sheet.getDataRange().createFilter();
  filter.setColumnFilterCriteria(1, SpreadsheetApp.newFilterCriteria().whenFormulaSatisfied(formula).build());
  var expected = a.rows.filter(function (r) { return afRowVisible_(r, s); }).length;
  return { sheetName: a.sheet.getName(), expected: expected, total: a.rows.length, queues: s.queues.length };
}

/** Dialog: Clear filter (the menu's own Clear Filters, callable from the dialog). */
function afClearFromDialog() {
  clearAllFilters();
  return { cleared: true };
}
