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
  assert.deepEqual(files.filter(file => file === '.pi' || file.startsWith('.pi/')).sort(), [],
    'Keep personal agent configuration outside the repository; untrack root .pi paths.');
});
