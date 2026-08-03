'use strict';

// F8 split guard. CLAUDE.md hit ~372 KB and is injected into EVERY session's
// context, so four reference sections were moved into docs/ with a one-line
// index left behind:
//
//   Invariant Library       -> docs/invariants.md
//   Regression Scenarios    -> docs/regression-scenarios.md
//   Operator State items    -> docs/operator-state.md
//   client/UI gotchas       -> docs/client-ui-conventions.md
//
// That split creates ONE new failure mode that did not exist before: the index
// and the full text can drift. A new INV added to docs/invariants.md but not to
// the index is invisible to anyone reading CLAUDE.md; an index line for an INV
// that no longer exists sends a reader looking for nothing. Both are silent.
// This test makes either a CI failure.
//
// It checks IDs and subsystem/title strings, NOT prose -- the index line is
// deliberately a summary of the entry, so their bodies must be allowed to differ.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const CLAUDE = read('CLAUDE.md');

// Everything under a heading, up to the next heading at the SAME level or
// shallower (so a `##` section keeps its `###` subsections -- "Read first" has
// them). Scopes an index lookup to its own section, so an `INV-` reference
// elsewhere in CLAUDE.md can't stand in for a missing index line.
function section(text, heading) {
  const start = text.indexOf('\n' + heading + '\n');
  assert.notEqual(start, -1, 'CLAUDE.md is missing the "' + heading + '" heading');
  const depth = /^#+/.exec(heading)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp('\\n#{1,' + depth + '} '));
  return end === -1 ? rest : rest.slice(0, end);
}

// `... | Subsystem: X` -- take the LAST occurrence and drop a trailing pipe,
// because several entries contain `|` inside the body (INV-54 lists sheet
// columns pipe-separated) and two end with a stray trailing `|`.
function subsystemOf(line) {
  const i = line.lastIndexOf('| Subsystem:');
  if (i === -1) return null;
  return line.slice(i + '| Subsystem:'.length).replace(/\s*\|\s*$/, '').trim();
}

function idMap(text, re) {
  const out = {};
  text.split('\n').forEach(function (line) {
    const m = re.exec(line);
    if (m) out[m[1]] = line;
  });
  return out;
}

test('F8 split: CLAUDE.md points at every split file', function () {
  ['docs/invariants.md', 'docs/regression-scenarios.md', 'docs/operator-state.md',
   'docs/client-ui-conventions.md'].forEach(function (rel) {
    assert.ok(CLAUDE.indexOf(rel) !== -1,
      'CLAUDE.md no longer links ' + rel + ' -- the split content is unreachable '
      + 'for anyone reading CLAUDE.md. Restore the pointer.');
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' is missing');
    // The "Read first" nav block is the entry point a fresh session uses.
    assert.ok(section(CLAUDE, '## Read first').indexOf(rel) !== -1,
      rel + ' is linked somewhere in CLAUDE.md but not from "Read first" -- add it '
      + 'there so a fresh session can find it.');
  });
});

test('F8 split: the Invariant Library index matches docs/invariants.md', function () {
  const idx = idMap(section(CLAUDE, '### Invariant Library'), /^(INV-\d+) \| /);
  const doc = idMap(read('docs/invariants.md'), /^(INV-\d+) \| /);

  const idxIds = Object.keys(idx).sort();
  const docIds = Object.keys(doc).sort();
  assert.deepEqual(idxIds, docIds,
    'invariant IDs differ.\n  only in CLAUDE.md index: '
    + idxIds.filter(function (k) { return !doc[k]; }).join(', ')
    + '\n  only in docs/invariants.md: '
    + docIds.filter(function (k) { return !idx[k]; }).join(', ')
    + '\n  A new invariant must be added to BOTH (full text in the doc, one-line'
    + ' summary in the CLAUDE.md index).');

  idxIds.forEach(function (id) {
    assert.equal(subsystemOf(idx[id]), subsystemOf(doc[id]),
      id + ': the index Subsystem disagrees with docs/invariants.md '
      + '(index="' + subsystemOf(idx[id]) + '", doc="' + subsystemOf(doc[id]) + '")');
  });
});

test('F8 split: the Regression Scenarios index matches docs/regression-scenarios.md', function () {
  const re = /^(S\d+) \| (.*?) \| Subsystem: (.*)$/;
  function parse(text) {
    const out = {};
    text.split('\n').forEach(function (line) {
      const m = re.exec(line);
      if (m) out[m[1]] = { title: m[2].trim(), sub: m[3].trim() };
    });
    return out;
  }
  const idx = parse(section(CLAUDE, '### Regression Scenarios'));
  const doc = parse(read('docs/regression-scenarios.md'));

  const idxIds = Object.keys(idx).sort();
  const docIds = Object.keys(doc).sort();
  assert.deepEqual(idxIds, docIds,
    'scenario IDs differ.\n  only in CLAUDE.md index: '
    + idxIds.filter(function (k) { return !doc[k]; }).join(', ')
    + '\n  only in docs/regression-scenarios.md: '
    + docIds.filter(function (k) { return !idx[k]; }).join(', '));

  idxIds.forEach(function (id) {
    // Scenario titles are copied verbatim into the index (unlike invariants,
    // whose index line is a summary), so these must match exactly.
    assert.equal(idx[id].title, doc[id].title,
      id + ': index title "' + idx[id].title + '" != doc title "' + doc[id].title + '"');
    assert.equal(idx[id].sub, doc[id].sub, id + ': Subsystem differs');
  });
});

test('F8 split: the Operator State index matches docs/operator-state.md', function () {
  const idxNums = section(CLAUDE, '## Operator State Checklist')
    .split('\n').map(function (l) { return /^(\d+)\. /.exec(l); })
    .filter(Boolean).map(function (m) { return Number(m[1]); });
  const docNums = read('docs/operator-state.md')
    .split('\n').map(function (l) { return /^(\d+)\. /.exec(l); })
    .filter(Boolean).map(function (m) { return Number(m[1]); });

  assert.deepEqual(idxNums, docNums,
    'operator-state item numbers differ between the CLAUDE.md index and '
    + 'docs/operator-state.md -- index=[' + idxNums.join(',') + '] doc=['
    + docNums.join(',') + ']');
  // Items are cited BY NUMBER across the repo ("Operator State #38"), so a gap
  // or reorder silently redirects those citations.
  idxNums.forEach(function (n, i) {
    assert.equal(n, i + 1,
      'operator-state numbering must stay contiguous from 1 (found ' + n
      + ' at position ' + (i + 1) + '). Items are cited by number -- retire one '
      + 'in place rather than renumbering.');
  });
});

// The tripwire F8 actually needs. CLAUDE.md regrew from 357 KB to 372 KB over a
// single cycle, one reasonable-looking paragraph at a time, and nothing noticed.
// The cap is generous (current ~152 KB) so ordinary rule additions never trip
// it; crossing it means it is time to split again, not to raise the number
// reflexively.
test('F8 split: CLAUDE.md stays under the size budget', function () {
  const MAX = 200 * 1024;
  const bytes = Buffer.byteLength(CLAUDE, 'utf8');
  assert.ok(bytes <= MAX,
    'CLAUDE.md is ' + Math.round(bytes / 1024) + ' KB, over the ' + (MAX / 1024)
    + ' KB budget. It is injected into EVERY session\'s context, so size is a '
    + 'real cost. Move a reference section into docs/ with an index (the F8 '
    + 'pattern: docs/invariants.md, docs/operator-state.md, '
    + 'docs/regression-scenarios.md, docs/client-ui-conventions.md) rather than '
    + 'raising this number.');
});

// ── Per-bullet ratchet ─────────────────────────────────────────────────────
//
// The whole-file size cap above is a CLIFF: it fires at 200 KB, by which point
// the fix is an emergency reorganisation mid-task. It also fires on the wrong
// author -- whoever happens to add the last paragraph, not whoever has been
// growing a bullet for weeks.
//
// The measured growth pattern says that is the wrong shape. Between the F8
// split and 2026-08-03 CLAUDE.md went 149.6 KB -> 178.1 KB, and Common Gotchas
// gained only TWO bullets in that time: ~77% of its growth was EXISTING bullets
// accreting prose. So the useful signal is per-bullet, and it should fire in
// the commit that grows one, while the author still has the context to decide
// what is a RULE (stays) and what is the incident that taught it (belongs in
// docs/fix-history.md).
//
// Design: a RATCHET, not a flat cap. New bullets must come in under
// MAX_BULLET_BYTES. The bullets already over it are grandfathered at their
// measured size and may only SHRINK -- growing one fails, and every extraction
// pass tightens its own budget automatically. Lower a number here when you
// shrink a bullet; never raise one to make room for new prose.
//
// The seeds below were measured at the CLOSE of the 2026-08-03 extraction pass,
// not during it. That distinction earned itself: a mid-edit snapshot made the
// ratchet fire on its own author when a separate token-loss check then required
// restoring three dropped identifiers, and the tempting fix -- shaving unrelated
// prose until an arbitrary number was satisfied -- would have been the ratchet
// causing exactly the damage it exists to prevent. Re-seed from a finished
// state; shave prose only when the prose is the problem. Take the number from
// THIS test's failure message, not from a side script -- a measuring script
// that trims trailing whitespace differently is off by a byte, and chasing
// that is the same wasted motion in miniature.
//
// Both PROSE sections are ratcheted, not just Common Gotchas. Key Design
// Decisions was 41.4 KB (23% of the file) and had the same shape -- phased
// rollouts amended per phase, and paragraphs duplicating what
// docs/client-ui-conventions.md already says. Leaving it uncovered would have
// meant the guard watched one growth surface while the other regrew freely.
const MAX_BULLET_BYTES = 4096;
const SECTIONS = [
  {
    heading: '\n## Common Gotchas',
    endHeading: '\n## Key Design Decisions',
    grandfathered: {
      'Inbound-call capture is Neon-only and rides the daily import.': 12834,
      'Role model + the all-departments manager (`allDepts`).': 6160,
      'Neon read-back (F1) is flag-gated and defaults OFF.': 5554,
      "Neon write discipline (don't regress this — it caused a daily-import\n  timeout).": 4896,
      'Direct-extension call metrics are a separate population from the\n  DQE/QCD queue metrics, with a "busy" carve-out.': 4848,
    },
  },
  {
    heading: '\n## Key Design Decisions',
    endHeading: '\n## Operator State Checklist',
    grandfathered: {
      'Sub-queue combined view on My Department (Phase 1).': 7547,
    },
  },
];

function sectionBullets(section) {
  const i = CLAUDE.indexOf(section.heading);
  const j = CLAUDE.indexOf(section.endHeading);
  assert.ok(i !== -1 && j > i,
    'headings not found: ' + section.heading.trim() + ' .. ' + section.endHeading.trim());
  const body = CLAUDE.slice(i, j);
  const starts = [];
  const rx = /^- \*\*/gm;
  let m;
  while ((m = rx.exec(body)) !== null) starts.push(m.index);
  starts.push(body.length);
  const out = [];
  for (let k = 0; k < starts.length - 1; k++) {
    const text = body.slice(starts[k], starts[k + 1]);
    const title = text.split('**')[1].trim();
    out.push({ title: title, bytes: Buffer.byteLength(text, 'utf8') });
  }
  return out;
}

test('F8 split: no NEW prose bullet exceeds the per-bullet budget', function () {
  const oversized = [];
  SECTIONS.forEach(function (section) {
    sectionBullets(section).forEach(function (b) {
      if (b.bytes > MAX_BULLET_BYTES
          && !Object.prototype.hasOwnProperty.call(section.grandfathered, b.title)) {
        oversized.push(section.heading.trim() + ' :: ' + b.title + ' (' + b.bytes + 'B)');
      }
    });
  });
  assert.deepEqual(oversized, [],
    'A CLAUDE.md bullet is over ' + MAX_BULLET_BYTES + ' bytes. That is '
    + 'usually a sign the RULE has been buried in the story of the incident that '
    + 'produced it. Move the narrative to docs/fix-history.md under the fix code '
    + 'it already cites and leave the rule + a pointer, per the "one bullet, one '
    + 'rule" note at the top of Common Gotchas. If the bullet describes how a '
    + 'CLIENT surface is built, docs/client-ui-conventions.md is its home. If it '
    + 'genuinely is all rule, add it to that section\'s grandfathered map with '
    + 'its measured size.');
});

test('F8 split: grandfathered bullets may only SHRINK', function () {
  const grown = [], gone = [];
  SECTIONS.forEach(function (section) {
    const bySize = {};
    sectionBullets(section).forEach(function (b) { bySize[b.title] = b.bytes; });
    Object.keys(section.grandfathered).forEach(function (title) {
      if (!(title in bySize)) { gone.push(title); return; }
      if (bySize[title] > section.grandfathered[title]) {
        grown.push(title + ': ' + section.grandfathered[title] + 'B -> ' + bySize[title] + 'B');
      }
    });
  });
  assert.deepEqual(grown, [],
    'A grandfathered bullet GREW. These are the biggest bullets in the file '
    + 'and the ratchet exists so they can only go down: put the addition in '
    + 'docs/fix-history.md, or shrink something else in the same bullet first.');
  assert.deepEqual(gone, [],
    'A GRANDFATHERED title no longer matches any bullet -- if you renamed or '
    + 'removed it, update the map (and lower the number if it shrank).');
});
