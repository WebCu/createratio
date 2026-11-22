'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const root = path.resolve(__dirname, '../../..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const manifests = ['package.json', 'extension/package.json'].map(file => JSON.parse(read(file)));
const exactVersion = /^\d+\.\d+\.\d+$/;

test('workflows share a pinned Node.js version and CI/deployment pin matching stable tools', () => {
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
  for (const file of readdirSync(path.join(root, '.github/workflows'))) {
    if (!/\.ya?ml$/.test(file)) continue;
    for (const [, node] of read(`.github/workflows/${file}`).matchAll(/node-version: (\S+)/g)) {
      assert.equal(node, versions[0].node, `${file} must use the shared Node.js version`);
    }
  }
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

const minimalPermissions = { contents: 'read' };
const oidcPermissions = { contents: 'read', 'id-token': 'write' };
const oidcJobs = new Set(['deploy-site.yml deploy', 'release-chrome.yml submit']);

const indentOf = line => line.match(/^ */)[0].length;

function mappingAt(lines, keyIndex) {
  const indent = indentOf(lines[keyIndex]);
  const inline = lines[keyIndex].split(/:\s*/).slice(1).join(':').trim();
  if (inline) return { '': inline };
  const entries = {};
  for (const line of lines.slice(keyIndex + 1)) {
    if (!line.trim()) continue;
    const lineIndent = indentOf(line);
    if (lineIndent <= indent) break;
    const entry = line.match(/^ *([\w-]+):\s*(.*)$/);
    if (lineIndent === indent + 2 && entry) entries[entry[1]] = entry[2].trim();
  }
  return entries;
}

function workflowPolicyViolations(file, workflow) {
  const violations = [];
  const lines = workflow.split('\n');
  const topIndex = lines.findIndex(line => /^permissions:/.test(line));
  if (topIndex === -1) violations.push(`${file} needs top-level permissions`);
  else if (!util.isDeepStrictEqual(mappingAt(lines, topIndex), minimalPermissions)) {
    violations.push(`${file} top-level permissions must be contents: read`);
  }
  const jobs = workflow.split(/^jobs:\n/m)[1]?.split(/^(?=  [\w-]+:\n)/m) ?? [];
  if (jobs.length === 0) violations.push(`${file} has jobs`);
  for (const job of jobs) {
    const name = job.match(/^  ([\w-]+):/)?.[1];
    const jobLines = job.split('\n');
    const permissionIndex = jobLines.findIndex(line => /^    permissions:/.test(line));
    if (permissionIndex !== -1) {
      const permissions = mappingAt(jobLines, permissionIndex);
      const allowed = oidcJobs.has(`${file} ${name}`) ? oidcPermissions : minimalPermissions;
      if (!util.isDeepStrictEqual(permissions, allowed)) {
        violations.push(`${file} ${name} job permissions exceed the allowed scope`);
      }
    }
    if (/^    uses: /m.test(job)) continue;
    if (!/^    timeout-minutes: \d+$/m.test(job)) violations.push(`${file} ${name} needs timeout-minutes`);
    jobLines.forEach((line, index) => {
      if (!/^\s+(?:- )?uses: actions\/checkout@/.test(line)) return;
      const keyIndent = indentOf(line.replace('- ', '  '));
      let inputs = {};
      for (let at = index + 1; at < jobLines.length; at++) {
        const candidate = jobLines[at];
        if (!candidate.trim()) continue;
        if (indentOf(candidate.replace('- ', '  ')) < keyIndent || /^\s*- /.test(candidate)) break;
        if (indentOf(candidate) === keyIndent && /^\s+with:$/.test(candidate)) inputs = mappingAt(jobLines, at);
      }
      if (inputs['persist-credentials'] !== 'false') {
        violations.push(`${file} ${name} checkout must not persist credentials`);
      }
    });
  }
  return violations;
}

test('every workflow limits token scope, keeps checkout credentials out, and bounds each job', () => {
  for (const file of readdirSync(path.join(root, '.github/workflows'))) {
    if (!/\.ya?ml$/.test(file)) continue;
    assert.deepEqual(workflowPolicyViolations(file, read(`.github/workflows/${file}`)), []);
  }
});

test('workflow policy rejects broad permissions and misleading checkout text', () => {
  const workflow = ({ top = '  contents: read', jobPermissions = '', checkoutWith }) => [
    'on: push', 'permissions:', top, '', 'jobs:', '  build:', '    runs-on: ubuntu-24.04',
    '    timeout-minutes: 5', jobPermissions, '    steps:', '      - name: Checkout (v1.0.0)',
    '        uses: actions/checkout@0000000000000000000000000000000000000000', checkoutWith,
    '      - run: echo done', '',
  ].filter(line => line !== '').join('\n');
  const safeWith = '        with:\n          persist-credentials: false';
  assert.deepEqual(workflowPolicyViolations('x.yml', workflow({ checkoutWith: safeWith })), []);
  assert.deepEqual(workflowPolicyViolations('x.yml', workflow({
    top: '  contents: write\n  issues: write', checkoutWith: safeWith,
  })), ['x.yml top-level permissions must be contents: read']);
  assert.deepEqual(workflowPolicyViolations('x.yml', workflow({ checkoutWith: safeWith })
    .replace('permissions:\n  contents: read', 'permissions: write-all')),
  ['x.yml top-level permissions must be contents: read']);
  assert.deepEqual(workflowPolicyViolations('x.yml', workflow({
    jobPermissions: '    permissions:\n      contents: write', checkoutWith: safeWith,
  })), ['x.yml build job permissions exceed the allowed scope']);
  assert.deepEqual(workflowPolicyViolations('x.yml', workflow({
    jobPermissions: '    permissions:\n      contents: read\n      id-token: write', checkoutWith: safeWith,
  })), ['x.yml build job permissions exceed the allowed scope']);
  for (const checkoutWith of [
    '        with:\n          persist-credentials: true\n        env:\n          NOTE: |\n            persist-credentials: false',
    '        env:\n          NOTE: persist-credentials: false',
    '        with:\n          ref: main\n          extra:\n            persist-credentials: false',
  ]) {
    assert.deepEqual(workflowPolicyViolations('x.yml', workflow({ checkoutWith })),
      ['x.yml build checkout must not persist credentials'], checkoutWith);
  }
});

test('CI uses a frozen install, audits security, and runs the shared fail-fast check', () => {
  const workflow = read('.github/workflows/ci.yml');
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm audit --audit-level=high', 'pnpm check']) {
    assert.ok(workflow.includes(`run: ${command}`), command);
  }
  assert.equal(manifests[0].scripts['check:syntax'], 'node bin/check-syntax.js');
  assert.equal(manifests[0].scripts['check:types'], 'tsc -p tsconfig.json');
  assert.match(workflow, /run: pnpm check:browser/);
  assert.match(workflow, /^  contents: read$/m);
  assert.match(workflow, /persist-credentials: false/);
});

test('weekly dependency automation proposes Action majors but excludes library and image majors', () => {
  const updates = read('.github/dependabot.yml').split('  - package-ecosystem: ').slice(1);
  assert.deepEqual(updates.map(update => update.split('\n')[0]), ['npm', 'github-actions', 'docker-compose']);
  for (const update of updates) {
    assert.match(update, /interval: weekly/);
    if (update.startsWith('github-actions\n')) {
      assert.doesNotMatch(update, /ignore:/);
    } else {
      assert.match(update, /dependency-name: '\*'\n\s+update-types: \['version-update:semver-major'\]/);
    }
  }
});
