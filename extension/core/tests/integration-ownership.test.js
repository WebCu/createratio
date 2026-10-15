'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const path = require('node:path');
const Sites = require('../../sites/index.js');

const extension = path.resolve(__dirname, '../..');
const domains = [...new Set(Sites.sites.flatMap(site => [
  ...site.hosts,
  ...(Sites.get(site.id).access?.domains || []),
]))];

function domainLeaks(source, ownedDomains) {
  return ownedDomains.filter(domain => source.includes(domain));
}

function sharedSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return ['sites', 'tests', 'node_modules'].includes(entry.name) ? [] : sharedSources(file);
    return /\.(js|html|css|json|svg)$/.test(entry.name) && !/\.test\.js$/.test(entry.name) ? [file] : [];
  });
}

test('registered integration domains stay out of shared runtime assets and build sources', () => {
  const files = sharedSources(extension);
  assert.ok(domains.length > 0);
  for (const file of files) {
    assert.deepEqual(domainLeaks(readFileSync(file, 'utf8'), domains), [], path.relative(extension, file));
  }
});

test('ownership detection catches exact hosts, root domains, and embedded URLs', () => {
  const owned = ['example.invalid', 'legacy.invalid'];
  for (const source of ['"example.invalid"', '"www.example.invalid"', '"https://example.invalid/home"']) {
    assert.deepEqual(domainLeaks(source, owned), ['example.invalid']);
  }
  assert.deepEqual(domainLeaks('Sites.forAccessURL(url)', owned), []);
  assert.deepEqual(domainLeaks('"https://legacy.invalid/home"', owned), ['legacy.invalid']);
});

test('source manifest leaves integration permissions and matches to the build', () => {
  const manifest = JSON.parse(readFileSync(path.join(extension, 'src/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, []);
  for (const script of manifest.content_scripts) assert.deepEqual(script.matches, []);
  for (const resource of manifest.web_accessible_resources) assert.deepEqual(resource.matches, []);
  assert.equal(existsSync(path.join(extension, 'src/block-rules.json')), false);
});
