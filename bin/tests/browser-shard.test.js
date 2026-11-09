'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'createratio-browser-shard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'bin'));
  mkdirSync(path.join(root, 'extension/browser-tests'), { recursive: true });
  copyFileSync(path.resolve(__dirname, '../browser-shard.js'), path.join(root, 'bin/browser-shard.js'));
  const shards = Array.from({ length: 8 }, (_, index) => [`case-${index + 1}.test.js`]);
  const save = () => writeFileSync(path.join(root, 'bin/browser-shards.json'), JSON.stringify(shards));
  save();
  for (let index = 1; index <= shards.length; index++) {
    writeFileSync(path.join(root, `extension/browser-tests/case-${index}.test.js`), `require('node:test').test('journey ${index}', () => console.log('visited-${index}'));`);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/browser-shard.js'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  return { root, shards, save, run };
}

test('each browser shard runs only its assigned real test files', t => {
  const { run, shards } = fixture(t);
  for (let index = 1; index <= shards.length; index++) {
    const result = run(String(index));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`visited-${index}`));
    for (let other = 1; other <= shards.length; other++) {
      if (other !== index) assert.doesNotMatch(result.stdout, new RegExp(`visited-${other}`));
    }
  }
});

test('a failing browser journey makes its shard fail', t => {
  const { root, run } = fixture(t);
  writeFileSync(path.join(root, 'extension/browser-tests/case-1.test.js'), "require('node:test').test('broken journey', () => { throw new Error('browser regression'); });");
  const result = run('1');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /browser regression/);
});

for (const args of [[], ['0'], ['9'], ['1.0'], ['1', '2']]) {
  test(`browser shards refuse invalid selection ${JSON.stringify(args)}`, t => {
    const result = fixture(t).run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stdout, /visited-/);
  });
}

test('a newly added unassigned browser test fails before any journeys run', t => {
  const { root, run } = fixture(t);
  writeFileSync(path.join(root, 'extension/browser-tests/new.test.js'), "throw new Error('must be assigned');");
  const result = run('1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unassigned.*new\.test\.js/i);
  assert.doesNotMatch(result.stdout, /visited-/);
});

test('duplicate assignments fail even when the selected shard is unaffected', t => {
  const { shards, save, run } = fixture(t);
  shards[5].push('case-2.test.js');
  save();
  const result = run('1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate.*case-2\.test\.js/i);
  assert.doesNotMatch(result.stdout, /visited-/);
});

test('missing or unsafe browser test paths cannot run', t => {
  const { shards, save, run } = fixture(t);
  for (const file of ['removed.test.js', '../outside.test.js']) {
    shards[0] = [file];
    save();
    const result = run('1');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing|invalid/i);
    assert.doesNotMatch(result.stdout, /visited-/);
  }
});

test('the browser matrix cannot contain empty or omitted shards', t => {
  const { shards, save, run } = fixture(t);
  const last = shards.pop();
  shards.push([]);
  save();
  assert.equal(run('1').status, 1);
  shards[shards.length - 1] = last;
  shards.pop();
  save();
  const result = run('1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unassigned.*case-8\.test\.js/i);
});

test('the committed browser plan is a complete disjoint partition', () => {
  const shards = JSON.parse(readFileSync(path.resolve(__dirname, '../browser-shards.json'), 'utf8'));
  assert.equal(shards.length, 8);
  const { readdirSync } = require('node:fs');
  const files = readdirSync(path.resolve(__dirname, '../../extension/browser-tests')).filter(file => file.endsWith('.test.js')).sort();
  assert.deepEqual(shards.flat().sort(), files);
});
