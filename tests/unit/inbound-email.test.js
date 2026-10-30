'use strict';

// SB-5e (owner 2026-10-28): the Inbound report EMAIL reads like the report
// since SB-5 -- total = answered + rang out / voicemail + hung up (the three
// dispositions; `missed` was computed and never shown, so the email's
// Answered % + Abandoned % fell short of 100), drawn as one bar whose cells
// are each part's share, with on hold / unanswered transfers labelled as NOT
// parts of it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'EmailKit.gs', 'InboundReport.gs'] });

function payload(companyView) {
  const kp = (t, a, ab, mi) => ({ total: t, answered: a, abandoned: ab, missed: mi, abandonedOnHold: 61,
    xferUnanswered: 14, abandonedIvr: companyView ? 120 : 0, abandonedDirect: companyView ? 38 : 0,
    avgWaitSec: 48, avgHoldSec: 112, abandonRate: Math.round(ab / t * 1000) / 10, answerRate: Math.round(a / t * 1000) / 10 });
  return { meta: { available: true, companyView: companyView, department: companyView ? null : 'CSR',
      from: '2026-09-28', to: '2026-10-27', priorFrom: '2026-08-28', priorTo: '2026-09-25' },
    kpis: kp(4120, 3410, 402, 308), kpisPrior: kp(3990, 3300, 410, 280), byInsurer: [], byDialIn: [] };
}

function send(companyView) {
  const sent = [];
  h.ctx.inboundResolveRequest_ = function () { return { user: { email: 'a@x.com' }, dept: companyView ? '' : 'CSR' }; };
  h.ctx.assertReportEmailThrottle_ = function () {};
  h.ctx.computeInboundReport_ = function () { return payload(companyView); };
  h.ctx.sendAppEmail_ = function (o) { sent.push(o); };
  h.ctx.sendInboundReportEmail({});
  assert.equal(sent.length, 1);
  return sent[0].htmlBody;
}

test('SB-5e: the email shows the rang-out / voicemail part, so the three rates add up', function () {
  const html = send(true);
  assert.match(html, /Rang out or went to voicemail/);
  assert.match(html, /308 \(7\.5%\)/);
  assert.match(html, /3,410 \(82\.8%\)/);
  assert.match(html, /402 \(9\.8%\)/);
});

test('SB-5e: one bar of three cells, each its share of the calls, in the row order', function () {
  const html = send(true);
  const cells = (html.match(/<td width="([\d.]+)%" style="background:(#[0-9a-f]{6});height:12px/g) || [])
    .map((c) => /width="([\d.]+)%" style="background:(#[0-9a-f]{6})/.exec(c).slice(1));
  assert.deepEqual(cells, [['82.8', '#3d9476'], ['7.5', '#e8b49c'], ['9.8', '#c66b4b']]);
});

test('SB-5e: on hold and unanswered transfers say why they are not parts; the stages only company-wide', function () {
  const all = send(true);
  assert.match(all, /Hung up while on hold \(after an answer, so inside Answered\)/);
  assert.match(all, /Transfers nobody picked up \(an agent/);
  assert.match(all, /in the phone menu \/ on a person/);
  assert.match(all, /120 \/ 38/);
  assert.doesNotMatch(send(false), /in the phone menu/);
});

test('SB-5e: ekSplitBarHtml_ drops zero parts, keeps a tiny one visible, and renders nothing for no total', function () {
  const bar = h.ctx.ekSplitBarHtml_([{ n: 999, color: '#111111' }, { n: 0, color: '#222222' }, { n: 1, color: '#333333' }], 1000);
  assert.doesNotMatch(bar, /#222222/);
  assert.match(bar, /width="1%" style="background:#333333/);
  assert.equal(h.ctx.ekSplitBarHtml_([{ n: 1, color: '#111111' }], 0), '');
});
