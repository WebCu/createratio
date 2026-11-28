'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const now = new Date(2026, 0, 15, 12).getTime();
const date = '2026-01-15';

function engine(folder) {
  const world = { data: {}, alarms: {}, tabs: [], rules: [], restart: false };
  const api = {
    runtime: { getURL: file => 'chrome-extension://fixture/' + file },
    storage: {
      session: {
        async get() {
          return { _accessInitialized: !world.restart };
        },
        async set() {}
      },
      local: {
        async get(keys) {
          return Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys])
              .filter(key => Object.hasOwn(world.data, key))
              .map(key => [key, structuredClone(world.data[key])])
          );
        },
        async set(changes) {
          Object.assign(world.data, structuredClone(changes));
        }
      }
    },
    declarativeNetRequest: {
      async getSessionRules() {
        return structuredClone(world.rules);
      },
      async updateSessionRules({ removeRuleIds, addRules = [] }) {
        world.rules = [...world.rules.filter(rule => !removeRuleIds.includes(rule.id)), ...structuredClone(addRules)];
      }
    },
    alarms: {
      async clear(name) {
        delete world.alarms[name];
      },
      async create(name, settings) {
        world.alarms[name] = settings;
      }
    },
    windows: {
      async getLastFocused() {
        return { focused: true, type: 'normal', id: 1 };
      }
    },
    tabs: {
      async query() {
        return structuredClone(world.tabs);
      },
      async update(id, changes) {
        Object.assign(
          world.tabs.find(tab => tab.id === id),
          changes
        );
      }
    }
  };
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const context = vm.createContext({ URL, Date: Clock, chrome: api });
  const scripts = ['sites.js', 'core.js'];
  if (fs.existsSync(path.join(folder, 'message-contracts.js'))) scripts.push('message-contracts.js');
  if (fs.existsSync(path.join(folder, 'site-access.js'))) scripts.push('site-access.js');
  scripts.push('blocker.js');
  for (const file of scripts) vm.runInContext(fs.readFileSync(path.join(folder, file), 'utf8'), context);
  const access = vm.runInContext('SiteAccess', context);
  const catalog = vm.runInContext(
    'Sites.sites.filter(site => site.gated).map(site => ({ ...site, access: Sites.get(site.id).access }))',
    context
  );
  const model = fs.existsSync(path.join(folder, 'site-access.js')) ? vm.runInContext('SiteAccessModel', context) : null;
  return {
    catalog: JSON.parse(JSON.stringify(catalog)),
    siteForURL: raw => access.siteForURL(raw),
    async snapshot(initial, url, restart) {
      Object.assign(world, { data: structuredClone(initial), alarms: {}, tabs: [{ id: 1, url }], rules: [], restart });
      const status = await access.reconcile();
      const { rules, data, alarms, tabs } = world;
      return JSON.parse(JSON.stringify({ status, rules, data, alarms, tabs }));
    },
    normalizedBaseline(snapshot) {
      if (!model || !snapshot.data._access) return snapshot;
      const normalized = Object.fromEntries(
        Object.entries(snapshot.data._access).flatMap(([site, raw]) => {
          const state = model.siteAccessFromStored(raw, now);
          if (state === null) return [];
          if (state.phase !== 'request') return [[site, raw]];
          const { expiresAt, remainingMs, ...entry } = raw;
          if (state.waitMs === null) delete entry.waitMs;
          return [[site, entry]];
        })
      );
      return { ...snapshot, data: { ...snapshot.data, _access: normalized } };
    }
  };
}

function matrix(catalog) {
  assert.ok(catalog.length > 0, 'Candidate bundle has no access integrations');
  const entries = value => Object.fromEntries(catalog.map(site => [site.id, structuredClone(value)]));
  const first = catalog[0];
  const urls = [
    ...new Set(
      catalog
        .flatMap(site =>
          site.access.domains.flatMap(domain => [
            ...['https:', 'http:'].flatMap(protocol =>
              ['', 'www.', 'm.', 'mobile.'].map(
                prefix => protocol + '//' + prefix + domain + new URL(site.access.home).pathname
              )
            ),
            'https://' + domain + '.evil.invalid/',
            'https://not' + domain + '/',
            'ftp://' + domain + '/'
          ])
        )
        .concat(['https://unknown.invalid/', 'chrome://newtab/', 'invalid'])
    )
  ];
  const enabled = { trackedSites: catalog.map(site => site.id) };
  const aboveGoal = {
    settings: { ...enabled, allowAboveGoal: true },
    [date]: { [first.id]: { createSec: 121, consumeSec: 120 } }
  };
  const states = {
    defaults: {},
    blocked: { settings: enabled },
    off: { settings: { trackedSites: [] } },
    oneOff: { settings: { trackedSites: catalog.slice(1).map(site => site.id) } },
    paused: { settings: enabled, _access: entries({ remainingMs: 300000, date, expiresAt: 0 }) },
    running: { settings: enabled, _access: entries({ remainingMs: 300000, date, expiresAt: now + 299000 }) },
    expired: { settings: enabled, _access: entries({ remainingMs: 1000, date, expiresAt: now - 1 }) },
    aboveGoal,
    atGoal: {
      settings: { ...enabled, allowAboveGoal: true },
      [date]: { [first.id]: { createSec: 120, consumeSec: 120 } }
    },
    waiting: { settings: enabled, _access: entries({ readyAt: now + 30000 }) },
    midnight: {
      settings: { ...enabled, accessMinutes: 12, siteOverrides: { [first.id]: { accessMinutes: 2 } } },
      _access: entries({ remainingMs: 60000, date: '2026-01-14', expiresAt: 0 })
    },
    exhausted: { settings: enabled, _access: entries({ refilledAt: now - 3600000, date }) },
    exhaustedYesterday: {
      settings: enabled,
      _access: entries({ refilledAt: now - 86400000, date: '2026-01-14' })
    },
    legacyDeadline: { settings: enabled, _access: entries({ expiresAt: now + 60000 }) },
    runningAtMidnight: {
      settings: enabled,
      _access: entries({
        remainingMs: 60000,
        date: '2026-01-14',
        expiresAt: new Date(2026, 0, 15, 0, 0, 30).getTime()
      })
    },
    aboveGoalSession: {
      ...aboveGoal,
      _access: entries({ remainingMs: 300000, date, expiresAt: 0, refilledAt: now - 60000 })
    },
    exhaustedAboveGoal: { ...aboveGoal, _access: entries({ refilledAt: now - 3600000, date }) },
    waitAboveGoal: { ...aboveGoal, _access: entries({ readyAt: now + 30000, waitMs: 300000 }) },
    staleWait: { settings: enabled, _access: entries({ readyAt: now + 3600000, waitMs: 60000 }) }
  };
  const restarts = ['running', 'midnight', 'runningAtMidnight'];
  return { urls, states, restarts };
}

const REPLY_TIMES = ['expiresAt', 'readyAt', 'refilledAt'];

function withAcceptedReplyTimes(baseline, candidate) {
  const status = Object.fromEntries(
    Object.entries(baseline.status).map(([site, state]) => {
      const accepted = { ...state };
      for (const key of REPLY_TIMES)
        if (state[key] === 0 && candidate.status[site]?.[key] === null) accepted[key] = null;
      return [site, accepted];
    })
  );
  return { ...baseline, status };
}

async function compare(baseline, candidate) {
  for (const file of ['manifest.json', 'block-rules.json']) {
    const read = folder => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
    assert.deepEqual(read(candidate), read(baseline), file);
  }
  const original = engine(baseline),
    updated = engine(candidate);
  const { urls, states, restarts } = matrix(updated.catalog);
  let count = 0;
  const runs = Object.entries(states).flatMap(([state, initial]) => [
    [state, initial, false],
    ...(restarts.includes(state) ? [[`${state} (restart)`, initial, true]] : [])
  ]);
  for (const [label, initial, restart] of runs) {
    for (const url of urls) {
      assert.equal(updated.siteForURL(url), original.siteForURL(url), `${label}: ${url}: lookup`);
      const result = await updated.snapshot(initial, url, restart);
      const expected = updated.normalizedBaseline(await original.snapshot(initial, url, restart));
      assert.deepEqual(result, withAcceptedReplyTimes(expected, result), `${label}: ${url}: lifecycle`);
      count++;
    }
  }
  return {
    cases: count,
    urls: urls.length,
    states: Object.keys(states).length,
    restarts: restarts.length,
    verification: 'mocked browser-world VM, not live-browser QA'
  };
}

if (require.main === module) {
  const [baseline, candidate] = process.argv.slice(2);
  if (!baseline || !candidate) {
    process.stderr.write('Usage: node bin/access-equivalence.js BASELINE_BUNDLE CANDIDATE_BUNDLE\n');
    process.exitCode = 1;
  } else
    compare(baseline, candidate)
      .then(result => console.log(JSON.stringify(result, null, 2)))
      .catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
}
module.exports = { compare, matrix };
