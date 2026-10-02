/**
 * Neon backup (optional, admin-toggled trigger) — Drive exports of the
 * tables whose ONLY store is Neon.
 *
 * Most historical tables have a sheet primary, so a Neon loss is
 * recoverable by re-mirroring. THREE do not: `escalations`,
 * `escalation_activity`, and `inbound_calls` (incl. the per-call journey
 * JSON). (OPS-5: when CONFIG_SOURCE=neon, the run ALSO snapshots the
 * then-Neon-authoritative dept_config / alert_config / digest_config as
 * <table>-latest.jsonl; while config is sheet-backed the sheet is the
 * backup and they're skipped.) If the Neon account/project is lost, that data is simply gone —
 * and escalations now takes writes from the external team-tools app
 * (INV-55 Phase 2). This trigger exports them to a Drive folder weekly:
 *
 *   - escalations-<YYYY-MM-DD>.jsonl        FULL snapshot per run (rows are
 *     mutable — status/resolution change), trimmed to the newest
 *     NEON_BACKUP_KEEP snapshots (default 8 ≈ two months of weeklies).
 *   - escalation_activity-<YYYY-MM>.jsonl   MONTHLY partitions (append-only
 *     rows): the current month is rewritten each run; a CLOSED month is
 *     skipped only once FINAL -- written at least NB_FINAL_GRACE_DAYS_ after
 *     it closed (ENG-1: the old "file exists -> skip" froze each month at its
 *     last in-month Saturday and never backed up the days after it). A
 *     pre-ENG-1 month too old to rewrite losslessly gets a
 *     <table>-<YYYY-MM>.tail.jsonl supplement instead (nbClosedMonthAction_).
 *     Restore = the month file(s) + its tail file, if any.
 *   - inbound_calls-<YYYY-MM>.jsonl         Same monthly scheme (rows for a
 *     date can be refreshed by a re-import, but only current-ish dates are
 *     ever rewritten, so final closed months are stable).
 *
 * Format: one JSON object per line (row_to_json), which restores cleanly
 * via psql/\copy or a small script. Fetching uses ONE
 * string_agg(row_to_json) round-trip per file — never per-row JDBC
 * iteration (~0.5s/row, the same trap the F1 read-back's json_agg pattern
 * avoids).
 *
 * Folder: the NEON_BACKUP_FOLDER_ID Script Property. When unset, the first
 * run CREATES a Drive folder named "Dashboard Neon Backups" (owned by the
 * trigger installer) and persists its id to the property — no manual step.
 *
 * Requires the `https://www.googleapis.com/auth/drive` scope (NEW —
 * consent per Operator State #9 after deploying) + the dashboard NEON_*
 * props.
 *
 * SHEETS FALLBACK (owner 2026-09-28): some Workspace policies block the Drive
 * permission ("You do not have permission to call DriveApp.createFolder").
 * When Drive is unavailable -- or `NEON_BACKUP_STORE=sheets` forces it -- the
 * SAME run writes the same files into a standing "Dashboard Neon Backups"
 * SPREADSHEET instead (created on first use with the Sheets permission the
 * project already has; id in NEON_BACKUP_SS_ID). Each file is one tab, one
 * JSON line per row, trimmed to its exact size (the allocated-cells budget,
 * Operator State #62); an `_index` tab records when each was written, which
 * stands in for Drive's last-updated date in the closed-month rules. The store
 * adapter exposes the Drive folder's own interface, so every rule below runs
 * unchanged against either. Restore: restoreNeonBackupFile() (either store). Install/uninstall are admin-gated; the trigger target is
 * underscore-suffixed. Best-effort per table: one table's failure never
 * blocks the others, and the run outcome lands in NEON_BACKUP_LAST /
 * NEON_BACKUP_LAST_RESULT (surfaced on the System Health page).
 */

var NEON_BACKUP_FOLDER_NAME  = 'Dashboard Neon Backups';
var NEON_BACKUP_KEEP_DEFAULT = 8;    // escalations snapshots retained
var NEON_BACKUP_HOUR_DEFAULT = 6;    // Saturday, quiet hours (Central)

// ── Public (admin-gated) API ──────────────────────────────────────────

function getNeonBackupStatus() {
  assertAdmin_();
  return logStatusReturn_(getNeonBackupStatus_());
}

function installNeonBackupTrigger() {
  assertAdmin_();
  uninstallNeonBackupTrigger_();
  var hour = nbHour_();
  ScriptApp.newTrigger('runNeonBackup_').timeBased()
    .everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(hour).create();
  return logStatusReturn_(getNeonBackupStatus_());
}

function uninstallNeonBackupTrigger() {
  assertAdmin_();
  uninstallNeonBackupTrigger_();
  return logStatusReturn_(getNeonBackupStatus_());
}

/** Manual one-shot backup (admin) — run after deploying to seed the folder. */
function runNeonBackupNow() {
  assertAdmin_();
  runNeonBackup_();
  return logStatusReturn_(getNeonBackupStatus_());
}

// ── Trigger entry point ───────────────────────────────────────────────

function runNeonBackup_() {
  var t0 = Date.now();
  var outcomes = [];
  var conn = null;
  var budgetHit = false;   // BU-3
  var overBudget = function () {
    if (!budgetHit && Date.now() - t0 > NB_RUN_BUDGET_MS_) budgetHit = true;
    return budgetHit;
  };
  try {
    // DL-3: a week-sized month window of journey rows can legitimately run long.
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_({ queryTimeoutS: NB_QUERY_TIMEOUT_S_ }) : null;
    if (!conn) {
      nbRecord_('skipped (Neon unreachable/unconfigured)');
      return;
    }
    var store = nbStore_();
    var folder = store.folder;
    outcomes.push('store ' + store.label
      + (store.driveError ? ' (Drive unavailable: ' + String(store.driveError).slice(0, 160) + ')' : ''));
    var nowIso = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    var currentYm = nowIso.slice(0, 7);

    // 1. escalations: full snapshot (mutable rows) + retention trim.
    try {
      var snap = nbFetchAgg_(conn,
        "SELECT COALESCE(string_agg(row_to_json(t)::text, E'\\n'), '') AS j "
        + 'FROM (SELECT * FROM escalations ORDER BY created_at, id) t', []);
      nbWriteFile_(folder, 'escalations-' + nowIso + '.jsonl', snap);
      nbTrimSnapshots_(folder, nbKeep_());
      outcomes.push('escalations ok (' + Math.round(snap.length / 1024) + 'KB)');
    } catch (e1) {
      outcomes.push('escalations FAILED: ' + (e1 && e1.message ? e1.message : e1));
    }

    // 2 + 3. Monthly partitions (closed months skipped once written).
    var monthlies = [
      { table: 'escalation_activity', dateCol: 'at',        cast: 'timestamptz', orderBy: 'at, id' },
      { table: 'inbound_calls',       dateCol: 'call_date', cast: 'date',        orderBy: 'call_date, call_id' },
      // P5: outbound_calls has NO sheet primary either (the Option B twin of
      // inbound_calls -- per-call rows past the ~14-day Call_Legs window
      // exist nowhere else, and Caller Lookup + the Outbound report read it),
      // but the capture shipped without joining this registry, so a Neon
      // project loss destroyed all outbound per-call history with the backup
      // trigger armed. The table is auto-created by the capture's first run;
      // until then the catch below reports a clean not-created-yet skip.
      { table: 'outbound_calls',      dateCol: 'call_date', cast: 'date',        orderBy: 'call_date, call_id' },
    ];
    var journeyDays = nbJourneyDays_();
    for (var m = 0; m < monthlies.length; m++) {
      var spec = monthlies[m];
      if (overBudget()) { outcomes.push(spec.table + ' not reached (run budget)'); continue; }   // BU-3
      try {
        var firstYm = nbMinMonth_(conn, spec.table, spec.dateCol);
        if (!firstYm) { outcomes.push(spec.table + ' empty'); continue; }
        var months = nbMonthsBetween_(firstYm, currentYm);
        var written = 0, skipped = 0, tails = 0, unreached = 0;
        // BU-3: newest first, and stop at the run budget.
        for (var i = months.length - 1; i >= 0; i--) {
          if (overBudget()) { unreached = i + 1; break; }
          var ym = months[i];
          var name = spec.table + '-' + ym + '.jsonl';
          if (ym < currentYm) {
            // ENG-1 (broad-scan 2026-09-23): a closed month is FINAL only once
            // a run has written it at least NB_FINAL_GRACE_DAYS_ after the
            // month closed. The old rule ("closed + file exists -> skip")
            // froze the file from the month's LAST IN-MONTH Saturday, so the
            // days after it (1-7 per month, plus the next-morning ingest of
            // the last day) were never backed up -- and NeonRetention prunes
            // them later. See nbClosedMonthAction_.
            var main = nbMonthMainFile_(folder, spec.table, ym);
            var tailName = spec.table + '-' + ym + '.tail.jsonl';
            var tailFile = nbFirstFile_(folder, tailName);
            var action = nbClosedMonthAction_(ym, {
              lastUpdatedIso: main ? nbFileUpdatedIso_(main) : null,
              tailUpdatedIso: tailFile ? nbFileUpdatedIso_(tailFile) : null,
            }, nowIso, { graceDays: NB_FINAL_GRACE_DAYS_, journeyDays: journeyDays });
            if (action === 'skip') { skipped++; continue; }
            if (action === 'tail') {
              nbWriteMonthTail_(conn, folder, spec, ym, main, tailName);
              tails++;
              continue;
            }
            // 'write' / 'rewrite': fall through to the full-month fetch.
          }
          // OPS-4: fetch the month in ~week-sized windows so no single JDBC
          // getString has to carry a whole month of journey-bearing rows
          // (0.2-6KB each -- monotonic growth was heading for the JDBC/V8
          // string and Drive setContent ceilings). Under the file budget
          // the chunks are joined back into the ONE month file (restore
          // format unchanged); an oversize month is written as
          // <table>-<ym>.partN.jsonl files instead.
          var chunks = nbFetchMonthChunks_(conn, spec, ym);
          var total = 0;
          for (var c = 0; c < chunks.length; c++) total += chunks[c].length;
          if (total <= NB_FILE_BUDGET_CHARS) {
            nbWriteFile_(folder, name, chunks.filter(function (s) { return s; }).join('\n'));
            // Symmetry with the parts branch below: if this month was
            // PREVIOUSLY written as parts (a heavier prior run) and now fits a
            // single file (e.g. a re-import shrank it), trash the stale part
            // files so a restore never mixes the new whole-month file with old
            // partN files (= duplicated rows).
            for (var sp = 1; ; sp++) {
              var partIt = folder.getFilesByName(spec.table + '-' + ym + '.part' + sp + '.jsonl');
              if (!partIt.hasNext()) break;
              while (partIt.hasNext()) partIt.next().setTrashed(true);
            }
          } else {
            var part = 0;
            for (var c2 = 0; c2 < chunks.length; c2++) {
              if (!chunks[c2]) continue;
              part++;
              nbWriteFile_(folder, spec.table + '-' + ym + '.part' + part + '.jsonl', chunks[c2]);
            }
            // Remove a stale single-file version so a restore never mixes
            // an old whole-month file with the new parts.
            var oldIt = folder.getFilesByName(name);
            while (oldIt.hasNext()) oldIt.next().setTrashed(true);
            // R8-E1: ALSO trash higher-numbered parts from a heavier prior
            // run of this same month. If a re-import shrank the month from
            // 4 parts to 3, the stale part4 kept old (possibly deleted)
            // rows; once the month closed, the part1 existence check froze
            // it in the archive forever -- a restore then duplicated /
            // resurrected rows, defeating exactly the mixing guarantee the
            // two cleanup passes above exist for.
            for (var xp = part + 1; ; xp++) {
              var staleIt = folder.getFilesByName(spec.table + '-' + ym + '.part' + xp + '.jsonl');
              if (!staleIt.hasNext()) break;
              while (staleIt.hasNext()) staleIt.next().setTrashed(true);
            }
          }
          // ENG-1: a full-month file now holds every row the tail file held,
          // so a stale tail would duplicate rows on restore.
          var staleTail = folder.getFilesByName(spec.table + '-' + ym + '.tail.jsonl');
          while (staleTail.hasNext()) staleTail.next().setTrashed(true);
          written++;
        }
        outcomes.push(spec.table + (unreached ? ' partial (' : ' ok (') + written + ' month file(s) written, '
          + (tails ? tails + ' closed-month tail(s) written, ' : '')
          + skipped + ' closed skipped'
          + (unreached ? ', ' + unreached + ' older month(s) not reached -- run budget' : '') + ')');
      } catch (e2) {
        var m2 = (e2 && e2.message ? e2.message : String(e2));
        // P5: a per-call table not created yet (outbound_calls before the
        // capture's first run) is a clean SKIP, not a backup failure -- the
        // ncMissingTableError_ distinction NeonCoverage draws for the same
        // reason. Every other error stays a loud FAILED outcome.
        // O-5: anchored like ncMissingTableError_ -- `column "x" does not
        // exist` (schema drift) is a real failure, not a not-yet-created table.
        if (/relation "[^"]*" does not exist/i.test(m2)) {
          outcomes.push(spec.table + ' skipped (table not created yet — the capture creates it on first run)');
        } else {
          outcomes.push(spec.table + ' FAILED: ' + m2);
        }
      }
    }

    // 4. OPS-5: once CONFIG_SOURCE=neon, the config tables are
    // Neon-authoritative (the sheet stops receiving edits) -- back them up
    // too. Tiny tables: one overwritten <table>-latest.jsonl snapshot per
    // run. Skipped entirely while config is sheet-backed (the sheet IS the
    // backup then).
    if (typeof getConfigSource_ === 'function' && getConfigSource_() === 'neon') {
      var cfgTables = ['dept_config', 'alert_config', 'digest_config'];
      for (var ct = 0; ct < cfgTables.length; ct++) {
        if (overBudget()) { outcomes.push(cfgTables[ct] + ' not reached (run budget)'); continue; }   // BU-3
        try {
          var cfgBody = nbFetchAgg_(conn,
            "SELECT COALESCE(string_agg(row_to_json(t)::text, E'\\n'), '') AS j "
            + 'FROM (SELECT * FROM ' + cfgTables[ct] + ') t', []);
          nbWriteFile_(folder, cfgTables[ct] + '-latest.jsonl', cfgBody);
          outcomes.push(cfgTables[ct] + ' ok');
        } catch (e3) {
          outcomes.push(cfgTables[ct] + ' FAILED: ' + (e3 && e3.message ? e3.message : e3));
        }
      }
    }

    // 5. ESC-D8: retry the scrub of deleted escalations -- AFTER the monthly
    // files, so a closed month the scrub had to defer has just been finalized.
    // Reported in the outcome but never FAILED: a backup that is complete is
    // still ok (the ENG-2 retention gate keys on it); the pending scrub has its
    // own Health row.
    if (nbScrubQueue_().ids.length) {
      if (overBudget()) {
        outcomes.push('scrub not reached (run budget)');
      } else {
        var sr = nbScrubPending_();
        outcomes.push(sr.status === 'ok'
          ? 'scrub ok (' + sr.lines + ' row(s) of deleted escalations removed from ' + sr.files + ' file(s))'
          : 'scrub pending (' + sr.pending + ' deleted escalation id(s) still in the backups)');
      }
    }

    if (store.label === 'sheets' && typeof folder.cellsUsedPct === 'function') {
      var pct = folder.cellsUsedPct();
      if (pct >= NB_SHEETS_WARN_PCT_) {
        outcomes.push('WARNING backup workbook at ' + pct + '% of the 10M-cell cap -- '
          + 'lower NEON_BACKUP_KEEP or start a new workbook (clear NEON_BACKUP_SS_ID)');
      }
    }

    var ms = Date.now() - t0;
    // M1: lead the outcome string with a status token (ok/FAILED). The
    // SystemHealth OPS-8 classifier treats a result as healthy iff it STARTS
    // WITH `ok` (so a designed-normal "...closed skipped" detail doesn't paint
    // the row amber). This summary was `outcomes.join(...)`, which starts with a
    // TABLE NAME and always contains the word "skipped" -- so the backup Health
    // row rendered WARN on every run, incl. fully-successful ones, masking a
    // real outage of the no-sheet-fallback tables. Prefixing a status token
    // (like the total-failure `nbRecord_('FAILED: ...')` path already does)
    // makes the shared classifier correct for backup too.
    var anyFail = outcomes.some(function (o) { return /\bFAILED\b/.test(o); });
    // BU-2 (broad-scan 2026-10-01): a near-cap workbook is not `ok` -- the
    // WARNING detail rode an `ok` prefix, so Health showed it green and the
    // ENG-2 retention gate (which prunes only after an `ok` backup) passed
    // while the next backups were heading for the cell cap. BU-3: a run cut at
    // its budget is PARTIAL. Both are bad prefixes (HEALTH_BAD_PREFIXES_), so
    // the gate holds until a complete, healthy run.
    var anyWarn = outcomes.some(function (o) { return /^WARNING\b/.test(o); });
    var status = anyFail ? 'FAILED' : budgetHit ? 'PARTIAL' : anyWarn ? 'WARN' : 'ok';
    var summary = status + ' | ' + outcomes.join(' | ') + ' | ' + ms + 'ms';
    Logger.log('runNeonBackup_: ' + summary);
    nbRecord_(summary);
  } catch (e) {
    Logger.log('runNeonBackup_ failed: ' + (e && e.message ? e.message : e));
    nbRecord_('FAILED: ' + (e && e.message ? e.message : e));
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

// ── Internals ─────────────────────────────────────────────────────────

// OPS-4: per-file size budget. Drive setContent has historically
// failed/truncated around ~10MB; stay comfortably under. Months whose
// combined rows exceed this are written as .partN.jsonl files.
var NB_FILE_BUDGET_CHARS = 8 * 1024 * 1024;

// BU-3 (broad-scan 2026-10-01): a WHOLE-RUN budget, under the ~6-minute
// execution ceiling whose kill skips every catch and records nothing (#70).
// A first seed of years of per-call months could hit it. Checked before each
// month file and each table; a run that stops records PARTIAL (a bad prefix,
// so the ENG-2 retention gate holds), and the next run resumes -- closed months
// already written are skipped. Months are taken NEWEST first, so a partial
// seed protects the most recent history first.
var NB_RUN_BUDGET_MS_ = 5 * 60 * 1000;
var NB_QUERY_TIMEOUT_S_ = 240;   // DL-3: per statement, inside NB_RUN_BUDGET_MS_

// ENG-1: a closed month's file is final once written at least this many days
// after the month closed -- covers the last day's next-morning ingest and a
// short catch-up. The previous month is therefore rewritten by the first one
// or two Saturday runs of the new month, then frozen.
var NB_FINAL_GRACE_DAYS_ = 3;

/** OPS-4: fetch one month's rows in ~week-sized date windows (4 windows:
 *  1st-8th, 9th-16th, 17th-24th, 25th-1st-of-next). Bounds every JDBC
 *  string to a fraction of the month; each window keeps the same
 *  one-string_agg-round-trip discipline. Returns one string per window
 *  ('' for empty windows). */
function nbFetchMonthChunks_(conn, spec, ym) {
  var next = nbNextMonth_(ym) + '-01';
  var bounds = [ym + '-01', ym + '-09', ym + '-17', ym + '-25', next];
  var chunks = [];
  for (var w = 0; w < bounds.length - 1; w++) {
    chunks.push(nbFetchAgg_(conn,
      "SELECT COALESCE(string_agg(row_to_json(t)::text, E'\\n'), '') AS j "
      + 'FROM (SELECT * FROM ' + spec.table
      + ' WHERE ' + spec.dateCol + ' >= ?::' + spec.cast
      + ' AND ' + spec.dateCol + ' < ?::' + spec.cast
      + ' ORDER BY ' + spec.orderBy + ') t',
      [bounds[w], bounds[w + 1]]));
  }
  return chunks;
}

/** One-string aggregate fetch (never per-row JDBC iteration). */
function nbFetchAgg_(conn, sql, params) {
  var stmt = conn.prepareStatement(sql);
  for (var i = 0; i < params.length; i++) stmt.setString(i + 1, params[i]);
  var rs = stmt.executeQuery();
  var out = rs.next() ? (rs.getString('j') || '') : '';
  rs.close(); stmt.close();
  // OD-3 (broad-scan 2026-09-17): the monthly backup is the LARGEST read of the
  // month (whole tables incl. journeys) and was unmetered -- in a backup month
  // the egress ranking named `dqe` while the backup was what tripped the cap.
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(out.length, 'backup');
  return out;
}

/** Earliest 'YYYY-MM' present in table.dateCol; null when empty. */
function nbMinMonth_(conn, table, dateCol) {
  var stmt = conn.prepareStatement(
    "SELECT to_char(MIN(" + dateCol + "), 'YYYY-MM') AS j FROM " + table);
  var rs = stmt.executeQuery();
  var ym = rs.next() ? rs.getString('j') : null;
  rs.close(); stmt.close();
  return ym || null;
}

/** Pure: inclusive 'YYYY-MM' list from `fromYm` to `toYm`. */
function nbMonthsBetween_(fromYm, toYm) {
  var out = [];
  var cur = String(fromYm || '');
  var end = String(toYm || '');
  if (!/^\d{4}-\d{2}$/.test(cur) || !/^\d{4}-\d{2}$/.test(end)) return out;
  var guard = 0;
  while (cur <= end && guard++ < 1200) {   // 100 years of months, runaway backstop
    out.push(cur);
    cur = nbNextMonth_(cur);
  }
  return out;
}

/** Pure: 'YYYY-MM' + 1 month. */
function nbNextMonth_(ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  m++;
  if (m > 12) { m = 1; y++; }
  return y + '-' + (m < 10 ? '0' + m : String(m));
}

/** Pure: ISO 'YYYY-MM-DD' shifted by `n` calendar days (UTC arithmetic, DST-proof). */
function nbAddDaysIso_(iso, n) {
  var p = String(iso || '').split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + (Number(n) || 0)));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2)
    + '-' + ('0' + d.getUTCDate()).slice(-2);
}

/**
 * ENG-1. Pure: what the backup does with a CLOSED month `ym` (< the current
 * month). `info.lastUpdatedIso` is the Drive last-updated date (script TZ) of
 * the month's file (single or part1; '' when unreadable, null when absent),
 * `info.tailUpdatedIso` the same for its `.tail.jsonl` supplement.
 *
 *   'write'   no file yet -- fetch the whole month (unchanged behaviour).
 *   'skip'    FINAL: the file (or its tail) was written at least
 *             `graceDays` after the month closed, so it saw the last day's
 *             next-morning ingest and any late re-import.
 *   'rewrite' not final, and every row of the month is still inside the
 *             retention journey horizon -- a full rewrite loses nothing.
 *   'tail'    not final, but older rows may already have had `journey`
 *             pruned, so overwriting the file would DESTROY backed-up
 *             journeys. Instead write `<table>-<ym>.tail.jsonl` with only the
 *             rows after the file's last row (the pre-ENG-1 legacy months).
 *
 * `opts.journeyDays` null/absent -> never 'rewrite' (fail toward the
 * lossless 'tail'). Two days of slack cover the prune's UTC CURRENT_DATE vs
 * the script-TZ `todayIso`.
 */
function nbClosedMonthAction_(ym, info, todayIso, opts) {
  info = info || {}; opts = opts || {};
  var grace = parseInt(opts.graceDays, 10);
  if (!isFinite(grace) || grace < 0) grace = NB_FINAL_GRACE_DAYS_;
  if (info.lastUpdatedIso === null || info.lastUpdatedIso === undefined) return 'write';
  var finalOn = nbAddDaysIso_(nbNextMonth_(ym) + '-01', grace);
  if (info.lastUpdatedIso && info.lastUpdatedIso >= finalOn) return 'skip';
  var jd = parseInt(opts.journeyDays, 10);
  if (isFinite(jd) && jd > 2 && (ym + '-01') >= nbAddDaysIso_(todayIso, -(jd - 2))) return 'rewrite';
  if (info.tailUpdatedIso && info.tailUpdatedIso >= finalOn) return 'skip';
  return 'tail';
}

/** The effective retention journey horizon (days), or null when unknown. */
function nbJourneyDays_() {
  try {
    if (typeof neonRetentionSettings_ === 'function') {
      return neonRetentionSettings_(PropertiesService.getScriptProperties()).journeyDays;
    }
  } catch (e) { /* unknown -> the lossless 'tail' path */ }
  return null;
}

function nbFirstFile_(folder, name) {
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

/** The month's single file, else its part1 (OPS-4), else null. */
function nbMonthMainFile_(folder, table, ym) {
  return nbFirstFile_(folder, table + '-' + ym + '.jsonl')
    || nbFirstFile_(folder, table + '-' + ym + '.part1.jsonl');
}

/** Drive last-updated date in script TZ; '' when it cannot be read (= not final). */
function nbFileUpdatedIso_(file) {
  try { return Utilities.formatDate(file.getLastUpdated(), TZ, 'yyyy-MM-dd'); }
  catch (e) { return ''; }
}

/**
 * ENG-1 'tail' action: back up the rows AFTER the month file's last row
 * (the file is ordered by spec.orderBy, so its last line carries the max
 * dateCol) into `<table>-<ym>.tail.jsonl`. Written even when empty -- the
 * file's timestamp is what marks the month final. Restore = month file(s)
 * + tail. Throws (-> the table's FAILED outcome) when the last row cannot
 * be read, rather than guess a cut-off and duplicate or drop rows.
 */
function nbWriteMonthTail_(conn, folder, spec, ym, mainFile, tailName) {
  var last = mainFile;
  if (/\.part1\.jsonl$/.test(mainFile.getName())) {
    for (var p = 2; ; p++) {
      var nextPart = nbFirstFile_(folder, spec.table + '-' + ym + '.part' + p + '.jsonl');
      if (!nextPart) break;
      last = nextPart;
    }
  }
  var lines = String(last.getBlob().getDataAsString() || '').split('\n')
    .filter(function (l) { return l.trim(); });
  var maxVal = null;
  try { maxVal = lines.length ? JSON.parse(lines[lines.length - 1])[spec.dateCol] : null; }
  catch (e) { maxVal = null; }
  if (maxVal === null || maxVal === undefined || maxVal === '') {
    throw new Error('tail for ' + ym + ': cannot read the last row of ' + last.getName());
  }
  var body = nbFetchAgg_(conn,
    "SELECT COALESCE(string_agg(row_to_json(t)::text, E'\\n'), '') AS j "
    + 'FROM (SELECT * FROM ' + spec.table
    + ' WHERE ' + spec.dateCol + ' > ?::' + spec.cast
    + ' AND ' + spec.dateCol + ' < ?::' + spec.cast
    + ' ORDER BY ' + spec.orderBy + ') t',
    [String(maxVal), nbNextMonth_(ym) + '-01']);
  nbWriteFile_(folder, tailName, body);
}

/**
 * Pure: given the folder's escalations snapshot FILE NAMES, returns the
 * ones to trash so only the newest `keep` remain (lexicographic date sort —
 * the ISO date in the name orders correctly).
 */
function nbSnapshotTrimList_(names, keep) {
  var snaps = (names || []).filter(function (n) {
    return /^escalations-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n);
  }).sort().reverse();
  return snaps.slice(Math.max(0, keep));
}

function nbTrimSnapshots_(folder, keep) {
  try {
    var names = [];
    var it = folder.getFiles();
    while (it.hasNext()) names.push(it.next().getName());
    var toTrash = nbSnapshotTrimList_(names, keep);
    for (var i = 0; i < toTrash.length; i++) {
      var fit = folder.getFilesByName(toTrash[i]);
      while (fit.hasNext()) fit.next().setTrashed(true);
    }
  } catch (e) { /* best-effort — retention never fails the backup */ }
}

/** Create-or-overwrite `name` in the folder. */
function nbWriteFile_(folder, name, content) {
  var it = folder.getFilesByName(name);
  if (it.hasNext()) { it.next().setContent(content); return; }
  folder.createFile(name, content, 'text/plain');
}

/**
 * The backup store for this run: { folder, label: 'drive'|'sheets', driveError? }.
 * `NEON_BACKUP_STORE=sheets` forces the Sheets store; otherwise Drive is tried
 * first and ANY failure to reach it (the Workspace Drive-permission block, a
 * trashed folder that cannot be recreated) falls back to Sheets for the whole
 * run -- a backup in a workbook beats no backup.
 */
function nbStore_() {
  var mode = '';
  try {
    mode = String(PropertiesService.getScriptProperties().getProperty('NEON_BACKUP_STORE') || '')
      .trim().toLowerCase();
  } catch (e) { mode = ''; }
  if (mode === 'sheets') return { folder: nbSheetsFolder_(), label: 'sheets' };
  try {
    return { folder: nbFolder_(), label: 'drive' };
  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    Logger.log('runNeonBackup_: Drive unavailable (' + msg + ') -- using the Sheets backup workbook.');
    return { folder: nbSheetsFolder_(), label: 'sheets', driveError: msg };
  }
}

// ── Sheets store (the Drive fallback) ─────────────────────────────────

var NB_SHEETS_WORKBOOK_NAME_ = 'Dashboard Neon Backups';
var NB_SHEETS_INDEX_TAB_ = '_index';
var NB_CELL_CHARS_ = 45000;          // under Sheets' 50,000-char per-cell cap
var NB_WRITE_BATCH_ROWS_ = 2000;     // bounds each setValues payload
var NB_SHEETS_CELL_CAP_ = 10000000;  // Google's per-workbook cap (ALLOCATED cells, #62)
var NB_SHEETS_WARN_PCT_ = 80;

/** The standing backup workbook, as a Drive-folder-shaped adapter. */
function nbSheetsFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('NEON_BACKUP_SS_ID');
  var ss = null;
  if (id) {
    // BU-1 (broad-scan 2026-10-01): NEVER recreate over a set id. Any openById
    // error -- a transient Sheets failure, or a restore run by an admin who
    // does not own the workbook ("missing ... or you don't have read access"
    // is one message for both) -- used to mint a fresh EMPTY workbook and
    // repoint the property: the history was orphaned, closed months were
    // re-fetched without their already-pruned journeys, and the run still
    // reported ok, so retention kept pruning. Apps Script cannot tell
    // "deleted" from "no access" without the Drive scope this store exists to
    // avoid, so the operator confirms instead (Operator State #28).
    try { ss = SpreadsheetApp.openById(id); }
    catch (e) {
      throw new Error('the backup workbook NEON_BACKUP_SS_ID=' + id + ' could not be opened ('
        + (e && e.message ? e.message : e) + '). NOT recreating it -- a new workbook would orphan '
        + 'the backup history. If it was deleted on purpose, clear NEON_BACKUP_SS_ID and re-run; '
        + 'otherwise run the backup as its owner or retry later.');
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(NB_SHEETS_WORKBOOK_NAME_);
    props.setProperty('NEON_BACKUP_SS_ID', ss.getId());
  }
  return nbSheetsFolderFor_(ss);
}

/**
 * Adapter exposing exactly the Drive folder/file methods runNeonBackup_ and
 * its helpers use (getId, getFilesByName, createFile, getFiles; file getName,
 * getLastUpdated, setContent, setTrashed, getBlob().getDataAsString()), plus
 * cellsUsedPct(). A "file" is a tab; `_index` holds name -> last-written ms.
 */
function nbSheetsFolderFor_(ss) {
  var idxSheet = ss.getSheetByName(NB_SHEETS_INDEX_TAB_);
  if (!idxSheet) {
    idxSheet = ss.insertSheet(NB_SHEETS_INDEX_TAB_);
    idxSheet.getRange(1, 1, 1, 2).setValues([['file', 'written (epoch ms)']]);
    // A brand-new workbook's default empty tab only costs cells (#62).
    ss.getSheets().forEach(function (sh) {
      if (sh.getName() !== NB_SHEETS_INDEX_TAB_ && sh.getLastRow() === 0) ss.deleteSheet(sh);
    });
  }
  var index = {};
  var lastIdx = idxSheet.getLastRow();
  if (lastIdx >= 2) {
    idxSheet.getRange(2, 1, lastIdx - 1, 2).getValues().forEach(function (r) {
      if (r[0]) index[String(r[0])] = Number(r[1]) || 0;
    });
  }
  var saveIndex = function () {
    var names = Object.keys(index).sort();
    var rows = [['file', 'written (epoch ms)']].concat(names.map(function (n) { return [n, index[n]]; }));
    var prevLast = idxSheet.getLastRow();
    idxSheet.getRange(1, 1, rows.length, 2).setValues(rows);
    if (prevLast > rows.length) idxSheet.getRange(rows.length + 1, 1, prevLast - rows.length, 2).clearContent();
  };
  var exists = function (name) { return (name in index) && !!ss.getSheetByName(name); };
  var fileObj = function (name) {
    return {
      getName: function () { return name; },
      getLastUpdated: function () { return new Date(index[name] || 0); },
      setContent: function (c) { nbSheetsWriteTab_(ss, name, c); index[name] = Date.now(); saveIndex(); },
      setTrashed: function () {
        var sh = ss.getSheetByName(name);
        if (sh) ss.deleteSheet(sh);
        delete index[name];
        saveIndex();
      },
      getBlob: function () { return { getDataAsString: function () { return nbSheetsReadTab_(ss, name); } }; },
    };
  };
  var iter = function (list) {
    var i = 0;
    return { hasNext: function () { return i < list.length; }, next: function () { return list[i++]; } };
  };
  return {
    getId: function () { return ss.getId(); },
    getFilesByName: function (n) { return iter(exists(n) ? [fileObj(n)] : []); },
    createFile: function (n, c) { fileObj(n).setContent(c); },
    getFiles: function () { return iter(Object.keys(index).filter(exists).map(fileObj)); },
    cellsUsedPct: function () {
      var cells = 0;
      ss.getSheets().forEach(function (sh) { cells += sh.getMaxRows() * sh.getMaxColumns(); });
      return Math.round(cells / NB_SHEETS_CELL_CAP_ * 100);
    },
  };
}

/**
 * Writes `content` (newline-separated JSON lines) into tab `name`: one line per
 * row, a line longer than one cell continues across columns. Built on a temp
 * tab and swapped in, so a failed write never leaves a half-written file under
 * the real name. Plain-text formatted first: a continuation cell can start
 * with a digit or `=`, which Sheets would otherwise coerce.
 */
function nbSheetsWriteTab_(ss, name, content) {
  var lines = String(content == null ? '' : content).split('\n').filter(function (l) { return l.length; });
  var rows = lines.map(function (l) {
    var parts = [];
    for (var i = 0; i < l.length; i += NB_CELL_CHARS_) parts.push(l.slice(i, i + NB_CELL_CHARS_));
    return parts;
  });
  var width = 1;
  rows.forEach(function (r) { if (r.length > width) width = r.length; });
  var height = Math.max(1, rows.length);
  var tmpName = name + '~writing';
  var stale = ss.getSheetByName(tmpName);
  if (stale) ss.deleteSheet(stale);
  var sh = ss.insertSheet(tmpName);
  nbSheetsSize_(sh, height, width);
  sh.getRange(1, 1, height, width).setNumberFormat('@');
  for (var b = 0; b < rows.length; b += NB_WRITE_BATCH_ROWS_) {
    var chunk = rows.slice(b, b + NB_WRITE_BATCH_ROWS_).map(function (r) {
      var padded = r.slice();
      while (padded.length < width) padded.push('');
      return padded;
    });
    sh.getRange(b + 1, 1, chunk.length, width).setValues(chunk);
  }
  var old = ss.getSheetByName(name);
  if (old) ss.deleteSheet(old);
  sh.setName(name);
}

/** Resize a tab to exactly rows x cols (allocated cells count against the cap). */
function nbSheetsSize_(sh, rows, cols) {
  var mr = sh.getMaxRows(), mc = sh.getMaxColumns();
  if (mr < rows) sh.insertRowsAfter(mr, rows - mr);
  else if (mr > rows) sh.deleteRows(rows + 1, mr - rows);
  if (mc < cols) sh.insertColumnsAfter(mc, cols - mc);
  else if (mc > cols) sh.deleteColumns(cols + 1, mc - cols);
}

/** Reads tab `name` back into the newline-joined JSON lines it was written from. */
function nbSheetsReadTab_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return '';
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 1 || lc < 1) return '';
  return sh.getRange(1, 1, lr, lc).getValues()
    .map(function (r) { return r.map(function (v) { return v == null ? '' : String(v); }).join(''); })
    .filter(function (l) { return l.length; })
    .join('\n');
}

// ── ESC-D8: scrub a deleted escalation out of the backups ─────────────
//
// Owner ruling 2026-10-02 (option C): a permanent delete must not survive in
// the backups. deleteEscalation calls nbScrubAfterDelete_ AFTER its Neon
// transaction commits and OUTSIDE the escalation write lock. The ids go on a
// queue (NEON_BACKUP_SCRUB_PENDING) FIRST, so a scrub that throws or is killed
// leaves them queued; then every `escalations-*.jsonl` snapshot and every
// `escalation_activity` month / part / tail file is rewritten without the
// rows of those ids, in EVERY store this install has written to (the Drive
// folder and the Sheets workbook -- a run that fell back to Sheets leaves the
// older Drive files behind). Ids leave the queue only once every store opened
// and every file is clean; the next backup run retries the rest, and the
// Health page's `backup-scrub` row shows what is still waiting.
//
// The ENG-1 trap: rewriting a file stamps it "last updated today", and that
// date is what marks a CLOSED month final. A closed month that is not final
// yet (still missing its last days) would be frozen short by a scrub run on or
// after its final date -- so such a file is DEFERRED, never rewritten; the
// next backup run finalizes the month from Neon (where the rows are already
// gone) before it retries the scrub. A write before the final date cannot
// mark it final, so those files are scrubbed at once.
//
// Limits (Operator State #28): Drive keeps prior revisions of a file for 30
// days and a spreadsheet keeps its version history -- the scrub rewrites the
// current content only.

var NB_SCRUB_PROP_ = 'NEON_BACKUP_SCRUB_PENDING';
var NB_SCRUB_MAX_IDS_ = 150;   // keeps the queue under the 9 KB property-value cap
var NB_SCRUB_SNAPSHOT_RE_ = /^escalations-\d{4}-\d{2}-\d{2}\.jsonl$/;
var NB_SCRUB_ACTIVITY_RE_ = /^escalation_activity-(\d{4}-\d{2})(?:\.part\d+|\.tail)?\.jsonl$/;

/** EDITOR-RUN (admin): retry the pending scrub now instead of at the next backup run. */
function runNeonBackupScrubNow() {
  assertAdmin_();
  var res = nbScrubPending_();
  Logger.log('runNeonBackupScrubNow: ' + JSON.stringify(res));
  return res;
}

/**
 * Called by deleteEscalation after the commit, with the lock released. Never
 * throws -- the delete already succeeded; a failed scrub stays queued.
 */
function nbScrubAfterDelete_(ids) {
  try {
    var clean = (ids || []).map(function (x) { return String(x || '').trim(); })
      .filter(function (x) { return x; });
    if (!clean.length) return { status: 'none', pending: nbScrubQueue_().ids.length };
    nbScrubUpdateQueue_(function (q) {
      clean.forEach(function (id) {
        if (q.ids.indexOf(id) !== -1) return;
        if (q.ids.length >= NB_SCRUB_MAX_IDS_) { q.dropped = (q.dropped || 0) + 1; return; }
        q.ids.push(id);
      });
      if (!q.since) q.since = new Date().toISOString();
      return q;
    });
    return nbScrubPending_();
  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    Logger.log('nbScrubAfterDelete_: ' + msg);
    return { status: 'queued', error: msg };
  }
}

/** The queue: { ids: [...], since, lastAttempt, lastError, dropped }. */
function nbScrubQueue_() {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty(NB_SCRUB_PROP_) || ''; } catch (e) { raw = ''; }
  var q = null;
  try { q = raw ? JSON.parse(raw) : null; } catch (e) { q = null; }
  if (!q || typeof q !== 'object') q = {};
  q.ids = Array.isArray(q.ids) ? q.ids.map(String) : [];
  return q;
}

/** Read-modify-write the queue under the script lock (an empty queue clears the property). */
function nbScrubUpdateQueue_(fn) {
  var lock = LockService.getScriptLock();
  var held = false;
  try { held = lock.tryLock(10000); } catch (e) { held = false; }
  try {
    var q = fn(nbScrubQueue_()) || { ids: [] };
    var props = PropertiesService.getScriptProperties();
    if (!q.ids.length && !q.dropped) props.deleteProperty(NB_SCRUB_PROP_);
    else props.setProperty(NB_SCRUB_PROP_, JSON.stringify(q));
    return q;
  } finally {
    if (held) { try { lock.releaseLock(); } catch (re) {} }
  }
}

/** Scrubs every queued id; dequeues them only when every store came back clean. */
function nbScrubPending_() {
  var q = nbScrubQueue_();
  if (!q.ids.length) return { status: 'none', pending: 0, dropped: q.dropped || 0 };
  var ids = q.ids.slice();
  var res;
  try {
    res = nbScrubIds_(ids, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
  } catch (e) {
    res = { ok: false, files: 0, lines: 0, deferred: [], errors: [(e && e.message) ? e.message : String(e)] };
  }
  var done = res.ok && !res.errors.length && !res.deferred.length;
  var after = nbScrubUpdateQueue_(function (cur) {
    if (done) cur.ids = cur.ids.filter(function (id) { return ids.indexOf(id) === -1; });
    cur.lastAttempt = new Date().toISOString();
    cur.lastError = done ? '' : (res.errors.concat(res.deferred.length
      ? ['deferred until the next backup run finalizes ' + res.deferred.join(', ')] : []).join('; ')).slice(0, 600);
    if (!cur.ids.length) cur.since = '';
    return cur;
  });
  return { status: done ? 'ok' : 'pending', pending: after.ids.length, dropped: after.dropped || 0,
           files: res.files, lines: res.lines, deferred: res.deferred, errors: res.errors };
}

/** The stores this install has written to (never creates one). */
function nbScrubStores_() {
  var props = PropertiesService.getScriptProperties();
  var out = { stores: [], errors: [] };
  var fid = props.getProperty('NEON_BACKUP_FOLDER_ID');
  if (fid) {
    try { out.stores.push({ label: 'drive', folder: DriveApp.getFolderById(fid) }); }
    catch (e) { out.errors.push('Drive folder ' + fid + ': ' + ((e && e.message) ? e.message : e)); }
  }
  var sid = props.getProperty('NEON_BACKUP_SS_ID');
  if (sid) {
    try { out.stores.push({ label: 'sheets', folder: nbSheetsFolderFor_(SpreadsheetApp.openById(sid)) }); }
    catch (e2) { out.errors.push('backup workbook ' + sid + ': ' + ((e2 && e2.message) ? e2.message : e2)); }
  }
  return out;
}

/**
 * Rewrites every escalation backup file without the rows of `ids`.
 * Returns { ok, files (rewritten), lines (removed), deferred: [names], errors }.
 */
function nbScrubIds_(ids, todayIso) {
  var set = {};
  ids.forEach(function (id) { set[id] = true; });
  var st = nbScrubStores_();
  var res = { ok: true, files: 0, lines: 0, deferred: [], errors: st.errors.slice() };
  var currentYm = String(todayIso).slice(0, 7);
  st.stores.forEach(function (s) {
    try {
      var names = [];
      var it = s.folder.getFiles();
      while (it.hasNext()) names.push(it.next().getName());
      names.sort().forEach(function (name) {
        var snap = NB_SCRUB_SNAPSHOT_RE_.test(name);
        var act = NB_SCRUB_ACTIVITY_RE_.exec(name);
        if (!snap && !act) return;
        var file = nbFirstFile_(s.folder, name);
        if (!file) return;
        var body = String(file.getBlob().getDataAsString() || '');
        if (!ids.some(function (id) { return body.indexOf(id) !== -1; })) return;   // cheap pre-check
        var key = snap ? 'id' : 'escalation_id';
        var removed = 0, unparsed = 0;
        var kept = body.split('\n').filter(function (l) {
          if (!l.trim()) return false;
          var row = null;
          try { row = JSON.parse(l); } catch (e) { row = null; }
          if (!row) {
            if (ids.some(function (id) { return l.indexOf(id) !== -1; })) unparsed++;
            return true;
          }
          if (set[String(row[key])]) { removed++; return false; }
          return true;
        });
        if (unparsed) res.errors.push(s.label + ' ' + name + ': ' + unparsed + ' unparseable line(s) name a deleted id');
        if (!removed) return;
        if (act && !nbScrubMonthSafe_(s.folder, act[1], currentYm, todayIso)) {
          res.deferred.push(s.label + ' ' + name);
          return;
        }
        file.setContent(kept.join('\n'));
        res.files++;
        res.lines += removed;
      });
    } catch (e) {
      res.errors.push(s.label + ': ' + ((e && e.message) ? e.message : e));
    }
  });
  if (res.errors.length) res.ok = false;
  return res;
}

/**
 * ENG-1 guard: may a scrub rewrite a file of month `ym` today? Yes for the
 * current month, for a closed month already FINAL (its main file or tail was
 * written on/after the final date), and before the final date (a write then
 * cannot mark it final). No otherwise -- the backup run must finalize it first.
 */
function nbScrubMonthSafe_(folder, ym, currentYm, todayIso) {
  if (ym >= currentYm) return true;
  var finalOn = nbAddDaysIso_(nbNextMonth_(ym) + '-01', NB_FINAL_GRACE_DAYS_);
  if (todayIso < finalOn) return true;
  var main = nbMonthMainFile_(folder, 'escalation_activity', ym);
  var tail = nbFirstFile_(folder, 'escalation_activity-' + ym + '.tail.jsonl');
  var mu = main ? nbFileUpdatedIso_(main) : '';
  var tu = tail ? nbFileUpdatedIso_(tail) : '';
  return !!((mu && mu >= finalOn) || (tu && tu >= finalOn));
}

// ── Restore (either store) ────────────────────────────────────────────

var NB_RESTORE_TABLES_ = ['escalations', 'escalation_activity', 'inbound_calls', 'outbound_calls',
                          'dept_config', 'alert_config', 'digest_config'];
var NB_RESTORE_BATCH_ = 500;

/**
 * EDITOR-RUN (admin). Loads one backed-up file back into its Neon table,
 * INSERT ... ON CONFLICT DO NOTHING, so rows still present are left alone and
 * only missing ones come back. Set the Script Property NEON_RESTORE_FILE to a
 * file name ('inbound_calls-2026-09.jsonl') or a month base ('inbound_calls-2026-09',
 * which takes the month file or its .partN files, plus any .tail file).
 * PREVIEW by default -- it reports what it would insert. Set
 * NEON_RESTORE_APPLY=true to write; both properties are cleared after an
 * applied run. Reads whichever store the backup uses (nbStore_).
 */
function restoreNeonBackupFile() {
  assertAdmin_();
  var props = PropertiesService.getScriptProperties();
  var want = String(props.getProperty('NEON_RESTORE_FILE') || '').trim();
  var apply = String(props.getProperty('NEON_RESTORE_APPLY') || '').trim().toLowerCase() === 'true';
  if (!want) {
    Logger.log('restoreNeonBackupFile: set NEON_RESTORE_FILE first (e.g. inbound_calls-2026-09).');
    return { ok: false, reason: 'NEON_RESTORE_FILE unset' };
  }
  var table = nbRestoreTableFor_(want);
  if (!table) {
    Logger.log('restoreNeonBackupFile: "' + want + '" does not name a backed-up table ('
      + NB_RESTORE_TABLES_.join(', ') + ').');
    return { ok: false, reason: 'unknown table' };
  }
  var folder = nbStore_().folder;
  var files = nbRestoreFileList_(folder, want);
  if (!files.length) {
    Logger.log('restoreNeonBackupFile: no backup file matches "' + want + '".');
    return { ok: false, reason: 'no file' };
  }
  var lines = [];
  files.forEach(function (f) {
    String(f.getBlob().getDataAsString() || '').split('\n').forEach(function (l) {
      if (l.trim()) lines.push(l.trim());
    });
  });
  var bad = 0;
  lines.forEach(function (l) { try { JSON.parse(l); } catch (e) { bad++; } });
  // ESC-D8: never restore an escalation that was deleted but is still waiting
  // to be scrubbed out of the backups.
  var skippedDeleted = 0;
  if (!bad && (table === 'escalations' || table === 'escalation_activity')) {
    var gone = {};
    nbScrubQueue_().ids.forEach(function (id) { gone[id] = true; });
    var idKey = table === 'escalations' ? 'id' : 'escalation_id';
    lines = lines.filter(function (l) {
      if (gone[String(JSON.parse(l)[idKey])]) { skippedDeleted++; return false; }
      return true;
    });
  }
  var summary = { ok: true, table: table, files: files.map(function (f) { return f.getName(); }),
                  rows: lines.length, unparseable: bad, applied: apply, inserted: 0,
                  skippedDeleted: skippedDeleted };
  if (bad) {
    summary.ok = false;
    Logger.log('restoreNeonBackupFile: ' + bad + ' line(s) are not valid JSON -- refusing to restore.');
    return summary;
  }
  if (!apply) {
    Logger.log('restoreNeonBackupFile PREVIEW: ' + lines.length + ' row(s) from ' + summary.files.join(', ')
      + ' -> ' + table + '. Rows already in Neon are skipped (ON CONFLICT DO NOTHING). '
      + (skippedDeleted ? skippedDeleted + ' row(s) of deleted escalations are left out (ESC-D8). ' : '')
      + 'Set NEON_RESTORE_APPLY=true and run again to write.');
    return summary;
  }
  var conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
  if (!conn) throw new Error('restoreNeonBackupFile: Neon unreachable/unconfigured.');
  try {
    var sql = 'INSERT INTO ' + table + ' SELECT * FROM json_populate_recordset(NULL::' + table
      + ', ?::json) ON CONFLICT DO NOTHING';
    for (var b = 0; b < lines.length; b += NB_RESTORE_BATCH_) {
      var st = conn.prepareStatement(sql);
      st.setString(1, '[' + lines.slice(b, b + NB_RESTORE_BATCH_).join(',') + ']');
      summary.inserted += st.executeUpdate() || 0;
      st.close();
    }
  } finally {
    try { conn.close(); } catch (ce) {}
  }
  props.deleteProperty('NEON_RESTORE_FILE');
  props.deleteProperty('NEON_RESTORE_APPLY');
  Logger.log('restoreNeonBackupFile: inserted ' + summary.inserted + ' of ' + lines.length
    + ' row(s) into ' + table + ' (the rest were already present).');
  return summary;
}

/** PURE: the table a backup file name belongs to (allowlisted), or null. */
function nbRestoreTableFor_(name) {
  var n = String(name || '');
  var best = null;
  NB_RESTORE_TABLES_.forEach(function (t) {
    if (n.indexOf(t + '-') === 0 && (!best || t.length > best.length)) best = t;
  });
  return best;
}

/** The file(s) a restore request names: exact, else the month base's file/parts + tail. */
function nbRestoreFileList_(folder, want) {
  var exact = nbFirstFile_(folder, want);
  if (exact) return [exact];
  var base = want.replace(/\.jsonl$/, '');
  var out = [];
  var main = nbFirstFile_(folder, base + '.jsonl');
  if (main) out.push(main);
  else {
    for (var p = 1; ; p++) {
      var part = nbFirstFile_(folder, base + '.part' + p + '.jsonl');
      if (!part) break;
      out.push(part);
    }
  }
  var tail = nbFirstFile_(folder, base + '.tail.jsonl');
  if (tail) out.push(tail);
  return out;
}

/** The backup folder — from NEON_BACKUP_FOLDER_ID, auto-created once. */
function nbFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('NEON_BACKUP_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); }
    catch (e) { /* stale id (folder trashed) — fall through and recreate */ }
  }
  var folder = DriveApp.createFolder(NEON_BACKUP_FOLDER_NAME);
  props.setProperty('NEON_BACKUP_FOLDER_ID', folder.getId());
  return folder;
}

function nbKeep_() {
  var n = parseInt(PropertiesService.getScriptProperties().getProperty('NEON_BACKUP_KEEP'), 10);
  return (isFinite(n) && n > 0) ? n : NEON_BACKUP_KEEP_DEFAULT;
}

function nbHour_() {
  var n = parseInt(PropertiesService.getScriptProperties().getProperty('NEON_BACKUP_HOUR'), 10);
  return (isFinite(n) && n >= 0 && n <= 23) ? n : NEON_BACKUP_HOUR_DEFAULT;
}

function nbRecord_(outcome) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('NEON_BACKUP_LAST', new Date().toISOString());
    props.setProperty('NEON_BACKUP_LAST_RESULT', String(outcome).slice(0, 2000));
  } catch (e) { /* best-effort */ }
}

function uninstallNeonBackupTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runNeonBackup_') ScriptApp.deleteTrigger(triggers[i]);
  }
}

function getNeonBackupStatus_() {
  var props = PropertiesService.getScriptProperties();
  var installed = false;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runNeonBackup_') { installed = true; break; }
  }
  var sheetsId = props.getProperty('NEON_BACKUP_SS_ID') || null;
  var lastResult0 = props.getProperty('NEON_BACKUP_LAST_RESULT') || '';
  return {
    installed:  installed,
    hour:       nbHour_(),
    keep:       nbKeep_(),
    folderId:   props.getProperty('NEON_BACKUP_FOLDER_ID') || null,
    // Sheets fallback: where the last run actually wrote, and the workbook link.
    store:      /\| store sheets/.test(lastResult0) ? 'sheets' : (/\| store drive/.test(lastResult0) ? 'drive' : null),
    sheetsUrl:  sheetsId ? ('https://docs.google.com/spreadsheets/d/' + sheetsId) : null,
    lastRun:    props.getProperty('NEON_BACKUP_LAST') || null,
    lastResult: props.getProperty('NEON_BACKUP_LAST_RESULT') || null,
  };
}
