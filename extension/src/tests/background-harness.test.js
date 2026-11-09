'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { worker, unlock, popupSender } = require('./background-harness.js');

test('the default worker clock cannot turn a same-day restart into an accidental midnight refill', async t => {
  const late = new Date(); late.setHours(23, 55, 0, 0);
  t.mock.method(Date, 'now', () => late.getTime());
  const w = worker({ settings: { accessMinutes: 12, siteOverrides: { x: { accessMinutes: 2 } } } });
  assert.equal((await unlock(w)).access.x.remainingMs, 120000);
  assert.equal((await w.send({ type: 'access-duration', site: 'x', minutes: null }, popupSender)).ok, true);
  const restarted = worker(w.data, 'chrome', w.now + 600000);
  const state = (await restarted.send({ type: 'access-status' })).access.x;
  assert.equal(state.sessionMinutes, 12);
  assert.equal(state.remainingMs, 120000);
});
