const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '../check-syntax.js');

function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-syntax-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: directory });
  fs.writeFileSync(path.join(directory, '.gitignore'), 'dist/\nnode_modules/\n');
  return directory;
}

function check(directory) {
  return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
}

test('syntax checks tracked and untracked JavaScript without executing it', t => {
  const directory = repository(t);
  fs.writeFileSync(path.join(directory, 'tracked.js'), "throw new Error('must not execute');\n");
  execFileSync('git', ['add', 'tracked.js'], { cwd: directory });
  fs.writeFileSync(path.join(directory, 'space in name.js'), 'const value = 1;\n');
  for (const name of ['dist', 'node_modules']) {
    fs.mkdirSync(path.join(directory, name));
    fs.writeFileSync(path.join(directory, name, 'ignored.js'), 'const =;');
  }
  const result = check(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 JavaScript syntax checks passed/);
});

for (const tracked of [false, true]) {
  test(`syntax failure in ${tracked ? 'tracked' : 'untracked'} input is a failed check`, t => {
    const directory = repository(t);
    fs.writeFileSync(path.join(directory, 'bad.js'), 'const =;\n');
    if (tracked) execFileSync('git', ['add', 'bad.js'], { cwd: directory });
    const result = check(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bad\.js/);
    assert.match(result.stderr, /SyntaxError/);
    assert.doesNotMatch(result.stdout, /checks passed/);
  });
}

for (const tracked of [false, true]) {
  test(`comments in ${tracked ? 'tracked' : 'untracked'} input fail the command`, t => {
    const directory = repository(t);
    fs.writeFileSync(path.join(directory, 'comment.js'), 'const value = 1;\n/* not allowed */\n');
    if (tracked) execFileSync('git', ['add', 'comment.js'], { cwd: directory });
    const result = check(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /comment\.js:2:1/);
    assert.match(result.stderr, /Code comments are not allowed/);
    assert.doesNotMatch(result.stdout, /checks passed/);
  });
}

for (const name of ['module.mjs', 'module.cjs', '.hidden/invalid.js']) {
  test(`syntax inventory includes ${name}`, t => {
    const directory = repository(t);
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'const =;\n');
    const result = check(directory);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(name));
    assert.match(result.stderr, /SyntaxError/);
  });
}

test('syntax checks resolve files from the repository root when invoked in a subdirectory', t => {
  const directory = repository(t);
  fs.mkdirSync(path.join(directory, 'nested'));
  fs.writeFileSync(path.join(directory, 'root.js'), 'const =;');
  const result = check(path.join(directory, 'nested'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root\.js/);
});
