'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const plugin = require('./facebook.js');
const { Element, environment, key, click } = require('./test-support.js');
const { tracker } = require('../src/tests/content-harness.js');

function populate(env, kind = 'comment') {
  const scope = env.body.append(new Element([kind === 'post' ? '[role="dialog"][aria-label="Create post"]' : 'form']));
  const editor = scope.append(new Element([kind === 'post' ? '[role="textbox"][contenteditable="true"][data-lexical-editor="true"]' : kind === 'message' ? '[role="textbox"][contenteditable="true"][aria-label="Message"]' : '[role="textbox"][contenteditable="true"][aria-label^="Write a comment" i]']));
  const button = scope.append(new Element(['button', '[role="button"]'], kind === 'post' ? 'Post' : kind === 'message' ? 'Send' : 'Comment'));
  return { ...env, scope, editor, button };
}
function fixture(kind = 'comment', url = 'https://www.facebook.com/') {
  const f = populate(environment(url), kind);
  return { ...f, adapter: plugin.create(f) };
}
function seconds(t, mode) { return t.packets.flatMap(p => p.segments).filter(s => s.mode === mode).reduce((total, s) => total + s.sec, 0); }

test('Facebook publishes a synchronous, opt-in, tracking-only module in Node and the browser', () => {
  assert.equal(plugin.id, 'facebook');
  assert.deepEqual(plugin.hosts, ['facebook.com', 'www.facebook.com']);
  assert.deepEqual(plugin.actions, ['posts', 'comments']);
  assert.equal(Object.hasOwn(plugin, 'defaultEnabled'), false);
  assert.equal(Object.hasOwn(plugin, 'access'), false);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('./facebook.js'), 'utf8'), context);
  assert.equal(context.C3_SITE_MODULES.facebook.id, plugin.id);
  assert.equal(typeof context.C3_SITE_MODULES.facebook.create, 'function');
});

test('Facebook classifies only conservative desktop routes on its two exact HTTPS hosts', () => {
  const paths = ['/', '/home.php', '/watch/', '/reel/123/', '/groups/feed/', '/groups/synthetic/', '/groups/synthetic/posts/123/', '/synthetic/posts/pfbidSynthetic/', '/permalink.php?story_fbid=123&id=456', '/profile.php?id=123', '/people/Synthetic/123/'];
  for (const host of plugin.hosts) for (const path of paths) assert.equal(plugin.classifyPage({ url: `https://${host}${path}` }), 'consume', host + path);
  for (const url of ['invalid', '', undefined, null, 'https://', 'http://facebook.com/', 'https://m.facebook.com/', 'https://web.facebook.com/', 'https://facebook.com.evil.test/', 'https://evil.test/?next=https://facebook.com/', 'https://facebook.com:8443/', 'https://name:secret@facebook.com/', 'file:///facebook.com/', 'https://facebook.com./']) {
    assert.equal(plugin.classifyPage({ url, facebookEditorFocused: true, facebookMessageEditorFocused: true }), 'neutral', String(url));
    const f = fixture(); f.location.href = url; f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'neutral');
    assert.equal(f.adapter.action(click(f.button)), null);
  }
});

test('Facebook unsupported routes remain neutral even with a focused recognized editor or submit button', () => {
  for (const path of ['/settings/', '/settings/privacy/', '/login/', '/login.php', '/checkpoint/', '/recover/', '/notifications/', '/friends/', '/marketplace/', '/gaming/', '/events/', '/search/', '/synthetic/', '/groups/create/', '/groups/synthetic/settings/', '/profile.php', '/profile.php?id=not-an-id', '/permalink.php?story_fbid=123', '/unknown/deep/']) {
    const f = fixture('post', 'https://www.facebook.com' + path); f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'neutral', path);
    assert.equal(f.adapter.action(click(f.button)), null, path);
    assert.equal(plugin.classifyPage({ url: f.location.href, facebookEditorFocused: true }), 'neutral', path);
  }
});

test('Facebook own numeric and people profiles are neutral without confusing different query IDs', () => {
  const f = fixture('comment', 'https://facebook.com/profile.php?id=123');
  const link = f.body.append(new Element(['a[aria-label="Your profile"]'])); link.href = 'https://www.facebook.com/profile.php?id=123';
  assert.equal(f.adapter.mode(), 'neutral');
  f.location.href = 'https://facebook.com/profile.php?id=456'; assert.equal(f.adapter.mode(), 'consume');
  f.location.href = 'https://facebook.com/people/Synthetic/123/'; link.href = f.location.href; assert.equal(f.adapter.mode(), 'neutral');
  f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
  link.href = 'https://evil.test/people/Synthetic/123/'; f.document.activeElement = f.body; assert.equal(f.adapter.mode(), 'consume');
});

test('Facebook recognizes the same numeric profile across supported URL forms', () => {
  const urls = id => [`https://facebook.com/profile.php?id=${id}`, `https://www.facebook.com/profile.php/?id=${id}&sk=about`, `https://facebook.com/people/Synthetic/${id}/`, `https://www.facebook.com/people/Another-name/${id}`];
  for (const id of ['123', '9007199254740993']) for (const url of urls(id)) {
    const f = fixture('comment', url);
    const link = f.body.append(new Element(['a[aria-label="Your profile"]']));
    for (const ownProfileURL of urls(id)) {
      link.href = ownProfileURL;
      assert.equal(plugin.classifyPage({ url, ownProfileURL }), 'neutral', `${url} matches ${ownProfileURL}`);
      assert.equal(f.adapter.mode(), 'neutral');
      f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create'); f.document.activeElement = f.body;
    }
    for (const ownProfileURL of urls(id === '123' ? '456' : '9007199254740992')) {
      link.href = ownProfileURL;
      assert.equal(f.adapter.mode(), 'consume', `${url} differs from ${ownProfileURL}`);
    }
  }
  const f = fixture('comment', 'https://facebook.com/people/Synthetic/123/');
  const link = f.body.append(new Element(['a[aria-label="Your profile picture"]']));
  for (const url of ['https://evil.test/profile.php?id=123', 'http://facebook.com/profile.php?id=123', 'https://m.facebook.com/profile.php?id=123', 'https://facebook.com:8443/profile.php?id=123', 'https://user@facebook.com/profile.php?id=123', 'https://facebook.com/profile.php?id=invalid', 'https://facebook.com/?id=123', 'https://facebook.com/groups/123', 'https://facebook.com/people/Synthetic/123/extra']) {
    link.href = url; assert.equal(f.adapter.mode(), 'consume', url);
  }
});

test('Facebook focused scoped post and comment editors take precedence; hidden, disabled and generic editors do not', () => {
  for (const kind of ['post', 'comment']) {
    const f = fixture(kind);
    assert.equal(f.adapter.mode(), 'consume');
    f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
    const child = f.editor.append(new Element()); f.document.activeElement = child; assert.equal(f.adapter.mode(), 'create');
    child.style.display = 'none'; assert.equal(f.adapter.mode(), 'consume'); child.style.display = 'block';
    for (const hidden of ['display', 'visibility']) {
      f.editor.style[hidden] = hidden === 'display' ? 'none' : 'hidden'; assert.equal(f.adapter.mode(), 'consume'); delete f.editor.style[hidden];
    }
    f.scope.attributes['aria-hidden'] = 'true'; assert.equal(f.adapter.mode(), 'consume'); delete f.scope.attributes['aria-hidden'];
    f.editor.isConnected = false; assert.equal(f.adapter.mode(), 'consume'); f.editor.isConnected = true;
    f.editor.attributes['aria-disabled'] = 'true'; assert.equal(f.adapter.mode(), 'consume'); delete f.editor.attributes['aria-disabled'];
    f.document.activeElement = f.button; assert.equal(f.adapter.mode(), 'consume');
    f.editor.selectors = new Set(['[role="textbox"][contenteditable="true"]']); f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'consume');
  }
  const f = fixture(); f.scope.selectors.clear(); f.document.activeElement = f.editor;
  assert.equal(f.adapter.mode(), 'consume'); assert.equal(f.adapter.action(click(f.button)), null);
});

test('Facebook rejects read-only, disabled and inert editors, composers and ancestors', () => {
  const states = [['property', 'readOnly', true], ['attribute', 'readonly', ''], ['attribute', 'aria-readonly', 'true'], ['property', 'disabled', true], ['attribute', 'disabled', ''], ['attribute', 'aria-disabled', 'true'], ['property', 'inert', true], ['attribute', 'inert', '']];
  for (const kind of ['post', 'comment', 'message']) for (const target of ['editor', 'scope', 'ancestor']) for (const [type, name, value] of states) {
    const f = fixture(kind, kind === 'message' ? 'https://www.facebook.com/messages/t/synthetic/' : undefined);
    const ancestor = f.body.append(new Element()); ancestor.append(f.scope);
    const node = target === 'ancestor' ? ancestor : f[target];
    if (type === 'property') node[name] = value; else node.attributes[name] = value;
    f.document.activeElement = f.editor;
    const label = `${kind} ${target} ${name}`;
    assert.equal(f.adapter.mode(), kind === 'message' ? 'neutral' : 'consume', label);
    assert.equal(f.adapter.action(click(f.button)), null, label);
    assert.equal(f.adapter.action(key(f.editor)), null, label);
  }
});

test('Facebook post submits require the create dialog and comments require their own form', () => {
  for (const kind of ['post', 'comment']) {
    const f = fixture(kind);
    const child = f.button.append(new Element());
    assert.deepEqual(f.adapter.action(click(child)), { button: f.button, action: kind === 'post' ? 'posts' : 'comments', submission: true });
    for (const text of ['Create post', 'Write a comment', 'Edit post', 'Save', 'Cancel', 'Like', 'Unlike', 'Share', 'Send', 'Delete']) {
      f.button.textContent = text; assert.equal(f.adapter.action(click(f.button)), null, text);
    }
    f.button.textContent = kind === 'post' ? 'Post' : 'Reply';
    f.button.disabled = true; assert.equal(f.adapter.action(click(f.button)), null); f.button.disabled = false;
    f.button.attributes['aria-disabled'] = 'true'; assert.equal(f.adapter.action(click(f.button)), null); delete f.button.attributes['aria-disabled'];
    f.button.style.display = 'none'; assert.equal(f.adapter.action(click(f.button)), null); delete f.button.style.display;
    f.editor.isConnected = false; assert.equal(f.adapter.action(click(f.button)), null);
    assert.equal(f.adapter.action(click(f.body.append(new Element(['button'], 'Post')))), null);
  }
  const f = fixture('post');
  const form = f.scope.append(new Element(['form'])); form.append(f.editor, f.button);
  assert.equal(f.adapter.action(click(f.button)).action, 'posts');
  f.scope.selectors = new Set(['[role="dialog"][aria-label="Edit post"]']);
  assert.equal(f.adapter.action(click(f.button)), null);
});

test('Facebook comment Enter resolves the same actual button as a click and excludes newline, IME and unsupported shortcuts', () => {
  const f = fixture(), child = f.editor.append(new Element());
  const keyboard = f.adapter.action(key(child));
  assert.deepEqual(keyboard, f.adapter.action(click(f.button)));
  for (const extra of [{ key: ' ' }, { key: 'Escape' }, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }]) assert.equal(f.adapter.action(key(f.editor, extra)), null, JSON.stringify(extra));
  assert.equal(f.adapter.action(key(f.button)), null);
  assert.equal(f.adapter.action({ type: 'input', target: f.editor }), null);
  const post = fixture('post'); assert.equal(post.adapter.action(key(post.editor)), null);
  f.button.isConnected = false;
  const other = f.body.append(new Element(['form'])); other.append(new Element(['button'], 'Comment'));
  assert.equal(f.adapter.action(key(f.editor)), null);
});

test('Facebook message reading stays neutral; focused explicit composing has no submission bonus', () => {
  for (const path of ['/messages/', '/messages/t/synthetic-thread/']) {
    const f = fixture('message', 'https://www.facebook.com' + path);
    assert.equal(f.adapter.mode(), 'neutral');
    f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
    assert.equal(f.adapter.action(click(f.button)), null); assert.equal(f.adapter.action(key(f.editor)), null);
    f.editor.style.display = 'none'; assert.equal(f.adapter.mode(), 'neutral');
  }
  const f = fixture('message'); f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'consume', 'unverified chat overlays are unsupported');
  f.location.href = 'https://www.facebook.com/settings/'; assert.equal(f.adapter.mode(), 'neutral');
});

for (const browser of ['chrome', 'browser']) {
  test(`Facebook ${browser} tracker keeps mixed-form own profiles neutral with native scrolling`, async () => {
    for (const [path, ownPath] of [['/people/Synthetic/123/', '/profile.php?id=123'], ['/profile.php?id=123', '/people/Synthetic/123/']]) {
      let f;
      const t = await tracker(browser, {
        integration: plugin, url: 'https://www.facebook.com' + path,
        snapshot: { day: {}, settings: { trackedSites: ['facebook'] } },
        fixture({ url, listen }) {
          f = populate(environment(url, listen));
          const link = f.body.append(new Element(['a[aria-label="Your profile"]'])); link.href = 'https://facebook.com' + ownPath;
          return f;
        }
      });
      t.input();
      assert.equal(t.wheel(240).defaultPrevented, false, 'own profiles keep native scrolling');
      assert.equal(t.document.scrollingElement.scrollTop, 1000);
      t.setNow(5000); await t.tick();
      assert.equal(seconds(t, 'consume'), 0, 'own profiles never record consuming time');
      assert.deepEqual(t.warnings, []);
    }
  });

  test(`Facebook actual adapter uses shared ${browser} trusted wheel/touch tracking and opt-in lifecycle`, async () => {
    let f;
    const snapshot = trackedSites => ({ day: {}, settings: { trackedSites } });
    const t = await tracker(browser, { integration: plugin, fixture({ url, listen }) { f = populate(environment(url, listen)); return f; }, url: 'https://www.facebook.com/', snapshot: snapshot([]) });
    assert.equal(t.wheel(100).defaultPrevented, false); t.setNow(5000); await t.tick(); assert.equal(t.packets.length, 0);
    t.setSnapshot(snapshot(['facebook'])); await t.tick();
    t.wheel(100, { isTrusted: false }); t.setNow(10000); await t.tick(); assert.equal(t.packets.length, 0);
    assert.equal(t.wheel(100).defaultPrevented, true); assert.equal(t.document.scrollingElement.scrollTop, 1050);
    t.setNow(15000); await t.tick(); assert.equal(seconds(t, 'consume'), 5);
    f.document.activeElement = f.editor; t.event('focusin', {}); t.event('touchstart', { isTrusted: true });
    assert.equal(t.wheel(100).defaultPrevented, false);
    t.setNow(20000); await t.tick(); assert.equal(seconds(t, 'create'), 5);
    t.event('keydown', { ...key(f.editor), isTrusted: true }); t.event('click', { ...click(f.button), isTrusted: true }); await t.tick();
    assert.deepEqual(t.packets.flatMap(p => p.actions).map(a => a.action), ['comments']);
    t.setSnapshot(snapshot([])); await t.tick(); const count = t.packets.length;
    assert.equal(t.wheel(100).defaultPrevented, false);
    t.event('touchstart', { isTrusted: true }); t.event('click', { ...click(f.button), isTrusted: true }); t.setNow(25000); await t.tick(); assert.equal(t.packets.length, count);
    assert.deepEqual(t.warnings, []);
  });
}
