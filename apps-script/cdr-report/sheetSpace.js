/**
 * Workbook cell-space tooling (R47, 2026-09-14). Read-only audit + a
 * refuse-by-default grid trim, plus the numbers behind the dashboard Health
 * page's `workbook-cells` row.
 *
 * WHY. Google counts a spreadsheet's ALLOCATED grid -- getMaxRows() x
 * getMaxColumns() on every tab -- against the 10,000,000-cell cap, NOT the
 * cells that hold data. An oversized grid therefore costs exactly as much as
 * a full one, and nothing in this stack measured it. The CDR Report workbook
 * reached 9,983,599 of 10,000,000 and the daily import's Direct Call History
 * write failed with "This action would increase the number of cells in the
 * workbook above the limit of 10000000 cells" -- an outage with no prior
 * warning. 36.7% of the entire cap was one tab, `QCDR Output`, holding a
 * 49x24 report inside a 12,607x291 grid.
 *
 * WHAT IS SAFE TO TRIM. Shrinking a grid deletes no values, but three things
 * can reach past the used range and they are NOT equivalent:
 *   - a NAMED RANGE: truncating one silently changes what every reader of it
 *     sees (the roster named ranges here run to row 1000 over 47 used rows),
 *     so the planner REFUSES rather than trims;
 *   - a WRITER's reach: `updateQcdrOutputSheet` clears
 *     getRange(2, 10, max(agents + 20, 100), 15) regardless of how few agents
 *     exist, so a trim to the 49 used rows would turn a space outage into a
 *     daily-import outage. A writer's reach cannot be derived from the sheet
 *     -- it is why the per-tab bounds below are hand-set and commented;
 *   - protections / conditional formatting / charts shrink harmlessly with
 *     the grid, so they are reported and never block.
 *
 * Preview-then-apply, per the sheetRepairs.js convention: every `preview*`
 * mutates nothing. No 1b snapshot -- a grid trim removes empty capacity, not
 * cells; take a File > Make a copy before a large one anyway.
 *
 * Operator State #62. Pinned by tests/unit/sheet-space.test.js (the planner)
 * and tests/unit/system-health.test.js (the Health row).
 */

var WORKBOOK_CELL_CAP_        = 10000000;   // Google's hard per-spreadsheet limit
var WORKBOOK_CELL_WARN_PCT_   = 80;         // Health row goes warn at/above this

/**
 * Per-tab keep bounds for `trimGrid`. Hand-set, because a WRITER's reach is
 * not derivable from the grid -- each entry names what it had to clear.
 * A tab absent here has no vetted bounds and must be passed explicitly.
 */
var SHEET_SPACE_TARGETS_ = Object.freeze({
  // Widest reach in code is row 101 / col 24: updateQcdrOutputSheet clears
  // getRange(2, 10, max(agents + 20, 100), 15); calcQcdReport reads A2:B49
  // and row 40; calcCsrReport reads N1:X1. 200x30 clears all of it and holds
  // a CSR team up to 179 agents. Verified 2026-09-14: no named ranges, no
  // formula references anywhere in the workbook, no protections/charts/CF.
  'QCDR Output':        { rows: 200, cols: 30 },
  // PDF export ranges B4:I70 and A83:O105, date cells B1 / B80, content to
  // row 111 col O, 13 conditional-format rules all inside rows 1-93 cols C-G.
  // Verified 2026-09-14: no named ranges, no formula references.
  'Daily Queue Report': { rows: 400, cols: 20 },
});

/**
 * PURE. One tab's trim decision.
 *
 * @param {Object} e  { name, maxRows, maxCols, lastRow, lastCol,
 *                      namedMaxRow, namedMaxCol, namedBy }
 * @param {number} keepRows
 * @param {number} keepCols
 * @return {Object} { name, before, after, frees, refused, reason, needRows, needCols }
 */
function sheetSpacePlanOne_(e, keepRows, keepCols) {
  var needRows = Math.max(Number(e.lastRow) || 0, 1);
  var needCols = Math.max(Number(e.lastCol) || 0, 1);
  var why = 'existing data';
  if ((Number(e.namedMaxRow) || 0) > needRows) {
    needRows = Number(e.namedMaxRow); why = 'named range ' + (e.namedBy || '');
  }
  if ((Number(e.namedMaxCol) || 0) > needCols) {
    needCols = Number(e.namedMaxCol); why = 'named range ' + (e.namedBy || '');
  }
  var before = (Number(e.maxRows) || 0) * (Number(e.maxCols) || 0);
  var out = { name: e.name, before: before, needRows: needRows, needCols: needCols,
              refused: false, reason: '', after: before, frees: 0 };
  if (!(keepRows >= 1 && keepCols >= 1)) {
    out.refused = true; out.reason = 'keep bounds must be >= 1';
    return out;
  }
  if (keepRows < needRows || keepCols < needCols) {
    out.refused = true;
    out.reason = why.trim() + ' reaches ' + needRows + 'x' + needCols
      + ', past the keep bounds ' + keepRows + 'x' + keepCols;
    return out;
  }
  out.after = Math.min(Number(e.maxRows) || 0, keepRows) * Math.min(Number(e.maxCols) || 0, keepCols);
  out.frees = Math.max(0, before - out.after);
  return out;
}

/**
 * PURE. The Health row's verdict over a whole-workbook reading.
 * `entries` are { name, maxRows, maxCols, lastRow, lastCol }.
 */
function sheetSpaceVerdict_(entries, cap, warnPct) {
  cap = Number(cap) || WORKBOOK_CELL_CAP_;
  warnPct = Number(warnPct) || WORKBOOK_CELL_WARN_PCT_;
  var total = 0, worst = null;
  (entries || []).forEach(function (e) {
    var alloc = (Number(e.maxRows) || 0) * (Number(e.maxCols) || 0);
    var used  = Math.max(0, Number(e.lastRow) || 0) * Math.max(0, Number(e.lastCol) || 0);
    total += alloc;
    var waste = alloc - used;
    if (!worst || waste > worst.waste) worst = { name: e.name, waste: waste };
  });
  var pct = cap > 0 ? Math.round((total / cap) * 100) : 0;
  var value = total + ' of ' + cap + ' cells (' + pct + '%)';
  if (worst && worst.waste > 0) {
    value += ' · most reclaimable: ' + worst.name + ' ' + worst.waste;
  }
  return {
    total: total, pct: pct, worst: worst,
    status: pct >= warnPct ? 'warn' : 'ok',
    value: value,
  };
}

/** Live reading of every tab: the input both pure helpers above expect. */
function sheetSpaceEntries_(ss) {
  var named = {};
  ss.getNamedRanges().forEach(function (nr) {
    var r = nr.getRange();
    var id = r.getSheet().getSheetId();
    var cur = named[id] || { row: 0, col: 0, by: '' };
    if (r.getLastRow() > cur.row)    { cur.row = r.getLastRow(); cur.by = nr.getName(); }
    if (r.getLastColumn() > cur.col) { cur.col = r.getLastColumn(); cur.by = nr.getName(); }
    named[id] = cur;
  });
  return ss.getSheets().map(function (s) {
    var n = named[s.getSheetId()] || { row: 0, col: 0, by: '' };
    return {
      name: s.getName(), maxRows: s.getMaxRows(), maxCols: s.getMaxColumns(),
      lastRow: s.getLastRow(), lastCol: s.getLastColumn(),
      namedMaxRow: n.row, namedMaxCol: n.col, namedBy: n.by,
    };
  });
}

/** READ-ONLY. Logs every tab biggest-first plus the workbook total. */
function auditSheetSpace() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var entries = sheetSpaceEntries_(ss);
  var v = sheetSpaceVerdict_(entries, WORKBOOK_CELL_CAP_, WORKBOOK_CELL_WARN_PCT_);
  Logger.log('TOTAL allocated: ' + v.total + ' / ' + WORKBOOK_CELL_CAP_
    + '  (' + v.pct + '%, ' + (WORKBOOK_CELL_CAP_ - v.total) + ' free) -- ' + v.status);
  entries.slice().sort(function (a, b) {
    return (b.maxRows * b.maxCols) - (a.maxRows * a.maxCols);
  }).forEach(function (e) {
    var alloc = e.maxRows * e.maxCols;
    Logger.log(e.name + ' | grid ' + e.maxRows + 'x' + e.maxCols
      + ' | used ' + e.lastRow + 'x' + e.lastCol
      + ' | alloc ' + alloc + ' | reclaimable ' + (alloc - e.lastRow * e.lastCol)
      + (e.namedBy ? ' | named range to ' + e.namedMaxRow + 'x' + e.namedMaxCol : ''));
  });
  return v;
}

/**
 * Shrink ONE tab's grid. REFUSES when data or a named range reaches past the
 * keep bounds; protections / conditional formatting / charts are reported,
 * never blocking. `apply` omitted or false = preview.
 */
function trimGrid(name, keepRows, keepCols, apply) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(name);
  if (!s) throw new Error('trimGrid: no tab named "' + name + '"');
  var entry = sheetSpaceEntries_(ss).filter(function (e) { return e.name === name; })[0];
  var plan = sheetSpacePlanOne_(entry, keepRows, keepCols);

  Logger.log('--- ' + name + (apply ? '  [APPLY]' : '  [PREVIEW]') + ' ---');
  Logger.log('  grid now  : ' + entry.maxRows + 'x' + entry.maxCols + '  (' + plan.before + ' cells)');
  Logger.log('  must keep : ' + plan.needRows + 'x' + plan.needCols);
  Logger.log('  keeping   : ' + keepRows + 'x' + keepCols + '  (' + plan.after + ' cells)');
  Logger.log('  frees     : ' + plan.frees + ' cells');
  if (plan.refused) throw new Error(name + ': REFUSED -- ' + plan.reason);

  var prot = s.getProtections(SpreadsheetApp.ProtectionType.RANGE).length;
  var cf   = s.getConditionalFormatRules().length;
  var ch   = s.getCharts().length;
  if (prot || cf || ch) {
    Logger.log('  NOTE: ' + prot + ' protection(s), ' + cf + ' conditional-format rule(s), '
      + ch + ' chart(s) -- these shrink with the grid; eyeball the tab afterwards.');
  }
  // Return what WOULD be freed, not 0: `trimVettedGrids_` sums these into the
  // rollup line, and a preview that reports "0 cell(s) would be freed" under
  // per-tab lines each showing millions reads as "this trim is pointless" --
  // the opposite of the decision the preview exists to inform.
  if (!apply) { Logger.log('  (preview only -- nothing changed)'); return plan.frees; }

  if (s.getMaxRows() > keepRows)    s.deleteRows(keepRows + 1, s.getMaxRows() - keepRows);
  if (s.getMaxColumns() > keepCols) s.deleteColumns(keepCols + 1, s.getMaxColumns() - keepCols);
  SpreadsheetApp.flush();
  var freed = plan.before - (s.getMaxRows() * s.getMaxColumns());
  Logger.log('  DONE: freed ' + freed + ' cells; grid is now '
    + s.getMaxRows() + 'x' + s.getMaxColumns());
  return freed;
}

/** Every vetted tab in SHEET_SPACE_TARGETS_, preview or apply. */
function trimVettedGrids_(apply) {
  var freed = 0;
  Object.keys(SHEET_SPACE_TARGETS_).forEach(function (name) {
    var t = SHEET_SPACE_TARGETS_[name];
    try { freed += trimGrid(name, t.rows, t.cols, apply) || 0; }
    catch (e) { Logger.log('  ' + name + ': ' + (e && e.message ? e.message : e)); }
  });
  Logger.log((apply ? 'APPLIED' : 'PREVIEW') + ': ' + freed + ' cell(s)'
    + (apply ? ' freed' : ' would be freed'));
  return freed;
}

function previewTrimVettedGrids() { return trimVettedGrids_(false); }
function applyTrimVettedGrids()   { return trimVettedGrids_(true); }

/** READ-ONLY. Conditional-format rule ranges on a tab (run before trimming it). */
function showConditionalFormatRanges() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Conditional-format ranges', 'Tab name:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var name = String(resp.getResponseText() || '').trim();
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!s) { ui.alert('No tab named "' + name + '".'); return; }
  var rules = s.getConditionalFormatRules();
  var lines = rules.map(function (r, i) {
    return (i + 1) + ': ' + r.getRanges().map(function (g) { return g.getA1Notation(); }).join(', ');
  });
  Logger.log(name + ': ' + rules.length + ' rule(s)\n' + lines.join('\n'));
  ui.alert(name + ': ' + rules.length + ' conditional-format rule(s)',
    (lines.join('\n') || '(none)') + '\n\nAlso in the execution log.', ui.ButtonSet.OK);
}
