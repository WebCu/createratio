'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const plugin = require('./tiktok.js');
const C = require('../core/core.js');
const { Element, environment, key, click } = require('./test-support.js');
const { tracker } = require('../src/tests/content-harness.js');

function mount(env, kind = 'comment') {
  const scope = env.document.body.append(new Element([kind === 'post' ? 'form' : kind === 'comment' ? '[class*="DivCommentInputContainer"]' : '[data-e2e="message-container"]']));
  const editor = scope.append(new Element([kind === 'post' ? '[data-e2e="upload-caption"] [contenteditable="true"]' : kind === 'comment' ? '[data-e2e="comment-input"] [contenteditable="true"]' : '[data-e2e="message-input"][contenteditable="true"]']));
  const button = scope.append(new Element([kind === 'post' ? 'button[data-e2e="post_video_button"]' : kind === 'comment' ? '[data-e2e="comment-post"]' : '[data-e2e="message-send"]']));
  return { ...env, scope, editor, button, adapter: plugin.create(env) };
}
function fixture(kind = 'comment', url = 'https://www.tiktok.com/@sample/video/123456') {
  return mount(environment(url), kind);
}
function seconds(t, mode) {
  return t.packets.flatMap(packet => packet.segments).filter(segment => segment.mode === mode).reduce((sum, segment) => sum + segment.sec, 0);
}

test('TikTok publishes a tracking-only, opt-in module in Node and the browser', () => {
  assert.equal(plugin.id, 'tiktok');
  assert.equal(plugin.name, 'TikTok');
  assert.deepEqual(plugin.hosts, ['tiktok.com', 'www.tiktok.com']);
  assert.equal(Object.hasOwn(plugin, 'defaultEnabled'), false);
  assert.equal(Object.hasOwn(plugin, 'access'), false);
  assert.deepEqual(plugin.actions, ['posts', 'comments', 'likes', 'bookmarks']);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('./tiktok.js'), 'utf8'), context);
  assert.equal(context.C3_SITE_MODULES.tiktok.id, plugin.id);
});

test('TikTok classifies only recognized desktop routes', () => {
  for (const host of plugin.hosts) {
    for (const path of ['/', '/foryou/', '/following', '/explore', '/search?q=synthetic', '/tag/synthetic', '/music/synthetic-123', '/@sample', '/@sample/video/123', '/@sample/photo/123']) {
      assert.equal(plugin.classifyPage({ url: 'https://' + host + path }), 'consume', path);
    }
    for (const path of ['/upload', '/tiktokstudio/upload/', '/messages', '/settings', '/login', '/signup', '/legal/privacy-policy', '/live', '/unknown', '/@sample/followers', '/@sample/video/not-an-id', '/foryou/unreviewed', '/tiktokstudio/analytics']) {
      assert.equal(plugin.classifyPage({ url: 'https://' + host + path }), 'neutral', path);
    }
  }
  assert.equal(plugin.classifyPage({ url: 'https://tiktok.com/@Sample/', ownProfilePath: '/@sample/' }), 'neutral');
  assert.equal(plugin.classifyPage({ url: 'https://tiktok.com/@sample/video/123', ownProfilePath: '/@sample' }), 'consume');
  assert.equal(plugin.classifyPage({ url: 'https://tiktok.com/@sample', ownProfilePath: '/@sample', tiktokEditorFocused: true }), 'create');
});

test('TikTok rejects malformed URLs, non-HTTPS, non-desktop hosts and unreviewed editors', () => {
  for (const url of [undefined, '', 'invalid', '/foryou', 'https://[', 'http://tiktok.com/', 'https://m.tiktok.com/', 'https://vm.tiktok.com/', 'https://tiktok.com.evil.test/', 'https://evil.test/?next=https://tiktok.com/', 'https://tiktok.com:444/', 'https://user@tiktok.com/', 'ftp://tiktok.com/']) {
    assert.equal(plugin.classifyPage({ url, tiktokEditorFocused: true }), 'neutral', String(url));
  }
  for (const path of ['/settings', '/login', '/unknown', '/messages/unreviewed']) {
    assert.equal(plugin.classifyPage({ url: 'https://tiktok.com' + path, tiktokEditorFocused: true }), 'neutral', path);
  }
});

test('TikTok focused comments override feed, video and known own-profile reading', () => {
  for (const path of ['/', '/@sample', '/@sample/video/123', '/@sample/photo/123']) {
    const f = fixture('comment', 'https://tiktok.com' + path);
    const own = f.body.append(new Element(['a[data-e2e="nav-profile"]'])); own.href = '/@sample/';
    const reading = path === '/@sample' ? 'neutral' : 'consume';
    assert.equal(f.adapter.mode(), reading);
    f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'create');
    f.document.activeElement = f.editor.append(new Element());
    assert.equal(f.adapter.mode(), 'create');
    f.document.activeElement = f.button;
    assert.equal(f.adapter.mode(), reading);
  }
});

test('TikTok ignores hidden, disabled, read-only and generic editors', () => {
  const f = fixture(); f.document.activeElement = f.editor;
  for (const change of [() => { f.editor.style.display = 'none'; }, () => { f.editor.style.visibility = 'hidden'; }, () => { f.editor.isConnected = false; }, () => { f.editor.disabled = true; }, () => { f.editor.readOnly = true; }, () => { f.editor.attributes['aria-readonly'] = 'true'; }]) {
    change(); assert.equal(f.adapter.mode(), 'consume');
    f.editor.style = {}; f.editor.isConnected = true; f.editor.disabled = false; f.editor.readOnly = false; f.editor.attributes = {};
  }
  f.editor.selectors = new Set(['textarea', '[contenteditable="true"]', '[role="textbox"][contenteditable="true"]']);
  assert.equal(f.adapter.mode(), 'consume');
  assert.equal(f.adapter.action(click(f.button)), null);
  f.location.href = 'https://tiktok.com/settings';
  assert.equal(f.adapter.mode(), 'neutral');
});

test('TikTok caption focus creates only on reviewed upload routes and posting needs a scoped submit', () => {
  for (const path of ['/upload', '/tiktokstudio/upload']) {
    const f = fixture('post', 'https://tiktok.com' + path);
    assert.equal(f.adapter.mode(), 'neutral');
    f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
    const nested = f.button.append(new Element());
    const result = f.adapter.action(click(nested));
    assert.equal(result.button, f.button); assert.equal(result.action, 'posts'); assert.equal(result.submission, true);
    assert.equal(f.adapter.action(key(f.editor, { ctrlKey: true })), null);
    assert.equal(f.adapter.action(key(f.editor)), null);
    f.location.href = 'https://tiktok.com/';
    assert.equal(f.adapter.mode(), 'consume'); assert.equal(f.adapter.action(click(f.button)), null);
  }
});

test('TikTok message reading is neutral and focused DM composing never earns submission bonuses', () => {
  const f = fixture('message', 'https://tiktok.com/messages');
  assert.equal(f.adapter.mode(), 'neutral');
  f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
  assert.equal(f.adapter.action(click(f.button)), null);
  assert.equal(f.adapter.action(key(f.editor)), null);
  f.document.activeElement = f.button; assert.equal(f.adapter.mode(), 'neutral');
  f.location.href = 'https://tiktok.com/settings'; f.document.activeElement = f.editor;
  assert.equal(f.adapter.mode(), 'neutral');
});

test('TikTok rejects inert and disabled composer ancestors for modes and actions', () => {
  for (const kind of ['comment', 'post', 'message']) {
    const f = fixture(kind, kind === 'post' ? 'https://tiktok.com/upload' : kind === 'message' ? 'https://tiktok.com/messages' : 'https://tiktok.com/');
    f.document.activeElement = f.editor;
    const light = f.scope.append(new Element(['button[data-e2e="like-icon"][aria-pressed="false"]']));
    for (const selector of ['[inert]', '[aria-disabled="true"]', 'fieldset[disabled]']) {
      f.scope.selectors.add(selector);
      assert.equal(f.adapter.mode(), kind === 'comment' ? 'consume' : 'neutral', selector);
      assert.equal(f.adapter.action(click(f.button)), null);
      assert.equal(f.adapter.action(key(f.editor)), null);
      assert.equal(f.adapter.action(click(light)), null);
      f.scope.selectors.delete(selector);
      assert.equal(f.adapter.mode(), 'create');
    }
  }
});

test('TikTok recognizes composing and submissions without reading editor text', () => {
  const f = fixture();
  for (const field of ['textContent', 'innerText', 'value']) Object.defineProperty(f.editor, field, { get() { throw new Error('Editor text must stay private'); } });
  f.document.activeElement = f.editor;
  assert.equal(f.adapter.mode(), 'create');
  assert.equal(f.adapter.action(click(f.button)).action, 'comments');
  assert.equal(f.adapter.action(key(f.editor)).button, f.button);
});

test('TikTok comment clicks and plain Enter identify the same submit element', () => {
  const f = fixture(), child = f.editor.append(new Element());
  const keyboard = f.adapter.action(key(child));
  const pointer = f.adapter.action(click(f.button.append(new Element())));
  assert.equal(keyboard.action, 'comments'); assert.equal(keyboard.submission, true);
  assert.equal(keyboard.button, f.button); assert.equal(pointer.button, keyboard.button);
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { key: ' ' }]) {
    assert.equal(f.adapter.action(key(child, extra)), null, JSON.stringify(extra));
  }
  assert.equal(f.adapter.action(key(f.button)), null);
  assert.equal(f.adapter.action({ type: 'input', target: f.editor }), null);
});

test('TikTok submissions reject unavailable controls, unrelated composers and unsupported routes', () => {
  const f = fixture();
  for (const change of [() => { f.button.disabled = true; }, () => { f.button.attributes['aria-disabled'] = 'true'; }, () => { f.button.style.display = 'none'; }, () => { f.button.isConnected = false; }]) {
    change(); assert.equal(f.adapter.action(click(f.button)), null); assert.equal(f.adapter.action(key(f.editor)), null);
    f.button.disabled = false; f.button.attributes = {}; f.button.style = {}; f.button.isConnected = true;
  }
  const other = f.body.append(new Element(['[class*="DivCommentInputContainer"]']));
  const unrelated = other.append(new Element(['[data-e2e="comment-post"]']));
  assert.equal(f.adapter.action(click(unrelated)), null);
  f.button.disabled = true;
  assert.equal(f.adapter.action(key(f.editor)), null);
  f.button.disabled = false;
  f.scope.selectors.clear();
  assert.equal(f.adapter.action(click(f.button)), null); assert.equal(f.adapter.action(key(f.editor)), null);
  f.scope.selectors.add('[class*="DivCommentInputContainer"]');
  f.document.activeElement = f.editor;
  for (const url of ['https://tiktok.com/settings', 'https://tiktok.com/messages', 'http://tiktok.com/', 'https://m.tiktok.com/', 'invalid']) {
    f.location.href = url;
    assert.equal(f.adapter.mode(), 'neutral'); assert.equal(f.adapter.action(click(f.button)), null); assert.equal(f.adapter.action(key(f.editor)), null);
  }
});

test('TikTok counts only explicit positive light controls, never composer or share launchers', () => {
  const f = fixture();
  for (const [selector, action] of [['button[data-e2e="like-icon"][aria-pressed="false"]', 'likes'], ['[role="button"][data-e2e="browse-collect-icon"][aria-pressed="false"]', 'bookmarks']]) {
    const button = f.body.append(new Element([selector]));
    const result = f.adapter.action(click(button.append(new Element())));
    assert.equal(result.action, action); assert.equal(result.button, button); assert.equal(result.submission, false);
    button.disabled = true; assert.equal(f.adapter.action(click(button)), null);
  }
  for (const selector of ['[data-e2e="like-icon"]', 'button[data-e2e="like-icon"][aria-pressed="true"]', 'button[data-e2e="bookmark-icon"][aria-pressed="true"]', '[data-e2e="comment-icon"]', '[data-e2e="share-icon"]', '[data-e2e="repost-button"]', '[data-e2e="upload-icon"]']) {
    assert.equal(f.adapter.action(click(new Element([selector]))), null, selector);
  }
});

for (const browser of ['chrome', 'browser']) {
  test(`TikTok real adapter uses shared trusted wheel/touch tracking, opt-in and submission deduplication (${browser})`, async () => {
    let mounted, creations = 0;
    const integration = { ...plugin, create(env) { creations++; mounted = mount(env); return mounted.adapter; } };
    const options = { url: 'https://tiktok.com/@sample/video/123', integration, snapshot: { day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: [] } } };
    const t = await tracker(browser, options);
    t.event('wheel', { isTrusted: true }); t.setNow(5000); await t.tick();
    assert.equal(creations, 0); assert.equal(t.packets.length, 0);
    t.setSnapshot({ day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: ['tiktok'] } }); await t.tick();
    assert.equal(creations, 1);
    t.event('wheel', { isTrusted: false }); t.setNow(10000); await t.tick();
    assert.equal(seconds(t, 'consume'), 0);
    t.event('wheel', { isTrusted: true }); t.setNow(15000); await t.tick();
    assert.equal(seconds(t, 'consume'), 5);
    mounted.document.activeElement = mounted.editor; t.event('focusin', {});
    t.event('touchstart', { isTrusted: true }); t.setNow(20000); await t.tick();
    assert.equal(seconds(t, 'create'), 5);
    t.event('keydown', { ...key(mounted.editor), isTrusted: true });
    t.event('click', { ...click(mounted.button), isTrusted: true }); await t.tick();
    assert.deepEqual(t.packets.flatMap(packet => packet.actions).map(action => action.action), ['comments']);
    t.setSnapshot({ day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: [] } }); await t.tick();
    const count = t.packets.length;
    t.event('touchstart', { isTrusted: true }); t.event('click', { ...click(mounted.button), isTrusted: true }); t.setNow(25000); await t.tick();
    assert.equal(t.packets.length, count); assert.deepEqual(t.warnings, []);
  });
}
