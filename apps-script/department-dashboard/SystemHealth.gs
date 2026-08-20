/**
 * System Health page (admin-only) — one glance instead of the 27-item
 * Operator State Checklist.
 *
 * Aggregates the operational signals that already exist as scattered
 * helpers/properties into a single `getSystemHealth()` payload, rendered by
 * the `#health-modal` (route `#/admin/health`). PURELY a read/assembly
 * surface: it computes nothing new, writes nothing, and every section is
 * individually best-effort (a failing probe renders as its own warn row —
 * "the health page is down" must never be the failure mode).
 *
 * Row shape: { key, section, label, status: 'ok'|'warn'|'muted', value, hint }
 *   ok    = green, healthy / configured / installed
 *   warn  = amber, needs attention (the hint says what to do)
 *   muted = informational / intentionally off / not applicable
 *
 * Sections: pipeline (DQE freshness), neon (flags + read-back + mirror
 * health), triggers (which optional trigger-driven services are installed
 * and their last outcomes), config (Script Properties presence), sheets
 * (the setup()-managed tabs). Trigger presence covers THIS project only —
 * cdr-import / cdr-report triggers and Script Properties are per-project
 * and unreadable from here (their rows say so rather than guessing).
 */

// How many Pipeline Health rows the "Recent pipeline step failures" classifier
// reads. MUST stay at least as wide as the Overview banner's
// OVERVIEW_PIPELINE_FRESHNESS_SCAN_ROWS (CompanyOverview.gs) -- this row is the
// page CLAUDE.md calls the single trustworthy pipeline signal, so its window
// must not be the narrower of the two.
//
// LM1 taught this at 40 rows on the Overview banner: a deferred-mirror retry
// storm evicted the DQE row and the banner false-WARNED, so it was widened to
// 250. This classifier was left at 80, where the same eviction produces the
// OPPOSITE and worse outcome -- a step whose failure has scrolled out of the
// window disappears from latestByStep entirely and the row renders `ok`, a
// false ALL-CLEAR on the surface an admin consults to decide whether anything
// is broken. Arithmetic: in deferred mode each drain writes up to 5 rows per
// queued date every 15 min, so 3 queued dates is ~15 rows/run and 80 rows is
// barely an hour of history. Do NOT shrink this.
var HEALTH_PIPELINE_SCAN_ROWS = 250;

// B4: warn when fewer than this many emails remain for the day. Absolute, not
// a percentage, because the quota is plan-dependent (~100/day consumer, ~1500
// Workspace) and the app cannot read which plan it is on -- below ~50 the
// alert channel is at risk on either.
var MAIL_QUOTA_WARN_FLOOR_ = 50;

function getSystemHealth(req) {
  assertAdmin_();
  // R21 (owner: "the full report takes a long time to load"): the two Neon
  // mirror probes are the only rows that open a LIVE Neon connection, and a
  // free-tier cold start (outside the keep-warm window) makes them the whole
  // wait. `part` lets the client fetch in two passes -- 'fast' (everything
  // else: property reads + bounded sheet tails) paints immediately, 'neon'
  // (the shared-conn mirror block) streams in when the probe lands. Omitted
  // (or 'all') = the full payload, byte-identical to before, so editor runs
  // and the existing tests are unchanged.
  var part = String((req && req.part) || 'all');
  var rows = [];
  var add = function (section, key, label, status, value, hint) {
    rows.push({ section: section, key: key, label: label, status: status,
                value: String(value == null ? '' : value), hint: hint || '' });
  };
  var neonConfigured = false;
  try { neonConfigured = !!PropertiesService.getScriptProperties().getProperty('NEON_HOST'); }
  catch (eNc) { neonConfigured = false; }

  if (part !== 'neon') {
  // ── Live presence (who is using the app right now) ──────────────────
  // Owner request: a pre-deploy glance -- "is anyone mid-session before I
  // roll a new version?". Fed by the recordPresence heartbeat below; every
  // row is muted (presence is information, not a health state). First
  // section on purpose: it's the row the owner opens this page for.
  try {
    var live = readPresence_();
    if (!live.length) {
      add('presence', 'presence-now', 'Active now (last ~' + Math.round(PRESENCE_ACTIVE_SEC_ / 60) + ' min)',
        'muted', 'nobody active', 'Heartbeats arrive only from open, visible tabs on the current deploy.');
    } else {
      add('presence', 'presence-now', 'Active now (last ~' + Math.round(PRESENCE_ACTIVE_SEC_ / 60) + ' min)',
        'muted', live.length + ' user(s) with an open tab',
        'A mid-session redeploy can strand these users on a stale client until they reload.');
      live.forEach(function (u) {
        add('presence', 'presence-' + u.email, u.email, 'muted',
          u.role + ' · ' + (u.page || '?') + ' · '
          + (u.ageSec < 60 ? 'just now' : Math.round(u.ageSec / 60) + 'm ago'));
      });
    }
  } catch (e) { add('presence', 'presence-now', 'Active now', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── Pipeline freshness ──────────────────────────────────────────────
  try {
    var fresh = computeOverviewPipelineFreshness_();
    if (!fresh) {
      add('pipeline', 'dqe-fresh', 'DQE build freshness', 'warn', 'no Pipeline Health rows',
        'Pipeline Health sheet empty/missing — run setup() and check the import triggers (Operator State #8/#11).');
    } else if (fresh.isStale) {
      add('pipeline', 'dqe-fresh', 'DQE build freshness', 'warn',
        fresh.latestTimestamp ? ('last fresh build ' + fresh.latestTimestamp + ' (' + fresh.hoursSinceFresh + 'h ago)') : 'no fresh build on record',
        'No fresh DQE rows in ' + OVERVIEW_PIPELINE_STALE_HOURS + 'h+ — the daily import or DQE rebuild likely didn\'t run (Operator State #1/#8/#11).');
    } else {
      add('pipeline', 'dqe-fresh', 'DQE build freshness', 'ok',
        fresh.latestTimestamp + ' (' + fresh.hoursSinceFresh + 'h ago)');
    }
  } catch (e) { add('pipeline', 'dqe-fresh', 'DQE build freshness', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── Recent pipeline step failures (the single trustworthy signal) ────
  // Flags a step ONLY when its MOST RECENT outcome is `failure` -- a step that
  // failed then recovered (its latest row is `success`) is NOT flagged, so this
  // never cries wolf about a fixed blip (the OPS-8/M1 lesson). Catches every
  // step name in one place: the CDR/QCD/DQE/Inbound sheet writes, the `:neon`
  // inline-mirror failures (L7), the `buildDQE:neon` (F4) / `:Inbound` (F9)
  // rows, and the deferred `neonMirror:*` drains -- so the admin doesn't have
  // to scan Pipeline Health by eye to know something is currently broken.
  try {
    // E3: which build is actually serving. deploy.sh stamps BuildStamp.gs at
    // push time (UTC + git SHA + branch); a bare `clasp push -f` ships the
    // committed placeholder instead, so "unstamped" is itself information --
    // the last push bypassed the deploy helper and its CI gates. Always
    // muted: a manual push is legitimate (the hint says what it means), and
    // an out-of-date SHA is for the OPERATOR to compare against git -- this
    // code cannot know what main's head is.
    try {
      var stamp = (typeof BUILD_STAMP_ === 'string' && BUILD_STAMP_)
        ? BUILD_STAMP_ : 'unknown (BuildStamp.gs not in this deployment — pre-E3 push)';
      add('pipeline', 'build-stamp', 'Deployed build (BuildStamp.gs)', 'muted', stamp,
        /unstamped|unknown/.test(stamp)
          ? 'The serving code was last pushed OUTSIDE scripts/deploy.sh, so no CI '
            + 'gate ran against exactly what went live (TST-7/F-10). Compare '
            + 'Manage deployments\' timestamp against git before trusting freshness.'
          : 'Compare the SHA against origin/main to check the deployed version is '
            + 'current (Operator State #2).');
    } catch (eStamp) { /* best-effort -- never costs the page */ }

    // E1 (fast half): the Call_Legs retention HORIZON -- which per-day leg
    // sheets still exist, read from the workbook itself. Everything the
    // ~14-day prune bounds (the inbound/outbound backfills, the queue-split
    // backfill #40) is recoverable only for these dates; the neon-part
    // 'retention-risk' row below cross-references which of them the per-call
    // tables are actually missing. Sheet-only, so it renders even mid-outage
    // -- which is precisely when the deadline matters.
    try {
      if (typeof ncSurvivingCallLegsDates_ === 'function') {
        var legs = ncSurvivingCallLegsDates_(openSpreadsheet_());
        add('pipeline', 'legs-horizon', 'Call_Legs retention horizon', 'muted',
          legs.length
            ? legs.length + ' day-sheet(s) alive: ' + legs[0] + ' … ' + legs[legs.length - 1]
            : 'no Call_Legs_* sheets found',
          legs.length
            ? 'These are the ONLY dates the per-call tables (inbound/outbound), '
              + 'journeys and the queue split (#40) can still be rebuilt from; the '
              + 'daily prune (#43) removes each ~' + ((typeof NC_RETENTION_DAYS_ !== 'undefined') ? NC_RETENTION_DAYS_ : 14)
              + ' days after its date. See the retention-risk row for which of them '
              + 'Neon is missing.'
            : 'Either a brand-new install (no import yet) or the prune removed '
              + 'everything -- if an import ran today a sheet should exist; check #43.');
      }
    } catch (eLegs) { add('pipeline', 'legs-horizon', 'Call_Legs retention horizon', 'warn', 'probe failed', String(eLegs && eLegs.message || eLegs)); }

    var phScan = HEALTH_PIPELINE_SCAN_ROWS;
    var phRows = (typeof readPipelineHealth_ === 'function') ? readPipelineHealth_(phScan) : [];
    if (!phRows || !phRows.length) {
      add('pipeline', 'pipe-failures', 'Recent pipeline step failures', 'muted', 'no Pipeline Health rows');
    } else {
      var latestByStep = {};   // readPipelineHealth_ returns NEWEST-first, so first-seen per step is its latest
      phRows.forEach(function (r) { if (r && r.step && !(r.step in latestByStep)) latestByStep[r.step] = r; });
      var failingSteps = Object.keys(latestByStep).filter(function (s) {
        return String(latestByStep[s].status || '').toLowerCase() === 'failure';
      });
      if (!failingSteps.length) {
        // Say what was MEASURED, not what is true. This row can only see the
        // scanned window, and "no step currently failing" overstated that into
        // an unqualified all-clear -- a step whose last row has scrolled out is
        // indistinguishable from one that never failed.
        add('pipeline', 'pipe-failures', 'Recent pipeline step failures', 'ok',
          'no step failing in the last ' + phScan + ' entries',
          'Scope: the newest ' + phScan + ' Pipeline Health rows (' + phRows.length
          + ' present). A step whose most recent row is older than that window is '
          + 'not assessed here — see Alerts modal → Pipeline Health for the full log.');
      } else {
        var latestFail = latestByStep[failingSteps[0]];
        add('pipeline', 'pipe-failures', 'Recent pipeline step failures', 'warn',
          failingSteps.length + ' step(s) whose latest outcome is failure: ' + failingSteps.join(', '),
          'Most recent: ' + failingSteps[0] + (latestFail.timestamp ? ' @ ' + latestFail.timestamp : '')
          + (latestFail.notes ? ' — ' + latestFail.notes : '')
          + '. See Alerts modal → Pipeline Health for the full Notes.');
      }
    }
  } catch (e) { add('pipeline', 'pipe-failures', 'Recent pipeline step failures', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── Neon ────────────────────────────────────────────────────────────
  var props = PropertiesService.getScriptProperties();
  var neonConfigured = false;
  try {
    neonConfigured = !!props.getProperty('NEON_HOST');
    add('neon', 'neon-conf', 'Neon connection (NEON_* properties)',
      neonConfigured ? 'ok' : 'warn', neonConfigured ? 'configured' : 'not configured',
      neonConfigured ? '' : 'Escalations, Inbound, Caller Lookup, and the F1 read-back need the NEON_* Script Properties (Operator State #18).');
  } catch (e) { add('neon', 'neon-conf', 'Neon connection', 'warn', 'probe failed', String(e && e.message || e)); }
  // F5: read VOLUME, not just reachability. The owner exhausted Neon's monthly
  // transfer allowance with managers live and the Neon-only surfaces went dark
  // for the rest of the month; every probe on this page said "reachable" right
  // up to the cliff, because a Neon that has spent its allowance is reachable.
  // Counted from OUR side (the json_agg payload lengths), so it is a FLOOR --
  // wire framing and any uninstrumented query are not in it. The hint says so:
  // over budget is proof of a problem, under budget is not proof of headroom.
  try {
    var eg = (typeof readNeonEgress_ === 'function') ? readNeonEgress_() : null;
    if (eg) {
      var mb = Math.round((eg.bytes / (1024 * 1024)) * 10) / 10;
      var val = mb + ' MB in ' + eg.reads + ' read(s), ' + eg.month + ' MTD';
      // No declared budget -> informational only. The plan's real allowance is
      // a billing fact this code cannot discover, and inventing a threshold
      // would either cry wolf or reassure wrongly.
      var st = 'muted';
      if (eg.budgetMb > 0) {
        val += ' — ' + eg.pctOfBudget + '% of the ' + eg.budgetMb + ' MB budget';
        st = eg.pctOfBudget >= 80 ? 'warn' : 'ok';
      }
      add('neon', 'neon-egress', 'Neon read volume (month to date)', st, val,
        (eg.budgetMb > 0
          ? 'Warns at 80% of NEON_EGRESS_BUDGET_MB. '
          : 'Set the NEON_EGRESS_BUDGET_MB Script Property to your plan\'s monthly '
            + 'transfer allowance to turn this into a threshold. ')
        + 'Measured from the payloads this project pulls, so treat it as a FLOOR, '
        + 'not an exact meter — under budget is not proof of headroom. Counters '
        + 'reset on the 1st (UTC) and are lossy under concurrency by design. '
        + 'If this climbs fast, the biggest lever is the report cache TTL + the '
        + 'reportFreshnessTag_ key suffix (every cached serve is a read avoided).');
    }
  } catch (e) { add('neon', 'neon-egress', 'Neon read volume (month to date)', 'warn', 'probe failed', String(e && e.message || e)); }
  // B4: the OTHER shared, exhaustible resource. Alerts, digests, the Daily
  // Call Queue Report, DQE-build failure notices, sign-in notifications and
  // the client-error beacon all draw on ONE MailApp daily quota, and running
  // it dry is silent in the same way the Neon cap was: sends just stop. Quota
  // is per-account and plan-dependent (~100/day consumer, ~1500 Workspace), so
  // the floor below is deliberately absolute rather than a percentage -- under
  // ~50 remaining the alert channel is at risk on any plan.
  try {
    if (typeof MailApp !== 'undefined' && MailApp && typeof MailApp.getRemainingDailyQuota === 'function') {
      var quota = Number(MailApp.getRemainingDailyQuota());
      if (isFinite(quota)) {
        add('neon', 'mail-quota', 'Email quota remaining today',
          quota < MAIL_QUOTA_WARN_FLOOR_ ? 'warn' : 'ok', String(quota) + ' message(s)',
          quota < MAIL_QUOTA_WARN_FLOOR_
            ? 'Low. Alerts / digests / the queue report share this quota, and it '
              + 'resets on a rolling 24 h -- a run that exhausts it fails SILENTLY '
              + '(no send, no error surfaced to a manager). Check the Alert Log for '
              + 'a burst of preview sends and the client-error beacon for a report storm.'
            : 'Shared by alerts, digests, the Daily Call Queue Report, pipeline '
              + 'failure notices, sign-in notifications and the client-error beacon.');
      }
    }
  } catch (e) { add('neon', 'mail-quota', 'Email quota remaining today', 'warn', 'probe failed', String(e && e.message || e)); }
  try {
    var src = getDqeReadSource_();
    add('neon', 'dqe-source', 'DQE read source (DQE_READ_SOURCE)',
      'muted', src,
      src === 'neon' ? 'Reads come from dqe_history; sheet is the fallback.'
                     : 'Reads come from the DQE sheet; flip to neon after a clean runDqeParityCheck (Operator State #19).');
  } catch (e) { add('neon', 'dqe-source', 'DQE read source', 'warn', 'probe failed', String(e && e.message || e)); }
  try {
    var qsrc = (typeof getQcdReadSource_ === 'function') ? getQcdReadSource_() : 'sheet';
    add('neon', 'qcd-source', 'QCD read source (QCD_READ_SOURCE)', 'muted', qsrc,
      qsrc === 'neon' ? 'Queue-report reads come from qcd_history; sheet is the fallback.'
                      : 'Queue-report reads come from the QCD sheet; flip to neon after a clean runQcdParityCheck.');
  } catch (e) { add('neon', 'qcd-source', 'QCD read source', 'warn', 'probe failed', String(e && e.message || e)); }
  try {
    var cfgSrc = (typeof getConfigSource_ === 'function') ? getConfigSource_() : 'sheet';
    add('neon', 'config-source', 'Config source (CONFIG_SOURCE)', 'muted', cfgSrc,
      cfgSrc === 'neon' ? 'Dept/Alert/Digest Config read+write Neon tables.' : 'Config sheets are authoritative (default).');
  } catch (e) { add('neon', 'config-source', 'Config source', 'warn', 'probe failed', String(e && e.message || e)); }
  try {
    var rh = computeNeonReadHealth_();
    if (!rh.configured || (rh.source !== 'neon' && rh.status === 'ok')) {
      add('neon', 'read-health', 'Neon read-back health', 'muted', 'n/a (reads on sheet, no failure on record)');
    } else if (rh.status === 'ok') {
      add('neon', 'read-health', 'Neon read-back health', 'ok', 'no failures on record');
    } else {
      add('neon', 'read-health', 'Neon read-back health', 'warn',
        (rh.count || 0) + ' consecutive failure(s) — last: ' + (rh.message || 'unknown') + (rh.at ? ' at ' + rh.at : ''),
        'Neon DQE reads are silently falling back to the sheet — sustained outage serves aging data (Operator State #19).');
    }
  } catch (e) { add('neon', 'read-health', 'Neon read-back health', 'warn', 'probe failed', String(e && e.message || e)); }
  }   // end part !== 'neon' (first fast range)

  if (part !== 'fast') {
  // Both mirror-health probes (DQE + QCD) share ONE Neon connection so the
  // page pays at most a single free-tier cold-start, not one handshake per
  // probe. Opened here, threaded into both compute*MirrorHealth_(conn), closed
  // in the finally. An explicit null (Neon configured but unreachable) tells
  // each helper to report 'error' WITHOUT re-attempting its own connection.
  // R21: this block is the ONLY live-Neon payer on the page -- it is what
  // part='neon' isolates so the rest can paint without waiting for a cold start.
  var sharedNeonConn = null;
  if (neonConfigured && typeof getDashboardNeonConn_ === 'function') {
    try { sharedNeonConn = getDashboardNeonConn_(); } catch (e) { sharedNeonConn = null; }
  }
  try {
    var renderMirror = function (key, label, mh, upsertHint) {
      if (mh.status === 'ok') {
        add('neon', key, label, 'ok',
          'neon max ' + (mh.neonMax || '?') + (mh.sheetMax ? (' vs sheet ' + mh.sheetMax) : ''));
      } else if (mh.status === 'behind') {
        add('neon', key, label, 'warn',
          'behind by ' + mh.gapDays + ' day(s) (neon ' + mh.neonMax + ' < sheet ' + mh.sheetMax + ')',
          upsertHint);
      } else {
        add('neon', key, label, 'warn', mh.status,
          'Could not read the mirror max date — check Neon reachability.');
      }
    };
    try {
      if (neonConfigured) {
        renderMirror('mirror-health', 'DQE→Neon mirror',
          computeNeonMirrorHealth_(sharedNeonConn),
          'Re-import the missing date(s) or run backfillDQEHistoryUpsert() (Operator State #19).');
      } else {
        add('neon', 'mirror-health', 'DQE→Neon mirror', 'muted', 'n/a (Neon unconfigured)');
      }
    } catch (e) { add('neon', 'mirror-health', 'DQE→Neon mirror', 'warn', 'probe failed', String(e && e.message || e)); }
    try {
      if (neonConfigured && typeof computeQcdMirrorHealth_ === 'function') {
        renderMirror('qcd-mirror-health', 'QCD→Neon mirror',
          computeQcdMirrorHealth_(sharedNeonConn),
          'Re-import the missing date(s) — writeQCDRowsToNeon is authoritative per-date.');
      } else if (neonConfigured) {
        add('neon', 'qcd-mirror-health', 'QCD→Neon mirror', 'muted', 'n/a (probe unavailable)');
      } else {
        add('neon', 'qcd-mirror-health', 'QCD→Neon mirror', 'muted', 'n/a (Neon unconfigured)');
      }
    } catch (e) { add('neon', 'qcd-mirror-health', 'QCD→Neon mirror', 'warn', 'probe failed', String(e && e.message || e)); }
    // E1 (neon half): which SURVIVING Call_Legs dates the two no-sheet-primary
    // tables are missing. Every date listed here becomes PERMANENTLY
    // unrecoverable on its lastDay -- there is no other source once the sheet
    // prunes. Rides the shared connection (R21: this block is the page's only
    // live-Neon payer). An unreachable Neon cannot answer "which dates", so it
    // warns with the outage playbook instead of guessing.
    try {
      if (neonConfigured && typeof ncRetentionRisk_ === 'function'
          && typeof ncSurvivingCallLegsDates_ === 'function') {
        var rrLegs = ncSurvivingCallLegsDates_(openSpreadsheet_());
        if (!rrLegs.length) {
          add('neon', 'retention-risk', 'Per-call tables vs retention window', 'muted',
            'no surviving Call_Legs sheets to check');
        } else if (!sharedNeonConn) {
          add('neon', 'retention-risk', 'Per-call tables vs retention window', 'warn',
            'Neon unreachable — cannot tell which surviving dates are unmirrored',
            'If the outage outlasts the horizon (oldest surviving sheet: ' + rrLegs[0]
            + '), run backfillInboundCalls + backfillOutboundCalls (cdr-import editor) '
            + 'the moment Neon returns — dates whose sheet prunes first are gone for good.');
        } else {
          var risk = ncRetentionRisk_(sharedNeonConn, rrLegs, function (iso) {
            try { return (typeof isCompanyHoliday_ === 'function') && isCompanyHoliday_(iso); }
            catch (e) { return false; }
          });
          var atRisk = [];
          var notes = [];
          (risk.tables || []).forEach(function (t) {
            if (t.missingTable) { notes.push(t.table + ': table not created yet'); return; }
            if (t.error) { notes.push(t.table + ': ' + t.error); return; }
            t.atRisk.forEach(function (a) { atRisk.push(t.table + ' ' + a.date + ' (until ~' + a.lastDay + ')'); });
          });
          if (atRisk.length) {
            add('neon', 'retention-risk', 'Per-call tables vs retention window', 'warn',
              atRisk.length + ' surviving date(s) unmirrored: '
              + atRisk.slice(0, 6).join(', ') + (atRisk.length > 6 ? ' …' : ''),
              'Run backfillInboundCalls / backfillOutboundCalls (cdr-import editor) '
              + 'BEFORE the listed last day — when the date\'s Call_Legs sheet prunes '
              + 'there is no other source (Operator State #40/#43).'
              + (notes.length ? ' Also: ' + notes.join('; ') + '.' : ''));
          } else {
            add('neon', 'retention-risk', 'Per-call tables vs retention window', 'ok',
              'every surviving Call_Legs date is mirrored'
              + (notes.length ? ' (' + notes.join('; ') + ')' : ''));
          }
        }
      }
    } catch (e) { add('neon', 'retention-risk', 'Per-call tables vs retention window', 'warn', 'probe failed', String(e && e.message || e)); }
  } finally {
    if (sharedNeonConn) { try { sharedNeonConn.close(); } catch (ce) {} }
  }
  }   // end part !== 'fast'

  if (part !== 'neon') {
  // ── Trigger-driven services (THIS project) ──────────────────────────
  try {
    var installed = {};
    var trig = ScriptApp.getProjectTriggers();
    for (var i = 0; i < trig.length; i++) installed[trig[i].getHandlerFunction()] = true;
    // Batch 3: an engine can be ARMED two ways, and they can disagree. Four of
    // them gate their handler BODY on an `*_ENABLED` Script Property, so a
    // trigger that is installed while the flag is off fires on schedule and
    // returns immediately -- the page said "installed", the operator believed
    // it was armed, and it did nothing. That mismatch is invisible today and is
    // exactly the Operator-Only State Gap bug shape. `flagProp` opts a row into
    // the reconciliation; engines with no flag (alerts, digests, cache warm,
    // backup) pass nothing and behave as before.
    var readiness = { armed: 0, attention: 0 };
    var svc = function (key, label, fns, required, offHint, flagProp) {
      var on = fns.some(function (f) { return !!installed[f]; });
      var missing = fns.filter(function (f) { return !installed[f]; });
      var complete = on && !missing.length;
      var flagOn = flagProp ? (String(props.getProperty(flagProp) || '') === 'true') : null;

      var status, value, hint;
      if (complete && flagOn === false) {
        // The silent-inert case: scheduled, but every run is a no-op.
        status = 'warn';
        value = 'installed but DISABLED (' + flagProp + ' is not "true") — every run is a no-op';
        hint = 'Set ' + flagProp + '=true, or uninstall the trigger so the page stops implying it is armed.';
      } else if (!complete && flagOn === true) {
        // The opposite mismatch: flagged on, nothing to fire it.
        status = 'warn';
        value = (on ? ('partial — missing ' + missing.join(', ')) : 'NO trigger installed')
          + ' but ' + flagProp + '=true — it never runs';
        hint = offHint || ('Install the trigger, or clear ' + flagProp + '.');
      } else {
        status = complete ? 'ok' : (required ? 'warn' : 'muted');
        value = complete ? ('installed' + (flagOn === true ? ' + enabled' : ''))
          : (on ? ('partial — missing ' + missing.join(', ')) : 'not installed');
        hint = complete ? '' : offHint;
      }
      if (status === 'warn') readiness.attention++;
      else if (status === 'ok') readiness.armed++;
      add('triggers', key, label, status, value, hint);
    };
    svc('trg-alerts',  'Daily alerts trigger',  ['runDailyAlerts_'], true,
      'Alerts only fire on manual Send without it — install from the Alerts modal (Operator State #8).');
    svc('trg-digests', 'Digest triggers (daily/weekly/monthly)',
      ['runDailyDigests_', 'runWeeklyDigests_', 'runMonthlyDigests_'], true,
      'Digest Config rows have no effect without them — install from the Alerts modal (Operator State #8).');
    svc('trg-warm',    'Report cache warming',  ['warmReportCaches_'], false,
      'Optional: pre-warms Overview / summaries / all-dept report / Insights after ingest (Operator State #21).');
    svc('trg-keepwarm','Neon keep-warm',        ['keepNeonWarm_'], false,
      'Optional; only matters once DQE_READ_SOURCE=neon (Operator State #20).',
      'NEON_KEEPWARM_ENABLED');
    svc('trg-watchdog','Ingest-failure watchdog', ['runIngestWatchdog_'], false,
      'Optional: emails admins when no fresh DQE build lands (Operator State #23).',
      'INGEST_WATCHDOG_ENABLED');
    svc('trg-pipewatch','Pipeline-failure watchdog', ['runPipelineWatch_'], false,
      'Optional: emails admins when a Pipeline Health failure row is logged — enable via installPipelineWatchTrigger().',
      'PIPELINE_WATCH_ENABLED');
    svc('trg-backup',  'Neon backup (escalations / inbound_calls)', ['runNeonBackup_'], false,
      'Optional but recommended: these tables have NO sheet fallback — install via installNeonBackupTrigger().');
    // O-5: the queue-report poller was the one trigger-driven engine this
    // inventory missed -- a deleted trigger was invisible on the page that
    // claims to replace the operator checklist.
    svc('trg-queuereport', 'Daily Call Queue Report email', ['runDailyQueueReport_'], false,
      'Optional: emails the all-dept queue report to subscribers each weekday morning (Operator State #31).',
      'QUEUE_REPORT_ENABLED');
    // R18d: the DQE-silence cross-check born from the Field Ops Power blind
    // spot -- queue taking calls, zero agent rows, nothing anywhere to notice.
    svc('trg-dqesilence', 'DQE-silence watchdog (queue active, agents dark)', ['runDqeSilenceWatch_'], false,
      'Optional but recommended: emails admins when a mapped queue shows QCD volume while ZERO DQE rows match the dept roster — the silent failure shape that cost Field Ops Power two months of agent history (Operator State #44). Enable via installDqeSilenceWatchTrigger().',
      'DQE_SILENCE_WATCH_ENABLED');
    // Batch 3: ONE verdict line so the answer to "is this install armed?" is a
    // row, not an exercise in reading fifteen. Counts the engine rows above --
    // `attention` is any row this section flagged warn (missing-but-required,
    // partial, or a flag/trigger mismatch).
    add('triggers', 'trg-readiness', 'Install readiness (engines)',
      readiness.attention ? 'warn' : 'ok',
      readiness.armed + ' armed, ' + readiness.attention + ' need attention',
      readiness.attention
        ? 'Each flagged row above says what to do. A row reading "installed but DISABLED" is the '
          + 'dangerous one -- it looks scheduled and does nothing.'
        : '');
  } catch (e) { add('triggers', 'trg-probe', 'Trigger inventory', 'warn', 'probe failed', String(e && e.message || e)); }

  // Last outcomes of the optional services (property-backed, cheap).
  try {
    var outcomes = [
      ['out-warm',     'Cache warm — last outcome',   'CACHE_WARM_LAST',    'CACHE_WARM_LAST_RESULT'],
      ['out-keepwarm', 'Keep-warm — last ping',       'NEON_KEEPWARM_LAST', 'NEON_KEEPWARM_LAST_RESULT'],
      ['out-backup',   'Neon backup — last run',      'NEON_BACKUP_LAST',   'NEON_BACKUP_LAST_RESULT'],
      ['out-pipewatch','Pipeline watch — last run',   'PIPELINE_WATCH_LAST','PIPELINE_WATCH_LAST_RESULT'],
      // O-5: queue-report outcome (this engine has no *_LAST timestamp prop;
      // the result string carries its own timestamp). MISSED / FAILED-ALL
      // outcomes trip the OPS-8 classifier's bad-word match, as intended.
      ['out-queuereport', 'Queue report — last outcome', 'QUEUE_REPORT_LAST', 'QUEUE_REPORT_LAST_RESULT'],
      // Live smoke harness (SmokeCheck.gs, editor-run): result string is
      // OPS-8 prefix-coded ('ok N/N ...' / 'FAILED k/N ...').
      ['out-smoke', 'Live smoke — last run', 'SMOKE_LAST', 'SMOKE_LAST_RESULT'],
      // R7 (G-2): Neon coverage check (NeonCoverage.gs, editor-run):
      // 'ok clean ...' / 'GAPS n finding(s) ...' / 'FAILED...' / 'skipped...'.
      ['out-coverage', 'Neon coverage — last check', 'NEON_COVERAGE_LAST', 'NEON_COVERAGE_LAST_RESULT'],
      // R18d: 'ok ...' / 'SILENT n dept(s) ...' / 'ERROR: ...'.
      ['out-dqesilence', 'DQE silence — last check', 'DQE_SILENCE_WATCH_LAST', 'DQE_SILENCE_WATCH_LAST_RESULT'],
    ];
    for (var o = 0; o < outcomes.length; o++) {
      var at = props.getProperty(outcomes[o][2]);
      var res = props.getProperty(outcomes[o][3]);
      if (!at && !res) { add('triggers', outcomes[o][0], outcomes[o][1], 'muted', 'never run'); continue; }
      // OPS-8: outcome strings are prefix-coded -- an "ok (...)" result is
      // healthy even when its detail mentions designed-normal partial work
      // (CacheWarm's "ok (12 warmed, 3 insights skipped on budget)").
      // Substring-matching "skipped" inside an ok result painted the row
      // amber every budget-limited day, training the admin to ignore the
      // SAME row that carries the genuinely-bad "skipped (no latest
      // date)" / "FAILED" outcomes.
      // O-5: the queue report's not-sent outcome leads with "MISSED <iso>" --
      // none of the substring bad-words match it, so classify by prefix too.
      // R7 (G-2): likewise the coverage check's findings outcome ("GAPS n ...").
      // O-9: and "NO-SUBSCRIBERS <iso> ..." -- the queue report ran with an
      // empty recipient list. It reads like a clean run and is the exact state
      // an admin lands in by installing the trigger without subscribing.
      // R18d: and the silence watchdog's found-something outcome ('SILENT n ...').
      var bad = !/^ok\b/i.test(res || '')
        && (/fail|error|unreachable|skipped/i.test(res || '')
            || /^MISSED\b/.test(res || '') || /^GAPS\b/.test(res || '')
            || /^NO-SUBSCRIBERS\b/.test(res || '') || /^SILENT\b/.test(res || ''));
      add('triggers', outcomes[o][0], outcomes[o][1], bad ? 'warn' : 'ok',
        (res || '') + (at ? (' @ ' + at) : ''));
    }
  } catch (e) { add('triggers', 'out-probe', 'Service outcomes', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── Script Properties presence ──────────────────────────────────────
  try {
    var propSpecs = [
      ['DASHBOARD_URL',    true,  'Alert-email links + "Open in new tab" buttons hide without it (Operator State #7).'],
      ['ADMIN_EMAILS',     true,  'Falls back to the ADMIN_EMAILS_FALLBACK constant — editing admins then needs a redeploy (Operator State #13).'],
      ['HMAC_SECRET',      true,  'Caller Lookup + phone-hash mirrors degrade without it (Operator State #17).'],
      ['COMPANY_HOLIDAYS', false, 'Optional: holiday-aware working-day counts + alert/digest skips (Operator State #27).'],
      ['SPREADSHEET_ID',   true,  'REQUIRED — every sheet read fails without it (Operator State: setup).'],
    ];
    for (var p = 0; p < propSpecs.length; p++) {
      var name = propSpecs[p][0];
      var required = propSpecs[p][1];
      var set = !!props.getProperty(name);
      add('config', 'prop-' + name, name, set ? 'ok' : (required ? 'warn' : 'muted'),
        set ? 'set' : 'not set', set ? '' : propSpecs[p][2]);
    }
  } catch (e) { add('config', 'prop-probe', 'Script Properties', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── setup()-managed sheets ──────────────────────────────────────────
  try {
    var ss = openSpreadsheet_();
    var expected = ['Access Control', 'Alert Config', 'Alert Log', 'Pipeline Health',
                    'Digest Config', 'Agent Alias Overrides', 'Orphan Fix Log',
                    'Dept Config', 'Report Usage',
                    'Queue Report Subscribers'];   // O-5: the tenth setup() sheet (INV-12)
    var missing = expected.filter(function (n) { return !ss.getSheetByName(n); });
    add('sheets', 'setup-sheets', 'setup()-managed sheets',
      missing.length ? 'warn' : 'ok',
      missing.length ? ('missing: ' + missing.join(', ')) : (expected.length + ' present'),
      missing.length ? 'Re-run setup() from the editor as an admin (Operator State #6) — writers against missing sheets silently no-op.' : '');
  } catch (e) { add('sheets', 'setup-sheets', 'setup()-managed sheets', 'warn', 'probe failed', String(e && e.message || e)); }

  // ── Report usage (last 30 days) ─────────────────────────────────────
  // The consolidation / un-gating EVIDENCE the Report Usage telemetry
  // carve-out (INV-01) exists to provide, surfaced instead of asking the
  // operator to hand-pivot the sheet. Informational only (every row is
  // 'muted' -- usage is evidence, not a health state), busiest-first.
  try {
    var ru = computeReportUsageSummary_();
    var ruLabelDays = 'Report usage (last ' + REPORT_USAGE_SUMMARY_DAYS_ + ' days)';
    if (!ru.available) {
      add('usage', 'usage-none', ruLabelDays, 'muted', 'unavailable — ' + (ru.reason || 'unknown'));
    } else if (!ru.reports.length) {
      add('usage', 'usage-none', ruLabelDays, 'muted', 'no report opens recorded');
    } else {
      ru.reports.forEach(function (rep) {
        add('usage', 'usage-' + rep.report, rep.report, 'muted',
          rep.runs + ' run(s) · ' + rep.users + ' user(s)'
          + (rep.managerRuns ? ' · ' + rep.managerRuns + ' by managers' : ' · admin-only use')
          + ' · ' + rep.cacheHitPct + '% cache hits · last ' + (rep.lastUsed || '?'));
      });
      if (ru.clipped) {
        add('usage', 'usage-clipped', 'Usage scan window', 'muted',
          'scan capped at the newest ' + REPORT_USAGE_SCAN_CAP_ + ' rows — counts above understate the full '
          + REPORT_USAGE_SUMMARY_DAYS_ + '-day window');
      }
      // R19: per-user rows under their own section; the client renders the
      // section COLLAPSED behind its header (still just {key,section,...} rows,
      // so a stale client renders them flat rather than breaking).
      (ru.users || []).forEach(function (u) {
        add('users', 'user-' + u.email, u.email, 'muted',
          u.runs + ' open(s) · ' + (u.role || '?') + ' · last ' + (u.lastUsed || '?')
          + (u.top ? ' · ' + u.top : ''));
      });
    }
  } catch (e) { add('usage', 'usage-none', 'Report usage', 'warn', 'probe failed', String(e && e.message || e)); }
  }   // end part !== 'neon' (second fast range)

  var warnCount = rows.filter(function (r) { return r.status === 'warn'; }).length;
  return { generatedAt: new Date().toISOString(), rows: rows, warnCount: warnCount, part: part };
}

// -- UI surface toggles (R7 / G-3) ---------------------------------------------
// Admin-only editor for the `UI_FLAGS` Script Property: a curated set of
// client surfaces (Config.gs::UI_FLAG_SURFACES) that can be HIDDEN for all
// viewers while something is fixed/investigated. INV-01 config-path
// mitigations: assertAdmin_ + registry validation + LockService + a
// Logger.log audit line. Presentation-only — nothing here changes compute,
// caches, or auth gates; viewers pick a change up on their next page load.

/** Pure (unit-tested): comma-list/array → deduped, registry-valid key list. */
function uiFlagsSanitize_(raw, registry) {
  var keys = registry || UI_FLAG_SURFACES;
  var toks = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(',');
  var out = [], seen = {};
  for (var i = 0; i < toks.length; i++) {
    var k = String(toks[i] || '').trim().toLowerCase();
    if (k && Object.prototype.hasOwnProperty.call(keys, k) && !seen[k]) {
      seen[k] = true; out.push(k);
    }
  }
  return out;
}

/** Internal read (renderDashboard_ injection + the editor). Never throws. */
function getUiFlags_() {
  try {
    return uiFlagsSanitize_(PropertiesService.getScriptProperties().getProperty('UI_FLAGS'));
  } catch (e) { return []; }
}

/** Admin RPC: current flags + the registry (key → label) for the editor UI. */
function getUiFlags() {
  assertAdmin_();
  return { flags: getUiFlags_(), registry: UI_FLAG_SURFACES };
}

/** Admin RPC: replace the flag set. Unknown keys are dropped (tolerant). */
function saveUiFlags(req) {
  assertAdmin_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10 * 1000);
  try {
    var clean = uiFlagsSanitize_((req && req.flags) || []);
    var props = PropertiesService.getScriptProperties();
    if (clean.length) props.setProperty('UI_FLAGS', clean.join(','));
    else props.deleteProperty('UI_FLAGS');
    Logger.log('saveUiFlags: %s set UI_FLAGS=%s',
      Session.getActiveUser().getEmail(), clean.join(',') || '(none)');
    return { flags: clean };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* best-effort */ }
  }
}

// -- Report Usage summary ------------------------------------------------------

var REPORT_USAGE_SUMMARY_DAYS_ = 30;   // aggregation window
// Bounded tail read (the F-20 / DRIFT_LOG_SCAN_CAP discipline): the sheet is
// append-only and grows with every report open, so an unbounded read would
// eventually blow the Health page's budget. 5000 rows comfortably covers 30
// days at current traffic; if it ever clips the window, the summary says so.
var REPORT_USAGE_SCAN_CAP_ = 5000;
// R19: per-user rows returned to the Health page's expandable "User activity"
// section, busiest-first. ~20 real users today; 40 leaves headroom without
// letting the payload grow unbounded.
var REPORT_USAGE_USER_CAP_ = 40;

/**
 * Aggregates the Report Usage telemetry sheet (Util.gs::logReportUsage_,
 * schema REPORT_USAGE_HEADERS: Timestamp | Report | Department | Role |
 * Email | Cache Hit) over the last REPORT_USAGE_SUMMARY_DAYS_ days.
 *
 * Returns { available, reason? , reports: [{ report, runs, users,
 * managerRuns, cacheHitPct, lastUsed }], rowsInWindow, clipped } with
 * reports sorted busiest-first. `managerRuns` is the number the
 * un-gating decisions care about: a vetted-gated report (Inbound /
 * Direct) shows admin-only use by construction, while a candidate for
 * retirement shows near-zero manager traffic. `clipped` is true when
 * the scan cap cut into the window (oldest scanned row is younger than
 * the window floor), i.e. the counts are a floor, not the total.
 */
function computeReportUsageSummary_() {
  var ss = openSpreadsheet_();
  var sheet = ss.getSheetByName(SHEETS.REPORT_USAGE);
  if (!sheet) return { available: false, reason: 'Report Usage sheet missing — re-run setup() (Operator State #6)' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { available: true, reports: [], rowsInWindow: 0, clipped: false };

  var count = Math.min(lastRow - 1, REPORT_USAGE_SCAN_CAP_);
  var start = lastRow - count + 1;
  var vals = sheet.getRange(start, 1, count, 6).getValues();
  var floor = new Date();
  floor.setDate(floor.getDate() - REPORT_USAGE_SUMMARY_DAYS_);

  var tz = Session.getScriptTimeZone();
  var byReport = {};
  var byUser = {};   // R19: per-user rollup for the Health page's expandable section
  var rowsInWindow = 0;
  for (var i = 0; i < vals.length; i++) {
    var ts = vals[i][0];
    if (!(ts instanceof Date)) ts = new Date(ts);
    if (isNaN(ts.getTime()) || ts < floor) continue;
    rowsInWindow++;
    var rep = String(vals[i][1] || '') || '(unknown)';
    var b = byReport[rep];
    if (!b) b = byReport[rep] = { report: rep, runs: 0, hits: 0, managerRuns: 0, userSet: {}, last: null };
    b.runs++;
    if (String(vals[i][5] || '').toUpperCase() === 'TRUE') b.hits++;
    if (String(vals[i][3] || '').toLowerCase() === 'manager') b.managerRuns++;
    var email = String(vals[i][4] || '').toLowerCase();
    if (email) b.userSet[email] = true;
    if (!b.last || ts > b.last) b.last = ts;
    if (email) {
      var u = byUser[email];
      if (!u) u = byUser[email] = { email: email, role: '', runs: 0, byReport: {}, last: null };
      u.runs++;
      u.byReport[rep] = (u.byReport[rep] || 0) + 1;
      if (!u.last || ts > u.last) {   // role as of the LAST-seen row (grants change)
        u.last = ts;
        u.role = String(vals[i][3] || '');
      }
    }
  }

  // Clipped = the cap dropped older rows AND the oldest row we DID scan is
  // already inside the window (so in-window rows were cut off below it).
  var clipped = false;
  if (count < lastRow - 1 && vals.length) {
    var oldest = vals[0][0];
    if (!(oldest instanceof Date)) oldest = new Date(oldest);
    clipped = !isNaN(oldest.getTime()) && oldest >= floor;
  }

  var reports = Object.keys(byReport).map(function (k) {
    var b = byReport[k];
    return {
      report: b.report,
      runs: b.runs,
      users: Object.keys(b.userSet).length,
      managerRuns: b.managerRuns,
      cacheHitPct: b.runs ? Math.round((b.hits / b.runs) * 100) : 0,
      lastUsed: b.last ? Utilities.formatDate(b.last, tz, 'yyyy-MM-dd') : null,
    };
  }).sort(function (a, b) { return b.runs - a.runs || (a.report < b.report ? -1 : 1); });

  // R19: per-user activity, busiest-first, each with a "top reports" digest
  // (top 3 by count). Capped so a big org can't bloat the payload.
  var users = Object.keys(byUser).map(function (k) {
    var u = byUser[k];
    var top = Object.keys(u.byReport)
      .sort(function (a, b) { return u.byReport[b] - u.byReport[a] || (a < b ? -1 : 1); })
      .slice(0, 3)
      .map(function (rep) { return rep + ' ' + u.byReport[rep]; })
      .join(', ');
    return {
      email: u.email,
      role: u.role,
      runs: u.runs,
      top: top,
      lastUsed: u.last ? Utilities.formatDate(u.last, tz, 'yyyy-MM-dd') : null,
    };
  }).sort(function (a, b) { return b.runs - a.runs || (a.email < b.email ? -1 : 1); })
    .slice(0, REPORT_USAGE_USER_CAP_);

  return { available: true, reports: reports, users: users, rowsInWindow: rowsInWindow, clipped: clipped };
}

// -- Client-error beacon (R19) -------------------------------------------------
// The push complement to the read-only rows above: when a signed-in user's
// browser hits an uncaught error or a top-level load failure, the client
// calls reportClientIssue and the admins get an email IMMEDIATELY -- the
// owner should not learn about a broken page from a manager's hallway
// report. INV-01: public but writes NO spreadsheet state (email + CacheService
// throttle counters + Logger only). Abuse/looping is bounded three ways:
// the client sends each error signature once per session (max 6 total), the
// server emails each signature at most once per CLIENT_ISSUE_SIG_TTL_SEC,
// and a rolling CacheService window caps total emails so a rendering loop
// on 14 managers' machines costs at most CLIENT_ISSUE_WINDOW_CAP_ emails.
// Throttled reports still Logger.log, so the Executions panel has the tail.

var CLIENT_ISSUE_MSG_CAP_ = 600;
var CLIENT_ISSUE_STACK_CAP_ = 1800;
var CLIENT_ISSUE_SIG_TTL_SEC = 1800;    // one email per distinct error / 30 min
var CLIENT_ISSUE_WINDOW_CAP_ = 15;      // max emails per rolling 6h CacheService window

function reportClientIssue(payload) {
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  var p = payload || {};
  var kind = String(p.kind || 'error').slice(0, 40);
  var msg = String(p.message || '').slice(0, CLIENT_ISSUE_MSG_CAP_);
  if (!msg) return { ok: false };
  var stack = String(p.stack || '').slice(0, CLIENT_ISSUE_STACK_CAP_);
  var route = String(p.route || '').slice(0, 120);
  var ua = String(p.ua || '').slice(0, 220);

  var sig = kind + '|' + msg.slice(0, 120);
  var sigKey = 'cissue:sig:' + Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, sig)).slice(0, 24);
  var cache = CacheService.getScriptCache();
  var emailed = false;
  try {
    var seen = cache.get(sigKey);
    var count = parseInt(cache.get('cissue:count') || '0', 10) || 0;
    if (!seen && count < CLIENT_ISSUE_WINDOW_CAP_) {
      var to = getAdminEmails_().join(',');
      if (to) {
        MailApp.sendEmail({
          to: to,
          subject: '[Dashboard] Client issue — ' + kind + ' (' + user.email + ')',
          body: 'A user\'s browser reported a client-side issue.\n\n'
            + 'User:  ' + user.email + ' (' + user.role + ')\n'
            + 'Page:  ' + (route || '(unknown)') + '\n'
            + 'Kind:  ' + kind + '\n'
            + 'Time:  ' + new Date().toISOString() + '\n\n'
            + 'Message:\n' + msg + '\n\n'
            + (stack ? 'Stack:\n' + stack + '\n\n' : '')
            + (ua ? 'Browser: ' + ua + '\n\n' : '')
            + 'Repeats of this error are throttled for 30 minutes; the full tail '
            + 'is in the Apps Script Executions log (reportClientIssue).',
        });
        emailed = true;
        cache.put(sigKey, '1', CLIENT_ISSUE_SIG_TTL_SEC);
        cache.put('cissue:count', String(count + 1), 21600);
      }
    }
  } catch (e) { /* best-effort -- the beacon must never error back into the client */ }
  Logger.log('reportClientIssue [%s] %s %s: %s%s', kind, user.email, route, msg,
    emailed ? '' : ' (throttled/not emailed)');
  return { ok: true, emailed: emailed };
}

// -- Live presence -------------------------------------------------------------
// Owner request: "see who is using the app live -- could allow timing of
// rollouts easier/less jarring." Both clients (the dashboard and the agent
// app) send a heartbeat on load and every ~2.5 min while their tab is
// VISIBLE; the Health page's "Active now" section reads the map back.
// INV-01-clean: CacheService only -- no sheet, no Neon, nothing durable.
// The map is read-modify-write WITHOUT a lock: two concurrent beats can
// lose one entry for a cycle, which the next heartbeat heals -- presence
// is a live glance, not a record, so lossy-but-cheap is the right trade.
// Gate: any signed-in role (agents included -- the rollout-timing question
// covers the agent app too), mirroring reportClientIssue's signed-in gate;
// role 'none' is rejected.

var PRESENCE_CACHE_KEY_ = 'presence:v1';
var PRESENCE_CACHE_TTL_SEC_ = 1800;   // the map itself survives 30 min of total silence
var PRESENCE_PRUNE_SEC_ = 900;        // entries older than 15 min are dropped on every beat
var PRESENCE_ACTIVE_SEC_ = 360;       // "active now" = a beat within ~6 min (2 heartbeats + slack)
var PRESENCE_MAX_USERS_ = 100;        // hard cap keeps the cache value bounded (~60B/entry)

function recordPresence(req) {
  var user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  try {
    var cache = CacheService.getScriptCache();
    var map = {};
    try { map = JSON.parse(cache.get(PRESENCE_CACHE_KEY_) || '{}') || {}; } catch (eJ) { map = {}; }
    var now = Math.floor(Date.now() / 1000);
    map[user.email] = { t: now, role: user.role, page: String((req && req.page) || '').slice(0, 40) };
    var emails = Object.keys(map).filter(function (em) {
      var e = map[em];
      return e && typeof e.t === 'number' && (now - e.t) <= PRESENCE_PRUNE_SEC_;
    });
    emails.sort(function (a, b) { return map[b].t - map[a].t; });   // newest-first, cap drops the stalest
    var kept = {};
    emails.slice(0, PRESENCE_MAX_USERS_).forEach(function (em) { kept[em] = map[em]; });
    cache.put(PRESENCE_CACHE_KEY_, JSON.stringify(kept), PRESENCE_CACHE_TTL_SEC_);
  } catch (e) { /* best-effort -- a presence hiccup must never surface to a client */ }
  return { ok: true };
}

/** Read side (Health page). Active entries only, freshest-first. Never throws to empty. */
function readPresence_() {
  var out = [];
  try {
    var map = JSON.parse(CacheService.getScriptCache().get(PRESENCE_CACHE_KEY_) || '{}') || {};
    var now = Math.floor(Date.now() / 1000);
    Object.keys(map).forEach(function (em) {
      var e = map[em];
      if (e && typeof e.t === 'number' && (now - e.t) <= PRESENCE_ACTIVE_SEC_) {
        out.push({ email: em, role: String(e.role || '?'), page: String(e.page || ''), ageSec: now - e.t });
      }
    });
    out.sort(function (a, b) { return a.ageSec - b.ageSec; });
  } catch (e) { /* best-effort */ }
  return out;
}
