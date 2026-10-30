'use strict';

// HOH-1 (owner 2026-10-29): "Hung up on hold" on an ANSWERED call read like an
// abandon. HOH-0b measured the flag on the call's last leg in 149 of 149
// cases, always after an answer, so the count stays and the wording changes:
// Caller Lookup's chip says "Hung up while on hold with <agent>", and the call
// path marks that agent's row. The step is the capture's `holdHangup` stamp
// (new rows), else the last answer by a person (older rows). The client
// functions lift out of script-10-escalations.html with their helpers stubbed
// (the answered-bar.test.js technique -- zero-dep, no jsdom).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const TEXT = fs.readFileSync(path.join(DIR, 'script-10-escalations.html'), 'utf8');

function extractFnText(name) {
  const start = TEXT.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' is missing');
  const open = TEXT.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < TEXT.length; i++) {
    if (TEXT[i] === '{') depth++;
    else if (TEXT[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return TEXT.slice(start, end);
}

// eslint-disable-next-line no-new-func
const lib = new Function('escapeHtml', 'fmtDuration', 'clCstTime_',
  extractFnText('clHoldHangupIdx_') + '\n' + extractFnText('clJourneyRowHtml_') + '\n'
  + extractFnText('clJourneyRowsHtml_') + '\n' + extractFnText('clOutcomeChip_') + '\n'
  + 'return { clHoldHangupIdx_: clHoldHangupIdx_, clJourneyRowsHtml_: clJourneyRowsHtml_, clOutcomeChip_: clOutcomeChip_ };'
)(function (s) { return String(s); }, function (n) { return n + 's'; }, function (t) { return t; });

const answered = (journey, extra) => Object.assign({ disposition: 'answered', abandonedOnHold: true, journey: journey }, extra || {});
const Q = { t: '08:00:00', name: 'A_Q_CSR', kind: 'queue' };
const PETER = { t: '08:00:10', name: 'Peter (Praneeth) Gummadi', kind: 'answer', talk: 74 };
const CAMILA = { t: '08:01:30', name: 'Camila (Cheshta) Bhutani', kind: 'answer', talk: 266 };

test('HOH-1: the capture\'s stamp names the step; older rows fall back to the last answer by a person', function () {
  const stamped = answered([Q, Object.assign({ holdHangup: true }, PETER), CAMILA]);
  assert.equal(lib.clHoldHangupIdx_(stamped), 1, 'the stamp wins over position');
  const old = answered([Q, PETER, CAMILA,
    { t: '08:01:30', name: '(caller)', kind: 'answer', talk: 266 },
    { t: '08:01:30', name: 'N.', kind: 'answer', talk: 266 },
    { t: '08:02:00', name: 'Daniel (Dishant) Sahani', kind: 'answer', talk: 20, transfer: true, consult: true }]);
  assert.equal(lib.clHoldHangupIdx_(old), 2, 'placeholders, the old "N." initials and a consult are skipped');
  assert.equal(lib.clHoldHangupIdx_(answered([Q, PETER], { abandonedOnHold: false })), -1, 'no flag, no step');
  assert.equal(lib.clHoldHangupIdx_(answered([Q, PETER], { disposition: 'abandoned' })), -1,
    'an unanswered call is only marked where the capture stamped it');
});

test('HOH-1: an answered call\'s chip says "Hung up while on hold with <agent>"; an unanswered one keeps "Hung up on hold"', function () {
  const chip = lib.clOutcomeChip_(answered([Q, PETER, CAMILA]));
  assert.match(chip, />Answered</);
  assert.match(chip, />Hung up while on hold with Camila \(Cheshta\) Bhutani</);
  assert.ok(chip.indexOf('>Hung up on hold<') === -1);
  const plain = lib.clOutcomeChip_(answered([Q, PETER, { t: '08:01:30', name: '(caller)', kind: 'answer', talk: 9 }]));
  assert.match(plain, />Hung up while on hold with Peter \(Praneeth\) Gummadi</);
  const nobody = lib.clOutcomeChip_(answered([Q, { t: '08:01:30', name: '(caller)', kind: 'answer', talk: 9 }]));
  assert.match(nobody, />Hung up while on hold</, 'no person found: no name, still the answered wording');
  const ab = lib.clOutcomeChip_({ disposition: 'abandoned', abandonStage: 'queue', abandonedOnHold: true, journey: [Q] });
  assert.match(ab, />Abandoned in queue</);
  assert.match(ab, />Hung up on hold</);
});

test('HOH-1: only the hold hang-up row is marked -- the map index never marks the others', function () {
  const html = lib.clJourneyRowsHtml_([Q, PETER, CAMILA], 2);
  assert.equal((html.match(/cl-ev-holdhang/g) || []).length, 1);
  assert.equal((html.match(/caller hung up here while on hold/g) || []).length, 1);
  assert.ok(/cl-ev-holdhang[^]*Camila/.test(html), 'on Camila\'s row');
  const none = lib.clJourneyRowsHtml_([Q, PETER, CAMILA], -1);
  assert.ok(none.indexOf('cl-ev-holdhang') === -1 && none.indexOf('hung up here') === -1);
});
