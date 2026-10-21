'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');

test('inactive trackers release the detached worker and recover saved preferences on return', { timeout: 80000 }, async () => {
  const { measureResources } = await import('./resources.mjs');
  const bundle = process.env.RESOURCE_EXTENSION_PATH || path.resolve(__dirname, '../../dist/chrome');
  const report = await measureResources(bundle, { tabs: 2, cycles: 1, idleMs: 45000 });
  const artifacts = process.env.BROWSER_ARTIFACT_DIR || path.resolve(__dirname, '../../dist/browser-artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'resource-lifecycle.json'), JSON.stringify(report, null, 2));
  assert.ok(report.worker.samples.every(sample => sample.debuggerAttached === false), 'idle samples must not keep a debugger attached');
  assert.equal(report.worker.exited, true, 'the worker must become absent without a debugger attached');
  assert.ok(report.worker.samples.slice(-5).every(sample => !sample.present), 'the worker must remain absent at the end of the controlled idle observation');
  assert.equal(report.worker.recovered, true, 'returning must wake a new worker');
  assert.equal(report.worker.preferencesRecovered, true, 'the new worker must serve the saved preferences');
  assert.equal(report.pages.length, 2);
  assert.ok(report.pages.every(sample => sample.usedHeapBytes.length === 2 && sample.usedHeapBytes.every(bytes => bytes > 0)));
});
