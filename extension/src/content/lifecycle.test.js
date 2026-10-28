'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function client() {
  const listeners = new Set();
  const api = { runtime: { id: 'extension', onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } } } };
  let expire;
  const context = vm.createContext({ chrome: api, setTimeout(fn) { expire = fn; return 1; }, clearTimeout() { expire = null; } });
  const source = fs.readFileSync(path.join(__dirname, 'lifecycle.js'), 'utf8');
  vm.runInContext(source, context);
  return { lifecycle: context.ContentLifecycle, listeners, expire() { expire(); }, reload() { vm.runInContext(source, context); }, send(message, id = 'extension') { return new Promise(resolve => { for (const listener of listeners) listener(message, { id }, resolve); }); } };
}

test('update preparation drains all owners and resumes everyone if any owner cannot save', async () => {
  const c = client(); let paused = false;
  c.lifecycle.register('guard', { async prepare() { paused = true; return true; }, resume() { paused = false; }, stop() {} });
  c.lifecycle.register('tracker', { async prepare() { throw new Error('Storage unavailable'); }, resume() {}, stop() {} });
  const reply = await c.send({ type: 'prepare-update' });
  assert.equal(reply.ready, false); assert.equal(paused, false);
});

test('a lost worker or cancelled preparation cannot leave trackers paused or commit stale readiness', async () => {
  const c = client(); let paused = false, release;
  c.lifecycle.register('tracker', { async prepare() { paused = true; await new Promise(resolve => { release = resolve; }); return true; }, resume() { paused = false; }, stop() {} });
  const preparing = c.send({ type: 'prepare-update' });
  assert.equal(paused, true); c.expire(); assert.equal(paused, false);
  release(); assert.equal((await preparing).ready, false);
  assert.equal((await c.send({ type: 'commit-update' })).ready, false);
  assert.equal(c.listeners.size, 1);
});

test('overlapping preparation cannot replace an unfinished readiness decision', async () => {
  const c = client(); let release, first = true;
  c.lifecycle.register('tracker', { async prepare() { if (first) { first = false; await new Promise(resolve => { release = resolve; }); } return true; }, resume() {}, stop() {} });
  const pending = c.send({ type: 'prepare-update' });
  try { assert.equal((await c.send({ type: 'prepare-update' })).ready, false); }
  finally { await c.send({ type: 'resume-update' }); release(); await pending; }
  assert.equal((await c.send({ type: 'commit-update' })).ready, false);
});

test('repeated injection has one message listener and commit releases all old owners', async () => {
  const c = client(); let stopped = 0;
  c.lifecycle.register('guard', { async prepare() { return true; }, resume() {}, stop() { stopped++; } });
  c.reload(); assert.equal(c.listeners.size, 1);
  assert.equal((await c.send({ type: 'prepare-update' })).ready, true);
  assert.equal((await c.send({ type: 'commit-update' })).ready, true);
  assert.equal(stopped, 1); assert.equal(c.listeners.size, 0);
});
