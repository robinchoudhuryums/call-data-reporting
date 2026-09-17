/**
 * propRegistry.js -- the cdr-report project's Script Property REGISTRY (the
 * sibling of cdr-import/propRegistry.js and the dashboard's
 * Config.gs::PROP_REGISTRY_). Same contract:
 *
 *   - `operator`: set by a human (secrets, switches, tunables, a ceiling).
 *   - `engine`:   written by the code as outcome / resume / self-populating
 *                 state -- never set by hand; clearing one re-arms its engine
 *                 (a `*_RESUME` pointer restarts that backfill from 0).
 *   - `tool`:     a window or filter a diagnostic reads (set per run).
 *
 * ENFORCED both ways by tests/unit/cdr-report-prop-registry.test.js: every
 * key this project passes to get/set/deleteProperty OR to the backfill resume
 * helpers (`nbResumeRead_` / `nbResumeWrite_`, whose `prop` argument IS a
 * key) must be registered, and every registered key must still be referenced
 * -- including keys declared once as a `var` (`RESUME_KEY`, `HR_BACKUP_PROP_`,
 * `CDR_EGRESS_PROP_`, `HISTORICAL_SORT_FLAG_PROP_`). Adding a property means
 * registering it in the same commit.
 *
 * `listCdrReportScriptProperties()` (editor-run) prints the LIVE store's keys
 * classified -- UNRECOGNIZED first -- with NO values (NEON_PASS / HMAC_SECRET).
 */

var CDR_REPORT_PROP_REGISTRY_ = Object.freeze({
  secret: Object.freeze({ NEON_PASS: true, HMAC_SECRET: true }),
  exact: Object.freeze({
    // operator -- secrets + identity (Operator State #16-#17)
    NEON_HOST: 'operator', NEON_DB: 'operator', NEON_USER: 'operator', NEON_PASS: 'operator',
    HMAC_SECRET: 'operator',
    // operator -- switches + tunables
    CDR_PHONES_MIRROR: 'operator',            // #57: phones-children write gate (shared neonWrite.js)
    CDR_BACKFILL_BEFORE: 'operator',          // #57: the CDR backfills' date ceiling
    HISTORICAL_SORT_ENABLED: 'operator',      // #61: the nightly sort check's flag
    INBOUND_EXPORT_KEEP_DAYS: 'operator', INBOUND_EXPORT_JOURNEY_DAYS: 'operator',     // #49
    OUTBOUND_EXPORT_KEEP_DAYS: 'operator', OUTBOUND_EXPORT_JOURNEY_DAYS: 'operator',   // #50
    // engine -- written by the code
    DQE_BACKFILL_RESUME: 'engine', DQE_UPSERT_RESUME: 'engine',        // T-8 fingerprinted pointers (#56)
    CDR_BACKFILL_RESUME: 'engine', QCD_BACKFILL_RESUME: 'engine',
    CDR_PHONES_BACKFILL_RESUME: 'engine', CDR_MISSING_BACKFILL_RESUME: 'engine',
    DQE_BACKFILL_LAST: 'engine', DQE_UPSERT_LAST: 'engine',            // T-7 sanitizer-loss tallies
    NEON_EGRESS_MTD: 'engine',                                         // #47: this project's egress floor
    HR_BACKUP_SS_ID: 'engine',                                         // #59: self-populating backup workbook id
    CRB_DIAG_COL: 'engine',                                            // dashboardCDR diagnostic column memo
    // tool -- diagnostic parameters
    DQE_UPSERT_SINCE: 'tool',                 // backfillDQEHistoryUpsert floor date
    QUEUE_OVERLAP_DATE: 'tool',               // queueOverlapAudit's date pick
  }),
});

/** PURE. 'operator' | 'engine' | 'tool' for a registered key, else null. */
function cdrReportPropRegistryGroup_(key) {
  return CDR_REPORT_PROP_REGISTRY_.exact[String(key)] || null;
}

/** PURE. Classify live keys into { operator, engine, tool, unrecognized }; values never taken. */
function classifyCdrReportProps_(keys) {
  var out = { operator: [], engine: [], tool: [], unrecognized: [] };
  (keys || []).forEach(function (k) {
    var g = cdrReportPropRegistryGroup_(k);
    (g ? out[g] : out.unrecognized).push(String(k));
  });
  Object.keys(out).forEach(function (g) { out[g].sort(); });
  return out;
}

/** Editor-run: log the live store's keys, classified. Read-only. */
function listCdrReportScriptProperties() {
  var keys = Object.keys(PropertiesService.getScriptProperties().getProperties() || {});
  var c = classifyCdrReportProps_(keys);
  var lines = ['cdr-report Script Properties (' + keys.length + ' keys; values never shown):'];
  lines.push(c.unrecognized.length
    ? '  UNRECOGNIZED (' + c.unrecognized.length + ') -- a retired leftover, a manual one-off, or a TYPO of a real key: ' + c.unrecognized.join(', ')
    : '  unrecognized: none');
  lines.push('  operator (' + c.operator.length + '): ' + c.operator.join(', '));
  lines.push('  engine   (' + c.engine.length + '): ' + c.engine.join(', '));
  lines.push('  tool     (' + c.tool.length + '): ' + c.tool.join(', '));
  Logger.log(lines.join('\n'));
  return c;
}
