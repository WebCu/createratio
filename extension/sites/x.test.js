'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('./x.js');
const { Element, xFixture, key, click } = require('./test-support.js');
const submit = (fixture, target = fixture.editor) => fixture.adapter.action(key(target, { ctrlKey: true }));

test('X owns its default activation, access home, aliases, and stable rule IDs', () => {
  assert.equal(plugin.defaultEnabled, true);
  assert.deepEqual(plugin.hosts, ['x.com', 'www.x.com']);
  assert.deepEqual(plugin.access.domains, ['x.com', 'twitter.com']);
  assert.equal(plugin.access.home, 'https://x.com/home');
  assert.equal(plugin.access.redirectRuleId, 1);
  assert.deepEqual(plugin.access.ruleIds, [101, 104]);
});

test('X access rules allow free browsing when off but never unlock embedded frames during a session', () => {
  const domains = ['x.com', 'twitter.com'];
  assert.deepEqual(plugin.access.unrestrictedRules, [
    { id: 101, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, resourceTypes: ['main_frame'] } },
    { id: 104, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['main_frame'] } }
  ]);
  assert.deepEqual(plugin.access.sessionRules, [
    { id: 101, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['sub_frame'] } }
  ]);
});

test('X keyboard lookup reuses click classification for posts, replies, quotes and intent', () => {
  const f = xFixture({ dialog: true });
  assert.equal(submit(f).action, 'posts');
  f.adapter.action(click(new Element(['[data-testid="reply"]'])));
  assert.equal(submit(f).action, 'replies');
  f.adapter.action(click(new Element(['[role="menuitem"][aria-label="Quote"]'])));
  assert.equal(submit(f).action, 'quotes');
  assert.equal(submit(f).action, 'posts', 'submission clears intent');
  f.scope.append(new Element(['[data-testid="replyingTo"]']));
  assert.equal(submit(f).action, 'replies');
  f.scope.append(new Element(['[data-testid="quoteTweetPreview"]']));
  assert.equal(submit(f).action, 'quotes');
  assert.equal(submit(xFixture({ url: 'https://x.com/someone/status/123' })).action, 'replies');
});
test('X keyboard lookup does not treat a referenced tweet above the editor as a quote', () => {
  const f = xFixture({ dialog: true });
  const reference = f.scope.append(new Element(['[data-testid="tweet"]']));
  f.scope.children = [reference, f.editor, f.button]; f.button.textContent = 'Reply';
  assert.equal(submit(f).action, 'replies');
});
test('X keyboard lookup supports nested targets and the smallest common composer fallback', () => {
  const f = xFixture(); f.scope.selectors.clear();
  const child = f.editor.append(new Element()), result = submit(f, child);
  assert.equal(result.button, f.button); assert.equal(result.editor, f.editor); assert.equal(result.action, 'posts');
});
test('X keyboard lookup excludes disabled, hidden, missing and unrelated submit buttons', () => {
  const f = xFixture(); f.button.disabled = true;
  assert.equal(submit(f), null);
  f.button.disabled = false; f.button.attributes['aria-disabled'] = 'true'; assert.equal(submit(f), null);
  delete f.button.attributes['aria-disabled']; f.button.isConnected = false; assert.equal(submit(f), null);
  f.button.isConnected = true; assert.equal(submit(f, f.button), null); assert.equal(submit(f, f.body), null);
});
test('X adapter owns editor precedence, neutral pages, own profiles, and composer lifecycle', () => {
  const f = xFixture();
  assert.equal(f.adapter.mode(), 'consume', 'blank unfocused home composer is not creating');
  f.document.activeElement = f.editor; assert.equal(f.adapter.mode(), 'create');
  f.adapter.action(click(new Element(['[role="menuitem"][aria-label="Quote"]'])));
  f.document.activeElement = f.body; assert.equal(f.adapter.mode(), 'consume');
  assert.equal(submit(f).action, 'posts', 'closing the composer clears intent');
  const own = f.body.append(new Element(['a[data-testid="AppTabBar_Profile_Link"]'])); own.href = 'https://x.com/me';
  f.location.href = 'https://x.com/ME/media'; f.location.pathname = '/ME/media'; assert.equal(f.adapter.mode(), 'neutral');
  f.location.href = 'https://x.com/me/status/1'; f.location.pathname = '/me/status/1'; assert.equal(f.adapter.mode(), 'create', 'inline status reply takes precedence');
  f.scope.children = []; assert.equal(f.adapter.mode(), 'consume');
  for (const path of ['/messages', '/settings/profile', '/notifications', '/i/bookmarks']) {
    f.location.href = 'https://x.com' + path; f.location.pathname = path; assert.equal(f.adapter.mode(), 'neutral');
  }
});
test('X adapter counts only positive light actions and final repost confirmations', () => {
  const f = xFixture();
  for (const [selector, action] of [['[data-testid="like"]', 'likes'], ['[data-testid="bookmark"]', 'bookmarks'], ['[data-testid="retweetConfirm"]', 'reposts']]) {
    const result = f.adapter.action(click(new Element([selector])));
    assert.equal(result.action, action); assert.equal(result.submission, false);
  }
  for (const selector of ['[data-testid="unlike"]', '[data-testid="removeBookmark"]', '[data-testid="retweet"]']) assert.equal(f.adapter.action(click(new Element([selector]))), null);
});
test('X plugin classification rejects other hosts even with a creating editor', () => {
  for (const url of ['invalid', 'http://x.com/home', 'https://linkedin.com/feed/', 'https://x.com.evil.test/home']) assert.equal(plugin.classifyPage({ url, xComposerOpen: true }), 'neutral');
});
test('X per-page intent never leaks into another adapter', () => {
  const first = xFixture(), second = xFixture();
  first.adapter.action(click(new Element(['[role="menuitem"][aria-label="Quote"]'])));
  assert.equal(submit(second).action, 'posts'); assert.equal(submit(first).action, 'quotes');
});
