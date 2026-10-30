'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '../update-lifecycle-profile.mjs');
for (const extra of [['--unknown'], ['--baseline-idle', '--baseline-idle']]) test(`profile refuses invalid flags ${extra.join(' ')}`, () => {
  const result = spawnSync(process.execPath, [script, '/missing/baseline', '/missing/candidate', '/missing/report.json', ...extra], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/);
});

test('already-idle mode still validates actual bundle inputs before launching a browser', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'createratio-profile-input-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = path.join(root, 'baseline'), candidate = path.join(root, 'candidate');
  mkdirSync(baseline); mkdirSync(candidate);
  const result = spawnSync(process.execPath, [script, baseline, candidate, path.join(root, 'report.json'), '--baseline-idle'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /manifest\.json/); assert.doesNotMatch(result.stderr, /Usage:/);
});
