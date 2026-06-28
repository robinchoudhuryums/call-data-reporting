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
    // No-ops used by the cdr-report write path (formatting + sort are
    // cosmetic; tests read values back and filter by key rather than
    // relying on row order).
    setNumberFormat: function () { return this; },
    sort: function () { return this; },
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
    getRange: function (startRow, startCol, numRows, numCols) {
      return makeFakeRange(this, startRow, startCol, numRows, numCols);
    },
    appendRow: function (row) { this._data.push(row.slice()); return this; },
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
