'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const script = path.resolve(__dirname, '../benchmark-resources.mjs');

test('resource benchmark help documents the reproducible comparison command without starting a browser', () => {
  const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.match(output, /--baseline/);
  assert.match(output, /--candidate/);
  assert.match(output, /--output/);
});

test('resource benchmark preserves an existing evidence file rather than replacing it', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'createratio-resource-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'manifest.json'), '{}');
  const output = path.join(directory, 'previous.json');
  writeFileSync(output, 'previous evidence');
  const result = spawnSync(process.execPath, [script, '--baseline', directory, '--candidate', directory, '--output', output], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(readFileSync(output, 'utf8'), 'previous evidence');
});
