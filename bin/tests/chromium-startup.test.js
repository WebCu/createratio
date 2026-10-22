'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const helper = () => import('../../extension/browser-tests/chromium.mjs');
const debuggerPath = '/devtools/browser/35332af7-9075-49ec-acbc-c50d95cca9b0';

test('Chromium startup accepts complete debugger endpoints with valid ports', async () => {
  const { devToolsEndpoint } = await helper();
  for (const port of ['1', '45179', '65535']) {
    for (const ending of ['', '\n', '\r\n']) {
      assert.equal(devToolsEndpoint(`${port}\n${debuggerPath}${ending}`), `ws://127.0.0.1:${port}${debuggerPath}`);
    }
  }
});

test('Chromium startup keeps polling incomplete or malformed debugger endpoints', async () => {
  const { devToolsEndpoint } = await helper();
  const contents = [
    '', '45179', '45179\n', `\n${debuggerPath}`,
    `0\n${debuggerPath}`, `65536\n${debuggerPath}`, `not-a-port\n${debuggerPath}`,
    `45179oops\n${debuggerPath}`, `45179.5\n${debuggerPath}`,
    '45179\n/devtools/', '45179\n/devtools/browser/',
    '45179\nnot-a-debugger-path', '45179\n/devtools/browser/invalid path'
  ];
  for (const content of contents) {
    assert.equal(devToolsEndpoint(content), null, JSON.stringify(content));
  }
});

test('Chromium startup waits for an empty then partially written debugger file to become complete', async t => {
  const { devToolsEndpoint, eventually } = await helper();
  const directory = await mkdtemp(join(tmpdir(), 'createratio-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'DevToolsActivePort');
  await writeFile(file, '');
  const writes = ['45179\n', `45179\n${debuggerPath}`];
  let reads = 0;
  const endpoint = await eventually(async () => {
    reads++;
    const endpoint = devToolsEndpoint(await readFile(file, 'utf8'));
    if (writes.length) await writeFile(file, writes.shift());
    return endpoint;
  }, 'complete debugger endpoint');
  assert.equal(endpoint, `ws://127.0.0.1:45179${debuggerPath}`);
  assert.equal(reads, 3);
});
