'use strict';

/**
 * Faithful-enough shim for Apps Script's `Utilities.formatDate(date, tz, pattern)`.
 *
 * Apps Script formats a Date in a given IANA timezone using a Java
 * SimpleDateFormat pattern. We reproduce that with Intl.DateTimeFormat
 * (which has real IANA-tz support in Node) for the SUBSET of pattern
 * tokens this codebase actually uses:
 *
 *   y/yyyy full year   yy 2-digit year   M/MM month   MMM short name
 *   MMMM full name     d/dd day           H/HH 0-23      h/hh 1-12
 *   m/mm minute        s/ss second        a AM/PM        u ISO weekday
 *   'quoted' literal text ('' = a quote); any non-letter is literal.
 *
 * Any OTHER letter run throws (HT-4) -- see fieldValue below. If a test needs
 * a field that is not listed, model it there rather than guessing.
 */

function partsInTz(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const out = {};
  dtf.formatToParts(ts).forEach(function (p) { out[p.type] = p.value; });
  // Intl can emit '24' for midnight in some ICU builds; normalize to '00'.
  if (out.hour === '24') out.hour = '00';
  return out;
}

function isoDowInTz(ts, tz) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .formatToParts(ts)
    .filter(function (p) { return p.type === 'weekday'; })[0].value;
  return String({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd]);
}

function shortMonthInTz(ts, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' })
    .formatToParts(ts)
    .filter(function (p) { return p.type === 'month'; })[0].value;
}

// HT-4 (broad-scan 2026-10-01): a real TOKENIZER, faithful to Java
// SimpleDateFormat's lexing -- a run of ONE repeated ASCII letter is a field,
// text inside single quotes is literal ('' is an escaped quote), every other
// character is literal. A letter run the shim does not model THROWS instead of
// passing through as text: the real API either formats it (so a passthrough is
// a wrong value the test cannot see) or throws IllegalArgumentException (so a
// passthrough is a production crash the test cannot see). Either way the test
// was green on a lie. Model the field here rather than catching the throw.
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function fieldValue(ch, count, ts, tz, p, pattern) {
  const month = Number(p.month), day = Number(p.day), hour = Number(p.hour);
  const minute = Number(p.minute), second = Number(p.second);
  function num(n) {   // count 1 = unpadded, 2 = 2-digit; wider pads are unmodelled
    if (count === 1) return String(n);
    if (count === 2) return pad2(n);
    return null;
  }
  let v = null;
  switch (ch) {
    case 'y': v = count === 2 ? p.year.slice(-2) : (count <= 4 ? p.year : null); break;   // Java: any count but 2 = full year
    case 'M':
      if (count <= 2) v = num(month);
      else if (count === 3) v = shortMonthInTz(ts, tz);
      else v = MONTHS_LONG[month - 1];
      break;
    case 'd': v = num(day); break;
    case 'H': v = num(hour); break;
    case 'h': v = num(hour % 12 === 0 ? 12 : hour % 12); break;   // 1-12
    case 'm': v = num(minute); break;
    case 's': v = num(second); break;
    case 'a': v = hour < 12 ? 'AM' : 'PM'; break;
    case 'u': v = count === 1 ? isoDowInTz(ts, tz) : null; break;   // ISO 1=Mon..7=Sun
    default: v = null;
  }
  if (v === null) {
    throw new Error('Utilities.formatDate shim: pattern token "' + ch.repeat(count)
      + '" in "' + pattern + '" is not modelled -- add it to tests/harness/formatDate.js (HT-4)');
  }
  return v;
}

function formatDate(date, tz, pattern) {
  // Realm-safe Date check: vm-created Dates fail `instanceof Date`
  // against the host constructor, so duck-type on getTime() instead.
  const ts = (typeof date === 'number')
    ? date
    : (date && typeof date.getTime === 'function')
      ? date.getTime()
      : (function () { throw new TypeError('formatDate: first arg must be a Date'); }());
  const pat = String(pattern);
  const p = partsInTz(ts, tz);
  let out = '';
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === "'") {
      if (pat[i + 1] === "'") { out += "'"; i += 2; continue; }   // '' -> literal quote
      // Quoted literal; inside it, '' is an escaped quote ('it''s' -> it's).
      let j = i + 1, lit = '';
      for (;;) {
        if (j >= pat.length) throw new Error('Utilities.formatDate shim: unterminated quote in "' + pat + '"');
        if (pat[j] === "'") {
          if (pat[j + 1] === "'") { lit += "'"; j += 2; continue; }
          break;
        }
        lit += pat[j++];
      }
      out += lit;
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < pat.length && pat[j] === ch) j++;
      out += fieldValue(ch, j - i, ts, tz, p, pat);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

module.exports = { formatDate };
