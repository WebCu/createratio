'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const manifests = ['package.json', 'extension/package.json'].map(file => JSON.parse(read(file)));
const exactVersion = /^\d+\.\d+\.\d+$/;

test('CI and deployment pin matching stable tools', () => {
  const versions = ['ci.yml', 'deploy-site.yml'].map(file => {
    const workflow = read(`.github/workflows/${file}`);
    const node = workflow.match(/node-version: (\S+)/)?.[1];
    const pnpm = workflow.match(/pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version: (\S+)/)?.[1];
    assert.match(node, exactVersion, file);
    assert.match(pnpm, exactVersion, file);
    assert.doesNotMatch(workflow, /node-version-file:/);
    return { node, pnpm };
  });
  assert.deepEqual(versions[0], versions[1]);
});

test('browser runtime remains dependency-free and any development packages use exact versions', () => {
  for (const manifest of manifests) {
    assert.deepEqual(manifest.dependencies || {}, {});
    assert.deepEqual(manifest.optionalDependencies || {}, {});
    for (const [name, version] of Object.entries(manifest.devDependencies || {})) {
      assert.match(version, exactVersion, name);
    }
  }
});

test('one committed pnpm lockfile covers both manifests without competing locks', () => {
  const lockfile = read('pnpm-lock.yaml');
  assert.match(lockfile, /^lockfileVersion: '9\.0'$/m);
  assert.match(lockfile, /^  \.:/m);
  assert.match(lockfile, /^  extension:/m);
  assert.doesNotMatch(lockfile, /packageManagerDependencies:/);
  for (const dir of ['', 'extension']) {
    for (const file of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']) {
      assert.equal(existsSync(path.join(root, dir, file)), false, `${dir}/${file}`);
    }
  }
  const packages = lockfile.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
  if (packages) {
    const keys = packages.match(/^  \S.+:$/gm) || [];
    const resolutions = packages.match(/    resolution: .+/g) || [];
    assert.equal(resolutions.length, keys.length);
    for (const key of keys) assert.match(key, /@\d+\.\d+\.\d+'?:$/);
    for (const resolution of resolutions) assert.match(resolution, /integrity: sha512-[A-Za-z0-9+/]{86}==/);
  }
});

test('installs save exact versions and reject immature releases without exceptions', () => {
  const config = read('pnpm-workspace.yaml');
  assert.match(config, /^  - extension$/m);
  assert.match(config, /^saveExact: true$/m);
  assert.match(config, /^engineStrict: true$/m);
  assert.match(config, /^minimumReleaseAge: 1440$/m);
  assert.match(config, /^minimumReleaseAgeStrict: true$/m);
  assert.doesNotMatch(config, /minimumReleaseAgeExclude:/);
});

test('preview images use the CI Node.js version and immutable digest', () => {
  const images = [...read('docker-compose.yml').matchAll(/^\s*image:\s*(\S+)$/gm)];
  assert.ok(images.length > 0);
  for (const [, image] of images) {
    assert.match(image, /^node:\d+\.\d+\.\d+-alpine\d+\.\d+@sha256:[a-f0-9]{64}$/);
    const ciNodeVersion = read('.github/workflows/ci.yml').match(/node-version: (\S+)/)?.[1];
    assert.ok(image.startsWith(`node:${ciNodeVersion}-alpine`));
  }
});

test('every external GitHub Action uses a full commit SHA and stable release label', () => {
  let count = 0;
  for (const file of readdirSync(path.join(root, '.github/workflows'))) {
    if (!/\.ya?ml$/.test(file)) continue;
    const workflow = read(`.github/workflows/${file}`);
    for (const match of workflow.matchAll(/\buses:\s*(.+)/g)) {
      const action = match[1];
      if (action.startsWith('./')) continue;
      count++;
      assert.match(action, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/, file);
      assert.match(workflow.slice(0, match.index), /- name: .+ \(v\d+\.\d+\.\d+\)\n\s*$/, file);
    }
  }
  assert.ok(count > 0);
});

test('CI uses a frozen install, audits security, and runs the shared fail-fast check', () => {
  const workflow = read('.github/workflows/ci.yml');
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm audit --audit-level=high', 'pnpm check']) {
    assert.ok(workflow.includes(`run: ${command}`), command);
  }
  assert.equal(manifests[0].scripts['check:syntax'], 'node bin/check-syntax.js');
  assert.equal(manifests[0].scripts.check, 'pnpm check:syntax && pnpm test && pnpm build && pnpm build:site');
  assert.equal(manifests[0].scripts['check:browser'], 'pnpm build:chrome && pnpm test:browser');
  assert.match(workflow, /run: pnpm check:browser/);
  assert.match(workflow, /^  contents: read$/m);
  assert.match(workflow, /persist-credentials: false/);
});

test('browser verification is a bounded CI job using a pinned, verified browser download', () => {
  const workflow = read('.github/workflows/ci.yml');
  const browserJob = workflow.split('  browser-smoke:\n')[1];
  assert.ok(browserJob);
  assert.match(browserJob, /timeout-minutes: 10/);
  assert.match(browserJob, /https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/\d+\.\d+\.\d+\.\d+\/linux64\/chrome-linux64\.zip/);
  assert.match(browserJob, /[a-f0-9]{64} {2}.*\$RUNNER_TEMP\/chrome\.zip.*\| sha256sum --check/);
  assert.ok(browserJob.indexOf('sha256sum --check') < browserJob.indexOf('unzip -q'));
  assert.match(browserJob, /CHROMIUM_PATH=.*chrome-linux64\/chrome/);
  assert.match(browserJob, /run: pnpm check:browser/);
  assert.doesNotMatch(browserJob, /continue-on-error:|\|\| true/);
});

test('weekly dependency automation excludes automatic major upgrades', () => {
  const updates = read('.github/dependabot.yml').split('  - package-ecosystem: ').slice(1);
  assert.deepEqual(updates.map(update => update.split('\n')[0]), ['npm', 'github-actions', 'docker-compose']);
  for (const update of updates) {
    assert.match(update, /interval: weekly/);
    assert.match(update, /dependency-name: '\*'\n\s+update-types: \['version-update:semver-major'\]/);
  }
});
