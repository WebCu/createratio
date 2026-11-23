'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourceFiles, containerUser, prepareOutput } = require('../browser-container.js');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'docker/browser-check.sh');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'docker/Dockerfile.browser'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

function scratch(t) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'createratio-container-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function write(directory, file, content) {
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), content);
}

function container(t) {
  const base = scratch(t);
  const dirs = Object.fromEntries(['source', 'work', 'deps', 'output', 'home'].map(name => [name, path.join(base, name)]));
  for (const name of ['source', 'deps']) fs.mkdirSync(dirs[name]);
  write(dirs.source, 'pnpm-lock.yaml', 'lock: 1\n');
  write(dirs.source, 'bin/browser-pins.json', '{"pin":1}\n');
  write(dirs.source, 'package.json', 'host');
  write(dirs.deps, 'pnpm-lock.yaml', 'lock: 1\n');
  write(dirs.deps, 'node_modules/image.txt', 'image');
  const pins = path.join(base, 'image-pins.json');
  fs.writeFileSync(pins, '{"pin":1}\n');
  const run = (...command) => {
    const archive = spawnSync('tar', ['-cf', '-', '.'], { cwd: dirs.source, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    return spawnSync('sh', [entry, ...command], {
      encoding: 'utf8',
      input: archive.stdout,
      env: { PATH: process.env.PATH, HOME: dirs.home, BROWSER_CHECK_WORK: dirs.work, BROWSER_CHECK_DEPS: dirs.deps, BROWSER_CHECK_PINS: pins, BROWSER_CHECK_OUTPUT: dirs.output }
    });
  };
  return { dirs, run };
}

test('the wrapper sends only files git tracks or would track', t => {
  const repo = scratch(t);
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo }).status, 0, args.join(' '));
  git('init', '-q');
  for (const [file, content] of [['.gitignore', '.env\nnode_modules/\ndist/\n.codex/\n'], ['tracked.txt', 'a'], ['gone.txt', 'b'], ['sub/new.txt', 'c'], ['.env', 'SECRET'], ['node_modules/x.js', 'x'], ['dist/old.txt', 'o'], ['.codex/auth.json', 'token']]) {
    write(repo, file, content);
  }
  git('add', '.gitignore', 'tracked.txt', 'gone.txt');
  fs.rmSync(path.join(repo, 'gone.txt'));
  assert.deepEqual(sourceFiles(repo).sort(), ['.gitignore', 'sub/new.txt', 'tracked.txt']);
});

test('the wrapper runs as the host user and prepares a writable output folder', t => {
  assert.deepEqual(containerUser(501, 20), ['--user', '501:20']);
  assert.deepEqual(containerUser(0, 0), []);
  const output = path.join(scratch(t), 'dist/container');
  assert.equal(prepareOutput(output), output);
  assert.ok(fs.statSync(output).isDirectory());
});

test('the container entry unpacks the stream with image dependencies, then forwards the command', t => {
  const { dirs, run } = container(t);
  const result = run('sh', '-c', 'printf "%s|" "$@"; ls -A; cat node_modules/image.txt', 'probe', 'two words', '--flag');
  assert.equal(result.status, 0, result.stderr);
  const [forwarded, ...listing] = result.stdout.split('\n');
  assert.equal(forwarded, 'two words|--flag|' + 'bin');
  assert.deepEqual(listing.filter(Boolean).sort(), ['image', 'node_modules', 'package.json', 'pnpm-lock.yaml'].sort());
  assert.equal(fs.existsSync(dirs.output), false);
});

test('the container entry keeps the command exit status and exports failure evidence', t => {
  const { dirs, run } = container(t);
  const result = run('sh', '-c', 'mkdir -p dist/browser-artifacts/failure-1 && echo evidence > dist/browser-artifacts/failure-1/report.json && exit 7');
  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(path.join(dirs.output, 'browser-artifacts/failure-1/report.json'), 'utf8'), 'evidence\n');
});

test('the container entry keeps the command status when the export fails', t => {
  const { dirs, run } = container(t);
  fs.writeFileSync(dirs.output, 'not a folder');
  const evidence = 'mkdir -p dist/browser-artifacts && echo e > dist/browser-artifacts/r';
  const failed = run('sh', '-c', `${evidence} && exit 7`);
  assert.equal(failed.status, 7);
  assert.match(failed.stderr, /Could not export/);
  assert.equal(run('sh', '-c', evidence).status, 5);
});

test('the container entry refuses an unwritable output folder before running anything', t => {
  if (process.getuid() === 0) return t.skip('root can write any folder');
  const { dirs, run } = container(t);
  fs.mkdirSync(dirs.output, { mode: 0o500 });
  const result = run('sh', '-c', 'touch ran');
  assert.equal(result.status, 4);
  assert.equal(fs.existsSync(path.join(dirs.work, 'ran')), false);
});

for (const file of ['pnpm-lock.yaml', 'bin/browser-pins.json']) {
  test(`the container entry refuses a ${file} that differs from the image and runs nothing`, t => {
    const { dirs, run } = container(t);
    write(dirs.source, file, 'changed\n');
    const result = run('sh', '-c', 'touch ran');
    assert.equal(result.status, 3);
    assert.match(result.stderr, new RegExp(`${file.replace('.', '\\.')} differs[^\\n]+docker compose build browser-tests`));
    assert.equal(fs.existsSync(path.join(dirs.work, 'ran')), false);
  });
}

test('the container entry needs a command and a piped checkout', t => {
  const { run } = container(t);
  assert.equal(run().status, 2);
});

test('the browser container runs isolated and installs the versions CI uses', () => {
  const service = compose.split('\n  browser-tests:\n')[1];
  assert.ok(service, 'Missing browser-tests service');
  for (const setting of [/network_mode: none/, /read_only: true/, /cap_drop:\n\s+- ALL/, /no-new-privileges:true/, /platform: linux\/amd64/]) {
    assert.match(service, setting);
  }
  const volumes = service.split('volumes:\n')[1].match(/^\s+- (\S+)$/gm).map(line => line.trim().slice(2));
  assert.deepEqual(volumes, ['./dist/container:/out'], 'the checkout is streamed, and only failure evidence is writable on the host');
  assert.match(workflow, /run: node bin\/browser-container\.js pnpm smoke:browser/);
  assert.match(dockerfile, /^FROM node:([\d.]+)-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  const ciNode = workflow.match(/node-version: (\S+)/)[1];
  const ciPnpm = workflow.match(/pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version: (\S+)/)[1];
  assert.equal(dockerfile.match(/^FROM node:([\d.]+)-/m)[1], ciNode);
  assert.equal(dockerfile.match(/^ARG PNPM_VERSION=(\S+)$/m)[1], ciPnpm);
  assert.match(dockerfile, /COPY bin\/browser-pins\.json bin\/setup-chromium\.js \/opt\/createratio\/bin\//, 'the entry compares the checkout pins with this copy');
  assert.match(dockerfile, /RUN node \/opt\/createratio\/bin\/setup-chromium\.js/);
  assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(dockerfile, /pnpm_config_verify_deps_before_run=false/, 'the entry lockfile check replaces pnpm network verification');
});
