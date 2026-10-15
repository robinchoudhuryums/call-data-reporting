'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createShim } = require('./shim');

const APPS_SCRIPT_DIR = path.resolve(__dirname, '../../apps-script');
const DASHBOARD_DIR = path.join(APPS_SCRIPT_DIR, 'department-dashboard');

// Project -> source dir. Lets a suite load the sibling pipeline
// projects (cdr-report / cdr-import) in addition to the dashboard.
const PROJECT_DIRS = {
  dashboard:    DASHBOARD_DIR,
  'cdr-report': path.join(APPS_SCRIPT_DIR, 'cdr-report'),
  'cdr-import': path.join(APPS_SCRIPT_DIR, 'cdr-import'),
};

/**
 * Loads one or more Department Dashboard `.gs` files into a single vm
 * context with mocked Apps Script globals, mirroring Apps Script's
 * flat shared global scope (all files see each other's top-level
 * declarations).
 *
 * Why one combined context: Apps Script evaluates every .gs file in
 * one global scope. Top-level `function`/`var` declarations attach to
 * the context's global object (sloppy-mode script semantics), so tests
 * call them as `ctx.fnName`. Top-level `const`/`let` are lexically
 * scoped to the script and are NOT global properties -- so to read a
 * constant (e.g. TZ, DEPT_QCD_QUEUES) pass its name in `capture` and
 * read it back from the returned `consts` object.
 *
 * @param {object} opts
 * @param {string[]} opts.files   .gs/.js filenames relative to the project dir,
 *                                in load order (must satisfy each other's refs).
 * @param {string[]} [opts.capture] top-level const names to expose in `consts`.
 * @param {string} [opts.project]  'dashboard' (default) | 'cdr-report' | 'cdr-import'.
 * @returns {{ shim, state, ctx, consts, fn(name), call(name, ...args) }}
 */
function loadGas(opts) {
  const files = opts.files;
  const capture = opts.capture || [];
  const baseDir = PROJECT_DIRS[opts.project || 'dashboard'];
  if (!baseDir) throw new Error('loadGas: unknown project "' + opts.project + '"');
  const shim = createShim();

  const code = files
    .map(function (f) { return fs.readFileSync(path.join(baseDir, f), 'utf8'); })
    .join('\n;\n');

  const captureSnippet = capture.length
    ? '\n;globalThis.__consts__ = {};' + capture.map(function (n) {
        return 'try { globalThis.__consts__[' + JSON.stringify(n) + '] = ' + n + '; } catch (e) {}';
      }).join('')
    : '\n;globalThis.__consts__ = {};';

  const ctx = Object.assign({}, shim.globals);
  vm.createContext(ctx);
  // Share the host Date so `v instanceof Date` is consistent across
  // the realm boundary: production code does `v instanceof Date`
  // (rowDateIso_, readDeptConfigRows_, etc.), and tests pass Dates in.
  // Without this, vm's own Date constructor makes both directions fail.
  ctx.Date = Date;
  try {
    vm.runInContext(code + captureSnippet, ctx, { filename: files.join('+') });
  } catch (e) {
    throw new Error('loadGas failed for [' + files.join(', ') + ']: ' + e.message);
  }

  // F39 (broad-scan 2026-10-14): EVERY per-execution memo resets between
  // executions, not just the two workbook memos -- Apps Script starts each
  // request with fresh globals, and a memo that survives here serves one
  // test's fixture to the next (the R40 hole: a suite had to reset four DQE
  // memos by hand, and a fifth memo would have needed a fifth reset). The
  // memo globals are FOUND, not listed: every top-level `var` whose name
  // carries MEMO, minus the tuning constants (*_MAX_ / *_CAP_), snapshotted at
  // load and restored (deep-copied, so a `{}` start is never shared) on each
  // h.fn / h.call entry. A `let` is invisible to the context, which is why the
  // codebase declares its memos with `var`.
  const memoInitial = {};
  Object.keys(ctx).forEach(function (k) {
    if (/MEMO/.test(k) && !/_(MAX|CAP)_$/.test(k)) {
      try { memoInitial[k] = JSON.stringify(ctx[k] === undefined ? null : ctx[k]); } catch (e) { /* not plain data: skip */ }
    }
  });
  function resetExecutionMemos_() {
    Object.keys(memoInitial).forEach(function (k) { ctx[k] = JSON.parse(memoInitial[k]); });
  }
  // A test that asserts a memo's WITHIN-execution behaviour ("read once per
  // execution", "a failed connect is not retried") runs its calls inside
  // h.inExecution(body): one reset at the start, none between the calls.
  let execDepth = 0;
  function freshExecution_() {
    resetExecutionMemos_();
    if (typeof ctx.resetWorkbookMemos_ === 'function') ctx.resetWorkbookMemos_();
  }

  return {
    shim: shim,
    state: shim.state,
    ctx: ctx,
    memoNames: Object.keys(memoInitial),
    consts: ctx.__consts__ || {},
    fn: function (name) {
      const f = ctx[name];
      if (typeof f !== 'function') {
        throw new Error('loadGas: "' + name + '" is not a function in the loaded context '
          + '(top-level const? functions/var attach to global, const/let do not -- '
          + 'use `capture` for constants).');
      }
      // DL-7: every h.call / h.fn entry is a fresh Apps Script EXECUTION for
      // the per-execution workbook memos (openSpreadsheet_ + the roster block),
      // exactly as the platform resets globals between requests -- so a test
      // that swaps state.spreadsheet between calls is served the new fixture.
      // Within one call the memo behaves as in production. A test reaching
      // into ctx directly (h.ctx.someFn) bypasses this boundary on purpose.
      return function () {
        if (!execDepth) freshExecution_();   // F39: every memo, as a new execution
        return f.apply(this, arguments);
      };
    },
    /** F39: run `body` as ONE Apps Script execution -- memos reset once, then
     *  every h.call / h.fn inside it shares them, as calls within one request do. */
    inExecution: function (body) {
      if (!execDepth) freshExecution_();
      execDepth++;
      try { return body(); } finally { execDepth--; }
    },
    call: function (name) {
      const args = Array.prototype.slice.call(arguments, 1);
      return this.fn(name).apply(null, args);
    },
  };
}

module.exports = { loadGas, DASHBOARD_DIR };
