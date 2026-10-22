import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluate, eventually, click, waitForEnabledControl } from '../extension/browser-tests/chromium.mjs';
import { sampleOwnedMemory } from './native-process-memory.mjs';

export const workload = {
  version: 1, localDate: [2026, 2, 9, 12], settleMs: 250, maximumSnapshotAttempts: 3,
  pilot: { tabs: 2, cycles: 2 }, comparison: { tabs: 8, cycles: 12 },
  operations: ['changing synthetic storage totals', 'PNG previews in every dashboard', 'HTML download in active dashboard', 'alternating today/week selection', 'history clear and navigation every two cycles'],
  sampling: 'Active dashboard isolate after forced GC, then owned process tree after fixed settlement; no retained Blob, image or canvas handles'
};

export function checkpointPlan(mode) {
  const { cycles } = workload[mode];
  return [
    { phase: 'ready', cycle: 0 },
    ...[...new Set([1, cycles / 2, cycles])].map(cycle => ({ phase: 'populated', cycle })),
    ...['period-cleared', 'history-cleared', 'navigated'].map(phase => ({ phase, cycle: cycles }))
  ];
}

export function syntheticHistory(cycle) {
  assert.ok(Number.isSafeInteger(cycle) && cycle >= 1 && cycle <= 12, 'Invalid workload cycle');
  return {
    '2026-03-03': { linkedin: { createSec: cycle * 120, consumeSec: 180, posts: cycle } },
    '2026-03-09': { x: { createSec: cycle * 60, consumeSec: 60, replies: cycle } }
  };
}

export async function exerciseDashboard(browser, root, mode) {
  const config = workload[mode];
  assert.ok(config, 'Unknown workload mode');
  await browser.setTime(new Date(...workload.localDate).getTime());
  const inspect = (page, source) => evaluate(browser, page.session, source);
  const settings = await browser.page(browser.origin + '/settings.html');
  await waitForEnabledControl(browser, settings, '#clear-history');
  const pages = [];
  const ready = async page => {
    await eventually(() => inspect(page, 'document.readyState === "complete" && !!document.querySelector("#score")?.textContent'), 'generated dashboard loaded');
    await waitForEnabledControl(browser, page, '#share-create');
    await waitForEnabledControl(browser, page, '#report-export');
  };
  for (let index = 0; index < config.tabs; index++) {
    const page = await browser.page(browser.origin + '/dashboard.html');
    await ready(page);
    pages.push(page);
  }
  const active = pages.at(-1);
  const checkpoints = [];
  const sample = async (phase, cycle) => {
    await browser.cdp.send('HeapProfiler.collectGarbage', {}, active.session);
    const heap = await browser.cdp.send('Runtime.getHeapUsage', {}, active.session);
    const discardedSnapshots = [];
    for (let attempt = 1; attempt <= workload.maximumSnapshotAttempts; attempt++) {
      await delay(workload.settleMs);
      try {
        const processMemory = await sampleOwnedMemory(root);
        checkpoints.push({ phase, cycle, activeIsolateHeapBytes: heap.usedSize, processMemory, discardedSnapshots });
        return;
      } catch (error) {
        const transient = ['ENOENT', 'ESRCH'].includes(error.code) || /Process identity changed during sampling|Owned process tree changed during sampling/.test(error.message);
        if (!transient || attempt === workload.maximumSnapshotAttempts) throw error;
        discardedSnapshots.push({ attempt, reason: error.message });
      }
    }
  };
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: browser.directory, eventsEnabled: true });
  const downloadReport = async () => {
    let guid, completed = false, canceled = false;
    const begin = browser.cdp.on('Browser.downloadWillBegin', event => { guid = event.guid; });
    const progress = browser.cdp.on('Browser.downloadProgress', event => {
      if (event.guid === guid) { completed = event.state === 'completed'; canceled = event.state === 'canceled'; }
    });
    try {
      await waitForEnabledControl(browser, active, '#report-export');
      await click(browser, active, '#report-export');
      await eventually(() => {
        assert.equal(canceled, false, 'HTML download canceled');
        return completed;
      }, 'HTML export download');
      await unlink(join(browser.directory, guid));
    } finally { begin(); progress(); }
  };
  const period = async (page, value) => {
    await waitForEnabledControl(browser, page, '#report-range');
    await inspect(page, `(() => { const control = document.querySelector('#report-range'); control.value = ${JSON.stringify(value)}; control.dispatchEvent(new Event('change')); })()`);
    await eventually(() => inspect(page, 'document.querySelector("#share-result").hidden'), 'period discards preview');
  };
  const clear = async () => {
    const result = await inspect(settings, 'chrome.runtime.sendMessage({ type: "clear-history" })');
    assert.equal(result.ok, true, 'Real history clear failed');
    await eventually(async () => (await evaluate(browser, browser.worker, 'chrome.storage.local.get("_historyGeneration")'))._historyGeneration, 'history generation persisted');
    for (const page of pages) await eventually(() => inspect(page, 'document.querySelector("#share-result").hidden && document.querySelector("#score").textContent === "0.00"'), 'history clear visible');
  };
  const navigate = async () => {
    for (const page of pages) {
      await browser.cdp.send('Page.navigate', { url: browser.origin + '/settings.html' }, page.session);
      await waitForEnabledControl(browser, page, '#clear-history');
      await browser.cdp.send('Page.navigate', { url: browser.origin + '/dashboard.html' }, page.session);
      await ready(page);
    }
  };
  const previews = async (value, cycle) => {
    for (const page of pages) {
      await period(page, value);
      await waitForEnabledControl(browser, page, '#share-create');
      await click(browser, page, '#share-create');
      await eventually(() => inspect(page, `!document.querySelector('#share-result').hidden && !document.querySelector('#share-create').disabled && document.querySelector('#share-preview').getAttribute('aria-label').includes('${cycle * (value === 'today' ? 1 : 3)}m creating')`), 'changed synthetic PNG preview ready');
    }
  };
  await sample('ready', 0);
  const generations = [];
  for (let cycle = 1; cycle <= config.cycles; cycle++) {
    await evaluate(browser, browser.worker, `chrome.storage.local.set(${JSON.stringify(syntheticHistory(cycle))})`);
    const value = cycle % 2 ? 'today' : 'week';
    await previews(value, cycle);
    await downloadReport();
    if ([1, config.cycles / 2, config.cycles].includes(cycle)) await sample('populated', cycle);
    for (const page of pages) await period(page, value === 'today' ? 'week' : 'today');
    if (cycle === config.cycles) {
      await sample('period-cleared', cycle);
      await previews(value === 'today' ? 'week' : 'today', cycle);
    }
    if (cycle % 2 === 0) {
      const before = await evaluate(browser, browser.worker, 'chrome.storage.local.get("_historyGeneration")');
      await clear();
      const after = await evaluate(browser, browser.worker, 'chrome.storage.local.get("_historyGeneration")');
      assert.notEqual(after._historyGeneration, before._historyGeneration, 'History generation must change');
      generations.push({ cycle, changed: true });
      if (cycle === config.cycles) await sample('history-cleared', cycle);
      await navigate();
      if (cycle === config.cycles) await sample('navigated', cycle);
    }
  }
  assert.deepEqual(browser.errors, [], 'Browser harness errors');
  return { checkpoints, generations };
}
