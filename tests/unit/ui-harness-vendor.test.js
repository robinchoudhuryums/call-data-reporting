'use strict';

// F7: the rendered-UI harness carries COMMITTED vendor bundles (Chart.js, the
// datalabels plugin, html2canvas-pro) so it runs without an ad-hoc npm install.
// Those copies must stay pinned to the SAME versions dashboard.html loads from
// the CDN -- otherwise the harness silently verifies the client against a
// different Chart.js than production ships, and a chart bug could pass CI and
// still break live (or vice versa: a harness-only failure nobody can reproduce).
//
// Zero-dep and fast: this reads two text files. It does NOT run the harness
// (that's `npm run ci:ui`, which needs playwright).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DASHBOARD = path.join(ROOT, 'apps-script', 'department-dashboard', 'dashboard.html');
const VENDOR_DIR = path.join(ROOT, 'tools', 'ui-harness', 'vendor');

// npm package name -> the vendor file the harness serves it as.
const VENDOR_FILES = {
  'chart.js': 'chart.umd.js',
  'chartjs-plugin-datalabels': 'datalabels.min.js',
  'html2canvas-pro': 'html2canvas-pro.min.js',
};

test('F7: harness vendor versions match the CDN versions dashboard.html pins', function () {
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'VERSIONS.json'), 'utf8'));

  Object.keys(VENDOR_FILES).forEach(function (pkg) {
    // Extract the version from the jsdelivr URL: .../npm/<pkg>@<version>/dist/...
    const re = new RegExp('cdn\\.jsdelivr\\.net/npm/'
      + pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '@([\\w.\\-]+)/');
    const m = html.match(re);
    assert.ok(m, 'dashboard.html should pin a CDN version for ' + pkg);
    assert.equal(manifest[pkg], m[1],
      'tools/ui-harness/vendor/VERSIONS.json says ' + pkg + '@' + manifest[pkg]
      + ' but dashboard.html loads ' + pkg + '@' + m[1]
      + ' -- re-copy the vendor file from that version and update VERSIONS.json, '
      + 'or the harness tests a different library than production ships.');
  });
});

test('F7: every declared vendor bundle actually exists and is non-trivial', function () {
  Object.keys(VENDOR_FILES).forEach(function (pkg) {
    const f = path.join(VENDOR_DIR, VENDOR_FILES[pkg]);
    assert.ok(fs.existsSync(f), 'missing committed vendor bundle: ' + VENDOR_FILES[pkg]);
    // A truncated/LFS-pointer copy would let the harness boot with a broken
    // Chart global and report confusing failures.
    assert.ok(fs.statSync(f).size > 5000, VENDOR_FILES[pkg] + ' looks truncated');
  });
});

test('F-11: the manifest hash matches the committed bundle BYTES', function () {
  // The version check above ties the MANIFEST to dashboard.html; nothing tied
  // the manifest to the bundle CONTENT -- bumping VERSIONS.json without
  // re-copying the bundle passed, and the harness then verified the client
  // against a stale library while claiming the new version.
  const crypto = require('crypto');
  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'VERSIONS.json'), 'utf8'));
  const hashes = manifest.sha256 || {};
  Object.keys(VENDOR_FILES).forEach(function (pkg) {
    const file = VENDOR_FILES[pkg];
    const expected = hashes[file];
    assert.ok(expected, 'VERSIONS.json has no sha256 for ' + file);
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(VENDOR_DIR, file)))
      .digest('hex');
    assert.equal(actual, expected,
      file + ' does not match its manifest hash -- if you bumped the version, '
      + 're-copy the bundle AND update sha256 in VERSIONS.json to ' + actual);
  });
});
