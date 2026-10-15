'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../core/core.js');
function worker(data = {}, browser = 'chrome', now = Date.now(), options = {}) {
  const session = options.session || {};
  let listener, installed, started, alarmListener, rules = [], failRules = false, websitePermissions = false;
  const badge = {}, accessLevels = [], alarms = {}, tabs = [], events = {}, errors = [];
  let failWrites = false, failRemove = false;
  let focused = false, activeTab = null;
  const event = name => ({ addListener(fn) { (events[name] ||= []).push(fn); } });
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const api = {
    runtime: { id: 'test-extension', getURL(file) { return 'chrome-extension://test-extension/' + file; }, onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener(fn) { installed = fn; } }, onStartup: { addListener(fn) { started = fn; } } },
    alarms: { onAlarm: { addListener(fn) { alarmListener = fn; } }, async get(name) { return alarms[name]; }, async create(name, options) { alarms[name] = options; }, async clear(name) { delete alarms[name]; } },
    permissions: { async contains() { return websitePermissions; }, onRemoved: { addListener() {} } },
    windows: { async getLastFocused() { return { id: 1, focused, type: 'normal' }; }, onFocusChanged: event('focus') },
    idle: { setDetectionInterval() {}, async queryState() { return 'active'; }, onStateChanged: { addListener() {} } },
    tabs: { async query(query) { return query.active ? activeTab ? [activeTab] : [] : tabs; }, async update(id, changes) { Object.assign(tabs.find(tab => tab.id === id), changes); }, onActivated: event('activate'), onUpdated: event('update'), onRemoved: event('remove') },
    declarativeNetRequest: { async getSessionRules() { return structuredClone(rules); }, async updateSessionRules({ removeRuleIds = [], addRules = [] }) { if (failRules) throw new Error('Rule update failed'); rules = [...rules.filter(rule => !removeRuleIds.includes(rule.id)), ...structuredClone(addRules)]; } },
    action: { async setBadgeText(v) { badge.text = v.text; }, async setBadgeBackgroundColor(v) { badge.color = v.color; }, async setTitle() {} },
    storage: { session: {
      async get(key) { return Object.hasOwn(session, key) ? { [key]: structuredClone(session[key]) } : {}; },
      async set(values) { Object.assign(session, structuredClone(values)); }
    }, local: { async remove(keys) { if (failRemove) throw new Error('Remove failed'); for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }, async get(keys) { await new Promise(resolve => setImmediate(resolve)); return Object.fromEntries((keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).filter(k => data[k] !== undefined).map(k => [k, structuredClone(data[k])])); }, async set(values) { await new Promise(resolve => setImmediate(resolve)); if (failWrites) throw new Error('Storage unavailable'); Object.assign(data, structuredClone(values)); } } }
  };
  if (options.localStorage) api.storage.local = options.localStorage;
  if (browser === 'chrome') api.storage.local.setAccessLevel = async options => { accessLevels.push(options.accessLevel); };
  const context = vm.createContext({ console: { ...console, error(...args) { errors.push(args); } }, URL, TextEncoder, crypto, Date: Clock, setInterval() { return 1; }, clearInterval() {}, [browser]: api });
  const load = file => {
    if (file === 'sites.js') {
      for (const script of require('../../build.js').SITE_SCRIPTS) vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', script), 'utf8'), context);
      if (options.integrations) context.C3Sites = options.integrations;
    } else vm.runInContext(fs.readFileSync(file === 'core.js' ? path.join(__dirname, '../../core/core.js') : path.join(__dirname, '../background', file), 'utf8'), context);
  };
  if (browser === 'chrome') context.importScripts = (...files) => files.forEach(load);
  else { load('sites.js'); load('core.js'); load('message-contracts.js'); load('blocker.js'); load('history.js'); load('web-time.js'); }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background/background.js'), 'utf8'), context);
  return { data, badge, accessLevels, alarms, tabs, errors,
    set failWrites(value) { failWrites = value; },
    set failRemove(value) { failRemove = value; },
    activate(url, id = 1) { focused = true; activeTab = { id, url }; for (const fn of events.activate || []) fn({ tabId: id, windowId: 1 }); },
    blur() { focused = false; for (const fn of events.focus || []) fn(-1); },
    navigate(url) { activeTab.url = url; for (const fn of events.update || []) fn(activeTab.id, { url }); },
    removeActive() { const id = activeTab.id; activeTab = null; for (const fn of events.remove || []) fn(id); },
    grantWebsitePermissions() { websitePermissions = true; }, get rules() { return rules; }, set failRules(value) { failRules = value; }, advance(ms) { now += ms; }, get now() { return now; }, install: () => installed(), startup: () => started(), alarm: name => alarmListener({ name }), send(message, sender = { id: 'test-extension', tab: { id: 1 }, frameId: 0, url: 'https://x.com/home' }) { return new Promise(resolve => listener(message, sender, result => resolve(structuredClone(result)))); } };
}
function activeWorker(data = {}, browser = 'chrome') {
  return worker({ _access: { x: { remainingMs: 300000 }, linkedin: { remainingMs: 300000 } }, ...data }, browser);
}
const gate = site => ({ id: 'test-extension', tab: { id: 3 }, frameId: 0, url: `chrome-extension://test-extension/blocked.html?site=${site}` });
const intent = 'Reply to Alex about our launch, then leave.';
async function unlock(w, site = 'x') {
  assert.equal((await w.send({ type: 'access-begin', site, reason: intent }, gate(site))).ok, true);
  w.advance(60000);
  const result = await w.send({ type: 'access-open', site }, gate(site));
  assert.equal(result.ok, true); return result;
}
const popupSender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
module.exports = { worker, activeWorker, unlock, gate, intent, popupSender };
