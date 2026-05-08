/**
 * Data layer.
 *
 * Public API (called via google.script.run from the client):
 *   getDepartmentSummary({ department, from, to })
 *     -> { meta, rows, totals }
 *
 * Step C: returns mocked data so the UI is verifiable end-to-end
 *   without touching the historical sheet. meta.mock === true so the
 *   client can show a "MOCK DATA" banner.
 * Step D: same signature, body replaced with real reads + caching.
 *
 * Authorization: every request re-resolves the caller and rejects
 *   any cross-department access. Admins can request any department
 *   that exists in the dept list; managers are pinned to theirs.
 */

function getDepartmentSummary(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);

  if (user.role === 'none') {
    throw new Error('Not authorized.');
  }

  const dept = String((req && req.department) || '').trim();
  if (!dept) {
    throw new Error('Department is required.');
  }

  if (user.role === 'manager' && dept !== user.department) {
    throw new Error('Not authorized for this department.');
  }
  if (user.role === 'admin' && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }

  const from = String((req && req.from) || '').trim();
  const to = String((req && req.to) || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) {
    throw new Error('from/to must be YYYY-MM-DD.');
  }
  if (from > to) {
    throw new Error('from must be on or before to.');
  }

  return mockSummary_(dept, from, to);
}

function isIsoDate_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

/**
 * Step C mock. Generates plausible-looking rows seeded by the dept
 * name so the same dept always produces the same shape; Step D
 * deletes this and reads real data.
 */
function mockSummary_(dept, from, to) {
  const agentNames = [
    'Mock Agent Alpha',
    'Mock Agent Bravo',
    'Mock Agent Charlie',
    'Mock Agent Delta',
    'Mock Agent Echo',
    'Mock Agent Foxtrot',
  ];

  // Cheap deterministic seed from the dept name.
  let seed = 0;
  for (let i = 0; i < dept.length; i++) seed = (seed + dept.charCodeAt(i)) % 1000;

  const rows = agentNames.map(function (name, i) {
    const k = (seed + i * 13) % 100;
    const rung = 80 + (k * 2) % 60;
    const missed = 4 + (k * 3) % 14;
    const answered = Math.max(0, rung - missed);
    const att = 150 + (k * 2) % 180; // seconds
    return {
      agent: name,
      totalUnique: rung + 5 + (k % 8),
      totalRung: rung,
      totalMissed: missed,
      totalAnswered: answered,
      tttSeconds: answered * att,
      attSeconds: att,
      avgAbdWaitSeconds: 6 + (k % 18),
      csrAvgAbdWaitSeconds: 4 + (k % 12),
      daysActive: 5,
    };
  });

  const totals = rows.reduce(function (acc, r) {
    acc.totalUnique += r.totalUnique;
    acc.totalRung += r.totalRung;
    acc.totalMissed += r.totalMissed;
    acc.totalAnswered += r.totalAnswered;
    acc.tttSeconds += r.tttSeconds;
    return acc;
  }, { totalUnique: 0, totalRung: 0, totalMissed: 0, totalAnswered: 0, tttSeconds: 0 });

  // ATT for the totals row is a weighted avg: sum(TTT) / sum(Answered).
  totals.attSeconds = totals.totalAnswered
    ? Math.round(totals.tttSeconds / totals.totalAnswered)
    : 0;
  // Abandoned-wait totals are simple averages over the agents we have.
  // Not strictly correct (true weighting requires raw abandoned-call
  // counts) but good enough for a header row; we'll revisit in Step D.
  totals.avgAbdWaitSeconds = avg_(rows, 'avgAbdWaitSeconds');
  totals.csrAvgAbdWaitSeconds = avg_(rows, 'csrAvgAbdWaitSeconds');

  return {
    meta: {
      department: dept,
      from: from,
      to: to,
      mock: true,
      generatedAt: new Date().toISOString(),
    },
    rows: rows,
    totals: totals,
  };
}

function avg_(arr, key) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i][key];
  return Math.round(s / arr.length);
}
