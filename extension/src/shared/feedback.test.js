'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const extension = resolve(__dirname, '..');

async function feedback({ installType = 'normal', id = 'a'.repeat(32), failure = false, store = 'chrome' } = {}) {
  const attributes = new Map([['aria-disabled', 'true'], ['tabindex', '-1']]);
  const link = { dataset: { store }, removeAttribute: key => attributes.delete(key) };
  const note = { textContent: 'Available in the Chrome Web Store version.' };
  let getSelfCalls = 0;
  const context = vm.createContext({
    document: { getElementById: key => key === 'feedback' ? link : note },
    chrome: {
      runtime: { id },
      management: { getSelf: async () => {
        getSelfCalls++;
        if (failure) throw new Error('Unavailable');
        return { installType };
      } },
    },
  });
  await vm.runInContext(readFileSync(resolve(__dirname, 'feedback.js'), 'utf8'), context);
  return { link, note, attributes, getSelfCalls };
}

test('published installations open their own store reviews without sharing local activity', async () => {
  const { link, note, attributes, getSelfCalls } = await feedback();
  const url = new URL(link.href);
  assert.equal(url.origin, 'https://chromewebstore.google.com');
  assert.equal(url.pathname, `/detail/${'a'.repeat(32)}/reviews`);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.ok(!attributes.has('aria-disabled'));
  assert.ok(!attributes.has('tabindex'));
  assert.match(note.textContent, /public.*No activity data attached/);
  assert.equal(getSelfCalls, 1);
});

test('unpacked builds keep feedback unavailable and identify the store version', async () => {
  const { link, note, attributes } = await feedback({ installType: 'development' });
  assert.equal(link.href, undefined);
  assert.equal(attributes.get('aria-disabled'), 'true');
  assert.equal(attributes.get('tabindex'), '-1');
  assert.match(note.textContent, /Available in the Chrome Web Store version/);
});

test('other browser builds never navigate to a Chrome listing', async () => {
  for (const store of ['edge', 'firefox', undefined]) {
    const { link, note, attributes, getSelfCalls } = await feedback({ store: store || 'unknown' });
    assert.equal(link.href, undefined);
    assert.equal(attributes.get('aria-disabled'), 'true');
    assert.match(note.textContent, /not configured for this browser/);
    assert.equal(getSelfCalls, 0);
  }
});

test('store lookup failure or an invalid extension ID never produces an unsafe link', async () => {
  for (const options of [{ failure: true }, { id: '' }, { id: '../evil' }, { id: 'q'.repeat(32) }]) {
    const { link, attributes } = await feedback(options);
    assert.equal(link.href, undefined);
    assert.equal(attributes.get('aria-disabled'), 'true');
  }
  assert.match((await feedback({ failure: true })).note.textContent, /unavailable/);
});

test('feedback is isolated from activity loading and needs no feedback-specific permissions or GitHub form', () => {
  const html = readFileSync(resolve(extension, 'pages/settings/settings.html'), 'utf8');
  const anchor = html.match(/<a\b[^>]*id="feedback"[^>]*>[\s\S]*?<\/a>/)[0];
  assert.match(anchor, /target="_blank"/);
  assert.match(anchor, /rel="noopener noreferrer"/);
  assert.match(anchor, /aria-describedby="feedback-privacy"/);
  assert.ok(!anchor.includes('href='), 'no placeholder or direct GitHub URL');
  assert.match(html, /<script src="feedback.js"><\/script>/);
  assert.match(html, /id="feedback-privacy">Available in the Chrome Web Store version\.<\/p>/);
  const manifest = JSON.parse(readFileSync(resolve(extension, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'declarativeNetRequestWithHostAccess']);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
  assert.ok(!existsSync(resolve(extension, '../.github/ISSUE_TEMPLATE/feedback.yml')));
});
