'use strict';

// Call_Legs_* retention prune (cdr-import/DeleteOldSheets.js, Operator State #43).
//
// This is the most destructive code in the repo and it had NO tests. It calls
// ss.deleteSheet() permanently, and the ~14-day window it enforces is
// load-bearing far past disk hygiene: the per-leg queue identity behind the
// DQE Queue Split column exists NOWHERE else, so a sheet pruned early is
// history that can never be split (Operator State #40). Two defects already
// shipped here -- C-3 (no installer or telemetry: it survived as a hand-made
// trigger invisible to the repo) and P18 (a fallback that opened the CDR
// REPORT workbook, where the Call_Legs_* tabs do not live, so the prune
// no-op'd against the wrong spreadsheet while logging a green success row).
//
// What these tests pin, in order of what a defect would cost:
//   1. non-Call_Legs sheets are untouchable       (catastrophic if broken)
//   2. the cutoff boundary + reverse-iteration    (silent early deletion)
//   3. P18 fails LOUDLY rather than reporting 0   (silent non-enforcement)
//   4. the Pipeline Health row is accurate        (the Health page's only
//                                                  proof-of-life for a prune)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({ project: 'cdr-import', files: ['DeleteOldSheets.js'] });

// ── Controlling "today" ────────────────────────────────────────────────────
// deleteOldCDRSheets() reads the wall clock via `new Date()`. loadGas shares
// the HOST Date into the vm context (so `instanceof Date` works across the
// realm), so pinning "now" means swapping ctx.Date for the call and restoring
// it after -- never leaving a fake Date installed for the next suite.
function withToday(y, m, d, fn) {
  const RealDate = h.ctx.Date;
  function FakeDate() {
    if (arguments.length === 0) return new RealDate(y, m - 1, d, 12, 0, 0);
    return new RealDate(...arguments);
  }
  FakeDate.prototype = RealDate.prototype;
  // Forward the STATICS, not just `now`. The prune calls Date.UTC to compare
  // whole calendar days; a fake that omits it fails every test at once, which
  // reads as a production regression rather than a harness gap.
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.now = function () { return new RealDate(y, m - 1, d, 12, 0, 0).getTime(); };
  h.ctx.Date = FakeDate;
  try { return fn(); } finally { h.ctx.Date = RealDate; }
}

function ssWith(names) {
  const sheets = {};
  names.forEach(function (n) { sheets[n] = [['header']]; });
  return makeFakeSpreadsheet({ sheets: sheets });
}

function liveNames(ss) {
  return ss.getSheets().map(function (s) { return s.getName(); }).sort();
}

// Runs the prune with `today` pinned, returning {result, survivors}.
function prune(today, names) {
  const ss = ssWith(names);
  h.state.spreadsheet = ss;
  const result = withToday(today[0], today[1], today[2], function () {
    return h.fn('deleteOldCDRSheets')();
  });
  return { result: result, survivors: liveNames(ss) };
}

// ── 1. Blast radius: everything that is not a dated Call_Legs tab ──────────

test('the prune NEVER touches a sheet outside the Call_Legs_ prefix', function () {
  // Every one of these is a live, load-bearing tab in the import workbook.
  const bystanders = [
    'CDR Historical Data', 'QCD Historical Data', 'DQE Historical Data',
    'Inbound Calls', 'Outbound Calls', 'Direct Call History',
    'Pipeline Health', 'Neon Mirror Queue', 'Raw Data',
    // Near-misses that must still be spared: the prefix must match at
    // position 0, and the name must carry a date-shaped suffix.
    'Archive_Call_Legs_2020-01-01',   // prefix present but not at index 0
    'Call_Legs_backup',               // right prefix, no date
  ];
  const out = prune([2026, 8, 31], bystanders.concat(['Call_Legs_2020-01-01']));

  assert.equal(out.result.deleted, 1, 'only the one genuinely-old dated tab');
  assert.deepEqual(out.survivors, bystanders.slice().sort(),
    'a non-Call_Legs sheet (or an undated one) was deleted -- this is '
    + 'unrecoverable data loss, not a hygiene bug');
});

test('out-of-range date components are REJECTED, not normalised into a real date', function () {
  // Date.UTC(2020, 12, 99) is a valid timestamp (2021-04-09) and
  // Date.UTC(2026, 98, 1) is 2034-03-01, so before the range + round-trip
  // check a nonsense suffix was aged as whatever it rolled over to -- and an
  // old-enough rollover was then DELETED on the strength of a date nobody
  // wrote. Now an unrecognised name is skipped, so it is kept.
  const out = prune([2026, 8, 31], [
    'Call_Legs_2020-13-99',   // month + day both out of range
    'Call_Legs_2026-99-01',   // month out of range
    'Call_Legs_2026-00-10',   // month zero
    'Call_Legs_2026-06-00',   // day zero
    'Call_Legs_2026-02-30',   // in range per component, but Feb has no 30th
    'Call_Legs_2026-04-31',   // April has no 31st
  ]);
  assert.equal(out.result.deleted, 0, 'a tab was deleted on a date that does not exist');
  assert.equal(out.result.kept, 0, 'rejected names are skipped, so they count '
    + 'as neither deleted nor kept');
  assert.equal(out.survivors.length, 6);
});

test('a real leap day is NOT rejected by the round-trip check', function () {
  // Guards the guard: an over-strict validator that rejected Feb 29 would
  // silently stop pruning one day a year, and nothing else would notice.
  const out = prune([2028, 4, 1], ['Call_Legs_2028-02-29']);
  assert.equal(out.result.deleted, 1, '2028 is a leap year -- Feb 29 is real');
});

test('a Call_Legs tab whose date will not parse is KEPT, not guessed at', function () {
  // Failing safe matters more than pruning tidily: keeping a stray sheet
  // costs disk, deleting an unrecognized one costs history.
  const out = prune([2026, 8, 31], [
    'Call_Legs_', 'Call_Legs_2026', 'Call_Legs_26-01-01', 'Call_Legs_not-a-date',
  ]);
  assert.equal(out.result.deleted, 0);
  assert.equal(out.result.kept, 0, 'unparseable names are skipped entirely, '
    + 'so they count as neither deleted nor kept');
  assert.equal(out.survivors.length, 4);
});

// ── 2. The cutoff boundary ────────────────────────────────────────────────

test('the 14-day cutoff is EXCLUSIVE: exactly 14 days old survives, 15 does not', function () {
  // today = 2026-08-31, no DST transition in this span (see the DST test below).
  const out = prune([2026, 8, 31], [
    'Call_Legs_2026-08-31',   //  0d
    'Call_Legs_2026-08-30',   //  1d
    'Call_Legs_2026-08-18',   // 13d
    'Call_Legs_2026-08-17',   // 14d  <- boundary: KEPT
    'Call_Legs_2026-08-16',   // 15d  <- first deleted
    'Call_Legs_2026-08-01',   // 30d
  ]);
  assert.deepEqual(out.survivors, [
    'Call_Legs_2026-08-17', 'Call_Legs_2026-08-18',
    'Call_Legs_2026-08-30', 'Call_Legs_2026-08-31',
  ], 'the boundary moved -- a day of leg-level queue identity is at stake '
    + 'on each side of it');
  assert.equal(out.result.deleted, 2);
  assert.equal(out.result.kept, 4);
});

test('a FUTURE-dated tab is kept (negative age never crosses the cutoff)', function () {
  const out = prune([2026, 8, 31], ['Call_Legs_2026-09-05']);
  assert.equal(out.result.deleted, 0);
  assert.equal(out.result.kept, 1);
});

test('a bulk run deletes every eligible tab and no ineligible one', function () {
  // Twenty eligible tabs interleaved with twenty ineligible ones, so a
  // partial sweep shows up as a count mismatch rather than hiding in a
  // single-tab fixture.
  //
  // Note on the source's reverse iteration: it is defensive but not
  // load-bearing. getSheets() hands back a SNAPSHOT array, so deleting a
  // sheet cannot shift the un-visited entries, and this test passes with the
  // loop run forwards -- verified by mutation. Said plainly because a comment
  // claiming this guards an index-shift bug would be describing a hazard the
  // API's semantics rule out.
  const TODAY = [2026, 9, 20];
  const names = [];
  const expectDeleted = [];
  // Derive the expectation from the age rule independently of the code under
  // test, so this stays a cross-check rather than a transcription of it.
  for (let d = 1; d <= 20; d++) {
    [['08', d], ['09', d]].forEach(function (pair) {
      const name = 'Call_Legs_2026-' + pair[0] + '-' + String(pair[1]).padStart(2, '0');
      names.push(name);
      const age = (new Date(TODAY[0], TODAY[1] - 1, TODAY[2])
        - new Date(2026, Number(pair[0]) - 1, pair[1])) / 86400000;
      if (age > 14) expectDeleted.push(name);
    });
  }
  const out = prune(TODAY, names);

  assert.equal(out.result.deleted, expectDeleted.length,
    'partial sweep: deleted ' + out.result.deleted + ' of '
    + expectDeleted.length + ' eligible tabs');
  expectDeleted.forEach(function (n) {
    assert.ok(out.survivors.indexOf(n) === -1, n + ' should have been pruned');
  });
  assert.equal(out.survivors.length, names.length - expectDeleted.length);
});

test('returned counts are exact -- the Pipeline Health row reports them verbatim', function () {
  const out = prune([2026, 8, 31], [
    'Call_Legs_2026-08-30', 'Call_Legs_2026-08-29',    // kept
    'Call_Legs_2026-07-01', 'Call_Legs_2026-06-01',    // deleted
    'CDR Historical Data',                             // neither
  ]);
  assert.deepEqual({ deleted: out.result.deleted, kept: out.result.kept },
    { deleted: 2, kept: 2 },
    'runRetentionPrune_ logs res.deleted as the row\'s `rows` value, so a '
    + 'miscount makes the Health page report a prune that did not happen');
});

// ── 3. P18: the unbound context must FAIL LOUDLY ──────────────────────────

test('P18: no active spreadsheet THROWS rather than silently pruning nothing', function () {
  h.state.spreadsheet = null;
  assert.throws(function () { h.fn('deleteOldCDRSheets')(); }, /no active spreadsheet/i,
    'the pre-P18 code fell back to the CDR REPORT workbook, where no '
    + 'Call_Legs_* tab exists -- the prune no-op\'d while reporting success '
    + 'and the retention window silently stopped being enforced. Failing '
    + 'loudly is the fix; a caught-and-logged 0 is the bug.');
});

// ── 4. The Pipeline Health row (the only proof-of-life a prune has) ────────

function captureHealthRows(fn) {
  const rows = [];
  const prev = h.ctx.logPipelineHealthWithFallback_;
  h.ctx.logPipelineHealthWithFallback_ = function (ss, row) { rows.push(row); };
  try { fn(); } finally { h.ctx.logPipelineHealthWithFallback_ = prev; }
  return rows;
}

test('runRetentionPrune_ logs a success row carrying the deleted count', function () {
  h.state.spreadsheet = ssWith([
    'Call_Legs_2026-08-30', 'Call_Legs_2026-06-01', 'Call_Legs_2026-06-02',
  ]);
  const rows = captureHealthRows(function () {
    withToday(2026, 8, 31, function () { h.fn('runRetentionPrune_')(); });
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, 'retentionPrune',
    'the step name is the vocabulary the Health page and PipelineWatch match on');
  assert.equal(rows[0].status, 'success');
  assert.equal(rows[0].rows, 2, 'rows carries the DELETED count');
  assert.match(rows[0].notes, /within the 14d window/);
});

test('runRetentionPrune_ turns a throw into a FAILURE row and does not rethrow', function () {
  // A trigger handler that throws produces an Apps Script failure email but
  // no Pipeline Health row -- so the Health page would show the prune as
  // merely absent, indistinguishable from a trigger that was never installed.
  h.state.spreadsheet = null;   // drives the P18 throw
  let rows;
  assert.doesNotThrow(function () {
    rows = captureHealthRows(function () { h.fn('runRetentionPrune_')(); });
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failure');
  assert.match(rows[0].notes, /no active spreadsheet/i);
});

test('runRetentionPrune_ survives a Pipeline Health logger that is absent or throws', function () {
  // Telemetry is best-effort by design: losing the row must never cost the
  // prune, and must never leave the trigger in a throwing state.
  h.state.spreadsheet = ssWith(['Call_Legs_2026-06-01']);
  const prev = h.ctx.logPipelineHealthWithFallback_;

  h.ctx.logPipelineHealthWithFallback_ = undefined;   // absent
  assert.doesNotThrow(function () {
    withToday(2026, 8, 31, function () { h.fn('runRetentionPrune_')(); });
  });

  h.state.spreadsheet = ssWith(['Call_Legs_2026-06-01']);
  h.ctx.logPipelineHealthWithFallback_ = function () { throw new Error('sheet locked'); };
  assert.doesNotThrow(function () {
    withToday(2026, 8, 31, function () { h.fn('runRetentionPrune_')(); });
  });
  h.ctx.logPipelineHealthWithFallback_ = prev;
});

// ── 5. DST: the cutoff is fractional-day arithmetic on LOCAL midnights ─────

// Runs `fn` under a DST-observing zone. The prune compares two local
// midnights and divides by a fixed 86_400_000, so the result is only an
// integer when no transition falls inside the window. Under the host's UTC
// this whole class of behaviour is unobservable -- which is why the zone is
// forced here rather than inherited, and asserted to have taken effect so
// the test can never pass vacuously.
function inZone(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, tz,
    'the process timezone did not take effect -- this test would otherwise '
    + 'assert nothing at all');
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
}

test('a window spanning the FALL-BACK transition still keeps a 14-day-old tab', function () {
  // The regression this replaced a characterization test for. US fall-back
  // 2026 is Nov 1, so Oct 25 -> Nov 8 contains a 25-hour day. The old
  // arithmetic divided a local-midnight millisecond difference by 86_400_000
  // and got 14.0417, clearing `> 14` and pruning a day EARLY -- the effective
  // window narrowed to 13 days for ~2 weeks each November. Comparing whole
  // calendar days via Date.UTC removes the offset, so the boundary holds in
  // every zone and season.
  inZone('America/Chicago', function () {
    const out = prune([2026, 11, 8], ['Call_Legs_2026-10-25']);
    assert.equal(out.result.deleted, 0,
      'a 14-day-old tab was pruned across the fall-back transition -- the '
      + 'DST-sensitive fractional-day arithmetic is back');
    assert.equal(out.result.kept, 1);
  });
});

test('the day AFTER the cutoff still prunes across the fall-back transition', function () {
  // The other side of the same boundary: the fix must not simply stop
  // deleting near a transition, or retention quietly grows without bound.
  inZone('America/Chicago', function () {
    const out = prune([2026, 11, 9], ['Call_Legs_2026-10-25']);   // 15 days
    assert.equal(out.result.deleted, 1);
  });
});

test('the same 14-day span with no transition inside it KEEPS the tab', function () {
  // The control for the test above: same zone, same 14-day age, no
  // transition in the window -- so the early deletion is attributable to
  // DST and not to an off-by-one in the cutoff itself.
  inZone('America/Chicago', function () {
    const out = prune([2026, 8, 31], ['Call_Legs_2026-08-17']);
    assert.equal(out.result.deleted, 0);
    assert.equal(out.result.kept, 1);
  });
});

test('spring-forward errs the safe way: a 14-day-old tab is still kept', function () {
  // US spring-forward 2026 is Mar 8; the 23-hour day yields 13.958, which
  // fails `> 14`. Erring toward keeping is the harmless direction, and
  // pinning it documents that the two transitions are NOT symmetric.
  inZone('America/Chicago', function () {
    const out = prune([2026, 3, 14], ['Call_Legs_2026-02-28']);
    assert.equal(out.result.deleted, 0);
    assert.equal(out.result.kept, 1);
  });
});
