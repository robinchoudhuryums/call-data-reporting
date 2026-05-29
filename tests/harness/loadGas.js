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

  return {
    shim: shim,
    state: shim.state,
    ctx: ctx,
    consts: ctx.__consts__ || {},
    fn: function (name) {
      const f = ctx[name];
      if (typeof f !== 'function') {
        throw new Error('loadGas: "' + name + '" is not a function in the loaded context '
          + '(top-level const? functions/var attach to global, const/let do not -- '
          + 'use `capture` for constants).');
      }
      return f;
    },
    call: function (name) {
      const args = Array.prototype.slice.call(arguments, 1);
      return this.fn(name).apply(null, args);
    },
  };
}

module.exports = { loadGas, DASHBOARD_DIR };
