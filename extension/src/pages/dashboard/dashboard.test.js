'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { page, C3 } = require('../../tests/ui-harness.js');
const dashboard = (data, enabled) => page('dashboard', data, enabled);
test('dashboard rejects malformed history and intentions and surfaces runtime export failures', async () => {
  const p = dashboard(); await p.ready();
  p.state.replies.set('history', { ok: true }); p.refresh(); await p.ready();
  assert.equal(p.nodes.error.textContent, 'Unable to load history.');
  assert.equal(p.nodes['consume-min'].textContent, '1.0m');
  await p.nodes.export.fire('click');
  assert.equal(p.nodes.error.textContent, 'Unable to export history.'); assert.equal(p.blobs.length, 0);
  p.state.replies.set('access-history-list', { ok: true, intentions: {} });
  p.nodes['intentions-view'].fire('click'); await p.ready();
  assert.equal(p.nodes.error.textContent, 'Unable to load history.'); assert.equal(p.nodes['intention-list'].children.length, 0);
  p.state.replies.delete('history'); p.state.rejections.set('history', new Error('Worker disconnected.'));
  await p.nodes.export.fire('click');
  assert.equal(p.nodes.error.textContent, 'Worker disconnected.'); assert.equal(p.blobs.length, 0);
});
test('intention view shows newest first and renders text without interpreting HTML', async () => {
  const data = { settings: { intentionHistoryEnabled: true }, _intentions: [{ site: 'x', reason: 'Reply to a colleague', requestedAt: 1 }, { site: 'linkedin', reason: '<img src=x onerror=alert(1)>', requestedAt: 2 }] };
  const p = dashboard(data); await p.ready(); p.nodes['intentions-view'].fire('click'); await p.ready();
  assert.equal(p.nodes['ratio-panel'].hidden, true); assert.equal(p.nodes['intentions-panel'].hidden, false); assert.equal(p.nodes.export.hidden, true);
  assert.match(p.nodes['intention-status'].textContent, /Saving is on/);
  assert.match(p.nodes['intention-list'].children[0].children[0].textContent, /LinkedIn/);
  assert.equal(p.nodes['intention-list'].children[0].children[1].textContent, data._intentions[1].reason);
  assert.equal(p.nodes['intention-list'].children[0].children[1].children.length, 0);
  assert.equal(p.nodes['intention-empty'].hidden, true);
});
test('clearing intentions requires confirmation, handles failure, and preserves activity', async () => {
  const p = dashboard({ [C3.localDate()]: { x: { consumeSec: 60 } }, _intentions: [{ site: 'x', reason: 'Reply to a colleague', requestedAt: 1 }] }); await p.ready(); p.nodes['intentions-view'].fire('click'); await p.ready();
  assert.match(p.nodes['intention-status'].textContent, /Saving is off/);
  p.state.confirm = false; await p.nodes['intention-clear'].fire('click');
  assert.equal(p.messages.some(m => m.type === 'access-history-clear'), false);
  p.state.confirm = true; p.fail = true; await p.nodes['intention-clear'].fire('click');
  assert.equal(p.data._intentions.length, 1); assert.equal(p.nodes.error.textContent, 'Could not save.'); assert.equal(p.nodes['intention-clear'].disabled, false);
  p.fail = false; await p.nodes['intention-clear'].fire('click'); await p.ready();
  assert.deepEqual(p.data._intentions, []); assert.equal(p.nodes['intention-clear'].disabled, true); assert.equal(p.nodes['intention-empty'].hidden, false);
  assert.equal(p.data[C3.localDate()].x.consumeSec, 60);
});
test('switching to intentions requests only that view and leaves range-based history intact', async () => {
  const p = dashboard({ [C3.localDate()]: { x: { consumeSec: 60 } }, _websiteTime: { [C3.localDate()]: { 'example.com': 120 } }, _intentions: [{ site: 'x', reason: 'Reply to a colleague', requestedAt: 1 }] });
  p.nodes['intentions-view'].fire('click'); await p.ready();
  assert.equal(p.messages.at(-1).type, 'access-history-list');
  assert.equal(p.nodes['intention-list'].children.length, 1); assert.deepEqual(p.state.storageReads, []);
  p.nodes['websites-view'].fire('click'); await p.ready();
  assert.equal(p.nodes['website-total'].textContent, '2m 0s');
  p.nodes['ratio-view'].fire('click'); await p.ready();
  assert.equal(p.nodes['consume-min'].textContent, '1.0m');
  p.nodes['intentions-view'].fire('click'); await p.ready();
  p.data._intentions = []; p.change(); await p.ready();
  assert.equal(p.nodes['intention-list'].children.length, 0); assert.equal(p.nodes['intention-clear'].disabled, true);
});
test('dashboard preserves scores, actions, history and removed-integration totals', async () => {
  const p = dashboard(); await p.ready();
  assert.equal(p.nodes['consume-min'].textContent, '1.0m'); assert.equal(p.nodes['chart-table'].querySelector().children.length, 7);
  p.setDay({ retired: { consumeSec: 120, posts: 1, quotes: 1 } }); p.change(); await p.ready();
  assert.equal(p.nodes['consume-min'].textContent, '2.0m'); assert.equal(p.nodes.posts.textContent, 1); assert.equal(p.nodes.quotes.textContent, 1);
  assert.ok(p.nodes.sites.children.some(row => row.children[0].textContent === 'retired (unavailable)'));
});
test('dashboard charts use the same semantic colors as the time legend', async () => {
  const p = dashboard(); await p.ready();
  const bars = p.nodes.chart.children.filter(node => node.attributes.fill);
  assert.equal(bars.length, 14);
  assert.deepEqual(bars.map(node => node.attributes.fill), Array.from({ length: 7 }, () => ['var(--green)', 'var(--consume)']).flat());
});
test('all-websites view switches without changing the existing ratio view', async () => {
  const p = dashboard(); await p.ready(); p.nodes['websites-view'].fire('click'); await p.ready();
  assert.equal(p.nodes['ratio-panel'].hidden, true); assert.equal(p.nodes['websites-panel'].hidden, false);
  assert.equal(p.nodes.export.hidden, true); assert.equal(p.nodes['websites-view'].attributes['aria-pressed'], 'true');
  assert.equal(p.nodes['website-total'].textContent, '0s'); assert.match(p.nodes['website-status'].textContent, /off/);
  p.nodes['ratio-view'].fire('click'); assert.equal(p.nodes['ratio-panel'].hidden, false);
});
test('website filters show sorted rows and combined time, including paused totals', async () => {
  const today = C3.localDate(), lastWeek = C3.recentDates()[0];
  const p = dashboard({ _websiteTime: { [today]: { 'example.com': 120, 'x.com': 60 }, [lastWeek]: { 'x.com': 180 }, [C3.recentDates(30)[0]]: { 'older.test': 3600 } } }); await p.ready(); p.nodes['websites-view'].fire('click'); await p.ready();
  assert.equal(p.nodes['website-total'].textContent, '1h 6m'); assert.equal(p.nodes['website-count'].textContent, '3 websites');
  assert.equal(p.nodes['website-sites'].children[0].children[0].textContent, 'older.test'); assert.equal(p.nodes['website-export'].disabled, false);
  p.nodes['website-range'].value = 'week'; p.nodes['website-range'].fire('change'); await p.ready();
  assert.equal(p.nodes['website-total'].textContent, '6m 0s'); assert.equal(p.nodes['website-sites'].children[0].children[0].textContent, 'x.com');
  p.nodes['website-range'].value = 'today'; p.nodes['website-range'].fire('change'); await p.ready();
  assert.equal(p.nodes['website-total'].textContent, '3m 0s'); assert.equal(p.nodes['website-sites'].children[0].children[0].textContent, 'example.com'); assert.equal(p.nodes['website-count'].textContent, '2 websites');
});
test('dashboard exports both existing CSV formats without changing recorded history', async () => {
  const data = { [C3.localDate()]: { x: { consumeSec: 60 } }, _websiteTime: { [C3.localDate()]: { 'example.com': 120 } }, _intentions: [{ site: 'x', reason: 'Private intention text', requestedAt: 1 }] };
  const p = dashboard(data); await p.ready();
  await p.nodes.export.fire('click'); await p.nodes['website-export'].fire('click');
  assert.equal(p.state.downloads[0].filename, `CreateRatio-${C3.localDate()}.csv`);
  assert.equal(p.state.downloads[1].filename, `CreateRatio-websites-${C3.localDate()}.csv`);
  assert.match(await p.blobs[0].text(), /consume/); assert.match(await p.blobs[1].text(), /example\.com/); assert.deepEqual(p.data, data);
  for (const blob of p.blobs) assert.equal((await blob.text()).includes('Private intention text'), false);
});
test('dashboard downloads daily and weekly readable reports without changing history or exporting intentions', async () => {
  const today = C3.localDate(), first = C3.recentDates()[0], older = C3.recentDates(8)[0];
  const data = { [today]: { x: { createSec: 60, consumeSec: 120, posts: 1 } }, [first]: { retired: { createSec: 120 } }, [older]: { older: { createSec: 99999 } }, _intentions: [{ reason: 'Private intention text', site: 'x', requestedAt: 1 }] };
  const before = structuredClone(data), p = dashboard(data); await p.ready();
  p.nodes['report-range'].value = 'today';
  await p.nodes['report-export'].fire('click');
  assert.deepEqual(p.messages.at(-1), { type: 'history', kind: 'ratio', range: 'today' });
  assert.equal(p.state.downloads[0].filename, `CreateRatio-report-${today}.html`);
  assert.equal(p.blobs[0].type, 'text/html;charset=utf-8');
  const daily = await p.blobs[0].text();
  assert.match(daily, /<dt>Creating<\/dt><dd>1\.0m<\/dd>/);
  assert.match(daily, /<dt>Period creation score<\/dt><dd>1\.50<\/dd>/);
  assert.equal(daily.includes(first), false);
  p.nodes['report-range'].value = 'week';
  await p.nodes['report-export'].fire('click');
  assert.deepEqual(p.messages.at(-1), { type: 'history', kind: 'ratio', range: 'week' });
  assert.equal(p.state.downloads[1].filename, `CreateRatio-report-${first}-to-${today}.html`);
  const weekly = await p.blobs[1].text();
  assert.match(weekly, /<dt>Creating<\/dt><dd>3\.0m<\/dd>/);
  assert.match(weekly, /retired \(unavailable\)/);
  assert.equal(weekly.includes(older), false);
  for (const blob of p.blobs) assert.equal((await blob.text()).includes('Private intention text'), false);
  assert.deepEqual(p.data, before);
  assert.equal(p.nodes['report-export'].disabled, false);
});
for (const range of ['today', 'week']) for (const step of [2000, -2000]) {
  test(`${range} report rejects a history reply after the local date moves ${step > 0 ? 'forward' : 'backward'} and can be retried`, async () => {
    let now = (step > 0 ? new Date(2026, 11, 31, 23, 59, 59) : new Date(2027, 0, 1, 0, 0, 1)).getTime();
    const dates = C3.recentDates(range === 'today' ? 1 : 7, new Date(now));
    const days = Object.fromEntries(dates.map(date => [date, { x: { createSec: 120, consumeSec: 60, posts: 1 } }]));
    const p = page('dashboard', {}, false, { now: () => now }); await p.ready();
    p.nodes['report-range'].value = range;
    p.state.replies.set('history', { ok: true, days });
    const release = p.holdMessage('history');
    const exporting = p.nodes['report-export'].fire('click');
    now += step; release(); await exporting;
    assert.equal(p.blobs.length, 0, 'a rollover must not download an empty or truncated report');
    assert.deepEqual(p.state.downloads, []);
    assert.equal(p.nodes.error.textContent, 'The local date changed while loading history. Please try again.');
    assert.equal(p.nodes['report-export'].disabled, false);
    const today = C3.localDate(new Date(now));
    p.state.replies.set('history', { ok: true, days: { [today]: { x: { createSec: 180, consumeSec: 120 } } } });
    await p.nodes['report-export'].fire('click');
    assert.match(await p.blobs[0].text(), /<dt>Creating<\/dt><dd>3\.0m<\/dd>/);
    const selected = C3.recentDates(range === 'today' ? 1 : 7, new Date(now));
    assert.equal(p.state.downloads[0].filename, `CreateRatio-report-${selected[0]}${range === 'week' ? '-to-' + today : ''}.html`);
    assert.equal(p.nodes.error.hidden, true);
  });
}
test('a same-day delayed report keeps the date captured when export started', async () => {
  const started = new Date(2026, 5, 15, 9).getTime();
  let now = started;
  const p = page('dashboard', {}, false, { now: () => now }); await p.ready();
  p.state.replies.set('history', { ok: true, days: { [C3.localDate(new Date(started))]: { x: { createSec: 120 } } } });
  const release = p.holdMessage('history');
  const exporting = p.nodes['report-export'].fire('click');
  now += 3600000; release(); await exporting;
  assert.equal(p.blobs.length, 1);
  assert.ok((await p.blobs[0].text()).includes(`Generated locally on ${new Date(started).toLocaleString()}.`));
});
for (const range of ['today', 'week']) {
  test(`${range} report rejects a pre-reset history reply and retry exports only cleared history`, async () => {
    const now = new Date(2026, 5, 15, 12).getTime(), today = C3.localDate(new Date(now));
    const data = { [today]: { x: { createSec: 180, consumeSec: 60, posts: 1 } } };
    const p = page('dashboard', data, false, { now: () => now }); await p.ready();
    p.nodes['report-range'].value = range;
    p.state.replies.set('history', { ok: true, days: structuredClone(data) });
    const release = p.holdMessage('history');
    const exporting = p.nodes['report-export'].fire('click');
    delete data[today];
    p.change({ _historyGeneration: { oldValue: 'before-clear', newValue: 'after-clear' }, _historyReset: { oldValue: false, newValue: true } });
    await p.ready(); release(); await exporting;
    assert.equal(p.blobs.length, 0, 'cleared activity must never become an HTML download');
    assert.deepEqual(p.state.downloads, []);
    assert.equal(p.nodes.error.textContent, 'History changed while loading. Please try again.');
    assert.equal(p.nodes['report-export'].disabled, false);
    p.state.replies.delete('history');
    await p.nodes['report-export'].fire('click');
    assert.equal(p.blobs.length, 1);
    assert.match(await p.blobs[0].text(), /<dt>Creating<\/dt><dd>0\.0m<\/dd>/);
    assert.equal(p.nodes.error.hidden, true);
  });
}
test('receipt-window rollover does not cancel an in-flight HTML snapshot', async () => {
  const now = new Date(2026, 5, 15, 12).getTime(), today = C3.localDate(new Date(now));
  const p = page('dashboard', {}, false, { now: () => now }); await p.ready();
  p.state.replies.set('history', { ok: true, days: { [today]: { x: { createSec: 180 } } } });
  const release = p.holdMessage('history'), exporting = p.nodes['report-export'].fire('click');
  p.change({ _historyGeneration: { oldValue: 'before-rollover', newValue: 'after-rollover' }, _receipts: { newValue: ['new-packet'] } });
  await p.ready(); release(); await exporting;
  assert.equal(p.blobs.length, 1);
  assert.match(await p.blobs[0].text(), /<dt>Creating<\/dt><dd>3\.0m<\/dd>/);
});
test('report export prevents duplicate requests and recovers after loading failures', async () => {
  const p = dashboard(); await p.ready(); p.nodes['report-range'].value = 'today';
  const release = p.holdMessage('history'), before = p.messages.length;
  const exporting = p.nodes['report-export'].fire('click');
  assert.equal(p.nodes['report-export'].disabled, true);
  await p.nodes['report-export'].fire('click');
  assert.equal(p.messages.length, before + 1);
  release(); await exporting;
  p.state.replies.set('history', { ok: true });
  await p.nodes['report-export'].fire('click');
  assert.equal(p.blobs.length, 1);
  assert.equal(p.nodes.error.textContent, 'Unable to export report.');
  assert.equal(p.nodes['report-export'].disabled, false);
  p.state.replies.delete('history');
  p.state.rejections.set('history', new Error('Worker disconnected.'));
  await p.nodes['report-export'].fire('click');
  assert.equal(p.blobs.length, 1);
  assert.equal(p.nodes.error.textContent, 'Worker disconnected.');
  p.state.rejections.delete('history');
  await p.nodes['report-export'].fire('click');
  assert.equal(p.blobs.length, 2);
  assert.equal(p.nodes.error.hidden, true);
});
test('repeated report downloads retain only one temporary URL and release it after ten seconds', async () => {
  const p = dashboard(); await p.ready();
  for (let i = 0; i < 5; i++) {
    await p.nodes['report-export'].fire('click');
    assert.equal(p.timeouts.size, 1);
    assert.equal(p.revokedURLs.length, i);
    assert.equal([...p.timeouts.values()][0].ms, 10000);
  }
  p.runTimeout([...p.timeouts.keys()][0]);
  assert.equal(p.timeouts.size, 0);
  assert.deepEqual(p.revokedURLs, p.state.downloads.map(download => download.url));
});
test('share-card history failures never expose a stale preview and allow retrying', async () => {
  const p = dashboard(); await p.ready();
  p.state.replies.set('history', { ok: true });
  await p.nodes['share-create'].fire('click');
  assert.equal(p.nodes.error.textContent, 'Unable to create share card.');
  assert.equal(p.nodes['share-result'].hidden, true);
  assert.equal(p.nodes['share-download'].disabled, true);
  assert.equal(p.nodes['share-create'].disabled, false);
  assert.equal(p.blobs.length, 0);
  p.state.replies.delete('history');
  p.state.rejections.set('history', new Error('Worker disconnected.'));
  await p.nodes['share-create'].fire('click');
  assert.equal(p.nodes.error.textContent, 'Worker disconnected.');
  assert.equal(p.nodes['share-create'].disabled, false);
});
test('dashboard distinguishes creation-score measurements from all-site browsing time', () => {
  const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  assert.match(html, /id="ratio-view"[^>]*>Creation score/); assert.match(html, /id="websites-view"[^>]*>Website time/);
  assert.match(html, /No creating\/consuming classification or actions; never affects your creation score/);
  assert.match(html, /vetted sites only/); assert.match(html, /two must not be added together/);
});
test('dashboard sends no preference messages or permission requests', async () => {
  const p = dashboard(); await p.ready(); p.refresh(); await p.ready();
  assert.ok(p.messages.every(m => ['snapshot', 'history'].includes(m.type))); assert.equal(p.state.requested, 0);
  assert.ok(p.messages.filter(m => m.type === 'history').every(m => m.kind === 'ratio' && m.range === 'week'));
  assert.deepEqual(p.state.storageReads, []);
  assert.equal(p.nodes['access-minutes'], undefined); assert.equal(p.nodes['website-time-enabled'], undefined);
});
test('a view switch during history loading discards the stale render and loads the selected view', async () => {
  const p = dashboard({ [C3.localDate()]: { x: { consumeSec: 60 } }, _intentions: [{ site: 'x', reason: 'Reply to a colleague', requestedAt: 1 }] });
  await p.ready();
  const release = p.holdMessage('history'), before = p.messages.length;
  p.setDay({ x: { consumeSec: 120, posts: 1 } }); p.refresh(); await p.ready();
  p.nodes['intentions-view'].fire('click'); await p.ready();
  assert.equal(p.nodes['intention-list'].children.length, 0);
  release(); await p.ready();
  assert.equal(p.nodes['consume-min'].textContent, '1.0m');
  assert.equal(p.nodes['intention-list'].children[0].children[1].textContent, 'Reply to a colleague');
  assert.deepEqual(p.messages.slice(before), [
    { type: 'snapshot' }, { type: 'history', kind: 'ratio', range: 'week' },
    { type: 'snapshot' }, { type: 'access-history-list' }
  ]);
});
test('website export requires a successful snapshot while ratio export only loads history', async () => {
  const p = dashboard(); await p.ready();
  p.state.failSnapshot = true;
  const before = p.messages.length;
  await p.nodes['website-export'].fire('click');
  assert.deepEqual(p.messages.slice(before), [{ type: 'snapshot' }]);
  assert.equal(p.blobs.length, 0); assert.deepEqual(p.state.downloads, []);
  assert.equal(p.nodes.error.textContent, 'Could not save.');
  await p.nodes.export.fire('click');
  assert.deepEqual(p.messages.at(-1), { type: 'history', kind: 'ratio', range: 'month' });
  assert.equal(p.state.downloads[0].filename, `CreateRatio-${C3.localDate()}.csv`);
  assert.equal(p.nodes.error.hidden, true);
});
