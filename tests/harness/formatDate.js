'use strict';

/**
 * Faithful-enough shim for Apps Script's `Utilities.formatDate(date, tz, pattern)`.
 *
 * Apps Script formats a Date in a given IANA timezone using a Java
 * SimpleDateFormat pattern. We reproduce that with Intl.DateTimeFormat
 * (which has real IANA-tz support in Node) for the SUBSET of pattern
 * tokens this codebase actually uses:
 *
 *   yyyy  4-digit year        MM  2-digit month   dd  2-digit day
 *   M     1-2 digit month     d   1-2 digit day
 *   HH    2-digit hour (00-23)  mm  2-digit minute
 *   MMM   short month name (Jan, Feb, ...)
 *
 * Observed call sites (grep Utilities.formatDate): 'yyyy-MM-dd',
 * 'yyyy-MM', 'MMM d', 'HH:mm', 'yyyy-MM-dd HH:mm'. If a test needs a
 * token not listed here, add it to TOKENS + the map below rather than
 * guessing.
 */

function partsInTz(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const out = {};
  dtf.formatToParts(ts).forEach(function (p) { out[p.type] = p.value; });
  // Intl can emit '24' for midnight in some ICU builds; normalize to '00'.
  if (out.hour === '24') out.hour = '00';
  return out;
}

function shortMonthInTz(ts, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' })
    .formatToParts(ts)
    .filter(function (p) { return p.type === 'month'; })[0].value;
}

// Longest-first so 'yyyy' wins over 'yy', 'MMM' over 'MM'/'M', etc.
const TOKENS = /yyyy|yy|MMM|MM|dd|HH|mm|M|d/g;

function formatDate(date, tz, pattern) {
  // Realm-safe Date check: vm-created Dates fail `instanceof Date`
  // against the host constructor, so duck-type on getTime() instead.
  const ts = (typeof date === 'number')
    ? date
    : (date && typeof date.getTime === 'function')
      ? date.getTime()
      : (function () { throw new TypeError('formatDate: first arg must be a Date'); }());
  const p = partsInTz(ts, tz);
  const map = {
    yyyy: p.year,
    yy: p.year.slice(-2),
    MMM: shortMonthInTz(ts, tz),
    MM: p.month,
    dd: p.day,
    HH: p.hour,
    mm: p.minute,
    M: String(Number(p.month)),
    d: String(Number(p.day)),
  };
  return String(pattern).replace(TOKENS, function (tok) { return map[tok]; });
}

module.exports = { formatDate };
