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
    fakeSheet.js    in-memory SpreadsheetApp fakes; supports a separate
                    { values, displays } grid so duration columns can
                    model getValue() ≠ getDisplayValue() (INV-02)
    fixtures.js     DQE-row + DO NOT EDIT! roster grid builders
    shim.js         mock Apps Script globals + a `state` handle to drive them
    loadGas.js      loads .gs files into one vm context (shared global scope)
  unit/
    util.test.js              Util.gs: formatting, month lists, insights, assertAdmin_
    data-parsing.test.js      Data.gs: rowDateIso_, parseExtensions_, parseHmsDisplay_, getDeptQueueExts_
    cache-key.test.js         Data.gs: hashAgents_ (INV-36)
    dept-config.test.js       DeptConfig.gs: INV-54 override accessors + validators
    compute-summary.test.js   Data.gs: computeSummary_ — INV-02/04/05/23/53, S35 parity, E5 prior-window
    individual-report.test.js IndividualReport.gs: INV-25 weighted ATT, INV-53 floaters, INV-26 exclude, auth
    canonicalization.test.js  cdr-report/cdr-import buildDQEHistoricalData.js: INV-24/INV-46 + INV-16 cross-project
    pipeline-build.test.js    buildDQEHistoricalData end-to-end: INV-07 window legs, INV-08 TTT attribution, INV-20 PST→CST slots, INV-21 parentMap, dup guard
    digest-wow.test.js        Digest.gs: WoW "driver" narrative (#11) reusing INV-48 — gain/drop drivers, threshold, narrative HTML + escaping
```

To load a sibling pipeline project instead of the dashboard, pass
`project: 'cdr-report'` (or `'cdr-import'`) to `loadGas` — both share
the byte-identical `buildDQEHistoricalData.js` (INV-16).

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

- **Covered so far:**
  - *Pure logic (Phase 1):* Util formatting, date/duration parsing
    (INV-02 root cause, 2-digit-year pivot, serial dates),
    `parseExtensions_` (INV-03), `hashAgents_` (INV-36), the full INV-54
    Dept Config override + validation surface.
  - *Aggregators (Phase 2):* `computeSummary_` (My Department table) —
    INV-02 (display-vs-value durations), INV-04 (exact name match),
    INV-05 (simple-mean ATT), INV-23 (sentinel skip), INV-53 (floater
    exclusion from totals) + S35 roster/both parity, and the E5
    prior-window deltas (summary:v8). The Individual Report —
    INV-25 (answered-weighted ATT, the deliberate contrast to INV-05's
    240-vs-288 case), INV-53 floater fields, INV-26 team-avg exclude via
    a Dept Config override, and the cross-dept auth gate.
  - *Report builders + canonicalization (Phase 3):* the Insights
    consolidation-freeze (insights-report.test.js) — the retired
    Performance / Compare Ranges semantics pinned as fixture literals:
    INV-28 (auto prior = immediately-preceding same-length window),
    INV-25 weighted ATT, INV-29 trend window, INV-53 roster gating;
    INV-35's working-day math lives in util.test.js
    (`countWorkingDays_`) + the Insights suite. `loadRosterCanonicalNames_`
    (pipeline) — INV-24 paren-strip map + ambiguity, INV-46 alias
    overrides (active/inactive/first-wins), and an INV-16 cross-project
    behavioral equivalence check (cdr-report vs cdr-import).
  - *Pipeline end-to-end (Phase 4):* `buildDQEHistoricalData` driven
    through a Raw Data leg fixture (`DQE_C` schema, parent + queue legs)
    — INV-07 (only in-window legs count), INV-08/INV-21 (TTT sums the
    agent's OWN parent-leg talk via `findAgentTalkOnParent`, not the max
    across legs — a Bob decoy leg proves it), INV-20 (missed-slot
    PST→CST +2h bucketing), the Pass-4 INV-23 **queue-sentinel producer**
    (a no-ring abandoned queue call emits one sentinel row with the
    documented column contract; a rung-abandoned parent stays on the
    agent row), and the same-date duplicate guard. Neon mirror +
    failure-notify are stubbed (live in `neonWrite.js`).
  - *QCD report (qcd-report.test.js):* the F-15 daily date axis (a
    sub-queue-only date appears on the axis; dept total zero-fills,
    the child's per-queue line keeps its numbers) and the F-36
    all-departments grand-total dedup (a double-mapped queue counts
    once company-wide while listing under both dept sections), via
    Dept Config fixtures (parent/child + double-mapped queues).
- *Neon writers (`neonWrite.js`, INV-16 pair):* chunking + single-commit
  discipline (`neon-write-chunking.test.js`) AND the field mappings
  (`neon-write-mapping.test.js` -- a recording fake conn asserts the SQL
  column list + every bound param's index/setter/value for the DQE /
  QCD / CDR writers, incl. the no-HMAC NULL-JSONB path).
- *Deferred-mirror tail-scan (neon-mirror-tail.test.js):* the F-20
  `nmReadDateRowsTail_` bounded read -- accepted-window parity with a
  full scan, widening on a top-clipped block, old-date full-scan
  fallback, and the `NEON_MIRROR_TAIL_ROWS` default.
- **Not yet covered:** the deferred mirror's sheet-derived payload
  re-derivation (`NeonMirror.js`'s mirror*ForDate_ field mappings) -- the
  writers it calls AND its tail-read are pinned, but the row-to-payload
  mapping itself is verified via the manual Regression Scenarios.
  The INV-29 trend window IS covered (`trend-window.test.js`).
- **Regression Scenarios (CLAUDE.md):** the floater-exclusion contract
  (S35) and the Sonia `0:15:03 / 0:03:01` durations (S7) are now asserted
  as unit tests; the rest remain manual deploy-time checks.
- **No browser/DOM tests.** `script.html` client logic is out of scope
  for a Node harness.
