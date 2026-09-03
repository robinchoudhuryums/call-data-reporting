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
was "deploy + manually walk the Regression Scenarios" (now in
`docs/regression-scenarios.md`, indexed from CLAUDE.md).

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
                    model getValue() ≠ getDisplayValue() (INV-02).
                    STRICT on purpose (F-5/F-6): getRange past
                    getMaxColumns THROWS like real Sheets (the REP-10
                    class -- set `_maxColumns` when a test wants a narrow
                    sheet), and setNumberFormat RECORDS onto
                    sheet._numberFormats so the plain-text coercion
                    protections are assertable. Never loosen the fake to
                    make a fixture fit -- widen the fixture.
    fixtures.js     DQE-row + DO NOT EDIT! roster grid builders
    shim.js         mock Apps Script globals + a `state` handle to drive them
    loadGas.js      loads .gs files into one vm context (shared global scope)
  unit/                       (the directory is canonical; every suite is
                               named somewhere in this map — ENFORCED by
                               claude-md-split.test.js, which fails on an
                               unlisted tests/unit/*.test.js — with full
                               rows for the representative examples and a
                               compact roll for the rest)
    util.test.js              Util.gs: formatting, month lists, insights, assertAdmin_
    data-parsing.test.js      Data.gs: rowDateIso_, parseExtensions_, parseHmsDisplay_, getDeptQueueExts_
    cache-key.test.js         Data.gs: hashAgents_ (INV-36)
    dept-config.test.js       DeptConfig.gs: INV-54 override accessors + validators
    compute-summary.test.js   Data.gs: computeSummary_ — INV-02/04/05/23/53, S35 parity, E5 prior-window
    individual-report.test.js IndividualReport.gs: INV-25 weighted ATT, INV-53 floaters, INV-26 exclude, auth
    canonicalization.test.js  cdr-report/cdr-import buildDQEHistoricalData.js: INV-24/INV-46 + INV-16 cross-project
    pipeline-build.test.js    buildDQEHistoricalData end-to-end: INV-07 window legs, INV-08 TTT attribution, INV-20 PST→CST slots, INV-21 parentMap, dup guard
    digest-wow.test.js        Digest.gs: WoW "driver" narrative (#11) reusing INV-48 — gain/drop drivers, threshold, narrative HTML + escaping
    missed-report.test.js     MissedCallsReport.gs: RPT-1 slot-less abandoned parents + lost-detail flag, RPT-2 per-second FIFO parent-id pairing
    ingest-watchdog.test.js   IngestWatchdog.gs: OPS-1 confirmed-send episode arming, OPS-7 holiday skip + non-business-day staleness credit
    ...                       + 81 more (this file is the coverage map —
                              CLAUDE.md's Key-commands block deliberately
                              stopped enumerating suites in the 2026-08-20
                              trim pass): dal-cutover parity, escalations
                              hardening, neon-write chunking/mapping (incl.
                              IMP-4/5/6 replace/dedupe pins), qcd/insights
                              freezes, cache-version-sync (doc↔code
                              cache-pin drift), heatmap drill,
                              system-health + smoke-check, queue-report,
                              pipeline-watch, missed-slice,
                              inbound-qcd-parity, journey-fallback (the
                              call-path drill's sheet fallback: source
                              parity, both auth arms, miss reasons),
                              neon-conn-memo (the per-execution
                              unreachable memo), inbound-calls /
                              outbound-calls (the two per-call captures:
                              builder gates + authoritative/P-1/hash pins,
                              plus the shared-leg-tree scoping: originator-
                              scoped `answered`, the abandon-leg fallback,
                              and the queue-leg originator identity),
                              sheet-repairs-merge, cache-warm-budget (the
                              O-4 whole-run budget), neon-backfill-resume
                              (T-8 fingerprinted resume pointers + the
                              T-7 sanitizer-loss tally), dept-config-neon /
                              config-neon-c3, caller-lookup, answer-targets
                              (R12-25/R23 display standards),
                              access-control-editor, neon-coverage,
                              neon-retention (R27: the storage-cap prune --
                              floored horizons above the coverage window,
                              the six ctid-batched steps, budget/skip/error
                              isolation, the flag-gated weekly handler),
                              html-include-structure (the whole-file
                              tag-wrap trap + the assembled-client pins),
                              queue-split (cols A..AH byte-identical +
                              the Phase-2 reader's four fail-open paths +
                              the S2-0 gate + the Phase-0 de-dup
                              inversion), subqueue-access, claude-md-split,
                              the two NEON-DOWN SHEET FALLBACKS
                              (heatmap-fallback: the mirrored bucketing +
                              two-arm dept attribution; direct-fallback:
                              source parity between the Neon path and the
                              sheet, which is the PRIMARY there),
                              inbound-export (the "Inbound Calls" tab's
                              cols 16-17 + coercion guards feeding that
                              fallback), freshness-weekend (the OPS-7
                              weekend/holiday staleness credit the header
                              pill and Overview banner never had)
                              (index↔file sync + the size/bullet ratchets),
                              setup (INV-12), alert-recipients (B-5),
                              agent-role / agent-home (the deny wall +
                              the no-teammate-identity payload pin),
                              company-overview (getCompanyOverview
                              end-to-end: crossover partition, no
                              cross-dept leak, all-queue hero invariance),
                              trend-window, qcd-report (F-15/F-36),
                              neon-mirror tail/IMP-11,
                              qcd-sidebar-parity (the Extraction Sidebar and
                              calcQcdReport driven from ONE fixture — the
                              behavioral F1 guard; loads BOTH sibling
                              projects in separate harnesses; + the row-34
                              total-row refusal and the previewRow34Overlap
                              probe pinned against the pipeline's own cells),
                              escalations-snapshot (the E2 outage cache),
                              coaching (gates + the F-e delivery: diff/txn/
                              email gating/race-safe close),
                              outbound-report (the Batch G callback report:
                              vetting gate, SQL property pins, roster
                              attribution, getOutboundUncalled),
                              dashboard-cdr-helpers + dashboard-cdr-core
                              (generateCustomReportCore_ end-to-end via a
                              LOCAL recording fake — deliberately not a
                              loosening of the shared strict harness; caught
                              the T-7 panel-clear clipping bug),
                              abandoned-classify (classifyAbandonedCell_,
                              the read-side coercion guard),
                              batch2-helpers, logger-format,
                              call-journey-entitlement (the F-4 gate),
                              config-editor-c3 (the C3 config editors),
                              cross-file-pins (the cross-project literal
                              pins: R20 row-40, JDBC timeout-param absence,
                              the B-2/S4 DQE-reader tripwire, the S1 INV-06
                              window cross-pin),
                              csr-transfer (computeCsrTransferRange_ +
                              guardForceRebuildLoss_ + the bulk-flow
                              harness), dept-summary-email,
                              digest-insights, dqe-silence-watch (episode
                              streaks + the OPS-1 confirmed-send rule),
                              direct-call-metrics / direct-call-backfill /
                              direct-call-report (the direct-extension
                              family: busy carve-out engine, resumable
                              upsert, report + R11-M priors + DC-1
                              fallback siblings),
                              heatmap-cell-drill (the R16h dow+slot pair
                              contract), inbound-window-scope (the
                              INBOUND_WORK_WINDOW_PST sweep + its two
                              deliberate exemptions),
                              login-notify (P14 store-after-confirmed-send),
                              orphan-rename-race (the F-22 re-verify),
                              orphan-roster-add (the New-hire flow),
                              overview-dqe-silence, overview-qcd-snapshot
                              (computeQcdSnapshots_ + the L4 prior-window
                              read), prop-registry (the two-way Script
                              Property sweep: unregistered key / dead
                              registry entry both fail, + the tool-param
                              self-clear pins), report-usage (the INV-01
                              telemetry carve-out + usage rollup),
                              ui-harness-vendor (the committed vendor
                              bundles' version + F-11 sha256 pins),
                              outbound-fallback (the Outbound report's
                              Neon-down sheet fallback: SOURCE PARITY
                              between the Neon blob and the export tabs
                              through the shared outboundShapeReport_, the
                              callback rule's sheet-side mirror, the
                              never-cache rule and all three failure
                              branches),
                              date-presets (the SHARED preset resolver: no
                              open-ended preset includes today, the
                              degenerate month/week-start clamps, and a
                              tripwire that fails if a resolver computes its
                              own dates again),
                              window-clamp (R30: the SHARED window clamp --
                              no report runs past the latest data date, a
                              wholly future window collapses to latest..latest
                              without inverting, a null latest leaves the
                              window alone, plus tripwires that every report's
                              RUN chokepoint clamps against its OWN source and
                              that the per-call surfaces stay unclamped),
                              sheet-coverage (R25: the interior-gap detector
                              -- weekends/holidays/pre-start dates are not
                              gaps, a missing sheet reads distinctly, and it
                              opens no Neon connection),
                              csr-transfer-detail (R25: the headline stays
                              byte-identical, per-agent rows SUM to it,
                              destination labels come from the sheet header,
                              and transfers outside the 11 fixed columns are
                              disclosed),
                              ir-send-to-agent (the three server-side gates
                              on emailing an Individual Report to its
                              subject: dept+roster, registered-address
                              preference, domain allowlist),
                              retention-prune (the destructive Call_Legs_*
                              prune: non-Call_Legs tabs are untouchable, the
                              14-day cutoff is exclusive, P18 fails LOUDLY
                              rather than reporting 0, the Pipeline Health
                              row is accurate -- plus a CHARACTERIZATION of
                              the DST fall-back early deletion),
                              dqe-drilldown-parity (the FOURTH hand-mirrored
                              rule set: one fixture drives the real build AND
                              the real drill sidebar, and the drill's Found-N
                              must reconcile with the DQE cell -- catches all
                              three historical drifts, F24 / R8-D4 / F-13),
                              neon-keepwarm (the COST gate: one observable --
                              did this invocation open a connection? -- across
                              the flag, the weekday check, the half-open hour
                              window, and a typo'd hour property that must
                              NARROW to the default rather than widen to
                              24/7; plus the NEO-3 skipReadHealth contract),
                              queue-overlap-audit (the read-only diagnostic
                              behind "does one CALL get counted by two
                              queues?": cross-queue overlap detection, the
                              REP-4 N/A-parent guard, the Dept Config parent
                              map + summation overlap, roster->queues-worked,
                              crossover agents -- plus a PARITY test driving
                              the real build and the diagnostic from one grid,
                              and the CARRY-OVER regression: the first version
                              picked the MAXIMUM date and analysed only rows
                              matching it, which on a real day selected the
                              handful of legs that crossed midnight, 19 of
                              ~1000, then reported a confident "no overlap"
                              from 2% of the data),
                              cdr-egress-metering (the cdr-report Neon read
                              meter: accumulation, UTC-month reset, surface
                              capping, the never-throws contract, a frozen
                              record reported as stale rather than current --
                              plus the COVERAGE tripwire that every Neon
                              reader in that project meters or is allowlisted,
                              which is what the dashboard-only gauge lacked),
                              insurance-numbers (the insurer-label reference
                              table: every punctuation variant canonicalizes
                              to one form, REP-7's 10-digit country-code fix,
                              the PHI contract that only hash+label reach
                              Neon, and cross-PROJECT hash equivalence between
                              hashPhone and cdrHashPhone_ -- a divergence
                              there silently unlabels every insurer)
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
    prior-window deltas (the summary:v8 bump at the time; INV-30 tracks
    the current version). The Individual Report —
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
  mapping itself is verified via the manual Regression Scenarios
  (`docs/regression-scenarios.md`).
  The INV-29 trend window IS covered (`trend-window.test.js`).
- **Regression Scenarios (`docs/regression-scenarios.md`):** the floater-exclusion contract
  (S35) and the Sonia `0:15:03 / 0:03:01` durations (S7) are now asserted
  as unit tests; the rest remain manual deploy-time checks.
- **No browser/DOM tests** — but PURE client logic is no longer out of
  scope. Anything needing a document, a layout or an event stays with the
  rendered-UI gate (`npm run ci:ui`, headless Chromium). A dependency-free
  helper inside a `script-*.html` fragment, however, can be lifted out and
  unit-tested here: read the fragment, brace-match the `function NAME(...)
  {...}` declaration, and `new Function('return (' + src + ')')()` it.
  `call-grouping.test.js` does this for `groupConsecutiveByCall_` (the
  shared "these rings are one call" rule, R17i) and is the pattern to copy;
  `html-include-structure.test.js` reads the same fragments as text for its
  structural pins. Worth doing whenever a client RULE is shared by more than
  one surface — the UI gate can see THAT something rendered, not that two
  surfaces agreed on the rule behind it.
