'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repository } = require('./release-fixture.js');

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

test('publication pushes only its matching tag despite automatic tag and mirror settings', t => {
  for (const mirror of [false, true]) {
    const repo = repository(t);
    repo.git('push', 'origin', 'HEAD:refs/heads/retained-remote');
    repo.git('tag', '--annotate', 'v9.9.9', '--message', 'Unrelated release');
    repo.git('branch', 'unrelated-work');
    repo.git('config', 'push.followTags', 'true');
    repo.git('config', 'remote.origin.mirror', String(mirror));
    repo.git('config', '--add', 'remote.origin.push', 'refs/heads/unrelated-work:refs/heads/unrelated-work');
    const result = repo.run(['publish']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(repo.git('--git-dir', repo.remote, 'for-each-ref', '--format=%(refname)').split('\n').sort(), [
      'refs/heads/main',
      'refs/heads/retained-remote',
      'refs/tags/v0.0.1'
    ]);
    assert.equal(repo.git('tag', '--list'), 'v0.0.1\nv9.9.9');
    assert.equal(repo.git('config', '--get', 'remote.origin.mirror'), String(mirror));
    assert.equal(repo.git('config', '--get', 'push.followTags'), 'true');
  }
});

test('publish creates a GitHub release with generated changes on the matching annotated tag', t => {
  const repo = repository(t);
  const head = repo.git('rev-parse', 'HEAD');
  const result = repo.run(['publish']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('cat-file', '-t', 'refs/tags/v0.0.1'), 'tag');
  assert.equal(repo.git('--git-dir', repo.remote, 'rev-parse', 'refs/tags/v0.0.1^{}'), head);
  assert.equal(repo.git('rev-parse', 'HEAD'), head);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.deepEqual(repo.calls(), [
    { tool: 'gh', args: ['auth', 'status', '--hostname', 'github.com'] },
    {
      tool: 'gh',
      args: [
        'release',
        'create',
        'v0.0.1',
        '--repo',
        'WebCu/createratio',
        '--verify-tag',
        '--title',
        'Release 0.0.1',
        '--generate-notes'
      ]
    }
  ]);
  assert.match(result.stdout, /https:\/\/github.com\/WebCu\/createratio\/releases\/tag\/v0.0.1/);
});

test('publish refuses an existing lightweight tag without replacing or pushing it', t => {
  const repo = repository(t);
  repo.git('tag', 'v0.0.1');
  const original = repo.git('rev-parse', 'refs/tags/v0.0.1');
  const result = repo.run(['publish']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /annotated/i);
  assert.equal(repo.git('cat-file', '-t', 'refs/tags/v0.0.1'), 'commit');
  assert.equal(repo.git('rev-parse', 'refs/tags/v0.0.1'), original);
  assert.equal(repo.git('ls-remote', '--tags', 'origin'), '');
  assert.equal(repo.git('status', '--porcelain'), '');
});

test('existing annotated-tag validation uses the tag namespace, not a same-named branch', t => {
  for (const matchingTag of [true, false]) {
    const repo = repository(t);
    const initial = repo.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo.checkout, 'advance.txt'), 'New main');
    repo.git('add', '.');
    repo.git('commit', '-m', 'Advance main');
    repo.git('push', 'origin', 'main');
    const head = repo.git('rev-parse', 'HEAD');
    repo.git('tag', '--annotate', 'v0.0.1', matchingTag ? head : initial, '--message', 'Existing annotated tag');
    repo.git('branch', 'v0.0.1', matchingTag ? initial : head);
    const original = repo.git('rev-parse', 'refs/tags/v0.0.1');
    const result = repo.run(['publish']);
    assert.equal(repo.git('rev-parse', 'refs/tags/v0.0.1'), original);
    if (matchingTag) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(repo.git('--git-dir', repo.remote, 'rev-parse', 'refs/tags/v0.0.1'), original);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /another commit/);
      assert.equal(repo.git('ls-remote', '--tags', 'origin'), '');
    }
  }
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
  assert.match(repeated.stderr, /Inspect the GitHub release/);
  const other = repository(t);
  other.git('tag', '--annotate', 'v0.0.1', '--message', 'Original tag');
  const original = other.git('rev-parse', 'v0.0.1^{}');
  fs.writeFileSync(path.join(other.checkout, 'new.txt'), 'new work');
  other.git('add', '.');
  other.git('commit', '-m', 'New main');
  other.git('push', 'origin', 'main');
  const moved = other.run(['publish']);
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /another commit/);
  assert.equal(other.git('rev-parse', 'v0.0.1^{}'), original);
  assert.equal(other.git('ls-remote', '--tags', 'origin'), '');
});

test('publication authentication fails before creating or pushing a tag', t => {
  const repo = repository(t);
  const result = repo.run(['publish'], { FAIL_AUTH: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(repo.git('tag', '--list'), '');
  assert.equal(repo.git('ls-remote', '--tags', 'origin'), '');
  assert.equal(repo.calls().filter(call => call.args[0] === 'release').length, 0);
});

test('a failed release creation preserves the tag and can resume without moving it', t => {
  const repo = repository(t);
  const failed = repo.run(['publish'], { FAIL_RELEASE: '1' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Inspect the GitHub release/);
  const tag = repo.git('--git-dir', repo.remote, 'rev-parse', 'refs/tags/v0.0.1');
  assert.equal(repo.git('status', '--porcelain'), '');
  const resumed = repo.run(['publish']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(repo.git('--git-dir', repo.remote, 'rev-parse', 'refs/tags/v0.0.1'), tag);
});

test('remote tags must be annotated and point to current main before release creation', t => {
  for (const annotated of [false, true]) {
    const repo = repository(t);
    repo.git('tag', ...(annotated ? ['--annotate', 'v0.0.1', '--message', 'Old release'] : ['v0.0.1']));
    repo.git('push', 'origin', 'refs/tags/v0.0.1:refs/tags/v0.0.1');
    if (annotated) {
      repo.git('commit', '--allow-empty', '-m', 'New main');
      repo.git('push', 'origin', 'main');
    }
    const result = repo.run(['publish']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /remote tag must be annotated and point to current main/);
    assert.equal(repo.calls().filter(call => call.args[0] === 'release').length, 0);
  }
});
