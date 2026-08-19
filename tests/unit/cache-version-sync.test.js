'use strict';

// Cache-version sync guard (extends CI; runs under the existing `node --test`
// step). The audit's F1 finding was that docs/ tables, CLAUDE.md INV-30, and
// inline .gs comments had drifted a full version behind the actual cache-key
// constants (summary v8->v9, companyOverview v14->v15, qcd v6->v7,
// insights v3->v6). This test makes that drift a CI failure instead of a
// silent trap for the next developer.
//
// NOTE for the next bump author (learned in the B-4 v7->v8 bump): the
// every-mention check below flags HISTORICAL citations too ("shipped in
// `inbound:v7`") -- rephrase those off the prefix pattern up front (e.g.
// "the inbound v7 bump") instead of chasing one failure per doc file.
//
// Design: the CANONICAL version for each report is EXTRACTED from the code's
// cache-key literal (never hardcoded here), so the test self-updates when a
// prefix is bumped -- it only fails when the docs/comments disagree with the
// code. Two checks:
//   (1) every prefix-qualified `prefix:vN` mention (real digit) across the
//       dashboard .gs files + the four docs equals the canonical version;
//   (2) the markdown cache-version TABLES in known-issues.md / conventions.md
//       (a `prefix:vN:` template cell + a `vN` version cell on one row) list
//       the canonical version.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DASH = path.join(ROOT, 'apps-script', 'department-dashboard');

function read(rel, base) { return fs.readFileSync(path.join(base || ROOT, rel), 'utf8'); }

// [prefix, source file, regex capturing the version from the cache-key LITERAL
// that constructs the key]. Anchored on the quoted literal so the version
// history in nearby comments (bare `v8:` etc.) is ignored.
const SPECS = [
  ['summary',           'Data.gs',                /'summary:v(\d+):'/],
  ['latestDate',        'Data.gs',                /'latestDate:v(\d+):'/],
  ['latestDates',       'Data.gs',                /'latestDates:v(\d+):'/],
  ['individual',        'IndividualReport.gs',    /'individual:v(\d+)'/],
  ['individual_active', 'Util.gs',                /'individual_active:v(\d+):'/],
  // 'performance' retired with the Performance Report (PR->Insights
  // consolidation) -- PerformanceReport.gs was deleted; Insights carries
  // the team rollup + Absolute volume chart + share donut.
  // 'compareRanges' retired with the Compare Ranges report (CR->Insights
  // consolidation) -- CompareRangesReport.gs was deleted; Insights covers
  // arbitrary two-window comparison via its custom prior mode + the
  // vs-Prior chart basis.
  ['missed',            'MissedCallsReport.gs',   /'missed:v(\d+):'/],
  ['companyOverview',   'CompanyOverview.gs',     /'companyOverview:v(\d+)'/],
  // 'qcd' retired with the QCD modal (QCD->Insights consolidation) --
  // only the all-departments 'qcdAll' prefix remains in QCDReport.gs.
  ['qcdAll',            'QCDReport.gs',           /'qcdAll:v(\d+)'/],
  ['inbound',           'InboundReport.gs',       /'inbound:v(\d+)'/],
  ['inboundHeatmap',    'InboundReport.gs',       /'inboundHeatmap:v(\d+)'/],
  ['insights',          'InsightsReport.gs',      /'insights:v(\d+)'/],
  ['directCall',        'DirectCallReport.gs',    /'directCall:v(\d+)'/],
  // B5 (broad-scan F3b): the agent-role prefixes were added to
  // docs/invariants.md's INV-30 list but never to THIS list, so they were
  // documented and unenforced -- the one combination the suite exists to
  // prevent. `agentHome` is a named constant; `agentHist` is inline.
  ['agentHome',         'AgentHome.gs',           /AGENT_HOME_CACHE_PREFIX_ = 'agentHome:v(\d+)'/],
  ['agentHist',         'AgentHome.gs',           /'agentHist:v(\d+):'/],
];

// Build the canonical map from code at load time so every test sees it.
const canonical = {};
SPECS.forEach(function (s) {
  const prefix = s[0], file = s[1], re = s[2];
  const m = re.exec(read(file, DASH));
  if (!m) {
    throw new Error('cache-version-sync: could not find the cache-key literal for "'
      + prefix + '" in ' + file + ' -- was the constant renamed? Update SPECS.');
  }
  canonical[prefix] = Number(m[1]);
});

// Files whose prefix-qualified mentions must agree with the code.
const GS_FILES = fs.readdirSync(DASH).filter(function (f) { return /\.gs$/.test(f); });
// EXPLICIT list, not a docs/*.md glob, and that is deliberate: docs/fix-history.md
// and the design specs are ARCHIVES -- they legitimately name past versions
// ("insights:v18 -> v19", "missed:v14 at the time") and a glob would fail on
// them. Only CURRENT-TRUTH docs belong here.
//
// F8 note: docs/invariants.md carries INV-30 -- the cache-version table itself,
// and the single densest source of `prefix:vN` claims in the repo. It was inside
// CLAUDE.md until the F8 split, so leaving it off this list would have silently
// gutted this guard's coverage the day the split landed. Any future section that
// moves OUT of CLAUDE.md and states a current cache version must be added here.
const DOC_FILES = ['CLAUDE.md', 'docs/invariants.md', 'docs/operator-state.md',
  'docs/client-ui-conventions.md', 'docs/regression-scenarios.md',
  'docs/known-issues.md', 'docs/conventions.md', 'docs/architecture.md'];

test('cache-version sync: code defines a version for every tracked prefix', function () {
  SPECS.forEach(function (s) {
    assert.equal(typeof canonical[s[0]], 'number',
      'no canonical version extracted for ' + s[0]);
  });
});

test('cache-version sync: every prefix-qualified mention matches the code', function () {
  const targets = GS_FILES.map(function (f) { return { name: 'apps-script/department-dashboard/' + f, base: DASH, rel: f }; })
    .concat(DOC_FILES.map(function (f) { return { name: f, base: ROOT, rel: f }; }));

  Object.keys(canonical).forEach(function (prefix) {
    const want = canonical[prefix];
    // Prefix-qualified with a REAL digit. `latestDate` won't match inside
    // `latestDates` (and `individual` won't match inside `individual_active`)
    // because the char after the prefix there is not ":".
    const re = new RegExp(prefix + ':v(\\d+)', 'g');
    targets.forEach(function (t) {
      const text = read(t.rel, t.base);
      let m;
      while ((m = re.exec(text)) !== null) {
        // Skip the "from" side of a version-history bump narrative, written
        // in this repo as "`prefix:vOLD` -> `vNEW`" (CLAUDE.md Common
        // Gotchas). Those legitimately reference past versions; only the
        // current-version CLAIMS (no trailing arrow) must equal canonical.
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
        if (/^`?\s*(->|→|=>)/.test(after)) continue;
        assert.equal(Number(m[1]), want,
          t.name + ' mentions ' + prefix + ':v' + m[1]
          + ' but the code constant is ' + prefix + ':v' + want
          + ' -- sync the doc/comment (INV-30).');
      }
    });
  });
});

test('cache-version sync: markdown version tables match the code', function () {
  ['docs/known-issues.md', 'docs/conventions.md'].forEach(function (rel) {
    const lines = read(rel).split('\n');
    lines.forEach(function (line, i) {
      // Row shape: | ... | `<prefix>:vN[:]` | `v<digit>` |
      const cell = /`([a-zA-Z_]+):vN:?`/.exec(line);
      const ver  = /`v(\d+)`/.exec(line);
      if (!cell || !ver) return;
      const prefix = cell[1];
      if (canonical[prefix] == null) return;   // not a tracked prefix
      assert.equal(Number(ver[1]), canonical[prefix],
        rel + ':' + (i + 1) + ' table lists ' + prefix + ' as v' + ver[1]
        + ' but the code constant is v' + canonical[prefix] + ' (INV-30).');
    });
  });
});
