'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../arrival.js'), 'utf8');

test('the opening has no interactive controls and its scroll cue starts hidden', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const opening = html.match(/<section class="arrival"[\s\S]*?<\/section>/);
  assert.ok(opening);
  assert.doesNotMatch(opening[0], /<(?:a|button)\b/);
  assert.match(opening[0], /<p class="scroll-hint" hidden>/);
  assert.match(opening[0], /<span>Scroll down<\/span>/);
  assert.match(opening[0], /<svg[^>]+aria-hidden="true"/);
  assert.match(opening[0], /<div class="distractions" aria-hidden="true">/);
});

test('the scroll cue appears only after eight seconds without scrolling down', () => {
  const h = harness();
  assert.equal(h.scrollHint.hidden, true);
  h.advance(7999);
  assert.equal(h.scrollHint.hidden, true);
  h.advance(1);
  assert.equal(h.scrollHint.hidden, false);
  assert.equal(h.scrolls.length, 0);
});

test('scrolling before the delay cancels the cue, even after returning to the top', () => {
  const h = harness();
  h.advance(4000);
  h.scroll(1);
  assert.equal(h.timers.size, 0);
  h.scroll(0);
  h.advance(8000);
  assert.equal(h.scrollHint.hidden, true);
});

test('scrolling after the cue appears dismisses it permanently', () => {
  const h = harness();
  h.advance(8000);
  h.scroll(1);
  assert.equal(h.scrollHint.hidden, true);
  h.scroll(0);
  h.advance(8000);
  assert.equal(h.scrollHint.hidden, true);
});

test('restored scroll positions and direct anchors do not show the cue', () => {
  const restored = harness({ scrollY: 100 });
  assert.equal(restored.timers.size, 0);
  restored.scroll(0);
  restored.advance(8000);
  assert.equal(restored.scrollHint.hidden, true);
  const linked = harness({ hash: '#install' });
  linked.flush();
  linked.advance(8000);
  assert.equal(linked.scrollHint.hidden, true);
});

test('the static opening retains the cue without requiring animated masks', () => {
  for (const options of [{ reduced: true }, { supportsMask: false }]) {
    const h = harness(options);
    h.advance(8000);
    assert.equal(h.scrollHint.hidden, false);
    h.scroll(10);
    assert.equal(h.scrollHint.hidden, true);
  }
});

test('the scroll cue animations respect reduced motion', () => {
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.scroll-hint:not\(\[hidden\]\)/);
});

test('hover wiggle is limited to opening distractions, not the stats card', () => {
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.match(css, /\.distractions span:hover\s*\{\s*animation: card-alarm/);
  assert.doesNotMatch(css, /\.example:hover/);
});

function harness({ reduced = false, supportsMask = true, hash = '', scrollY = 0 } = {}) {
  const frames = new Map();
  const timers = new Map();
  let now = 0;
  let nextTimer = 1;
  const scrollHint = { hidden: true };
  const windowEvents = {};
  const documentEvents = {};
  const classes = new Set();
  const arrivalClasses = new Set();
  const properties = new Map();
  const scrolls = [];
  let nextFrame = 1;
  let motionChange;
  const classList = values => ({
    toggle(name, enabled) { if (enabled) values.add(name); else values.delete(name); },
    remove(name) { values.delete(name); }
  });
  const window = {
    scrollY, innerWidth: 1280, location: { hash },
    matchMedia: () => motion,
    addEventListener(name, fn, options) { windowEvents[name] = { fn, options }; },
    scrollTo(options) { scrolls.push(options); window.scrollY = options.top; }
  };
  const motion = {
    matches: reduced,
    addEventListener(name, fn) { assert.equal(name, 'change'); motionChange = fn; }
  };
  const arrival = {
    offsetHeight: 1188,
    getBoundingClientRect: () => ({ top: -window.scrollY }),
    style: { setProperty: (name, value) => properties.set(name, String(value)) },
    classList: classList(arrivalClasses)
  };
  const stage = { offsetHeight: 900 };
  const pageLink = {};
  const space = { contains: target => target === pageLink };
  const anchorCalls = [];
  const anchor = {
    scrollIntoView(options) {
      anchorCalls.push(options);
      window.scrollY = 800;
      windowEvents.scroll.fn();
    }
  };
  const document = {
    documentElement: { classList: classList(classes) },
    querySelector: selector => ({ '.arrival': arrival, '.arrival-stage': stage, '#your-space': space, '.scroll-hint': scrollHint })[selector],
    getElementById: id => id === 'install' ? anchor : null,
    addEventListener(name, fn) { documentEvents[name] = fn; }
  };
  vm.runInNewContext(source, {
    window, document, CSS: { supports: () => supportsMask },
    requestAnimationFrame(fn) { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  function flush() {
    while (frames.size) {
      const [id, fn] = frames.entries().next().value;
      frames.delete(id);
      fn();
    }
  }
  function scroll(top) { window.scrollY = top; windowEvents.scroll.fn(); }
  return {
    frames, windowEvents, documentEvents, classes, arrivalClasses, properties,
    scrolls, window, arrival, stage, pageLink, anchorCalls, flush, scroll, scrollHint, timers,
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
    changeMotion(value) { motion.matches = value; motionChange(); }
  };
}

test('a short native scroll opens the page, and scrolling back restores the opening', () => {
  const h = harness();
  h.flush();
  assert.ok(h.classes.has('has-arrival'));
  assert.equal(h.properties.get('--aperture'), '0px');
  assert.equal(h.properties.get('--thought-opacity'), '1');
  assert.equal(h.scrolls.length, 0);
  assert.equal(h.windowEvents.scroll.options.passive, true);
  assert.equal(h.windowEvents.wheel, undefined);
  assert.equal(h.windowEvents.touchmove, undefined);

  h.scroll(144);
  h.flush();
  assert.ok(parseFloat(h.properties.get('--aperture')) > 400);
  assert.equal(h.properties.get('--thought-opacity'), '0');
  assert.equal(h.arrivalClasses.has('is-open'), false);
  h.scroll(288);
  h.flush();
  assert.ok(h.arrivalClasses.has('is-open'));
  assert.equal(h.properties.get('--noise-opacity'), '0');
  const endRadius = h.properties.get('--aperture');
  h.scroll(900);
  h.flush();
  assert.equal(h.properties.get('--aperture'), endRadius);
  h.scroll(0);
  h.flush();
  assert.equal(h.arrivalClasses.has('is-open'), false);
  assert.equal(h.properties.get('--thought-opacity'), '1');
});

test('scroll updates are coalesced into one animation frame', () => {
  const h = harness();
  h.flush();
  for (let i = 1; i <= 10; i++) h.scroll(i * 20);
  assert.equal(h.frames.size, 1);
  h.flush();
  assert.equal(h.frames.size, 0);
});

test('keyboard focus reveals the page rather than leaving controls behind the opening', () => {
  const h = harness();
  h.flush();
  h.documentEvents.focusin({ target: {} });
  assert.equal(h.scrolls.length, 0);
  h.documentEvents.focusin({ target: h.pageLink });
  assert.equal(h.scrolls[0].top, 288);
  assert.equal(h.scrolls[0].behavior, 'instant');
  h.flush();
  assert.ok(h.arrivalClasses.has('is-open'));
});

test('reduced motion uses the static page and responds to preference changes', () => {
  const h = harness({ reduced: true });
  assert.equal(h.classes.has('has-arrival'), false);
  assert.equal(h.frames.size, 0);
  assert.equal(h.properties.size, 0);
  h.changeMotion(false);
  h.flush();
  assert.ok(h.classes.has('has-arrival'));
  h.scroll(288);
  assert.equal(h.frames.size, 1);
  h.changeMotion(true);
  assert.equal(h.frames.size, 0);
  assert.equal(h.classes.has('has-arrival'), false);
  assert.equal(h.arrivalClasses.has('is-open'), false);
  h.documentEvents.focusin({ target: h.pageLink });
  assert.equal(h.scrolls.length, 0);
});

test('browsers without CSS masks keep the readable static opening', () => {
  const h = harness({ supportsMask: false });
  h.scroll(200);
  assert.equal(h.classes.has('has-arrival'), false);
  assert.equal(h.frames.size, 0);
});

test('resize remeasures the scroll distance and aperture', () => {
  const h = harness();
  h.flush();
  h.window.innerWidth = 390;
  h.stage.offsetHeight = 600;
  h.arrival.offsetHeight = 792;
  h.windowEvents.resize.fn();
  h.scroll(192);
  h.flush();
  assert.ok(h.arrivalClasses.has('is-open'));
  assert.ok(parseFloat(h.properties.get('--aperture')) > Math.hypot(390, 600) / 2);
});

test('direct installation links survive the enhanced layout', () => {
  const h = harness({ hash: '#install' });
  h.flush();
  assert.equal(h.anchorCalls.length, 1);
  assert.equal(h.anchorCalls[0].behavior, 'instant');
  assert.ok(h.arrivalClasses.has('is-open'));
});
