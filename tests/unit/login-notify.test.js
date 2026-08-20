'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// R18d sign-in notifications (Auth.gs): email the admins on the FIRST
// sighting of an address at doGet -- granted or denied -- and again when
// that address's outcome class CHANGES (denied -> manager after an Access
// Control grant, a dept reassignment, a revocation). Repeat visits with an
// unchanged outcome are silent. These tests pin the pure decision core +
// the outcome-key mapper; the send itself is a thin MailApp call inside
// doGet's best-effort try/catch.
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs'] });

const decide = (storeJson, email, key, max) =>
  JSON.parse(JSON.stringify(h.call('loginNotifyDecide_', storeJson, email, key, max)));
const keyOf = (user) => h.call('loginNotifyOutcomeKey_', user);

test('first sighting notifies and records; a repeat with the same outcome is silent', function () {
  const d1 = decide('{}', 'jane@x.com', 'manager:CSR');
  assert.equal(d1.notify, true);
  assert.equal(d1.reason, 'first');
  const stored = JSON.stringify(d1.store);
  const d2 = decide(stored, 'jane@x.com', 'manager:CSR');
  assert.equal(d2.notify, false, 'unchanged outcome must not re-mail on every page view');
});

test('an outcome CHANGE notifies again and reports what it was', function () {
  const denied = decide('{}', 'new@x.com', 'denied');
  assert.equal(denied.reason, 'first');
  const granted = decide(JSON.stringify(denied.store), 'new@x.com', 'manager:Sales');
  assert.equal(granted.notify, true);
  assert.equal(granted.reason, 'changed');
  assert.equal(granted.prev, 'denied');
});

test('a dept reassignment is an outcome change (the key carries the dept list)', function () {
  assert.equal(keyOf({ role: 'manager', department: 'CSR', departments: ['CSR'] }), 'manager:CSR');
  assert.equal(keyOf({ role: 'manager', department: 'CSR', departments: ['CSR', 'Sales'] }), 'manager:CSR+Sales');
  assert.equal(keyOf({ role: 'manager', allDepts: true, departments: ['A', 'B'] }), 'manager:ALL');
  assert.equal(keyOf({ role: 'admin' }), 'admin');
  assert.equal(keyOf({ role: 'none' }), 'denied');
  assert.equal(keyOf(null), 'denied');
});

test('corrupt store JSON is treated as empty, never a throw into doGet', function () {
  const d = decide('not json{', 'jane@x.com', 'admin');
  assert.equal(d.notify, true);
  assert.equal(d.reason, 'first');
});

// B3 (broad-scan F4): a full store used to notify WITHOUT recording, so the
// same address was a "first sighting" again on its very next visit and the
// branch emailed on EVERY page view, forever. MailApp's daily quota is shared
// with alerts, digests and the queue report, so that "extra signal" was paid
// for by the channel carrying the real signal. It now evicts the oldest entry
// and RECORDS the new address: bounded store, exactly one email per address.
test('a FULL store stays bounded, notifies ONCE, and evicts the oldest entry', function () {
  const full = {};
  for (let i = 0; i < 5; i++) full['u' + i + '@x.com'] = 'denied';
  const d = decide(JSON.stringify(full), 'overflow@x.com', 'denied', 5);
  assert.equal(d.notify, true, 'a new address past the cap still notifies');
  assert.equal(Object.keys(d.store).length, 5, 'and the store still does not grow');
  assert.equal(d.evicted, 'u0@x.com', 'the OLDEST entry makes way');
  assert.equal(d.store['overflow@x.com'], 'denied', 'the new address is RECORDED...');
  assert.equal(d.store['u0@x.com'], undefined, '...at the oldest entry\'s expense');

  // The whole point: the SECOND visit is silent. Under the old behavior this
  // returned notify:true again, and again, without limit.
  const again = decide(JSON.stringify(d.store), 'overflow@x.com', 'denied', 5);
  assert.equal(again.notify, false,
    'a repeat visit past the cap must not re-mail — that was the unbounded path');

  // Known users keep change-detection even at the cap.
  const known = decide(JSON.stringify(full), 'u3@x.com', 'manager:CSR', 5);
  assert.equal(known.notify, true);
  assert.equal(known.prev, 'denied');
  assert.equal(known.evicted, null, 'a KNOWN address updates in place, evicting nothing');
});

test('B3: repeated new addresses at the cap each cost exactly one email', function () {
  let store = {};
  for (let i = 0; i < 5; i++) store['u' + i + '@x.com'] = 'denied';
  let mails = 0;
  // Ten distinct scanners, three visits each, against a full store.
  for (let n = 0; n < 10; n++) {
    for (let visit = 0; visit < 3; visit++) {
      const d = decide(JSON.stringify(store), 'scan' + n + '@x.com', 'denied', 5);
      if (d.notify) mails++;
      store = d.store;
    }
  }
  assert.equal(mails, 10, 'one email per address, not one per visit (was 30)');
  assert.equal(Object.keys(store).length, 5, 'store stayed at the cap throughout');
});
