const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');

function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-git-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  function run(...args) {
    return spawnSync('git', args, { cwd: directory, env, encoding: 'utf8' });
  }
  function git(...args) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function commit(name) {
    fs.writeFileSync(path.join(directory, name), name);
    git('add', name);
    git('commit', '-m', name);
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  commit('initial');
  fs.cpSync(path.join(root, '.githooks'), path.join(directory, '.githooks'), { recursive: true });
  git('config', 'core.hooksPath', path.join(root, '.githooks'));
  return { directory, env, run, git, commit };
}

test('a real commit rejects staged whitespace errors and preserves HEAD', t => {
  const { directory, git, run } = repository(t);
  const before = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(directory, 'new.js'), 'const value = 1;\n\n');
  git('add', 'new.js');
  const result = run('commit', '-m', 'invalid whitespace');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /new blank line at EOF/);
  assert.equal(git('rev-parse', 'HEAD'), before);
  fs.writeFileSync(path.join(directory, 'new.js'), 'const value = 1;\n');
  git('add', 'new.js');
  git('commit', '-m', 'repaired whitespace');
  assert.notEqual(git('rev-parse', 'HEAD'), before);
});

test('commit checks the index, not unrelated working-tree whitespace', t => {
  const { directory, git } = repository(t);
  fs.writeFileSync(path.join(directory, 'new.js'), 'const value = 1;\n');
  git('add', 'new.js');
  fs.writeFileSync(path.join(directory, 'new.js'), 'const value = 1;  \n');
  git('commit', '-m', 'clean index');
  assert.equal(git('show', 'HEAD:new.js'), 'const value = 1;');
  assert.match(fs.readFileSync(path.join(directory, 'new.js'), 'utf8'), /;  \n/);
});

test('a real rebase cannot flatten merges on a tracked branch', t => {
  const { directory, git, run, commit } = repository(t);
  const remote = path.join(directory, 'remote.git');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('checkout', '-b', 'feature');
  commit('feature');
  git('push', '-u', 'origin', 'feature');
  git('checkout', 'main');
  commit('main-change');
  git('checkout', 'feature');
  git('merge', '--no-ff', 'main', '-m', 'merge-main');
  git('push', 'origin', 'feature');
  const before = git('rev-parse', 'HEAD');
  const result = run('rebase', 'main');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to flatten merge history/);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(fs.existsSync(path.join(directory, '.git', 'rebase-merge')), false);
  for (const args of [['rebase', 'main', 'refs/heads/feature'], ['rebase', '--root']]) {
    const rejected = run(...args);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Refusing to flatten merge history/);
    assert.equal(git('rev-parse', 'HEAD'), before);
  }
  git('pull', '--rebase', '--ff-only');
  assert.equal(git('rev-parse', 'HEAD'), before);
  git('branch', '--unset-upstream');
  const untracked = run('rebase', 'main');
  assert.notEqual(untracked.status, 0);
  assert.match(untracked.stderr, /Refusing to flatten merge history/);
  assert.equal(git('rev-parse', 'HEAD'), before);
});

test('unpublished linear branches can still rebase', t => {
  const { git, commit } = repository(t);
  git('checkout', '-b', 'feature');
  commit('feature');
  git('checkout', 'main');
  commit('main-change');
  git('checkout', 'feature');
  git('rebase', 'main');
  assert.equal(git('rev-list', '--count', 'main..HEAD'), '1');
});

test('explicit hook setup repairs hooks when an up-to-date frozen install skips prepare', t => {
  const { directory, env, git, run } = repository(t);
  git('config', '--unset', 'core.hooksPath');
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version', 'extension/package.json', 'site/package.json', 'bin/setup-git-hooks.js', '.githooks/pre-rebase', '.githooks/pre-commit']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: directory, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(git('config', '--get', 'core.hooksPath'), '.githooks');
  assert.match(result.stdout, /Repository Git hooks enabled/);
  git('config', '--unset', 'core.hooksPath');
  const repeated = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: directory, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(repeated.status, 0, repeated.stderr || repeated.error?.message);
  assert.equal(run('config', '--get', 'core.hooksPath').status, 1);
  const setup = spawnSync('pnpm', ['setup:hooks'], {
    cwd: directory, env, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  assert.equal(git('config', '--get', 'core.hooksPath'), '.githooks');
  fs.writeFileSync(path.join(directory, 'bad.js'), 'const value = 1;  \n');
  git('add', 'bad.js');
  const rejected = run('commit', '-m', 'invalid whitespace');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, /trailing whitespace/);
});

test('automatic setup tolerates source archives and environments without Git', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-no-git-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const PATH of [process.env.PATH, directory]) {
    const invoke = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/setup-git-hooks.js'), ...args], { cwd: directory, env: { ...process.env, PATH }, encoding: 'utf8' });
    assert.equal(invoke('--if-unconfigured').status, 0);
    const explicit = invoke();
    assert.equal(explicit.status, 1);
    assert.match(explicit.stderr, /Git guard requires Git and a repository checkout/);
  }
});

test('hook setup preserves custom files in the default Git hooks directory', t => {
  const { directory, env, git, run } = repository(t);
  git('config', '--unset', 'core.hooksPath');
  const hook = path.join(directory, '.git/hooks/pre-commit');
  const source = '#!/bin/sh\nexit 0\n';
  fs.writeFileSync(hook, source, { mode: 0o755 });
  for (const args of [[], ['--if-unconfigured']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/setup-git-hooks.js'), ...args], { cwd: directory, env, encoding: 'utf8' });
    assert.equal(result.status, args.length ? 0 : 1);
    assert.match(result.stderr, /Existing Git hook files/);
    assert.equal(run('config', '--get', 'core.hooksPath').status, 1);
    assert.equal(fs.readFileSync(hook, 'utf8'), source);
  }
});

test('hook setup refuses missing or nonexecutable checked-in hooks before changing config', t => {
  const { directory, env, git, run } = repository(t);
  git('config', '--unset', 'core.hooksPath');
  const hook = path.join(directory, '.githooks/pre-commit');
  fs.rmSync(hook);
  const invoke = () => spawnSync(process.execPath, [path.join(root, 'bin/setup-git-hooks.js')], { cwd: directory, env, encoding: 'utf8' });
  const missing = invoke();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing or nonexecutable checked-in Git hook/);
  assert.equal(run('config', '--get', 'core.hooksPath').status, 1);
  if (process.platform !== 'win32') {
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    assert.notEqual(invoke().status, 0);
    assert.equal(run('config', '--get', 'core.hooksPath').status, 1);
  }
});

test('hook setup preserves an explicitly disabled hook path', t => {
  const { directory, env, git } = repository(t);
  git('config', 'core.hooksPath', '');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/setup-git-hooks.js')], { cwd: directory, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Existing hooksPath/);
  assert.equal(git('config', '--get', 'core.hooksPath'), '');
});

test('hook setup is idempotent and preserves an existing hooks path', t => {
  const { directory, env, git } = repository(t);
  const setup = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/setup-git-hooks.js'), ...args], {
    cwd: directory, env, encoding: 'utf8',
  });
  git('config', '--unset', 'core.hooksPath');
  assert.equal(setup().status, 0);
  assert.equal(setup().status, 0);
  assert.equal(git('config', '--get', 'core.hooksPath'), '.githooks');
  git('config', 'core.hooksPath', 'custom-hooks');
  const result = setup();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Existing hooksPath custom-hooks/);
  const automatic = setup('--if-unconfigured');
  assert.equal(automatic.status, 0);
  assert.match(automatic.stderr, /Existing hooksPath custom-hooks/);
  assert.equal(git('config', '--get', 'core.hooksPath'), 'custom-hooks');
  const manifest = require('../../package.json');
  assert.equal(manifest.scripts.prepare, 'node bin/setup-git-hooks.js --if-unconfigured');
});
