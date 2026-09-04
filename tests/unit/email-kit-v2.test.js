'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');

// R29: EmailKit v2 -- the notice family. Every admin notice now carries an
// HTML alternative in the house style, built from ONE `notice:` spec that
// sendAppEmail_ renders through ekNoticeHtml_. Pinned:
//   (1) the shell without `band` is unchanged (the report emails keep their
//       light header); with `band` it gains the stripe, glyph and wordmark;
//   (2) tiles / steps / list / mono / notice compose in a fixed order;
//   (3) sendAppEmail_ renders `notice` into htmlBody when the kit is loaded,
//       drops the spec either way, and a render failure still sends plain;
//   (4) the SWEEP: every plain-text sender passes a `notice:` spec.

const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'EmailKit.gs'] });

test('R29: ekShellHtml_ keeps the light header without band; band adds stripe, glyph, wordmark', function () {
  const plain = h.call('ekShellHtml_', { kicker: 'K', title: 'T', rowsHtml: '', ctaUrl: 'https://x', ctaLabel: 'Go' });
  assert.ok(!/height:5px;background:/.test(plain), 'no stripe/dark band by default');
  assert.ok(!/CALL DATA<\/td>/.test(plain), 'no wordmark by default');
  assert.match(plain, /bgcolor="#101418" style="border-radius:8px;"><a href="https:\/\/x"/, 'the classic ink CTA color is untouched');
  const banded = h.call('ekShellHtml_', { band: { tone: 'warn' }, kicker: 'K', title: 'T', rowsHtml: '',
    ctaUrl: 'https://x', ctaLabel: 'Go', cta2Url: 'https://y', cta2Label: 'Also' });
  assert.match(banded, /height:5px;background:#c66b4b/, 'warn stripe');
  assert.match(banded, /bgcolor="#c66b4b" style="border-radius:22px;[^"]*">!</, 'warn glyph badge');
  assert.match(banded, /CALL DATA<\/td>/, 'wordmark');
  assert.match(banded, /bgcolor="#3d9476" style="border-radius:8px;"><a href="https:\/\/x"/, 'accent CTA');
  assert.match(banded, /<a href="https:\/\/y"[^>]*>Also<\/a>/, 'second CTA');
});

test('R29: tiles / steps / list / mono render their shapes', function () {
  const tiles = h.call('ekTilesHtml_', [{ label: 'A', value: '1' }, { label: 'B', value: '2', tone: 'warn' }, { label: 'C', value: '3', sub: 's', tone: 'good' }]);
  assert.equal((tiles.match(/<td width="33%"/g) || []).length, 3);
  assert.match(tiles, /background:#f6e2d4/, 'warn tile tint');
  assert.match(tiles, /background:#e6f0ea/, 'good tile tint');
  assert.equal(h.call('ekTilesHtml_', []), '');
  assert.equal((h.call('ekTilesHtml_', [1, 2, 3, 4, 5].map(function (i) { return { label: 'L' + i, value: i }; })).match(/<td width="25%"/g) || []).length, 4, 'capped at four');
  const steps = h.call('ekStepsHtml_', [{ head: 'One.', body: 'b1' }, { head: 'Two.' }], 'warn');
  assert.match(steps, /bgcolor="#c66b4b"[^>]*>1</); assert.match(steps, />2</);
  assert.match(steps, /<strong>One\.<\/strong> <span[^>]*>b1<\/span>/);
  const list = h.call('ekListHtml_', 'Items', ['<b>x</b>', '', 'y']);
  assert.equal((list.match(/&bull;/g) || []).length, 2, 'empty items dropped');
  assert.match(list, />ITEMS<\/div>|>Items<\/div>/);
  const mono = h.call('ekMonoHtml_', 'Stack', 'a <b> & c', 10);
  assert.match(mono, /a &lt;b&gt; &amp; c/);
  assert.equal(h.call('ekMonoHtml_', 'Stack', '   '), '');
  assert.match(h.call('ekMonoHtml_', '', 'x'.repeat(50), 20), /x{20}\n…/, 'capped');
});

test('R29: ekNoticeHtml_ composes sections in order and tones the band', function () {
  const html = h.call('ekNoticeHtml_', {
    tone: 'bad', kicker: 'Admin notice · X', title: 'Boom', subtitle: 'sub',
    tiles: [{ label: 'T', value: '1' }], callout: { kicker: 'C', html: 'callout-body' },
    list: { title: 'L', items: ['item-1'] }, stepsTitle: 'S', steps: [{ head: 'step-1' }],
    mono: { title: 'M', text: 'mono-text' }, outro: 'outro-text',
    ctaUrl: 'https://d/#/admin/health', ctaLabel: 'Open',
  });
  const idx = ['height:5px;background:#b23a2c', 'padding-top:4px;">Boom<', '<td width="100%"', 'callout-body', 'item-1', 'step-1', 'mono-text', 'outro-text', 'href="https://d/#/admin/health"']
    .map(function (k) { const i = html.indexOf(k); assert.ok(i >= 0, 'missing ' + k); return i; });
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], 'section order at ' + i);
  assert.match(html, /border-left:4px solid #c66b4b/, 'a bad notice defaults its callout to warn tone');
  const neutral = h.call('ekNoticeHtml_', { title: 'Quiet' });
  assert.match(neutral, /height:5px;background:#8a97a4/);
  assert.match(neutral, /Admin notice<\/div>/i);
});

test('R29: sendAppEmail_ renders `notice` into htmlBody when the kit is loaded and never forwards the spec', function () {
  h.state.props = { ADMIN_EMAILS: 'robin@x.com' };
  h.state.sentEmails.length = 0;
  h.call('sendAppEmail_', { to: 'a@x.com', subject: 's', body: 'plain', notice: { tone: 'warn', title: 'Hello' } });
  const m = h.state.sentEmails[0];
  assert.match(m.htmlBody, />Hello</);
  assert.equal(m.body, 'plain', 'plain body kept as the alternative');
  assert.ok(!('notice' in m), 'the spec never reaches MailApp');
  assert.equal(m.bcc, 'robin@x.com');

  // An explicit htmlBody wins over the spec.
  h.state.sentEmails.length = 0;
  h.call('sendAppEmail_', { to: 'a@x.com', subject: 's', htmlBody: '<i>mine</i>', notice: { title: 'Hello' } });
  assert.equal(h.state.sentEmails[0].htmlBody, '<i>mine</i>');

  // A render failure still sends the plain body.
  const real = h.ctx.ekNoticeHtml_;
  h.ctx.ekNoticeHtml_ = function () { throw new Error('render boom'); };
  try {
    h.state.sentEmails.length = 0;
    h.call('sendAppEmail_', { to: 'a@x.com', subject: 's', body: 'plain', notice: { title: 'Hello' } });
    assert.equal(h.state.sentEmails.length, 1);
    assert.equal(h.state.sentEmails[0].htmlBody, undefined);
  } finally { h.ctx.ekNoticeHtml_ = real; }

  // Without the kit (a suite that loads Config.gs alone), the plain body goes out.
  const h2 = loadGas({ files: ['Config.gs'] });
  h2.state.props = { ADMIN_EMAILS: 'robin@x.com' };
  h2.call('sendAppEmail_', { to: 'a@x.com', subject: 's', body: 'plain', notice: { title: 'Hello' } });
  assert.equal(h2.state.sentEmails[0].htmlBody, undefined);
  assert.ok(!('notice' in h2.state.sentEmails[0]));
});

test('R29: a real sender renders through the kit (ingest watchdog)', function () {
  const hw = loadGas({ files: ['Config.gs', 'Util.gs', 'EmailKit.gs', 'IngestWatchdog.gs'] });
  hw.state.props = { ADMIN_EMAILS: 'robin@x.com', DASHBOARD_URL: 'https://d/exec' };
  const ok = hw.call('notifyIngestStale_', { latestTimestamp: '2026-09-02 06:12:00', hoursSinceFresh: 49 }, 36);
  assert.equal(ok, true);
  const m = hw.state.sentEmails[0];
  assert.match(m.body, /Hours since: 49/, 'plain body unchanged');
  assert.match(m.htmlBody, /No fresh DQE build in 36 hours/);
  assert.match(m.htmlBody, /2026-09-02 06:12:00/);
  assert.match(m.htmlBody, /href="https:\/\/d\/exec#\/admin\/health"/);
  assert.match(m.htmlBody, /height:5px;background:#c66b4b/, 'warn band');
});

// ── sweep: every plain-text sender carries a notice spec ──────────────────
function sendCalls(src) {
  const out = [];
  let i = 0;
  for (;;) {
    const k = src.indexOf('sendAppEmail_(', i);
    if (k < 0) break;
    let depth = 0, j = k + 'sendAppEmail_'.length;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(k, j + 1));
    i = j + 1;
  }
  return out;
}

test('R29 sweep: every sendAppEmail_ call that sends a plain `body:` also passes `notice:` (or an htmlBody)', function () {
  const offenders = [];
  fs.readdirSync(DASH).filter(function (f) { return f.endsWith('.gs') && f !== 'Config.gs'; }).forEach(function (f) {
    const src = fs.readFileSync(path.join(DASH, f), 'utf8');
    sendCalls(src).forEach(function (call) {
      // Object-literal calls only; a variable message (sendAppEmail_(msg)) is
      // the queue report's already-styled HTML.
      if (!/^sendAppEmail_\(\s*\{/.test(call)) return;
      const hasBody = /\bbody:/.test(call);
      const styled = /\bnotice:/.test(call) || /\bhtmlBody:/.test(call);
      if (hasBody && !styled) offenders.push(f + ': ' + call.slice(0, 80).replace(/\s+/g, ' '));
    });
  });
  assert.deepEqual(offenders, [], 'a plain-text email must carry a `notice:` spec so it renders in the house style: ' + offenders.join(' | '));
});

// ── R30 (owner ruling 2026-09-04): the family is UNIFORM -- every report /
// alert / digest email built on ekShellHtml_ passes `band`, so the dark
// header is the one look across notices, welcome, and reports. (The Daily
// Call Queue Report keeps its own pinned local shell on purpose.)
test('R30 sweep: every ekShellHtml_ caller passes band', function () {
  const offenders = [];
  fs.readdirSync(DASH).filter(function (f) { return f.endsWith('.gs') && f !== 'EmailKit.gs'; }).forEach(function (f) {
    const src = fs.readFileSync(path.join(DASH, f), 'utf8');
    let i = 0;
    for (;;) {
      const k = src.indexOf('ekShellHtml_({', i);
      if (k < 0) break;
      // The options literal opens at k; `band:` must appear within its first 200 chars.
      if (!/\bband:\s*\{/.test(src.slice(k, k + 200))) offenders.push(f + '@' + k);
      i = k + 1;
    }
  });
  assert.deepEqual(offenders, [], 'pass band: { tone } to ekShellHtml_ -- the email family is uniform (R30): ' + offenders.join(', '));
});
