const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { releaseVersion, validateConfiguration, submitRelease } = require('../chrome-store-release.js');

const version = '0.0.2';
const itemId = 'kopbjmlmjpnkekffalpbjfhmbhgbgamk';
const configuration = { publisherId: 'publisher-123', itemId, token: 'fake-token', version, archive: Buffer.from('synthetic ZIP') };

function store(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      assert.ok(responses.length, 'Unexpected store request');
      const next = responses.shift();
      return { ok: !next.httpError, status: next.httpError || 200, json: async () => next };
    }
  };
}

test('release tags must match all source versions and Chrome numeric limits', () => {
  assert.equal(releaseVersion('v0.0.2', [version, version, version]), version);
  for (const tag of ['0.0.2', 'v0.0.2-beta', 'v00.0.2', 'v65536.0.2', 'v0.0.0', 'v0.0.2;echo injected']) {
    assert.throws(() => releaseVersion(tag, [version]), /version|tag/i);
  }
  assert.throws(() => releaseVersion('v0.0.2', [version, '0.0.1']), /match/i);
});

test('unset or unsafe store identifiers fail before requests', () => {
  for (const publisherId of ['', 'SET_FROM_DASHBOARD', '../other', 'a/b']) {
    assert.throws(() => validateConfiguration({ ...configuration, publisherId }), /publisher/i);
  }
  assert.throws(() => validateConfiguration({ ...configuration, token: '' }), /token/i);
  assert.throws(() => validateConfiguration({ ...configuration, itemId: 'other-extension' }), /extension/i);
});

test('successful upload submits for normal review and automatic publication on approval', async () => {
  const api = store([{}, { uploadState: 'SUCCEEDED', crxVersion: version }, { state: 'PENDING_REVIEW' }]);
  assert.equal(await submitRelease(configuration, api.fetch), 'PENDING_REVIEW');
  assert.deepEqual(api.calls.map(call => call.method), ['GET', 'POST', 'POST']);
  assert.match(api.calls[1].url, new RegExp(`/upload/v2/publishers/publisher-123/items/${itemId}:upload$`));
  assert.equal(api.calls[1].body, configuration.archive);
  assert.deepEqual(JSON.parse(api.calls[2].body), { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true });
});

test('async processing is polled to success before publication', async () => {
  const api = store([{}, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }]);
  let waits = 0;
  await submitRelease(configuration, api.fetch, async () => { waits++; });
  assert.equal(waits, 2);
  assert.equal(api.calls.filter(call => call.url.endsWith(':publish')).length, 1);
});

test('blocked, duplicate, or existing pending submissions cannot upload', async () => {
  for (const status of [
    { takenDown: true }, { warned: true },
    { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } },
    { submittedItemRevisionStatus: { state: 'STAGED' } },
    { publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: version }] } },
    { publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '0.0.3' }] } }
  ]) {
    const api = store([status]);
    await assert.rejects(submitRelease(configuration, api.fetch));
    assert.equal(api.calls.length, 1);
  }
});

test('failed or unrecognized uploads and version mismatches never submit', async () => {
  for (const upload of [{ uploadState: 'FAILED' }, {}, { uploadState: 'SUCCEEDED', crxVersion: '0.0.3' }]) {
    const api = store([{}, upload]);
    await assert.rejects(submitRelease(configuration, api.fetch));
    assert.equal(api.calls.length, 2);
  }
  const api = store([{}, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'FAILED' }]);
  await assert.rejects(submitRelease(configuration, api.fetch, async () => {}));
  assert.equal(api.calls.length, 3);
});

test('async processing has a finite polling limit', async () => {
  const api = store([{}, { uploadState: 'IN_PROGRESS' }, ...Array.from({ length: 30 }, () => ({ lastAsyncUploadState: 'IN_PROGRESS' }))]);
  await assert.rejects(submitRelease(configuration, api.fetch, async () => {}), /timed out/i);
  assert.equal(api.calls.length, 32);
});

test('HTTP errors are not retried or printed with credentials', async () => {
  for (const responses of [[{ httpError: 403 }], [{}, { httpError: 500 }], [{}, { uploadState: 'SUCCEEDED', crxVersion: version }, { httpError: 400 }]]) {
    const api = store(responses);
    await assert.rejects(submitRelease(configuration, api.fetch), error => {
      assert.doesNotMatch(error.message, /fake-token/);
      return /HTTP/.test(error.message);
    });
  }
});

test('unrecognized publish results are failures, not a successful release', async () => {
  for (const state of ['REJECTED', 'CANCELLED', 'STAGED', 'PUBLISHED_TO_TESTERS', undefined]) {
    const api = store([{}, { uploadState: 'SUCCEEDED', crxVersion: version }, { state }]);
    await assert.rejects(submitRelease(configuration, api.fetch));
  }
});

test('CLI rejects a mismatched source manifest and incomplete federation setup', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'extension/src'), { recursive: true });
  const files = ['package.json', 'extension/package.json', 'extension/src/manifest.json'];
  for (const file of files) fs.writeFileSync(path.join(directory, file), JSON.stringify({ version }));
  const env = {
    ...process.env, GITHUB_REF_NAME: `v${version}`,
    CWS_EXTENSION_ID: itemId, CWS_PUBLISHER_ID: 'publisher-123',
    CWS_SERVICE_ACCOUNT: 'createratio-prod-store@sunsetatomic-createratio.iam.gserviceaccount.com',
    CWS_WORKLOAD_IDENTITY_PROVIDER: 'projects/123456789/locations/global/workloadIdentityPools/createratio-release/providers/github'
  };
  const run = (command, overrides = {}) => spawnSync(process.execPath, [path.resolve(__dirname, '../chrome-store-release.js'), command], {
    cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000
  });
  assert.equal(run('validate').status, 0);
  fs.writeFileSync(path.join(directory, files[2]), JSON.stringify({ version: '0.0.1' }));
  const mismatch = run('validate');
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /must match/);
  assert.equal(run('check-config').status, 0);
  for (const overrides of [
    { CWS_WORKLOAD_IDENTITY_PROVIDER: 'SET_FROM_INFRA_OUTPUT' },
    { CWS_WORKLOAD_IDENTITY_PROVIDER: 'projects/string-id/locations/global/workloadIdentityPools/createratio-release/providers/github' },
    { CWS_SERVICE_ACCOUNT: '' }, { CWS_PUBLISHER_ID: 'SET_FROM_DASHBOARD' }
  ]) assert.notEqual(run('check-config', overrides).status, 0);
});

test('release workflow preserves CI, artifact approval, tag ancestry and token boundaries', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release-chrome.yml'), 'utf8');
  assert.match(workflow, /release:\n    types: \[published\]/);
  assert.match(workflow, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(workflow, /checks:\n    needs: validate-release\n    uses: \.\/\.github\/workflows\/ci.yml/);
  assert.match(workflow, /package:\n    needs: checks/);
  const submit = workflow.split('  submit:\n')[1];
  assert.match(submit, /needs: package/);
  assert.match(submit, /environment: chrome-web-store/);
  assert.equal((workflow.match(/id-token: write/g) || []).length, 1);
  assert.match(submit, /id-token: write/);
  assert.ok(submit.indexOf('check-config') < submit.indexOf('google-github-actions/auth@'));
  assert.ok(submit.indexOf('sha256sum --check') < submit.indexOf('google-github-actions/auth@'));
  assert.match(submit, /access_token_scopes: https:\/\/www.googleapis.com\/auth\/chromewebstore/);
  assert.match(submit, /create_credentials_file: false/);
  assert.match(workflow, /cancel-in-progress: false/);
});
