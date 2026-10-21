const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../release-smoke.js');
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-smoke-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('release smoke refuses a non-repository before creating a test release', t => {
  const cwd = directory(t);
  const result = spawnSync(process.execPath, [script], { cwd, env: { ...process.env, CR_RELEASE_SMOKE: '' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git checkout/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('release smoke refuses uncommitted candidates without discarding their changes', t => {
  const cwd = directory(t);
  assert.equal(spawnSync('git', ['init'], { cwd }).status, 0);
  fs.writeFileSync(path.join(cwd, 'candidate.txt'), 'preserve');
  const result = spawnSync(process.execPath, [script], { cwd, env: { ...process.env, CR_RELEASE_SMOKE: '' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /clean working tree/);
  assert.equal(fs.readFileSync(path.join(cwd, 'candidate.txt'), 'utf8'), 'preserve');
});

test('CI runs the full release check outside the fast gate to avoid recursive verification', () => {
  const root = path.resolve(__dirname, '../..');
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts;
  assert.equal(scripts['check:release'], 'node bin/release-smoke.js');
  assert.doesNotMatch(scripts.check, /check:release/);
  assert.match(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'), /run: pnpm check:release/);
});

test('release smoke blocks recursion before running any nested check', t => {
  const cwd = directory(t);
  const result = spawnSync(process.execPath, [script], { cwd, env: { ...process.env, CR_RELEASE_SMOKE: '1' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /recursively/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});
