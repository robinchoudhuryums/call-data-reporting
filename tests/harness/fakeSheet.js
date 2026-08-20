'use strict';

/**
 * Minimal in-memory fakes for the SpreadsheetApp surface the dashboard
 * .gs files actually touch: getSheetByName / getSpreadsheetTimeZone on
 * the spreadsheet, and getLastRow / getLastColumn / getRange /
 * appendRow on a sheet, with getValues / getDisplayValues / setValues
 * on a range.
 *
 * A sheet's `data` is the FULL 2-D grid INCLUDING the header row (row
 * 1), matching how the real code reads it (`getRange(2, 1, lastRow-1,
 * n)` to skip the header). Short rows are right-padded with '' to the
 * requested width so positional reads never see `undefined`.
 */

function sliceGrid(grid, startRow, startCol, numRows, numCols) {
  const out = [];
  for (let r = 0; r < numRows; r++) {
    const srcRow = grid[startRow - 1 + r] || [];
    const row = [];
    for (let c = 0; c < numCols; c++) {
      const v = srcRow[startCol - 1 + c];
      row.push(v === undefined ? '' : v);
    }
    out.push(row);
  }
  return out;
}

function makeFakeRange(sheet, startRow, startCol, numRows, numCols) {
  numRows = numRows || 1;   // 2-arg getRange(row, col) = single cell
  numCols = numCols || 1;
  return {
    getValues: function () {
      return sliceGrid(sheet._data, startRow, startCol, numRows, numCols);
    },
    getValue: function () { return this.getValues()[0][0]; },
    setValue: function (v) { return this.setValues([[v]]); },
    getA1Notation: function () {
      // Single-cell form is all the tests need (appendRosterEntry_).
      let n = startCol, letters = '';
      while (n > 0) { letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters; n = Math.floor((n - 1) / 26); }
      return letters + startRow;
    },
    getDisplayValues: function () {
      // Honor an explicit display grid if the fixture supplied one
      // (needed to model the TZ-offset duration columns, INV-02 --
      // where getValue() returns a TZ-shifted Date but getDisplayValue()
      // returns the correct "H:MM:SS" string); otherwise stringify the
      // underlying values.
      if (sheet._displays) {
        return sliceGrid(sheet._displays, startRow, startCol, numRows, numCols);
      }
      return this.getValues().map(function (row) {
        return row.map(function (v) { return v === '' ? '' : String(v); });
      });
    },
    setValues: function (vals) {
      for (let r = 0; r < vals.length; r++) {
        const tgt = startRow - 1 + r;
        if (!sheet._data[tgt]) sheet._data[tgt] = [];
        for (let c = 0; c < vals[r].length; c++) {
          sheet._data[tgt][startCol - 1 + c] = vals[r][c];
        }
      }
      return this;
    },
    // F-6: setNumberFormat RECORDS onto the sheet instead of no-opping.
    // The plain-text ('@') formats are the repo's primary defense against
    // the comma-joined cell coercion class (CLAUDE.md's largest gotcha) --
    // with a no-op here, deleting every protection passed all tests. Tests
    // assert coverage via sheet._numberFormats. Sort stays a no-op (tests
    // filter by key rather than relying on row order).
    setNumberFormat: function (fmt) {
      if (!sheet._numberFormats) sheet._numberFormats = [];
      sheet._numberFormats.push({ startRow: startRow, startCol: startCol,
        numRows: numRows, numCols: numCols, format: fmt });
      return this;
    },
    sort: function () { return this; },
    // Blanks the range's cells, leaving the rows in place -- the real
    // Range.clearContent. NOT a no-op: the deferred Neon mirror's queue
    // rewrite is clearContent-then-setValues, so a no-op here would leave
    // drained dates in the fixture and make a shrinking queue untestable
    // (the F-6 discipline -- model the method, never stub it away).
    clearContent: function () {
      for (let r = 0; r < numRows; r++) {
        const tgt = startRow - 1 + r;
        if (!sheet._data[tgt]) continue;
        for (let c = 0; c < numCols; c++) sheet._data[tgt][startCol - 1 + c] = '';
      }
      return this;
    },
    // Cosmetic no-ops (Setup.gs header styling).
    setFontWeight: function () { return this; },
    setBackground: function () { return this; },
  };
}

/**
 * `data` is either a 2-D values grid (display = stringified values) or
 * `{ values: [[...]], displays: [[...]] }` to model the duration
 * columns whose getValue() ≠ getDisplayValue() (INV-02). Both grids
 * include the header row at index 0.
 */
function makeFakeSheet(name, data) {
  const hasDisplays = data && !Array.isArray(data) && data.values;
  const values = hasDisplays ? data.values : (data || []);
  const sheet = {
    _data: values.map(function (row) { return row.slice(); }),
    _displays: hasDisplays && data.displays
      ? data.displays.map(function (row) { return row.slice(); })
      : null,
    _parent: null,   // set by makeFakeSpreadsheet
    getName: function () { return name; },
    getParent: function () { return this._parent; },
    getLastRow: function () { return this._data.length; },
    getLastColumn: function () {
      return this._data.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    },
    getMaxRows: function () { return Math.max(this._data.length, 1000); },
    // Grid WIDTH, distinct from getLastColumn (the last column with content).
    // Real Sheets throws on a getRange past getMaxColumns -- it does NOT
    // auto-expand columns the way it does rows -- which is why writers that
    // added a column widen the sheet first. `_maxColumns` lets a test pin the
    // narrow-sheet case; otherwise the grid is treated as wide enough for the
    // data it holds, with a floor matching a default new sheet.
    getMaxColumns: function () {
      if (this._maxColumns != null) return this._maxColumns;
      return Math.max(this.getLastColumn(), 26);
    },
    insertColumnsAfter: function (afterPosition, howMany) {
      const target = Math.max(this.getMaxColumns(), afterPosition + (howMany || 1));
      this._maxColumns = target;
      return this;
    },
    getRange: function (startRow, startCol, numRows, numCols) {
      // F-5: real Sheets THROWS on a getRange past getMaxColumns (columns
      // never auto-expand -- the REP-10 production failure class). Without
      // this, deleting a writer's widen-before-write step passed every test.
      // Column-only on purpose: rows DO effectively auto-grow in the code
      // paths under test (appendRow / getMaxRows floor), and the documented
      // incident class is columns.
      const endCol = (startCol || 1) + ((numCols || 1) - 1);
      if (endCol > this.getMaxColumns()) {
        throw new Error('The coordinates or dimensions of the range are invalid. '
          + '(range ends at column ' + endCol + ' but the sheet has '
          + this.getMaxColumns() + ' -- widen the sheet first, REP-10)');
      }
      return makeFakeRange(this, startRow, startCol, numRows, numCols);
    },
    appendRow: function (row) { this._data.push(row.slice()); return this; },
    // Cosmetic no-ops (Setup.gs).
    setFrozenRows: function () { return this; },
    autoResizeColumns: function () { return this; },
    // 1-based row delete (matches SpreadsheetApp). Splices the backing grid;
    // the header is row 1, data rows are 2..N.
    deleteRow: function (rowPosition) {
      const idx = rowPosition - 1;
      if (idx >= 0 && idx < this._data.length) this._data.splice(idx, 1);
      return this;
    },
  };
  return sheet;
}

/**
 * makeFakeSpreadsheet({ timeZone, sheets: { 'Sheet Name': [[...],[...]] } })
 * `sheets` maps a sheet name to its full grid (header row included).
 */
function makeFakeSpreadsheet(opts) {
  opts = opts || {};
  const tz = opts.timeZone || 'America/Chicago';
  const sheetMap = {};
  const ss = {
    getSpreadsheetTimeZone: function () { return tz; },
    getSheetByName: function (name) { return sheetMap[name] || null; },
    // E1: real Spreadsheet method, modelled not stubbed (the clearContent
    // discipline) -- ncSurvivingCallLegsDates_ enumerates Call_Legs_* tabs.
    getSheets: function () {
      return Object.keys(sheetMap).map(function (n) { return sheetMap[n]; });
    },
    insertSheet: function (name) {
      const s = makeFakeSheet(name, []);
      s._parent = this;
      sheetMap[name] = s;
      return s;
    },
    _sheet: function (name) { return sheetMap[name] || null; },
  };
  Object.keys(opts.sheets || {}).forEach(function (name) {
    const s = makeFakeSheet(name, opts.sheets[name]);
    s._parent = ss;   // so sheet.getParent() resolves (logPipelineHealth_, buildQueueNameToExts_)
    sheetMap[name] = s;
  });
  return ss;
}

module.exports = { makeFakeSpreadsheet, makeFakeSheet };
