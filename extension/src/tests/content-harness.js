'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../core/core.js');
const integrations = require('../../sites/index.js');
const { accessState } = require('./ui-harness.js');
const { Element, xFixture, linkedinFixture } = require('../../sites/test-support.js');

async function tracker(browser = 'chrome', options = {}) {
  let now = 0, focused = true, interval;
  const base = new Date(2026, 9, 11, 12).getTime(), events = {}, packets = [];
  function listen(type, fn) { (events[type] ||= []).push(fn); }
  const elements = [], warnings = [];
  const url = options.url || 'https://x.com/home';
  const fixture = C.siteForURL(url) === 'linkedin' ? linkedinFixture({ url, message: options.message, listen }) : xFixture({ url, action: options.action, listen });
  const doc = fixture.document, location = fixture.location;
  doc.hasFocus = () => focused;
  doc.createElement = () => { const node = new Element([], '', listen); elements.push(node); return node; };
  let snapshot = options.snapshot || { day: {}, settings: C.DEFAULT_SETTINGS };
  const context = vm.createContext({ C3: { ...C, localDate: () => C.localDate(new Date(base + now)),
      trackingEnabled: (id, settings) => C.trackingEnabled(id, settings) || options.integration?.id === id && settings.trackedSites?.includes(id)
    }, C3Sites: { ...integrations, get: id => options.integration?.id === id ? options.integration : integrations.get(id), forURL: raw => options.integration || integrations.forURL(raw) }, URL,
    C3_DOM: require('../content/dom.js'), Element, getComputedStyle: fixture.getComputedStyle,
    document: doc, location, window: { addEventListener: listen },
    crypto: { randomUUID: () => crypto.randomUUID() }, performance: { now: () => now }, Date: { now: () => base + now }, console: { ...console, warn(...args) { warnings.push(args); } },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval(fn) { interval = fn; return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    [browser]: { runtime: { id: 'extension', onMessage: { addListener() {} }, async sendMessage(message) {
      if (options.forward) return options.forward(message);
      if (message.type === 'ingest') {
        options.attempts?.push(structuredClone(message));
        if (options.failIngest) throw new Error('History storage is full');
        packets.push(structuredClone(message));
        for (const { action } of message.actions) {
          snapshot.day[message.site] ||= {};
          snapshot.day[message.site][action] = (snapshot.day[message.site][action] || 0) + 1;
        }
      }
      const access = snapshot.access || Object.fromEntries(C.SITES.filter(site => site.gated).map(site => [site.id, { remainingMs: 300000 }]));
      const reply = { ok: true, date: C.localDate(new Date(base + now)), websiteTimeEnabled: false, ...structuredClone(snapshot), settings: C.settingsSnapshot(snapshot.settings), access: Object.fromEntries(Object.entries(access).map(([site, state]) => [site, accessState(site, state)])) };
      return options.reply ? options.reply(message, reply) : reply;
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/messages.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/content.js'), 'utf8'), context);
  options.beforeReady?.((type, event) => { for (const fn of events[type] || []) fn({ type, ...event }); });
  await new Promise(resolve => setImmediate(resolve));
  return {
    packets, elements, warnings, editor: fixture.editor, button: fixture.button, setSnapshot(value) { snapshot = value; }, event(type, event) { for (const fn of events[type] || []) fn({ type, ...event }); }, setNow(n) { now = n; }, input(trusted = true) { for (const fn of events.keydown) fn({ isTrusted: trusted }); },
    focus(value) { focused = value; for (const fn of events[value ? 'focus' : 'blur']) fn({}); },
    visible(value) { doc.visibilityState = value ? 'visible' : 'hidden'; for (const fn of events.visibilitychange) fn({}); },
    route(url, create) { location.href = url; location.pathname = new URL(url).pathname; doc.activeElement = create ? fixture.editor : fixture.body; for (const fn of events['c3:route-change']) fn({}); },
    async tick() { interval(); await new Promise(resolve => setImmediate(resolve)); }
  };
}
module.exports = { tracker };
