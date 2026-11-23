'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'docker/browser-check.sh');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'docker/Dockerfile.browser'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

function container(t) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'createratio-container-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['source', 'work', 'deps', 'output', 'home'].map(name => [name, path.join(base, name)]));
  for (const name of ['source', 'deps']) fs.mkdirSync(dirs[name]);
  for (const file of ['pnpm-lock.yaml', 'package.json', '.env', 'dist/old.txt', '.git/HEAD', 'node_modules/host.txt']) {
    fs.mkdirSync(path.dirname(path.join(dirs.source, file)), { recursive: true });
    fs.writeFileSync(path.join(dirs.source, file), file === 'pnpm-lock.yaml' ? 'lock: 1\n' : 'host');
  }
  fs.writeFileSync(path.join(dirs.deps, 'pnpm-lock.yaml'), 'lock: 1\n');
  fs.mkdirSync(path.join(dirs.deps, 'node_modules'));
  fs.writeFileSync(path.join(dirs.deps, 'node_modules/image.txt'), 'image');
  const run = (...command) => spawnSync('sh', [entry, ...command], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dirs.home, BROWSER_CHECK_SOURCE: dirs.source, BROWSER_CHECK_WORK: dirs.work, BROWSER_CHECK_DEPS: dirs.deps, BROWSER_CHECK_OUTPUT: dirs.output }
  });
  return { dirs, run };
}

test('the container entry copies source without host dependencies, output or secrets, then forwards the command', t => {
  const { dirs, run } = container(t);
  const result = run('sh', '-c', 'printf "%s|" "$@"; ls -A; cat node_modules/image.txt', 'probe', 'two words', '--flag');
  assert.equal(result.status, 0, result.stderr);
  const [forwarded, ...listing] = result.stdout.split('\n');
  assert.equal(forwarded, 'two words|--flag|' + 'node_modules');
  assert.deepEqual(listing.filter(Boolean).sort(), ['image', 'package.json', 'pnpm-lock.yaml'].sort());
  assert.equal(fs.existsSync(dirs.output), false);
});

test('the container entry keeps the command exit status and exports failure evidence', t => {
  const { dirs, run } = container(t);
  const result = run('sh', '-c', 'mkdir -p dist/browser-artifacts/failure-1 && echo evidence > dist/browser-artifacts/failure-1/report.json && exit 7');
  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(path.join(dirs.output, 'browser-artifacts/failure-1/report.json'), 'utf8'), 'evidence\n');
});

test('the container entry refuses a lockfile that differs from the image and runs nothing', t => {
  const { dirs, run } = container(t);
  fs.writeFileSync(path.join(dirs.source, 'pnpm-lock.yaml'), 'lock: 2\n');
  const result = run('sh', '-c', 'touch ran');
  assert.equal(result.status, 3);
  assert.match(result.stderr, /docker compose build browser-tests/);
  assert.equal(fs.existsSync(path.join(dirs.work, 'ran')), false);
  assert.equal(run().status, 2);
});

test('the browser container runs isolated and installs the versions CI uses', () => {
  const service = compose.split('\n  browser-tests:\n')[1];
  assert.ok(service, 'Missing browser-tests service');
  for (const setting of [/network_mode: none/, /read_only: true/, /cap_drop:\n\s+- ALL/, /no-new-privileges:true/, /- \.:\/src:ro/, /platform: linux\/amd64/]) {
    assert.match(service, setting);
  }
  const volumes = service.split('volumes:\n')[1].match(/^\s+- (\S+)$/gm).map(line => line.trim().slice(2));
  assert.deepEqual(volumes, ['.:/src:ro', './dist/container:/out'], 'only failure evidence is writable on the host');
  assert.match(dockerfile, /^FROM node:([\d.]+)-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  const ciNode = workflow.match(/node-version: (\S+)/)[1];
  const ciPnpm = workflow.match(/pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version: (\S+)/)[1];
  assert.equal(dockerfile.match(/^FROM node:([\d.]+)-/m)[1], ciNode);
  assert.equal(dockerfile.match(/^ARG PNPM_VERSION=(\S+)$/m)[1], ciPnpm);
  assert.match(dockerfile, /RUN node \/opt\/createratio\/bin\/setup-chromium\.js/);
  assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(dockerfile, /pnpm_config_verify_deps_before_run=false/, 'the entry lockfile check replaces pnpm network verification');
});
