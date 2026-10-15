'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function animation() {
  let now = 100000, sequence = 0;
  const timers = new Map();
  function element() {
    return { children: [], attributes: {}, append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }, setAttribute(key, value) { this.attributes[key] = value; }, remove() { this.parent.children = this.parent.children.filter(child => child !== this); } };
  }
  const context = vm.createContext({ document: { createElement: element }, Date: { now: () => now }, setTimeout(fn, ms) { assert.equal(ms, 2800); timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'refill.js'), 'utf8') + '\n globalThis.animation = RefillAnimation;', context);
  return { target: element(), createTarget: element, timers, render: context.animation.render, waitForFill: context.animation.waitForFill, advance(ms) { now += ms; }, finish() { for (const [id, fn] of timers) { timers.delete(id); fn(); } } };
}

test('a refill reveals a decorative fill and a live announcement, then cleans up', () => {
  const a = animation();
  a.render(a.target, { remainingMs: 300000, refilledAt: 100000 });
  const notice = a.target.children[0];
  assert.equal(notice.className, 'refill-notice');
  assert.equal(notice.attributes.role, 'status');
  assert.equal(notice.children[0].textContent, 'Time refilled');
  assert.equal(notice.children[1].attributes['aria-hidden'], 'true');
  assert.equal(notice.children[1].children[0].className, 'refill-fill');
  a.finish(); assert.equal(a.target.children.length, 0);
});

test('countdown ticks and storage refreshes never replay the same refill', () => {
  const a = animation();
  a.render(a.target, { remainingMs: 300000, refilledAt: 100000 });
  const notice = a.target.children[0];
  a.render(a.target, { remainingMs: 299000, refilledAt: 100000 });
  assert.equal(a.target.children[0], notice); assert.equal(a.timers.size, 1);
  a.finish(); a.render(a.target, { remainingMs: 298000, refilledAt: 100000 });
  assert.equal(a.target.children.length, 0); assert.equal(a.timers.size, 0);
});

test('normal opens, old or future refills and exhausted budgets do not animate', () => {
  for (const refilledAt of [undefined, 0, 39999, 100001, NaN, Infinity]) {
    const a = animation(); a.render(a.target, { remainingMs: 300000, refilledAt });
    assert.equal(a.target.children.length, 0);
  }
  const a = animation(); a.render(a.target, { remainingMs: 0, refilledAt: 100000 });
  assert.equal(a.target.children.length, 0);
});

test('an already-open view announces a missed refill on wake, without replaying it', () => {
  const a = animation(); a.render(a.target, { remainingMs: 100000, refilledAt: 0 });
  a.advance(3600000);
  a.render(a.target, { remainingMs: 300000, refilledAt: 100000 });
  assert.equal(a.target.children.length, 1);
  a.finish(); a.render(a.target, { remainingMs: 300000, refilledAt: 100000 });
  assert.equal(a.target.children.length, 0);
});

test('separate sites animate independently and ending access cancels its notice', () => {
  const a = animation(), second = a.createTarget();
  a.render(a.target, { remainingMs: 300000, refilledAt: 100000 });
  a.render(second, { remainingMs: 300000, refilledAt: 100000 });
  a.render(a.target, { remainingMs: 0, refilledAt: 0 });
  assert.equal(a.target.children.length, 0); assert.equal(second.children.length, 1);
  assert.equal(a.timers.size, 1); a.finish(); assert.equal(second.children.length, 0);
});

test('a later daily refill replaces an unfinished animation without leaking timers', () => {
  const a = animation(); a.render(a.target, { remainingMs: 300000, refilledAt: 100000 });
  const old = a.target.children[0];
  a.advance(86400000);
  a.render(a.target, { remainingMs: 300000, refilledAt: 86500000 });
  assert.notEqual(a.target.children[0], old); assert.equal(a.target.children.length, 1);
  assert.equal(a.timers.size, 1); a.finish(); assert.equal(a.target.children.length, 0);
});

test('navigation waits for the fill sweep to finish', async () => {
  const a = animation(); a.render(a.target, { remainingMs: 300000, refilledAt: 100000 });
  const fill = a.target.children[0].children[1].children[0];
  let finish, completed = false;
  fill.getAnimations = () => [{ finished: new Promise(resolve => { finish = resolve; }) }];
  const waiting = a.waitForFill(a.target).then(() => { completed = true; });
  assert.equal(completed, false);
  finish(); await waiting; assert.equal(completed, true);
});

test('navigation is immediate without an animated fill and cancellation never prevents it', async () => {
  const a = animation(); assert.equal(a.waitForFill(a.target), undefined);
  a.render(a.target, { remainingMs: 300000, refilledAt: 100000 });
  const fill = a.target.children[0].children[1].children[0];
  fill.getAnimations = () => [];
  assert.equal(a.waitForFill(a.target), undefined);
  fill.getAnimations = () => [{ finished: Promise.reject(new Error('Animation cancelled')) }];
  await assert.doesNotReject(async () => a.waitForFill(a.target));
});

test('reduced motion keeps the refill announcement but disables both animations', () => {
  const css = fs.readFileSync(path.join(__dirname, 'refill.css'), 'utf8');
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.refill-notice,\.refill-fill\{animation:none\}\}/);
});
