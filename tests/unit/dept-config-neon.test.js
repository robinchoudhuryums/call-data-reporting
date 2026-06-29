'use strict';

// C2 DAL cutover: Dept Config read from Neon (CONFIG_SOURCE=neon) must produce
// IDENTICAL accessor results to the sheet path, and must fall back to the sheet
// when Neon is unreachable. A fake JDBC connection serves the dept_config
// json_agg payload built from the SAME logical rows the sheet fixture holds.
// (The list columns are stored as the same comma-joined text in both sources,
// so dcParseList_ normalization yields byte-identical lists.)

const { test } = require('node:test');
const { deepEqual, equal } = require('node:assert');   // prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({
  files: ['Config.gs', 'CompanyOverview.gs', 'NeonRead.gs', 'DeptConfig.gs'],
  capture: ['DEPT_CONFIG_HEADERS', 'DEPT_QCD_QUEUES', 'OVERVIEW_PARENT_OF'],
});
const HEADERS = h.consts.DEPT_CONFIG_HEADERS;

// One logical dataset, projected into BOTH sources.
const LOGICAL = [
  { dept: 'CSR', qcd: 'A_Q_Foo, A_Q_Bar', parent: '', excl: 'Robin Choudhury',
    qext: '103, 108', active: true, notes: 'n', inbound: 'A_Q_CSR, Backup CSR' },
  { dept: 'Sales', qcd: 'A_Q_Sales', parent: '', excl: '', qext: '', active: true, notes: '', inbound: '' },
  { dept: 'PAP', qcd: '', parent: 'Sales', excl: '', qext: '', active: false, notes: 'paused', inbound: '' },
];

// Sheet grid row order: Dept | QCD | Parent | TeamExcl | QueueExt | Active | By | At | Notes | InboundAliases
function sheetRow(r) {
  return [r.dept, r.qcd, r.parent, r.excl, r.qext, r.active ? 'TRUE' : 'FALSE', 'admin@x.com', '', r.notes, r.inbound];
}
// Neon json_agg row shape (column names as the read SQL aliases them).
function neonRow(r) {
  return {
    department: r.dept, qcd_queues: r.qcd, overview_parent: r.parent,
    team_avg_excludes: r.excl, queue_ext_overrides: r.qext, active: r.active,
    updated_by: 'admin@x.com', updated_at: '2026-06-01 09:00', notes: r.notes, inbound_aliases: r.inbound,
  };
}

function rsFor(json) {
  let consumed = false;
  return { next: function () { if (consumed) return false; consumed = true; return true; },
           getString: function () { return json; }, close: function () {} };
}
function fakeDeptConfigConn(neonRows) {
  return {
    createStatement: function () {
      return {
        execute: function () { return true; },              // CREATE TABLE IF NOT EXISTS
        executeQuery: function (sql) {
          if (sql.indexOf('FROM dept_config') !== -1) return rsFor(JSON.stringify(neonRows));
          throw new Error('Unexpected SQL: ' + sql);
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function installSheet() {
  h.state.props.SPREADSHEET_ID = 'fake';
  delete h.state.props.CONFIG_SOURCE;
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'Dept Config': [HEADERS].concat(LOGICAL.map(sheetRow)) } });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
}
function installNeon(conn) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.CONFIG_SOURCE = 'neon';
  h.ctx.getDashboardNeonConn_ = conn;
  // No Dept Config sheet -> proves the read came from Neon, not the sheet.
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
}

test('CONFIG_SOURCE=neon: readDeptConfigRows_ matches the sheet path row-for-row', function () {
  installSheet();
  const fromSheet = h.call('readDeptConfigRows_');
  installNeon(function () { return fakeDeptConfigConn(LOGICAL.map(neonRow)); });
  const fromNeon = h.call('readDeptConfigRows_');
  // updatedBy/updatedAt are provenance, not behavior -- compare the rest.
  const strip = function (rows) {
    return rows.map(function (r) {
      return { dept: r.dept, qcdQueues: r.qcdQueues, overviewParent: r.overviewParent,
               teamAvgExcludes: r.teamAvgExcludes, queueExtOverrides: r.queueExtOverrides,
               active: r.active, notes: r.notes, inboundAliases: r.inboundAliases };
    });
  };
  deepEqual(JSON.parse(JSON.stringify(strip(fromNeon))), JSON.parse(JSON.stringify(strip(fromSheet))));
});

test('CONFIG_SOURCE=neon: accessors resolve identically to the sheet path', function () {
  installSheet();
  const sheetQcd = h.call('getDeptQcdQueues_', 'CSR');
  const sheetExcl = h.call('getTeamAvgExcludes_', 'CSR');
  const sheetExt = h.call('getDeptQueueExtsOverride_', 'CSR');
  const sheetAlias = h.call('getInboundQueueAliases_', 'CSR');
  const sheetParent = h.call('getOverviewParentMap_')['PAP'];

  installNeon(function () { return fakeDeptConfigConn(LOGICAL.map(neonRow)); });
  deepEqual(JSON.parse(JSON.stringify(h.call('getDeptQcdQueues_', 'CSR'))), JSON.parse(JSON.stringify(sheetQcd)));
  deepEqual(JSON.parse(JSON.stringify(h.call('getTeamAvgExcludes_', 'CSR'))), JSON.parse(JSON.stringify(sheetExcl)));
  deepEqual(JSON.parse(JSON.stringify(h.call('getDeptQueueExtsOverride_', 'CSR'))), JSON.parse(JSON.stringify(sheetExt)));
  deepEqual(JSON.parse(JSON.stringify(h.call('getInboundQueueAliases_', 'CSR'))), JSON.parse(JSON.stringify(sheetAlias)));
  // PAP is inactive in both sources -> its parent override is dropped, so the
  // constant (OVERVIEW_PARENT_OF['PAP']='Sales') wins in BOTH.
  equal(h.call('getOverviewParentMap_')['PAP'], sheetParent);
});

test('CONFIG_SOURCE=neon: inactive Neon row is ignored (reverts to constant)', function () {
  installNeon(function () { return fakeDeptConfigConn(LOGICAL.map(neonRow)); });
  // PAP active=false -> getActiveDeptConfigMap_ drops it; qcd falls to constant.
  const c = h.consts.DEPT_QCD_QUEUES && h.consts.DEPT_QCD_QUEUES['PAP'];
  deepEqual(JSON.parse(JSON.stringify(h.call('getDeptQcdQueues_', 'PAP'))),
            JSON.parse(JSON.stringify(c || [])));
});

test('CONFIG_SOURCE=neon but Neon unreachable -> falls back to the sheet', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.CONFIG_SOURCE = 'neon';
  h.ctx.getDashboardNeonConn_ = function () { return null; };   // unreachable
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'Dept Config': [HEADERS].concat(LOGICAL.map(sheetRow)) } });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  // Sheet still serves the data despite the neon flag.
  deepEqual(JSON.parse(JSON.stringify(h.call('getDeptQcdQueues_', 'CSR'))), ['A_Q_Foo', 'A_Q_Bar']);
});
