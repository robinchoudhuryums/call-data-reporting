/**
 * Inbound Report -- admin-only analytical view of the per-call inbound data
 * captured in Neon's `inbound_calls` (written by cdr-import/inboundCalls.js),
 * with insurer labels via the `insurance_numbers` reference table.
 *
 * Answers: how many inbound calls (per insurer / per advertised dial-in line
 * / per entry queue / per dial-in x insurer cross-cut), answered vs abandoned
 * vs abandoned-on-hold, average wait, the daily trend, and how all of it
 * compares to the immediately-preceding same-length window (INV-28, via the
 * shared computePriorWindow_).
 *
 * Public entry (callable via google.script.run):
 *   getInboundReport({ from, to }) -> { meta, kpis, kpisPrior, byInsurer,
 *                                       byDialIn, byQueue, byDialInInsurer,
 *                                       daily }
 *
 * Admin-only at the server boundary (assertAdmin_) -- it's a company-wide
 * cross-dept/queue view. Reads Neon via getDashboardNeonConn_ (same
 * NEON_* props + script.external_request scope as the F1 read-back). Reads
 * ALL aggregates in ONE round-trip (json_build_object) -- Apps Script JDBC
 * is ~0.5s/row, so per-row iteration is not an option. Best-effort: any
 * Neon null/error returns the empty shape with meta.available=false, so the
 * modal renders a clean "unavailable" state rather than throwing.
 *
 * Caching: 30 min (REPORT_CACHE_TTL_SECONDS) per (from, to) under
 * INBOUND_CACHE_KEY_PREFIX.
 */

// v2: kpisPrior (auto-adjacent INV-28 window) + meta.priorFrom/priorTo;
// avg_wait on the byInsurer / byDialIn / byQueue rows; new
// byDialInInsurer cross-cut (marketing-line x insurer attribution).
const INBOUND_CACHE_KEY_PREFIX = 'inbound:v2';
const INBOUND_TOP_N = 50;

function getInboundReport(req) {
  assertAdmin_();   // company-wide view -> admin only

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');

  const cache = CacheService.getScriptCache();
  const cacheKey = INBOUND_CACHE_KEY_PREFIX + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { const p = JSON.parse(cached); p.meta.cacheHit = true; return p; }
    catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeInboundReport_(from, to);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;
  // Only cache USABLE payloads. An unavailable result (Neon unreachable /
  // table missing / query error) must NOT be pinned for the 30-min report
  // TTL -- a transient Neon blip would otherwise render the modal
  // "unavailable" for every admin until the entry expires. Skipping the
  // put means the next request simply retries Neon.
  if (data.meta.available) {
    try { cache.put(cacheKey, JSON.stringify(data), REPORT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('InboundReport cache put failed: %s', e); }
  }
  return data;
}

function computeInboundReport_(from, to) {
  const empty = emptyInboundReport_(from, to);
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { empty.meta.available = false; return empty; }

    // Comparison window: immediately-preceding same-length window via the
    // shared INV-28 implementation (Data.gs). Derived from the validated
    // from/to, so inlining its ISO strings below is as safe as inlining
    // from/to themselves.
    const prior = computePriorWindow_(from, to);

    // from/to are validated ISO (isIsoDate_) -> safe to inline. ONE query,
    // ONE getString. caller_hash IS NOT NULL drops anonymous callers from the
    // per-insurer/per-number cuts (they can't be labeled) but they still count
    // in the headline KPIs + per-queue.
    const dr = "c.call_date BETWEEN '" + from + "'::date AND '" + to + "'::date";
    const priorDr = "c.call_date BETWEEN '" + prior.from + "'::date AND '" + prior.to + "'::date";
    const kpiSelect = function (range) {
      return "(SELECT json_build_object(" +
            "'total', count(*), " +
            "'answered', count(*) FILTER (WHERE disposition='answered'), " +
            "'abandoned', count(*) FILTER (WHERE disposition='abandoned'), " +
            "'missed', count(*) FILTER (WHERE disposition='missed'), " +
            "'abandonedOnHold', count(*) FILTER (WHERE abandoned_on_hold), " +
            "'anonymous', count(*) FILTER (WHERE caller_hash IS NULL), " +
            "'avgWaitSec', COALESCE(round(avg(wait_seconds))::int, 0), " +
            "'avgHoldSec', COALESCE(round(avg(NULLIF(hold_seconds,0)))::int, 0)" +
          ") FROM inbound_calls c WHERE " + range + ")";
    };
    const sql =
      "SELECT json_build_object(" +
        "'kpis', " + kpiSelect(dr) + ", " +
        "'kpisPrior', " + kpiSelect(priorDr) + ", " +
        "'byInsurer', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(i.insurance_name,'(unlabeled)') AS label, count(*) AS calls, " +
              "count(*) FILTER (WHERE c.disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE c.disposition='abandoned') AS abandoned, " +
              "count(*) FILTER (WHERE c.abandoned_on_hold) AS on_hold, " +
              "COALESCE(round(avg(c.wait_seconds))::int, 0) AS avg_wait " +
            "FROM inbound_calls c LEFT JOIN insurance_numbers i ON i.phone_hash=c.caller_hash " +
            "WHERE " + dr + " AND c.caller_hash IS NOT NULL " +
            "GROUP BY 1 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        "'byDialIn', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(dial_in_number,'(none)') AS label, count(*) AS calls, " +
              "count(*) FILTER (WHERE disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE disposition='abandoned') AS abandoned, " +
              "COALESCE(round(avg(wait_seconds))::int, 0) AS avg_wait " +
            "FROM inbound_calls c WHERE " + dr + " " +
            "GROUP BY 1 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        "'byQueue', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(entry_queue,'(none)') AS label, count(*) AS calls, " +
              "count(*) FILTER (WHERE disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE disposition='abandoned') AS abandoned, " +
              "COALESCE(round(avg(wait_seconds))::int, 0) AS avg_wait " +
            "FROM inbound_calls c WHERE " + dr + " " +
            "GROUP BY 1 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        "'byDialInInsurer', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(c.dial_in_number,'(none)') AS dial_in, " +
              "COALESCE(i.insurance_name,'(unlabeled)') AS insurer, count(*) AS calls, " +
              "count(*) FILTER (WHERE c.disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE c.disposition='abandoned') AS abandoned " +
            "FROM inbound_calls c LEFT JOIN insurance_numbers i ON i.phone_hash=c.caller_hash " +
            "WHERE " + dr + " AND c.caller_hash IS NOT NULL " +
            "GROUP BY 1, 2 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        "'daily', (SELECT COALESCE(json_agg(t ORDER BY t.d), '[]') FROM (" +
            "SELECT call_date::text AS d, count(*) AS calls, " +
              "count(*) FILTER (WHERE disposition='abandoned') AS abandoned " +
            "FROM inbound_calls c WHERE " + dr + " GROUP BY 1) t)" +
      ")::text AS j";

    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : null;
    rs.close(); stmt.close();
    if (!json) { empty.meta.available = false; return empty; }

    const obj = JSON.parse(json);
    const shapeKpis = function (k) {
      k = k || {};
      const total = Number(k.total) || 0;
      return {
        total:           total,
        answered:        Number(k.answered) || 0,
        abandoned:       Number(k.abandoned) || 0,
        missed:          Number(k.missed) || 0,
        abandonedOnHold: Number(k.abandonedOnHold) || 0,
        anonymous:       Number(k.anonymous) || 0,
        avgWaitSec:      Number(k.avgWaitSec) || 0,
        avgHoldSec:      Number(k.avgHoldSec) || 0,
        abandonRate:     total > 0 ? Math.round((Number(k.abandoned) || 0) / total * 1000) / 10 : 0,
        answerRate:      total > 0 ? Math.round((Number(k.answered) || 0) / total * 1000) / 10 : 0,
      };
    };
    const kpis = shapeKpis(obj.kpis);
    return {
      meta: {
        from: from, to: to, available: true,
        priorFrom: prior.from, priorTo: prior.to,
        rows: kpis.total, generatedAt: new Date().toISOString(),
      },
      kpis: kpis,
      kpisPrior: shapeKpis(obj.kpisPrior),
      byInsurer:       Array.isArray(obj.byInsurer)       ? obj.byInsurer       : [],
      byDialIn:        Array.isArray(obj.byDialIn)        ? obj.byDialIn        : [],
      byQueue:         Array.isArray(obj.byQueue)         ? obj.byQueue         : [],
      byDialInInsurer: Array.isArray(obj.byDialInInsurer) ? obj.byDialInInsurer : [],
      daily:           Array.isArray(obj.daily)           ? obj.daily           : [],
    };
  } catch (e) {
    // Table missing / Neon error -> graceful empty (modal shows "unavailable").
    Logger.log('computeInboundReport_ failed (best-effort): ' + (e && e.message ? e.message : e));
    if (typeof recordNeonReadFailure_ === 'function') recordNeonReadFailure_('computeInboundReport_', e);
    empty.meta.available = false;
    return empty;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

function emptyInboundReport_(from, to) {
  const zeroKpis = function () {
    return {
      total: 0, answered: 0, abandoned: 0, missed: 0, abandonedOnHold: 0,
      anonymous: 0, avgWaitSec: 0, avgHoldSec: 0, abandonRate: 0, answerRate: 0,
    };
  };
  const prior = computePriorWindow_(from, to);
  return {
    meta: {
      from: from, to: to, available: true,
      priorFrom: prior.from, priorTo: prior.to,
      rows: 0, generatedAt: new Date().toISOString(),
    },
    kpis: zeroKpis(),
    kpisPrior: zeroKpis(),
    byInsurer: [], byDialIn: [], byQueue: [], byDialInInsurer: [], daily: [],
  };
}
