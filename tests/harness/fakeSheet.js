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

// Default rendering for a cell with no explicit display grid. A Date renders
// as "M/D/YYYY" -- what Sheets shows for an automatic-format date cell (en-US)
// and what every display-path reader (parseDateForNeon, the DQE build's dup
// guard via displayToDate) is written against. `String(date)` -- the old
// fallback -- is a rendering Sheets never produces; readers that resolved it
// through `new Date(s)` got a TZ-dependent answer that only held because CI
// pins TZ. Phase 1 made this load-bearing: the DQE build now writes col B as
// a Date, and its dup guard reads that cell back through the display path.
//
// R46: the day is rendered in the SPREADSHEET's timezone when the sheet has a
// parent, because that is what Sheets does -- a script-TZ-midnight instant in a
// spreadsheet one hour behind displays as the PREVIOUS day. The first Phase 1
// repair shifted 9,516 live rows exactly that way, and this fake (rendering in
// the process TZ, which CI pins to the script's) could not show it. Duck-typed
// on getTime(): vm-realm Dates fail `instanceof` against the host constructor.
const { formatDate } = require('./formatDate');

function fakeDisplay_(v, tz) {
  if (v === '') return '';
  if (v && typeof v.getTime === 'function' && !isNaN(v.getTime())) {
    if (tz) return formatDate(v, tz, 'M/d/yyyy');
    return (v.getMonth() + 1) + '/' + v.getDate() + '/' + v.getFullYear();
  }
  return String(v);
}

// HT-2: the real Range.setValues shape rule, with Sheets' own messages. Exported
// so a suite's hand-rolled range double enforces the SAME rule (the
// dashboard-cdr-core and inbound-export doubles do).
function assertSetValuesShape(vals, numRows, numCols) {
  if (!Array.isArray(vals) || vals.length !== numRows) {
    throw new Error('The number of rows in the data does not match the number of rows in the range. '
      + 'The data has ' + (Array.isArray(vals) ? vals.length : 0) + ' but the range has ' + numRows + '.');
  }
  for (let r = 0; r < vals.length; r++) {
    if (!Array.isArray(vals[r]) || vals[r].length !== numCols) {
      throw new Error('The number of columns in the data does not match the number of columns in the range. '
        + 'The data has ' + (Array.isArray(vals[r]) ? vals[r].length : 0) + ' but the range has ' + numCols + '.');
    }
  }
}

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
    // Real setValue writes the ONE value into EVERY cell of the range.
    setValue: function (v) {
      const grid = [];
      for (let r = 0; r < numRows; r++) { const row = []; for (let c = 0; c < numCols; c++) row.push(v); grid.push(row); }
      return this.setValues(grid);
    },
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
      const tz = (sheet._parent && typeof sheet._parent.getSpreadsheetTimeZone === 'function')
        ? sheet._parent.getSpreadsheetTimeZone() : null;
      return this.getValues().map(function (row) {
        return row.map(function (v) { return fakeDisplay_(v, tz); });
      });
    },
    // Phase 0b: the per-cell number format, served from an optional fixture
    // grid (`{ values, displays, formats }`), 'General' where none is given.
    // Read-only by design: it does NOT reflect setNumberFormat calls made in
    // the same test -- those are RECORDED on sheet._numberFormats (F-6) and a
    // writer test asserts against that record. A future round-trip test must
    // model the write-through here first, not assume it.
    getNumberFormats: function () {
      if (sheet._formats) {
        return sliceGrid(sheet._formats, startRow, startCol, numRows, numCols)
          .map(function (row) { return row.map(function (f) { return f === '' ? 'General' : f; }); });
      }
      return this.getValues().map(function (row) { return row.map(function () { return 'General'; }); });
    },
    getNumberFormat: function () { return this.getNumberFormats()[0][0]; },
    // HT-2 (broad-scan 2026-10-01): STRICT, like the real API. The grid must
    // be exactly the range's rows x columns -- every row, not just the first --
    // or it throws with Sheets' own message; the old fake wrote any shape, so a
    // writer whose range and payload disagreed (an off-by-one width, a ragged
    // row) passed every test and threw in production. The display grid, when
    // the fixture has one, is UPDATED for the written cells (the value's
    // default rendering), so a read-back through getDisplayValues sees the
    // write instead of the fixture's stale text.
    setValues: function (vals) {
      assertSetValuesShape(vals, numRows, numCols);
      const tz = (sheet._parent && typeof sheet._parent.getSpreadsheetTimeZone === 'function')
        ? sheet._parent.getSpreadsheetTimeZone() : null;
      for (let r = 0; r < vals.length; r++) {
        const tgt = startRow - 1 + r;
        if (!sheet._data[tgt]) sheet._data[tgt] = [];
        if (sheet._displays && !sheet._displays[tgt]) sheet._displays[tgt] = [];
        for (let c = 0; c < vals[r].length; c++) {
          sheet._data[tgt][startCol - 1 + c] = vals[r][c];
          if (sheet._displays) sheet._displays[tgt][startCol - 1 + c] = fakeDisplay_(vals[r][c], tz);
        }
      }
      return this;
    },
    // F-6: setNumberFormat RECORDS onto the sheet instead of no-opping.
    // The plain-text ('@') formats are the repo's primary defense against
    // the comma-joined cell coercion class (CLAUDE.md's largest gotcha) --
    // with a no-op here, deleting every protection passed all tests. Tests
    // assert coverage via sheet._numberFormats. Sort is MODELLED below
    // (Batch 4) -- tests that read rows by index after a sorting writer
    // should filter by key, as the row order now follows the sort.
    setNumberFormat: function (fmt) {
      if (!sheet._numberFormats) sheet._numberFormats = [];
      sheet._numberFormats.push({ startRow: startRow, startCol: startCol,
        numRows: numRows, numCols: numCols, format: fmt });
      return this;
    },
    // The per-cell twin (CR-3, broad-scan 2026-10-01): RECORDED the same way,
    // with the grid on `formats` -- a restore-the-original-formats path is
    // asserted against it. Shape-checked like the real API (a grid of the
    // range's size), so a wrong-sized restore throws here as it would live.
    setNumberFormats: function (grid) {
      if (!Array.isArray(grid) || grid.length !== numRows
          || grid.some(function (r) { return !Array.isArray(r) || r.length !== numCols; })) {
        throw new Error('setNumberFormats: the grid must be ' + numRows + 'x' + numCols);
      }
      if (!sheet._numberFormats) sheet._numberFormats = [];
      sheet._numberFormats.push({ startRow: startRow, startCol: startCol,
        numRows: numRows, numCols: numCols, format: '(per-cell)', formats: grid });
      return this;
    },
    // Batch 4 / Phase 2: MODELLED, not stubbed (the clearContent discipline).
    // Real Range.sort orders the range's rows by the given ABSOLUTE column,
    // numbers + Dates first (as numbers), then text, blanks last, stably;
    // the displays / formats grids move with their rows. `_sortCalls`
    // records every call; `_sortError` makes the next call throw (the
    // bulk-path "sort threw" class).
    sort: function (spec) {
      const specs = Array.isArray(spec) ? spec : [spec];
      const first = specs[0];
      const column = typeof first === 'number' ? first : Number(first && first.column);
      const ascending = (first && typeof first === 'object' && first.ascending === false) ? false : true;
      if (!sheet._sortCalls) sheet._sortCalls = [];
      sheet._sortCalls.push({ startRow: startRow, numRows: numRows, column: column, ascending: ascending });
      if (sheet._sortError) { const err = sheet._sortError; sheet._sortError = null; throw err; }
      const rank = function (v) {
        if (v === null || v === undefined || v === '') return { g: 2, k: 0 };
        if (v instanceof Date) return { g: 0, k: v.getTime() };
        if (typeof v === 'number') return { g: 0, k: v };
        return { g: 1, k: String(v) };
      };
      const idx = [];
      for (let r = 0; r < numRows; r++) idx.push(startRow - 1 + r);
      const keyed = idx.map(function (i, pos) {
        const row = sheet._data[i] || [];
        return { i: i, pos: pos, r: rank(row[column - 1]) };
      });
      keyed.sort(function (a, b) {
        if (a.r.g !== b.r.g) return a.r.g - b.r.g;            // blanks always last
        if (a.r.g === 2) return a.pos - b.pos;
        let c = a.r.k < b.r.k ? -1 : a.r.k > b.r.k ? 1 : 0;
        if (!ascending) c = -c;
        return c || (a.pos - b.pos);                             // stable
      });
      ['_data', '_displays', '_formats'].forEach(function (g) {
        if (!sheet[g]) return;
        const moved = keyed.map(function (k) { return sheet[g][k.i]; });
        keyed.forEach(function (k, pos) { sheet[g][idx[pos]] = moved[pos]; });
      });
      return this;
    },
    // Blanks the range's cells, leaving the rows in place -- the real
    // Range.clearContent. NOT a no-op: the deferred Neon mirror's queue
    // rewrite is clearContent-then-setValues, so a no-op here would leave
    // drained dates in the fixture and make a shrinking queue untestable
    // (the F-6 discipline -- model the method, never stub it away).
    clearContent: function () {
      for (let r = 0; r < numRows; r++) {
        const tgt = startRow - 1 + r;
        if (!sheet._data[tgt]) continue;
        for (let c = 0; c < numCols; c++) {
          sheet._data[tgt][startCol - 1 + c] = '';
          if (sheet._displays && sheet._displays[tgt]) sheet._displays[tgt][startCol - 1 + c] = '';   // HT-2
        }
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
 * `{ values: [[...]], displays: [[...]], formats: [[...]] }` to model the
 * duration columns whose getValue() ≠ getDisplayValue() (INV-02) and, since
 * Phase 0b, per-cell number formats for getNumberFormats(). All grids
 * include the header row at index 0; `formats` is optional.
 */
function makeFakeSheet(name, data) {
  const hasDisplays = data && !Array.isArray(data) && data.values;
  const values = hasDisplays ? data.values : (data || []);
  const sheet = {
    _data: values.map(function (row) { return row.slice(); }),
    _displays: hasDisplays && data.displays
      ? data.displays.map(function (row) { return row.slice(); })
      : null,
    _formats: hasDisplays && data.formats
      ? data.formats.map(function (row) { return row.slice(); })
      : null,
    _parent: null,   // set by makeFakeSpreadsheet
    _name: name,
    getName: function () { return this._name; },
    // Roadmap 1b: real Sheet methods, modelled not stubbed (the clearContent
    // discipline) -- the repair backup copies a sheet into another workbook
    // and names the copy; a no-op copy would make every backup pin vacuous.
    setName: function (newName) {
      if (this._parent && typeof this._parent._rename === 'function') this._parent._rename(this, newName);
      this._name = newName;
      return this;
    },
    copyTo: function (targetSs) {
      const copy = targetSs.insertSheet('Copy of ' + this._name);
      copy._data = this._data.map(function (row) { return row.slice(); });
      copy._displays = this._displays ? this._displays.map(function (row) { return row.slice(); }) : null;
      copy._formats = this._formats ? this._formats.map(function (row) { return row.slice(); }) : null;
      if (this._maxColumns != null) copy._maxColumns = this._maxColumns;
      if (this._maxRows != null) copy._maxRows = this._maxRows;
      return copy;
    },
    getParent: function () { return this._parent; },
    getLastRow: function () { return this._data.length; },
    getLastColumn: function () {
      return this._data.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    },
    // `_maxRows` lets a test pin the sheet's row capacity (R38: the
    // force-delete re-pads to its previous getMaxRows). Unset = the old
    // floor.
    getMaxRows: function () {
      if (this._maxRows != null) return this._maxRows;
      return Math.max(this._data.length, 1000);
    },
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
    // The used grid (rows x columns holding data), as the real API returns it;
    // an empty sheet yields the 1x1 A1 range like the real one.
    getDataRange: function () {
      return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
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
    appendRow: function (row) {
      // HT-2: keep a fixture's display grid row-aligned with the data, or the
      // appended row reads back as blanks through getDisplayValues.
      if (this._displays) {
        while (this._displays.length < this._data.length) this._displays.push([]);
        const tz = this._parent && typeof this._parent.getSpreadsheetTimeZone === 'function'
          ? this._parent.getSpreadsheetTimeZone() : null;
        this._displays.push(row.map(function (v) { return fakeDisplay_(v, tz); }));
      }
      this._data.push(row.slice());
      return this;
    },
    // Cosmetic no-ops (Setup.gs).
    setFrozenRows: function () { return this; },
    autoResizeColumns: function () { return this; },
    // 1-based row delete (matches SpreadsheetApp). Splices the backing grid;
    // the header is row 1, data rows are 2..N.
    deleteRow: function (rowPosition) {
      const idx = rowPosition - 1;
      if (idx >= 0 && idx < this._data.length) this._data.splice(idx, 1);
      if (this._displays && idx >= 0 && idx < this._displays.length) this._displays.splice(idx, 1);
      if (this._formats && idx >= 0 && idx < this._formats.length) this._formats.splice(idx, 1);
      if (this._maxRows != null) this._maxRows--;
      return this;
    },
    // 1-based contiguous delete (R38). Throws past the grid like Sheets does.
    // Real Sheets deletes up to getMaxRows() -- BLANK capacity rows included
    // (the Neon backup's Sheets store trims every tab to its exact size, the
    // #62 allocated-cells budget). Past the grid still throws.
    deleteRows: function (rowPosition, howMany) {
      const idx = rowPosition - 1;
      const maxRows = this.getMaxRows();
      if (idx < 0 || idx + howMany > maxRows) throw new Error('deleteRows out of range');
      if (this._data.length > idx) this._data.splice(idx, howMany);
      if (this._displays && this._displays.length > idx) this._displays.splice(idx, howMany);
      if (this._formats && this._formats.length > idx) this._formats.splice(idx, howMany);
      this._maxRows = maxRows - howMany;
      return this;
    },
    // Real Sheet method, modelled: removes columns from the grid WIDTH (and any
    // data in them). Past the grid throws like Sheets.
    deleteColumns: function (columnPosition, howMany) {
      const maxCols = this.getMaxColumns();
      if (columnPosition < 1 || columnPosition - 1 + howMany > maxCols) throw new Error('deleteColumns out of range');
      const cut = function (row) { row.splice(columnPosition - 1, howMany); };
      this._data.forEach(cut);
      if (this._displays) this._displays.forEach(cut);
      if (this._formats) this._formats.forEach(cut);
      this._maxColumns = maxCols - howMany;
      return this;
    },
    // Blank rows at the bottom only affect capacity, never getLastRow.
    insertRowsAfter: function (afterPosition, howMany) {
      this._maxRows = this.getMaxRows() + howMany;
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
  // R46 / roadmap 1a: the DEFAULT is the live spreadsheet's zone, which is NOT
  // the script's (the shim's Session.getScriptTimeZone() is America/Chicago).
  // Script midnight and sheet midnight therefore DIFFER on summer dates in
  // every fixture unless a suite opts out with an explicit timeZone -- the
  // condition under which the R46 shift was invisible to 1,300 tests.
  // cross-file-pins pins that this default never equals the script zone.
  const tz = opts.timeZone || 'America/Mexico_City';
  const sheetMap = {};
  const ssId = opts.id || 'fake';
  const ssName = opts.name || 'Fake Spreadsheet';
  const ss = {
    getSpreadsheetTimeZone: function () { return tz; },
    getId: function () { return ssId; },
    getUrl: function () { return 'https://docs.google.com/spreadsheets/d/' + ssId; },
    getName: function () { return ssName; },
    getSheetByName: function (name) { return sheetMap[name] || null; },
    // Roadmap 1b: Sheet.setName re-keys the map; a duplicate name THROWS like
    // the real API (the backup helper suffixes a same-minute collision).
    _rename: function (sheet, newName) {
      if (sheetMap[newName] && sheetMap[newName] !== sheet) {
        throw new Error('A sheet with the name "' + newName + '" already exists. Please enter another name.');
      }
      const oldName = Object.keys(sheetMap).find(function (n) { return sheetMap[n] === sheet; });
      if (oldName !== undefined) delete sheetMap[oldName];
      sheetMap[newName] = sheet;
    },
    // E1: real Spreadsheet method, modelled not stubbed (the clearContent
    // discipline) -- ncSurvivingCallLegsDates_ enumerates Call_Legs_* tabs.
    getSheets: function () {
      return Object.keys(sheetMap).map(function (n) { return sheetMap[n]; });
    },
    // Real Spreadsheet method, modelled not stubbed (the clearContent
    // discipline): the retention prune DELETES sheets, and a no-op stub
    // would make every prune assertion pass vacuously. Removes by IDENTITY,
    // not by name -- the prune iterates a getSheets() snapshot, so a
    // name-keyed delete would hide an index-shift bug rather than expose it.
    deleteSheet: function (sheet) {
      const name = Object.keys(sheetMap).find(function (n) { return sheetMap[n] === sheet; });
      if (name === undefined) {
        // The real API throws for a sheet that is not in this spreadsheet.
        throw new Error('deleteSheet: sheet is not part of this spreadsheet');
      }
      delete sheetMap[name];
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

module.exports = { makeFakeSpreadsheet, makeFakeSheet, assertSetValuesShape };
