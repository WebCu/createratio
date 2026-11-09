'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('tracked files exclude root personal agent configuration', () => {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 10000
  }).trim();
  const files = execFileSync('git', ['ls-files', '--cached', '-z'], {
    cwd: root, encoding: 'utf8', timeout: 10000
  }).split('\0');
  const privatePaths = ['.pi', '.agents/skills', '.claude/skills'];
  const trackedPrivateFiles = files.filter(file => privatePaths.some(prefix => file === prefix || file.startsWith(`${prefix}/`)));
  assert.deepEqual(trackedPrivateFiles.sort(), [],
    'Keep personal agent configuration untracked, including skill directories and compatibility symlinks.');
});
