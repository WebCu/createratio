const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../deployment-guard.js');
const latest = 'a'.repeat(40);
const stale = 'b'.repeat(40);

function guard(t, { tested = latest, response = `${latest}\trefs/heads/main\n`, status = 0, gitAvailable = true, outputAvailable = true, token = '', requireAuth = false, remoteStderr = '' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-deployment-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (gitAvailable) {
    fs.writeFileSync(path.join(directory, 'git'), `#!/bin/sh
[ "$*" = "ls-remote --exit-code origin refs/heads/main" ] || exit 90
[ "$GIT_TERMINAL_PROMPT" = "0" ] || exit 91
if [ "$REQUIRE_AUTH" = "true" ]; then
  [ "$GIT_CONFIG_COUNT" = "1" ] || exit 92
  [ "$GIT_CONFIG_KEY_0" = "http.https://github.com/.extraheader" ] || exit 93
  [ "$GIT_CONFIG_VALUE_0" = "$EXPECTED_AUTH_HEADER" ] || exit 94
  [ -z "$GITHUB_TOKEN" ] || exit 95
fi
printf "%s" "$REMOTE_STDERR" >&2
printf "%s" "$REMOTE_RESPONSE"
exit "$REMOTE_STATUS"
`, { mode: 0o755 });
  }
  const output = path.join(directory, 'output');
  const result = spawnSync(process.execPath, [script], {
    cwd: directory,
    env: {
      ...process.env, PATH: directory, TESTED_SHA: tested,
      GITHUB_OUTPUT: outputAvailable ? output : '',
      GITHUB_TOKEN: token, GITHUB_SERVER_URL: 'https://github.com',
      REQUIRE_AUTH: String(requireAuth),
      EXPECTED_AUTH_HEADER: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      REMOTE_RESPONSE: response, REMOTE_STATUS: String(status), REMOTE_STDERR: remoteStderr
    },
    encoding: 'utf8', timeout: 5000
  });
  assert.ifError(result.error);
  return { ...result, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '' };
}

test('guard permits only the tested SHA matching the remote main tip', t => {
  const current = guard(t);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.output, 'publish=true\n');
  const older = guard(t, { tested: stale });
  assert.equal(older.status, 0, older.stderr);
  assert.equal(older.output, 'publish=false\n');
});

test('private freshness lookup uses transient host-scoped auth without token-bearing argv or logs', t => {
  const token = 'fake-read-only-job-token';
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  for (const status of [0, 128]) {
    const result = guard(t, { token, requireAuth: true, status, remoteStderr: `${token} ${encoded}\n` });
    if (status === 0) assert.equal(result.status, 0, result.stderr);
    else assert.notEqual(result.status, 0);
    assert.equal(result.output, status === 0 ? 'publish=true\n' : '');
    const logged = result.stdout + result.stderr + result.output;
    assert.equal(logged.includes(token), false);
    assert.equal(logged.includes(encoded), false);
  }
});

test('guard fails closed when Git is unavailable or its remote lookup fails', t => {
  for (const options of [{ gitAvailable: false }, { status: 2, response: '' }, { status: 128 }]) {
    const result = guard(t, options);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
    assert.match(result.stderr, /Cannot determine latest main; refusing deployment/);
  }
});

test('guard fails closed for missing, malformed, ambiguous, or wrong-ref responses', t => {
  for (const response of [
    '', 'not-a-sha\trefs/heads/main\n', `${latest}\trefs/heads/feature\n`,
    `${latest}\trefs/heads/main\n${stale}\trefs/heads/main\n`
  ]) {
    const result = guard(t, { response });
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
    assert.match(result.stderr, /Invalid latest main response; refusing deployment/);
  }
});

test('guard requires the tested full SHA and a GitHub step output destination', t => {
  for (const options of [{ tested: '' }, { tested: latest.slice(0, 7) }, { tested: 'main' }, { outputAvailable: false }]) {
    const result = guard(t, options);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
  }
});
