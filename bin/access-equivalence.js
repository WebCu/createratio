'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const now = new Date(2026, 0, 15, 12).getTime();
const date = '2026-01-15';

function engine(folder, initial = {}, url = '') {
  const data = structuredClone(initial), alarms = {}, tabs = [{ id: 1, url }];
  let rules = [];
  const api = {
    runtime: { getURL: file => 'chrome-extension://fixture/' + file },
    storage: {
      session: { async get() { return { _accessInitialized: true }; }, async set() {} },
      local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])])); },
        async set(changes) { Object.assign(data, structuredClone(changes)); },
      },
    },
    declarativeNetRequest: {
      async getSessionRules() { return structuredClone(rules); },
      async updateSessionRules({ removeRuleIds, addRules = [] }) { rules = [...rules.filter(rule => !removeRuleIds.includes(rule.id)), ...structuredClone(addRules)]; },
    },
    alarms: { async clear(name) { delete alarms[name]; }, async create(name, settings) { alarms[name] = settings; } },
    windows: { async getLastFocused() { return { focused: true, type: 'normal', id: 1 }; } },
    tabs: { async query() { return structuredClone(tabs); }, async update(id, changes) { Object.assign(tabs.find(tab => tab.id === id), changes); } },
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({ URL, Date: Clock, chrome: api });
  const scripts = ['sites.js', 'core.js'];
  if (fs.existsSync(path.join(folder, 'message-contracts.js'))) scripts.push('message-contracts.js');
  scripts.push('blocker.js');
  for (const file of scripts) vm.runInContext(fs.readFileSync(path.join(folder, file), 'utf8'), context);
  const access = vm.runInContext('SiteAccess', context);
  const catalog = vm.runInContext('C3Sites.sites.filter(site => site.gated).map(site => ({ ...site, access: C3Sites.get(site.id).access }))', context);
  return {
    catalog: JSON.parse(JSON.stringify(catalog)),
    siteForURL: raw => access.siteForURL(raw),
    async snapshot() { return JSON.parse(JSON.stringify({ status: await access.reconcile(), rules, data, alarms, tabs })); },
  };
}

function matrix(catalog) {
  assert.ok(catalog.length > 0, 'Candidate bundle has no access integrations');
  const entries = value => Object.fromEntries(catalog.map(site => [site.id, structuredClone(value)]));
  const first = catalog[0];
  const urls = [...new Set(catalog.flatMap(site => site.access.domains.flatMap(domain => [
    ...['https:', 'http:'].flatMap(protocol => ['', 'www.', 'm.', 'mobile.'].map(prefix => protocol + '//' + prefix + domain + new URL(site.access.home).pathname)),
    'https://' + domain + '.evil.invalid/', 'https://not' + domain + '/', 'ftp://' + domain + '/',
  ])).concat(['https://unknown.invalid/', 'chrome://newtab/', 'invalid']))];
  const enabled = { trackedSites: catalog.map(site => site.id) };
  const states = {
    defaults: {},
    blocked: { settings: enabled },
    off: { settings: { trackedSites: [] } },
    oneOff: { settings: { trackedSites: catalog.slice(1).map(site => site.id) } },
    paused: { settings: enabled, _access: entries({ remainingMs: 300000, date, expiresAt: 0 }) },
    running: { settings: enabled, _access: entries({ remainingMs: 300000, date, expiresAt: now + 299000 }) },
    expired: { settings: enabled, _access: entries({ remainingMs: 1000, date, expiresAt: now - 1 }) },
    aboveGoal: { settings: { ...enabled, allowAboveGoal: true }, [date]: { [first.id]: { createSec: 121, consumeSec: 120 } } },
    atGoal: { settings: { ...enabled, allowAboveGoal: true }, [date]: { [first.id]: { createSec: 120, consumeSec: 120 } } },
    waiting: { settings: enabled, _access: entries({ readyAt: now + 30000, requestExpiresAt: now + 600000 }) },
    midnight: { settings: { ...enabled, accessMinutes: 12, siteOverrides: { [first.id]: { accessMinutes: 2 } } }, _access: entries({ remainingMs: 60000, date: '2026-01-14', expiresAt: 0 }) },
  };
  return { urls, states };
}

async function compare(baseline, candidate) {
  for (const file of ['manifest.json', 'block-rules.json']) {
    const read = folder => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
    assert.deepEqual(read(candidate), read(baseline), file);
  }
  const { urls, states } = matrix(engine(candidate).catalog);
  let count = 0;
  for (const [state, initial] of Object.entries(states)) {
    for (const url of urls) {
      const original = engine(baseline, initial, url), updated = engine(candidate, initial, url);
      assert.equal(updated.siteForURL(url), original.siteForURL(url), `${state}: ${url}: lookup`);
      assert.deepEqual(await updated.snapshot(), await original.snapshot(), `${state}: ${url}: lifecycle`);
      count++;
    }
  }
  return { cases: count, urls: urls.length, states: Object.keys(states).length, verification: 'mocked browser-world VM, not live-browser QA' };
}

if (require.main === module) {
  const [baseline, candidate] = process.argv.slice(2);
  if (!baseline || !candidate) {
    process.stderr.write('Usage: node bin/access-equivalence.js BASELINE_BUNDLE CANDIDATE_BUNDLE\n');
    process.exitCode = 1;
  } else compare(baseline, candidate).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = { compare, matrix };
