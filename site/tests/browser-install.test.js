'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0';

function render(navigator) {
  const groups = Array.from({ length: 2 }, () => {
    const links = ['chrome', 'firefox'].map(browser => ({
      dataset: { browser },
      hidden: false
    }));
    return {
      links,
      querySelectorAll() { return this.links; }
    };
  });
  const notes = Array.from({ length: 2 }, () => ({ hidden: true, textContent: '' }));
  const instructions = ['chrome', 'firefox'].map(browser => ({ dataset: { installBrowser: browser }, open: browser === 'chrome' }));
  const document = {
    querySelectorAll(selector) {
      return { '[data-install-actions]': groups, '[data-browser-note]': notes,
        '[data-install-browser]': instructions }[selector];
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../browser-install.js'), 'utf8'), { navigator, document });
  return { groups, notes, instructions };
}

for (const [browser, navigator] of [
  ['firefox', { userAgent: firefox }],
  ['chrome', { userAgent: chrome }],
  ['chrome', { userAgent: chrome, userAgentData: { brands: [{ brand: 'Google Chrome' }], mobile: false } }]
]) {
  test(`desktop ${browser} shows only its install button and matching instructions`, () => {
    const page = render(navigator);
    for (const group of page.groups) {
      assert.deepEqual(group.links.filter(link => !link.hidden).map(link => link.dataset.browser), [browser]);
    }
    for (const note of page.notes) {
      assert.equal(note.hidden, false);
      assert.match(note.textContent, new RegExp(browser, 'i'));
    }
    assert.deepEqual(page.instructions.filter(item => item.open).map(item => item.dataset.installBrowser), [browser]);
  });
}

for (const [name, navigator] of [
  ['unknown', {}],
  ['Safari', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' }],
  ['Edge', { userAgent: `${chrome} Edg/150.0.0.0` }],
  ['Opera', { userAgent: `${chrome} OPR/120.0.0.0` }],
  ['Vivaldi', { userAgent: `${chrome} Vivaldi/7.0` }],
  ['Brave', { userAgent: chrome, brave: {} }],
  ['other Chromium brand', { userAgent: chrome, userAgentData: { brands: [{ brand: 'Chromium' }] } }],
  ['Android Firefox', { userAgent: firefox.replace('X11; Linux x86_64', 'Android 14; Mobile') }],
  ['Android Chrome', { userAgent: chrome.replace('X11; Linux x86_64', 'Linux; Android 14; Mobile') }],
  ['iOS Firefox', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 FxiOS/150.0 Mobile/15E148 Safari/605.1.15' }],
  ['iPad desktop mode', { userAgent: chrome, platform: 'MacIntel', maxTouchPoints: 5 }],
  ['mobile client hints', { userAgent: chrome, userAgentData: { mobile: true, brands: [{ brand: 'Google Chrome' }] } }]
]) {
  test(`${name} keeps neutral choices without recommending a store`, () => {
    const page = render(navigator);
    for (const group of page.groups) {
      assert.deepEqual(group.links.map(link => link.dataset.browser), ['chrome', 'firefox']);
      assert.ok(group.links.every(link => !link.hidden));
    }
    assert.ok(page.notes.every(note => note.hidden));
  });
}
