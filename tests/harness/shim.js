'use strict';

const crypto = require('crypto');
const { formatDate } = require('./formatDate');

/**
 * Builds a set of mock Apps Script global services + a `state` handle
 * tests use to drive them. One shim instance backs one loaded context
 * (see loadGas.js).
 *
 * Coverage is intentionally scoped to what the loaded .gs functions
 * call at TEST time. Since Batch 11 (HT-3/HT-5) the services MODEL the
 * platform limits that turn into production failures -- cache key/value
 * caps, property value/store caps, the 20-trigger cap, a live trigger set
 * and real lock state -- rather than accepting anything. Email stays a
 * capture (state.sentEmails).
 */
// HT-3: CacheService's documented limits.
const CACHE_MAX_KEY_CHARS = 250;
const CACHE_MAX_VALUE_BYTES = 100 * 1024;
// HT-5: Script Properties + trigger quotas.
const PROP_MAX_VALUE_BYTES = 9 * 1024;
const PROP_MAX_STORE_BYTES = 500 * 1024;
const TRIGGER_MAX_PER_SCRIPT = 20;

function createShim() {
  const state = {
    userEmail: 'nobody@example.com',  // Session.getActiveUser().getEmail()
    props: {},                        // Script Properties
    cache: new Map(),                 // CacheService script cache
    spreadsheet: null,                // current fake spreadsheet (set per test)
    spreadsheetsById: {},             // 1b: SpreadsheetApp.create() registry, keyed by id
    createdSpreadsheets: [],          // 1b: every fake SpreadsheetApp.create() call, in order
    createdTriggers: [],              // ING-4: handler names of ScriptApp.newTrigger(...).create() calls
    strictOpenById: false,            // 1b: true -> openById THROWS for an unknown id (real API)
    sentEmails: [],                   // MailApp.sendEmail captures
    locks: 0,                         // LockService.tryLock call count
    lockBusy: false,                  // A-6: true -> tryLock/waitLock report the lock as held
    mailQuota: undefined,             // MailApp.getRemainingDailyQuota (B4)
    cacheLimitHits: [],               // HT-3: every CacheService key/value-size refusal
    propLimitHits: [],                // HT-5: every Script Properties size refusal
    triggers: [],                     // HT-5: the LIVE trigger set getProjectTriggers returns
    triggerSeq: 0,                    // HT-5: unique-id counter
    deletedTriggers: [],              // HT-5: handler names passed to deleteTrigger, in order
    lockHeld: false,                  // HT-5: this execution holds the script lock
    lockReleases: 0,                  // HT-5: releaseLock calls that released a held lock
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
      // Batch 10: computeReportUsageSummary_ formats lastUsed in script TZ.
      getScriptTimeZone: function () { return 'America/Chicago'; },
    },

    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(state.props, k) ? state.props[k] : null; },
          // HT-5: the two documented store limits, enforced -- 9 KB per value
          // and 500 KB for the whole store (PROPS-1's Health row watches the
          // second). Both throw before writing, as the real store does.
          setProperty: function (k, v) {
            const val = String(v);
            if (Buffer.byteLength(val, 'utf8') > PROP_MAX_VALUE_BYTES) {
              state.propLimitHits.push({ kind: 'value', key: k });
              throw new Error('Argument too large: value');
            }
            let total = Buffer.byteLength(String(k), 'utf8') + Buffer.byteLength(val, 'utf8');
            Object.keys(state.props).forEach(function (pk) {
              if (pk !== k) total += Buffer.byteLength(pk, 'utf8') + Buffer.byteLength(String(state.props[pk]), 'utf8');
            });
            if (total > PROP_MAX_STORE_BYTES) {
              state.propLimitHits.push({ kind: 'store', key: k, bytes: total });
              throw new Error('You have exceeded the property storage quota. Please remove some properties and try again.');
            }
            state.props[k] = val;
            return this;
          },
          deleteProperty: function (k) { delete state.props[k]; return this; },
          // prop-registry batch: the Health inventory reads the whole store.
          getProperties: function () {
            const out = {};
            Object.keys(state.props).forEach(function (k) { out[k] = state.props[k]; });
            return out;
          },
        };
      },
    },

    // HT-3 (broad-scan 2026-10-01): the real service's two size limits are
    // ENFORCED, so INV-36 (hashAgents_ keeps keys bounded) and F6 (the Overview
    // blob near the per-value cap) are pinned by behaviour, not only by source
    // text. A key over 250 chars throws on get/put/remove alike (the platform
    // rejects it before looking anything up -- the IR/Insights big-roster bug
    // surfaced on cache.get); a value over 100 KB throws on put.
    // `state.cacheLimitHits` records each refusal for tests that assert one.
    CacheService: {
      getScriptCache: function () {
        function checkKey(k) {
          if (String(k).length > CACHE_MAX_KEY_CHARS) {
            state.cacheLimitHits.push({ kind: 'key', length: String(k).length });
            throw new Error('Argument too large: key');
          }
        }
        return {
          get: function (k) { checkKey(k); return state.cache.has(k) ? state.cache.get(k) : null; },
          put: function (k, v) {
            checkKey(k);
            const bytes = Buffer.byteLength(String(v), 'utf8');
            if (bytes > CACHE_MAX_VALUE_BYTES) {
              state.cacheLimitHits.push({ kind: 'value', bytes: bytes });
              throw new Error('Argument too large: value');
            }
            state.cache.set(k, v);
          },
          remove: function (k) { checkKey(k); state.cache.delete(k); },
        };
      },
    },

    SpreadsheetApp: {
      openById: function (id) {
        // 1b: a spreadsheet this run CREATED resolves by id; anything else is
        // the test's one fake workbook (the historical behaviour), unless a
        // suite opts into the real API's throw for an unknown id.
        if (id && Object.prototype.hasOwnProperty.call(state.spreadsheetsById, id)) return state.spreadsheetsById[id];
        if (state.strictOpenById) throw new Error('Requested entity was not found. (openById: ' + id + ')');
        if (!state.spreadsheet) throw new Error('No fake spreadsheet set on shim.state.spreadsheet');
        return state.spreadsheet;
      },
      // 1b: real SpreadsheetApp.create, modelled -- a new workbook with the
      // default "Sheet1" tab, registered so openById finds it afterwards.
      create: function (name) {
        const { makeFakeSpreadsheet } = require('./fakeSheet');
        const id = 'fake-ss-' + (state.createdSpreadsheets.length + 1);
        const ss = makeFakeSpreadsheet({ id: id, name: name, sheets: { Sheet1: [] } });
        state.spreadsheetsById[id] = ss;
        state.createdSpreadsheets.push(ss);
        return ss;
      },
      // The cdr-report/cdr-import pipeline reads the active spreadsheet
      // (loadRosterCanonicalNames_ falls back to getActive()).
      getActive: function () { return state.spreadsheet; },
      getActiveSpreadsheet: function () { return state.spreadsheet; },
      flush: function () {},   // T-1: sheetRepairs' merge flushes between write + delete
    },

    // HT-5: the script lock is ONE lock with real held/released state, so a
    // test can assert a writer released it (state.lockHeld false afterwards)
    // and hasLock() exists. lockBusy still models ANOTHER execution holding it.
    LockService: {
      getScriptLock: function () {
        return {
          tryLock: function () {
            state.locks++;
            if (state.lockBusy) return false;
            state.lockHeld = true;
            return true;
          },
          waitLock: function () {   // R7: saveUiFlags path
            state.locks++;
            if (state.lockBusy) throw new Error('Lock timeout: another process was holding the lock for too long.');
            state.lockHeld = true;
          },
          releaseLock: function () { if (state.lockHeld) state.lockReleases++; state.lockHeld = false; },
          hasLock: function () { return state.lockHeld; },
        };
      },
    },

    MailApp: {
      sendEmail: function (arg) { state.sentEmails.push(arg); },
      // Real method, modelled rather than omitted: the Health page reads it
      // (B4). Tests override state.mailQuota to drive the low-quota branch.
      getRemainingDailyQuota: function () {
        return state.mailQuota === undefined ? 1500 : state.mailQuota;
      },
    },

    // HT-5: triggers are MODELLED, not discarded -- create() registers a
    // trigger getProjectTriggers() returns and deleteTrigger() removes, so an
    // installer's "remove the old one first" loop and its idempotence are
    // exercised (getProjectTriggers used to return [] forever, so a double
    // install looked clean). The real per-script cap of 20 triggers throws.
    // state.createdTriggers keeps its historical shape (handler names, in
    // creation order, never pruned by delete); state.triggers is the live set.
    ScriptApp: {
      newTrigger: function (handler) {
        const spec = { handler: handler, kind: 'CLOCK' };
        const builder = {
          timeBased: function () { return builder; },
          everyDays: function (n) { spec.everyDays = n; return builder; },
          everyWeeks: function (n) { spec.everyWeeks = n; return builder; },
          everyHours: function (n) { spec.everyHours = n; return builder; },
          everyMinutes: function (n) { spec.everyMinutes = n; return builder; },
          after: function (ms) { spec.after = ms; return builder; },   // ING-4: the one-shot catch-up
          atHour: function (h) { spec.atHour = h; return builder; },
          onWeekDay: function (d) { spec.onWeekDay = d; return builder; },
          onMonthDay: function (d) { spec.onMonthDay = d; return builder; },
          nearMinute: function (m) { spec.nearMinute = m; return builder; },
          inTimezone: function (tz) { spec.timezone = tz; return builder; },
          create: function () {
            if (state.triggers.length >= TRIGGER_MAX_PER_SCRIPT) {
              throw new Error('This script has too many triggers. Triggers must be deleted from the script before more can be added.');
            }
            const id = 'fake-trigger-' + (++state.triggerSeq);
            const t = {
              _spec: spec,
              getUniqueId: function () { return id; },
              getHandlerFunction: function () { return handler; },
              getEventType: function () { return spec.kind; },
              getTriggerSource: function () { return 'CLOCK'; },
            };
            state.triggers.push(t);
            state.createdTriggers.push(handler);
            return t;
          },
        };
        return builder;
      },
      getProjectTriggers: function () { return state.triggers.slice(); },
      // TST-1: ONE WeekDay literal -- a duplicate key here once silently
      // clobbered SATURDAY/SUNDAY (legal duplicate-key semantics), so a
      // trigger-schedule test would have passed `undefined` into the
      // builder and still gone green.
      WeekDay: { MONDAY: 'MONDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
      deleteTrigger: function (t) {
        const i = state.triggers.indexOf(t);
        if (i >= 0) state.triggers.splice(i, 1);
        state.deletedTriggers.push(t && t.getHandlerFunction ? t.getHandlerFunction() : t);
      },
    },

    Utilities: Utilities,
  };

  return { globals: globals, state: state };
}

module.exports = { createShim };
