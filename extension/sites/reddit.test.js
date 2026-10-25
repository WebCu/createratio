'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const plugin = require('./reddit.js');
const { Element, environment, key, click } = require('./test-support.js');
const { tracker } = require('../src/tests/content-harness.js');

function populate(env, kind = 'comment') {
  const scope = env.body.append(new Element([kind === 'post' ? 'form[action="/api/submit"]' : kind === 'message' ? 'form[action="/api/compose"]' : 'form[action="/api/comment"]']));
  const editor = scope.append(new Element([kind === 'post' ? 'textarea[name="title"]' : 'textarea[name="text"]']));
  const button = scope.append(new Element(['button'], kind === 'post' ? 'Post' : kind === 'message' ? 'Send' : 'Comment'));
  return { ...env, scope, editor, button };
}
function fixture(kind = 'comment', url = 'https://www.reddit.com/r/synthetic/comments/abc123/synthetic_post/') {
  const f = populate(environment(url), kind);
  return { ...f, adapter: plugin.create(f) };
}
function seconds(t, mode) { return t.packets.flatMap(p => p.segments).filter(s => s.mode === mode).reduce((total, s) => total + s.sec, 0); }

test('Reddit publishes a synchronous, opt-in, tracking-only module without the old host', () => {
  assert.equal(plugin.id, 'reddit');
  assert.deepEqual(plugin.hosts, ['reddit.com', 'www.reddit.com']);
  assert.deepEqual(plugin.actions, ['posts', 'comments']);
  assert.equal(Object.hasOwn(plugin, 'defaultEnabled'), false);
  assert.equal(Object.hasOwn(plugin, 'access'), false);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('./reddit.js'), 'utf8'), context);
  assert.equal(context.C3_SITE_MODULES.reddit.id, plugin.id);
  assert.equal(typeof context.C3_SITE_MODULES.reddit.create, 'function');
});

test('Reddit classifies only conservative feed, search, thread and profile routes on exact HTTPS hosts', () => {
  const paths = ['/', '/best/', '/hot/', '/new/', '/top/?t=day', '/rising/', '/controversial/', '/search/?q=synthetic', '/r/synthetic/', '/r/synthetic/new/', '/r/synthetic/search/?q=synthetic', '/r/synthetic/comments/abc123/', '/r/synthetic/comments/abc123/synthetic_post/def456/', '/comments/abc123/synthetic_post/', '/user/synthetic/', '/u/synthetic/', '/user/synthetic/comments/', '/user/synthetic/submitted/', '/user/synthetic/overview/'];
  for (const host of plugin.hosts) for (const path of paths) assert.equal(plugin.classifyPage({ url: `https://${host}${path}` }), 'consume', host + path);
  for (const url of ['invalid', '', undefined, null, 'https://', 'http://reddit.com/', 'https://old.reddit.com/', 'https://new.reddit.com/', 'https://m.reddit.com/', 'https://chat.reddit.com/', 'https://reddit.com.evil.test/', 'https://evil.test/?next=https://reddit.com/', 'https://reddit.com:8443/', 'https://name:secret@reddit.com/', 'file:///reddit.com/', 'https://reddit.com./']) {
    assert.equal(plugin.classifyPage({ url, redditEditorFocused: true, redditMessageEditorFocused: true }), 'neutral', String(url));
    const f = fixture(); f.location.href = url; f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'neutral'); assert.equal(f.adapter.action(click(f.button)), null);
  }
});

test('Reddit unsupported routes never create or submit even with a recognized focused composer', () => {
  for (const path of ['/settings/', '/settings/profile/', '/login/', '/register/', '/account/', '/notifications/', '/message/inbox/', '/message/messages/', '/chat/', '/user/synthetic/saved/', '/user/synthetic/settings/', '/r/synthetic/about/', '/r/synthetic/wiki/', '/r/synthetic/about/modqueue/', '/r/synthetic/submit/extra/', '/unknown/', '/r/synthetic/comments/', '/r/synthetic/comments/abc123/title/id/extra/']) {
    const f = fixture('comment', 'https://www.reddit.com' + path); f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'neutral', path); assert.equal(f.adapter.action(click(f.button)), null, path);
    assert.equal(plugin.classifyPage({ url: f.location.href, redditEditorFocused: true, redditMessageEditorFocused: true }), 'neutral', path);
  }
});

test('Reddit own profiles and their aliases remain neutral until writing; unrelated profiles consume', () => {
  const f = fixture('comment', 'https://www.reddit.com/user/Synthetic/comments/');
  const link = f.body.append(new Element(['a[data-testid="profile-link"]'])); link.href = 'https://www.reddit.com/user/synthetic/';
  assert.equal(f.adapter.mode(), 'neutral');
  f.location.href = 'https://www.reddit.com/u/SYNTHETIC/'; assert.equal(f.adapter.mode(), 'neutral');
  f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
  f.document.activeElement = f.body; f.location.href = 'https://www.reddit.com/user/another/'; assert.equal(f.adapter.mode(), 'consume');
  for (const path of ['/user/me/', '/u/me/comments/']) { f.location.href = 'https://www.reddit.com' + path; assert.equal(f.adapter.mode(), 'neutral'); }
});

test('Reddit post routes create only with a focused scoped editor, not just an open composer', () => {
  for (const path of ['/submit/', '/r/synthetic/submit/']) {
    const f = fixture('post', 'https://www.reddit.com' + path);
    assert.equal(f.adapter.mode(), 'neutral');
    f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
    assert.deepEqual(f.adapter.action(click(f.button)), { button: f.button, action: 'posts', submission: true });
    f.document.activeElement = f.button; assert.equal(f.adapter.mode(), 'neutral');
    f.scope.selectors.clear(); f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'neutral');
    assert.equal(f.adapter.action(click(f.button)), null);
  }
});

test('Reddit focused comments take precedence on threads, feeds and profiles, including light-DOM composers', () => {
  for (const path of ['/', '/r/synthetic/', '/r/synthetic/comments/abc123/title/', '/user/synthetic/']) {
    const f = fixture('comment', 'https://www.reddit.com' + path);
    assert.equal(f.adapter.mode(), 'consume');
    f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
    f.scope.selectors = new Set(['shreddit-composer']); f.editor.selectors = new Set(['[contenteditable="true"][role="textbox"]']);
    f.document.activeElement = f.editor.append(new Element()); assert.equal(f.adapter.mode(), 'create');
    assert.equal(f.adapter.action(click(f.button)).action, 'comments');
    f.scope.selectors.clear(); assert.equal(f.adapter.mode(), 'consume'); assert.equal(f.adapter.action(click(f.button)), null);
  }
});

test('Reddit hidden, disabled, disconnected and read-only editors neither create nor submit', () => {
  const f = fixture(); f.document.activeElement = f.editor;
  for (const apply of [
    () => { f.editor.style.display = 'none'; },
    () => { f.editor.style.visibility = 'hidden'; },
    () => { f.scope.attributes['aria-hidden'] = 'true'; },
    () => { f.editor.disabled = true; },
    () => { f.editor.readOnly = true; },
    () => { f.editor.attributes.readonly = ''; },
    () => { f.editor.isConnected = false; }
  ]) {
    apply(); assert.equal(f.adapter.mode(), 'consume'); assert.equal(f.adapter.action(click(f.button)), null);
    f.editor.style = {}; f.scope.attributes = {}; f.editor.attributes = {}; f.editor.disabled = false; f.editor.readOnly = false; f.editor.isConnected = true;
  }
  f.editor.selectors = new Set(['[contenteditable="false"][role="textbox"]']); assert.equal(f.adapter.mode(), 'consume'); assert.equal(f.adapter.action(click(f.button)), null);
});

test('Reddit rejects read-only, disabled and inert editors, composers and ancestors', () => {
  const states = [['property', 'readOnly', true], ['attribute', 'readonly', ''], ['attribute', 'aria-readonly', 'true'], ['property', 'disabled', true], ['attribute', 'disabled', ''], ['attribute', 'aria-disabled', 'true'], ['property', 'inert', true], ['attribute', 'inert', '']];
  for (const kind of ['post', 'comment', 'message']) for (const target of ['editor', 'scope', 'ancestor']) for (const [type, name, value] of states) {
    const f = fixture(kind, kind === 'message' ? 'https://www.reddit.com/message/compose/' : kind === 'post' ? 'https://www.reddit.com/submit/' : undefined);
    const ancestor = f.body.append(new Element()); ancestor.append(f.scope);
    const node = target === 'ancestor' ? ancestor : f[target];
    if (type === 'property') node[name] = value; else node.attributes[name] = value;
    f.document.activeElement = f.editor;
    const label = `${kind} ${target} ${name}`;
    assert.equal(f.adapter.mode(), kind === 'comment' ? 'consume' : 'neutral', label);
    assert.equal(f.adapter.action(click(f.button)), null, label);
  }
});

test('Reddit actions require scoped positive post/comment submits, not open, edit, vote or reversing controls', () => {
  for (const kind of ['post', 'comment']) {
    const f = fixture(kind, kind === 'post' ? 'https://www.reddit.com/submit/' : undefined);
    const child = f.button.append(new Element());
    assert.equal(f.adapter.action(click(child)).button, f.button);
    for (const text of ['Create post', 'Add a comment', 'Save', 'Edit', 'Cancel', 'Delete', 'Send', 'Upvote', 'Downvote', 'Remove upvote', 'Share', 'Award', 'Unsave']) {
      f.button.textContent = text; assert.equal(f.adapter.action(click(f.button)), null, text);
    }
    f.button.textContent = kind === 'post' ? 'Submit' : 'Reply'; assert.equal(f.adapter.action(click(f.button)).submission, true);
    f.button.disabled = true; assert.equal(f.adapter.action(click(f.button)), null); f.button.disabled = false;
    f.button.attributes['aria-disabled'] = 'true'; assert.equal(f.adapter.action(click(f.button)), null); delete f.button.attributes['aria-disabled'];
    f.button.style.display = 'none'; assert.equal(f.adapter.action(click(f.button)), null); delete f.button.style.display;
    assert.equal(f.adapter.action(click(f.body.append(new Element(['button'], 'Post')))), null);
  }
});

test('Reddit submission lookup does not borrow an editor from a different or nested composer', () => {
  const f = fixture();
  f.editor.isConnected = false;
  const other = f.body.append(new Element(['form[action="/api/comment"]']));
  other.append(new Element(['textarea[name="text"]']));
  assert.equal(f.adapter.action(click(f.button)), null);
  f.editor.isConnected = true;
  const nested = f.scope.append(new Element(['shreddit-composer']));
  nested.append(f.button);
  assert.equal(f.adapter.action(click(f.button)), null);
});

test('Reddit rejects unverified editor shortcuts, newlines, IME and repeats; native button clicks still submit', () => {
  const f = fixture();
  for (const extra of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { key: ' ' }]) {
    assert.equal(f.adapter.action(key(f.editor, extra)), null);
    assert.equal(f.adapter.action(key(f.button, extra)), null);
  }
  assert.equal(f.adapter.action({ type: 'input', target: f.editor }), null);
  assert.equal(f.adapter.action(click(f.button)).action, 'comments');
});

test('Reddit DM composing is scoped to its compose form and earns no submission bonus', () => {
  const f = fixture('message', 'https://www.reddit.com/message/compose/');
  assert.equal(f.adapter.mode(), 'neutral');
  f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
  assert.equal(f.adapter.action(click(f.button)), null); assert.equal(f.adapter.action(key(f.editor, { ctrlKey: true })), null);
  f.scope.selectors.clear(); assert.equal(f.adapter.mode(), 'neutral');
  f.location.href = 'https://www.reddit.com/message/inbox/'; assert.equal(f.adapter.mode(), 'neutral');
});

for (const browser of ['chrome', 'browser']) {
  test(`Reddit actual adapter uses shared ${browser} trusted wheel/touch tracking and opt-in lifecycle`, async () => {
    let f;
    const snapshot = trackedSites => ({ day: {}, settings: { trackedSites } });
    const t = await tracker(browser, { integration: plugin, fixture({ url, listen }) { f = populate(environment(url, listen)); return f; }, url: 'https://www.reddit.com/r/synthetic/comments/abc123/title/', snapshot: snapshot([]) });
    assert.equal(t.wheel(100).defaultPrevented, false); t.setNow(5000); await t.tick(); assert.equal(t.packets.length, 0);
    t.setSnapshot(snapshot(['reddit'])); await t.tick();
    t.event('touchstart', { isTrusted: false }); t.setNow(10000); await t.tick(); assert.equal(t.packets.length, 0);
    assert.equal(t.wheel(100).defaultPrevented, true); assert.equal(t.document.scrollingElement.scrollTop, 1050);
    t.setNow(15000); await t.tick(); assert.equal(seconds(t, 'consume'), 5);
    f.document.activeElement = f.editor; t.event('focusin', {}); t.event('touchstart', { isTrusted: true });
    assert.equal(t.wheel(100).defaultPrevented, false);
    t.setNow(20000); await t.tick(); assert.equal(seconds(t, 'create'), 5);
    t.event('click', { ...click(f.button), isTrusted: true }); t.event('click', { ...click(f.button), isTrusted: true }); await t.tick();
    assert.deepEqual(t.packets.flatMap(p => p.actions).map(a => a.action), ['comments']);
    t.setSnapshot(snapshot([])); await t.tick(); const count = t.packets.length;
    assert.equal(t.wheel(100).defaultPrevented, false);
    t.event('touchstart', { isTrusted: true }); t.event('click', { ...click(f.button), isTrusted: true }); t.setNow(25000); await t.tick(); assert.equal(t.packets.length, count);
    assert.deepEqual(t.warnings, []);
  });
}
