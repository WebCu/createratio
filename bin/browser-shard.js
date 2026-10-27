'use strict';
const { spawnSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const { constants } = require('node:os');
const path = require('node:path');

try {
  const shards = JSON.parse(readFileSync(path.join(__dirname, 'browser-shards.json'), 'utf8'));
  if (!Array.isArray(shards) || !shards.length || shards.some(files => !Array.isArray(files) || !files.length)) {
    throw new Error('Browser plan must contain nonempty shards.');
  }
  const [selection, ...extra] = process.argv.slice(2);
  if (!/^[1-9]\d*$/.test(selection) || Number(selection) > shards.length || extra.length) {
    throw new Error(`Usage: node bin/browser-shard.js <1-${shards.length}>`);
  }
  const directory = path.resolve(__dirname, '../extension/browser-tests');
  const inventory = new Set(readdirSync(directory).filter(file => file.endsWith('.test.js')));
  const assigned = new Set();
  for (const file of shards.flat()) {
    if (typeof file !== 'string' || path.basename(file) !== file || !file.endsWith('.test.js')) throw new Error(`Invalid browser test: ${file}`);
    if (assigned.has(file)) throw new Error(`Duplicate browser test: ${file}`);
    if (!inventory.has(file)) throw new Error(`Missing browser test: ${file}`);
    assigned.add(file);
  }
  const unassigned = [...inventory].filter(file => !assigned.has(file));
  if (unassigned.length) throw new Error(`Unassigned browser tests: ${unassigned.join(', ')}`);
  const files = shards[Number(selection) - 1].map(file => path.join(directory, file));
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
