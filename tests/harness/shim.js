'use strict';

const crypto = require('crypto');
const { formatDate } = require('./formatDate');

/**
 * Builds a set of mock Apps Script global services + a `state` handle
 * tests use to drive them. One shim instance backs one loaded context
 * (see loadGas.js).
 *
 * Coverage is intentionally scoped to what the loaded .gs functions
 * call at TEST time. Write/trigger/email services (LockService,
 * MailApp, ScriptApp) are stubbed permissively so files load and
 * admin-gated config writes can be exercised, but their side effects
 * are no-ops captured in `state` where useful.
 */
function createShim() {
  const state = {
    userEmail: 'nobody@example.com',  // Session.getActiveUser().getEmail()
    props: {},                        // Script Properties
    cache: new Map(),                 // CacheService script cache
    spreadsheet: null,                // current fake spreadsheet (set per test)
    sentEmails: [],                   // MailApp.sendEmail captures
    locks: 0,                         // LockService.tryLock call count
  };

  function computeDigest(_algorithm, str) {
    // Apps Script returns a signed byte[] (-128..127). Node's md5
    // digest is unsigned (0..255); map high bytes negative so the
    // production hex-rebuild loop (which re-adds 256) round-trips.
    const buf = crypto.createHash('md5').update(String(str), 'utf8').digest();
    return Array.from(buf).map(function (b) { return b > 127 ? b - 256 : b; });
  }

  function computeHmacSha256Signature(value, key) {
    // Same signed byte[] convention as computeDigest (the production
    // hex-rebuild masks with & 0xff, so signed-vs-unsigned round-trips).
    const buf = crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest();
    return Array.from(buf).map(function (b) { return b > 127 ? b - 256 : b; });
  }

  const Utilities = {
    formatDate: formatDate,
    computeDigest: computeDigest,
    computeHmacSha256Signature: computeHmacSha256Signature,
    DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    newBlob: function (data) { return { getBytes: function () { return data; }, getDataAsString: function () { return String(data); } }; },
    base64Encode: function (bytes) { return Buffer.from(bytes).toString('base64'); },
    base64Decode: function (str) { return Array.from(Buffer.from(String(str), 'base64')); },
    parseDate: function () { throw new Error('Utilities.parseDate is not shimmed; add it if a test needs it.'); },
    sleep: function () {},
    // Deterministic uuid (escalation writes stamp activity rows with it).
    getUuid: (function () { let n = 0; return function () { return 'uuid-' + (++n); }; })(),
  };

  const globals = {
    console: console,
    Logger: { log: function () {} },

    Session: {
      getActiveUser: function () { return { getEmail: function () { return state.userEmail; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return state.userEmail; } }; },
    },

    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(state.props, k) ? state.props[k] : null; },
          setProperty: function (k, v) { state.props[k] = String(v); return this; },
          deleteProperty: function (k) { delete state.props[k]; return this; },
        };
      },
    },

    CacheService: {
      getScriptCache: function () {
        return {
          get: function (k) { return state.cache.has(k) ? state.cache.get(k) : null; },
          put: function (k, v) { state.cache.set(k, v); },
          remove: function (k) { state.cache.delete(k); },
        };
      },
    },

    SpreadsheetApp: {
      openById: function () {
        if (!state.spreadsheet) throw new Error('No fake spreadsheet set on shim.state.spreadsheet');
        return state.spreadsheet;
      },
      // The cdr-report/cdr-import pipeline reads the active spreadsheet
      // (loadRosterCanonicalNames_ falls back to getActive()).
      getActive: function () { return state.spreadsheet; },
      getActiveSpreadsheet: function () { return state.spreadsheet; },
    },

    LockService: {
      getScriptLock: function () {
        return {
          tryLock: function () { state.locks++; return true; },
          releaseLock: function () {},
        };
      },
    },

    MailApp: {
      sendEmail: function (arg) { state.sentEmails.push(arg); },
    },

    ScriptApp: {
      newTrigger: function () {
        const builder = {
          timeBased: function () { return builder; },
          everyDays: function () { return builder; },
          atHour: function () { return builder; },
          onWeekDay: function () { return builder; },
          nearMinute: function () { return builder; },
          create: function () { return { getUniqueId: function () { return 'fake-trigger'; } }; },
        };
        return builder;
      },
      getProjectTriggers: function () { return []; },
      deleteTrigger: function () {},
      WeekDay: { MONDAY: 'MONDAY' },
    },

    Utilities: Utilities,
  };

  return { globals: globals, state: state };
}

module.exports = { createShim };
