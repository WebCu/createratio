const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { preflight } = require('../agent-preflight');

const root = path.resolve(__dirname, '../..');

function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tools = path.join(directory, 'tools');
  fs.mkdirSync(tools);
  const pnpm = path.join(tools, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  fs.writeFileSync(pnpm, '', { mode: 0o755 });
  const env = { ...process.env, PATH: tools + path.delimiter + process.env.PATH, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', CHROMIUM_PATH: '', CHROMIUM: '' };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: directory, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function run(command, args, options) {
    if (command === pnpm) return { status: 0, stdout: '12.11.2\n', stderr: '' };
    return spawnSync(command, args, options);
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  for (const file of ['package.json', '.githooks/pre-commit', '.githooks/pre-rebase']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  git('add', 'package.json', '.githooks');
  git('commit', '-m', 'initial');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { directory, env, git, run, pnpm };
}

test('offline preflight from a subdirectory reports missing actual hooks without changing configuration', t => {
  const { directory, env, run, pnpm } = repository(t);
  const subdirectory = path.join(directory, 'nested');
  fs.mkdirSync(subdirectory);
  const report = preflight({ cwd: subdirectory, env, run });
  assert.equal(report.root, directory);
  assert.equal(report.architecture, process.arch);
  assert.equal(report.toolchain.node.executable, process.execPath);
  assert.equal(report.toolchain.node.compatible, true);
  assert.equal(report.toolchain.pnpm.executable, pnpm);
  assert.equal(report.toolchain.pnpm.version, '12.11.2');
  assert.equal(report.hooks.active, false);
  assert.equal(report.hooks.configuredPath, null);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /--setup-hooks/);
  assert.equal(report.upstream.behind, 0);
});

test('explicit preflight setup enables real hooks in an existing checkout and rejects whitespace commits', t => {
  const { directory, env, run, git } = repository(t);
  const before = git('rev-parse', 'HEAD');
  const report = preflight({ cwd: directory, env, run, setupHooks: true });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.hooks.active, true);
  assert.equal(git('config', '--get', 'core.hooksPath'), '.githooks');
  fs.writeFileSync(path.join(directory, 'bad.js'), 'const value = 1;  \n');
  git('add', 'bad.js');
  const commit = spawnSync('git', ['commit', '-m', 'bad whitespace'], { cwd: directory, env, encoding: 'utf8' });
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr + commit.stdout, /trailing whitespace/);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(preflight({ cwd: directory, env, run, setupHooks: true }).ok, true);
});

function write(directory, name, contents = name + '\n') {
  fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
  fs.writeFileSync(path.join(directory, name), contents);
}

test('toolchain failures and stable minimums use the selected executables without installing', t => {
  const { directory, env, run, pnpm } = repository(t);
  for (const [nodeVersion, pnpmVersion, supported] of [
    ['24.0.0', '12.0.0', true],
    ['26.1.0', '13.0.1', true],
    ['23.9.0', '11.9.0', false],
    ['24.0.0-rc.1', '12.0.0-beta.1', false],
  ]) {
    const selected = (command, args, options) => {
      if (command === process.execPath && args[0] === '--version') return { status: 0, stdout: 'v' + nodeVersion, stderr: '' };
      if (command === pnpm) return { status: 0, stdout: pnpmVersion, stderr: '' };
      return run(command, args, options);
    };
    const report = preflight({ cwd: directory, env, run: selected });
    assert.equal(report.toolchain.node.compatible, supported);
    assert.equal(report.toolchain.pnpm.compatible, supported);
    if (!supported) assert.match(report.errors.join('\n'), /Select a compatible toolchain on PATH/);
  }
  const broken = preflight({ cwd: directory, env, run: (command, args, options) => command === pnpm ? { status: null, error: new Error('wrong executable architecture') } : run(command, args, options) });
  assert.equal(broken.toolchain.pnpm.compatible, false);
  fs.rmSync(pnpm);
  const missing = preflight({ cwd: directory, env: { ...env, PATH: path.dirname(pnpm) }, run: (command, args, options) => command === 'git' ? run(command, args, { ...options, env }) : run(command, args, options) });
  assert.equal(missing.toolchain.pnpm.executable, null);
  assert.equal(missing.ok, false);
});

test('setup preserves custom hooks and reports why manual integration is needed', t => {
  for (const customPath of ['custom hooks', '']) {
    const { directory, env, run, git } = repository(t);
    git('config', 'core.hooksPath', customPath);
    const report = preflight({ cwd: directory, env, run, setupHooks: true });
    assert.equal(report.ok, false);
    assert.equal(report.hooks.configuredPath, customPath);
    assert.equal(git('config', '--get', 'core.hooksPath'), customPath);
    assert.match(report.errors.join('\n'), /Preserve custom hooks/);
    assert.match(report.warnings.join('\n'), /custom.*preserved/i);
  }
  const { directory, env, run, git } = repository(t);
  const hook = path.join(directory, '.git/hooks/pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const report = preflight({ cwd: directory, env, run, setupHooks: true });
  assert.equal(report.ok, false);
  assert.equal(report.hooks.configuredPath, null);
  assert.match(report.hooks.setupMessage, /Existing Git hook files/);
  assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(git('status', '--porcelain', '--', '.githooks'), '');
});

test('version queries disable tool-manager downloads and package manifest pinning', t => {
  const { directory, env, run, pnpm } = repository(t);
  const before = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
  const report = preflight({ cwd: directory, env, run: (command, args, options) => {
    if (command === pnpm) {
      assert.equal(options.env.COREPACK_ENABLE_NETWORK, '0');
      assert.equal(options.env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
      assert.equal(options.env.COREPACK_ENABLE_AUTO_PIN, '0');
      assert.equal(options.env.npm_config_manage_package_manager_versions, 'false');
    }
    return run(command, args, options);
  } });
  assert.equal(report.toolchain.pnpm.compatible, true);
  assert.equal(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'), before);
});

test('effective inherited hook paths are preserved without creating a local override', t => {
  const { directory, env, run } = repository(t);
  const configuration = path.join(directory, 'user.gitconfig');
  fs.writeFileSync(configuration, '[core]\n\thooksPath = custom-hooks\n');
  const inherited = { ...env, GIT_CONFIG_GLOBAL: configuration };
  const report = preflight({ cwd: directory, env: inherited, run, setupHooks: true });
  assert.equal(report.hooks.configuredPath, 'custom-hooks');
  assert.equal(report.hooks.active, false);
  const local = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: directory, env: inherited, encoding: 'utf8' });
  assert.equal(local.status, 1);
  assert.equal(fs.readFileSync(configuration, 'utf8'), '[core]\n\thooksPath = custom-hooks\n');
});

test('hook paths resolving to the checked-in directory are recognized without replacing configuration', t => {
  const { directory, env, run, git } = repository(t);
  const configuredPath = '.githooks/../.githooks/';
  git('config', 'core.hooksPath', configuredPath);
  const report = preflight({ cwd: directory, env, run, setupHooks: true });
  assert.equal(report.hooks.active, true, JSON.stringify(report));
  assert.equal(report.ok, true);
  assert.equal(git('config', '--get', 'core.hooksPath'), configuredPath);
});

test('safe hook setup and inspection use the actual linked worktree from a subdirectory', t => {
  const { directory, env, run, git } = repository(t);
  const worktree = path.join(directory, 'linked');
  git('worktree', 'add', '-b', 'linked', worktree);
  const nested = path.join(worktree, 'nested');
  fs.mkdirSync(nested);
  const report = preflight({ cwd: nested, env, run, setupHooks: true });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.root, worktree);
  assert.equal(report.hooks.path, path.join(worktree, '.githooks'));
  assert.equal(report.hooks.active, true);
});

test('configuration alone does not prove actual hook activation', t => {
  const { directory, env, run, git } = repository(t);
  git('config', 'core.hooksPath', '.githooks');
  fs.rmSync(path.join(directory, '.githooks/pre-rebase'));
  const report = preflight({ cwd: directory, env, run });
  assert.equal(report.ok, false);
  assert.equal(report.hooks.active, false);
  assert.equal(report.hooks.files.find(file => file.name === 'pre-rebase').executable, false);
});

test('upstream drift warns with committed, staged, and untracked high-conflict overlaps without rewriting branches', t => {
  const { directory, env, run, git } = repository(t);
  const base = git('rev-parse', 'HEAD');
  const common = ['package.json', '.github/workflows/check.yml', 'pnpm-lock.yaml', '.node-version', 'CONTRIBUTING.md', 'extension/src/tests/content-harness.js'];
  git('checkout', '-b', 'feature');
  fs.appendFileSync(path.join(directory, 'package.json'), '\n');
  git('add', 'package.json');
  git('commit', '-m', 'local package');
  git('checkout', 'main');
  for (const name of common.slice(1)) write(directory, name);
  fs.appendFileSync(path.join(directory, 'package.json'), '\n\n');
  write(directory, 'ordinary.txt');
  git('add', '.');
  git('commit', '-m', 'upstream changes');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const current = git('rev-parse', 'HEAD');
  git('checkout', 'feature');
  write(directory, '.github/workflows/check.yml', 'local workflow\n');
  git('add', '.github/workflows/check.yml');
  for (const name of common.slice(2)) write(directory, name, 'local\n');
  const head = git('rev-parse', 'HEAD');
  const before = git('status', '--porcelain');
  const commands = [];
  const report = preflight({ cwd: directory, env, setupHooks: true, run: (command, args, options) => {
    commands.push([command, ...args]);
    return run(command, args, options);
  } });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.upstream.base, base);
  assert.equal(report.upstream.current, current);
  assert.equal(report.upstream.head, head);
  assert.equal(report.upstream.ahead, 1);
  assert.equal(report.upstream.behind, 1);
  assert.deepEqual(report.upstream.upstreamPaths, [...common].sort());
  assert.deepEqual(report.upstream.overlappingPaths, [...common].sort());
  assert.match(report.warnings.join('\n'), /origin\/main.*1 commit/);
  assert.match(report.warnings.join('\n'), /overlap.*package.json/i);
  assert.equal(commands.some(args => args.includes('fetch')), false);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), before);
});

test('fetch is opt-in, refreshes only origin/main, and leaves HEAD unchanged', t => {
  const { directory, env, run, git } = repository(t);
  const remote = path.join(directory, 'remote.git');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main');
  const base = git('rev-parse', 'HEAD');
  write(directory, 'CONTRIBUTING.md');
  git('add', 'CONTRIBUTING.md');
  git('commit', '-m', 'new upstream');
  git('push', 'origin', 'main');
  const current = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'feature', base);
  git('update-ref', 'refs/remotes/origin/main', base);
  assert.equal(preflight({ cwd: directory, env, run }).upstream.current, base);
  const report = preflight({ cwd: directory, env, run, fetch: true, setupHooks: true });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.upstream.beforeFetch, base);
  assert.equal(report.upstream.current, current);
  assert.equal(report.upstream.behind, 1);
  assert.equal(report.upstream.refreshed, true);
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.equal(git('branch', '--show-current'), 'feature');
});

test('missing or unrelated upstream is actionable warning-only; requested fetch failure is an error', t => {
  const { directory, env, run, git } = repository(t);
  git('update-ref', '-d', 'refs/remotes/origin/main');
  const missing = preflight({ cwd: directory, env, run, setupHooks: true });
  assert.equal(missing.ok, true, JSON.stringify(missing));
  assert.equal(missing.upstream.current, null);
  assert.match(missing.warnings.join('\n'), /--fetch/);
  const failed = preflight({ cwd: directory, env, fetch: true, run: (command, args, options) => {
    if (command === 'git' && args[0] === 'fetch') return { status: 128, stdout: '', stderr: 'private remote credentials' };
    return run(command, args, options);
  } });
  assert.equal(failed.ok, false);
  assert.match(failed.errors.join('\n'), /fetch.*origin.*failed/i);
  assert.doesNotMatch(JSON.stringify(failed), /private remote credentials/);
  git('checkout', '--orphan', 'unrelated');
  git('rm', '-rf', '.');
  write(directory, 'unrelated.txt');
  git('add', 'unrelated.txt');
  git('-c', 'core.hooksPath=' + os.devNull, 'commit', '-m', 'unrelated');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', 'main');
  const unrelated = preflight({ cwd: directory, env, run });
  assert.equal(unrelated.ok, true, JSON.stringify(unrelated));
  assert.equal(unrelated.upstream.base, null);
  assert.match(unrelated.warnings.join('\n'), /common base.*shallow|shallow.*common base/i);
});

test('optional browser diagnostics compare only --version against the workflow download pin', t => {
  const { directory, env, run, git } = repository(t);
  git('config', 'core.hooksPath', '.githooks');
  write(directory, '.github/workflows/ci.yml', 'steps:\n  - name: Chrome for Testing 100.0.0.0\n    run: curl https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.79/linux64/chrome-linux64.zip\n');
  const browser = path.join(directory, 'browser with spaces');
  for (const [output, status, version, matchesCI] of [
    ['Google Chrome for Testing 155.0.8059.79\n', 0, '155.0.8059.79', true],
    ['Chromium 154.0.8000.1\n', 0, '154.0.8000.1', false],
    ['', null, null, null],
    ['unknown browser version\n', 0, null, null],
  ]) {
    const queries = [];
    const report = preflight({ cwd: directory, env: { ...env, CHROMIUM_PATH: browser, CHROMIUM: 'must-not-run' }, run: (command, args, options) => {
      if (command === browser) {
        queries.push(args);
        return { status, stdout: output, stderr: '', error: status === null ? new Error('unrunnable') : undefined };
      }
      assert.notEqual(command, 'must-not-run');
      return run(command, args, options);
    } });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.browser, { executable: browser, version, ciVersion: '155.0.8059.79', matchesCI });
    assert.deepEqual(queries, [['--version']]);
    if (matchesCI === false) assert.match(report.warnings.join('\n'), /browser.*154\.0\.8000\.1.*CI.*155\.0\.8059\.79/i);
    if (version === null) assert.match(report.warnings.join('\n'), /browser.*unrunnable|browser.*version.*unavailable/i);
  }
});

test('absent optional browser and unavailable CI pin never fail otherwise-valid preflight', t => {
  const { directory, env, run, git } = repository(t);
  git('config', 'core.hooksPath', '.githooks');
  const absent = preflight({ cwd: directory, env, run });
  assert.equal(absent.ok, true);
  assert.equal(absent.browser, null);
  assert.doesNotMatch(absent.warnings.join('\n'), /browser/i);
  const browser = 'configured-chromium';
  const inspect = () => preflight({ cwd: directory, env: { ...env, CHROMIUM: browser }, run: (command, args, options) => command === browser ? { status: 0, stdout: 'Chromium 155.0.8059.79\n', stderr: '' } : run(command, args, options) });
  for (const workflow of [null, 'steps: []\n']) {
    if (workflow !== null) write(directory, '.github/workflows/ci.yml', workflow);
    const report = inspect();
    assert.equal(report.ok, true);
    assert.deepEqual(report.browser, { executable: browser, version: '155.0.8059.79', ciVersion: null, matchesCI: null });
    assert.match(report.warnings.join('\n'), /CI browser pin.*ci\.yml/i);
  }
});

test('CLI emits machine-readable failures, supports report-only, and rejects unknown options', t => {
  const { directory, env } = repository(t);
  const invoke = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/agent-preflight.js'), ...args], { cwd: directory, env, encoding: 'utf8' });
  const strict = invoke('--json');
  assert.equal(strict.status, 1, strict.stderr);
  assert.equal(JSON.parse(strict.stdout).ok, false);
  assert.equal(strict.stderr, '');
  const informational = invoke('--json', '--report-only');
  assert.equal(informational.status, 0);
  assert.equal(JSON.parse(informational.stdout).ok, false);
  const invalid = invoke('--force');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unknown option/);
  assert.match(invoke('--help').stdout, /Offline by default/);
});
