const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../extension/build.js');
const { compare, matrix } = require('../access-equivalence.js');

async function bundles(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'createratio-equivalence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const baseline = await build('chrome', path.join(directory, 'before'));
  const candidate = path.join(directory, 'after');
  await fs.cp(baseline, candidate, { recursive: true });
  return { baseline, candidate };
}

test('equivalence compares all lifecycle states and metadata-derived URLs', async t => {
  const { baseline, candidate } = await bundles(t);
  const result = await compare(baseline, candidate);
  assert.equal(result.states, 19);
  assert.equal(result.restarts, 3);
  assert.ok(result.urls > 20);
  assert.equal(result.cases, (result.states + result.restarts) * result.urls);
  assert.match(result.verification, /not live-browser QA/);
});

test('equivalence detects changed lifecycle behavior', async t => {
  const { baseline, candidate } = await bundles(t);
  const blocker = path.join(candidate, 'blocker.js');
  const source = await fs.readFile(blocker, 'utf8');
  const changed = source.replace(/waitSeconds,(\s*)sessionMinutes:/, 'waitSeconds: waitSeconds + 1,$1sessionMinutes:');
  assert.notEqual(changed, source);
  await fs.writeFile(blocker, changed);
  await assert.rejects(compare(baseline, candidate), /lifecycle/);
});

async function mutate(candidate, from, to) {
  for (const file of ['blocker.js', 'site-access.js']) {
    const target = path.join(candidate, file);
    const source = await fs.readFile(target, 'utf8').catch(() => '');
    if (!source.includes(from)) continue;
    await fs.writeFile(target, source.replace(from, to));
    return;
  }
  assert.fail(`No candidate file contains ${from}`);
}

test('equivalence detects changed restart behavior', async t => {
  const { baseline, candidate } = await bundles(t);
  await mutate(candidate, 'const pausedAtMidnight = !restart &&', 'const pausedAtMidnight =');
  await assert.rejects(compare(baseline, candidate), /restart/);
});

test('equivalence detects static blocking policy changes', async t => {
  const { baseline, candidate } = await bundles(t);
  const file = path.join(candidate, 'block-rules.json');
  const rules = JSON.parse(await fs.readFile(file, 'utf8'));
  rules[0].priority++;
  await fs.writeFile(file, JSON.stringify(rules));
  await assert.rejects(compare(baseline, candidate), /block-rules.json/);
});

test('generated fixture states never alias entries across integrations', () => {
  const access = { domains: ['example.invalid'], home: 'https://example.invalid/' };
  const { states, urls } = matrix([
    { id: 'first', access },
    { id: 'second', access: { domains: ['second.invalid'], home: 'https://second.invalid/' } }
  ]);
  assert.notEqual(states.running._access.first, states.running._access.second);
  assert.deepEqual(states.defaults, {});
  assert.deepEqual(states.blocked.settings.trackedSites, ['first', 'second']);
  assert.deepEqual(states.paused.settings.trackedSites, ['first', 'second']);
  assert.ok(urls.includes('http://mobile.second.invalid/'));
  assert.ok(urls.includes('https://second.invalid.evil.invalid/'));
  assert.throws(() => matrix([]), /no access integrations/);
});

test('matrix covers exhausted, legacy, stale-wait, above-goal session, and midnight-running states', () => {
  const { states, restarts } = matrix([
    { id: 'first', access: { domains: ['first.test'], home: 'https://first.test/' } },
    { id: 'second', access: { domains: ['second.test'], home: 'https://second.test/' } }
  ]);
  for (const name of [
    'exhausted',
    'exhaustedYesterday',
    'legacyDeadline',
    'runningAtMidnight',
    'aboveGoalSession',
    'exhaustedAboveGoal',
    'staleWait',
    'waitAboveGoal'
  ])
    assert.ok(states[name], name);
  assert.deepEqual(restarts, ['running', 'midnight', 'runningAtMidnight']);
});

test('equivalence detects a changed refill time', async t => {
  const { baseline, candidate } = await bundles(t);
  await mutate(candidate, 'refilledAt = dayStart;', 'refilledAt = dayStart + 1;');
  await assert.rejects(compare(baseline, candidate), /lifecycle/);
});

test('equivalence detects a stored budget dropped while a session runs', async t => {
  const { baseline, candidate } = await bundles(t);
  await mutate(
    candidate,
    'remainingMs: state.remainingMs,',
    'remainingMs: state.expiresAt ? null : state.remainingMs,'
  );
  await assert.rejects(compare(baseline, candidate), /lifecycle/);
});
