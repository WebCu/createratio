'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pins = require('../browser-pins.json');
const { pinnedChromium, installChromium, isInstalled, resolveBrowser } = require('../setup-chromium.js');

const script = path.resolve(__dirname, '../setup-chromium.js');
const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'createratio-setup-chromium-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeBrowser(directory, name, reportedVersion) {
  const file = path.join(directory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho '${reportedVersion}'\n`, { mode: 0o755 });
  return file;
}

function archiveOf(t, reportedVersion) {
  const source = temporaryDirectory(t);
  fakeBrowser(source, 'chrome-linux64/chrome', reportedVersion);
  const archive = path.join(source, 'chrome.zip');
  const result = spawnSync('zip', ['-qr', archive, 'chrome-linux64'], { cwd: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const bytes = fs.readFileSync(archive);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function serve(t, bytes) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { downloads: `http://127.0.0.1:${server.address().port}`, requests };
}

async function pinFor(t, archive, served = archive.bytes) {
  const cacheRoot = temporaryDirectory(t);
  const { downloads, requests } = await serve(t, served);
  const pin = { ...pinnedChromium({ key: 'linux64', cacheRoot, downloads }), sha256: archive.sha256 };
  return { pin, requests, cacheRoot };
}

test('setup installs a verified archive once and reuses it from the cache', async t => {
  const archive = archiveOf(t, `Google Chrome for Testing ${pins.chromeForTesting.version}`);
  const { pin, requests } = await pinFor(t, archive);
  assert.deepEqual(await installChromium(pin), { executable: pin.executable, downloaded: true });
  assert.ok(isInstalled(pin));
  assert.deepEqual(await installChromium(pin), { executable: pin.executable, downloaded: false });
  assert.deepEqual(requests, [`/${pins.chromeForTesting.version}/linux64/chrome-linux64.zip`]);
  assert.deepEqual(resolveBrowser({}, pin), {
    executable: pin.executable, version: `Google Chrome for Testing ${pins.chromeForTesting.version}`, warning: null
  });
});

test('a changed archive fails the checksum and is never unpacked', async t => {
  const archive = archiveOf(t, 'Google Chrome for Testing 1.0');
  const tampered = Buffer.concat([archive.bytes, Buffer.from('tampered')]);
  const { pin, cacheRoot } = await pinFor(t, archive, tampered);
  await assert.rejects(installChromium(pin), /Checksum mismatch.*not unpacked/);
  assert.equal(fs.existsSync(pin.directory), false);
  assert.deepEqual(fs.readdirSync(path.dirname(pin.directory)), []);
  assert.ok(fs.existsSync(cacheRoot));
});

test('an unverified cache directory is replaced rather than trusted', async t => {
  const archive = archiveOf(t, 'Google Chrome for Testing 1.0');
  const { pin, requests } = await pinFor(t, archive);
  fakeBrowser(pin.directory, 'chrome-linux64/chrome', 'Google Chrome for Testing interrupted');
  assert.equal(isInstalled(pin), false);
  assert.equal((await installChromium(pin)).downloaded, true);
  assert.equal(requests.length, 1);
  assert.match(spawnSync(pin.executable, ['--version'], { encoding: 'utf8' }).stdout, /1\.0/);
});

test('browser resolution rejects branded Chrome and missing browsers, and warns about other versions', t => {
  const directory = temporaryDirectory(t);
  const emptyCache = { CREATERATIO_CACHE_DIR: directory };
  const branded = fakeBrowser(directory, 'branded', 'Google Chrome 157.0.8103.80');
  assert.match(resolveBrowser({ ...emptyCache, CHROMIUM_PATH: branded }).problem, /branded Chrome.*pnpm setup:chromium/);
  assert.match(resolveBrowser({ ...emptyCache, CHROMIUM: path.join(directory, 'missing') }).problem, /not found.*pnpm setup:chromium/);
  const chromium = fakeBrowser(directory, 'chromium', 'Chromium 150.0.1.2');
  const preferred = fakeBrowser(directory, 'preferred', `Chromium ${pins.chromeForTesting.version}`);
  assert.match(resolveBrowser({ ...emptyCache, CHROMIUM: chromium }).warning, /differs from the CI browser/);
  const longerPatch = fakeBrowser(directory, 'longer-patch', `Chromium ${pins.chromeForTesting.version}0`);
  assert.match(resolveBrowser({ ...emptyCache, CHROMIUM: longerPatch }).warning, /differs from the CI browser/);
  assert.deepEqual(resolveBrowser({ ...emptyCache, CHROMIUM_PATH: preferred, CHROMIUM: chromium }), {
    executable: preferred, version: `Chromium ${pins.chromeForTesting.version}`, warning: null
  });
});

test('the resolve command fails with setup advice instead of launching branded Chrome', t => {
  const directory = temporaryDirectory(t);
  const env = { ...process.env, CREATERATIO_CACHE_DIR: directory, CHROMIUM_PATH: fakeBrowser(directory, 'branded', 'Google Chrome 157.0.8103.80') };
  const rejected = spawnSync(process.execPath, [script, '--resolve'], { encoding: 'utf8', env });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /branded Chrome/);
  assert.equal(rejected.stdout, '');
  env.CHROMIUM_PATH = fakeBrowser(directory, 'testing', `Google Chrome for Testing ${pins.chromeForTesting.version}`);
  const accepted = spawnSync(process.execPath, [script, '--resolve'], { encoding: 'utf8', env });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, `${env.CHROMIUM_PATH}\n`);
});

test('CI installs the browser versions that local setup pins', () => {
  const { version, archives } = pins.chromeForTesting;
  const downloads = [...workflow.matchAll(/chrome-for-testing-public\/([^/\s]+)\/linux64\/chrome-linux64\.zip/g)].map(match => match[1]);
  assert.ok(downloads.length >= 2);
  assert.deepEqual(new Set(downloads), new Set([version]));
  const checksums = [...workflow.matchAll(/echo '([a-f0-9]{64}) {2}'"\$RUNNER_TEMP\/chrome\.zip"/g)].map(match => match[1]);
  assert.equal(checksums.length, downloads.length);
  assert.deepEqual(new Set(checksums), new Set([archives.linux64.sha256]));
  assert.deepEqual([...workflow.matchAll(/browser-harness==(\S+)/g)].map(match => match[1]), [pins.browserHarness]);
});
