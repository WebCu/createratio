'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { relative, sep } = require('node:path');

const helper = () => import('../../extension/browser-tests/chromium.mjs');

test('browser tracer identifies the unpacked extension and declared worker path', async () => {
  const { extensionWorkerURL } = await helper();
  const manifest = { background: { service_worker: 'runtime/worker.js' } };
  assert.equal(extensionWorkerURL('/tmp/createratio-fixture/chrome', manifest), 'chrome-extension://iphddjbhcelpecbdffdmjmpboapobdmh/runtime/worker.js');
  const keyed = { ...manifest, key: Buffer.from('fixture-public-key').toString('base64') };
  assert.equal(extensionWorkerURL('/different/location', keyed), 'chrome-extension://bfmcheajhnbjgnhpjgbiefloegniiime/runtime/worker.js');
});

test('equivalent unpacked paths select the same worker while different paths do not', async t => {
  const { extensionWorkerURL, workerTarget } = await helper();
  const manifest = { background: { service_worker: 'runtime/worker.js' } };
  const canonical = '/tmp/createratio-fixture/chrome';
  const url = extensionWorkerURL(canonical, manifest);
  const worker = { type: 'service_worker', url, targetId: 'extension' };
  const spellings = [canonical, relative(process.cwd(), canonical)];
  const variants = [
    path => path.split(sep).join(sep + sep),
    path => `${path}${sep}.`,
    path => `${path}${sep}..${sep}chrome`,
    path => `${path}${sep}`
  ].reduce((paths, transform) => paths.flatMap(path => [path, transform(path)]), spellings);
  for (const path of new Set(variants)) {
    await t.test(path, () => {
      const expected = extensionWorkerURL(path, manifest);
      assert.equal(expected, url);
      assert.equal(workerTarget([worker], expected), worker);
    });
  }
  const different = extensionWorkerURL(`${canonical}-other`, manifest);
  assert.notEqual(different, url);
  assert.equal(workerTarget([worker], different), undefined);
  const keyed = { ...manifest, key: Buffer.from('fixture-public-key').toString('base64') };
  for (const path of [...variants, `${canonical}-other`]) {
    assert.equal(extensionWorkerURL(path, keyed), 'chrome-extension://bfmcheajhnbjgnhpjgbiefloegniiime/runtime/worker.js');
  }
});

test('built-in workers cannot steal browser tracer selection', async () => {
  const { workerTarget } = await helper();
  const url = 'chrome-extension://createratio/background.js';
  const correct = { type: 'service_worker', url, targetId: 'extension' };
  const unrelated = [
    { type: 'service_worker', url: 'chrome-extension://builtin/background.js' },
    { type: 'service_worker', url: 'chrome-extension://builtin/thunk.js' },
    { type: 'page', url }
  ];
  assert.equal(workerTarget(unrelated, url), undefined);
  assert.equal(workerTarget([...unrelated, correct], url), correct);
});

test('ambiguous browser tracer worker identity fails closed', async () => {
  const { workerTarget } = await helper();
  const url = 'chrome-extension://createratio/background.js';
  const worker = { type: 'service_worker', url };
  assert.throws(() => workerTarget([{ ...worker, targetId: 'one' }, { ...worker, targetId: 'two' }], url), error => error.fatal === true && /Multiple extension workers/.test(error.message));
});
