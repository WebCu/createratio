'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('./linkedin.js');
const { Element, linkedinFixture, key, click } = require('./test-support.js');
const submit = (fixture, target = fixture.editor) => fixture.adapter.action(key(target));

test('LinkedIn owns its default activation, access home, blocking root, and stable rule IDs', () => {
  assert.equal(plugin.defaultEnabled, true);
  assert.deepEqual(plugin.hosts, ['linkedin.com', 'www.linkedin.com']);
  assert.deepEqual(plugin.access.domains, ['linkedin.com']);
  assert.equal(plugin.access.home, 'https://www.linkedin.com/feed/');
  assert.equal(plugin.access.redirectRuleId, 2);
  assert.deepEqual(plugin.access.ruleIds, [102, 103]);
});

test('LinkedIn access rules allow free browsing when off and only same-site frames during a session', () => {
  const domains = ['linkedin.com'];
  assert.deepEqual(plugin.access.unrestrictedRules, [
    { id: 102, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, resourceTypes: ['main_frame'] } },
    { id: 103, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['main_frame'] } }
  ]);
  assert.deepEqual(plugin.access.sessionRules, [
    { id: 102, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['sub_frame'] } },
    { id: 103, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, initiatorDomains: domains, resourceTypes: ['sub_frame'] } }
  ]);
});

test('keyboard comment lookup finds the editor’s enabled submit button, including nested targets', () => {
  const f = linkedinFixture(), child = f.editor.append(new Element()), result = submit(f, child);
  assert.equal(result.action, 'comments'); assert.equal(result.editor, f.editor); assert.equal(result.button, f.button);
});
test('keyboard comment lookup excludes disabled, hidden and unrelated controls', () => {
  const f = linkedinFixture(); f.button.disabled = true; assert.equal(submit(f), null);
  f.button.disabled = false; f.button.attributes['aria-disabled'] = 'true'; assert.equal(submit(f), null);
  delete f.button.attributes['aria-disabled']; f.button.isConnected = false; assert.equal(submit(f), null);
  f.button.isConnected = true; f.button.selectors.delete('.comments-comment-box__submit-button'); f.button.textContent = 'Cancel'; assert.equal(submit(f), null);
  f.button.textContent = 'Reply'; assert.equal(submit(f).action, 'comments');
  assert.equal(submit(f, f.button), null); assert.equal(submit(f, f.body), null);
});
test('keyboard lookup never counts an Enter in a LinkedIn post composer or another comment box', () => {
  const f = linkedinFixture(); f.button.isConnected = false;
  const other = f.body.append(new Element(['.comments-comment-box'])); other.append(new Element(['button', '.comments-comment-box__submit-button'], 'Comment'));
  assert.equal(submit(f), null);
  f.button.isConnected = true; f.scope.selectors = new Set(['.share-creation-state']); assert.equal(submit(f), null);
});
test('LinkedIn adapter scopes post clicks and supports translated submit labels', () => {
  const f = linkedinFixture(); f.scope.selectors = new Set(['.share-creation-state']);
  assert.equal(f.adapter.action(click(f.button)), null);
  f.button.textContent = 'Publicar';
  assert.equal(f.adapter.action(click(f.button)).action, 'posts');
  assert.equal(submit(f), null, 'post keyboard shortcuts are unsupported');
  f.scope.selectors = new Set(['.comments-comment-box']); f.button.textContent = 'Comentar';
  assert.equal(f.adapter.action(click(f.button)).action, 'comments');
});
test('LinkedIn adapter owns editor precedence, own profiles, and neutral routes', () => {
  const f = linkedinFixture(); assert.equal(f.adapter.mode(), 'consume');
  f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
  f.document.activeElement = f.body;
  const own = f.body.append(new Element(['a.global-nav__me-view-profile-link'])); own.href = 'https://www.linkedin.com/in/me/';
  f.location.href = 'https://www.linkedin.com/in/me/details/'; assert.equal(f.adapter.mode(), 'neutral');
  f.location.href = 'https://www.linkedin.com/in/another/'; assert.equal(f.adapter.mode(), 'consume');
  for (const path of ['/messaging/', '/jobs/', '/notifications/']) {
    f.location.href = 'https://www.linkedin.com' + path; assert.equal(f.adapter.mode(), 'neutral');
  }
});
test('focused direct-message editors create on messaging routes and in feed or profile overlays', () => {
  for (const path of ['/messaging/', '/messaging/thread/synthetic-thread/', '/feed/', '/in/another/']) {
    const f = linkedinFixture({ url: 'https://www.linkedin.com' + path, message: true });
    const reading = path.startsWith('/messaging/') ? 'neutral' : 'consume';
    assert.equal(f.adapter.mode(), reading);
    f.document.activeElement = f.editor;
    assert.equal(f.adapter.mode(), 'create', path);
    f.document.activeElement = f.editor.append(new Element());
    assert.equal(f.adapter.mode(), 'create', 'nested message editor focus');
    f.document.activeElement = f.button;
    assert.equal(f.adapter.mode(), reading, 'the send button is not a writing editor');
    assert.equal(f.adapter.action(click(f.button)), null);
    assert.equal(submit(f), null, 'sending a DM is not a post or comment');
  }
});
test('message selectors require editable, visible, focused message fields', () => {
  const f = linkedinFixture({ url: 'https://www.linkedin.com/messaging/thread/synthetic-thread/', message: true });
  f.document.activeElement = f.editor;
  for (const selector of ['.msg-form__contenteditable[contenteditable="true"]', '.msg-form [contenteditable="true"]']) {
    f.editor.selectors = new Set([selector]);
    assert.equal(f.adapter.mode(), 'create', selector);
  }
  f.editor.style.display = 'none'; assert.equal(f.adapter.mode(), 'neutral');
  f.editor.style.display = 'block'; f.editor.style.visibility = 'hidden'; assert.equal(f.adapter.mode(), 'neutral');
  f.editor.style.visibility = 'visible'; f.editor.isConnected = false; assert.equal(f.adapter.mode(), 'neutral');
  f.editor.isConnected = true; f.editor.selectors = new Set(['.msg-form__contenteditable', '[contenteditable="false"]']);
  assert.equal(f.adapter.mode(), 'neutral', 'read-only message field');
  f.editor.selectors = new Set(['[role="textbox"][contenteditable="true"]']);
  assert.equal(f.adapter.mode(), 'neutral', 'unrelated editable textbox');
});
test('LinkedIn adapter recognizes positive light labels without counting undo interactions', () => {
  const f = linkedinFixture();
  for (const [text, action] of [['Save', 'bookmarks'], ['Guardar', 'bookmarks'], ['Repost', 'reposts'], ['Republicar', 'reposts']]) {
    const result = f.adapter.action(click(new Element(['[role="menuitem"]'], text)));
    assert.equal(result.action, action); assert.equal(result.submission, false);
  }
  for (const text of ['Unsave', 'Unlike', 'Undo repost']) assert.equal(f.adapter.action(click(new Element(['[role="menuitem"]'], text))), null);
});
test('LinkedIn plugin classification rejects other hosts even with a creating editor', () => {
  for (const url of ['invalid', 'http://linkedin.com/feed', 'https://x.com/home', 'https://linkedin.com.evil.test/feed']) assert.equal(plugin.classifyPage({ url, linkedinEditorFocused: true }), 'neutral');
});
