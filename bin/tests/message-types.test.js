const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { typeCheck } = require('./type-probe.js');

const root = path.resolve(__dirname, '../..');

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

test('validator membership checks reject a field checked against another table', t => {
  const source = fs.readFileSync(path.join(root, 'extension', 'src', 'background', 'message-contracts.js'), 'utf8');
  const mismatched = source.replace('member(HISTORY_RANGES, message.range)', 'member(HISTORY_RANGES, message.kind)');
  assert.notEqual(mismatched, source);
  const result = typeCheck(t, { 'message-contracts.js': mismatched });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /message-contracts\.js\(\d+,\d+\): error TS2345: Argument of type 'HistoryKind' is not assignable to parameter of type 'HistoryRange'/);
});

test('scroll friction saves keep their typed runtime message', t => {
  const source = fs.readFileSync(path.join(root, 'extension', 'src', 'pages', 'settings', 'settings.js'), 'utf8');
  const mismatched = source.replace("{ type: 'scroll-friction-setting', ...scrollSaving }", "{ type: 'scroll-friction-settings', ...scrollSaving }");
  assert.notEqual(mismatched, source);
  const result = typeCheck(t, { 'settings.js': mismatched });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /settings\.js\(\d+,\d+\): error TS2820: Type '"scroll-friction-settings"' is not assignable/);
});
