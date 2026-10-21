'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '../verify.js');
const stages = ['check', 'check:browser', 'smoke:browser'];

function workspace(t, available = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'createratio-verify-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (available) writeFileSync(path.join(directory, 'pnpm'), `#!${process.execPath}
const fs = require('node:fs');
const stage = process.argv[2];
fs.appendFileSync(process.env.CALL_LOG, stage + '\\n');
console.log('fixture output: ' + stage);
console.error('fixture stderr: ' + stage);
if (process.env.FAIL_AT === 'signal:' + stage) process.kill(process.pid, 'SIGTERM');
if (stage === process.env.FAIL_AT) process.exit(7);
`, { mode: 0o755 });
  return failAt => {
    const callLog = path.join(directory, 'calls');
    writeFileSync(callLog, '');
    const result = spawnSync(process.execPath, [script], {
      cwd: directory, encoding: 'utf8',
      env: { ...process.env, PATH: directory, TMPDIR: directory, CALL_LOG: callLog, FAIL_AT: failAt || '' }
    });
    assert.ok(result.stdout.includes('Verification logs: '), result.stderr);
    const output = result.stdout.match(/^Verification logs: (.+)$/m)[1];
    return { ...result, output, calls: readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean), summary: JSON.parse(readFileSync(path.join(output, 'summary.json'), 'utf8')) };
  };
}

test('verification preserves a terminated stage as a signal-based failure', t => {
  const result = workspace(t)('signal:check');
  assert.equal(result.status, 143);
  assert.deepEqual(result.calls, ['check']);
  assert.deepEqual(result.summary.stages.map(stage => stage.status), ['failed', 'not-run', 'not-run']);
  assert.equal(result.summary.stages[0].exitCode, 143);
});

test('verification reports an unavailable package manager as a failed stage, not a success', t => {
  const result = workspace(t, false)();
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.summary.stages.map(stage => stage.status), ['failed', 'not-run', 'not-run']);
  assert.match(result.stderr, /ENOENT/);
});

test('verification keeps separate logs for every stage and never reuses an earlier run', t => {
  const run = workspace(t);
  const first = run();
  const second = run();
  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, stages);
    assert.deepEqual(result.summary.stages.map(stage => stage.status), ['passed', 'passed', 'passed']);
    for (const stage of result.summary.stages) {
      const log = readFileSync(path.join(result.output, stage.log), 'utf8');
      assert.match(log, new RegExp('fixture output: ' + stage.name));
      assert.match(log, new RegExp('fixture stderr: ' + stage.name));
    }
  }
  assert.notEqual(first.output, second.output);
});

for (const [index, name] of stages.entries()) {
  test(`verification preserves ${name} failure and marks later stages not run`, t => {
    const run = workspace(t);
    const success = run();
    const failed = run(name);
    assert.equal(failed.status, 7, failed.stderr);
    assert.deepEqual(failed.calls, stages.slice(0, index + 1));
    assert.deepEqual(failed.summary.stages.map(stage => stage.status), stages.map((_, position) => position < index ? 'passed' : position === index ? 'failed' : 'not-run'));
    assert.equal(failed.summary.stages[index].exitCode, 7);
    assert.match(failed.stderr, new RegExp('fixture stderr: ' + name));
    assert.notEqual(success.output, failed.output);
    for (const stage of failed.summary.stages.slice(index + 1)) {
      assert.equal(existsSync(path.join(failed.output, stage.log)), false);
      assert.ok(failed.stdout.includes(`NOT RUN ${stage.name}`));
    }
  });
}
