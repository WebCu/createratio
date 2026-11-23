'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page, accessState } = require('./ui-harness.js');

async function gate() {
  const ui = page('blocked');
  ui.state.access.x = accessState('x');
  await ui.ready();
  ui.messages.length = 0;
  ui.refresh();
  await ui.ready();
  return ui;
}

const statusCount = ui => ui.messages.filter(message => message.type === 'access-status').length;

test('blocked page pauses hidden polling and refreshes on visibility before resuming polls', async () => {
  const ui = await gate();
  assert.equal(statusCount(ui), 1);
  ui.visible(false);
  for (let tick = 0; tick < 6; tick++) {
    ui.timer(5000);
    await ui.ready();
  }
  assert.equal(statusCount(ui), 1);
  ui.visible(true);
  await ui.ready();
  assert.equal(statusCount(ui), 2);
  for (let tick = 0; tick < 3; tick++) {
    ui.timer(5000);
    await ui.ready();
    assert.equal(statusCount(ui), 3 + tick);
  }
});

test('hidden blocked page still refreshes on storage changes and focus', async () => {
  const ui = await gate();
  ui.visible(false);
  ui.state.access.x = accessState('x', { readyAt: Date.now() + 60000 });
  ui.change({ _access: { newValue: {} } });
  await ui.ready();
  assert.equal(statusCount(ui), 2);
  assert.equal(ui.nodes.waiting.hidden, false);
  ui.state.access.x = accessState('x');
  ui.refresh();
  await ui.ready();
  assert.equal(statusCount(ui), 3);
  assert.equal(ui.nodes.waiting.hidden, true);
});

test('visible blocked page renders wait expiry locally and reconciles session expiry by polling', async () => {
  let now = Date.now();
  const ui = page('blocked', {}, false, { now: () => now });
  ui.state.access.x = accessState('x', { readyAt: now + 1000 });
  await ui.ready();
  ui.messages.length = 0;
  ui.refresh();
  await ui.ready();
  assert.equal(ui.nodes.open.disabled, true);
  now += 1000;
  ui.timer(1000);
  assert.equal(ui.nodes.open.disabled, false);
  assert.equal(statusCount(ui), 1);
  ui.state.access.x = accessState('x', { remainingMs: 1000, expiresAt: now + 1000 });
  ui.timer(5000);
  await ui.ready();
  assert.equal(ui.nodes.active.hidden, false);
  now += 1000;
  ui.state.access.x = accessState('x');
  ui.timer(5000);
  await ui.ready();
  assert.equal(ui.nodes.active.hidden, true);
  assert.equal(ui.nodes.request.hidden, false);
});

test('visible polling recovers after an access-status error', async () => {
  const ui = await gate();
  ui.state.fail = true;
  ui.timer(5000);
  await ui.ready();
  assert.equal(ui.nodes.error.textContent, 'Could not save.');
  ui.state.fail = false;
  ui.timer(5000);
  await ui.ready();
  assert.equal(statusCount(ui), 3);
  assert.equal(ui.nodes.error.hidden, true);
});
