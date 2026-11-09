'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const plugin = require('./instagram.js');
const C = require('../core/core.js');
const { Element, environment, key, click } = require('./test-support.js');
const { tracker } = require('../src/tests/content-harness.js');

function mount(env, kind = 'comment') {
  const scope = env.document.body.append(new Element([kind === 'post' ? '[role="dialog"]' : 'form']));
  const editor = scope.append(new Element([kind === 'post' ? 'textarea[aria-label="Write a caption…"]' : kind === 'comment' ? 'textarea[aria-label="Add a comment…"]' : '[role="textbox"][contenteditable="true"][aria-label="Message"]']));
  const button = scope.append(new Element(['button'], kind === 'post' ? 'Share' : kind === 'comment' ? 'Post' : 'Send'));
  return { ...env, scope, editor, button, adapter: plugin.create(env) };
}
function fixture(kind = 'comment', url = 'https://www.instagram.com/p/synthetic-post/') {
  return mount(environment(url), kind);
}
function seconds(t, mode) {
  return t.packets.flatMap(packet => packet.segments).filter(segment => segment.mode === mode).reduce((sum, segment) => sum + segment.sec, 0);
}

test('Instagram publishes an opt-in module with explicit access policy in Node and the browser', () => {
  assert.equal(plugin.id, 'instagram'); assert.equal(plugin.name, 'Instagram');
  assert.deepEqual(plugin.hosts, ['instagram.com', 'www.instagram.com']);
  assert.equal(Object.hasOwn(plugin, 'defaultEnabled'), false);
  assert.deepEqual(plugin.access.domains, ['instagram.com']);
  assert.equal(plugin.access.home, 'https://www.instagram.com/');
  assert.equal(plugin.access.sessionRules.some(rule => rule.condition.excludedResourceTypes?.includes('sub_frame')), true);
  assert.equal(plugin.access.unrestrictedRules.some(rule => rule.condition.excludedResourceTypes?.includes('main_frame')), true);
  assert.deepEqual(plugin.actions, ['posts', 'comments', 'likes', 'bookmarks']);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('./instagram.js'), 'utf8'), context);
  assert.equal(context.C3_SITE_MODULES.instagram.id, plugin.id);
});

test('Instagram classifies reviewed feeds, content, profiles and neutral routes', () => {
  for (const host of plugin.hosts) {
    for (const path of ['/', '/explore/', '/explore/search?q=synthetic', '/explore/tags/synthetic', '/reels/', '/reel/synthetic-id/', '/reels/synthetic-id/', '/p/synthetic-id/', '/stories/sample/123/', '/sample/', '/sample/reels/', '/sample/tagged/']) {
      assert.equal(plugin.classifyPage({ url: 'https://' + host + path }), 'consume', path);
    }
    for (const path of ['/accounts/edit/', '/accounts/login/', '/settings/', '/login/', '/signup/', '/auth/', '/challenge/', '/direct/inbox/', '/direct/t/123/', '/direct/new/', '/create/details/', '/legal/terms/', '/notifications/', '/explore/unreviewed/', '/sample/saved/', '/p/id/unsupported/']) {
      assert.equal(plugin.classifyPage({ url: 'https://' + host + path }), 'neutral', path);
    }
  }
  for (const path of ['/Sample/', '/sample/reels/', '/sample/tagged/']) {
    assert.equal(plugin.classifyPage({ url: 'https://instagram.com' + path, ownProfilePath: '/sample/' }), 'neutral');
  }
  assert.equal(plugin.classifyPage({ url: 'https://instagram.com/p/id/', ownProfilePath: '/sample' }), 'consume');
  assert.equal(plugin.classifyPage({ url: 'https://instagram.com/sample/', ownProfilePath: '/sample', instagramEditorFocused: true }), 'create');
});

test('Instagram rejects invalid URLs and non-desktop hosts before editor precedence', () => {
  for (const url of [undefined, '', 'invalid', '/p/id/', 'https://[', 'http://instagram.com/', 'https://m.instagram.com/', 'https://help.instagram.com/', 'https://instagram.com.evil.test/', 'https://evil.test/?next=https://instagram.com/', 'https://instagram.com:444/', 'https://user@instagram.com/', 'ftp://instagram.com/']) {
    assert.equal(plugin.classifyPage({ url, instagramEditorFocused: true }), 'neutral', String(url));
  }
  for (const path of ['/accounts/edit/', '/accounts/login/', '/challenge/', '/settings/', '/direct/unreviewed/']) {
    assert.equal(plugin.classifyPage({ url: 'https://instagram.com' + path, instagramEditorFocused: true }), 'neutral', path);
  }
});

test('Instagram focused comments and caption dialogs override supported reading, including own profiles', () => {
  for (const kind of ['comment', 'post']) {
    for (const path of ['/', '/p/id/', '/reel/id/', '/sample/']) {
      const f = fixture(kind, 'https://instagram.com' + path);
      const own = f.body.append(new Element(['a[aria-label="Profile"]'])); own.href = '/sample/';
      const reading = path === '/sample/' ? 'neutral' : 'consume';
      assert.equal(f.adapter.mode(), reading);
      f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
      f.document.activeElement = f.editor.append(new Element()); assert.equal(f.adapter.mode(), 'create');
      f.document.activeElement = f.button; assert.equal(f.adapter.mode(), reading);
    }
  }
});

test('Instagram requires visible editable fields and scopes captions to creation dialogs', () => {
  for (const kind of ['comment', 'post']) {
    const f = fixture(kind); f.document.activeElement = f.editor;
    for (const change of [() => { f.editor.style.display = 'none'; }, () => { f.editor.style.visibility = 'hidden'; }, () => { f.editor.isConnected = false; }, () => { f.editor.disabled = true; }, () => { f.editor.readOnly = true; }, () => { f.editor.attributes['aria-readonly'] = 'true'; }]) {
      change(); assert.equal(f.adapter.mode(), 'consume'); assert.equal(f.adapter.action(click(f.button)), null);
      f.editor.style = {}; f.editor.isConnected = true; f.editor.disabled = false; f.editor.readOnly = false; f.editor.attributes = {};
    }
    if (kind === 'post') {
      f.scope.selectors.clear(); assert.equal(f.adapter.mode(), 'consume'); assert.equal(f.adapter.action(click(f.button)), null);
    }
    f.editor.selectors = new Set(['textarea', '[contenteditable="true"]', '[role="textbox"][contenteditable="true"]']);
    assert.equal(f.adapter.mode(), 'consume'); assert.equal(f.adapter.action(click(f.button)), null);
  }
});

test('Instagram auth and settings routes ignore even recognizable focused fields and action buttons', () => {
  for (const kind of ['comment', 'post', 'message']) {
    for (const path of ['/accounts/edit/', '/accounts/login/', '/settings/', '/challenge/', '/legal/privacy/']) {
      const f = fixture(kind, 'https://instagram.com' + path); f.document.activeElement = f.editor;
      assert.equal(f.adapter.mode(), 'neutral'); assert.equal(f.adapter.action(click(f.button)), null); assert.equal(f.adapter.action(key(f.editor)), null);
    }
  }
});

test('Instagram DM reading stays neutral and focused composing never earns post or comment bonuses', () => {
  for (const path of ['/direct/inbox/', '/direct/t/123/', '/direct/new/']) {
    const f = fixture('message', 'https://instagram.com' + path);
    assert.equal(f.adapter.mode(), 'neutral');
    f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
    assert.equal(f.adapter.action(click(f.button)), null); assert.equal(f.adapter.action(key(f.editor)), null);
    f.document.activeElement = f.button; assert.equal(f.adapter.mode(), 'neutral');
    f.location.href = 'https://instagram.com/'; f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'consume');
  }
});

test('Instagram caption sharing is a post only with a visible dialog editor and final Share control', () => {
  for (const path of ['/', '/create/select/', '/create/style/', '/create/details/']) {
    const f = fixture('post', 'https://instagram.com' + path);
    assert.equal(f.adapter.mode(), path === '/' ? 'consume' : 'neutral');
    f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
    const result = f.adapter.action(click(f.button.append(new Element())));
    assert.equal(result.button, f.button); assert.equal(result.action, 'posts'); assert.equal(result.submission, true);
    for (const text of ['Next', 'Create', 'Share to story', 'Cancel']) {
      f.button.textContent = text; assert.equal(f.adapter.action(click(f.button)), null, text);
    }
    f.button.textContent = 'Share';
    assert.equal(f.adapter.action(key(f.editor)), null);
    assert.equal(f.adapter.action(key(f.editor, { ctrlKey: true })), null);
  }
});

test('Instagram Reel rich-text captions recognize final Share without reading private text', () => {
  for (const label of ['Write a caption…', 'Write a caption...']) {
    const f = fixture('post');
    f.editor.selectors = new Set([`[role="textbox"][contenteditable="true"][aria-label="${label}"]`]);
    f.button.selectors = new Set(['[role="button"]']);
    for (const field of ['textContent', 'innerText', 'value']) Object.defineProperty(f.editor, field, { get() { throw new Error('Editor text must stay private'); } });
    const result = f.adapter.action(click(f.button.append(new Element())));
    assert.equal(result?.action, 'posts', label);
    assert.equal(result.button, f.button);
    assert.equal(result.submission, true);
    f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'create', label);
    for (const text of ['Next', 'Create', 'Share to story', 'Cancel']) {
      f.button.textContent = text;
      assert.equal(f.adapter.action(click(f.button)), null, text);
    }
    f.button.textContent = 'Share';
    assert.equal(f.adapter.action(key(f.editor)), null);
    f.editor.style.display = 'none';
    assert.equal(f.adapter.mode(), 'consume');
    assert.equal(f.adapter.action(click(f.button)), null);
    f.editor.style = {};
    f.button.attributes['aria-disabled'] = 'true';
    assert.equal(f.adapter.action(click(f.button)), null);
    f.button.attributes = {};
    f.scope.selectors.clear();
    assert.equal(f.adapter.mode(), 'consume');
    assert.equal(f.adapter.action(click(f.button)), null);
  }
});

test('Instagram rejects inert and disabled composer ancestors for modes and actions', () => {
  for (const kind of ['comment', 'post', 'message']) {
    const f = fixture(kind, kind === 'message' ? 'https://instagram.com/direct/t/123/' : 'https://instagram.com/');
    f.document.activeElement = f.editor;
    const light = f.scope.append(new Element(['button[aria-label="Like"]']));
    for (const selector of ['[inert]', '[aria-disabled="true"]', 'fieldset[disabled]']) {
      f.scope.selectors.add(selector);
      assert.equal(f.adapter.mode(), kind === 'message' ? 'neutral' : 'consume', selector);
      assert.equal(f.adapter.action(click(f.button)), null);
      assert.equal(f.adapter.action(key(f.editor)), null);
      assert.equal(f.adapter.action(click(light)), null);
      f.scope.selectors.delete(selector);
      assert.equal(f.adapter.mode(), 'create');
    }
  }
});

test('Instagram recognizes composing and submissions without reading editor text', () => {
  const f = fixture();
  for (const field of ['textContent', 'innerText', 'value']) Object.defineProperty(f.editor, field, { get() { throw new Error('Editor text must stay private'); } });
  f.document.activeElement = f.editor;
  assert.equal(f.adapter.mode(), 'create');
  assert.equal(f.adapter.action(click(f.button)).action, 'comments');
  assert.equal(f.adapter.action(key(f.editor)).button, f.button);
});

test('Instagram adapter rejects invalid and unrelated URLs even with focused recognized editors', () => {
  const f = fixture(); f.document.activeElement = f.editor;
  for (const url of ['invalid', 'https://help.instagram.com/p/id/', 'http://instagram.com/p/id/', 'https://instagram.com.evil.test/p/id/']) {
    f.location.href = url;
    assert.equal(f.adapter.mode(), 'neutral');
    assert.equal(f.adapter.action(click(f.button)), null);
    assert.equal(f.adapter.action(key(f.editor)), null);
  }
});

test('Instagram comment click and plain Enter return the same scoped submit button', () => {
  const f = fixture(), nested = f.editor.append(new Element());
  const keyboard = f.adapter.action(key(nested));
  const pointer = f.adapter.action(click(f.button.append(new Element())));
  assert.equal(keyboard.action, 'comments'); assert.equal(keyboard.submission, true);
  assert.equal(keyboard.button, f.button); assert.equal(pointer.button, keyboard.button);
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { key: ' ' }]) {
    assert.equal(f.adapter.action(key(nested, extra)), null, JSON.stringify(extra));
  }
  assert.equal(f.adapter.action(key(f.button)), null);
  assert.equal(f.adapter.action({ type: 'input', target: f.editor }), null);
});

test('Instagram requires an enabled submit in the same comment form, not another composer', () => {
  const f = fixture();
  for (const change of [() => { f.button.disabled = true; }, () => { f.button.attributes['aria-disabled'] = 'true'; }, () => { f.button.style.display = 'none'; }, () => { f.button.isConnected = false; }]) {
    change(); assert.equal(f.adapter.action(click(f.button)), null); assert.equal(f.adapter.action(key(f.editor)), null);
    f.button.disabled = false; f.button.attributes = {}; f.button.style = {}; f.button.isConnected = true;
  }
  f.button.remove();
  const other = f.body.append(new Element(['form'])); other.append(new Element(['button'], 'Post'));
  assert.equal(f.adapter.action(key(f.editor)), null);
  assert.equal(f.adapter.action(click(other.children[0])), null);
  f.scope.selectors.clear(); assert.equal(f.adapter.action(key(f.editor)), null);
});

test('Instagram recognizes positive light actions without unliking, unsaving, share or composer launchers', () => {
  const f = fixture();
  for (const [selector, action] of [['button[aria-label="Like"]', 'likes'], ['[role="button"]:has(svg[aria-label="Like"])', 'likes'], ['button:has(svg[aria-label="Save"])', 'bookmarks']]) {
    const button = f.body.append(new Element([selector]));
    const result = f.adapter.action(click(button.append(new Element())));
    assert.equal(result.action, action); assert.equal(result.button, button); assert.equal(result.submission, false);
    button.attributes['aria-pressed'] = 'true'; assert.equal(f.adapter.action(click(button)), null);
    delete button.attributes['aria-pressed']; button.disabled = true; assert.equal(f.adapter.action(click(button)), null);
  }
  for (const selector of ['button[aria-label="Unlike"]', 'button[aria-label="Remove"]', '[role="button"]:has(svg[aria-label="Unlike"])', '[role="button"]:has(svg[aria-label="Remove"])', 'button[aria-label="Comment"]', 'button[aria-label="New post"]', 'button[aria-label="Share Post"]']) {
    assert.equal(f.adapter.action(click(new Element([selector]))), null, selector);
  }
  const button = new Element(['button[aria-label="Like"]']);
  f.location.href = 'https://instagram.com/direct/inbox/'; assert.equal(f.adapter.action(click(button)), null);
  f.location.href = 'https://help.instagram.com/'; assert.equal(f.adapter.action(click(button)), null);
});

for (const browser of ['chrome', 'browser']) {
  test(`Instagram Reel rich-text captions save writing time and one Share action (${browser})`, async () => {
    let mounted;
    const integration = { ...plugin, create(env) {
      mounted = mount(env, 'post');
      mounted.editor.selectors = new Set(['[role="textbox"][contenteditable="true"][aria-label="Write a caption..."]']);
      return mounted.adapter;
    } };
    const t = await tracker(browser, { url: 'https://instagram.com/', integration, snapshot: { day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: ['instagram'] } } });
    mounted.document.activeElement = mounted.editor;
    t.event('focusin', {});
    t.event('input', { target: mounted.editor, isTrusted: true });
    t.setNow(5000); await t.tick();
    assert.equal(seconds(t, 'create'), 5);
    assert.deepEqual(t.packets.flatMap(packet => packet.actions), []);
    t.event('click', { ...click(mounted.button), isTrusted: false });
    await t.tick();
    assert.deepEqual(t.packets.flatMap(packet => packet.actions), []);
    t.event('click', { ...click(mounted.button), isTrusted: true });
    t.event('click', { ...click(mounted.button), isTrusted: true });
    await t.tick();
    assert.deepEqual(t.packets.flatMap(packet => packet.actions).map(action => action.action), ['posts']);
    assert.deepEqual(t.warnings, []);
  });

  test(`Instagram real adapter uses shared trusted wheel/touch tracking, opt-in and submission deduplication (${browser})`, async () => {
    let mounted, creations = 0;
    const integration = { ...plugin, create(env) { creations++; mounted = mount(env); return mounted.adapter; } };
    const t = await tracker(browser, { url: 'https://instagram.com/p/synthetic/', integration, snapshot: { day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: [] } } });
    t.event('touchstart', { isTrusted: true }); t.setNow(5000); await t.tick();
    assert.equal(creations, 0); assert.equal(t.packets.length, 0);
    t.setSnapshot({ day: {}, settings: { ...C.DEFAULT_SETTINGS, trackedSites: ['instagram'] } }); await t.tick();
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
    t.event('wheel', { isTrusted: true }); t.event('click', { ...click(mounted.button), isTrusted: true }); t.setNow(25000); await t.tick();
    assert.equal(t.packets.length, count); assert.deepEqual(t.warnings, []);
  });
}
