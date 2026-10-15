'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const integrations = require('./index.js');
const source = fs.readFileSync(require.resolve('./index.js'), 'utf8');
function browserCatalog(modules) {
  const context = vm.createContext({ URL, C3_SITE_MODULES: modules });
  vm.runInContext(source, context); return context.C3Sites;
}
function modules() { return { x: require('./x.js'), linkedin: require('./linkedin.js') }; }

test('explicit catalog works in Node and browser worlds without reading the DOM', () => {
  const catalog = browserCatalog(modules());
  for (const site of integrations.sites) {
    assert.equal(catalog.get(site.id).name, site.name);
    assert.equal(catalog.forURL('https://' + site.hosts[0] + '/').id, site.id);
    assert.equal(catalog.forURL('http://' + site.hosts[0] + '/'), null);
  }
  assert.equal(catalog.get('constructor'), null);
  assert.equal(catalog.forURL('invalid'), null);
});
test('catalog exposes gate capability and default activation from module declarations', () => {
  const x = { ...modules().x, defaultEnabled: false, access: undefined };
  const catalog = browserCatalog({ ...modules(), x });
  assert.equal(catalog.sites.find(site => site.id === 'x').gated, false);
  assert.equal(catalog.sites.find(site => site.id === 'x').defaultEnabled, false);
  assert.equal(catalog.sites.find(site => site.id === 'linkedin').gated, true);
  assert.equal(catalog.sites.find(site => site.id === 'linkedin').defaultEnabled, true);
  assert.equal(catalog.forAccessURL('https://x.com/home'), null);
});

test('access lookup covers HTTP, aliases and subdomains without treating unknown hosts as a site', () => {
  const catalog = browserCatalog(modules());
  for (const raw of ['http://x.com/home', 'https://mobile.twitter.com/home', 'https://www.x.com/home']) assert.equal(catalog.forAccessURL(raw)?.id, 'x');
  assert.equal(catalog.forAccessURL('http://www.linkedin.com/feed/')?.id, 'linkedin');
  for (const raw of ['https://x.com.evil.test/', 'https://notlinkedin.com/', 'ftp://x.com/', 'invalid', 'https://example.test/']) assert.equal(catalog.forAccessURL(raw), null);
  assert.equal(catalog.forURL('https://twitter.com/home'), null);
});

test('access lookup follows a module whose domains differ from the original website', () => {
  const linkedin = { ...modules().linkedin, hosts: ['example.test'], access: { ...modules().linkedin.access, domains: ['example.test', 'alias.test'], home: 'https://example.test/feed/' } };
  const catalog = browserCatalog({ ...modules(), linkedin });
  assert.equal(catalog.forAccessURL('http://mobile.alias.test/').id, 'linkedin');
  assert.equal(catalog.forAccessURL('https://linkedin.com/feed/'), null);
});

test('an unregistered module cannot enter the vetted catalog', () => {
  const catalog = browserCatalog({ ...modules(), draft: { id: 'draft', name: 'Draft', hosts: ['draft.test'] } });
  assert.equal(catalog.get('draft'), null); assert.equal(catalog.forURL('https://draft.test/'), null);
});
test('access rule IDs respect browser integer limits and reserve an ID for the shared blocking rule', () => {
  const maximumRuleId = 2 ** 31 - 1;
  function configuredAccess(redirectRuleId, resourceId) {
    const access = modules().linkedin.access;
    const remap = rule => ({ ...rule, id: rule.id === 103 ? resourceId : rule.id });
    return { ...access, redirectRuleId, ruleIds: [102, resourceId], unrestrictedRules: access.unrestrictedRules.map(remap), sessionRules: access.sessionRules.map(remap) };
  }
  for (const access of [configuredAccess(2, 1), configuredAccess(maximumRuleId - 1, maximumRuleId)]) {
    const catalog = browserCatalog({ ...modules(), linkedin: { ...modules().linkedin, access } });
    assert.equal(catalog.get('linkedin').access.redirectRuleId, access.redirectRuleId);
  }
  for (const redirectRuleId of [0, -1, 1.5, '2', maximumRuleId, maximumRuleId + 1]) {
    const access = configuredAccess(redirectRuleId, 103);
    assert.throws(() => browserCatalog({ ...modules(), linkedin: { ...modules().linkedin, access } }), /access/i);
  }
  for (const resourceId of [0, -1, 1.5, '103', maximumRuleId + 1]) {
    const access = configuredAccess(2, resourceId);
    assert.throws(() => browserCatalog({ ...modules(), linkedin: { ...modules().linkedin, access } }), /access/i);
  }
});

test('catalog rejects malformed access declarations, overlapping roots and conflicting session IDs', () => {
  for (const changes of [
    { domains: [] }, { domains: ['*.linkedin.com'] }, { domains: ['linkedin.com/path'] },
    { home: 'http://linkedin.com/feed/' }, { home: 'https://unowned.test/' },
    { redirectRuleId: 0 }, { redirectRuleId: 1 }, { ruleIds: [] }, { ruleIds: [102, 102] }, { ruleIds: [101, 103] },
    { ruleIds: [0, 103] }, { unrestrictedRules: null }, { sessionRules: null },
    { unrestrictedRules: [] }, { sessionRules: [] }, { sessionRules: [null] },
    { sessionRules: [{ id: 999 }] }, { sessionRules: [{ id: 102 }, { id: 102 }] },
    { domains: ['x.com'], home: 'https://x.com/' },
    { domains: ['mobile.x.com'], home: 'https://mobile.x.com/' }
  ]) {
    const linkedin = { ...modules().linkedin, access: { ...modules().linkedin.access, ...changes } };
    assert.throws(() => browserCatalog({ ...modules(), linkedin }), /access|hosts/i);
  }
  assert.throws(() => browserCatalog({ ...modules(), x: { ...modules().x, defaultEnabled: 'yes' } }), /default activation/);
});

test('catalog rejects missing modules, mismatched IDs, overlapping hosts, and incomplete adapters', () => {
  assert.throws(() => browserCatalog({ x: modules().x }), /Invalid site integration/);
  for (const changes of [{ id: 'other' }, { create: null }, { classifyPage: null }, { actions: null }, { hosts: ['x.com'] }, { hosts: ['*.linkedin.com'] }, { hosts: ['linkedin.com/path'] }]) {
    assert.throws(() => browserCatalog({ ...modules(), linkedin: { ...modules().linkedin, ...changes } }), /integration|hosts/i);
  }
});
