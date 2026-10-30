'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const plugin = require('./youtube.js');
const C = require('../core/core.js');
const { Element, environment, key, click } = require('./test-support.js');
const { tracker } = require('../src/tests/content-harness.js');

function addComment(env, parent = env.document.body) {
  const scope = parent.append(new Element(['ytd-commentbox']));
  const editor = scope.append(new Element(['#contenteditable-root[contenteditable="true"]']));
  const submit = scope.append(new Element(['#submit-button']));
  const button = submit.append(new Element(['button', '#submit-button button'], 'Comment'));
  return { scope, editor, submit, button };
}
function fixture(url = 'https://www.youtube.com/watch?v=synthetic') {
  const env = environment(url);
  return { ...env, ...addComment(env), adapter: plugin.create(env) };
}
function selection(enabled) {
  return { day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: enabled ? ['youtube'] : [] }, access: {} };
}
async function youtubeTracker(browser, { enabled = true, ...options } = {}) {
  const fixtures = [];
  const integration = { ...plugin, create(env) {
    fixtures.push({ ...env, body: env.document.body, ...addComment(env) });
    return plugin.create(env);
  } };
  const t = await tracker(browser, { url: 'https://www.youtube.com/watch?v=synthetic', snapshot: selection(enabled), ...options, integration });
  return { ...t, fixtures };
}
function seconds(t, mode) {
  return t.packets.flatMap(packet => packet.segments).filter(segment => segment.mode === mode).reduce((sum, segment) => sum + segment.sec, 0);
}
function actions(t) { return t.packets.flatMap(packet => packet.actions).map(item => item.action); }

const consuming = [
  '/', '/watch?v=synthetic', '/shorts', '/shorts/synthetic', '/results?search_query=synthetic',
  '/playlist?list=synthetic', '/feed/subscriptions', '/feed/trending', '/feed/explore',
  '/feed/history', '/feed/library', '/feed/you', '/feed/playlists',
  '/@synthetic', '/@synthetic/videos', '/@synthetic/shorts', '/@synthetic/streams',
  '/@synthetic/playlists', '/@synthetic/community', '/@synthetic/posts',
  '/channel/synthetic', '/channel/synthetic/featured', '/channel/synthetic/releases',
  '/c/synthetic/podcasts', '/user/synthetic/courses'
];
const unsupported = [
  '/account', '/account_advanced', '/account_privacy', '/settings', '/settings/privacy',
  '/signin', '/login', '/logout', '/auth', '/auth/callback', '/oops', '/upload', '/create',
  '/youtubei/v1/browse', '/live_chat', '/embed/synthetic', '/redirect', '/premium',
  '/feed', '/feed/unknown', '/watch/unknown', '/shorts/synthetic/unknown',
  '/results/unknown', '/channel', '/channel/synthetic/about', '/@synthetic/settings',
  '/@synthetic/videos/unknown', '/c', '/user'
];

test('YouTube publishes a tracking-only opt-in module in Node and the browser', () => {
  assert.equal(plugin.id, 'youtube');
  assert.equal(plugin.name, 'YouTube');
  assert.deepEqual(plugin.hosts, ['youtube.com', 'www.youtube.com']);
  assert.deepEqual(plugin.actions, ['comments']);
  assert.equal(Object.hasOwn(plugin, 'defaultEnabled'), false);
  assert.equal(Object.hasOwn(plugin, 'access'), false);
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(require.resolve('./youtube.js'), 'utf8'), context);
  const published = context.C3_SITE_MODULES.youtube;
  assert.equal(published.id, plugin.id);
  assert.equal(published.classifyPage({ url: 'https://youtube.com/' }), 'consume');
  assert.equal(typeof published.create, 'function');
});

test('home, watch, Shorts, search, and channel feeds consume on both exact HTTPS hosts', () => {
  for (const host of plugin.hosts) for (const path of consuming) {
    const url = `https://${host}${path}`;
    assert.equal(plugin.classifyPage({ url }), 'consume', url);
    assert.equal(fixture(url).adapter.mode(), 'consume', url);
    assert.equal(plugin.classifyPage({ url, youtubeCommentFocused: true }), 'create', url);
  }
  assert.equal(plugin.classifyPage({ url: 'https://www.youtube.com/@synthetic/videos/?view=grid#top' }), 'consume');
});

test('invalid URLs, non-HTTPS hosts, Studio, aliases, credentials, and nonstandard ports stay neutral', () => {
  for (const url of [
    'invalid', '', '/watch?v=synthetic', 'http://youtube.com/', 'ftp://youtube.com/',
    'https://m.youtube.com/', 'https://music.youtube.com/', 'https://studio.youtube.com/',
    'https://youtube.com.evil.test/', 'https://evilyoutube.com/', 'https://www.youtube.com.evil.test/',
    'https://youtube.com./', 'https://youtu.be/synthetic', 'https://evil.test/?next=https://youtube.com/',
    'https://youtube.com@evil.test/', 'https://user@youtube.com/', 'https://youtube.com:8443/'
  ]) {
    assert.equal(plugin.classifyPage({ url, youtubeCommentFocused: true }), 'neutral', url);
    const f = fixture();
    f.location.href = url;
    f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'neutral', url);
    assert.equal(f.adapter.action(click(f.button)), null, url);
  }
});

test('account, settings, authentication, and unsupported routes stay neutral even with a comment fixture', () => {
  for (const path of unsupported) {
    const url = 'https://www.youtube.com' + path, f = fixture(url);
    assert.equal(plugin.classifyPage({ url, youtubeCommentFocused: true }), 'neutral', path);
    f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'neutral', path);
    assert.equal(f.adapter.action(click(f.button)), null, path);
  }
});

test('only focus inside an identifiable comment editor takes precedence over a feed', () => {
  const f = fixture();
  assert.equal(f.adapter.mode(), 'consume');
  assert.equal(f.adapter.action(click(f.scope)), null);
  f.document.activeElement = f.button;
  assert.equal(f.adapter.mode(), 'consume');
  f.document.activeElement = f.editor;
  assert.equal(f.adapter.mode(), 'create');
  const nested = f.editor.append(new Element());
  f.document.activeElement = nested;
  assert.equal(f.adapter.mode(), 'create');
  nested.style.display = 'none';
  assert.equal(f.adapter.mode(), 'consume');
  f.document.activeElement = f.body.append(new Element(['[contenteditable="true"]', '[role="textbox"]']));
  assert.equal(f.adapter.mode(), 'consume');
  f.scope.selectors.clear();
  f.document.activeElement = f.editor;
  assert.equal(f.adapter.mode(), 'consume');
  assert.equal(f.adapter.action(click(f.button)), null);
});

test('hidden, disconnected, read-only, and disabled editors cannot create or submit', () => {
  for (const mutate of [
    f => { f.editor.style.display = 'none'; },
    f => { f.editor.style.visibility = 'hidden'; },
    f => { f.editor.isConnected = false; },
    f => { f.editor.selectors.clear(); },
    f => { f.scope.attributes.hidden = ''; },
    f => { f.scope.attributes['aria-hidden'] = 'true'; },
    f => { f.editor.attributes['aria-readonly'] = 'true'; },
    f => { f.editor.attributes['aria-disabled'] = 'true'; },
    f => { f.editor.attributes.disabled = ''; },
    f => { f.scope.attributes.inert = ''; }
  ]) {
    const f = fixture();
    f.document.activeElement = f.editor;
    mutate(f);
    assert.equal(f.adapter.mode(), 'consume');
    assert.equal(f.adapter.action(click(f.button)), null);
  }
});

test('comment submissions return the actual scoped button, without requiring editor focus or reading text', () => {
  const f = fixture();
  Object.defineProperty(f.editor, 'textContent', { get() { throw new Error('Editor text must remain unread'); } });
  Object.defineProperty(f.editor, 'value', { get() { throw new Error('Editor value must remain unread'); } });
  const target = f.button.append(new Element());
  assert.deepEqual(f.adapter.action(click(target)), { button: f.button, action: 'comments', submission: true });
  f.button.textContent = 'Comentar';
  f.document.activeElement = f.editor;
  assert.equal(f.adapter.mode(), 'create');
  assert.equal(f.adapter.action(click(target)).button, f.button);
  f.button.disabled = true;
  assert.equal(f.adapter.mode(), 'create', 'disabled submit on an empty composer does not disable writing time');
  assert.equal(f.adapter.action(click(target)), null);
});

test('submit recognition rejects disabled, hidden, disconnected, inert, and unrelated controls', () => {
  for (const mutate of [
    f => { f.button.disabled = true; },
    f => { f.button.attributes.disabled = ''; },
    f => { f.button.attributes['aria-disabled'] = 'true'; },
    f => { f.submit.attributes.disabled = ''; },
    f => { f.submit.attributes['aria-disabled'] = 'true'; },
    f => { f.scope.attributes.inert = ''; },
    f => { f.button.style.display = 'none'; },
    f => { f.button.style.visibility = 'hidden'; },
    f => { f.scope.attributes.hidden = ''; },
    f => { f.button.isConnected = false; },
    f => { f.button.selectors = new Set(['button']); },
    f => { f.editor.remove(); }
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal(f.adapter.action(click(f.button)), null);
  }
  const f = fixture();
  for (const target of [f.editor, f.scope, f.submit, f.body, {}, null, new Element(['button'], 'Comment'), new Element(['button', '#submit-button button'], 'Comment')]) {
    assert.equal(f.adapter.action(click(target)), null);
  }
});

test('multiple comment boxes remain independent and nested replies use their own scope', () => {
  const f = fixture(), other = addComment(f), reply = addComment(f, f.scope);
  f.document.activeElement = other.editor;
  assert.equal(f.adapter.mode(), 'create');
  assert.equal(f.adapter.action(click(f.button)).button, f.button);
  assert.equal(f.adapter.action(click(other.button)).button, other.button);
  assert.equal(f.adapter.action(click(reply.button)).button, reply.button);
  f.editor.remove();
  assert.equal(f.adapter.action(click(f.button)), null, 'a nearby or nested editor cannot authorize another submit');
  assert.equal(f.adapter.action(click(reply.button)).button, reply.button);
  other.button.disabled = true;
  assert.equal(f.adapter.action(click(other.button)), null);
  assert.equal(f.adapter.mode(), 'create');
});

test('ambiguous editors or submit controls in one comment box are not guessed', () => {
  const f = fixture();
  const extraEditor = f.scope.append(new Element(['#contenteditable-root[contenteditable="true"]']));
  f.document.activeElement = f.editor;
  assert.equal(f.adapter.mode(), 'consume');
  assert.equal(f.adapter.action(click(f.button)), null);
  extraEditor.remove();
  const extraSubmit = f.scope.append(new Element(['button', '#submit-button button']));
  assert.equal(f.adapter.mode(), 'create');
  assert.equal(f.adapter.action(click(f.button)), null);
  assert.equal(f.adapter.action(click(extraSubmit)), null);
  extraSubmit.remove();
  assert.equal(f.adapter.action(click(f.button)).button, f.button);
});

test('all editor shortcuts and unsupported actions remain uncredited', () => {
  const f = fixture();
  for (const target of [f.editor, f.button, f.editor.append(new Element())]) {
    for (const extra of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }]) {
      assert.equal(f.adapter.action(key(target, extra)), null);
    }
  }
  for (const type of ['input', 'submit', 'pointerdown', 'wheel', 'touchstart']) assert.equal(f.adapter.action({ type, target: f.editor }), null);
  for (const label of ['Like', 'Unlike', 'Reply', 'Cancel', 'Share', 'Subscribe', 'Upload', 'Publish', 'Post', 'Create']) {
    const button = f.scope.append(new Element(['button'], label));
    assert.equal(f.adapter.action(click(button)), null, label);
  }
});

for (const browser of ['chrome', 'browser']) {
  for (const type of ['wheel', 'touchstart']) {
    test(`${browser} shared tracker uses trusted ${type} input for YouTube consuming and creating time`, async () => {
      const t = await youtubeTracker(browser), f = t.fixtures[0];
      let prevented = false;
      t.event(type, { target: f.body, isTrusted: false });
      t.setNow(5000); await t.tick();
      assert.deepEqual(t.packets, []);
      t.event(type, { target: f.body, isTrusted: true, preventDefault() { prevented = true; } });
      t.setNow(10000); await t.tick();
      assert.equal(seconds(t, 'consume'), 5);
      f.document.activeElement = f.editor;
      t.event('focusin', { target: f.editor });
      t.event(type, { target: f.editor, isTrusted: true });
      t.setNow(15000); await t.tick();
      assert.equal(seconds(t, 'create'), 5);
      assert.equal(prevented, false);
      assert.deepEqual(actions(t), []);
      assert.ok(t.packets.every(packet => packet.site === 'youtube'));
      assert.deepEqual(t.warnings, []);
    });
  }

  test(`${browser} YouTube is opt-in and disable/re-enable requires fresh input`, async () => {
    const t = await youtubeTracker(browser, { snapshot: { day: {}, settings: C.DEFAULT_SETTINGS, access: {} } });
    t.input(); t.event('click', { isTrusted: true, target: new Element(['button', '#submit-button button']) });
    t.setNow(5000); await t.tick();
    assert.equal(t.fixtures.length, 0);
    assert.deepEqual(t.packets, []);
    t.setSnapshot(selection(true)); await t.tick();
    assert.equal(t.fixtures.length, 1);
    t.setNow(10000); await t.tick();
    assert.deepEqual(t.packets, []);
    t.event('wheel', { isTrusted: true });
    t.setNow(15000); await t.tick();
    assert.equal(seconds(t, 'consume'), 5);
    t.setSnapshot(selection(false)); await t.tick();
    const count = t.packets.length;
    t.event('touchstart', { isTrusted: true });
    t.event('click', { isTrusted: true, target: t.fixtures[0].button });
    t.setNow(20000); await t.tick();
    assert.equal(t.packets.length, count);
    t.setSnapshot(selection(true)); await t.tick();
    assert.equal(t.fixtures.length, 2);
    t.setNow(25000); await t.tick();
    assert.equal(t.packets.length, count);
    t.event('touchstart', { isTrusted: true });
    t.setNow(30000); await t.tick();
    assert.equal(seconds(t, 'consume'), 10);
    assert.deepEqual(actions(t), []);
    assert.deepEqual(t.warnings, []);
  });

  test(`${browser} actual adapter submits one comment through shared trusted-input and deduplication rules`, async () => {
    const t = await youtubeTracker(browser), f = t.fixtures[0];
    const target = f.button.append(new Element());
    t.event('click', { isTrusted: false, target }); await t.tick();
    t.focus(false); t.event('click', { isTrusted: true, target }); await t.tick();
    t.focus(true); t.visible(false); t.event('click', { isTrusted: true, target }); await t.tick();
    t.visible(true);
    assert.deepEqual(actions(t), []);
    t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: f.editor }); await t.tick();
    assert.deepEqual(actions(t), []);
    t.event('keydown', { isTrusted: true, key: 'Enter', target: f.button });
    t.event('click', { isTrusted: true, target }); await t.tick();
    t.event('click', { isTrusted: true, target }); await t.tick();
    assert.deepEqual(actions(t), ['comments']);
    t.setNow(1500);
    f.button.disabled = true;
    t.event('click', { isTrusted: true, target }); await t.tick();
    assert.deepEqual(actions(t), ['comments']);
    f.button.disabled = false;
    t.event('click', { isTrusted: true, target }); await t.tick();
    assert.deepEqual(actions(t), ['comments', 'comments']);
    assert.deepEqual(t.warnings, []);
  });

  test(`${browser} YouTube SPA navigation stops classification and actions on unsupported routes`, async () => {
    const t = await youtubeTracker(browser), f = t.fixtures[0];
    t.event('wheel', { isTrusted: true });
    t.setNow(2000); t.route('https://www.youtube.com/account', false);
    f.document.activeElement = f.editor;
    t.event('focusin', { target: f.editor });
    t.event('click', { isTrusted: true, target: f.button });
    t.setNow(5000); await t.tick();
    assert.equal(seconds(t, 'consume'), 2);
    assert.equal(seconds(t, 'create'), 0);
    assert.deepEqual(actions(t), []);
    t.route('https://www.youtube.com/shorts/synthetic', false);
    t.event('touchstart', { isTrusted: true });
    t.setNow(10000); await t.tick();
    assert.equal(seconds(t, 'consume'), 7);
    assert.deepEqual(t.warnings, []);
  });
}
