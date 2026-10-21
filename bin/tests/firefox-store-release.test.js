const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { submitFirefoxRelease } = require('../firefox-store-release.js');

const addonId = 'create-greater-consume@createratio';
const version = '0.0.2';
const configuration = {
  addonId, version, apiKey: 'user:123:45', apiSecret: 'synthetic-secret',
  archive: Buffer.from('synthetic extension ZIP'), sourceArchive: Buffer.from('synthetic source ZIP')
};
const addon = { guid: addonId, status: 'public', current_version: { version: '0.0.1' } };
const versions = { results: [{ version: '0.0.1', channel: 'listed', file: { status: 'public' } }], next: null };
const validated = { uuid: 'upload-123', processed: true, valid: true, submitted: false, version, channel: 'listed' };
const submitted = { id: 42, version, channel: 'listed', file: { status: 'unreviewed' } };

function store(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      assert.ok(responses.length, 'Unexpected AMO request');
      const next = responses.shift();
      return { ok: !next?.httpError, status: next?.httpError || 200, json: async () => next };
    }
  };
}

test('a Firefox update validates the upload then submits the listed version with reproducible source', async () => {
  const api = store([addon, versions, { uuid: 'upload-123', processed: false }, validated, submitted]);
  let waits = 0;
  assert.equal(await submitFirefoxRelease(configuration, api.fetch, async () => { waits++; }), 42);
  assert.equal(waits, 1);
  assert.deepEqual(api.calls.map(call => call.method), ['GET', 'GET', 'POST', 'GET', 'POST']);
  assert.match(api.calls[0].url, /create-greater-consume%40createratio\/$/);
  const upload = api.calls[2].body;
  assert.ok(upload instanceof FormData);
  assert.equal(upload.get('channel'), 'listed');
  assert.deepEqual(Buffer.from(await upload.get('upload').arrayBuffer()), configuration.archive);
  const creation = api.calls[4].body;
  assert.equal(creation.get('upload'), 'upload-123');
  assert.equal(creation.get('license'), 'MIT');
  assert.deepEqual(Buffer.from(await creation.get('source').arrayBuffer()), configuration.sourceArchive);
  const nonces = new Set();
  for (const call of api.calls) {
    const token = call.headers.Authorization.replace(/^JWT /, '');
    const [header, payload, signature] = token.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.iss, configuration.apiKey);
    assert.ok(claims.exp > claims.iat && claims.exp - claims.iat <= 300);
    assert.ok(Math.abs(claims.iat - Math.floor(Date.now() / 1000)) < 10);
    assert.equal(signature, createHmac('sha256', configuration.apiSecret).update(`${header}.${payload}`).digest('base64url'));
    assert.ok(!nonces.has(claims.jti));
    nonces.add(claims.jti);
    assert.equal(call.redirect, 'error');
    assert.equal(call.url.includes(configuration.apiKey), false);
    assert.equal(call.url.includes(configuration.apiSecret), false);
  }
});

test('missing credentials, wrong add-on identity and missing archives fail before HTTP requests', async () => {
  for (const overrides of [
    { apiKey: '' }, { apiSecret: '' }, { apiSecret: ' secret ' },
    { addonId: 'another-addon@example.invalid' }, { sourceArchive: Buffer.alloc(0) }, { version: '0.0.2-beta' }
  ]) {
    const api = store([]);
    await assert.rejects(submitFirefoxRelease({ ...configuration, ...overrides }, api.fetch));
    assert.equal(api.calls.length, 0);
  }
});

test('disabled listings, duplicates, higher versions and pending submissions cannot upload', async () => {
  for (const listing of [
    { ...addon, guid: 'other' }, { ...addon, status: 'disabled' }, { ...addon, is_disabled: true },
    { ...addon, current_version: { version } }
  ]) {
    const api = store([listing]);
    await assert.rejects(submitFirefoxRelease(configuration, api.fetch));
    assert.equal(api.calls.length, 1);
  }
  for (const previous of [
    { version, channel: 'listed', file: { status: 'public' } },
    { version: '0.0.3', channel: 'unlisted', file: { status: 'public' } },
    { version: '0.0.1', channel: 'listed', file: { status: 'unreviewed' } },
    { version: '0.0.1', channel: 'listed', file: { status: 'awaiting_review' } },
    { version: '1.0beta', channel: 'listed', file: { status: 'public' } },
    { version: '0.0.1', file: { status: 'unreviewed' } }
  ]) {
    const api = store([addon, { results: [previous], next: null }]);
    await assert.rejects(submitFirefoxRelease(configuration, api.fetch));
    assert.equal(api.calls.length, 2);
  }
});

test('version history is checked across pages without following credential-bearing redirects', async () => {
  const api = store([addon, { results: [], next: 'https://untrusted.example/next' }, versions, validated, submitted]);
  assert.equal(await submitFirefoxRelease(configuration, api.fetch), 42);
  assert.match(api.calls[2].url, /^https:\/\/addons.mozilla.org\/api\/v5\/addons\/addon\/.+page=2$/);
  const large = store([addon, ...Array.from({ length: 20 }, () => ({ results: [], next: 'next' }))]);
  await assert.rejects(submitFirefoxRelease(configuration, large.fetch), /safety limit/);
  assert.equal(large.calls.length, 21);
});

test('malformed history cannot be mistaken for a complete preflight', async () => {
  for (const history of [null, {}, { results: [] }, { results: [], next: false }, { results: [null], next: null }]) {
    const api = store([addon, history]);
    await assert.rejects(submitFirefoxRelease(configuration, api.fetch));
    assert.equal(api.calls.length, 2);
  }
});

test('invalid, already-submitted, wrong-version or wrong-channel uploads never create a version', async () => {
  for (const upload of [
    { ...validated, valid: false }, { ...validated, submitted: true },
    { ...validated, version: '0.0.3' }, { ...validated, channel: 'unlisted' },
    { ...validated, uuid: '../escape' }, { uuid: 'upload-123' }
  ]) {
    const api = store([addon, versions, upload]);
    await assert.rejects(submitFirefoxRelease(configuration, api.fetch, async () => {}));
    assert.equal(api.calls.length, 3);
  }
});

test('async validation has a finite bound and an invalid poll cannot create a version', async () => {
  const pending = { uuid: 'upload-123', processed: false };
  const api = store([addon, versions, pending, ...Array.from({ length: 60 }, () => pending)]);
  await assert.rejects(submitFirefoxRelease(configuration, api.fetch, async () => {}), /timed out/);
  assert.equal(api.calls.length, 63);
  const changed = store([addon, versions, pending, { ...validated, uuid: 'different-upload' }]);
  await assert.rejects(submitFirefoxRelease(configuration, changed.fetch, async () => {}));
  assert.equal(changed.calls.length, 4);
});

test('HTTP and ambiguous network failures are not retried and never expose credentials', async () => {
  for (const responses of [
    [{ httpError: 401 }], [addon, versions, { httpError: 500 }],
    [addon, versions, validated, { httpError: 400 }]
  ]) {
    const api = store(responses);
    await assert.rejects(submitFirefoxRelease(configuration, api.fetch), /HTTP/);
    assert.equal(responses.length, 0);
  }
  let calls = 0;
  await assert.rejects(submitFirefoxRelease(configuration, async () => {
    calls++;
    throw new Error(`${configuration.apiKey} ${configuration.apiSecret}`);
  }), error => {
    assert.equal(error.message.includes(configuration.apiKey), false);
    assert.equal(error.message.includes(configuration.apiSecret), false);
    return /Mozilla request failed/.test(error.message);
  });
  assert.equal(calls, 1);
});

test('unexpected or rejected version-creation results are not reported as a successful submission', async () => {
  for (const result of [
    {}, { ...submitted, version: '0.0.3' }, { ...submitted, channel: 'unlisted' },
    { ...submitted, file: { status: 'disabled' } }, { ...submitted, file: { status: 'rejected' } }
  ]) {
    const api = store([addon, versions, validated, result]);
    await assert.rejects(submitFirefoxRelease(configuration, api.fetch));
    assert.equal(api.calls.length, 4);
  }
});

test('Firefox CLI validates the real archive manifest before any store call', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-firefox-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'dist'));
  fs.writeFileSync(path.join(directory, 'dist/createratio-source.zip'), configuration.sourceArchive);
  const log = path.join(directory, 'requests');
  const preload = path.join(directory, 'http-boundary.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const responses = ${JSON.stringify([addon, versions, validated, submitted])};
global.fetch = async (url, options) => {
  fs.appendFileSync(${JSON.stringify(log)}, options.method + '\\n');
  return {ok: true, json: async () => responses.shift()};
};\n`);
  const env = {
    ...process.env, GITHUB_REF_NAME: `v${version}`, AMO_ADDON_ID: addonId,
    AMO_API_KEY: configuration.apiKey, AMO_API_SECRET: configuration.apiSecret
  };
  const run = overrides => spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../firefox-store-release.js'), 'submit'], {
    cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000
  });
  function archive(id) {
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ version, browser_specific_settings: { gecko: { id } } }));
    const result = spawnSync('zip', ['-q', 'dist/createratio-firefox.zip', 'manifest.json'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  archive('wrong-addon@example.invalid');
  const wrong = run({});
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /wrong add-on ID/);
  assert.equal(fs.existsSync(log), false);
  archive(addonId);
  const mismatch = run({ GITHUB_REF_NAME: 'v0.0.3' });
  assert.notEqual(mismatch.status, 0);
  assert.equal(fs.existsSync(log), false);
  const missing = run({ AMO_API_SECRET: '' });
  assert.notEqual(missing.status, 0);
  assert.equal(fs.existsSync(log), false);
  const success = run({});
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /submitted to AMO/);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['GET', 'GET', 'POST', 'POST']);
  assert.equal((success.stdout + success.stderr).includes(configuration.apiKey), false);
  assert.equal((success.stdout + success.stderr).includes(configuration.apiSecret), false);
});

test('both store jobs use the same checked packages but independent approvals and permissions', () => {
  const root = path.resolve(__dirname, '../..');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release-chrome.yml'), 'utf8');
  assert.match(workflow, /node bin\/package-release.js/);
  assert.match(workflow, /dist\/createratio-source.zip/);
  const firefox = workflow.split('  submit-firefox:\n')[1];
  assert.ok(firefox);
  assert.match(firefox, /needs: package/);
  assert.doesNotMatch(firefox, /needs:.*submit/);
  assert.match(firefox, /environment: firefox-addons/);
  assert.match(firefox, /permissions:\n      contents: read/);
  assert.doesNotMatch(firefox, /id-token/);
  assert.doesNotMatch(firefox.split('    steps:\n')[0], /secrets\./);
  assert.match(firefox, /AMO_API_KEY: \$\{\{ secrets.AMO_API_KEY \}\}/);
  assert.match(firefox, /AMO_API_SECRET: \$\{\{ secrets.AMO_API_SECRET \}\}/);
  assert.ok(firefox.indexOf('sha256sum --check SHA256SUMS') < firefox.indexOf('node bin/firefox-store-release.js submit'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts.release, 'node bin/release.js');
});
