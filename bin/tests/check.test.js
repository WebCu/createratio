'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const { scripts } = require('../../package.json');

function check(t, failAt = '', command = scripts.check) {
  const dir = mkdtempSync(path.join(tmpdir(), 'createratio-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  writeFileSync(path.join(dir, 'pnpm'), `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv[2];
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(command) + '\\n');
if (command === process.env.FAIL_AT) process.exit(7);
`, { mode: 0o755 });
  const result = spawnSync('sh', ['-c', command], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log, FAIL_AT: failAt }
  });
  return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

const stages = ['check:syntax', 'test', 'build', 'build:site'];

test('check runs syntax, tests, browser builds, and website build in order', t => {
  const result = check(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, stages);
});

for (const [index, stage] of stages.entries()) {
  test(`check propagates ${stage} failure and stops before later stages`, t => {
    const result = check(t, stage);
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(result.calls, stages.slice(0, index + 1));
  });
}

test('browser check builds the bundle before testing it', t => {
  const result = check(t, '', scripts['check:browser']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['build:chrome', 'test:browser']);
});

for (const [index, stage] of ['build:chrome', 'test:browser'].entries()) {
  test(`browser check propagates ${stage} failure and stops before later stages`, t => {
    const result = check(t, stage, scripts['check:browser']);
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(result.calls, ['build:chrome', 'test:browser'].slice(0, index + 1));
  });
}
