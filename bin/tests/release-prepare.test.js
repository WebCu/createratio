'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { versionFiles, repository } = require('./release-fixture.js');

test('prepare patch bumps all three version fields and opens a checked release PR', t => {
  const repo = repository(t);
  const result = repo.run(['prepare', 'patch']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('branch', '--show-current'), 'release/v0.0.2');
  for (const file of versionFiles) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo.checkout, file), 'utf8')).version, '0.0.2');
    assert.equal(fs.readFileSync(path.join(repo.checkout, file), 'utf8'), '{\n  "version": "0.0.2",\n  "description": "keep formatting"\n}\n');
  }
  assert.deepEqual(repo.git('diff', '--name-only', 'main...HEAD').split('\n').sort(), versionFiles.slice().sort());
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

test('preparation pushes only its branch despite automatic tag and mirror settings', t => {
  for (const mirror of [false, true]) {
    const repo = repository(t);
    repo.git('push', 'origin', 'HEAD:refs/heads/retained-remote');
    repo.git('tag', '--annotate', 'v9.9.9', '--message', 'Unrelated release');
    repo.git('branch', 'unrelated-work');
    repo.git('config', 'push.followTags', 'true');
    repo.git('config', 'remote.origin.mirror', String(mirror));
    repo.git('config', '--add', 'remote.origin.push', 'refs/tags/v9.9.9:refs/tags/v9.9.9');
    const result = repo.run(['prepare', 'patch']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(repo.git('--git-dir', repo.remote, 'for-each-ref', '--format=%(refname)').split('\n').sort(), [
      'refs/heads/main', 'refs/heads/release/v0.0.2', 'refs/heads/retained-remote'
    ]);
    assert.equal(repo.git('tag', '--list'), 'v9.9.9');
    assert.equal(repo.git('config', '--get', 'remote.origin.mirror'), String(mirror));
    assert.equal(repo.git('config', '--get', 'push.followTags'), 'true');
  }
});

test('a same-named local tag cannot replace or block the prepared branch push', t => {
  const repo = repository(t);
  repo.git('tag', '--annotate', 'release/v0.0.2', '--message', 'Same-named local tag');
  const result = repo.run(['prepare', 'patch']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(repo.git('--git-dir', repo.remote, 'for-each-ref', '--format=%(refname)').split('\n').sort(), [
    'refs/heads/main', 'refs/heads/release/v0.0.2'
  ]);
  assert.equal(repo.git('tag', '--list'), 'release/v0.0.2');
});

test('minor and major preparation keep the shared version synchronized', t => {
  for (const [increment, expected] of [['minor', '0.1.0'], ['major', '1.0.0']]) {
    const repo = repository(t);
    const result = repo.run(['prepare', increment]);
    assert.equal(result.status, 0, result.stderr);
    for (const file of versionFiles) assert.equal(JSON.parse(fs.readFileSync(path.join(repo.checkout, file))).version, expected);
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

test('version limits and ambiguous version fields fail before branch creation', t => {
  for (const contents of [
    '{"version":"65535.65535.65535"}\n',
    '{"version":"0.0.1","nested":{"version":"0.0.1"}}\n'
  ]) {
    const repo = repository(t);
    for (const file of versionFiles) fs.writeFileSync(path.join(repo.checkout, file), contents);
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
