'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { auditActions, fetchManifest } = require('../check-actions.js');

const sha = 'a'.repeat(40);
const action = `example/action@${sha}`;
const workflow = source => [{ name: 'ci.yml', source }];
const manifest = runtime => `name: Example\nruns:\n  using: '${runtime}'\n  main: dist/index.js\n`;

test('the audit catches deprecated action runtimes even when setup-node selects Node 24', async () => {
  const source = `steps:\n  - uses: ${action}\n    with:\n      node-version: 24\n`;
  assert.deepEqual(await auditActions(workflow(source), async () => manifest('node20')), [
    `${action}: Node 20 is below the supported action runtime minimum of 24`
  ]);
  assert.deepEqual(await auditActions(workflow(source), async () => manifest('node24')), []);
});

test('the audit fetches each immutable action once across workflows', async () => {
  const loaded = [];
  const workflows = [
    { name: 'ci.yml', source: `- uses: '${action}'\n- uses: ./.github/workflows/ci.yml\n` },
    { name: 'deploy.yml', source: `- uses: "${action}"\n` }
  ];
  assert.deepEqual(await auditActions(workflows, async reference => {
    loaded.push(reference);
    return manifest('node24');
  }), []);
  assert.deepEqual(loaded, [action]);
});

test('the audit rejects floating action pins and Ubuntu runner labels', async () => {
  const source = 'runs-on: ubuntu-latest\nsteps:\n  - uses: example/action@v1\n';
  assert.deepEqual(await auditActions(workflow(source), async () => {
    assert.fail('Floating action references must not be fetched');
  }), [
    'ci.yml: pin ubuntu-latest to an explicit Ubuntu release',
    'ci.yml: pin example/action@v1 to a full commit SHA'
  ]);
});

test('unavailable and unrecognized manifests fail visibly instead of passing', async () => {
  const workflows = workflow(`- uses: ${action}\n`);
  assert.deepEqual(await auditActions(workflows, async () => { throw new Error('HTTP 503'); }), [
    `${action}: could not verify runtime: HTTP 503`
  ]);
  assert.deepEqual(await auditActions(workflows, async () => 'name: Missing runtime\n'), [
    `${action}: could not identify the action runtime`
  ]);
});

test('non-JavaScript actions require review rather than silently skipping nested runtimes', async () => {
  for (const runtime of ['composite', 'docker']) {
    assert.deepEqual(await auditActions(workflow(`- uses: ${action}\n`), async () => manifest(runtime)), [
      `${action}: ${runtime} actions need a separate runtime audit`
    ]);
  }
});

test('manifest downloads support subpaths and action.yaml without swallowing server errors', async () => {
  const urls = [];
  const reference = `example/action/nested@${sha}`;
  const source = await fetchManifest(reference, async (url, options) => {
    urls.push(url);
    assert.ok(options.signal instanceof AbortSignal);
    return urls.length === 1 ? new Response('', { status: 404 }) : new Response(manifest('node24'));
  });
  assert.equal(source, manifest('node24'));
  assert.deepEqual(urls, [
    `https://raw.githubusercontent.com/example/action/${sha}/nested/action.yml`,
    `https://raw.githubusercontent.com/example/action/${sha}/nested/action.yaml`
  ]);
  await assert.rejects(fetchManifest(action, async () => new Response('', { status: 503 })), /HTTP 503/);
  await assert.rejects(fetchManifest(action, async () => new Response('', { status: 404 })), /manifest not found/);
});
