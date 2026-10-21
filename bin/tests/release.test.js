const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../release.js');
const files = ['package.json', 'extension/package.json', 'extension/src/manifest.json'];

function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-release-command-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, 'checkout');
  const remote = path.join(directory, 'origin.git');
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'commands.jsonl');
  for (const folder of [checkout, bin]) fs.mkdirSync(folder, { recursive: true });
  const transport = path.join(directory, 'git-transport.cjs');
  fs.writeFileSync(transport, `const cp = require('node:child_process');
const spawnSync = cp.spawnSync;
cp.spawnSync = (program, args, options) => {
  const result = spawnSync(program, args, options);
  if (program === 'git' && args[0] === 'remote' && args[1] === 'get-url' && result.status === 0) {
    result.stdout = result.stdout.split('\\n').map(url => url === ${JSON.stringify(`file://${remote}`)} ? 'https://github.com/WebCu/createratio.git' : url).join('\\n');
  }
  return result;
};\n`);
  const env = {
    ...process.env, NODE_OPTIONS: `--require=${transport}`, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Release fixture', GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Release fixture', GIT_COMMITTER_EMAIL: 'release@example.invalid',
    CLI_LOG: log
  };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: checkout, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '--bare', '--initial-branch=main', remote);
  git('init', '--initial-branch=main');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(directory, 'empty-hooks'));
  git('config', `url.file://${remote}.insteadOf`, 'https://github.com/WebCu/createratio.git');
  git('remote', 'add', 'origin', 'https://github.com/WebCu/createratio.git');
  assert.equal(git('remote', 'get-url', '--push', 'origin'), `file://${remote}`);
  fs.mkdirSync(path.join(checkout, 'extension/src'), { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(checkout, file), '{\n  "version": "0.0.1",\n  "description": "keep formatting"\n}\n');
  git('add', '.');
  git('commit', '-m', 'Initial fixture');
  git('push', '--set-upstream', 'origin', 'main');
  for (const tool of ['gh', 'pnpm']) fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLI_LOG, JSON.stringify({tool: ${JSON.stringify(tool)}, args}) + '\\n');
if (${JSON.stringify(tool)} === 'gh' && args[0] === 'auth' && process.env.FAIL_AUTH) process.exit(1);
if (${JSON.stringify(tool)} === 'pnpm' && process.env.FAIL_CHECK) { console.error('Synthetic check failure'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/WebCu/createratio/pull/123');
`, { mode: 0o755 });
  return {
    checkout, remote, env, git,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    run: (args, overrides = {}) => spawnSync(process.execPath, [script, ...args], {
      cwd: checkout, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000
    })
  };
}

test('prepare patch bumps all three version fields and opens a checked release PR', t => {
  const repo = repository(t);
  const result = repo.run(['prepare', 'patch']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('branch', '--show-current'), 'release/v0.0.2');
  for (const file of files) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo.checkout, file), 'utf8')).version, '0.0.2');
    assert.equal(fs.readFileSync(path.join(repo.checkout, file), 'utf8'), '{\n  "version": "0.0.2",\n  "description": "keep formatting"\n}\n');
  }
  assert.deepEqual(repo.git('diff', '--name-only', 'main...HEAD').split('\n').sort(), files.slice().sort());
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(repo.git('--git-dir', repo.remote, 'rev-parse', 'refs/heads/release/v0.0.2'), repo.git('rev-parse', 'HEAD'));
  const calls = repo.calls();
  assert.ok(calls.some(call => call.tool === 'pnpm' && call.args.join(' ') === 'check'));
  const pr = calls.find(call => call.tool === 'gh' && call.args[0] === 'pr');
  assert.ok(pr);
  assert.equal(pr.args[pr.args.indexOf('--base') + 1], 'main');
  assert.equal(pr.args[pr.args.indexOf('--head') + 1], 'release/v0.0.2');
  assert.match(pr.args[pr.args.indexOf('--body') + 1], /## Evidence/);
  assert.equal(repo.git('tag', '--list'), '');
});

test('a merged version PR can be published without manually editing or choosing a tag', t => {
  const repo = repository(t);
  assert.equal(repo.run(['prepare', 'patch']).status, 0);
  repo.git('switch', 'main');
  repo.git('merge', '--ff-only', 'release/v0.0.2');
  repo.git('push', 'origin', 'main');
  const result = repo.run(['publish']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('--git-dir', repo.remote, 'rev-parse', 'refs/tags/v0.0.2^{}'), repo.git('rev-parse', 'HEAD'));
  assert.equal(repo.git('status', '--porcelain'), '');
});

test('minor and major preparation keep the shared version synchronized', t => {
  for (const [increment, expected] of [['minor', '0.1.0'], ['major', '1.0.0']]) {
    const repo = repository(t);
    const result = repo.run(['prepare', increment]);
    assert.equal(result.status, 0, result.stderr);
    for (const file of files) assert.equal(JSON.parse(fs.readFileSync(path.join(repo.checkout, file))).version, expected);
  }
});

test('preparation refuses missing GitHub authentication without modifying the checkout', t => {
  const repo = repository(t);
  const result = repo.run(['prepare', 'patch'], { FAIL_AUTH: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(repo.git('branch', '--show-current'), 'main');
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(repo.calls().filter(call => call.args[0] === 'pr').length, 0);
});

test('failed checks preserve the release branch and edits without publishing them', t => {
  const repo = repository(t);
  const result = repo.run(['prepare', 'patch'], { FAIL_CHECK: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Synthetic check failure/);
  assert.match(result.stderr, /pnpm check failed/);
  assert.equal(repo.git('branch', '--show-current'), 'release/v0.0.2');
  assert.ok(repo.git('status', '--porcelain'));
  assert.equal(repo.git('ls-remote', '--heads', 'origin', 'refs/heads/release/v0.0.2'), '');
  assert.equal(repo.calls().filter(call => call.args[0] === 'pr').length, 0);
});

test('prepare and publish refuse dirty, non-main, stale, divergent, or wrong-origin checkouts', t => {
  const cases = [
    ['dirty', repo => fs.writeFileSync(path.join(repo.checkout, 'untracked.txt'), 'preserve me'), /clean/],
    ['branch', repo => repo.git('switch', '-c', 'work'), /on main/],
    ['ahead', repo => {
      fs.writeFileSync(path.join(repo.checkout, 'local.txt'), 'local');
      repo.git('add', '.'); repo.git('commit', '-m', 'Local work');
    }, /match origin\/main/],
    ['behind', repo => {
      repo.git('switch', '-c', 'advance-remote');
      fs.writeFileSync(path.join(repo.checkout, 'remote.txt'), 'remote');
      repo.git('add', '.'); repo.git('commit', '-m', 'Remote work');
      repo.git('push', 'origin', 'HEAD:refs/heads/main'); repo.git('switch', 'main');
    }, /match origin\/main/],
    ['origin', repo => repo.git('config', 'remote.origin.url', 'https://github.com/WebCu/other.git'), /official/]
  ];
  for (const [label, setup, message] of cases) {
    const repo = repository(t);
    setup(repo);
    const head = repo.git('rev-parse', 'HEAD');
    for (const args of [['prepare', 'patch'], ['publish']]) {
      const result = repo.run(args);
      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, message, label);
      assert.equal(repo.git('rev-parse', 'HEAD'), head, label);
      assert.equal(repo.git('tag', '--list'), '', label);
    }
  }
});

test('push URLs and URL rewrites cannot redirect a release away from the official repository', t => {
  for (const mode of ['pushurl', 'pushInsteadOf', 'insteadOf']) {
    for (const args of [['prepare', 'patch'], ['publish']]) {
      const repo = repository(t);
      const other = path.join(path.dirname(repo.remote), 'other.git');
      repo.git('init', '--bare', other);
      if (mode === 'pushurl') repo.git('config', '--add', 'remote.origin.pushurl', `file://${other}`);
      if (mode === 'pushInsteadOf') repo.git('config', `url.file://${other}.pushInsteadOf`, 'https://github.com/WebCu/createratio.git');
      if (mode === 'insteadOf') {
        repo.git('config', '--unset-all', `url.file://${repo.remote}.insteadOf`);
        repo.git('config', `url.file://${other}.insteadOf`, 'https://github.com/WebCu/createratio.git');
      }
      const result = repo.run(args);
      assert.notEqual(result.status, 0, `${mode}: ${args}`);
      assert.match(result.stderr, /official/i);
      assert.equal(repo.git('branch', '--show-current'), 'main');
      assert.equal(repo.git('status', '--porcelain'), '');
      assert.equal(repo.git('tag', '--list'), '');
      assert.deepEqual(repo.calls(), []);
    }
  }
});

test('mismatched version fields and invalid commands cannot create a release', t => {
  const repo = repository(t);
  fs.writeFileSync(path.join(repo.checkout, files[2]), '{"version":"0.0.2"}\n');
  repo.git('add', '.'); repo.git('commit', '-m', 'Mismatched manifest'); repo.git('push', 'origin', 'main');
  for (const args of [['prepare', 'patch'], ['publish'], ['prepare', 'beta'], ['publish', 'extra'], ['prepare', 'patch', 'extra']]) {
    const result = repo.run(args);
    assert.notEqual(result.status, 0);
    assert.equal(repo.git('branch', '--show-current'), 'main');
    assert.equal(repo.git('tag', '--list'), '');
  }
});

test('unexpected or empty arguments cannot trigger publication', t => {
  for (const args of [[], ['publish', ''], ['publish', '', 'extra'], ['prepare', 'patch', ''], ['prepare', 'beta']]) {
    const repo = repository(t);
    const result = repo.run(args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(repo.git('tag', '--list'), '');
    assert.equal(repo.git('branch', '--show-current'), 'main');
    assert.deepEqual(repo.calls(), []);
  }
});

test('publish pushes an annotated matching tag without changing versions or creating a PR', t => {
  const repo = repository(t);
  const head = repo.git('rev-parse', 'HEAD');
  const result = repo.run(['publish']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('cat-file', '-t', 'refs/tags/v0.0.1'), 'tag');
  assert.equal(repo.git('--git-dir', repo.remote, 'rev-parse', 'refs/tags/v0.0.1^{}'), head);
  assert.equal(repo.git('rev-parse', 'HEAD'), head);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.deepEqual(repo.calls(), []);
});

test('publish reuses a matching local tag after a failed push but never moves or republishes tags', t => {
  const repo = repository(t);
  const hook = path.join(repo.remote, 'hooks/pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const failedPush = repo.run(['publish']);
  assert.notEqual(failedPush.status, 0);
  const tagObject = repo.git('rev-parse', 'refs/tags/v0.0.1');
  assert.equal(repo.git('ls-remote', '--tags', 'origin'), '');
  fs.rmSync(hook);
  assert.equal(repo.run(['publish']).status, 0);
  assert.equal(repo.git('rev-parse', 'refs/tags/v0.0.1'), tagObject);
  const repeated = repo.run(['publish']);
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /already exists remotely/);
  const other = repository(t);
  other.git('tag', '--annotate', 'v0.0.1', '--message', 'Original tag');
  const original = other.git('rev-parse', 'v0.0.1^{}');
  fs.writeFileSync(path.join(other.checkout, 'new.txt'), 'new work');
  other.git('add', '.'); other.git('commit', '-m', 'New main'); other.git('push', 'origin', 'main');
  const moved = other.run(['publish']);
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /another commit/);
  assert.equal(other.git('rev-parse', 'v0.0.1^{}'), original);
  assert.equal(other.git('ls-remote', '--tags', 'origin'), '');
});

test('version limits and ambiguous version fields fail before branch creation', t => {
  for (const contents of [
    '{"version":"65535.65535.65535"}\n',
    '{"version":"0.0.1","nested":{"version":"0.0.1"}}\n'
  ]) {
    const repo = repository(t);
    for (const file of files) fs.writeFileSync(path.join(repo.checkout, file), contents);
    repo.git('add', '.'); repo.git('commit', '-m', 'Version constraint fixture'); repo.git('push', 'origin', 'main');
    const result = repo.run(['prepare', 'patch']);
    assert.notEqual(result.status, 0);
    assert.equal(repo.git('branch', '--show-current'), 'main');
    assert.equal(repo.git('status', '--porcelain'), '');
    assert.deepEqual(repo.calls(), []);
  }
});

test('prepare refuses an existing release branch without overwriting its history', t => {
  const repo = repository(t);
  assert.equal(repo.run(['prepare', 'patch']).status, 0);
  const release = repo.git('rev-parse', 'HEAD');
  repo.git('switch', 'main');
  const duplicate = repo.run(['prepare', 'patch']);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /branch already exists/);
  assert.equal(repo.git('rev-parse', 'release/v0.0.2'), release);
  assert.equal(repo.git('branch', '--show-current'), 'main');
});
