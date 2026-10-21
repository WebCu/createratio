'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ScrollFriction = require('./scroll-friction.js');

class Element {
  constructor(name, { scrollHeight = 0, clientHeight = 0, scrollWidth = 0, clientWidth = 0, overflowY = 'visible', overflowX = 'visible', contentEditable = false, dialog = false } = {}) {
    Object.assign(this, { name, scrollHeight, clientHeight, scrollWidth, clientWidth, overflowY, overflowX, isContentEditable: contentEditable, dialog });
    this.scrollTop = 0; this.scrollLeft = 0; this.moves = [];
  }
  matches(selector) { return this.dialog && selector.split(',').includes('dialog'); }
  scrollBy({ top = 0, left = 0 }) { this.moves.push({ top, left }); this.scrollTop += top; this.scrollLeft += left; }
}

function setup({ root, body, chain = [], active = null, viewport = 800 }) {
  const documentElement = new Element('html', { scrollHeight: viewport, clientHeight: viewport });
  const path = [...chain, body, documentElement];
  const document = {
    scrollingElement: root, documentElement, body, activeElement: active, listener: null, passive: null,
    addEventListener(type, listener, options) { if (type === 'wheel') { this.listener = listener; this.passive = options?.passive; } },
    removeEventListener(type) { if (type === 'wheel') this.listener = null; }
  };
  const getComputedStyle = node => ({ overflowY: node?.overflowY || 'visible', overflowX: node?.overflowX || 'visible' });
  const friction = ScrollFriction.create({ document, Element, getComputedStyle });
  function wheel({ deltaY, deltaX = 0, deltaMode = 0, ...overrides }) {
    const event = {
      isTrusted: true, cancelable: true, defaultPrevented: false, deltaX, deltaY, deltaMode,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, prevented: 0,
      preventDefault() { this.prevented++; this.defaultPrevented = true; },
      composedPath: () => [...path], ...overrides
    };
    document.listener(event);
    return event;
  }
  return { friction, document, documentElement, wheel };
}

function documentScroller({ scrollHeight = 5000, clientHeight = 800 } = {}) {
  const root = new Element('html', { scrollHeight, clientHeight, overflowY: 'auto' });
  root.scrollTop = 1000;
  return root;
}
function appShell(viewport = 540) {
  return { root: new Element('html', { scrollHeight: viewport, clientHeight: viewport }), body: new Element('body', { overflowY: 'hidden' }), viewport };
}

test('a document-scrolled page slows by the configured resistance', () => {
  const root = documentScroller(), body = new Element('body'), item = new Element('div');
  const h = setup({ root, body, chain: [item] });
  h.friction.setSpeed(0.5);
  assert.equal(h.document.passive, false, 'friction listens non-passively');
  const event = h.wheel({ deltaY: 240 });
  assert.equal(event.prevented, 1);
  assert.deepEqual(root.moves, [{ top: 120, left: 0 }]);
  assert.equal(root.scrollTop, 1120);
});

test('an app-shell page slows its own surface when the document cannot scroll', () => {
  const { root, body, viewport } = appShell();
  const workspace = new Element('main', { scrollHeight: 4200, clientHeight: 520, overflowY: 'auto' });
  workspace.scrollTop = 400;
  const h = setup({ root, body, chain: [new Element('div'), workspace], viewport });
  h.friction.setSpeed(0.5);
  const event = h.wheel({ deltaY: 100 });
  assert.equal(event.prevented, 1);
  assert.deepEqual(workspace.moves, [{ top: 50, left: 0 }]);
  assert.deepEqual(root.moves, []);
});

test('nested panels keep native scrolling, with or without a document scroll range', () => {
  const scenarios = [
    ['document scrolls', () => ({ root: documentScroller(), body: new Element('body'), pane: null, viewport: 800 })],
    ['app shell', () => ({ ...appShell(), pane: new Element('main', { scrollHeight: 4200, clientHeight: 520, overflowY: 'auto' }) })]
  ];
  for (const [label, build] of scenarios) {
    const { root, body, pane, viewport } = build();
    const panel = new Element('aside', { scrollHeight: 2000, clientHeight: 200, overflowY: 'auto' });
    const h = setup({ root, body, chain: pane ? [panel, pane] : [panel], viewport });
    h.friction.setSpeed(0.5);
    const event = h.wheel({ deltaY: 240 });
    assert.equal(event.prevented, 0, label);
    assert.deepEqual(panel.moves, [], label);
    assert.deepEqual(root.moves, [], label);
    assert.deepEqual(pane?.moves || [], [], label);
  }
});

test('a surface that fills less than half the viewport is a panel, not the page', () => {
  const { root, body, viewport } = appShell();
  const halfHeight = new Element('main', { scrollHeight: 4000, clientHeight: Math.floor(viewport / 2) - 1, overflowY: 'auto' });
  const h = setup({ root, body, chain: [halfHeight], viewport });
  h.friction.setSpeed(0.5);
  assert.equal(h.wheel({ deltaY: 120 }).prevented, 0);
  assert.deepEqual(halfHeight.moves, []);
});

test('an app-shell surface stops at its own boundaries instead of stealing the gesture', () => {
  const { root, body, viewport } = appShell();
  const workspace = new Element('main', { scrollHeight: 1000, clientHeight: 500, overflowY: 'auto' });
  workspace.scrollTop = 500;
  const h = setup({ root, body, chain: [workspace], viewport });
  h.friction.setSpeed(0.5);
  const event = h.wheel({ deltaY: 120 });
  assert.equal(event.prevented, 0);
  assert.deepEqual(workspace.moves, []);
});

test('editors, dialogs and horizontal panes stay native', () => {
  const body = new Element('body');
  const editor = new Element('div', { contentEditable: true });
  const dialog = new Element('div', { dialog: true });
  const horizontal = new Element('div', { scrollWidth: 2000, clientWidth: 200, overflowX: 'auto' });
  for (const [label, chain, active, gesture] of [
    ['focused editor', [], editor, { deltaY: 240 }],
    ['editor in path', [editor], null, { deltaY: 240 }],
    ['dialog in path', [dialog], null, { deltaY: 240 }],
    ['horizontal gesture', [horizontal], null, { deltaY: 120, deltaX: 100 }]
  ]) {
    const h = setup({ root: documentScroller(), body, chain, active });
    h.friction.setSpeed(0.5);
    assert.equal(h.wheel(gesture).prevented, 0, label);
  }
});

test('fractional movement accumulates on the promoted surface', () => {
  const { root, body, viewport } = appShell();
  const workspace = new Element('main', { scrollHeight: 4200, clientHeight: 520, overflowY: 'auto' });
  workspace.scrollTop = 300;
  const h = setup({ root, body, chain: [workspace], viewport });
  h.friction.setSpeed(0.5);
  h.wheel({ deltaY: 3 });
  h.wheel({ deltaY: 3 });
  assert.deepEqual(workspace.moves.map(move => move.top), [1, 2]);
  assert.equal(workspace.scrollTop, 303);
});

test('wheel input stays untouched while resistance is off', () => {
  const root = documentScroller(), body = new Element('body');
  const h = setup({ root, body });
  assert.equal(h.document.listener, null);
  h.friction.setSpeed(1);
  assert.equal(h.document.listener, null);
});
