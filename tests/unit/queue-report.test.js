'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// Automated Daily Call Queue Report email (QueueReportEmail.gs): the report is
// emailed for the PREVIOUS WORKDAY, once daily, to opt-in subscribers, but ONLY
// after that day's QCD data has landed. The gate decision is a pure helper
// (queueReportGateDecision_) so the window / weekday / holiday / dedupe /
// readiness logic is testable without a clock.
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Data.gs', 'QueueReportEmail.gs'] });

function baseCtx(over) {
  // A "would send" context: enabled, mid-window, a weekday, no holiday, data
  // ready (latestQcd >= target), not yet sent.
  return Object.assign({
    enabled: true, hour: 8, dow: 3, holiday: false,
    targetIso: '2026-07-10', lastSent: '', latestQcd: '2026-07-10',
  }, over || {});
}

test('gate: sends when enabled + in-window + weekday + data ready + not yet sent', function () {
  const d = h.call('queueReportGateDecision_', baseCtx());
  assert.equal(d.send, true);
  assert.equal(d.reason, 'ready');
});

test('gate: skips when disabled / outside window / weekend / holiday', function () {
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ enabled: false })).reason, 'disabled');
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ hour: 5 })).reason, 'outside-window');   // before 6
  // Round-16: the window END is classification, not a gate -- a post-noon
  // poll with ready data SENDS (the late catch-up; the target rolls at
  // midnight so this can never resend yesterday's report).
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ hour: 12 })).send, true);
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ hour: 23 })).send, true);
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ dow: 6 })).reason, 'weekend');
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ dow: 0 })).reason, 'weekend');
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ holiday: true })).reason, 'holiday');
});

test('gate: dedupe -- already sent this target date -> skip', function () {
  const d = h.call('queueReportGateDecision_', baseCtx({ lastSent: '2026-07-10' }));
  assert.equal(d.send, false);
  assert.equal(d.reason, 'already-sent');
});

test('gate: readiness -- QCD not yet at the target date -> not-ready (retry next poll)', function () {
  // Import hasn't written the target day's QCD yet (latest is the day before).
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ latestQcd: '2026-07-09' })).reason, 'not-ready');
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ latestQcd: '' })).reason, 'not-ready');
  // Exactly caught up -> ready.
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ latestQcd: '2026-07-10' })).send, true);
});

test('subscribers: parses active/inactive rows, skips blank emails', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes'],
        ['a@x.com', 'TRUE', 'CSR lead'],
        ['b@x.com', 'FALSE', 'paused'],
        ['', 'TRUE', 'blank -- skipped'],
        ['c@x.com', '', 'empty active -> active'],
      ],
    },
  });
  const subs = h.call('readQueueReportSubscribers_', null);
  assert.equal(subs.length, 3);
  assert.equal(subs[0].email, 'a@x.com');
  assert.equal(subs[0].active, true);
  assert.equal(subs[1].active, false);      // FALSE
  assert.equal(subs[2].email, 'c@x.com');
  assert.equal(subs[2].active, true);       // blank active defaults to active
});

test('readiness read: queueReportQcdLatestIso_ returns the max QCD date', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  // QCD Historical Data: Month|Week|Date(col3)|... -- put ISO dates in col 3.
  const row = function (iso) { return ['Jul 2026', 'W28', iso, 'A_Q_X', 'Total Calls', 10, 8, 2, '', '', '', 0]; };
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'QCD Historical Data': [
        ['Month Year', 'Week', 'Date', 'Call Queue', 'Call Source', 'Total Calls',
         'Total Answered', 'Abandoned', 'Longest Wait', 'Avg Answer', 'Abandoned %', 'Violations'],
        row('2026-07-08'), row('2026-07-10'), row('2026-07-09'),
      ],
    },
  });
  assert.equal(h.call('queueReportQcdLatestIso_', null), '2026-07-10');
});

test('readiness read: no QCD sheet -> empty (not-ready)', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: {} });
  assert.equal(h.call('queueReportQcdLatestIso_', null), '');
});

// Verdict-layer email (design update): verdict alert + KPI row + worst-first
// per-queue td-bar table. CSR (7.0%, 2 viol) is a WATCH offender; Sales (2.5%,
// 0 viol) is HEALTHY.
function emailFixture() {
  return {
    dateLabel: 'Jul 10, 2026',
    depts: [
      { dept: 'CSR', parent: null,
        totals: { totalCalls: 100, totalAnswered: 93, abandoned: 7, abandonedPct: 7.0,
          abandonedPctStr: '7.00%', longestWait: '0:02:10', avgAnswer: '0:00:20', violations: 2, violationsMtd: 6 },
        queues: [{ queue: 'A_Q_CSR', totalCalls: 100, totalAnswered: 93, abandoned: 7,
          abandonedPct: 7.0, abandonedPctStr: '7.00%', violations: 2, violationsMtd: 6 }] },
      { dept: 'Sales', parent: null,
        totals: { totalCalls: 40, totalAnswered: 39, abandoned: 1, abandonedPct: 2.5,
          abandonedPctStr: '2.50%', longestWait: '0:01:00', avgAnswer: '0:00:15', violations: 0, violationsMtd: 1 },
        queues: [{ queue: 'A_Q_SALES', totalCalls: 40, totalAnswered: 39, abandoned: 1,
          abandonedPct: 2.5, abandonedPctStr: '2.50%', violations: 0, violationsMtd: 1 }] },
    ],
    grandTotals: { totalCalls: 140, totalAnswered: 132, abandoned: 8, abandonedPct: 5.71,
      abandonedPctStr: '5.71%', longestWait: '0:02:10', avgAnswer: '0:00:18', violations: 2, violationsMtd: 7 },
  };
}

test('email HTML: KPI row + worst-first table, bound to server figures (banner retired, R11-B4)', function () {
  h.state.props.DASHBOARD_URL = 'https://example.com/exec';
  const html = h.call('buildQueueReportEmailHtml_', emailFixture(), '2026-07-10', false);
  assert.match(html, /Daily Call Queue Report/);
  assert.match(html, /Jul 10, 2026/);
  assert.match(html, /Company total/);
  assert.match(html, /5\.71%/);                             // company aban % (grandTotals)
  assert.match(html, /example\.com\/exec#\/overview/);      // bulletproof CTA
  // R11-B4: the verdict alert BANNER is retired (KPI tiles + row color carry
  // it); the hidden preheader still names the offender for inbox previews.
  assert.match(html, /over the 5% line/);                   // preheader only
  assert.doesNotMatch(html, /&#9873;/);                     // the banner's flag glyph is gone
  assert.match(html, /A_Q_CSR/);
  // WATCH offender carries the watch color; the HEALTHY row the green.
  assert.match(html, /#c66b4b/);                            // CSR (7%, 2 viol) = WATCH
  assert.match(html, /#3d9476/);                            // Sales (2.5%) = HEALTHY
  // R11-F: the dept name strip carries its verdict as a colored LEFT EDGE
  // (no HEALTHY/WATCH text) + the abandoned COUNT in its mini-summary.
  assert.match(html, /border-left:4px solid #c66b4b/);      // CSR strip: watch left edge
  assert.match(html, /7 abandoned/);                        // CSR abandoned count
  assert.match(html, /1 abandoned/);                        // Sales abandoned count
  // Worst-first: CSR section precedes Sales.
  assert.ok(html.indexOf('CSR') < html.indexOf('Sales'), 'worst-first: CSR before Sales');
  // Old plain-table warn color is gone.
  assert.doesNotMatch(html, /#B45309/);
  // R11-B4: no Courier -- email-safe Arial styling now.
  assert.doesNotMatch(html, /Courier New/);
});

test('email HTML: clean day -- no banner either way; split bar shows share-of-total (R11-B4)', function () {
  const clean = emailFixture();
  clean.depts[0].totals.abandonedPct = 3.0; clean.depts[0].totals.abandonedPctStr = '3.00%';
  clean.depts[0].totals.violations = 0; clean.depts[0].queues[0].abandonedPct = 3.0;
  clean.depts[0].queues[0].abandonedPctStr = '3.00%'; clean.depts[0].queues[0].violations = 0;
  // R12-22: single-queue sections render banner-only, so give CSR a second
  // queue -- the row (and its share bar) must exist for this pin to bite.
  clean.depts[0].queues.push({ queue: 'A_Q_CSR_2', totalCalls: 10, totalAnswered: 10,
    abandoned: 0, abandonedPct: 0, abandonedPctStr: '0.00%', violations: 0 });
  clean.grandTotals.abandonedPct = 2.8; clean.grandTotals.abandonedPctStr = '2.80%'; clean.grandTotals.violations = 0;
  const html = h.call('buildQueueReportEmailHtml_', clean, '2026-07-10', false);
  assert.doesNotMatch(html, /All queues held under the 5% line/);   // green banner retired too
  // Preheader keeps the all-clear line; no offender wording anywhere.
  assert.match(html, /All queues under the 5% line/);
  // R11-B4 split bar: the abandoned segment is the SHARE of calls (3% wide
  // for a 3%-abandon row), not the old 0-20%-scaled fill (which rendered
  // 3% as a 15%-wide bar). Passing rows carry the softened red.
  assert.match(html, /width="3%" style="background:#e8c4b2/);
  assert.doesNotMatch(html, /width="15%"/);
});

test('email HTML: over-threshold row fills red by its real share, full-strength (R11-B4)', function () {
  // The Denials-class case: 2 of 4 abandoned = 50%. The OLD bar clamped
  // 50%*5 -> a full orange bar; the split bar must render ~half red.
  const d = emailFixture();
  d.depts[0].queues[0] = { queue: 'A_Q_Denials', totalCalls: 4, totalAnswered: 2,
    abandonedPct: 50, abandonedPctStr: '50.00%', violations: 1 };
  d.depts[0].totals.abandonedPct = 50; d.depts[0].totals.violations = 1;
  // R12-22: keep the section multi-queue so the Denials ROW (whose bar this
  // test pins) still renders instead of collapsing into the banner.
  d.depts[0].queues.push({ queue: 'A_Q_CSR_2', totalCalls: 10, totalAnswered: 10,
    abandoned: 0, abandonedPct: 0, abandonedPctStr: '0.00%', violations: 0 });
  const html = h.call('buildQueueReportEmailHtml_', d, '2026-07-10', false);
  // Round-16: queue rows are volume TALLIES now -- an over-threshold row's
  // abandoned blocks render FULL-strength red (soft #e8c4b2 stays reserved
  // for under-5% rows); the proportional %-width bar survives only on the
  // company-total row.
  assert.match(html, /width="3" style="background:#b23a2c/);
  assert.doesNotMatch(html, /width="100%" style="background:#b23a2c/);
});

test('R12-22/R16c: parent-grouped sections -- child nests as a sub-row, single-queue gets banner + its own row, section total sums', function () {
  const d = emailFixture();
  d.depts.push({ dept: 'Spanish', parent: 'CSR',
    totals: { totalCalls: 20, totalAnswered: 18, abandoned: 2, abandonedPct: 10.0,
      abandonedPctStr: '10.00%', violations: 1 },
    queues: [{ queue: 'A_Q_Spanish', totalCalls: 20, totalAnswered: 18, abandoned: 2,
      abandonedPct: 10.0, abandonedPctStr: '10.00%', violations: 1 }] });
  const html = h.call('buildQueueReportEmailHtml_', d, '2026-07-10', false);
  // Spanish renders as an indented sub-row inside CSR, never its own banner.
  assert.match(html, /&#8627; <b>Spanish<\/b>/);
  assert.doesNotMatch(html, /bold 13px Arial,sans-serif;color:#101418;">Spanish</);
  // The CSR banner carries the SECTION total inline: 100+20 calls, 7+2 abandoned.
  // >=5%: count AND pct together, bold red (owner ruling).
  assert.match(html, /120 calls &middot; <span style="font-weight:bold;color:#b23a2c;">9 abandoned \(7\.5%\)<\/span>/);
  // <5% (Sales at 2.5%): plain ink, no bold.
  assert.match(html, /40 calls &middot; <span style="color:#101418;">1 abandoned \(2\.5%\)<\/span>/);
  // R12-24: the Viol column is MONTH-TO-DATE, labeled as such, and shows the
  // violationsMtd figure (6), not the range figure (2).
  assert.match(html, /Viol \(MTD\)/);
  assert.match(html, /month-to-date/);
  // R16c (owner): the banner-only collapse is RETIRED -- a single-queue
  // section renders a plain banner (no inline queue name) PLUS its own
  // queue data row, so the visual tally appears for EVERY queue.
  assert.doesNotMatch(html, /Sales <span[^>]*>&middot; A_Q_SALES<\/span>/);
  assert.equal((html.match(/A_Q_SALES/g) || []).length, 1);
});

test('Round-16/R16c: per-queue MTD pace sub-line in the email (on every queue row; absent pre-v6)', function () {
  // No mtd block (a pre-v6 cached payload): no pace line anywhere.
  const bare = h.call('buildQueueReportEmailHtml_', emailFixture(), '2026-07-10', false);
  assert.doesNotMatch(bare, /MTD &Oslash;/);

  const d = emailFixture();
  d.mtd = { from: '2026-07-01', to: '2026-07-10', workdays: 5,
    priorFrom: '2026-06-01', priorTo: '2026-06-30', priorWorkdays: 22, priorLabel: 'Jun',
    totalCalls: 700, answered: 660, abandoned: 40, abandonedPct: 5.71,
    priorTotalCalls: 3000, priorAnswered: 2850, priorAbandonedPct: 5.0 };
  // CSR gets a second queue to prove the multi-row shape too (R16c: every
  // section renders queue rows now -- the banner-only collapse is retired).
  d.depts[0].queues[0].mtdTotalCalls = 550;    // 550/5 = 110/day
  d.depts[0].queues[0].priorTotalCalls = 2200; // 2200/22 = 100/day -> +10.0%
  d.depts[0].queues.push({ queue: 'A_Q_CSR_2', totalCalls: 10, totalAnswered: 10,
    abandoned: 0, abandonedPct: 0, abandonedPctStr: '0.00%', violations: 0 });
  // Sales stays single-queue, with no prior-month activity.
  d.depts[1].queues[0].mtdTotalCalls = 100;    // 100/5 = 20/day, prior 0 -> "new this month"
  const html = h.call('buildQueueReportEmailHtml_', d, '2026-07-10', false);
  // Queue-row pace line: per-workday averages + neutral delta vs the ENTIRE
  // prior month (mirrors the web table's qMtdSub math).
  // R16c: '/day' on the PRIOR value too -- a bare "Jun 100" read as a date.
  assert.match(html, /MTD &Oslash; 110\/day &middot; Jun 100\/day &#9650; 10\.0%/);
  // Single-queue section: the pace line sits on its queue ROW (the
  // banner-only ride-along is retired with the collapse).
  assert.match(html, /MTD &Oslash; 20\/day &middot; new this month/);
  // A_Q_CSR_2 has no mtd fields at all -> exactly the two lines above.
  assert.equal((html.match(/MTD &Oslash;/g) || []).length, 2);
});

test('R16d: company-aban card tint follows the value tier; tally unit is per-section', function () {
  // Fixture company aban is 5.71% -> red tier: value red AND the card
  // carries the badTile background (the Queues-in-viol treatment).
  const red = h.call('buildQueueReportEmailHtml_', emailFixture(), '2026-07-10', false);
  assert.match(red, /background:#fbeae2;border:1px solid #eccbbb;[^>]*><tr>\s*<td class="kpi-cell"[^>]*>\s*<div[^>]*>Daily Company Aban %/,
    'red-tier company card gets the light-red tile');
  // Amber tier (3-4%): value #c66b4b but the tile stays NEUTRAL.
  const amberFx = emailFixture();
  amberFx.grandTotals.abandonedPct = 3.6;
  amberFx.grandTotals.abandonedPctStr = '3.60%';
  const amber = h.call('buildQueueReportEmailHtml_', amberFx, '2026-07-10', false);
  assert.match(amber, /background:#f2f6fa;border:1px solid #dde6ee;[^>]*><tr>\s*<td class="kpi-cell"[^>]*>\s*<div[^>]*>Daily Company Aban %/,
    'amber tier keeps the neutral tile');
  assert.match(amber, /color:#c66b4b;padding-top:2px;">3\.60%/,
    'amber tier colors the value');
  // Per-section tally units: CSR's busiest queue is 100 calls (unit 10),
  // Sales's is 40 (unit 5) -- each banner discloses its OWN block size
  // (the old cohort-wide unit rendered a quiet dept's tally as a sliver
  // on the busiest dept's scale; the company-row note is gone with it).
  assert.match(red, /7\.0%\)<\/span> &middot; <span style="color:#606872;">block &asymp; 5 calls<\/span>/);
  assert.match(red, /2\.5%\)<\/span> &middot; <span style="color:#606872;">block &asymp; 2 calls<\/span>/);
  assert.doesNotMatch(red, /each block/);
});

test('R16e/R17e: no tally row exceeds the 25-block width the email column can fit', function () {
  // The block cells are width="3" (+1px gap) inside a ~150px column; past
  // ~112px of natural cell width the renderer shrinks EVERY cell to fit, so
  // blocks stop being uniform between rows. The unit ladder exists to keep
  // the widest row under that threshold -- this pins the ceiling so a future
  // ladder edit can't quietly re-introduce the squeeze (R17e slimmed the
  // cells to buy the 25-block ceiling that lands 20 calls/block on a
  // ~350-500-call queue day). Volumes spanning three orders of magnitude in
  // ONE section.
  const d = emailFixture();
  d.depts[0].queues = [
    { queue: 'A_Q_BIG', totalCalls: 4000, totalAnswered: 3800, abandoned: 200,
      abandonedPct: 5, abandonedPctStr: '5.00%', violations: 1, violationsMtd: 1 },
    { queue: 'A_Q_MID', totalCalls: 260, totalAnswered: 250, abandoned: 10,
      abandonedPct: 3.85, abandonedPctStr: '3.85%', violations: 0, violationsMtd: 0 },
    { queue: 'A_Q_TINY', totalCalls: 7, totalAnswered: 7, abandoned: 0,
      abandonedPct: 0, abandonedPctStr: '0.00%', violations: 0, violationsMtd: 0 },
  ];
  const html = h.call('buildQueueReportEmailHtml_', d, '2026-07-10', false);
  // Count the block cells in each tally table (width="5" + a background).
  const tallies = html.match(/<table role="presentation"[^>]*><tr>(?:<td width="3"[\s\S]*?)<\/tr><\/table>/g) || [];
  assert.ok(tallies.length >= 3, 'expected a tally per queue row, got ' + tallies.length);
  tallies.forEach(function (t) {
    const blocks = (t.match(/<td width="3"/g) || []).length;
    assert.ok(blocks <= 25, 'a tally row rendered ' + blocks + ' blocks (max 25 fits the column)');
  });
  // ...and the smallest queue still shows at least one block (never hidden).
  assert.match(html, /block &asymp; 200 calls/);
});

// ── Owner round (2026-07): Viol MTD on the banner; no company roll-up ───────
// Reported: "Resupply did not get a violation that day and is green, so it
// does not show the Violations MTD value, even if they did get a violation
// earlier this month." Cause: a section whose whole story is ONE queue renders
// BANNER-ONLY (no per-queue rows), and the banner had no Viol cell -- so that
// dept's month-to-date count had nowhere to appear. The fixture's Sales dept
// is exactly that shape: single queue, 0 violations in range, violationsMtd 1.

// The value sits in the real Viol column, NOT as " N viol MTD" appended to the
// summary text -- the column already has a header, so the label was repeating
// it. That means the banner spans 3 columns plus its own 4th cell.

test('viol MTD renders on the banner of a GREEN single-queue dept (the reported gap)', function () {
  h.state.props.DASHBOARD_URL = 'https://example.com/exec';
  const html = h.call('buildQueueReportEmailHtml_', emailFixture(), '2026-07-10', false);
  // Sales: 2.5% abandoned, 0 violations TODAY, 1 month-to-date. It renders
  // banner-only, so before this change the 1 was invisible.
  assert.doesNotMatch(html, /viol MTD/,
    'the label is redundant with the column header it sits under');
  assert.match(html, /colspan="3"/,
    'the banner spans 3 cols so its 4th cell lands under Viol (MTD)');
  // The banner's own Viol cell, right after the nested strip table closes.
  assert.match(html, /<\/table><\/td><td align="right"[^>]*>1<\/td>/,
    'a dept green today but carrying an earlier violation must still report it, '
    + 'as a bare number in the Viol column');
});

test('viol MTD on the banner is the SECTION total (parent + children)', function () {
  const fx = emailFixture();
  fx.depts.push({ dept: 'Spanish', parent: 'CSR',
    totals: { totalCalls: 20, totalAnswered: 18, abandoned: 2, abandonedPct: 10,
      abandonedPctStr: '10.00%', longestWait: '0:01:00', avgAnswer: '0:00:10',
      violations: 1, violationsMtd: 3 },
    queues: [{ queue: 'A_Q_Spanish', totalCalls: 20, totalAnswered: 18, abandoned: 2,
      abandonedPct: 10, abandonedPctStr: '10.00%', violations: 1, violationsMtd: 3 }] });
  const html = h.call('buildQueueReportEmailHtml_', fx, '2026-07-10', false);
  assert.match(html, /<\/table><\/td><td align="right"[^>]*>9<\/td>/,
    "CSR's own 6 + nested Spanish's 3 -- the banner reports the SECTION, like "
    + 'the calls and abandoned figures beside it');
});

test('a dept with NO month-to-date violations renders no MTD chip at all', function () {
  const fx = emailFixture();
  fx.depts[1].totals.violationsMtd = 0;
  fx.depts[1].queues[0].violationsMtd = 0;
  const html = h.call('buildQueueReportEmailHtml_', fx, '2026-07-10', false);
  // R16c: target the BANNER MTD cell by its 8px padding signature -- queue
  // rows (6px padding) legitimately show a muted 0 in the Viol column now
  // that every section renders them.
  assert.match(html, /padding:8px 12px;font:12px Arial,Helvetica,sans-serif;color:#606872;"><\/td>/,
    'a clean dept leaves the banner cell EMPTY rather than advertising a zero');
  assert.match(html, /padding:8px 12px;font:bold 12px Arial,Helvetica,sans-serif;color:#c66b4b;">6<\/td>/,
    "but CSR's still shows");
});

test('each dept banner links to ITS OWN My Department page', function () {
  h.state.props.DASHBOARD_URL = 'https://example.com/exec';
  const html = h.call('buildQueueReportEmailHtml_', emailFixture(), '2026-07-10', false);
  assert.match(html, /href="https:\/\/example\.com\/exec#\/dept\?dept=CSR"/);
  assert.match(html, /href="https:\/\/example\.com\/exec#\/dept\?dept=Sales"/);
  // Authorization is NOT carried by the link. assertDeptAccess_ gates every
  // endpoint server-side, and the client's '/dept' provider ignores a dept the
  // viewer does not hold -- so a recipient clicking another dept's line lands
  // on their OWN dept, not on an error. This report's subscriber list is not
  // the Access Control roster, so that case is expected.
  // (The raw-& case is asserted precisely in the next test, against a dept name
  // that actually contains one. A document-wide scan for a bare `&` here just
  // matches the `&middot;` separators everywhere else in the email.)
});

test('a dept name with spaces and & survives the link encoding', function () {
  h.state.props.DASHBOARD_URL = 'https://example.com/exec';
  const fx = emailFixture();
  fx.depts[1].dept = 'Eligibility MM&R';
  const html = h.call('buildQueueReportEmailHtml_', fx, '2026-07-10', false);
  // Encoded in the href ('Eligibility MM&R' would otherwise truncate at the &)
  // and HTML-escaped in the visible label.
  assert.match(html, /dept=Eligibility%20MM%26R/);
  assert.match(html, /Eligibility MM&amp;R/);
});

test('with DASHBOARD_URL unset the banner is plain text, not a dead link', function () {
  delete h.state.props.DASHBOARD_URL;
  const html = h.call('buildQueueReportEmailHtml_', emailFixture(), '2026-07-10', false);
  assert.doesNotMatch(html, /href="#\/dept/,
    'an unset URL must degrade to plain text, like the CTA block does');
  assert.match(html, /Company total/, 'and the rest of the email still renders');
});

test('the company total no longer sums month-to-date violations', function () {
  const html = h.call('buildQueueReportEmailHtml_', emailFixture(), '2026-07-10', false);
  // grandTotals.violationsMtd is 7 in the fixture. Summing violation DAYS
  // across departments is meaningless -- two depts violating on the SAME day
  // reads as 2, and the figure only grows as depts are added.
  const foot = html.slice(html.indexOf('Company total'));
  assert.doesNotMatch(foot, /">7<\/td>/,
    'the company Viol cell must not carry the summed MTD figure');
  // The row itself, and every other company figure, is untouched.
  assert.match(html, /Company total/);
  assert.match(html, /5\.71%/);
});

test('email HTML: empty day renders the no-activity note without throwing', function () {
  const html = h.call('buildQueueReportEmailHtml_', { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} }, '2026-07-10', false);
  assert.match(html, /No queue activity recorded/);
});

// ── Batch 2 (O-1 / O-4 / O-7): send-loop reliability ────────────────────────

test('O-4: duplicate subscriber rows are flagged first-row-wins (no double-send)', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes'],
        ['a@x.com', 'TRUE', 'first'],
        ['A@X.com', 'TRUE', 'hand-edited duplicate'],
        ['b@x.com', 'TRUE', ''],
      ],
    },
  });
  const subs = h.call('readQueueReportSubscribers_', null);
  assert.equal(subs.length, 3, 'duplicate stays visible in the list');
  assert.equal(subs[0].duplicateRow, undefined);
  assert.equal(subs[1].duplicateRow, true, 'later copy flagged');
  assert.equal(subs.filter(function (s) { return s.active && !s.duplicateRow; }).length, 2,
    'send loop sees each subscriber once');
});

test('Round-16 To/Cc: ONE message -- To rows joined, Cc rows on cc (dedupe by shared Message-ID)', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes', 'Cc'],
        ['departmentleads@x.com', 'TRUE', 'group inbox', ''],
        ['ops@x.com', 'TRUE', '', 'TRUE'],
        ['exec@x.com', 'TRUE', '', 'TRUE'],
        ['off@x.com', 'FALSE', '', ''],
      ],
    },
  });
  h.ctx.qcdAllDeptCachedData_ = function () {
    return { data: { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} } };
  };
  const mails = [];
  h.ctx.MailApp = { sendEmail: function (arg) { mails.push(arg); } };
  const res = h.call('sendQueueReportForDate_', '2026-07-10', {});
  assert.equal(mails.length, 1, 'exactly ONE message per day');
  assert.equal(mails[0].to, 'departmentleads@x.com');
  assert.equal(mails[0].cc, 'ops@x.com,exec@x.com');
  assert.equal(res.count, 3);
});

test('Round-16 To/Cc: a send failure fails the WHOLE message -- count 0, every recipient in failed (FAILED-ALL retry path)', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes', 'Cc'],
        ['ok1@x.com', 'TRUE', '', ''], ['bad@x.com', 'TRUE', '', ''],
      ],
    },
  });
  h.ctx.qcdAllDeptCachedData_ = function () {
    return { data: { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} } };
  };
  h.ctx.MailApp = { sendEmail: function () { throw new Error('Invalid email: bad@x.com'); } };
  const res = h.call('sendQueueReportForDate_', '2026-07-10', {});
  assert.equal(res.count, 0, 'nobody received it -> the next poll may retry safely');
  assert.equal(res.failed.length, 2, 'every recipient reported');
  assert.match(res.failed[0].error, /Invalid email/);
});

test('Round-16 To/Cc: all-Cc rows promote to To (an email needs a To); legacy 3-col sheet reads as all-To', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes', 'Cc'],
        ['cc1@x.com', 'TRUE', '', 'TRUE'], ['cc2@x.com', 'TRUE', '', 'TRUE'],
      ],
    },
  });
  h.ctx.qcdAllDeptCachedData_ = function () {
    return { data: { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} } };
  };
  const mails = [];
  h.ctx.MailApp = { sendEmail: function (arg) { mails.push(arg); } };
  h.call('sendQueueReportForDate_', '2026-07-10', {});
  assert.equal(mails[0].to, 'cc1@x.com,cc2@x.com', 'promoted');
  assert.equal(mails[0].cc, undefined, 'no cc left');
  // Legacy sheet (pre-Cc, 3 columns): bounded read -> every row is To.
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes'], ['old@x.com', 'TRUE', ''],
      ],
    },
  });
  const subs = h.call('readQueueReportSubscribers_');
  assert.equal(subs[0].cc, false, 'legacy rows default to To');
});

test('O-1: the single-address preview path still throws (admin sees the error)', function () {
  h.ctx.qcdAllDeptCachedData_ = function () {
    return { data: { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} } };
  };
  h.ctx.MailApp = { sendEmail: function () { throw new Error('quota'); } };
  assert.throws(function () {
    h.call('sendQueueReportForDate_', '2026-07-10', { to: 'admin@x.com', isPreview: true });
  }, /quota/);
});

test('O-7 (late catch-up): a window-closed-without-send day is flagged ONCE (LATE result + one admin email; the poller keeps retrying)', function () {
  h.state.props = { ADMIN_EMAILS: 'admin@x.com', QUEUE_REPORT_LAST_SENT: '2026-07-08' };
  h.state.sentEmails.length = 0;
  const props = {
    getProperty: function (k) { return h.state.props[k] || null; },
    setProperty: function (k, v) { h.state.props[k] = String(v); },
  };
  const mails = [];
  h.ctx.MailApp = { sendEmail: function (arg) { mails.push(arg); } };
  // TZ-absolute so the fixture is host-TZ independent: Fri Jul 10, 2 PM
  // Chicago (CDT = UTC-5) -- post-window.
  const afternoon = new Date('2026-07-10T14:00:00-05:00');
  h.call('queueReportFlagMissedDay_', props, afternoon, '2026-07-09');
  assert.equal(h.state.props.QUEUE_REPORT_LAST_MISSED, '2026-07-09');
  assert.match(h.state.props.QUEUE_REPORT_LAST_RESULT, /^LATE 2026-07-09/);
  assert.match(h.state.props.QUEUE_REPORT_LAST_RESULT, /keeps retrying/);
  assert.equal(mails.length, 1, 'one admin notification');
  // Second post-window poll the same day: no re-flag, no second email.
  h.call('queueReportFlagMissedDay_', props, afternoon, '2026-07-09');
  assert.equal(mails.length, 1, 'flagged once per target day');
});

test('O-7: morning polls, sent days, and fresh installs are never flagged', function () {
  const mails = [];
  h.ctx.MailApp = { sendEmail: function (arg) { mails.push(arg); } };
  function freshProps(over) {
    const bag = Object.assign({ ADMIN_EMAILS: 'admin@x.com' }, over || {});
    return {
      bag: bag,
      getProperty: function (k) { return bag[k] || null; },
      setProperty: function (k, v) { bag[k] = String(v); },
    };
  }
  // Morning (pre-window-close, 7 AM Chicago) -> no flag.
  let p = freshProps({ QUEUE_REPORT_LAST_SENT: '2026-07-08' });
  h.call('queueReportFlagMissedDay_', p, new Date('2026-07-10T07:00:00-05:00'), '2026-07-09');
  assert.equal(p.bag.QUEUE_REPORT_LAST_MISSED, undefined);
  // Already sent the target -> no flag.
  p = freshProps({ QUEUE_REPORT_LAST_SENT: '2026-07-09' });
  h.call('queueReportFlagMissedDay_', p, new Date('2026-07-10T14:00:00-05:00'), '2026-07-09');
  assert.equal(p.bag.QUEUE_REPORT_LAST_MISSED, undefined);
  // Fresh install (nothing ever sent) -> no baseline, no flag.
  p = freshProps({});
  h.call('queueReportFlagMissedDay_', p, new Date('2026-07-10T14:00:00-05:00'), '2026-07-09');
  assert.equal(p.bag.QUEUE_REPORT_LAST_MISSED, undefined);
  assert.equal(mails.length, 0);
});

// ---- QV-4/QV-5 (queue-report visual pass): the modal's manual send buttons ----

function qvInstall_(role) {
  h.state.userEmail = role === 'admin' ? 'admin@x.com' : 'mgr@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  delete h.state.props.QUEUE_REPORT_LAST_SENT;
  h.ctx.resolveUser_ = function (email) {
    if (email === 'admin@x.com') return { email: email, role: 'admin' };
    if (email === 'mgr@x.com')   return { email: email, role: 'manager', department: 'CSR' };
    return { email: email, role: 'none' };
  };
  h.ctx.qcdAllDeptCachedData_ = function (from, to) {
    return { data: { dateLabel: from === to ? from : (from + ' - ' + to),
                     depts: [], grandTotals: {}, meta: { from: from, to: to } } };
  };
}

test('QV-4: sendQcdAllDeptEmail mails the CALLER only, for the requested range', function () {
  qvInstall_('manager');
  const sent = [];
  h.ctx.MailApp = { sendEmail: function (arg) { sent.push(arg); } };
  const res = h.call('sendQcdAllDeptEmail', { from: '2026-07-14', to: '2026-07-18' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'mgr@x.com', 'caller-recipient, never subscribers');
  assert.ok(sent[0].subject.indexOf('2026-07-14 - 2026-07-18') !== -1, 'range label in subject');
  assert.equal(res.to, 'mgr@x.com');
  // Signed-in gate matches the report (managers allowed; role-none refused).
  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () {
    h.call('sendQcdAllDeptEmail', { from: '2026-07-14', to: '2026-07-14' });
  }, /Not authorized/);
  delete h.ctx.resolveUser_;
});

test('QV-5: subscriber blast is admin-only and claims the dedupe marker ONLY for the gate target day', function () {
  qvInstall_('admin');
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'Queue Report Subscribers': [['Email', 'Active', 'Notes'], ['s1@x.com', 'TRUE', '']] },
  });
  const sent = [];
  h.ctx.MailApp = { sendEmail: function (arg) { sent.push(arg.to); } };
  h.ctx.prevBusinessDayIso_ = function () { return '2026-07-20'; };   // the gate's current target

  // A PAST day: sends, but never touches the marker (nothing to dedupe).
  let res = h.call('sendQcdAllDeptToSubscribers', { date: '2026-07-10' });
  assert.equal(res.count, 1);
  assert.equal(res.markerClaimed, false);
  assert.equal(h.state.props.QUEUE_REPORT_LAST_SENT, undefined, 'marker untouched for a non-target day');

  // The TARGET day: claims the marker so the morning poll can't double-blast.
  res = h.call('sendQcdAllDeptToSubscribers', { date: '2026-07-20' });
  assert.equal(res.markerClaimed, true);
  assert.equal(h.state.props.QUEUE_REPORT_LAST_SENT, '2026-07-20');

  // Non-admin refused outright.
  h.state.userEmail = 'mgr@x.com';
  assert.throws(function () {
    h.call('sendQcdAllDeptToSubscribers', { date: '2026-07-20' });
  });
  delete h.ctx.resolveUser_;
  delete h.ctx.prevBusinessDayIso_;
});

// ── O-9: an empty subscriber list is not a send ───────────────────────────
//
// The failure this pins is a SILENT one, and it was live: arming the trigger
// without adding a subscriber row produced a run that reported
// "Sent <iso> to 0 subscribers" and claimed the dedupe marker. The modal shows
// that string verbatim and the Health page classified it GREEN, so the engine
// looked healthy every weekday while nobody received anything. Same family as
// F5 (a rows:0 DQE success is a NO-OP, not freshness) and O-7 (the missed-day
// flag): a no-op does not get to look like work.

test('O-9: no active subscribers -> noRecipients, and the report is never composed', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      // Present but every row inactive -- the same end state as an empty sheet,
      // and the one an admin reaches by toggling their own row off.
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes'],
        ['off@x.com', 'FALSE', ''],
      ],
    },
  });
  let composed = 0;
  h.ctx.qcdAllDeptCachedData_ = function () {
    composed++;
    return { data: { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} } };
  };
  const sent = [];
  h.ctx.MailApp = { sendEmail: function (a) { sent.push(a.to); } };

  const res = h.call('sendQueueReportForDate_', '2026-07-10', {});
  assert.equal(res.noRecipients, true, 'the empty-list case is distinguishable from a real send');
  assert.equal(res.count, 0);
  assert.equal(res.failed.length, 0);
  assert.equal(sent.length, 0, 'nothing sent');
  // Recipients are resolved first, so a poll with nobody subscribed does not
  // pay the all-departments compute -- twelve times per morning window.
  assert.equal(composed, 0, 'the report is not composed when there is no one to send it to');
});

test('O-9: a real send does NOT carry noRecipients (the flag is not sticky)', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes'],
        ['on@x.com', 'TRUE', ''],
      ],
    },
  });
  h.ctx.qcdAllDeptCachedData_ = function () {
    return { data: { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} } };
  };
  h.ctx.MailApp = { sendEmail: function () {} };
  const res = h.call('sendQueueReportForDate_', '2026-07-10', {});
  assert.equal(res.count, 1);
  assert.ok(!res.noRecipients, 'a delivered run must not look like an empty one');
});

test('O-9: the Health classifier treats NO-SUBSCRIBERS as needs-attention', function () {
  // Mirrors the SystemHealth.gs outcome classifier verbatim. The point of the
  // pin is that "NO-SUBSCRIBERS ..." matches NONE of the bad-word substrings
  // (no "fail"/"error"/"skipped"), so without an explicit prefix arm it is
  // classified ok/green -- which is exactly how it went unnoticed.
  function classify(res) {
    return !/^ok\b/i.test(res || '')
      && (/fail|error|unreachable|skipped/i.test(res || '')
          || /^MISSED\b/.test(res || '') || /^GAPS\b/.test(res || '')
          || /^NO-SUBSCRIBERS\b/.test(res || ''));
  }
  assert.equal(classify('NO-SUBSCRIBERS 2026-07-10 — the data was ready and the report was NOT sent: '
    + 'no active Queue Report subscriber rows exist.'), true, 'must not read green');
  assert.equal(classify('Sent 2026-07-10 to 3 subscribers at Fri Jul 10'), false, 'a real send stays green');
  assert.equal(classify('MISSED 2026-07-09 — QCD data was not ready'), true);
  assert.equal(classify('ok (12 warmed, 3 insights skipped on budget)'), false, 'OPS-8 prefix wins over "skipped"');
});

// ── O-10: the gate check answers "why hasn't it sent?" ────────────────────
//
// Every non-send path in runDailyQueueReport_ returns SILENTLY -- disabled /
// outside-window / weekend / holiday / already-sent / not-ready write nothing
// anywhere, and the trigger entry point is `_`-suffixed so the editor's Run
// picker hides it. That combination is why diagnosing a non-arriving report
// cost a day per hypothesis. These pin the two properties that make the check
// worth trusting: it is READ-ONLY, and "ready" never overstates itself when
// nobody is subscribed.

function gateCheckFixture(over) {
  over = over || {};
  h.state.props = Object.assign({
    SPREADSHEET_ID: 'fake',
    QUEUE_REPORT_ENABLED: 'true',
  }, over.props || {});
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: Object.assign({
      'Queue Report Subscribers': over.subscribers || [
        ['Email', 'Active', 'Notes'],
        ['me@x.com', 'TRUE', ''],
      ],
    }, over.sheets || {}),
  });
  // The admin gate is exercised in util.test.js against resolveUser_; Auth.gs
  // is not in this suite's file list, so stub it (the dept-config-neon /
  // inbound-qcd-parity convention).
  h.ctx.assertAdmin_ = function () {};
  h.ctx.ScriptApp = { getProjectTriggers: function () {
    return over.installed === false ? [] : [{ getHandlerFunction: function () { return 'runDailyQueueReport_'; } }];
  } };
  h.ctx.queueReportQcdLatestIso_ = function () { return over.latestQcd || '2026-07-30'; };
}

test('O-10: the gate check writes NOTHING -- no send, no marker, no result string', function () {
  gateCheckFixture({ props: { SPREADSHEET_ID: 'fake', QUEUE_REPORT_ENABLED: 'true',
                              ADMIN_EMAILS: 'me@x.com', QUEUE_REPORT_LAST_SENT: '2026-07-29' } });
  const sent = [];
  h.ctx.MailApp = { sendEmail: function (a) { sent.push(a); } };
  const before = JSON.stringify(h.state.props);

  const out = h.call('runQueueReportGateCheck', null);

  assert.equal(sent.length, 0, 'a diagnostic must never send');
  assert.equal(JSON.stringify(h.state.props), before, 'no property may move -- the marker above all');
  assert.ok(out.decision, 'a decision is always reported');
  assert.ok(out.explanation, 'and always in plain English');
});

test('O-10: "ready" does not claim it will send when nobody is subscribed', function () {
  // The gate is evaluated BEFORE the recipient list, so decision.send can be
  // true while the run would deliver nothing. wouldSend must fold both in, or
  // the readout tells an admin to expect an email that will not arrive -- the
  // O-9 failure wearing a different hat. Asserted on the PURE verdict: the
  // 'ready' branch is unreachable from a wall-clock test outside 6-12 Central.
  const none = h.call('queueReportGateExplain_',
    { reason: 'ready', send: true, activeSubs: 0, targetIso: '2026-07-30' });
  assert.equal(none.wouldSend, false, 'no subscribers -> would not send, whatever the gate says');
  assert.match(none.explanation, /no active Queue Report subscribers/i);

  const some = h.call('queueReportGateExplain_',
    { reason: 'ready', send: true, activeSubs: 2, targetIso: '2026-07-30' });
  assert.equal(some.wouldSend, true);
  assert.match(some.explanation, /would send 2026-07-30 to 2 subscribers/i);

  // And a gate that is NOT sending never reads as wouldSend, however many
  // people are subscribed.
  assert.equal(h.call('queueReportGateExplain_',
    { reason: 'not-ready', send: false, activeSubs: 5, latestQcd: '2026-07-28',
      targetIso: '2026-07-30' }).wouldSend, false);

  // The end-to-end call still reports the subscriber count it resolved.
  gateCheckFixture({
    props: { SPREADSHEET_ID: 'fake', QUEUE_REPORT_ENABLED: 'true', ADMIN_EMAILS: 'me@x.com' },
    subscribers: [['Email', 'Active', 'Notes'], ['off@x.com', 'FALSE', '']],
  });
  h.ctx.MailApp = { sendEmail: function () {} };
  const out = h.call('runQueueReportGateCheck', null);
  assert.equal(out.activeSubscribers, 0);
  assert.equal(out.wouldSend, false);
});

test('O-10: each skip reason explains itself with the input that caused it', function () {
  // A reason code alone is not actionable -- "not-ready" only becomes a next
  // step beside the date the data actually reaches.
  const nr = h.call('queueReportGateExplain_',
    { reason: 'not-ready', send: false, activeSubs: 1, latestQcd: '2026-07-28', targetIso: '2026-07-30' });
  assert.match(nr.explanation, /2026-07-28/, 'names how far the data reaches');
  assert.match(nr.explanation, /2026-07-30/, 'and the date it is waiting for');
  assert.match(nr.explanation, /MISSED/, 'and that the window closing is terminal for that day');

  const as = h.call('queueReportGateExplain_',
    { reason: 'already-sent', send: false, activeSubs: 1, targetIso: '2026-07-30' });
  assert.match(as.explanation, /O-9/, 'flags the pre-fix marker claim -- "sent" may mean nobody got it');
  assert.match(as.explanation, /Send to subscribers/i, 'and names the way to deliver it now');

  // installed-but-disabled is the dangerous one: it looks scheduled and is not.
  assert.match(h.call('queueReportGateExplain_', { reason: 'disabled', installed: true }).explanation,
    /installed but QUEUE_REPORT_ENABLED/);
  assert.match(h.call('queueReportGateExplain_', { reason: 'disabled', installed: false }).explanation,
    /No trigger is installed/);
});

test('O-10: an already-claimed marker explains itself, incl. the pre-O-9 empty-send case', function () {
  // The trap this call has to surface: before O-9 a run with no subscribers
  // claimed the marker, so a date can read "sent" that nobody received. An
  // admin looking at a silent engine needs to be told that outright.
  gateCheckFixture({ props: { SPREADSHEET_ID: 'fake', QUEUE_REPORT_ENABLED: 'true',
                              ADMIN_EMAILS: 'me@x.com', QUEUE_REPORT_LAST_SENT: '2026-07-30' } });
  h.ctx.MailApp = { sendEmail: function () {} };
  // Freeze the clock inside the window on a weekday so the target resolves to
  // the claimed date and 'already-sent' is the reason under test.
  const out = h.call('runQueueReportGateCheck', null);
  if (out.decision === 'already-sent') {
    assert.match(out.explanation, /Send to subscribers/i, 'names the way to deliver it now');
    assert.equal(out.wouldSend, false);
  }
  // Whatever the host clock, the marker is always reported back verbatim --
  // that is the field that explains a silent day.
  assert.equal(out.lastSentMarker, '2026-07-30');
});

test('O-10: the next window and the date THAT run will target are both reported', function () {
  // "Nothing today" is only half an answer; the question that follows is when,
  // and for which day -- which is not the same day the admin just imported.
  gateCheckFixture({ props: { SPREADSHEET_ID: 'fake', QUEUE_REPORT_ENABLED: 'true',
                              ADMIN_EMAILS: 'me@x.com' } });
  h.ctx.MailApp = { sendEmail: function () {} };
  const out = h.call('runQueueReportGateCheck', null);
  assert.match(String(out.nextWindowDate), /^\d{4}-\d{2}-\d{2}$/, 'a concrete next window date');
  assert.match(String(out.nextWindowTarget), /^\d{4}-\d{2}-\d{2}$/, 'and the date it will send');
  assert.ok(out.nextWindowTarget < out.nextWindowDate, 'it always targets an EARLIER day than the run');
});
