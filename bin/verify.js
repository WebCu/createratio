'use strict';
const { spawnSync } = require('node:child_process');
const { mkdtempSync, openSync, closeSync, writeFileSync, writeSync, fstatSync, readSync } = require('node:fs');
const { tmpdir, constants } = require('node:os');
const path = require('node:path');

function commandValue(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

function runVerification() {
  const status = commandValue('git', ['status', '--porcelain']);
  const source = { head: commandValue('git', ['rev-parse', '--verify', 'HEAD']), dirty: status === null ? null : Boolean(status) };
  const runtime = { node: process.version, pnpm: commandValue('pnpm', ['--version']) };
  const directory = mkdtempSync(path.join(tmpdir(), 'createratio-verify-'));
  const stages = ['check', 'check:browser', 'smoke:browser'].map(name => ({ name, status: 'not-run', log: name.replaceAll(':', '-') + '.log' }));
  const save = () => writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ source, runtime, stages }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Verification logs: ${directory}`);
  save();
  let exitCode = 0;
  for (const stage of stages) {
    if (exitCode) {
      console.log(`NOT RUN ${stage.name}`);
      continue;
    }
    const descriptor = openSync(path.join(directory, stage.log), 'wx+', 0o600);
    try {
      stage.status = 'running'; save();
      console.log(`RUN ${stage.name}`);
      const result = spawnSync('pnpm', [stage.name], { stdio: ['ignore', descriptor, descriptor] });
      exitCode = result.status ?? (result.signal ? 128 + (constants.signals[result.signal] || 0) : 1);
      if (result.error) writeSync(descriptor, result.error.message + '\n');
      stage.exitCode = exitCode;
      stage.status = exitCode ? 'failed' : 'passed'; save();
      console.log(`${exitCode ? 'FAIL' : 'PASS'} ${stage.name}`);
      if (exitCode) {
        const size = fstatSync(descriptor).size;
        const tail = Buffer.alloc(Math.min(size, 8192));
        readSync(descriptor, tail, 0, tail.length, size - tail.length);
        console.error(tail.toString('utf8').split('\n').slice(-40).join('\n'));
      }
    } finally { closeSync(descriptor); }
  }
  return exitCode;
}

if (require.main === module) process.exitCode = runVerification();
module.exports = { runVerification };
