'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const helper = () => import('../../extension/browser-tests/chromium.mjs');

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'createratio-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function browser(workerFailure = false) {
  return {
    executable: '/fixture/chrome', stderr: 'fixture browser stderr',
    pages: [{ targetId: 'fixture-tab', session: 'page' }], worker: 'worker',
    events: [{ type: 'exception', message: 'fixture page error' }], errors: [],
    cdp: { async send(method, params, session) {
      if (method === 'Browser.getVersion') return { product: 'Chrome/155.0.8059.79' };
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'fixture-tab', url: 'chrome-extension://fixture/blocked.html?site=x' }] };
      if (method === 'Runtime.evaluate') {
        if (session === 'worker') {
          if (workerFailure) throw new Error('Fixture worker disconnected');
          return { result: { value: { storage: { _access: { x: { readyAt: 123 } } }, sessionRules: [{ id: 1001 }], alarms: [] } } };
        }
        return { result: { value: { url: 'chrome-extension://fixture/blocked.html?site=x', title: 'X blocked', html: '<html><body><p id="error">Fixture error</p></body></html>', text: 'Fixture error', controls: [{ id: 'open', disabled: false }] } } };
      }
      if (method === 'Page.captureScreenshot') return { data: png.toString('base64') };
      throw new Error(`Unexpected CDP operation: ${method}`);
    } }
  };
}

test('a failed browser journey retains state, DOM, screenshot and errors before cleanup', async t => {
  const directory = await workspace(t);
  const { withFailureArtifacts } = await helper();
  const failure = new Error('Timed out: explicit confirmation');
  await assert.rejects(withFailureArtifacts(browser(), 'explicit confirmation', async () => { throw failure; }, directory), error => error === failure);
  const entries = await readdir(directory);
  assert.equal(entries.length, 1);
  const artifacts = path.join(directory, entries[0]);
  const report = JSON.parse(await readFile(path.join(artifacts, 'report.json'), 'utf8'));
  assert.equal(report.error.message, failure.message);
  assert.equal(report.version.product, 'Chrome/155.0.8059.79');
  assert.equal(report.environment.architecture, process.arch);
  assert.equal(report.stderr, 'fixture browser stderr');
  assert.equal(report.state.storage._access.x.readyAt, 123);
  assert.deepEqual(report.state.sessionRules, [{ id: 1001 }]);
  assert.equal(report.events[0].message, 'fixture page error');
  assert.equal(report.pages[0].url, 'chrome-extension://fixture/blocked.html?site=x');
  assert.equal(report.pages[0].controls[0].disabled, false);
  assert.equal(await readFile(path.join(artifacts, 'page-1.html'), 'utf8'), '<html><body><p id="error">Fixture error</p></body></html>');
  assert.deepEqual(await readFile(path.join(artifacts, 'page-1.png')), png);
});

test('a disconnected worker does not prevent page evidence or mask the journey failure', async t => {
  const directory = await workspace(t);
  const { withFailureArtifacts } = await helper();
  const failure = new Error('Original journey failure');
  await assert.rejects(withFailureArtifacts(browser(true), 'disconnected worker', async () => { throw failure; }, directory), error => error === failure);
  const [entry] = await readdir(directory);
  const report = JSON.parse(await readFile(path.join(directory, entry, 'report.json'), 'utf8'));
  assert.match(report.diagnosticErrors.join('\n'), /Fixture worker disconnected/);
  assert.deepEqual(await readFile(path.join(directory, entry, 'page-1.png')), png);
});

test('successful browser journeys return their result without collecting artifacts', async t => {
  const directory = await workspace(t);
  const { withFailureArtifacts } = await helper();
  assert.equal(await withFailureArtifacts(browser(), 'success', async () => 'done', directory), 'done');
  assert.deepEqual(await readdir(directory), []);
});

test('an unwritable artifact destination never replaces the original test failure', async t => {
  const directory = await workspace(t);
  const destination = path.join(directory, 'not-a-directory');
  await writeFile(destination, 'fixture');
  const { withFailureArtifacts } = await helper();
  const failure = new Error('Original failure remains actionable');
  await assert.rejects(withFailureArtifacts(browser(), 'write failure', async () => { throw failure; }, destination), error => error === failure);
});
