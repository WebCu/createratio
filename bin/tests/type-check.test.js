const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function typeCheck(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-check-types-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'fixture.js'), source);
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: ['fixture.js'], exclude: [] }));
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: directory, encoding: 'utf8' });
  return { ...result, files: fs.readdirSync(directory).sort() };
}

test('check:types reports JavaScript type errors with the root configuration and emits nothing', t => {
  const result = typeCheck(t, "let count = 1;\ncount.toUpperCase();\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /fixture\.js\(2,7\): error TS2339: Property 'toUpperCase' does not exist on type 'number'/);
  assert.deepEqual(result.files, ['fixture.js', 'tsconfig.json']);
});

test('check:types accepts valid JavaScript with the root configuration and emits nothing', t => {
  const result = typeCheck(t, "const name = 'createratio';\nname.toUpperCase();\n");
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.files, ['fixture.js', 'tsconfig.json']);
});
