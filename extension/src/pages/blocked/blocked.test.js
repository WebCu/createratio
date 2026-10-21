'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C3 = require('../../../core/core.js');
const C3Sites = require('../../../sites/index.js');
const { accessState } = require('../../tests/ui-harness.js');

function page(options = {}) {
  const site = options.site || 'x';
  let now = 0, fail = !!options.fail, access = accessState(site);
  const elements = {}, intervals = {}, sent = [], redirects = [];
  const document = { body: { id: '', tagName: 'BODY', focus() { document.activeElement = this; } }, getElementById: id => elements[id], createElement: element };
  document.activeElement = document.body;
  const panels = { reason: 'request', begin: 'request', 'waiting-title': 'waiting', open: 'waiting', cancel: 'waiting', 'active-title': 'active', return: 'active', end: 'active' };
  for (const [, id] of fs.readFileSync(path.join(__dirname, 'blocked.html'), 'utf8').matchAll(/id="([^"]+)"/g)) {
    let hidden = ['waiting', 'active', 'error'].includes(id), disabled = ['reason', 'begin', 'open'].includes(id);
    elements[id] = { id, get hidden() { return hidden; }, set hidden(value) { hidden = value; if (value && (document.activeElement === this || panels[document.activeElement.id] === id)) document.activeElement = document.body; }, get disabled() { return disabled; }, set disabled(value) { disabled = value; if (value && document.activeElement === this) document.activeElement = document.body; }, focus() { if (!this.disabled && !this.hidden && !elements[panels[id]]?.hidden) document.activeElement = this; }, value: '', textContent: '', events: {}, addEventListener(event, fn) { this.events[event] = fn; }, reportValidity() { return true; } };
  }
  let finishFill;
  const fillFinished = new Promise(resolve => { finishFill = resolve; });
  function element() {
    return { focus() { document.activeElement = this; }, children: [], append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }, setAttribute() {}, remove() { this.parent.children = this.parent.children.filter(child => child !== this); }, getAnimations() { return options.animate && this.className === 'refill-fill' ? [{ finished: fillFinished }] : []; } };
  }
  Object.assign(elements['active-countdown'], element());
  const saved = options.saved || new Map();
  const context = vm.createContext({ C3, C3Sites, URL, URLSearchParams, Date: { now: () => now }, Math: Object.assign(Object.create(Math), { random: () => options.random ?? 0 }),
    localStorage: { getItem(key) { if (options.storageUnavailable) throw new Error('Storage unavailable'); return saved.get(key) ?? null; }, setItem(key, value) { if (options.storageUnavailable) throw new Error('Storage unavailable'); saved.set(key, String(value)); } },
    document,
    location: { search: '?site=' + site, replace: url => redirects.push(url) },
    addEventListener() {}, setInterval(fn, ms) { intervals[ms] = fn; }, setTimeout() {}, clearTimeout() {},
    chrome: { storage: { onChanged: { addListener() {} } }, runtime: { async sendMessage(message) {
      sent.push(structuredClone(message));
      if (options.beforeReply) await options.beforeReply(message);
      if (Object.hasOwn(options, 'reply')) return options.reply;
      if (fail) return { ok: false, error: 'Unable to check access.' };
      if (message.type === 'access-begin') {
        if (!C3.validIntention(message.reason)) return { ok: false, error: 'Write a specific intention of 20–280 characters.' };
        access = { ...access, readyAt: now + 60000, requestExpiresAt: now + 660000 };
      }
      if (message.type === 'access-open' && !access.remainingMs) {
        if (!access.readyAt || now < access.readyAt) return { ok: false, error: 'Finish the waiting period before opening the site.' };
        access = { ...access, readyAt: 0, remainingMs: access.sessionMinutes * 60000, expiresAt: 0, refilledAt: now };
      }
      if (message.type === 'access-cancel' || message.type === 'access-end') access = { ...access, readyAt: 0, expiresAt: 0, remainingMs: 0, requestExpiresAt: 0 };
      return { ok: true, access: { [site]: structuredClone(access) }, intentionHistoryEnabled: options.intentionHistoryEnabled === true };
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../shared/messages.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../shared/refill.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'blocked.js'), 'utf8'), context);
  return { elements, document, sent, redirects, intervals, finishFill, set now(value) { now = value; }, set fail(value) { fail = value; }, set access(value) { access = { ...access, ...value }; }, async flush() { await new Promise(resolve => setImmediate(resolve)); }, submit() { elements.request.events.submit({ preventDefault() {} }); }, click(id) { elements[id].focus(); elements[id].events.click(); } };
}
test('acknowledged intention moves focus to the waiting heading, not on later renders', async () => {
  const p = page(); await p.flush();
  assert.equal(p.document.activeElement, p.document.body, 'initial loading must not move focus');
  p.elements.reason.value = 'Reply to Alex about our launch, then leave.';
  p.elements.begin.focus(); p.submit(); await p.flush();
  assert.equal(p.document.activeElement.id, 'waiting-title');
  p.elements.cancel.focus(); p.now = 60000;
  p.intervals[1000](); p.intervals[5000](); await p.flush();
  assert.equal(p.elements.open.disabled, false);
  assert.equal(p.document.activeElement.id, 'cancel', 'readiness and polling must not move focus');
});

test('acknowledged cancel and end restore the cleared, enabled intention field', async () => {
  const p = page(); await p.flush();
  p.elements.reason.value = 'Reply to Alex about our launch, then leave.'; p.submit(); await p.flush();
  p.click('cancel'); await p.flush();
  assert.equal(p.elements.reason.value, ''); assert.equal(p.elements.reason.disabled, false);
  assert.equal(p.document.activeElement.id, 'reason');
  p.access = { remainingMs: 60000 }; p.intervals[5000](); await p.flush();
  p.elements.reason.value = 'An earlier intention.';
  p.click('end'); await p.flush();
  assert.equal(p.elements.reason.value, ''); assert.equal(p.elements.reason.disabled, false);
  assert.equal(p.document.activeElement.id, 'reason');
});

test('failed intention preserves input and restores actionable focus after re-enabling controls', async () => {
  const p = page(); await p.flush(); p.fail = true;
  const intention = 'Reply to Alex about our launch, then leave.';
  p.elements.reason.value = intention; p.elements.begin.focus(); p.submit(); await p.flush();
  assert.equal(p.elements.reason.value, intention); assert.equal(p.elements.request.hidden, false);
  assert.equal(p.elements.begin.disabled, false); assert.equal(p.elements.error.hidden, false);
  assert.equal(p.document.activeElement.id, 'begin');
});

test('pending actions preserve focus deliberately moved to another control before acknowledgement', async () => {
  for (const [type, control, state] of [
    ['access-begin', 'begin', {}],
    ['access-cancel', 'cancel', { readyAt: 60000, requestExpiresAt: 660000 }],
    ['access-end', 'end', { remainingMs: 60000 }],
    ['access-open', 'open', { readyAt: 1, requestExpiresAt: 660000 }],
    ['access-status', 'return', { remainingMs: 60000 }]
  ]) {
    let release, hold = false;
    const acknowledged = new Promise(resolve => { release = resolve; });
    const p = page({ async beforeReply(message) { if (hold && message.type === type) await acknowledged; } });
    await p.flush(); p.now = 1000; p.access = state; p.intervals[5000](); await p.flush();
    p.elements.reason.value = 'Reply to Alex about our launch, then leave.';
    hold = true;
    if (control === 'begin') { p.elements.begin.focus(); p.submit(); } else p.click(control);
    const link = p.document.createElement('a'); link.focus();
    release(); await p.flush();
    assert.equal(p.document.activeElement, link, `${type} must respect the user's new focus`);
    if (control === 'open' || control === 'return') assert.deepEqual(p.redirects, ['https://x.com/home'], 'focus must not replace requested navigation');
  }
});

test('failed cancel, end and open retain the current view and an enabled recovery control', async () => {
  for (const [control, panel, state] of [
    ['cancel', 'waiting', { readyAt: 60000, requestExpiresAt: 660000 }],
    ['end', 'active', { remainingMs: 60000 }],
    ['open', 'waiting', { readyAt: 1, requestExpiresAt: 660000 }]
  ]) {
    const p = page(); await p.flush(); p.now = 1000; p.access = state; p.intervals[5000](); await p.flush();
    p.elements.reason.value = 'Keep this intention until the action succeeds.'; p.fail = true;
    p.click(control); await p.flush();
    assert.equal(p.elements[panel].hidden, false);
    assert.equal(p.elements[control].disabled, false); assert.equal(p.elements.error.hidden, false);
    assert.equal(p.document.activeElement.id, control);
    assert.equal(p.elements.reason.value, 'Keep this intention until the action succeeds.');
    assert.deepEqual(p.redirects, []);
  }
});

test('passive wait restoration, expiry and active refreshes never move deliberate focus', async () => {
  const p = page(); await p.flush();
  const link = p.document.createElement('a'); link.focus();
  p.access = { readyAt: 60000, requestExpiresAt: 660000 }; p.intervals[5000](); await p.flush();
  assert.equal(p.document.activeElement, link);
  p.now = 660000; p.intervals[1000]();
  assert.equal(p.elements.request.hidden, false); assert.equal(p.document.activeElement, link);
  p.access = { remainingMs: 60000 }; p.intervals[5000](); await p.flush(); p.intervals[1000]();
  assert.equal(p.elements.active.hidden, false); assert.equal(p.document.activeElement, link);
});

test('gate stays closed on malformed replies and requires access for its requested site', async () => {
  for (const reply of [{ ok: 'true', access: {} }, { ok: true }, { ok: true, access: { x: { remainingMs: '60000', goalAllowed: 'true' } } }]) {
    const p = page({ reply }); await p.flush();
    assert.equal(p.elements.begin.disabled, true); assert.deepEqual(p.redirects, []);
    assert.equal(p.elements.error.textContent, 'Unable to check access. The site stays blocked.');
  }
  const p = page({ reply: { ok: true, access: {} } }); await p.flush();
  assert.equal(p.elements.error.textContent, 'Open this page by visiting X or LinkedIn.');
  assert.equal(p.elements.begin.disabled, true); assert.deepEqual(p.redirects, []);
});
test('blocked-page refresh refuses Off-site navigation to malformed, unvetted, mismatched or credentialed homes', async () => {
  for (const { id } of C3Sites.sites.filter(site => site.gated)) {
    const valid = accessState(id, { enabled: false });
    const credentialURL = new URL(valid.home); credentialURL.username = 'user';
    const other = C3Sites.sites.find(site => site.gated && site.id !== id);
    for (const home of ['https://[/', 'https://evil.test/', C3Sites.get(other.id).access.home, credentialURL.href, valid.home + '?redirect=https://evil.test/']) {
      const options = { site: id, reply: { ok: true, access: { [id]: { ...valid, home } } } };
      const p = page(options); await p.flush();
      assert.deepEqual(p.redirects, []);
      assert.equal(p.elements.error.textContent, 'Unable to check access. The site stays blocked.');
      assert.equal(p.elements.begin.disabled, true);
      p.click('return'); await p.flush(); assert.deepEqual(p.redirects, []);
      options.reply = { ok: true, access: { [id]: valid } };
      p.intervals[5000](); await p.flush();
      assert.deepEqual(p.redirects, [valid.home]);
    }
  }
});
test('gate explains whether intentions are saved before submission', async () => {
  const off = page(); await off.flush(); assert.match(off.elements['reason-hint'].textContent, /not saved/);
  const on = page({ intentionHistoryEnabled: true }); await on.flush(); assert.match(on.elements['reason-hint'].textContent, /saved on this device/);
});
test('gate stays disabled until it loads access and renders a blocked site accurately', async () => {
  const p = page(); assert.equal(p.elements.begin.disabled, true); await p.flush();
  assert.equal(p.elements.begin.disabled, false); assert.equal(p.elements.reason.disabled, false);
  assert.ok(p.elements.heading.textContent.trim());
  assert.match(p.elements.description.textContent, /X/);
  assert.equal(p.elements.request.hidden, false); assert.equal(p.elements.waiting.hidden, true);
});
test('blocked messages vary across visits without repeating, but stay stable during countdown updates', async () => {
  const saved = new Map(), seen = new Set();
  let previous;
  for (let i = 0; i < 12; i++) {
    const p = page({ saved, random: i / 12 }); await p.flush();
    const line = p.elements.heading.textContent;
    assert.notEqual(line, previous, 'consecutive visits must use different lines');
    p.intervals[1000](); p.intervals[5000](); await p.flush();
    assert.equal(p.elements.heading.textContent, line, 'do not rotate on each timer tick');
    seen.add(line); previous = line;
  }
  assert.ok(seen.size >= 4, 'use a varied set of messages');
});

test('playful gate stays usable with corrupt or unavailable presentation storage and fails closed without the worker', async () => {
  const fallback = page(); await fallback.flush();
  for (const savedValue of ['not a number', '-1', '999999', '']) {
    const p = page({ saved: new Map([['c3-blocked-line-x', savedValue]]) }); await p.flush();
    assert.equal(p.elements.heading.textContent, fallback.elements.heading.textContent);
    assert.equal(p.elements.begin.disabled, false);
  }
  const p = page({ storageUnavailable: true, fail: true }); await p.flush();
  assert.equal(p.elements.heading.textContent, fallback.elements.heading.textContent);
  assert.equal(p.elements.begin.disabled, true);
  assert.equal(p.elements.error.hidden, false); assert.deepEqual(p.redirects, []);
});

test('gate shows goal-based access without a countdown and returns directly to the site', async () => {
  const p = page(); await p.flush(); p.access = { goalAllowed: true, remainingMs: 60000, refilledAt: 1000 }; p.now = 1000;
  p.intervals[5000](); await p.flush();
  assert.equal(p.elements.heading.textContent, 'X is open.');
  assert.equal(p.elements.request.hidden, true); assert.equal(p.elements.waiting.hidden, true);
  assert.equal(p.elements.active.hidden, false); assert.equal(p.elements.end.hidden, true);
  assert.equal(p.elements.return.disabled, false);
  assert.match(p.elements['state-text'].textContent, /Above your daily goal/);
  assert.equal(p.elements['active-countdown'].children.length, 0, 'goal-based access does not show a timed-session refill');
  assert.match(p.elements.description.textContent, /current daily target/);
  assert.doesNotMatch(p.elements.description.textContent, /1\.0/);
  p.click('return'); await p.flush(); assert.deepEqual(p.redirects, ['https://x.com/home']);
  assert.equal(p.sent.some(m => m.type === 'access-begin'), false);
  p.access = { goalAllowed: false, remainingMs: 0 }; p.intervals[5000](); await p.flush();
  assert.equal(p.elements.active.hidden, true); assert.equal(p.elements.request.hidden, false);
});

test('an open session hides blocked-only instructions and restores them when the session ends', async () => {
  const p = page(); await p.flush();
  assert.equal(p.elements['access-steps'].hidden, false);
  p.access = { remainingMs: 60000 }; p.intervals[5000](); await p.flush();
  assert.equal(p.elements['access-steps'].hidden, true);
  assert.equal(p.elements.active.hidden, false);
  p.click('end'); await p.flush();
  assert.equal(p.elements['access-steps'].hidden, false);
  assert.equal(p.elements.request.hidden, false);
});
test('gate validates trimmed intentions before contacting the worker', async () => {
  const p = page(); await p.flush();
  assert.equal(p.elements.reason.minLength, C3.INTENTION_LIMITS.minLength);
  assert.equal(p.elements.reason.maxLength, C3.INTENTION_LIMITS.maxLength);
  for (const reason of ['', 'short', ' '.repeat(20), ' '.repeat(20) + 'short', 'a'.repeat(281)]) {
    p.elements.reason.value = reason; p.submit(); await p.flush();
    assert.equal(p.sent.some(message => message.type === 'access-begin'), false);
    assert.equal(p.elements.error.textContent, 'Write a specific intention of 20–280 characters.');
    assert.equal(p.elements.waiting.hidden, true);
  }
  p.elements.reason.value = '  Reply to Alex about our launch, then leave.  '; p.submit(); await p.flush();
  assert.equal(p.sent.find(message => message.type === 'access-begin').reason, 'Reply to Alex about our launch, then leave.');
  assert.equal(p.elements.error.hidden, true);
  assert.equal(p.elements.waiting.hidden, false);
});

test('gate counts down but never automatically opens access; confirmation navigates only after acknowledgement', async () => {
  const p = page(); await p.flush();
  p.elements.reason.value = 'Reply to Alex about our launch, then leave.'; p.submit(); await p.flush();
  assert.equal(p.elements.waiting.hidden, false); assert.equal(p.elements.open.disabled, true);
  assert.equal(p.elements.clock.textContent, '1:00');
  p.now = 59000; p.intervals[1000](); assert.equal(p.elements.clock.textContent, '0:01'); assert.equal(p.elements.open.disabled, true);
  p.now = 60000; p.intervals[1000](); assert.equal(p.elements.open.disabled, false); assert.equal(p.elements.clock.textContent, '0:00');
  assert.deepEqual(p.redirects, []); assert.equal(p.sent.some(message => message.type === 'access-open'), false);
  p.click('open'); assert.equal(p.elements.open.disabled, true); assert.deepEqual(p.redirects, []); await p.flush();
  assert.deepEqual(p.redirects, ['https://x.com/home']);
  assert.equal(p.elements.active.hidden, false); assert.equal(p.elements.heading.textContent, 'X is open.');
  assert.equal(p.elements['access-steps'].hidden, true, 'an active session must not show blocked-only instructions');
});
test('successful unblock shows the refill sweep before navigation; returning does not wait or replay', async () => {
  const p = page({ animate: true }); await p.flush();
  p.elements.reason.value = 'Reply to Alex about our launch, then leave.';
  p.submit(); await p.flush(); p.now = 60000;
  p.click('open'); await p.flush();
  const notice = p.elements['active-countdown'].children[0];
  assert.equal(notice.children[0].textContent, 'Time refilled');
  assert.equal(p.elements.active.hidden, false);
  assert.equal(p.elements.return.disabled, true);
  assert.equal(p.document.activeElement.id, 'active-title', 'acknowledged access keeps a focus target while the refill is visible');
  assert.deepEqual(p.redirects, [], 'keep the page visible until the fill sweep finishes');
  p.click('open'); await p.flush();
  assert.equal(p.sent.filter(message => message.type === 'access-open').length, 1);
  const link = p.document.createElement('a'); link.focus();
  p.finishFill(); await p.flush();
  assert.deepEqual(p.redirects, ['https://x.com/home']);
  assert.equal(p.document.activeElement, link, 'finishing the refill must not steal focus again');
  p.click('return'); await p.flush();
  assert.deepEqual(p.redirects, ['https://x.com/home', 'https://x.com/home']);
  assert.equal(p.elements['active-countdown'].children[0], notice);
});

test('successful unblock navigates immediately when no motion is running', async () => {
  const p = page(); await p.flush();
  p.elements.reason.value = 'Reply to Alex about our launch, then leave.';
  p.submit(); await p.flush(); p.now = 60000;
  p.click('open'); await p.flush();
  assert.deepEqual(p.redirects, ['https://x.com/home']);
  assert.equal(p.elements['active-countdown'].children[0].children[0].textContent, 'Time refilled');
});

test('gate uses configured duration and displays a paused budget without consuming it', async () => {
  const p = page(); await p.flush(); p.access = { sessionMinutes: 12 };
  p.elements.reason.value = 'Reply to Alex about our launch, then leave.';
  p.submit(); await p.flush();
  assert.equal(p.elements.open.textContent, 'Open X for 12 active minutes');
  p.now = 60000; p.click('open'); await p.flush();
  assert.match(p.elements['active-time'].textContent, /12:00 remaining · paused/);
  p.now = 900000; p.intervals[1000]();
  assert.match(p.elements['active-time'].textContent, /12:00 remaining · paused/);
  p.click('return'); await p.flush();
  assert.equal(p.redirects.length, 2, 'paused access still permits returning to the site');
});

test('gate animates a refill once while continuing to render the authoritative countdown', async () => {
  const p = page(); await p.flush(); p.now = 100000;
  p.access = { remainingMs: 300000, refilledAt: 100000 };
  p.intervals[5000](); await p.flush();
  const target = p.elements['active-countdown'], notice = target.children[0];
  assert.equal(notice.children[0].textContent, 'Time refilled');
  assert.match(p.elements['active-time'].textContent, /5:00 remaining/);
  p.intervals[1000](); p.intervals[5000](); await p.flush();
  assert.equal(target.children[0], notice);
  p.click('end'); await p.flush();
  assert.equal(target.children.length, 0); assert.equal(p.elements.active.hidden, true);
});

test('instruction step 3 reflects the configured duration and changes after refresh', async () => {
  const p = page(); await p.flush();
  assert.equal(p.elements['session-step']?.textContent, 'Open a 5-minute session.');
  p.access = { sessionMinutes: 12 }; p.intervals[5000](); await p.flush();
  assert.equal(p.elements['session-step'].textContent, 'Open a 12-minute session.');
  p.access = { sessionMinutes: 1 }; p.intervals[5000](); await p.flush();
  assert.equal(p.elements['session-step'].textContent, 'Open a 1-minute session.');
});

test('turning Limit & track Off releases an already-open gate without waiting or starting a session', async () => {
  const p = page(); await p.flush(); p.access = { enabled: false }; p.intervals[5000](); await p.flush();
  assert.deepEqual(p.redirects, ['https://x.com/home']); assert.ok(p.sent.every(message => message.type === 'access-status'));
});
test('cancelling resets the gate and clears the intention without opening the site', async () => {
  const p = page(); await p.flush(); p.elements.reason.value = 'Reply to Alex about our launch, then leave.';
  p.submit(); await p.flush(); p.click('cancel'); await p.flush();
  assert.equal(p.elements.waiting.hidden, true); assert.equal(p.elements.request.hidden, false); assert.equal(p.elements.reason.value, '');
  assert.deepEqual(p.redirects, []);
});
test('gate reports failed requests without navigating or claiming access', async () => {
  const p = page(); await p.flush(); p.fail = true;
  p.elements.reason.value = 'Reply to Alex about our launch, then leave.'; p.submit(); await p.flush();
  assert.equal(p.elements.error.hidden, false); assert.equal(p.elements.error.textContent, 'Unable to check access.');
  assert.equal(p.elements.active.hidden, true); assert.deepEqual(p.redirects, []);
});
test('gate recovers ongoing waits from refresh and resets abandoned requests', async () => {
  const p = page(); await p.flush(); p.access = { readyAt: 60000, requestExpiresAt: 660000 };
  p.now = 30000; p.intervals[5000](); await p.flush(); assert.equal(p.elements.clock.textContent, '0:30');
  p.now = 660000; p.intervals[1000](); assert.equal(p.elements.request.hidden, false); assert.equal(p.elements.waiting.hidden, true);
});
