/**
 * propRegistry.js -- the cdr-import project's Script Property REGISTRY.
 *
 * The dashboard registers every Script Property it reads or writes
 * (`Config.gs::PROP_REGISTRY_`) so its Health page can classify the live store
 * and flag a typo of a real key instead of silently defaulting. This project
 * had no such view: 20+ keys spread across autoImport / NeonMirror /
 * inboundCalls / directCallMetrics / execCeilingProbe / the shared neonWrite,
 * and the settings page was the only inventory. Same contract here:
 *
 *   - `operator`: set by a human (identity, secrets, switches, tunables).
 *   - `engine`:   written by the code as outcome / resume state -- never set
 *                 by hand; clearing one just re-arms its engine.
 *   - `tool`:     a window or filter a diagnostic reads (set per run).
 *
 * ENFORCED both ways by tests/unit/cdr-import-prop-registry.test.js: every key
 * literal the project's .js files pass to get/set/deleteProperty must be
 * registered, and every registered key must still be referenced. Adding a
 * property means registering it in the same commit (the dashboard's rule).
 *
 * `listCdrImportScriptProperties()` (editor-run) prints the LIVE store's keys
 * classified against this registry -- UNRECOGNIZED keys first -- with NO
 * values (the store holds NEON_PASS / HMAC_SECRET).
 */

var CDR_IMPORT_PROP_REGISTRY_ = Object.freeze({
  secret: Object.freeze({ NEON_PASS: true, HMAC_SECRET: true }),
  exact: Object.freeze({
    // operator -- identity + secrets (Operator State #15-#17)
    TARGET_SS_ID: 'operator',
    NEON_HOST: 'operator', NEON_DB: 'operator', NEON_USER: 'operator', NEON_PASS: 'operator',
    HMAC_SECRET: 'operator',
    // operator -- switches + tunables
    NEON_MIRROR_MODE: 'operator',           // #22: inline (default) | deferred
    NEON_MIRROR_TAIL_ROWS: 'operator',      // #22: the F-20 tail window
    NEON_MIRROR_MAX_ATTEMPTS: 'operator',   // #22: the IMP-6 retry cap
    NEON_MIRROR_BUDGET_MS: 'operator',      // #22: per-run drain budget
    CDR_PHONES_MIRROR: 'operator',          // #57: phones-children write gate
    BULK_TIME_LIMIT_MS: 'operator',         // #70: bulk per-click budget (P-3)
    IC_BACKFILL_TIME_LIMIT_MS: 'operator',  // #70: inbound/outbound backfill budget (P-3)
    // engine -- written by the code
    bulkQueue: 'engine', bulkIndex: 'engine', bulkReport: 'engine',   // processBulkQueue state
    lastSheets: 'engine',                                              // autoImport's recent-sheet memo
    RETENTION_HOLD: 'engine',                                          // ING-5: recovered Call_Legs tabs held from the prune
    DIRECT_UPSERT_RESUME: 'engine',                                    // backfillDirectCallToNeon pointer
    EXEC_CEILING_PROBE_STARTED: 'engine', EXEC_CEILING_PROBE_LAST_MS: 'engine',
    EXEC_CEILING_PROBE_FINISHED: 'engine',                             // #70: the probe's record
    // tool -- diagnostic parameters
    DIRECT_UPSERT_SINCE: 'tool',            // backfillDirectCallToNeon floor date
    SAMPLE_QUEUE: 'tool', SAMPLE_AGENT: 'tool', SAMPLE_MAX_IDS: 'tool',   // queueSplitSample.js
    TRANSFER_PREVIEW_DATE: 'tool',          // the transfer-path previews' date pick
  }),
});

/** PURE. 'operator' | 'engine' | 'tool' for a registered key, else null. */
function cdrImportPropRegistryGroup_(key) {
  return CDR_IMPORT_PROP_REGISTRY_.exact[String(key)] || null;
}

/**
 * PURE. Classify a list of live keys: { operator, engine, tool, unrecognized }
 * (each a sorted array). Values are never taken, so nothing secret can leak
 * through a log line.
 */
function classifyCdrImportProps_(keys) {
  var out = { operator: [], engine: [], tool: [], unrecognized: [] };
  (keys || []).forEach(function (k) {
    var g = cdrImportPropRegistryGroup_(k);
    (g ? out[g] : out.unrecognized).push(String(k));
  });
  Object.keys(out).forEach(function (g) { out[g].sort(); });
  return out;
}

/** Editor-run: log the live store's keys, classified. Read-only. */
function listCdrImportScriptProperties() {
  var keys = Object.keys(PropertiesService.getScriptProperties().getProperties() || {});
  var c = classifyCdrImportProps_(keys);
  var lines = ['cdr-import Script Properties (' + keys.length + ' keys; values never shown):'];
  if (c.unrecognized.length) {
    lines.push('  UNRECOGNIZED (' + c.unrecognized.length + ') -- a retired leftover, a manual one-off, or a TYPO of a real key: '
      + c.unrecognized.join(', '));
  } else {
    lines.push('  unrecognized: none');
  }
  lines.push('  operator (' + c.operator.length + '): ' + c.operator.join(', '));
  lines.push('  engine   (' + c.engine.length + '): ' + c.engine.join(', '));
  lines.push('  tool     (' + c.tool.length + '): ' + c.tool.join(', '));
  Logger.log(lines.join('\n'));
  return c;
}
