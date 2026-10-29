/**
 * DayQuickView.gs -- QV-2 (owner 2026-10-29): ONE request for the My
 * Department day quick view (script-5, dqvOpen_).
 *
 *   getDayQuickView({ department, dates: [iso, ...], outbound, includeExceptionDays, prefetch })
 *     -> { meta: { department, dates, computeMs, partMs },
 *          days: { iso: { summary, missed, outbound, errors: { summary?, missed?, outbound? } } } }
 *
 * The pop-up used to send two or three requests per day (agent table, missed
 * calls, admin outbound) and three more per prefetched neighbour. This one
 * call returns them all, for up to DQV_MAX_DATES_ days at once -- the open day
 * alone, or both neighbours together -- so opening a day costs two requests
 * (the day, then its neighbours) and each arrow step one.
 *
 * It ADDS no data path of its own: each part is the EXISTING public endpoint
 * (getDepartmentSummary / getMissedCallsReport / getDeptOutboundSummary) for a
 * one-day window, so every gate (dept access, the SEC-1 cap, the outbound
 * vetting gate, the admin-only exception-day include), every cache key and
 * every payload shape is the one those endpoints already pin. Running them in
 * ONE execution shares their per-execution memos (the DQE date column, the
 * roster, the exception-day list), which three separate requests re-read.
 *
 * A part that throws is reported in that day's `errors` and the others still
 * return, as the pop-up's sections already load and fail independently. The
 * dept gate runs up front, so a department the viewer cannot reach fails the
 * whole request. Telemetry: the inner endpoints' own usage rows are
 * suppressed (REPORT_USAGE_SUPPRESS_, the cache-warm switch); the request
 * logs ONE `dayView` row, and a prefetch logs none (prefetch rows would count
 * days nobody opened). Read-only (INV-01).
 */

var DQV_MAX_DATES_ = 3;

function getDayQuickView(req) {
  const t0 = Date.now();
  const user = resolveUser_(Session.getActiveUser().getEmail());
  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  assertDeptAccess_(user, dept);   // admin | manager of this dept, else throws
  const raw = (req && Array.isArray(req.dates)) ? req.dates : [];
  const dates = [];
  raw.forEach(function (d) {
    const iso = String(d || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('dates must be YYYY-MM-DD.');
    if (dates.indexOf(iso) === -1) dates.push(iso);
  });
  if (!dates.length) throw new Error('At least one date is required.');
  if (dates.length > DQV_MAX_DATES_) throw new Error('At most ' + DQV_MAX_DATES_ + ' dates per request.');
  const sorted = dates.slice().sort();
  assertReportRangeCap_(sorted[0], sorted[sorted.length - 1]);   // SEC-1 (each part re-checks its own day)

  const wantOb = !!(req && req.outbound);
  const inc = !!(req && (req.includeExceptionDays === true || req.includeExceptionDays === 'true'));
  // partMs: each part's time, so the owner can compare one combined request
  // with the three parallel ones it replaced (the parts run in sequence here).
  const partMs = {};
  const part = function (fn, iso, errors, key) {
    const r = { department: dept, from: iso, to: iso };
    if (inc) r.includeExceptionDays = true;
    const p0 = Date.now();
    try { return fn(r); } catch (e) { errors[key] = (e && e.message) ? e.message : String(e); return null; }
    finally { partMs[iso + ':' + key] = Date.now() - p0; }
  };
  const days = {};
  let allHit = true;
  const prevSuppress = REPORT_USAGE_SUPPRESS_;
  REPORT_USAGE_SUPPRESS_ = true;
  try {
    dates.forEach(function (iso) {
      const errors = {};
      const day = {
        summary: part(getDepartmentSummary, iso, errors, 'summary'),
        missed: part(getMissedCallsReport, iso, errors, 'missed'),
        outbound: wantOb ? part(getDeptOutboundSummary, iso, errors, 'outbound') : null,
        errors: errors,
      };
      [day.summary, day.missed, day.outbound].forEach(function (p) {
        if (p && p.meta && p.meta.cacheHit !== true) allHit = false;
      });
      days[iso] = day;
    });
  } finally {
    REPORT_USAGE_SUPPRESS_ = prevSuppress;
  }
  if (!(req && req.prefetch)) logReportUsage_('dayView', dept, user, allHit);
  return { meta: { department: dept, dates: dates, computeMs: Date.now() - t0, partMs: partMs }, days: days };
}
