'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const workflow = readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
const smoke = readFileSync(path.resolve(__dirname, '../browser-smoke.py'), 'utf8');

function job(name) {
  const source = workflow.split(`\n  ${name}:\n`)[1];
  assert.ok(source, `Missing ${name} job`);
  return source.split(/^  [\w-]+:\n/m)[0];
}

for (const name of ['browser-smoke-core', 'browser-journeys']) {
  test(`${name} uses pinned isolated browser tools and preserves failure evidence`, () => {
    const source = job(name);
    const build = job('test-and-build');
    assert.match(source, /timeout-minutes: 10/);
    assert.equal(source.match(/node-version: (\S+)/)?.[1], build.match(/node-version: (\S+)/)?.[1]);
    const pnpm = /pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version: (\S+)/;
    assert.equal(source.match(pnpm)?.[1], build.match(pnpm)?.[1]);
    assert.match(source, /run: pnpm install --frozen-lockfile/);
    assert.match(source, /chrome-for-testing-public\/155\.0\.8059\.79\/linux64\/chrome-linux64\.zip/);
    assert.match(source, /[a-f0-9]{64}  .*chrome\.zip/);
    assert.match(source, /sha256sum --check/);
    assert.ok(source.indexOf('sha256sum --check') < source.indexOf('unzip -q'));
    assert.match(source, /persist-credentials: false/);
    assert.match(source, /CHROMIUM_NO_SANDBOX: '1'/);
    assert.match(source, /defaults:\n\s+run:\n\s+shell: bash/);
    assert.match(source, /BROWSER_ARTIFACT_DIR: dist\/browser-artifacts/);
    assert.match(source, /if: failure\(\)/);
    assert.match(source, /uses: actions\/upload-artifact@[a-f0-9]{40}/);
    assert.match(source, /path: \$\{\{ env\.BROWSER_ARTIFACT_DIR \}\}/);
    assert.match(source, /retention-days: 7/);
    assert.doesNotMatch(source, /continue-on-error/);
  });
}

test('only the broad smoke installs Python browser-harness', () => {
  const source = job('browser-smoke-core');
  assert.match(source, /browser-harness==0\.1\.13/);
  assert.match(source, /BH_TELEMETRY: '0'/);
  assert.match(source, /BH_UPDATE_CHECK: '0'/);
  assert.match(source, /pnpm smoke:browser 2>&1 \| tee "\$BROWSER_ARTIFACT_DIR\/smoke\.log"/);
  assert.doesNotMatch(source, /pnpm check:browser/);
  assert.doesNotMatch(job('browser-journeys'), /pip|browser-harness/);
});

test('browser journeys run every configured shard independently without fail-fast cancellation', () => {
  const source = job('browser-journeys');
  const shards = JSON.parse(readFileSync(path.resolve(__dirname, '../browser-shards.json'), 'utf8'));
  const matrix = JSON.parse(source.match(/shard: (\[[^\n]+\])/)[1]);
  assert.deepEqual(matrix, shards.map((_, index) => index + 1));
  assert.match(source, /fail-fast: false/);
  assert.doesNotMatch(source, /needs:/);
  assert.match(source, /pnpm check:browser:shard \$\{\{ matrix\.shard \}\} 2>&1 \| tee "\$BROWSER_ARTIFACT_DIR\/journeys\.log"/);
  assert.match(source, /name: browser-journey-failure-evidence-\$\{\{ matrix\.shard \}\}/);
  assert.match(job('browser-smoke-core'), /name: browser-smoke-failure-evidence/);
});

test('the existing required browser check passes only when the smoke and all journey shards succeed', () => {
  const source = job('browser-smoke');
  assert.match(source, /needs: \[browser-smoke-core, browser-journeys\]/);
  assert.match(source, /if: \$\{\{ always\(\) \}\}/);
  assert.match(source, /SMOKE_RESULT: \$\{\{ needs\.browser-smoke-core\.result \}\}/);
  assert.match(source, /JOURNEYS_RESULT: \$\{\{ needs\.browser-journeys\.result \}\}/);
  const command = source.match(/run: \|\n((?:          [^\n]*(?:\n|$))+)/)?.[1];
  assert.ok(command, 'Missing aggregate browser check');
  for (const smokeResult of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const journeysResult of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command], {
        encoding: 'utf8', env: { ...process.env, SMOKE_RESULT: smokeResult, JOURNEYS_RESULT: journeysResult }
      });
      assert.equal(result.status === 0, smokeResult === 'success' && journeysResult === 'success', `${smokeResult}/${journeysResult}: ${result.stderr}`);
    }
  }
});

test('browser smoke uses a fresh profile, blocks external DNS, and propagates failure', () => {
  assert.match(smoke, /TemporaryDirectory\(prefix="createratio-chromium-"\)/);
  assert.match(smoke, /--host-resolver-rules=MAP \* ~NOTFOUND, EXCLUDE localhost/);
  assert.match(smoke, /subprocess\.run\(\["browser-harness"\].*check=True, timeout=90/);
  assert.match(smoke, /os\.killpg\(browser\.pid, signal\.SIGTERM\)/);
  assert.match(smoke, /"liveSiteQA": False/);
});
