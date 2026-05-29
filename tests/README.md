# Regression test harness

Node-based unit tests for the **Department Dashboard** Apps Script
code. Zero dependencies — uses Node's built-in `node:test` + `node:assert`
(Node ≥ 18; developed on Node 22). No `npm install` needed.

```bash
node --test          # from the repo root — runs everything under tests/
npm test             # same thing
node --test tests/unit/dept-config.test.js   # one file
```

A run prints a TAP summary; a non-zero exit code means a failure (wire it
into CI / a pre-push hook the same way `scripts/check-duplicated-files.sh`
is wired).

## Why a harness at all

The `.gs` files run in Google's Apps Script V8 runtime against globals
that don't exist in Node (`SpreadsheetApp`, `CacheService`, `Session`,
`Utilities`, …). Historically this repo had **no tests** — verification
was "deploy + manually walk the Regression Scenarios in CLAUDE.md."

This harness loads the *real* production `.gs` files into a Node `vm`
context with mocked Apps Script globals, so the pure-logic functions
(parsing, date math, aggregation rules, validation, the config-override
accessors) can be exercised directly and regressions caught before a
deploy. It is **not** a full Apps Script emulator — see Limitations.

## Layout

```
tests/
  harness/
    formatDate.js   Intl-based shim for Utilities.formatDate (IANA-tz aware)
    fakeSheet.js    in-memory SpreadsheetApp fakes (getRange/getValues/…)
    shim.js         mock Apps Script globals + a `state` handle to drive them
    loadGas.js      loads .gs files into one vm context (shared global scope)
  unit/
    util.test.js          Util.gs: formatting, month lists, insights, assertAdmin_
    data-parsing.test.js  Data.gs: rowDateIso_, parseExtensions_, parseHmsDisplay_, getDeptQueueExts_
    cache-key.test.js     Data.gs: hashAgents_ (INV-36)
    dept-config.test.js   DeptConfig.gs: INV-54 override accessors + validators
```

## Writing a test

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert');   // see "Cross-realm" below
const { loadGas } = require('../harness/loadGas');

// Load the .gs files you need, in dependency order. They share one
// global scope (like Apps Script), so include every file whose
// top-level functions the code under test calls.
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Data.gs'],
  capture: ['TZ', 'HISTORICAL_COLS'],   // top-level CONSTS you want to read
});

test('my thing', function () {
  assert.equal(h.call('round1_', 3.14159), 3.1);
  deepEqual(h.call('parseExtensions_', '1, 2'), ['1', '2']);
});
```

`h.call(name, ...args)` invokes a loaded function; `h.fn(name)` returns
it; `h.consts.NAME` reads a captured constant; `h.ctx` is the raw context
(to set globals like a stubbed `resolveUser_` or reset a memo); `h.state`
drives the shim (current user email, script properties, cache, the fake
spreadsheet). See `dept-config.test.js` for the fake-spreadsheet pattern.

### Two gotchas the harness imposes

1. **Top-level `const`/`let` are not global properties.** Apps Script's
   flat scope means files see each other's `function` and `var`
   declarations (these attach to the vm global, so `h.call('fn')` works),
   but top-level `const`/`let` are lexically scoped to the script and are
   **not** reachable as `ctx.NAME`. To read a constant, pass its name in
   `capture` and read `h.consts.NAME`.

2. **Cross-realm values → use the legacy `deepEqual`.** Arrays/objects a
   `.gs` function builds are created with the vm realm's intrinsics, so
   their `[[Prototype]]` differs from the host's. `assert/strict`'s
   `deepStrictEqual` checks the prototype and would fail. Use the
   **legacy** `deepEqual` (`require('node:assert').deepEqual`) for
   structural comparisons of returned arrays/objects; it is
   prototype-agnostic. Primitive comparisons (`assert.equal`, `.match`,
   `.throws`) are fine as-is. (The harness shares the host `Date` into the
   vm so `instanceof Date` works in both directions.)

## Limitations (and the roadmap this Phase-1 harness leaves open)

- **Pure logic only, so far.** Covered: Util formatting, date/duration
  parsing (INV-02 root cause, the 2-digit-year pivot, serial dates),
  `parseExtensions_` (INV-03), `hashAgents_` (INV-36), and the full
  INV-54 Dept Config override + validation surface.
- **Not yet covered (future phases):** the big aggregators
  (`computeSummary_`, `buildDQEHistoricalData`, the report builders) need
  richer sheet fixtures — including `getDisplayValues()` for the duration
  columns (INV-02) and a roster (`DO NOT EDIT!`) fixture. The fake-sheet
  layer already supports `getDisplayValues`/`setValues` to make that
  possible.
- **Regression Scenarios (CLAUDE.md) are still manual.** A later phase
  could encode the data-shape scenarios (S5/S7 numeric spot-checks,
  S6/S35 floater-exclusion) as fixture-backed tests; the Sonia
  `0:15:03 / 0:03:01` values are already asserted in `util.test.js` via
  `formatSecondsHms_`.
- **No browser/DOM tests.** `script.html` client logic is out of scope
  for a Node harness.
