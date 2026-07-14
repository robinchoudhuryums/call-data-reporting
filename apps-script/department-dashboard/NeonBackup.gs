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
 *     rows): a CLOSED month whose file already exists is skipped; the
 *     current month is rewritten each run.
 *   - inbound_calls-<YYYY-MM>.jsonl         Same monthly scheme (rows for a
 *     date can be refreshed by a re-import, but only current-ish dates are
 *     ever rewritten, so closed months are stable).
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
 * props. Install/uninstall are admin-gated; the trigger target is
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
  return getNeonBackupStatus_();
}

function installNeonBackupTrigger() {
  assertAdmin_();
  uninstallNeonBackupTrigger_();
  var hour = nbHour_();
  ScriptApp.newTrigger('runNeonBackup_').timeBased()
    .everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(hour).create();
  return getNeonBackupStatus_();
}

function uninstallNeonBackupTrigger() {
  assertAdmin_();
  uninstallNeonBackupTrigger_();
  return getNeonBackupStatus_();
}

/** Manual one-shot backup (admin) — run after deploying to seed the folder. */
function runNeonBackupNow() {
  assertAdmin_();
  runNeonBackup_();
  return getNeonBackupStatus_();
}

// ── Trigger entry point ───────────────────────────────────────────────

function runNeonBackup_() {
  var t0 = Date.now();
  var outcomes = [];
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) {
      nbRecord_('skipped (Neon unreachable/unconfigured)');
      return;
    }
    var folder = nbFolder_();
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
    ];
    for (var m = 0; m < monthlies.length; m++) {
      var spec = monthlies[m];
      try {
        var firstYm = nbMinMonth_(conn, spec.table, spec.dateCol);
        if (!firstYm) { outcomes.push(spec.table + ' empty'); continue; }
        var months = nbMonthsBetween_(firstYm, currentYm);
        var written = 0, skipped = 0;
        for (var i = 0; i < months.length; i++) {
          var ym = months[i];
          var name = spec.table + '-' + ym + '.jsonl';
          // OPS-4: a month already written as split parts also counts as
          // closed (the single-name check alone would refetch it forever).
          if (ym < currentYm && (folder.getFilesByName(name).hasNext()
              || folder.getFilesByName(spec.table + '-' + ym + '.part1.jsonl').hasNext())) {
            skipped++; continue;
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
          }
          written++;
        }
        outcomes.push(spec.table + ' ok (' + written + ' month file(s) written, ' + skipped + ' closed skipped)');
      } catch (e2) {
        outcomes.push(spec.table + ' FAILED: ' + (e2 && e2.message ? e2.message : e2));
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
    var summary = (anyFail ? 'FAILED' : 'ok') + ' | ' + outcomes.join(' | ') + ' | ' + ms + 'ms';
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
  return {
    installed:  installed,
    hour:       nbHour_(),
    keep:       nbKeep_(),
    folderId:   props.getProperty('NEON_BACKUP_FOLDER_ID') || null,
    lastRun:    props.getProperty('NEON_BACKUP_LAST') || null,
    lastResult: props.getProperty('NEON_BACKUP_LAST_RESULT') || null,
  };
}
