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
  function listen(type, fn) { if (!(events[type] ||= []).includes(fn)) events[type].push(fn); }
  function unlisten(type, fn) { events[type] = (events[type] || []).filter(listener => listener !== fn); }
  const elements = [], warnings = [];
  const url = options.url || 'https://x.com/home';
  const fixture = options.fixture ? options.fixture({ url, listen }) : C.siteForURL(url) === 'linkedin' ? linkedinFixture({ url, message: options.message, standalonePost: options.standalonePost, listen }) : xFixture({ url, action: options.action, listen });
  const doc = fixture.document, location = fixture.location;
  doc.hasFocus = () => focused;
  doc.removeEventListener = unlisten;
  doc.scrollingElement = Object.assign(doc.documentElement, {
    scrollTop: 1000, scrollLeft: 0, scrollHeight: 10000, clientHeight: 1000,
    scrollBy({ top, left = 0 }) { this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + Math.trunc(top))); this.scrollLeft += left; }
  });
  doc.createElement = () => { const node = new Element([], '', listen); elements.push(node); return node; };
  let snapshot = options.snapshot || { day: {}, settings: C.DEFAULT_SETTINGS };
  const context = vm.createContext({ C3: { ...C, localDate: () => C.localDate(new Date(base + now)),
      trackingEnabled: (id, settings) => C.trackingEnabled(id, settings) || options.integration?.id === id && settings.trackedSites?.includes(id)
    }, C3Sites: { ...integrations, get: id => options.integration?.id === id ? options.integration : integrations.get(id), forURL: raw => options.integration || integrations.forURL(raw) }, URL,
    ScrollFriction: require('../content/scroll-friction.js'),
    C3_DOM: require('../content/dom.js'), Element, getComputedStyle: node => ({ ...fixture.getComputedStyle(node), overflowY: node.style.overflowY || 'visible', overflowX: node.style.overflowX || 'visible' }),
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
    packets, elements, warnings, document: doc, editor: fixture.editor, button: fixture.button,
    listenerCount: type => (events[type] || []).length,
    wheel(deltaY, extra = {}) {
      const event = { type: 'wheel', isTrusted: true, cancelable: true, defaultPrevented: false, deltaY, deltaX: 0, deltaMode: 0, target: fixture.body,
        preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
        composedPath() { const nodes = []; for (let node = this.target; node; node = node.parentElement) nodes.push(node); return [...nodes, doc]; }, ...extra };
      for (const fn of [...events.wheel || []]) fn(event);
      return event;
    },
    setSnapshot(value) { snapshot = value; }, event(type, event) { for (const fn of events[type] || []) fn({ type, ...event }); }, setNow(n) { now = n; }, input(trusted = true) { for (const fn of events.keydown) fn({ isTrusted: trusted }); },
    focus(value) { focused = value; for (const fn of events[value ? 'focus' : 'blur']) fn({}); },
    visible(value) { doc.visibilityState = value ? 'visible' : 'hidden'; for (const fn of events.visibilitychange) fn({}); },
    route(url, create) { location.href = url; location.pathname = new URL(url).pathname; doc.activeElement = create ? fixture.editor : fixture.body; for (const fn of events['c3:route-change']) fn({}); },
    async tick() { interval(); await new Promise(resolve => setImmediate(resolve)); }
  };
}
module.exports = { tracker };
