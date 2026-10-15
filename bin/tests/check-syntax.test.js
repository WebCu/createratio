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
