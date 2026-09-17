#!/usr/bin/env node
/* Undeclared-identifier net for the three Apps Script projects.
 *
 * WHY (ported from team-tools' lint-server.mjs, where it caught a live
 * ReferenceError the same week): every suite under tests/unit loads a
 * SELECTION of .gs files into a vm (max ~7 per loadGas call) and the
 * structural pins read the source as TEXT. Neither can see a name that LOOKS
 * right and resolves to nothing at runtime -- the `ship` that two endpoints
 * referenced undeclared in team-tools stayed green under four shape pins.
 * Only executing a line, or resolving its scope, catches that. This resolves.
 *
 * THE MODEL: Apps Script loads every file of ONE project into ONE global
 * scope, so a name declared in Config.gs is in scope in Alerts.gs -- and a
 * name declared in cdr-report is NOT in scope in cdr-import. So each project
 * is linted as ONE concatenation, and the projects are linted separately:
 *   apps-script/department-dashboard/*.gs
 *   apps-script/cdr-report/*.js
 *   apps-script/cdr-import/*.js
 * (dqe-report is FROZEN, INV-22 -- deliberately not linted.)
 *
 * The ONLY hand-maintained list is APPS_SCRIPT_GLOBALS -- the platform's own
 * services, which live in no file we can read. A wrong entry silences a real
 * bug, so add a name only after checking the Apps Script reference.
 *
 * Zero-dep posture (the F-9 / ci:ui rule): `npm run ci` stays dependency-free;
 * this script needs eslint (a devDependency). With eslint ABSENT it SKIPS and
 * exits 0 -- EXCEPT under CI=true, where absence FAILS, so a workflow refactor
 * that loses the install step cannot turn the net silently green.
 *
 * Exit 1 and name project/file:line on any undeclared identifier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let Linter;
try {
  ({ Linter } = await import('eslint'));
} catch (e) {
  if (process.env.CI) {
    console.error('lint-gas: eslint is not installed but CI=true -- the undeclared-identifier net must not go silently green. Run `npm ci` first.');
    process.exit(1);
  }
  console.log('lint-gas: eslint not installed -- SKIPPING the undeclared-identifier net.\n  Install it with:  npm ci   (a devDependency; `npm run ci` itself stays zero-dep)');
  process.exit(0);
}

/** Apps Script platform globals. Not derivable -- provided by the runtime. */
const APPS_SCRIPT_GLOBALS = [
  'SpreadsheetApp', 'DriveApp', 'GmailApp', 'MailApp', 'CalendarApp',
  'DocumentApp', 'FormApp', 'SlidesApp', 'ContactsApp', 'GroupsApp',
  'HtmlService', 'ContentService', 'CacheService', 'PropertiesService',
  'LockService', 'ScriptApp', 'UrlFetchApp', 'Utilities', 'Session',
  'Logger', 'console', 'Browser', 'Drive', 'Docs', 'Sheets', 'Gmail',
  'XmlService', 'Charts', 'Maps', 'LanguageApp', 'BigQuery', 'People',
  'Jdbc', 'MimeType', 'Blob', 'Ui', 'ScriptProperties', 'UserProperties',
  'JSON', 'Math', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Infinity', 'NaN', 'undefined',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'globalThis', 'Intl',
  'ArrayBuffer', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int32Array',
  'Float64Array', 'DataView', 'BigInt', 'Reflect', 'Proxy', 'escape', 'unescape',
];

const PROJECTS = [
  { dir: 'apps-script/department-dashboard', ext: '.gs' },
  { dir: 'apps-script/cdr-report', ext: '.js' },
  { dir: 'apps-script/cdr-import', ext: '.js' },
];

const globals = {};
for (const g of APPS_SCRIPT_GLOBALS) globals[g] = 'readonly';

let bad = 0, fileCount = 0;
for (const p of PROJECTS) {
  const dir = path.join(ROOT, p.dir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(p.ext)).sort();
  fileCount += files.length;
  // Concatenate, remembering where each file starts so a reported line can
  // be translated back to file:line. ONE combined lint per project is the
  // point: per-file linting reports every cross-file helper as undeclared.
  const offsets = [];
  let combined = '', line = 1;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    offsets.push({ file: f, start: line });
    combined += src + '\n';
    line += src.split('\n').length;
  }
  const messages = new Linter().verify(combined, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals },
    rules: { 'no-undef': 'error' },
  });
  const locate = (ln) => {
    let hit = offsets[0];
    for (const o of offsets) if (o.start <= ln) hit = o; else break;
    return p.dir + '/' + hit.file + ':' + (ln - hit.start + 1);
  };
  for (const m of messages) { bad++; console.error('  ' + locate(m.line) + '  ' + m.message); }
}

if (bad === 0) {
  console.log('lint-gas: no undeclared identifiers across ' + fileCount + ' files in ' + PROJECTS.length + ' projects.');
  process.exit(0);
}
console.error('\nlint-gas: ' + bad + ' undeclared identifier(s). Every name above resolves to nothing at\n' +
  'runtime: the line throws ReferenceError when reached. If the name IS real, it is\n' +
  'either an Apps Script platform global (add it to APPS_SCRIPT_GLOBALS in this file)\n' +
  'or a declaration that belongs in that project\'s own files -- the three projects\n' +
  'are SEPARATE global scopes.');
process.exit(1);
