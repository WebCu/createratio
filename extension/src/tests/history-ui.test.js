'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page, C3 } = require('./ui-harness.js');
test('popup and dashboard use a neutral score for a fresh day and retain score colours for recorded activity', async () => {
  for (const name of ['popup', 'dashboard']) {
    const p = page(name, {}); await p.ready();
    assert.equal(p.nodes.score.textContent, '0.00');
    assert.equal(p.nodes.score.style.color, '');
    assert.match(p.nodes['score-status'].textContent, /fresh start/i);
    p.setDay({ x: { consumeSec: 60 } }); p.refresh(); await p.ready();
    assert.equal(p.nodes.score.style.color, C3.scoreColor(0));
    p.setDay({ x: { consumeSec: 60, posts: 1 } }); p.refresh(); await p.ready();
    assert.equal(p.nodes.score.style.color, C3.scoreColor(2));
    p.setDay({}); p.refresh(); await p.ready();
    assert.equal(p.nodes.score.style.color, '');
  }
});
test('Settings exports both retained histories in the existing CSV formats', async () => {
  const today = C3.localDate();
  const data = { [today]: { retired: { consumeSec: 60, posts: 1 } }, _websiteTime: { [today]: { 'example.com': 120 } } };
  const p = page('settings', data); await p.ready();
  await p.nodes['export-ratio'].fire('click'); await p.nodes['export-websites'].fire('click');
  assert.deepEqual(p.state.downloads.map(download => download.filename), [`CreateRatio-${today}.csv`, `CreateRatio-websites-${today}.csv`]);
  assert.match(await p.blobs[0].text(), /retired/); assert.match(await p.blobs[1].text(), /example\.com/);
  assert.deepEqual(p.data, data); assert.equal(p.nodes['export-ratio'].disabled, false);
});
test('clearing activity history keeps intention history separately reviewable', async () => {
  const intentions = [{ site: 'x', reason: 'Reply to a colleague', requestedAt: 1 }];
  const p = page('settings', { [C3.localDate()]: { x: { posts: 1 } }, _intentions: intentions }); await p.ready();
  await p.nodes['clear-history'].fire('click');
  assert.equal(p.data[C3.localDate()], undefined); assert.deepEqual(p.data._intentions, intentions);
});
test('cancelling Clear history does not send a destructive message', async () => {
  const p = page('settings'); await p.ready(); p.state.confirm = false;
  await p.nodes['clear-history'].fire('click');
  assert.equal(p.state.confirmations.length, 1); assert.match(p.state.confirmations[0], /cannot be undone/);
  assert.equal(p.messages.some(message => message.type === 'clear-history'), false);
  assert.equal(p.data[C3.localDate()].x.consumeSec, 60);
});
test('confirmed clearing removes both histories, not settings, and restores the control', async () => {
  const p = page('settings', { [C3.localDate()]: { x: { posts: 1 } }, _websiteTime: { [C3.localDate()]: { 'example.com': 120 } }, settings: { accessMinutes: 12 } });
  await p.ready(); await p.nodes['clear-history'].fire('click');
  assert.equal(p.data[C3.localDate()], undefined); assert.equal(p.data._websiteTime, undefined);
  assert.equal(p.data.settings.accessMinutes, 12); assert.equal(p.nodes['clear-history'].disabled, false);
  assert.match(p.nodes['save-status'].textContent, /History cleared/);
});
test('failed clearing or export reports errors without changing stored history or downloading', async () => {
  const p = page('settings'); await p.ready(); p.fail = true;
  await p.nodes['clear-history'].fire('click'); assert.equal(p.data[C3.localDate()].x.consumeSec, 60);
  assert.equal(p.nodes['clear-history'].disabled, false); assert.equal(p.nodes.error.textContent, 'Could not save.');
  await p.nodes['export-ratio'].fire('click');
  assert.deepEqual(p.state.downloads, []); assert.equal(p.nodes['export-ratio'].disabled, false);
});
test('dashboard requests only the active website range and refreshes after a rapid switch', async () => {
  const p = page('dashboard', { _websiteTime: { [C3.localDate()]: { 'example.com': 120 } } });
  p.nodes['websites-view'].fire('click'); await p.ready();
  assert.equal(p.nodes['website-total'].textContent, '2m 0s');
  p.nodes['website-range'].value = 'today'; p.nodes['website-range'].fire('change'); await p.ready();
  assert.deepEqual(p.messages.filter(message => message.type === 'history').at(-1), { type: 'history', kind: 'websites', range: 'today' });
  assert.deepEqual(p.state.storageReads, ['_pendingUpdate']);
});
test('storage changes caused by a snapshot do not create a refresh feedback loop', async () => {
  const p = page('dashboard'); await p.ready();
  p.state.snapshotChanges = true; const before = p.messages.length;
  p.refresh(); await p.ready(); await p.ready();
  assert.equal(p.messages.length - before, 2);
});
test('an empty selected website range does not disable exporting other retained days', async () => {
  const older = C3.recentDates(30)[0];
  const p = page('dashboard', { _websiteTime: { [older]: { 'older.test': 120 } } }); await p.ready();
  p.nodes['websites-view'].fire('click'); await p.ready();
  p.nodes['website-range'].value = 'today'; p.nodes['website-range'].fire('change'); await p.ready();
  assert.equal(p.nodes['website-total'].textContent, '0s'); assert.equal(p.nodes['website-export'].disabled, false);
  await p.nodes['website-export'].fire('click'); assert.match(await p.blobs[0].text(), /older\.test/);
});
