'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const workflows = path.join(root, '.github/workflows');

test('.node-version selects the exact Node.js version every workflow pins', () => {
  const local = readFileSync(path.join(root, '.node-version'), 'utf8').trim();
  const pins = readdirSync(workflows).flatMap(name =>
    [...readFileSync(path.join(workflows, name), 'utf8').matchAll(/node-version: (\S+)/g)].map(match => [
      name,
      match[1]
    ])
  );
  assert.ok(pins.length > 0, 'no workflow pins a Node.js version');
  for (const [name, version] of pins) assert.equal(local, version, name);
});
