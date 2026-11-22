'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { versionFiles, repository } = require('./release-fixture.js');

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
    ['origin repository', repo => repo.git('config', 'remote.origin.url', 'https://github.com/WebCu/other.git'), /official/],
    ['origin host', repo => repo.git('config', 'remote.origin.url', 'https://example.invalid/WebCu/createratio.git'), /official/]
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
  fs.writeFileSync(path.join(repo.checkout, versionFiles[2]), '{"version":"0.0.2"}\n');
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
