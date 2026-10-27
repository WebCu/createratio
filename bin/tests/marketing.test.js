'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRelease, syncWebsite, assertWebsiteCurrent, writeKit, releaseFingerprint } = require('../marketing.js');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-marketing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a release change updates both static website announcements and produces matching copy', t => {
  const output = temporary(t);
  const original = readRelease();
  assert.doesNotThrow(() => assertWebsiteCurrent(html, original));
  const release = { ...original, headline: 'A new <feature> & more.', summary: 'New summary with $& and <unsafe> text.', activation: 'Enable it in Settings.' };
  assert.throws(() => assertWebsiteCurrent(html, release), /marketing:copy/);
  const updated = syncWebsite(html, release);
  assert.doesNotThrow(() => assertWebsiteCurrent(updated, release));
  assert.equal(syncWebsite(updated, release), updated);
  assert.match(updated, /A new &lt;feature&gt; &amp; more\./);
  assert.match(updated, /New summary with \$&amp; and &lt;unsafe&gt; text\./);
  assert.equal(updated.split('A new &lt;feature&gt; &amp; more.').length - 1, 2);
  assert.equal(updated.slice(updated.indexOf('<section class="hero"')), html.slice(html.indexOf('<section class="hero"')));
  fs.mkdirSync(path.join(output, 'screenshots'));
  fs.writeFileSync(path.join(output, 'screenshots/stale.png'), 'old capture');
  writeKit(output, release);
  assert.equal(fs.existsSync(path.join(output, 'screenshots')), false, 'new copy invalidates old screenshots');
  assert.equal(fs.readFileSync(path.join(output, 'social-post.txt'), 'utf8').trim(), release.socialPost);
  assert.equal(fs.readFileSync(path.join(output, 'store-description.txt'), 'utf8').trim(), release.description.join('\n\n'));
  assert.equal(fs.readFileSync(path.join(output, 'release-notes.txt'), 'utf8').trim(), [release.headline, release.summary, release.activation].join('\n\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'screenshots.json'), 'utf8')), release.screenshots);
  assert.notEqual(releaseFingerprint(original), releaseFingerprint(release));
});

test('missing or duplicate website slots stop synchronization instead of dropping an announcement', () => {
  const release = readRelease();
  assert.throws(() => syncWebsite('<main>No announcement</main>', release), /exactly one/);
  assert.throws(() => syncWebsite(html + html, release), /exactly one/);
});

test('invalid copy and unsafe screenshot names fail before generation', t => {
  const directory = temporary(t);
  const filename = path.join(directory, 'release.json');
  const release = readRelease();
  for (const invalid of [
    { ...release, headline: '' },
    { ...release, shortDescription: 'x'.repeat(133) },
    { ...release, description: [''] },
    { ...release, screenshots: [{ id: '../escape', caption: 'Unsafe filename' }] }
  ]) {
    fs.writeFileSync(filename, JSON.stringify(invalid));
    assert.throws(() => readRelease(filename));
  }
  fs.writeFileSync(filename, JSON.stringify(release));
  assert.deepEqual(readRelease(filename), release);
});
