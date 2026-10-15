'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildSite } = require('../build.js');

const listing = 'https://chromewebstore.google.com/detail/kopbjmlmjpnkekffalpbjfhmbhgbgamk';

function verifyInstallation(html) {
  const hero = html.split('<section class="hero"')[1].split('</section>')[0];
  const install = html.split('<section class="install"')[1].split('</section>')[0];
  for (const section of [hero, install]) {
    const button = section.match(/<a class="button" href="([^"]+)">([^<]+)<\/a>/);
    assert.ok(button, 'installation has a plain link that works without JavaScript');
    assert.equal(button[1], listing);
    assert.equal(button[2], 'Add to Chrome');
  }
  assert.match(hero, /href="#install">Other browsers &amp; source<\/a>/);
  assert.match(install, /Save (?:any |your )?X and LinkedIn drafts before installing/);
  assert.match(install, /<details>\s*<summary>Build from source/);
  assert.match(install, /https:\/\/github\.com\/WebCu\/createratio\.git/);
  for (const bundle of ['dist/chrome', 'dist/edge', 'dist/firefox/manifest.json']) {
    assert.ok(install.includes(bundle), bundle);
  }
  assert.match(install, /Firefox.*removed when Firefox restarts/s);
  assert.match(install, /Edge and Firefox.*not store releases/s);
  assert.doesNotMatch(html, /For now, install from source|Install from source<\/a>/);
}

test('the source and built landing page offer the published Chrome listing with source alternatives', t => {
  verifyInstallation(fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-install-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  buildSite(output);
  verifyInstallation(fs.readFileSync(path.join(output, 'index.html'), 'utf8'));
});
