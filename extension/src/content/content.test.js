'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../core/core.js');
const integrations = require('../../sites/index.js');
const { Element, linkedinFixture } = require('../../sites/test-support.js');
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
test('default scroll friction halves wheel distance on both consuming sites', async () => {
  for (const browser of ['chrome', 'browser']) {
    for (const url of ['https://x.com/home', 'https://www.linkedin.com/feed/']) {
      const t = await tracker(browser, { url, snapshot: { day: {}, settings: {} } });
      assert.equal(t.wheel(200).defaultPrevented, true);
      assert.equal(t.document.scrollingElement.scrollTop, 1100);
      assert.equal(t.wheel(-100).defaultPrevented, true);
      assert.equal(t.document.scrollingElement.scrollTop, 1050);
    }
  }
});
test('positive resistance changes live without accumulating listeners and saved zero stays Off', async () => {
  for (const browser of ['chrome', 'browser']) {
    for (const url of ['https://x.com/home', 'https://www.linkedin.com/feed/']) {
      const t = await tracker(browser, { url, snapshot: { day: {}, settings: { scrollFrictionEnabled: true } } });
      for (const [strength, distance] of [[95, 10], [75, 50], [90, 20], [50, 100]]) {
        t.setSnapshot({ day: {}, settings: { scrollFrictionEnabled: true, scrollFrictionStrength: strength } }); await t.tick();
        t.document.scrollingElement.scrollTop = 1000;
        assert.equal(t.wheel(200).defaultPrevented, true);
        assert.equal(t.document.scrollingElement.scrollTop, 1000 + distance);
        assert.equal(t.listenerCount('wheel'), 2);
      }
      t.setSnapshot({ day: {}, settings: { scrollFrictionEnabled: true, scrollFrictionStrength: 0 } }); await t.tick();
      assert.equal(t.wheel(200).defaultPrevented, false);
      assert.equal(t.listenerCount('wheel'), 1);
    }
  }
});
test('scroll friction handles pixel, line, page and fractional wheel deltas without queuing motion', async () => {
  const t = await tracker('chrome', { snapshot: { day: {}, settings: { scrollFrictionEnabled: true } } });
  const root = t.document.scrollingElement;
  t.wheel(3, { deltaMode: 1 }); assert.equal(root.scrollTop, 1024);
  t.wheel(1, { deltaMode: 2 }); assert.equal(root.scrollTop, 1524);
  for (let i = 0; i < 10; i++) t.wheel(0.5);
  assert.equal(root.scrollTop, 1526);
  t.wheel(-2); assert.equal(root.scrollTop, 1525);
  root.scrollTop = 2000; t.wheel(1); assert.equal(root.scrollTop, 2000);
  t.wheel(1); assert.equal(root.scrollTop, 2001);
  const before = root.scrollTop;
  await t.tick(); assert.equal(root.scrollTop, before, 'no delayed movement');
});
test('scroll friction preserves controls, nested panels, zoom and horizontal gestures', async () => {
  const t = await tracker('chrome', { snapshot: { day: {}, settings: { scrollFrictionEnabled: true } } });
  const root = t.document.scrollingElement;
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { deltaX: 400 }, { isTrusted: false }, { cancelable: false }, { deltaMode: 3 }]) {
    assert.equal(t.wheel(200, extra).defaultPrevented, false);
  }
  t.wheel(200, { defaultPrevented: true });
  for (const selector of ['input', 'textarea', 'select', 'video', '[role="textbox"]', '[role="dialog"]']) {
    assert.equal(t.wheel(200, { target: new Element([selector]) }).defaultPrevented, false);
  }
  const editor = new Element(); editor.isContentEditable = true;
  assert.equal(t.wheel(200, { target: editor }).defaultPrevented, false);
  t.document.activeElement = editor;
  assert.equal(t.wheel(200).defaultPrevented, false);
  t.document.activeElement = t.document.body;
  const panel = new Element(); Object.assign(panel, { scrollHeight: 500, clientHeight: 100 }); panel.style.overflowY = 'auto';
  const child = panel.append(new Element());
  assert.equal(t.wheel(200, { target: child }).defaultPrevented, false);
  panel.scrollTop = 400;
  assert.equal(t.wheel(200, { target: child }).defaultPrevented, false, 'nested panel boundaries keep native scroll chaining');
  const carousel = new Element(); Object.assign(carousel, { scrollWidth: 500, clientWidth: 100 }); carousel.style.overflowX = 'auto';
  assert.equal(t.wheel(200, { deltaX: 100, target: carousel }).defaultPrevented, false);
  for (const node of [root, t.document.body]) {
    node.style.overflowY = 'hidden';
    assert.equal(t.wheel(200).defaultPrevented, false);
    node.style.overflowY = 'visible';
  }
  assert.equal(root.scrollTop, 1000);
  t.wheel(200, { deltaX: 10 }); assert.equal(root.scrollTop, 1100); assert.equal(root.scrollLeft, 10);
});
test('scroll friction leaves page edges, keyboard and touch navigation native', async () => {
  const t = await tracker('chrome', { snapshot: { day: {}, settings: { scrollFrictionEnabled: true } } });
  const root = t.document.scrollingElement;
  root.scrollTop = 0; assert.equal(t.wheel(-200).defaultPrevented, false);
  root.scrollTop = root.scrollHeight - root.clientHeight; assert.equal(t.wheel(200).defaultPrevented, false);
  for (const type of ['touchmove', 'keydown']) assert.equal(scrollAttempt(t, type), false);
});
test('scroll friction respects Off, follows access and releases its listener across document lifetimes', async () => {
  const snapshot = { day: {}, settings: { scrollFrictionEnabled: true } };
  const messages = [];
  const t = await tracker('chrome', { snapshot, reply(message, result) { messages.push(message.type); return result; } });
  const nativeListeners = t.listenerCount('wheel') - 1;
  const before = messages.length;
  for (let i = 0; i < 100; i++) t.wheel(10);
  assert.equal(messages.length, before, 'wheel handling does not request background work');
  for (let i = 0; i < 30; i++) {
    t.route('https://x.com/compose/post', true); assert.equal(t.listenerCount('wheel'), nativeListeners);
    t.route('https://x.com/home', false); assert.equal(t.listenerCount('wheel'), nativeListeners + 1);
    t.visible(false); assert.equal(t.listenerCount('wheel'), nativeListeners);
    t.visible(true); assert.equal(t.listenerCount('wheel'), nativeListeners + 1);
    t.focus(false); assert.equal(t.listenerCount('wheel'), nativeListeners);
    t.focus(true); assert.equal(t.listenerCount('wheel'), nativeListeners + 1);
    t.event('pagehide', { persisted: true }); assert.equal(t.listenerCount('wheel'), nativeListeners);
    t.event('pageshow', { persisted: true }); assert.equal(t.listenerCount('wheel'), nativeListeners + 1);
  }
  await t.tick();
  for (const disabled of [
    { ...snapshot, settings: { scrollFrictionEnabled: false } },
    { ...snapshot, settings: { scrollFrictionEnabled: true, scrollFrictionStrength: 0 } },
    { ...snapshot, settings: { scrollFrictionEnabled: true, trackedSites: [] } },
    { ...snapshot, access: { x: { remainingMs: 0 } } }
  ]) {
    t.setSnapshot(disabled); await t.tick();
    assert.equal(t.listenerCount('wheel'), nativeListeners);
    assert.equal(t.wheel(200).defaultPrevented, false);
    t.setSnapshot(snapshot); await t.tick();
    assert.equal(t.listenerCount('wheel'), nativeListeners + 1);
  }
  t.setSnapshot({ ...snapshot, access: { x: { remainingMs: 0, goalAllowed: true } } }); await t.tick();
  assert.equal(t.wheel(200).defaultPrevented, true);
});
test('scroll friction leaves messaging and creating modes native on both sites', async () => {
  for (const [url, messageURL] of [['https://x.com/home', 'https://x.com/messages'], ['https://www.linkedin.com/feed/', 'https://www.linkedin.com/messaging/']]) {
    const t = await tracker('chrome', { url, snapshot: { day: {}, settings: { scrollFrictionEnabled: true } } });
    t.route(url, true); assert.equal(t.wheel(200).defaultPrevented, false);
    t.route(messageURL, false); assert.equal(t.wheel(200).defaultPrevented, false);
    t.route(url, false); assert.equal(t.wheel(200).defaultPrevented, true);
  }
});
test('invalidated extension contexts and failed adapters restore native scrolling', async () => {
  let invalidated = false;
  const t = await tracker('chrome', { snapshot: { day: {}, settings: { scrollFrictionEnabled: true } }, reply(_, result) {
    if (invalidated) throw new Error('Extension context invalidated');
    return result;
  } });
  invalidated = true; await t.tick();
  assert.equal(t.wheel(200).defaultPrevented, false);
  assert.equal(t.listenerCount('wheel'), 1);
  let broken = false;
  const integration = { ...integrations.get('x'), create() { return { mode() { if (broken) throw new Error('Unsupported DOM'); return 'consume'; }, action() { return null; } }; } };
  const failed = await tracker('chrome', { integration, snapshot: { day: {}, settings: { scrollFrictionEnabled: true } } });
  assert.equal(failed.wheel(200).defaultPrevented, true);
  broken = true; failed.route('https://x.com/explore', false);
  assert.equal(failed.wheel(200).defaultPrevented, false);
  assert.equal(failed.listenerCount('wheel'), 1);
});
test('retired reminders do not pause scroll friction or affect writing', async () => {
  const t = await tracker('chrome', { snapshot: overdueSnapshot() }); await t.tick();
  assert.equal(t.elements.some(node => node.id === 'c3-nudge' && !node.removed), false);
  assert.equal(t.wheel(200).defaultPrevented, true);
  assert.equal(t.document.scrollingElement.scrollTop, 1100);
  for (const type of ['touchmove', 'keydown']) assert.equal(scrollAttempt(t, type), false);
  assert.equal(t.elements.some(node => node.id === 'c3-scroll-lock'), false);
  t.route('https://x.com/home', true);
  assert.equal(t.wheel(200).defaultPrevented, false, 'drafting remains usable during an access session');
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
test('inactive trackers stop polling and synchronize settings when returning', async () => {
  for (const browser of ['chrome', 'browser']) {
    for (const inactive of ['hidden', 'unfocused', 'departed']) {
      const messages = [];
      const t = await tracker(browser, { reply(message, response) { messages.push(message.type); return response; } });
      t.input(); t.setNow(2000);
      if (inactive === 'hidden') t.visible(false);
      else if (inactive === 'unfocused') t.focus(false);
      else t.event('pagehide', { persisted: true });
      await t.tick();
      assert.equal(seconds(t, 'consume'), 2);
      const before = messages.length;
      t.setNow(10000); await t.tick();
      assert.equal(messages.length, before, `${browser} ${inactive} tracker must not wake the worker`);
      t.setSnapshot({ day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: [] } });
      if (inactive === 'hidden') t.visible(true);
      else if (inactive === 'unfocused') t.focus(true);
      else t.event('pageshow', { persisted: true });
      await t.tick();
      assert.ok(messages.length > before, 'returning synchronizes preferences');
      t.input(); t.setNow(15000); await t.tick();
      assert.equal(seconds(t, 'consume'), 2, 'disabled tracking cannot resume with stale settings');
      t.setSnapshot({ day: {}, settings: C.DEFAULT_SETTINGS });
      await t.tick(); t.input(); t.setNow(20000); await t.tick();
      assert.equal(seconds(t, 'consume'), 7, 're-enabling records only fresh activity');
    }
  }
});

test('inactive trackers retry undelivered activity without recording inactive time', async () => {
  for (const browser of ['chrome', 'browser']) {
    const options = { failIngest: true, attempts: [] };
    const t = await tracker(browser, options);
    t.input(); t.setNow(2000); t.visible(false); await t.tick();
    assert.equal(t.packets.length, 0);
    options.failIngest = false;
    t.setNow(10000); await t.tick();
    assert.equal(seconds(t, 'consume'), 2);
    assert.ok(options.attempts.length > 1);
    assert.ok(options.attempts.every(packet => packet.id === options.attempts[0].id));
    t.setNow(15000); await t.tick();
    assert.equal(seconds(t, 'consume'), 2);
  }
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

test('LinkedIn DM writing records creation time without post or comment credit and stops when unfocused', async () => {
  for (const browser of ['chrome', 'browser']) {
    for (const path of ['/messaging/thread/synthetic-thread/', '/feed/']) {
      const url = 'https://www.linkedin.com' + path;
      const t = await tracker(browser, { url, message: true });
      t.route(url, true); t.input(); t.setNow(5000); await t.tick();
      assert.equal(seconds(t, 'create'), 5, `${browser} ${path}`);
      assert.equal(seconds(t, 'consume'), 0);
      t.event('keydown', { isTrusted: true, key: 'Enter', target: t.editor });
      t.event('click', { isTrusted: true, target: t.button }); await t.tick();
      assert.deepEqual(t.packets.flatMap(p => p.actions), []);
      t.route(url, false); t.setNow(10000); await t.tick();
      assert.equal(seconds(t, 'create'), 5, 'reading must not earn creation time');
      assert.equal(seconds(t, 'consume'), path === '/feed/' ? 5 : 0);
      t.route(url, true); t.input(); t.setNow(15000); await t.tick();
      assert.equal(seconds(t, 'create'), 10, 'returning to the editor resumes creation');
    }
  }
});
test('LinkedIn DM writing retains idle, trusted-input, focus, visibility and access protections', async () => {
  const url = 'https://www.linkedin.com/messaging/thread/synthetic-thread/';
  const t = await tracker('chrome', { url, message: true });
  t.route(url, true); t.input(false); t.setNow(5000); await t.tick();
  assert.equal(seconds(t, 'create'), 0);
  t.input();
  for (let n = 10000; n <= 40000; n += 5000) { t.setNow(n); await t.tick(); }
  assert.equal(seconds(t, 'create'), 30);
  t.input(); t.focus(false); t.setNow(45000); await t.tick();
  assert.equal(seconds(t, 'create'), 30);
  t.focus(true); t.visible(false); t.setNow(50000); await t.tick();
  assert.equal(seconds(t, 'create'), 30);
  for (const snapshot of [
    { day: {}, settings: C.DEFAULT_SETTINGS, access: { linkedin: { enabled: true, remainingMs: 0 } } },
    { day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: [] } }
  ]) {
    const blocked = await tracker('chrome', { url, message: true, snapshot });
    blocked.route(url, true); blocked.input(); blocked.setNow(5000); await blocked.tick();
    assert.deepEqual(blocked.packets, [], 'blocked and disabled sites cannot record DMs');
  }
});

test('LinkedIn shadow DM writing switches to reading, closes and resumes without submission credit', async () => {
  for (const browser of ['chrome', 'browser']) {
    for (const path of ['/feed/', '/in/another/']) {
      let f;
      const t = await tracker(browser, { url: 'https://www.linkedin.com' + path, fixture: options => (f = linkedinFixture({ ...options, message: true, shadow: true })) });
      const focus = node => {
        f.document.activeElement = f.host; f.shadowRoot.activeElement = node;
        t.event('focusin', { target: f.host });
      };
      focus(f.editor); t.input(); t.setNow(5000); await t.tick();
      assert.equal(seconds(t, 'create'), 5, `${browser} ${path}`);
      focus(f.button); t.setNow(10000); await t.tick();
      assert.equal(seconds(t, 'create'), 5, 'reading is not creation');
      assert.equal(seconds(t, 'consume'), 5);
      t.event('keydown', { isTrusted: true, key: 'Enter', target: f.host });
      t.event('click', { isTrusted: true, target: f.host });
      assert.deepEqual(t.packets.flatMap(p => p.actions), []);
      focus(null); t.setNow(15000); await t.tick();
      assert.equal(seconds(t, 'create'), 5, 'closing does not continue creation');
      focus(f.editor); t.input(); t.setNow(20000); await t.tick();
      assert.equal(seconds(t, 'create'), 10, 'returning resumes creation');
      assert.equal(t.wheel(100).defaultPrevented, false, 'writing keeps native scrolling');
    }
  }
});
test('LinkedIn shadow DM writing preserves trusted-input, idle, focus, visibility, access and disabled protections', async () => {
  let f;
  const options = { url: 'https://www.linkedin.com/feed/', fixture: options => (f = linkedinFixture({ ...options, message: true, shadow: true })) };
  const t = await tracker('chrome', options);
  f.document.activeElement = f.host; f.shadowRoot.activeElement = f.editor; t.event('focusin', {});
  t.input(false); t.setNow(5000); await t.tick(); assert.equal(seconds(t, 'create'), 0);
  t.input();
  for (let n = 10000; n <= 40000; n += 5000) { t.setNow(n); await t.tick(); }
  assert.equal(seconds(t, 'create'), 30);
  t.input(); t.focus(false); t.setNow(45000); await t.tick(); assert.equal(seconds(t, 'create'), 30);
  t.focus(true); t.visible(false); t.setNow(50000); await t.tick(); assert.equal(seconds(t, 'create'), 30);
  for (const snapshot of [
    { day: {}, settings: C.DEFAULT_SETTINGS, access: { linkedin: { enabled: true, remainingMs: 0 } } },
    { day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: [] } }
  ]) {
    const blocked = await tracker('chrome', { ...options, snapshot });
    f.document.activeElement = f.host; f.shadowRoot.activeElement = f.editor; blocked.event('focusin', {});
    blocked.input(); blocked.setNow(5000); await blocked.tick();
    assert.deepEqual(blocked.packets, []);
  }
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
