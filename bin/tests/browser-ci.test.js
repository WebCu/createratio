const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const workflow = readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
const job = workflow.split('\n  browser-smoke:\n')[1];
const smoke = readFileSync(path.resolve(__dirname, '../browser-smoke.py'), 'utf8');

test('CI runs the existing browser smoke command with pinned isolated browser tools', () => {
  assert.ok(job, 'Browser smoke is a separate CI job');
  assert.match(job, /timeout-minutes: 10/);
  const buildJob = workflow.split('\n  browser-smoke:\n')[0];
  const nodeVersion = buildJob.match(/node-version: (\S+)/)?.[1];
  const pnpmVersion = buildJob.match(/pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version: (\S+)/)?.[1];
  assert.match(nodeVersion, /^\d+\.\d+\.\d+$/);
  assert.match(pnpmVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(job.match(/node-version: (\S+)/)?.[1], nodeVersion);
  assert.equal(job.match(/pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version: (\S+)/)?.[1], pnpmVersion);
  assert.match(job, /run: pnpm install --frozen-lockfile/);
  assert.match(job, /browser-harness==0\.1\.13/);
  assert.match(job, /chrome-for-testing-public\/155\.0\.8059\.79\/linux64\/chrome-linux64\.zip/);
  assert.match(job, /[a-f0-9]{64}  .*chrome\.zip/);
  assert.match(job, /sha256sum --check/);
  assert.match(job, /run: pnpm smoke:browser/);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /BH_TELEMETRY: '0'/);
  assert.match(job, /BH_UPDATE_CHECK: '0'/);
});

test('CI retains browser failure artifacts without hiding the failing command', () => {
  assert.match(job, /defaults:\n\s+run:\n\s+shell: bash/);
  assert.match(job, /BROWSER_ARTIFACT_DIR: dist\/browser-artifacts/);
  assert.match(job, /pnpm smoke:browser 2>&1 \| tee "\$BROWSER_ARTIFACT_DIR\/smoke\.log"/);
  assert.match(job, /pnpm check:browser 2>&1 \| tee "\$BROWSER_ARTIFACT_DIR\/journeys\.log"/);
  assert.match(job, /if: failure\(\)/);
  assert.match(job, /uses: actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(job, /path: \$\{\{ env\.BROWSER_ARTIFACT_DIR \}\}/);
  assert.match(job, /retention-days: 7/);
  assert.doesNotMatch(job, /continue-on-error/);
});

test('browser smoke uses a fresh profile, blocks external DNS, and propagates failure', () => {
  assert.match(smoke, /TemporaryDirectory\(prefix="createratio-chromium-"\)/);
  assert.match(smoke, /--host-resolver-rules=MAP \* ~NOTFOUND, EXCLUDE localhost/);
  assert.match(smoke, /subprocess\.run\(\["browser-harness"\].*check=True, timeout=90/);
  assert.match(smoke, /os\.killpg\(browser\.pid, signal\.SIGTERM\)/);
  assert.match(smoke, /"liveSiteQA": False/);
});
