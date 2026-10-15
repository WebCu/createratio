'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'bin/dev.sh');

function run(t, args = [], overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'createratio-dev-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  writeFileSync(path.join(dir, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'info') process.exit(Number(process.env.DAEMON_STATUS || 0));
if (args[0] === 'network') process.exit(Number(process.env.NETWORK_STATUS || 0));
if (args[0] === 'ps' && process.env.PROXY_RUNNING !== '0') console.log('test-proxy');
if (args[0] === 'compose') process.exit(Number(process.env.COMPOSE_STATUS || 0));
`, { mode: 0o755 });
  const result = spawnSync('bash', [script, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log,
      DAEMON_STATUS: '0', NETWORK_STATUS: '0', PROXY_RUNNING: '1', COMPOSE_STATUS: '0', ...overrides }
  });
  let calls = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...result, calls };
}

test('default uses the proxy overlay, no implicit .env, and runs from the repo root', t => {
  const result = run(t, ['-d', '--force-recreate']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(call => call.args), [
    ['info'], ['network', 'inspect', 'devproxy'],
    ['ps', '-q', '-f', 'label=com.docker.compose.service=traefik'],
    ['compose', '--env-file', '/dev/null', '-f', 'docker-compose.yml', '-f',
      'docker-compose.dev-proxy.yml', 'up', '-d', '--force-recreate']
  ]);
  assert.ok(result.calls.every(call => call.cwd === root));
});

test('no-proxy bypasses shared infrastructure and preserves argument boundaries', t => {
  const result = run(t, ['--no-proxy', '--timeout', '10', 'web'], { NETWORK_STATUS: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(call => call.args), [
    ['info'], ['compose', '--env-file', '/dev/null', '-f', 'docker-compose.yml',
      'up', '--timeout', '10', 'web']
  ]);
});

test('no arguments works, including with older Bash empty-array semantics', t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.at(-1).args.at(-1), 'up');
});

test('help needs no Docker and shows both URLs', t => {
  const result = run(t, ['--help'], { DAEMON_STATUS: '1' });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.match(result.stdout, /http:\/\/createratio\.localhost/);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:4173/);
});

test('unreachable daemon fails before probing the shared network', t => {
  const result = run(t, [], { DAEMON_STATUS: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Docker daemon/);
  assert.deepEqual(result.calls.map(call => call.args), [['info']]);
});

test('missing shared network fails with a useful fallback', t => {
  const result = run(t, [], { NETWORK_STATUS: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docker network create devproxy/);
  assert.match(result.stderr, /--no-proxy/);
  assert.equal(result.calls.length, 2);
});

test('missing proxy warns without blocking a differently named proxy', t => {
  const result = run(t, [], { PROXY_RUNNING: '0' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /warning:.*traefik/);
  assert.equal(result.calls.at(-1).args[0], 'compose');
});

test('Compose failures propagate to the caller', t => {
  assert.equal(run(t, [], { COMPOSE_STATUS: '7' }).status, 7);
});
