const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function typeCheck(t, sources) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-message-types-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = Object.entries(sources).map(([name, source]) => {
    fs.writeFileSync(path.join(directory, name), source);
    return name;
  });
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
    extends: path.join(root, 'tsconfig.json'),
    files: ['globals.d.ts', 'messages.d.ts'].map(name => path.join(root, 'extension', 'types', name)).concat(files),
    include: []
  }));
  return spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: directory, encoding: 'utf8' });
}

test('runtime message types accept documented senders and validator tables', t => {
  const result = typeCheck(t, {
    'valid.js': [
      '/** @type {RuntimeMessage[]} */',
      "const sent = [{ type: 'access-duration', preference: 'waitMinutes', minutes: 5 }, { type: 'history', kind: 'websites', range: 'today' }];",
      '/** @type {Record<AccessPreference, true>} */',
      'const preferences = { accessMinutes: true, waitMinutes: true };',
      ''
    ].join('\n')
  });
  assert.equal(result.status, 0, result.stdout);
});

test('runtime message types reject undocumented senders and incomplete validator tables', t => {
  const result = typeCheck(t, {
    'sender.js': [
      '/** @type {RuntimeMessage} */',
      "const sent = { type: 'access-duration', preference: 'waitSeconds', minutes: 5 };",
      ''
    ].join('\n'),
    'validator.js': [
      '/** @type {Record<AccessPreference, true>} */',
      'const preferences = { accessMinutes: true };',
      '/** @type {Record<PreferenceMessage["type"], true>} */',
      "const rules = { tracking: true, 'access-duration': true, 'access-goal-setting': true, 'access-history-setting': true, 'scroll-friction-setting': true, 'website-time-setting': true, 'website-time': true };",
      ''
    ].join('\n'),
    'replies.js': [
      "/** @typedef {ReplyTable<Omit<RuntimeReplies, 'history'>>} MissingReply */",
      ''
    ].join('\n')
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /sender\.js\(2,\d+\): error TS2322: Type '"waitSeconds"' is not assignable to type 'AccessPreference/);
  assert.match(result.stdout, /validator\.js\(2,7\): error TS2741: Property 'waitMinutes' is missing/);
  assert.match(result.stdout, /validator\.js\(4,\d+\): error TS2353: .*'website-time'/);
  assert.match(result.stdout, /replies\.js\(1,\d+\): error TS2344: .*\n.*Property 'history' is missing/);
});
