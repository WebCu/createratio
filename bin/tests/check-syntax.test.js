'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { checkSyntax } = require('../check-syntax.js');

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'createratio-syntax-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('syntax checks nested JavaScript modules without executing them', t => {
  const directory = fixture(t);
  mkdirSync(path.join(directory, 'nested'));
  writeFileSync(path.join(directory, 'a.js'), "throw new Error('Must not execute');");
  writeFileSync(path.join(directory, 'nested', 'b.js'), 'const answer = 42;');
  writeFileSync(path.join(directory, 'nested', 'c.mjs'), 'export const answer = 42;');
  writeFileSync(path.join(directory, 'nested', 'd.cjs'), 'module.exports = 42;');
  const files = ['a.js', 'nested/b.js', 'nested/c.mjs', 'nested/d.cjs'].map(file => path.join(directory, file));
  assert.equal(checkSyntax(files), 4);
});

test('syntax checks reject invalid JavaScript and identify its file', t => {
  const directory = fixture(t);
  const file = path.join(directory, 'invalid.js');
  writeFileSync(file, 'const = ;');
  assert.throws(() => checkSyntax([file]), error => error.message.includes(file) && error.message.includes('SyntaxError'));
});

test('syntax checks fail when a requested file is missing', t => {
  const file = path.join(fixture(t), 'missing.js');
  assert.throws(() => checkSyntax([file]), error => error.message.includes(file));
});

for (const [name, source, location] of [
  ['line.js', '// private fixture text\nconst value = 1;', '1:1'],
  ['inline.cjs', 'const x = 1; // private fixture text', '1:14'],
  ['block.mjs', 'export const x = 1;\r\n/* private fixture text */', '2:1'],
  ['documentation.js', '/** private fixture text */\nconst value = 1;', '1:1'],
  ['template.js', 'const x = `${1 /* private fixture text */}`;', '1:16'],
  ['module.js', '// private fixture text\nexport const value = 1;', '1:1'],
  ['legacy.js', '<!-- private fixture text\nconst value = 1;', '1:1'],
  ['hashbang.js', '#!/usr/bin/env node\n// private fixture text', '2:1']
]) {
  test(`comment check rejects ${name} with a location, without echoing its contents`, t => {
    const file = path.join(fixture(t), name);
    writeFileSync(file, source);
    assert.throws(() => checkSyntax([file]), error => {
      assert.match(error.message, /Code comments are not allowed/);
      assert.ok(error.message.includes(`${file}:${location}`), error.message);
      assert.doesNotMatch(error.message, /private fixture text/);
      return true;
    });
  });
}

for (const type of ['module', 'commonjs']) {
  test(`comment parsing respects the package's ${type} scope for ambiguous slashes`, t => {
    const directory = fixture(t);
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type }));
    const file = path.join(directory, 'scoped.js');
    writeFileSync(file, 'await / a // b;');
    if (type === 'module') assert.equal(checkSyntax([file]), 1);
    else assert.throws(() => checkSyntax([file]), /scoped\.js:1:11/);
  });
}

test('comment-like text in literals and division are not comments', t => {
  const file = path.join(fixture(t), 'literals.js');
  writeFileSync(file, [
    'const url = "https://example.test/";',
    'const block = "/* text */";',
    'const html = "<!-- text -->";',
    'const template = `// text ${"/* text */"}`;',
    String.raw`const expression = /https?:\/\/example\.test/;`,
    'const ratio = { value: 4 }.value / 2;',
    'throw new Error("Must not execute");'
  ].join('\n'));
  assert.equal(checkSyntax([file]), 1);
});

for (const [name, source] of [
  ['executable.cjs', '#!/usr/bin/env node\nmodule.exports = 1;'],
  ['commonjs.cjs', 'module.exports = new.target; return;'],
  ['module.mjs', 'export const value = await Promise.resolve(1);'],
  ['module.js', 'import fs from "node:fs"; export const value = fs;']
]) {
  test(`comment checking accepts ${name} without executing it`, t => {
    const file = path.join(fixture(t), name);
    writeFileSync(file, source);
    assert.equal(checkSyntax([file]), 1);
  });
}
