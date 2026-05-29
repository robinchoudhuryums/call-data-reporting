'use strict';

/**
 * Fixture builders for DQE Historical Data + the DO NOT EDIT! roster,
 * shaped to the column layouts pinned in Config.gs (HISTORICAL_COLS,
 * ROSTER). Shared across aggregator suites.
 */

// DQE Historical Data is read across cols A..AH (CSR_AVG_ABD_WAIT = 34).
const DQE_COLS = 34;

// 0-based indices (HISTORICAL_COLS are 1-based):
//   DATE=2->1  AGENT=3->2  QUEUE_EXT=4->3  TOTAL_UNIQUE=5->4
//   TOTAL_RUNG=6->5  TOTAL_MISSED=7->6  TOTAL_ANSWERED=8->7
//   TTT=9->8  ATT=10->9  AVG_ABD_WAIT=33->32  CSR_AVG_ABD_WAIT=34->33
const I = {
  date: 1, agent: 2, ext: 3, unique: 4, rung: 5, missed: 6, answered: 7,
  ttt: 8, att: 9, aaw: 32, caw: 33,
};

/**
 * Builds one DQE row as { vals, disp } (both length-34). Numeric
 * columns live in `vals`; duration columns (TTT/ATT/abd-wait) live in
 * `disp` as "H:MM:SS" strings (production parses those from the
 * DISPLAY grid, INV-02). The duration cells in `vals` are left blank
 * by default to model that production never reads them; a test can
 * poke a wrong value in to prove display is what's used.
 */
function dqeRow(o) {
  const vals = new Array(DQE_COLS).fill('');
  const disp = new Array(DQE_COLS).fill('');
  vals[0] = o.month || '';
  vals[I.date] = o.date;
  vals[I.agent] = o.agent;
  vals[I.ext] = o.ext || '';
  vals[I.unique] = o.unique || 0;
  vals[I.rung] = o.rung || 0;
  vals[I.missed] = o.missed || 0;
  vals[I.answered] = o.answered || 0;
  // Mirror non-duration cells into the display grid (stringified),
  // matching how Sheets renders them.
  for (let c = 0; c < DQE_COLS; c++) disp[c] = vals[c] === '' ? '' : String(vals[c]);
  // Duration columns: display strings drive the parse.
  disp[I.ttt] = o.ttt || '';
  disp[I.att] = o.att || '';
  disp[I.aaw] = o.aaw || '';
  disp[I.caw] = o.caw || '';
  return { vals: vals, disp: disp };
}

/** Assembles built rows into a { values, displays } sheet (header row included). */
function dqeSheet(rows) {
  const header = new Array(DQE_COLS).fill('');
  return {
    values:   [header].concat(rows.map(function (r) { return r.vals; })),
    displays: [header].concat(rows.map(function (r) { return r.disp; })),
  };
}

/**
 * Builds a DO NOT EDIT! roster grid from { DeptName: ['Name, ext', ...] }.
 * Depts are placed left-to-right starting at column F (DEPT_FIRST_COL=6,
 * 0-based index 5), in object-key order; each dept's agents stack down
 * its column from row 2.
 */
function rosterGrid(deptAgents) {
  const FIRST = 5; // 0-based col F
  const depts = Object.keys(deptAgents);
  const maxAgents = depts.reduce(function (m, d) { return Math.max(m, deptAgents[d].length); }, 0);
  const width = FIRST + depts.length;

  const header = new Array(width).fill('');
  depts.forEach(function (d, i) { header[FIRST + i] = d; });

  const grid = [header];
  for (let r = 0; r < maxAgents; r++) {
    const row = new Array(width).fill('');
    depts.forEach(function (d, i) {
      row[FIRST + i] = deptAgents[d][r] || '';
    });
    grid.push(row);
  }
  return grid;
}

module.exports = { dqeRow, dqeSheet, rosterGrid, DQE_COLS, I };
