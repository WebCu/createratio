'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../core/core.js');
const { worker, unlock, gate, popupSender, intent, rulesFor } = require('./background-harness.js');
const start = new Date(2026, 9, 11, 12).getTime();
const status = async (w, expectedErrors = 0) => {
  const result = await w.send({ type: 'access-status' });
  assert.equal(result.ok, true);
  assert.equal(w.errors.length, expectedErrors);
  return result.access;
};

for (const browser of ['chrome', 'browser']) {
  for (const site of ['x', 'linkedin', 'tiktok', 'instagram']) {
    test(`${browser}: ${site} shares intention, wait, custom time, pause, expiry and Off behavior`, async () => {
      const w = worker({ settings: { trackedSites: [site], siteOverrides: { [site]: { accessMinutes: 2 } } } }, browser, start);
      let access = await status(w);
      assert.ok(access[site], `${site} needs an access gate`);
      assert.equal(access[site].remainingMs, 0);
      assert.deepEqual(rulesFor(w, [site]), []);
      const home = access[site].home;
      w.tabs.push({ id: 1, url: home });
      assert.equal((await w.send({ type: 'access-begin', site, reason: intent }, gate(site))).ok, true);
      assert.equal((await w.send({ type: 'access-open', site }, gate(site))).ok, false);
      w.advance(60000);
      assert.equal((await status(w))[site].remainingMs, 0, 'waiting alone never unlocks');
      assert.equal((await w.send({ type: 'access-open', site }, gate(site))).ok, true);
      w.activate(home);
      assert.equal((await status(w))[site].remainingMs, 120000);
      assert.deepEqual(rulesFor(w, [site]), require('../../sites/index.js').get(site).access.sessionRules);
      w.advance(15000); w.blur();
      assert.equal((await status(w))[site].remainingMs, 105000);
      w.advance(30000);
      assert.equal((await status(w))[site].remainingMs, 105000, 'away time does not spend budget');
      w.activate(home); access = await status(w);
      w.advance(access[site].remainingMs + 1);
      assert.equal((await status(w))[site].remainingMs, 0);
      assert.equal(w.tabs[0].url, gate(site).url);
      assert.deepEqual(rulesFor(w, [site]), []);
      w.advance(86400000);
      assert.equal((await status(w))[site].remainingMs, 120000, 'daily refill uses the saved per-site duration');
      assert.equal((await w.send({ type: 'access-end', site }, popupSender)).ok, true);
      assert.equal(w.data._access[site], undefined);
      assert.equal((await w.send({ type: 'tracking', site, enabled: false }, popupSender)).ok, true);
      access = await status(w);
      assert.equal(access[site].enabled, false);
      assert.equal(access[site].sessionMinutes, 2);
      assert.equal(w.data._access[site], undefined);
      assert.deepEqual(rulesFor(w, [site]), require('../../sites/index.js').get(site).access.unrestrictedRules);
      assert.equal((await w.send({ type: 'tracking', site, enabled: true }, popupSender)).ok, true);
      assert.equal((await status(w))[site].remainingMs, 0, 're-enabling starts blocked');
      assert.deepEqual(rulesFor(w, [site]), []);
    });
  }
  test(`${browser}: worker replacement charges the active deadline and repeated wakes cannot refill it`, async () => {
    const session = {};
    const first = worker({}, browser, start - 60000, { session });
    await unlock(first);
    first.activate('https://x.com/home');
    assert.equal((await status(first)).x.remainingMs, 300000);
    const wake = worker(first.data, browser, first.now + 60000, { session });
    wake.activate('https://x.com/home', 2);
    let access = await status(wake);
    assert.equal(access.x.remainingMs, 240000);
    assert.equal(access.x.expiresAt, start + 300000);
    assert.equal(wake.alarms['access-x'].when, start + 300000);
    wake.advance(10000);
    wake.activate('https://twitter.com/home', 3);
    assert.equal((await status(wake)).x.remainingMs, 230000);
    const next = worker(wake.data, browser, wake.now + 10000, { session });
    next.activate('https://x.com/home', 4);
    access = await status(next);
    assert.equal(access.x.remainingMs, 220000);
    assert.equal(access.x.expiresAt, start + 300000);
  });

  test(`${browser}: wake away from the active site charges elapsed time before pausing`, async () => {
    const session = {};
    const first = worker({}, browser, start - 60000, { session });
    await unlock(first);
    first.activate('https://x.com/home');
    await status(first);
    const wake = worker(first.data, browser, start + 60000, { session });
    wake.activate('https://example.com/');
    assert.equal((await status(wake)).x.remainingMs, 240000);
    assert.equal(wake.data._access.x.expiresAt, 0);
    wake.advance(600000);
    assert.equal((await status(wake)).x.remainingMs, 240000);
    wake.activate('https://x.com/home');
    assert.equal((await status(wake)).x.expiresAt, wake.now + 240000);
  });

  test(`${browser}: paused budgets survive worker replacement and browser downtime`, async () => {
    const session = {};
    const first = worker({}, browser, start - 60000, { session });
    await unlock(first);
    first.activate('https://x.com/home');
    await status(first);
    first.advance(20000);
    first.blur();
    assert.equal((await status(first)).x.remainingMs, 280000);
    for (const nextSession of [session, {}]) {
      const wake = worker(first.data, browser, first.now + 600000, { session: nextSession });
      const access = await status(wake);
      assert.equal(access.x.remainingMs, 280000);
      assert.equal(access.x.expiresAt, 0);
      assert.equal(wake.alarms['access-x'], undefined);
    }
  });

  test(`${browser}: cold load preserves budget before delayed startup and startup cannot refund active time`, async () => {
    const first = worker({}, browser, start - 60000, { session: {} });
    await unlock(first);
    first.activate('https://x.com/home');
    await status(first);
    first.advance(20000);
    assert.equal((await status(first)).x.remainingMs, 280000);
    const restarted = worker(first.data, browser, first.now + 600000, { session: {} });
    restarted.activate('https://x.com/home');
    assert.equal((await status(restarted)).x.remainingMs, 280000);
    restarted.advance(10000);
    restarted.startup();
    const access = await status(restarted);
    assert.equal(access.x.remainingMs, 270000);
    assert.equal(access.x.expiresAt, restarted.now + 270000);
  });

  test(`${browser}: an expired deadline on worker wake closes every site tab without granting access`, async () => {
    const session = {};
    const first = worker({}, browser, start - 60000, { session });
    await unlock(first);
    first.activate('https://x.com/home');
    await status(first);
    const wake = worker(first.data, browser, start + 300000, { session });
    wake.tabs.push({ id: 1, url: 'https://x.com/home' }, { id: 2, url: 'http://mobile.twitter.com/home' }, { id: 3, url: 'https://x.com.evil.test/' });
    wake.activate('https://x.com/home');
    wake.alarm('access-x');
    const access = await status(wake);
    assert.equal(access.x.remainingMs, 0);
    assert.equal(access.x.expiresAt, 0);
    assert.equal(wake.alarms['access-x'], undefined);
    assert.deepEqual(rulesFor(wake), []);
    assert.equal(wake.tabs[0].url, gate('x').url);
    assert.equal(wake.tabs[1].url, gate('x').url);
    assert.equal(wake.tabs[2].url, 'https://x.com.evil.test/');
    assert.equal((await wake.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
  });

  test(`${browser}: midnight wake charges the refilled deadline but browser downtime does not`, async () => {
    const midnight = new Date(2026, 9, 12).getTime();
    for (const restart of [false, true]) {
      const session = {};
      const first = worker({}, browser, midnight - 120000, { session });
      await unlock(first);
      first.activate('https://x.com/home');
      await status(first);
      const wake = worker(first.data, browser, midnight + 60000, { session: restart ? {} : session });
      wake.activate('https://x.com/home');
      const access = await status(wake);
      assert.equal(access.x.remainingMs, restart ? 300000 : 240000);
      assert.equal(access.x.refilledAt, midnight);
      wake.alarm('access-midnight');
      assert.equal((await status(wake)).x.remainingMs, access.x.remainingMs);
      assert.equal(wake.alarms['access-midnight'].when, new Date(2026, 9, 13).getTime());
    }
  });

  test(`${browser}: above-goal budgets stay paused over wake and resume when the goal exception ends`, async () => {
    const session = {};
    const first = worker({}, browser, start - 60000, { session });
    await unlock(first);
    first.activate('https://x.com/home');
    await status(first);
    first.advance(10000);
    const date = C.localDate(new Date(first.now));
    first.data[date] = { x: { posts: 1 } };
    assert.equal((await first.send({ type: 'access-goal-setting', enabled: true }, popupSender)).ok, true);
    const wake = worker(first.data, browser, first.now + 600000, { session });
    wake.activate('https://x.com/home');
    let access = await status(wake);
    assert.equal(access.x.goalAllowed, true);
    assert.equal(access.x.remainingMs, 290000);
    assert.equal(access.x.expiresAt, 0);
    wake.data[date].x.consumeSec = 120;
    access = await status(wake);
    assert.equal(access.x.goalAllowed, false);
    assert.equal(access.x.remainingMs, 290000);
    assert.equal(access.x.expiresAt, wake.now + 290000);
  });

  test(`${browser}: failed cold reconciliation leaves the session marker unset and a successful retry restores the budget`, async () => {
    for (const failure of ['failRules', 'failWrites']) {
      const session = {};
      const w = worker({ _access: { x: { remainingMs: 240000, expiresAt: start - 600000 } } }, browser, start, { session });
      w[failure] = true;
      assert.equal((await w.send({ type: 'access-status' })).ok, false);
      assert.deepEqual(session, {});
      w[failure] = false;
      assert.equal((await status(w, 2)).x.remainingMs, 240000);
      assert.equal(Object.keys(session).length, 1);
      w.activate('https://x.com/home');
      await status(w, 2);
      w.advance(10000);
      w.startup();
      assert.equal((await status(w, 2)).x.remainingMs, 230000);
    }
  });

  test(`${browser}: legacy deadlines migrate safely and wait requests cannot be bypassed on wake`, async () => {
    const session = {};
    const legacy = worker({ _access: { x: { expiresAt: start + 300000 } } }, browser, start + 60000, { session });
    legacy.activate('https://x.com/home');
    assert.equal((await status(legacy)).x.remainingMs, 240000);
    const wake = worker(legacy.data, browser, start + 120000, { session });
    wake.activate('https://x.com/home');
    assert.equal((await status(wake)).x.remainingMs, 180000);
    assert.equal((await wake.send({ type: 'access-end', site: 'x' }, { ...gate('x'), frameId: 1 })).ok, false);
    assert.equal((await wake.send({ type: 'access-duration', minutes: 240 })).ok, false);
    assert.equal((await status(wake)).x.remainingMs, 180000);
    assert.equal((await wake.send({ type: 'access-end', site: 'x' }, popupSender)).ok, true);
    const ended = worker(wake.data, browser, start + 180000, { session });
    assert.equal((await status(ended)).x.remainingMs, 0);
    assert.equal((await ended.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
    assert.equal((await ended.send({ type: 'access-begin', site: 'x', reason: 'Reply to Alex about our launch, then leave.' }, gate('x'))).ok, true);
    const waiting = worker(ended.data, browser, ended.now + 30000, { session });
    assert.equal((await waiting.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
    assert.equal((await status(waiting)).x.remainingMs, 0);
  });
}
