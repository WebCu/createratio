'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C3 = require('../../core/core.js');
const WebTime = require('../background/web-time.js');
const C3Sites = require('../../sites/index.js');
function accessState(site, changes = {}, catalog = C3Sites) {
  const definition = catalog.get(site);
  return { site, name: definition.name, home: definition.access.home, enabled: true, goalAllowed: false, remainingMs: 0, expiresAt: 0, readyAt: 0, requestExpiresAt: 0, sessionMinutes: 5, ...changes };
}
function page(name, data = { [C3.localDate()]: { x: { consumeSec: 60 } } }, enabled = false, options = {}) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [options.now()])); }
    static now() { return options.now(); }
  }
  const PageDate = options.now ? Clock : Date;
  const core = options.now ? { ...C3, localDate: (date = new PageDate()) => C3.localDate(date), recentDates: (count = 7, now = new PageDate()) => C3.recentDates(count, now) } : C3;
  const intervals = {}, saved = new Map();
  let settings = { ...C3.DEFAULT_SETTINGS, ...data.settings }, changed, interval;
  const messageWaits = new Map();
  const state = { permission: true, requested: 0, removed: 0, messages: [], notifications: [], fail: false, failSnapshot: false, optionsOpened: 0, tabs: [], downloads: [], access: {}, confirm: true, confirmations: [], storageReads: [], snapshotChanges: false, replies: new Map(), rejections: new Map() };
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.hidden = false; this.disabled = false; this.style = { setProperty(key, value) { this[key] = String(value); } }; this.attributes = {}; this.value = ''; this.checked = false; this.textContent = ''; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    append(...children) { for (const node of children) { node.parent = this; this.children.push(node); if (node.id) nodes[node.id] = node; } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    get lastChild() { return this.children.at(-1); }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    querySelector() { return this.tbody ||= new Element(); }
    focus() { document.activeElement = this; }
    reportValidity() { return true; }
    getAnimations() { return []; }
    fire(type, event) { return this.listeners[type]?.(event); }
    click() { state.downloads.push({ filename: this.download, url: this.href }); }
  }
  const nodes = Object.fromEntries([...fs.readFileSync(path.join(__dirname, `../pages/${name}/${name}.html`), 'utf8').matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  if (nodes['website-range']) { nodes['website-range'].value = 'month'; nodes['websites-panel'].hidden = true; }
  if (nodes.chart) nodes.chart.append(new Element(), new Element());
  if (name === 'blocked') {
    for (const id of ['waiting', 'active', 'error']) nodes[id].hidden = true;
    for (const id of ['reason', 'begin', 'open']) nodes[id].disabled = true;
  }
  state.redirects = [];
  const api = {
    runtime: { getURL: file => 'chrome-extension://test/' + file, async openOptionsPage() { state.optionsOpened++; }, async sendMessage(message) {
      state.messages.push(structuredClone(message));
      if (messageWaits.has(message.type)) {
        const waiting = messageWaits.get(message.type);
        messageWaits.delete(message.type);
        await waiting;
      }
      if (state.rejections.has(message.type)) throw state.rejections.get(message.type);
      if (state.replies.has(message.type)) return structuredClone(state.replies.get(message.type));
      if (message.type === 'snapshot' && state.snapshotChanges) changed?.({}, 'local');
      if (state.fail && message.type !== 'snapshot' || state.failSnapshot && message.type === 'snapshot') return { ok: false, error: 'Could not save.' };
      if (options.forward) return options.forward(message);
      if (message.type === 'history') {
        const dates = C3.recentDates(message.range === 'today' ? 1 : message.range === 'week' ? 7 : 30);
        const source = message.kind === 'websites' ? data._websiteTime || {} : data;
        return { ok: true, days: Object.fromEntries(dates.filter(date => source[date]).map(date => [date, structuredClone(source[date])])) };
      }
      if (message.type === 'clear-history') {
        for (const key of Object.keys(data)) if (/^\d{4}-\d{2}-\d{2}$/.test(key) || key === '_websiteTime') delete data[key];
      }
      if (message.type === 'tracking') {
        const active = new Set(settings.trackedSites);
        if (message.enabled) active.add(message.site); else active.delete(message.site);
        settings = { ...settings, trackedSites: [...active] };
      }
      if (message.type === 'settings') return { ok: false, error: 'Unknown message' };
      if (message.type === 'access-duration') { settings = C3.updatePreferences(settings, { accessMinutes: message.minutes }, message.site); return { ok: true, access: structuredClone(state.access) }; }
      if (message.type === 'access-goal-setting') settings.allowAboveGoal = message.enabled;
      if (message.type === 'access-history-setting') settings.intentionHistoryEnabled = message.enabled;
      if (message.type === 'scroll-friction-setting') {
        settings.scrollFrictionEnabled = message.enabled;
        if (message.strength !== undefined) settings.scrollFrictionStrength = message.strength;
      }
      if (message.type === 'access-history-clear') data._intentions = [];
      if (message.type === 'access-history-list') return { ok: true, intentions: structuredClone(data._intentions || []) };
      if (message.type === 'website-time-setting') { enabled = message.enabled; return { ok: true, enabled }; }
      if (message.type === 'access-end') state.access[message.site] = { ...state.access[message.site], remainingMs: 0, expiresAt: 0 };
      return { ok: true, date: C3.localDate(), day: structuredClone(data[C3.localDate()] || {}), settings: C3.settingsSnapshot(structuredClone(settings)), access: structuredClone(state.access), websiteTimeEnabled: enabled };
    } },
    storage: { local: { async get(keys) { state.storageReads.push(keys); return keys === '_websiteTime' ? { _websiteTime: structuredClone(data._websiteTime) } : structuredClone(data); } }, onChanged: { addListener(fn) { changed = fn; } } },
    permissions: { async request() { state.requested++; return state.permission; }, async remove() { state.removed++; } },
    tabs: { async create(options) { state.tabs.push(options); }, async query(query) { assert.deepEqual(Object.keys(query), []); return [{ id: 1 }, { id: 2 }]; }, async sendMessage(id, message) { state.notifications.push({ id, ...structuredClone(message) }); } }
  };
  const document = { activeElement: null, getElementById: id => nodes[id], createElement: () => new Element(), createElementNS: () => new Element(), body: new Element() };
  const blobs = [];
  const context = vm.createContext({ C3: core, C3Sites, WebTime, chrome: api, document, console, Blob, URL: class extends URL { static createObjectURL(blob) { blobs.push(blob); return 'blob:test'; } static revokeObjectURL() {} }, URLSearchParams,
    location: { search: '?site=' + (options.site || 'x'), replace(url) { state.redirects.push(url); } },
    localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, String(value)); } }, addEventListener() {},
    confirm(message) { state.confirmations.push(message); return state.confirm; }, setInterval(fn, ms) { interval = fn; intervals[ms] = fn; }, setTimeout() {}, clearTimeout() {}, Date: PageDate });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/messages.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/refill.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, `../pages/${name}/${name}.js`), 'utf8'), context);
  const ready = async () => { await new Promise(resolve => setImmediate(resolve)); };
  return { nodes, elements: nodes, state, document, data, blobs, messages: state.messages, notifications: state.notifications,
    holdMessage(type) {
      assert.equal(messageWaits.has(type), false);
      let release;
      messageWaits.set(type, new Promise(resolve => { release = resolve; }));
      return release;
    },
    ready, flush: ready, set fail(value) { state.fail = value; }, get settings() { return structuredClone(settings); }, setSettings(value) { settings = value; }, setDay(value) { data[C3.localDate()] = value; },
    change(changes = { settings: { newValue: structuredClone(settings) } }, area = 'local') { changed(changes, area); }, refresh() { interval(); }, timer(ms) { intervals[ms](); },
    toggle(site, active) { const input = nodes['track-' + site]; input.checked = active; input.fire('change'); return input; }
  };
}
module.exports = { page, C3, accessState };
