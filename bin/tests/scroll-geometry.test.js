'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require.resolve('../scroll-geometry.js'), 'utf8');

function collect(depth = 2) {
  let root, leaf;
  const style = { overflowX: 'hidden', overflowY: 'auto', contain: 'layout paint', contentVisibility: 'visible', containerType: 'inline-size scroll-state' };
  const guarded = value => new Proxy(value, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `unexpected diagnostic read: ${String(key)}`);
    return target[key];
  } });
  for (let i = 0; i < depth; i++) {
    leaf = guarded({ tagName: i ? 'PRIVATE-ACCOUNT-ID' : 'HTML', parentElement: leaf || null, clientHeight: 800, scrollHeight: 20000, clientWidth: 1280, scrollWidth: 1280, scrollTop: 1000.12345 });
    root ||= leaf;
  }
  const document = guarded({ elementFromPoint: (x, y) => { assert.deepEqual([x, y], [640, 400]); return leaf; }, scrollingElement: root });
  return JSON.parse(vm.runInNewContext(source, { document, innerWidth: 1280, innerHeight: 800, getComputedStyle: () => guarded(style) }));
}

test('geometry diagnostic reads only approved numeric geometry and enumerated styles', () => {
  const result = collect();
  assert.deepEqual(Object.keys(result), ['version', 'viewport', 'nodes', 'truncated']);
  assert.deepEqual(result.viewport, { width: 1280, height: 800 });
  assert.deepEqual(result.nodes[0], { tag: 'OTHER', root: false, clientHeight: 800, scrollHeight: 20000, clientWidth: 1280, scrollWidth: 1280, scrollTop: 1000.123, overflowX: 'hidden', overflowY: 'auto', contain: 'layout paint', contentVisibility: 'visible', containerType: 'inline-size scroll-state' });
  assert.equal(result.nodes[1].root, true);
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('geometry diagnostic bounds ancestry and handles empty hit tests', () => {
  assert.equal(collect(40).nodes.length, 32);
  assert.equal(collect(40).truncated, true);
  assert.deepEqual(collect(0).nodes, []);
});

test('geometry diagnostic suppresses unknown style strings and nonfinite numbers', () => {
  const node = { tagName: 'DIV', clientHeight: Infinity, parentElement: null };
  const result = JSON.parse(vm.runInNewContext(source, { document: { elementFromPoint: () => node }, innerWidth: 1, innerHeight: 1, getComputedStyle: () => ({ overflowX: 'PRIVATE', contain: 'layout PRIVATE', containerType: 'PRIVATE' }) }));
  assert.equal(result.nodes[0].clientHeight, null);
  assert.equal(result.nodes[0].overflowX, null);
  assert.equal(result.nodes[0].contain, null);
  assert.equal(result.nodes[0].containerType, null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
