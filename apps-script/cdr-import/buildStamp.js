/**
 * S6 (broad-scan 2026-08-27): the sibling-project build stamp -- the E3
 * dashboard mechanism (BuildStamp.gs) extended to cdr-import, which holds
 * half the INV-16 duplicated files and previously had NO deploy-bypass
 * detection at all: a bare `clasp push -f` from this directory skipped the
 * tests, the INV-16 guard, and the orphan check with no trace anywhere.
 *
 * HOW IT WORKS (same contract as BuildStamp.gs): this committed file holds
 * the placeholder below; scripts/deploy.sh overwrites it with the real stamp
 * (UTC time + git short SHA + branch) immediately before `clasp push -f` and
 * trap-restores the placeholder after, so the stamp lives only in the pushed
 * project. A bare push ships the placeholder -- "unstamped" IS the finding.
 *
 * SURFACE: the daily `autoImport` success Pipeline Health row appends
 * `build: <stamp>` to its note, so the Health page's pipeline section shows
 * which build produced each day's ingest with no new reader.
 */
var PROJECT_BUILD_STAMP_ = 'unstamped — last push bypassed scripts/deploy.sh';
