'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { cp, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

test('cold-bundle resource comparison releases detached workers and recovers preferences', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'createratio-resource-journey-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = process.env.RESOURCE_EXTENSION_PATH || path.resolve(__dirname, '../../dist/chrome');
  for (const name of ['baseline', 'candidate']) {
    await cp(bundle, path.join(directory, name), { recursive: true, filter: source => path.relative(bundle, source).split(path.sep)[0] !== '_metadata' });
  }
  const output = path.join(directory, 'resources.json');
  let failure;
  try {
    await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../../bin/benchmark-resources.mjs'),
      '--baseline', path.join(directory, 'baseline'), '--candidate', path.join(directory, 'candidate'),
      '--output', output, '--runs', '1', '--tabs', '2', '--cycles', '1'], { timeout: 170000 });
  } catch (error) { failure = error; }
  const contents = await readFile(output, 'utf8');
  const artifacts = process.env.BROWSER_ARTIFACT_DIR || path.resolve(__dirname, '../../dist/browser-artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'resource-lifecycle.json'), contents);
  assert.ifError(failure);
  const report = JSON.parse(contents);
  assert.equal(report.complete, true, 'Chrome-generated caches must not invalidate unchanged source bundles');
  assert.equal(report.fingerprints.baseline, report.fingerprints.candidate);
  assert.equal(report.memoryBudgetPassed, null);
  assert.equal(report.candidateLifecyclePassed, true);
  assert.equal(report.runs.length, 2);
  for (const run of report.runs) {
    assert.ok(run.worker.samples.every(sample => sample.debuggerAttached === false));
    assert.equal(run.worker.exited, true, 'the worker must become absent without an attached debugger');
    assert.ok(run.worker.samples.slice(-5).every(sample => !sample.present));
    assert.equal(run.worker.recovered, true, 'returning must wake a new worker');
    assert.equal(run.worker.preferencesRecovered, true);
    assert.equal(run.pages.length, 2);
    assert.ok(run.pages.every(sample => sample.usedHeapBytes.length === 2 && sample.usedHeapBytes.every(bytes => bytes > 0)));
  }
});
