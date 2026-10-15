'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../core/core.js');
const integrations = require('../../sites/index.js');
const { Element } = require('../../sites/test-support.js');
const { tracker } = require('../tests/content-harness.js');
test('an unusable ingest acknowledgement retains the exact queued packet for retry', async () => {
  for (const browser of ['chrome', 'browser']) {
    for (const invalid of [{ ok: true }, { ok: 'true' }, { ok: true, settings: null }, { ok: true, settings: { trackedSites: 'x' } }]) {
      const attempts = [];
      let malformed = true;
      const t = await tracker(browser, { attempts, reply(message, reply) { return message.type === 'ingest' && malformed ? invalid : reply; } });
      t.input(); t.setNow(5000); await t.tick();
      malformed = false; await t.tick();
      assert.deepEqual(attempts[1], attempts[0]);
      assert.equal(t.warnings.length, 1);
      const count = attempts.length; await t.tick();
      assert.equal(attempts.length, count);
    }
  }
});
test('an impossible calendar date in a valid ingest reply preserves the packet until a valid retry', async () => {
  for (const browser of ['chrome', 'browser']) {
    const attempts = [];
    let invalidDate = true;
    const t = await tracker(browser, { attempts, reply(message, reply) {
      return message.type === 'ingest' && invalidDate ? { ...reply, date: '2026-02-30' } : reply;
    } });
    t.input(); t.setNow(5000); await t.tick();
    assert.equal(attempts.length, 1);
    assert.equal(t.warnings.length, 1);
    invalidDate = false; await t.tick();
    assert.deepEqual(attempts[1], attempts[0]);
    const count = attempts.length; await t.tick();
    assert.equal(attempts.length, count);
  }
});
function overdueSnapshot() {
  return { day: { x: { consumeSec: 60 } }, settings: { nudgeEnabled: true, nudgeMinutes: 1 } };
}
function scrollAttempt(t, type = 'wheel', extra = {}) {
  let prevented = false;
  t.event(type, { isTrusted: true, target: {}, key: 'PageDown', preventDefault() { prevented = true; }, ...extra });
  return prevented;
}
test('creation tracking never intercepts scrolling or shows retired reminders', async () => {
  const t = await tracker('chrome', { snapshot: overdueSnapshot() }); await t.tick();
  assert.equal(t.elements.some(node => node.id === 'c3-nudge' && !node.removed), false);
  for (const type of ['wheel', 'touchmove', 'keydown']) assert.equal(scrollAttempt(t, type), false);
  assert.equal(t.elements.some(node => node.id === 'c3-scroll-lock'), false);
  t.route('https://x.com/home', true);
  assert.equal(scrollAttempt(t), false, 'drafting remains usable during an access session');
});

test('saved nudge overrides remain inert while both sites continue creation tracking', async () => {
  const snapshot = overdueSnapshot(); snapshot.settings.siteOverrides = { x: { nudgeEnabled: true, nudgeMinutes: 1 } };
  for (const url of ['https://x.com/home', 'https://www.linkedin.com/feed/']) {
    const t = await tracker('chrome', { url, snapshot }); t.input(); t.setNow(5000); await t.tick();
    assert.equal(t.elements.some(node => node.id === 'c3-nudge' && !node.removed), false); assert.equal(seconds(t, 'consume'), 5);
    t.setSnapshot(overdueSnapshot()); t.setNow(10000); await t.tick();
    assert.equal(t.elements.some(node => node.id === 'c3-nudge' && !node.removed), false); assert.equal(seconds(t, 'consume'), 10);
  }
});

function seconds(t, mode) { return t.packets.flatMap(p => p.segments).filter(s => s.mode === mode).reduce((sum, s) => sum + s.sec, 0); }

test('creating/consuming time and actions require an active access session', async () => {
  const locked = { day: {}, settings: C.DEFAULT_SETTINGS, access: { x: { enabled: true, remainingMs: 0 } } };
  const t = await tracker('chrome', { snapshot: locked }); t.input(); t.setNow(5000); await t.tick(); assert.equal(t.packets.length, 0);
  t.setSnapshot({ ...locked, access: { x: { enabled: true, remainingMs: 60000 } } }); await t.tick();
  t.input(); t.setNow(10000); await t.tick(); assert.equal(seconds(t, 'consume'), 5);
  t.setSnapshot(locked); await t.tick(); const count = t.packets.length;
  t.input(); t.event('click', { isTrusted: true, target: t.button }); t.setNow(15000); await t.tick(); assert.equal(t.packets.length, count);
});
test('goal-unlocked access measures fresh input without a timer, but blocked and Off sites do not', async () => {
  for (const browser of ['chrome', 'browser']) {
    const snapshot = { day: {}, settings: C.DEFAULT_SETTINGS, access: { x: { enabled: true, goalAllowed: true, remainingMs: 0 } } };
    const t = await tracker(browser, { snapshot }); t.input(); t.setNow(5000); await t.tick();
    assert.equal(seconds(t, 'consume'), 5);
    t.event('click', { isTrusted: true, target: t.button }); await t.tick();
    assert.equal(t.packets.flatMap(p => p.actions).length, 1);
    t.setSnapshot({ ...snapshot, access: { x: { enabled: true, goalAllowed: false, remainingMs: 0 } } }); await t.tick();
    const count = t.packets.length;
    t.input(); t.event('click', { isTrusted: true, target: t.button }); t.setNow(10000); await t.tick();
    assert.equal(t.packets.length, count);
    t.setSnapshot({ ...snapshot, settings: { ...C.DEFAULT_SETTINGS, trackedSites: [] }, access: { x: { enabled: false, goalAllowed: true, remainingMs: 0 } } }); await t.tick();
    t.input(); t.setNow(15000); await t.tick(); assert.equal(t.packets.length, count);
  }
});
test('tracker uses the Firefox browser namespace without a Chrome global', async () => {
  const t = await tracker('browser'); t.input(); t.setNow(5000); await t.tick();
  assert.equal(seconds(t, 'consume'), 5);
});
test('tracker ignores synthetic input, clips idle time and resumes without backfilling', async () => {
  const t = await tracker(); t.input(false); t.setNow(5000); await t.tick(); assert.equal(seconds(t, 'consume'), 0);
  t.input();
  for (let n = 10000; n <= 40000; n += 5000) { t.setNow(n); await t.tick(); }
  assert.equal(seconds(t, 'consume'), 30);
  t.setNow(50000); t.input(); t.setNow(55000); await t.tick(); assert.equal(seconds(t, 'consume'), 35);
});
test('focus and visibility boundaries save partial ticks without inactive time', async () => {
  const t = await tracker(); t.input(); t.setNow(2000); t.focus(false);
  t.setNow(5000); await t.tick(); assert.equal(seconds(t, 'consume'), 2);
  t.setNow(10000); t.focus(true); t.setNow(12000); t.visible(false);
  t.setNow(15000); await t.tick(); assert.equal(seconds(t, 'consume'), 4);
  t.setNow(20000); t.visible(true); t.input(); t.setNow(25000); await t.tick(); assert.equal(seconds(t, 'consume'), 9);
});
for (const browser of ['chrome', 'browser']) {
  for (const mode of ['consume', 'create']) {
    for (const awayMs of [10000, 60000]) {
      test(`${browser} cached ${mode} page excludes ${awayMs}ms on an untracked website`, async () => {
        const t = await tracker(browser);
        if (mode === 'create') t.route('https://x.com/compose/post', true);
        t.input(); t.setNow(2000); t.event('pagehide', { persisted: true });
        t.setNow(2000 + awayMs); t.event('pageshow', { persisted: true });
        await t.tick();
        assert.equal(seconds(t, mode), 2);
        t.setNow(7000 + awayMs); await t.tick();
        assert.equal(seconds(t, mode), 2, 'returning requires fresh input');
        t.input(); t.setNow(12000 + awayMs); await t.tick();
        assert.equal(seconds(t, mode), 7);
      });
    }
  }
}
test('departed pages ignore pending refreshes, input, actions and timer ticks', async () => {
  const t = await tracker();
  t.input(); t.setNow(2000); t.event('pagehide', { persisted: false });
  await t.tick();
  t.setNow(5000); t.input();
  t.event('click', { isTrusted: true, target: t.button });
  t.setNow(10000); await t.tick();
  assert.equal(seconds(t, 'consume'), 2);
  assert.equal(t.packets.flatMap(packet => packet.actions).length, 0);
});
test('SPA route/editor changes split creating and consuming within a tick', async () => {
  const t = await tracker(); t.input(); t.setNow(2000); t.route('https://x.com/compose/post', true);
  t.setNow(5000); await t.tick(); assert.equal(seconds(t, 'consume'), 2); assert.equal(seconds(t, 'create'), 3);
  t.setNow(7000); t.route('https://x.com/messages', false);
  t.setNow(10000); await t.tick(); assert.equal(seconds(t, 'create'), 5); assert.equal(seconds(t, 'consume'), 2);
});

async function linkedinTracker() { return tracker('chrome', { url: 'https://www.linkedin.com/feed/' }); }
function comments(t) { return t.packets.flatMap(p => p.actions).filter(a => a.action === 'comments').length; }

async function xTracker(action = 'posts', browser = 'chrome', options = {}) { return tracker(browser, { ...options, action }); }

for (const [modifier, browser] of [['ctrlKey', 'chrome'], ['metaKey', 'browser']]) {
  for (const action of ['posts', 'replies', 'quotes']) {
    test(`X ${modifier}+Enter records ${action} once, including a generated click (${browser})`, async () => {
      const t = await xTracker(action, browser);
      t.event('keydown', { isTrusted: true, key: 'Enter', [modifier]: true, target: t.editor });
      await t.tick();
      assert.deepEqual(t.packets.flatMap(p => p.actions).map(a => a.action), [action]);
      t.event('click', { isTrusted: true, target: t.button });
      await t.tick();
      assert.equal(t.packets.flatMap(p => p.actions).length, 1);
      t.setNow(1500);
      t.event('keydown', { isTrusted: true, key: 'Enter', [modifier]: true, target: t.editor });
      await t.tick();
      assert.equal(t.packets.flatMap(p => p.actions).length, 2);
    });
  }
}

test('X keyboard submission carries reply/quote intent and clears it after counting', async () => {
  for (const [selector, action] of [['[data-testid="reply"]', 'replies'], ['[role="menuitem"][aria-label="Quote"]', 'quotes']]) {
    const t = await xTracker();
    t.event('click', { isTrusted: true, target: new Element([selector]) });
    t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor });
    await t.tick();
    assert.deepEqual(t.packets.flatMap(p => p.actions).map(a => a.action), [action]);
    t.setNow(1500);
    t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor });
    await t.tick();
    assert.deepEqual(t.packets.flatMap(p => p.actions).map(a => a.action), [action, 'posts']);
  }
});

test('X ignores plain/newline Enter, composition, repeated and unrelated shortcuts', async () => {
  const t = await xTracker();
  for (const extra of [{ ctrlKey: false }, { shiftKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }, { isTrusted: false }, { target: {} }, { key: 'a' }]) {
    t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor, ...extra });
  }
  await t.tick();
  assert.equal(t.packets.flatMap(p => p.actions).length, 0);
  t.focus(false);
  t.event('keydown', { isTrusted: true, key: 'Enter', metaKey: true, target: t.editor });
  await t.tick();
  assert.equal(t.packets.flatMap(p => p.actions).length, 0);
  t.focus(true); t.visible(false);
  t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor });
  await t.tick();
  assert.equal(t.packets.flatMap(p => p.actions).length, 0);
});

test('LinkedIn Enter submission records a comment and deduplicates a generated click', async () => {
  const t = await linkedinTracker();
  t.event('keydown', { isTrusted: true, key: 'Enter', target: t.editor });
  await t.tick();
  assert.equal(comments(t), 1);
  t.event('click', { isTrusted: true, target: t.button });
  await t.tick();
  assert.equal(comments(t), 1);
  t.setNow(1500);
  t.event('keydown', { isTrusted: true, key: 'Enter', target: t.editor });
  await t.tick();
  assert.equal(comments(t), 2);
});

test('LinkedIn ignores newline, composing, repeated, synthetic and unrelated Enter events', async () => {
  const t = await linkedinTracker();
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }, { isTrusted: false }, { target: {} }, { key: 'a' }]) {
    t.event('keydown', { isTrusted: true, key: 'Enter', target: t.editor, ...extra });
  }
  await t.tick();
  assert.equal(comments(t), 0);
  t.focus(false);
  t.event('keydown', { isTrusted: true, key: 'Enter', target: t.editor });
  await t.tick();
  assert.equal(comments(t), 0);
  t.focus(true); t.visible(false);
  t.event('keydown', { isTrusted: true, key: 'Enter', target: t.editor });
  await t.tick();
  assert.equal(comments(t), 0);
});

test('tracker waits for preferences before recording trusted activity', async () => {
  const t = await tracker('chrome', { beforeReady(event) {
    event('pointerdown', { isTrusted: true });
    event('click', { isTrusted: true, target: {} });
    event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: {} });
  } });
  t.setNow(5000); await t.tick();
  assert.deepEqual(t.packets, []);
  t.input(); t.setNow(10000); await t.tick();
  assert.equal(seconds(t, 'consume'), 5);
});

test('disabled creation tracking collects neither time nor actions, even with legacy nudge settings', async () => {
  const t = await xTracker('posts', 'chrome', { snapshot: {
    ...overdueSnapshot(), settings: { ...overdueSnapshot().settings, trackedSites: [] }
  } });
  t.input(); t.setNow(5000);
  t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor });
  t.event('click', { isTrusted: true, target: t.button });
  await t.tick();
  assert.deepEqual(t.packets, []);
  assert.equal(t.elements.some(node => node.id === 'c3-nudge' && !node.removed), false);
});
test('disabling an open tracker suppresses further time and actions; re-enabling requires fresh input', async () => {
  const t = await xTracker();
  t.input(); t.setNow(5000); await t.tick();
  assert.equal(seconds(t, 'consume'), 5);
  t.setSnapshot({ day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: ['linkedin'] } });
  await t.tick();
  const before = t.packets.length;
  t.setNow(10000); t.input();
  t.event('click', { isTrusted: true, target: t.button });
  t.route('https://x.com/compose/post', true); await t.tick();
  assert.equal(t.packets.length, before);
  t.setSnapshot({ day: {}, settings: C.DEFAULT_SETTINGS });
  await t.tick();
  t.setNow(15000); await t.tick();
  assert.equal(t.packets.length, before, 'disabled input must not resume tracking');
  t.input(); t.setNow(20000); await t.tick();
  assert.equal(seconds(t, 'create'), 5);
  t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor });
  await t.tick();
  assert.equal(t.packets.flatMap(packet => packet.actions).length, 1);
});

test('shared tracker accepts a third site adapter without site-specific event branches', async () => {
  const button = new Element();
  const integration = { id: 'example', name: 'Example', hosts: ['example.test'], actions: ['posts'], create() {
    return { mode: () => 'create', action: event => event.type === 'click' ? { button, action: 'posts', submission: true } : null };
  } };
  const off = await tracker('chrome', { url: 'https://example.test/work', integration });
  off.input(); off.setNow(5000); off.event('click', { isTrusted: true }); await off.tick();
  assert.deepEqual(off.packets, [], 'availability is not activation');
  const t = await tracker('chrome', { url: 'https://example.test/work', integration, snapshot: { day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: ['example'] } } });
  t.input(); t.setNow(5000); await t.tick();
  t.event('click', { isTrusted: true }); await t.tick();
  assert.equal(seconds(t, 'create'), 5);
  assert.ok(t.packets.every(packet => packet.site === 'example'));
  assert.equal(t.packets.flatMap(packet => packet.actions)[0].action, 'posts');
});
test('unchanged snapshots preserve the adapter, composer intent and active input', async () => {
  let creations = 0;
  const plugin = integrations.get('x');
  const integration = { ...plugin, create(state) { creations++; return plugin.create(state); } };
  const t = await tracker('chrome', { integration, snapshot: { day: {}, settings: C.DEFAULT_SETTINGS, generation: 'current' } });
  t.route('https://x.com/compose/post', true); t.input();
  t.event('click', { isTrusted: true, target: new Element(['[role="menuitem"][aria-label="Quote"]']) });
  await t.tick();
  t.setNow(5000); await t.tick();
  assert.equal(seconds(t, 'create'), 5);
  t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor });
  await t.tick();
  assert.deepEqual(t.packets.flatMap(packet => packet.actions).map(action => action.action), ['quotes']);
  assert.equal(creations, 1);
});

test('a new delivery generation resets adapter intent and requires fresh input', async () => {
  let creations = 0;
  const plugin = integrations.get('x');
  const integration = { ...plugin, create(state) { creations++; return plugin.create(state); } };
  const snapshot = { day: {}, settings: C.DEFAULT_SETTINGS, generation: 'before' };
  const t = await tracker('chrome', { integration, snapshot });
  t.route('https://x.com/compose/post', true); t.input();
  t.event('click', { isTrusted: true, target: new Element(['[role="menuitem"][aria-label="Quote"]']) });
  t.setSnapshot({ ...snapshot, generation: 'after' }); await t.tick();
  t.setNow(5000); await t.tick();
  assert.deepEqual(t.packets, []);
  assert.equal(creations, 2);
  t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor });
  await t.tick();
  assert.deepEqual(t.packets.flatMap(packet => packet.actions).map(action => action.action), ['posts']);
  assert.ok(t.packets.every(packet => packet.generation === 'after'));
  t.setNow(10000); await t.tick();
  assert.equal(seconds(t, 'create'), 5);
  assert.equal(creations, 2);
});

test('disabled integrations are not initialized or asked to interpret activity', async () => {
  let calls = 0;
  const integration = { ...integrations.get('x'), create() { calls++; throw new Error('Must not run'); } };
  const t = await tracker('chrome', { integration, snapshot: { day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: [] } } });
  t.input(); t.setNow(5000); t.event('click', { isTrusted: true }); await t.tick();
  assert.equal(calls, 0); assert.deepEqual(t.warnings, []); assert.deepEqual(t.packets, []);
});
test('broken adapter creation pauses only that site until reload without changing user preferences', async () => {
  const snapshot = { day: {}, settings: C.DEFAULT_SETTINGS };
  const broken = await tracker('chrome', { snapshot, integration: { ...integrations.get('x'), create() { throw new Error('Broken selector setup'); } } });
  broken.input(); broken.setNow(5000); await broken.tick();
  broken.setSnapshot(snapshot); await broken.tick();
  assert.deepEqual(broken.packets, []); assert.equal(broken.warnings.length, 1);
  const healthy = await linkedinTracker(); healthy.input(); healthy.setNow(5000); await healthy.tick();
  assert.equal(seconds(healthy, 'consume'), 5); assert.deepEqual(healthy.warnings, []);
  assert.deepEqual(snapshot.settings.trackedSites, ['x', 'linkedin']);
});
test('throwing or invalid mode/action recognition pauses the adapter and drops unsaved activity', async () => {
  for (const failure of ['throw-mode', 'invalid-mode', 'throw-action', 'invalid-action', 'invalid-button']) {
    let broken = false;
    const integration = { ...integrations.get('x'), create() { return {
      mode() { if (!broken) return 'consume'; if (failure === 'throw-mode') throw new Error('Route failed'); return failure === 'invalid-mode' ? 'unknown' : 'consume'; },
      action(event) { if (event.type !== 'click') return null; if (failure === 'throw-action') throw new Error('Event failed'); return { action: failure === 'invalid-action' ? 'unsupported' : 'posts', button: failure === 'invalid-button' ? {} : new Element(), submission: true }; }
    }; } };
    const t = await tracker('chrome', { integration });
    t.input(); t.setNow(2000); broken = true;
    if (failure.endsWith('mode')) t.route('https://x.com/home', false);
    else t.event('click', { isTrusted: true });
    t.setNow(5000); await t.tick(); t.input(); t.setNow(10000); await t.tick();
    assert.deepEqual(t.packets, [], failure); assert.equal(t.warnings.length, 1, failure);
  }
});

test('sustained ingest failures pause at 64 packets without losing queued actions and resume with fresh input', async () => {
  const options = { failIngest: true, attempts: [] }, t = await tracker('chrome', options);
  for (let n = 1; n <= 200; n++) {
    t.input(); t.setNow(n * 5000);
    t.event('click', { isTrusted: true, target: t.button });
    await t.tick();
  }
  assert.equal(t.packets.length, 0);
  assert.ok(options.attempts.every(packet => packet.id === options.attempts[0].id));
  options.failIngest = false;
  await t.tick();
  assert.equal(t.packets.length, 64);
  assert.equal(t.packets.flatMap(packet => packet.actions).length, 64);
  assert.equal(seconds(t, 'consume'), 320);
  assert.equal(new Set(t.packets.map(packet => packet.id)).size, 64);
  t.setNow(1005000); await t.tick();
  assert.equal(t.packets.length, 64, 'input during the pause cannot backfill after recovery');
  t.input(); t.setNow(1010000); await t.tick();
  assert.equal(seconds(t, 'consume'), 325);
});

test('rapid route changes keep queued and pending time packets within receiver limits', async () => {
  const options = { failIngest: true }, t = await tracker('chrome', options);
  t.input();
  for (let n = 1; n <= 5000; n++) {
    t.setNow(n * 10);
    t.input();
    t.route(n % 2 ? 'https://x.com/compose/post' : 'https://x.com/home', Boolean(n % 2));
  }
  options.failIngest = false;
  await t.tick();
  assert.ok(t.packets.length <= 64);
  assert.ok(t.packets.every(packet => packet.segments.length <= 64 && packet.actions.length <= 64 && packet.segments.reduce((sum, segment) => sum + segment.sec, 0) <= 3600));
});
