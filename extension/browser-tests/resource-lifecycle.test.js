'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const workload of ['settings', 'trackers']) test(`built ${workload} lifecycle instruments real controls and current documents`, async () => {
  const { launch, withFailureArtifacts, evaluate } = await import('./chromium.mjs');
  const { settingsWorkload, trackerWorkload } = await import('../../bin/lifecycle-workloads.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, workload + ' resource fixture', async () => {
      const result = workload === 'settings'
        ? await settingsWorkload(browser, { cycles: 3, tabCount: 2 })
        : await trackerWorkload(browser, { cycles: 1, tabCount: 2, idleMs: 35000 });
      assert.equal(result.attribution.pages.length, 2);
      assert.ok(result.checkpoints.at(-1).samples.every(sample => sample.heapBytes > 0));
      if (workload === 'settings') {
        assert.equal(result.closedTargets, 1);
        assert.equal(await evaluate(browser, browser.worker, 'chrome.storage.local.get("settings").then(data=>data.settings.siteOverrides?.x?.accessMinutes ?? null)'), null);
      } else {
        assert.equal(result.idle.recovered, true);
        assert.equal(result.idle.sameDocument, true);
      }
    });
  } finally { await browser.cleanup(); }
});

test('tracker lifecycle workload detects synthetic worker polling with every debugger detached', async () => {
  const { launch, withFailureArtifacts, evaluate } = await import('./chromium.mjs');
  const { trackerWorkload } = await import('../../bin/lifecycle-workloads.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'worker polling sensitivity', async () => {
      await evaluate(browser, browser.worker, 'globalThis.syntheticPolling = setInterval(() => chrome.storage.local.get("settings"), 1000)');
      await assert.rejects(trackerWorkload(browser, { cycles: 1, tabCount: 1, idleMs: 35000 }), /natural worker shutdown/);
    });
  } finally { await browser.cleanup(); }
});

for (const retained of ['node', 'listener']) test(`Settings lifecycle workload detects a retained ${retained} regression`, async () => {
  const { launch, withFailureArtifacts, evaluate } = await import('./chromium.mjs');
  const { settingsWorkload } = await import('../../bin/lifecycle-workloads.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'Settings resource sensitivity', async () => {
      await assert.rejects(settingsWorkload(browser, { tabCount: 1, afterCycle: async (browser, page) => {
        await evaluate(browser, page.session, retained === 'node'
          ? '(globalThis.syntheticRetainedControls ||= []).push(document.createElement("button"))'
          : 'window.addEventListener("synthetic-retained-listener", () => {})');
      } }), retained === 'node' ? /Settings detached DOM nodes accumulated/ : /Settings listeners accumulated/);
      const restored = await settingsWorkload(browser, { tabCount: 1 });
      assert.deepEqual(restored.checkpoints.map(({ cycle, phase }) => [cycle, phase]), [[0, 'initial'], [6, 'before-navigation'], [6, 'after-navigation'], [12, 'before-navigation'], [12, 'after-navigation']]);
    });
  } finally { await browser.cleanup(); }
});
