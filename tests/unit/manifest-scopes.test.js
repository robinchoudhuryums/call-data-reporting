'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// T-7 (broad-scan 2026-09-17): the dashboard manifest declared a scope no code
// used (script.container.ui -- a standalone web app never calls getUi), and
// the two pipeline siblings declared NONE, relying on auto-detection, which
// cannot see the scope a UrlFetch target needs (cdr-report's PDF export fetches
// the sheet's /export URL with the script's own OAuth token). An explicit list
// is only safe if it is COMPLETE, so this suite derives the required scopes
// from the services each project actually calls and pins the manifest to
// exactly that set: a missing scope (a new DriveApp call with no manifest
// edit -> "Insufficient permissions" in production) and an unused one (a
// consent prompt wider than the code) both fail. dqe-report is FROZEN
// (INV-22) and keeps auto-detection; it is deliberately not pinned.

const ROOT = path.resolve(__dirname, '../../apps-script');
const S = 'https://www.googleapis.com/auth/';

// service usage -> scope. One entry per service family the projects use.
const RULES = [
  [/\bSpreadsheetApp\.(?!getUi)/, S + 'spreadsheets'],
  [/\bSpreadsheetApp\.getUi\(\)/, S + 'script.container.ui'],
  [/\b(MailApp)\.\w+/, S + 'script.send_mail'],
  [/\bScriptApp\.(newTrigger|deleteTrigger|getProjectTriggers)\b/, S + 'script.scriptapp'],
  [/\b(Jdbc\.getConnection|UrlFetchApp\.fetch)\b/, S + 'script.external_request'],
  [/\bSession\.get(Active|Effective)User\(\)/, S + 'userinfo.email'],
  [/\bDriveApp\.\w+/, S + 'drive'],
];
// A UrlFetch of the sheet's own /export URL with ScriptApp.getOAuthToken()
// reads the file through Drive: the token must carry drive.readonly.
const EXPORT_RULE = { needs: [/ScriptApp\.getOAuthToken\(\)/, /export\?format=pdf/], scope: S + 'drive.readonly' };

function projectSource(dir) {
  return fs.readdirSync(dir)
    .filter(function (f) { return /\.(gs|js|html)$/.test(f); })
    .map(function (f) { return fs.readFileSync(path.join(dir, f), 'utf8'); })
    .join('\n');
}

function requiredScopes(dir) {
  const src = projectSource(dir);
  const out = new Set();
  RULES.forEach(function (r) { if (r[0].test(src)) out.add(r[1]); });
  if (EXPORT_RULE.needs.every(function (re) { return re.test(src); })) out.add(EXPORT_RULE.scope);
  // DriveApp implies full drive, which subsumes drive.readonly.
  if (out.has(S + 'drive')) out.delete(S + 'drive.readonly');
  return Array.from(out).sort();
}

function declaredScopes(project) {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, project, 'appsscript.json'), 'utf8'));
  return (m.oauthScopes || []).slice().sort();
}

['department-dashboard', 'cdr-report', 'cdr-import'].forEach(function (project) {
  test('T-7: ' + project + ' declares exactly the OAuth scopes its code needs', function () {
    const need = requiredScopes(path.join(ROOT, project));
    const have = declaredScopes(project);
    assert.ok(have.length, project + ': the manifest must declare oauthScopes explicitly (T-7)');
    const missing = need.filter(function (s) { return have.indexOf(s) === -1; });
    const unused  = have.filter(function (s) { return need.indexOf(s) === -1; });
    assert.deepEqual(missing, [], project + ': scopes the code needs but the manifest omits -- '
      + 'the function using them fails with "Insufficient permissions" in production');
    assert.deepEqual(unused, [], project + ': scopes the manifest declares but no code uses -- '
      + 'a consent prompt wider than the code (the container.ui shape T-7 removed)');
  });
});

test('T-7: the dashboard, a standalone web app, declares no container UI scope', function () {
  assert.equal(declaredScopes('department-dashboard').indexOf(S + 'script.container.ui'), -1);
});

test('T-7: dqe-report stays on auto-detection (frozen, INV-22)', function () {
  assert.equal(declaredScopes('dqe-report').length, 0);
});
