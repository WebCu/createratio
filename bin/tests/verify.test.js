'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '../verify.js');
const stages = ['check', 'check:browser', 'smoke:browser'];

function workspace(t, { available = true, repository = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'createratio-verify-test-'));
  const project = path.join(directory, 'project');
  mkdirSync(project);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (repository) {
    for (const args of [
      ['init', '--initial-branch=main'], ['config', 'user.name', 'Verification fixture'],
      ['config', 'user.email', 'verify@example.invalid'], ['config', 'commit.gpgsign', 'false']
    ]) assert.equal(spawnSync('git', args, { cwd: project }).status, 0);
    writeFileSync(path.join(project, 'source.txt'), 'original');
    assert.equal(spawnSync('git', ['add', '.'], { cwd: project }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-m', 'Fixture'], { cwd: project }).status, 0);
  }
  if (available) writeFileSync(path.join(directory, 'pnpm'), `#!${process.execPath}
const fs = require('node:fs');
const stage = process.argv[2];
if (stage === '--version') { console.log('12.11.2'); process.exit(0); }
fs.appendFileSync(process.env.CALL_LOG, stage + '\\n');
console.log('fixture output: ' + stage);
console.error('fixture stderr: ' + stage);
if (process.env.FAIL_AT === 'signal:' + stage) process.kill(process.pid, 'SIGTERM');
if (stage === process.env.FAIL_AT) process.exit(7);
`, { mode: 0o755 });
  return (failAt, overrides = {}) => {
    const callLog = path.join(directory, 'calls');
    writeFileSync(callLog, '');
    const result = spawnSync(process.execPath, [script], {
      cwd: project, encoding: 'utf8',
      env: { ...process.env, PATH: repository ? directory + path.delimiter + process.env.PATH : directory, TMPDIR: directory, CALL_LOG: callLog, FAIL_AT: failAt || '', ...overrides }
    });
    assert.ok(result.stdout.includes('Verification logs: '), result.stderr);
    const output = result.stdout.match(/^Verification logs: (.+)$/m)[1];
    return { ...result, cwd: project, output, calls: readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean), summary: JSON.parse(readFileSync(path.join(output, 'summary.json'), 'utf8')) };
  };
}

test('verification records the actual commit, working-tree state and tool versions', t => {
  const run = workspace(t, { repository: true });
  const clean = run();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: clean.cwd, encoding: 'utf8' }).stdout.trim();
  assert.deepEqual(clean.summary.source, { head, dirty: false });
  assert.deepEqual(clean.summary.runtime, { node: process.version, pnpm: '12.11.2' });
  writeFileSync(path.join(clean.cwd, 'source.txt'), 'modified');
  assert.deepEqual(run().summary.source, { head, dirty: true });
});

test('verification provenance reads leave a stale caller index byte-for-byte unchanged', t => {
  const run = workspace(t, { repository: true });
  const first = run();
  const index = path.join(first.cwd, '.git/index');
  const original = readFileSync(index);
  const changedTime = new Date(Date.now() + 2000);
  utimesSync(path.join(first.cwd, 'source.txt'), changedTime, changedTime);
  const second = run(undefined, { GIT_OPTIONAL_LOCKS: '1' });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readFileSync(index), original);
  assert.deepEqual(second.summary.source, first.summary.source);
});

test('unavailable provenance is explicit rather than inferred from another checkout', t => {
  const result = workspace(t)();
  assert.deepEqual(result.summary.source, { head: null, dirty: null });
  assert.equal(result.summary.runtime.node, process.version);
});

test('verification preserves a terminated stage as a signal-based failure', t => {
  const result = workspace(t)('signal:check');
  assert.equal(result.status, 143);
  assert.deepEqual(result.calls, ['check']);
  assert.deepEqual(result.summary.stages.map(stage => stage.status), ['failed', 'not-run', 'not-run']);
  assert.equal(result.summary.stages[0].exitCode, 143);
});

test('verification reports an unavailable package manager as a failed stage, not a success', t => {
  const result = workspace(t, { available: false })();
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
