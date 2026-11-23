'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdir, mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const stat = (start = '123', state = 'S') =>
  `42 (renderer (worker)) ${[state, '1', ...Array(17).fill('0'), start].join(' ')}`;
const counters = 'Rss: 80 kB\nPss: 40 kB\nPrivate_Clean: 8 kB\nPrivate_Dirty: 12 kB\n';
const missing = code => Object.assign(new Error(code), { code });

test('blocked return synchronization waits for a new response and the refresh render to finish', async () => {
  const { blockedReturnReady } = await import('../lifecycle-workloads.mjs');
  const context = vm.createContext({ blockedProfile: { sends: 0, completed: 0 }, refreshing: false });
  const browser = {
    cdp: {
      async send(method, { expression }, session) {
        assert.equal(method, 'Runtime.evaluate');
        assert.equal(session, 'gate');
        return { result: { value: vm.runInContext(expression, context) } };
      }
    }
  };
  assert.equal(await blockedReturnReady(browser, 'gate', 0), false);
  context.blockedProfile.sends++;
  context.refreshing = true;
  assert.equal(
    await blockedReturnReady(browser, 'gate', 0),
    false,
    'sending with the old blocked DOM is not synchronization'
  );
  context.blockedProfile.completed++;
  assert.equal(await blockedReturnReady(browser, 'gate', 0), false, 'a received reply must still render');
  context.refreshing = false;
  assert.equal(await blockedReturnReady(browser, 'gate', 0), true);
  assert.equal(
    await blockedReturnReady(browser, 'gate', 1),
    false,
    'an earlier completed refresh is not a new response'
  );
  context.blockedProfile.sends++;
  assert.equal(
    await blockedReturnReady(browser, 'gate', 1),
    false,
    'a failed request without a response does not synchronize'
  );
});

test('worker process accounting distinguishes unavailable counters, exit and PID reuse', async () => {
  const { processMemory } = await import('../lifecycle-resources.mjs');
  const read = async file => (file.endsWith('/stat') ? stat() : counters);
  const sample = await processMemory(42, { platform: 'linux', read });
  assert.equal(sample.pssBytes, 40 * 1024);
  assert.equal(sample.privateBytes, 20 * 1024);
  assert.equal(sample.rssBytes, 80 * 1024);
  assert.equal(sample.processState, 'present');
  for (const platform of ['darwin', 'win32']) {
    const unavailable = await processMemory(42, {
      platform,
      read: async () => assert.fail('unsupported platform must not read /proc')
    });
    assert.equal(unavailable.counters, 'unavailable');
    assert.equal(unavailable.pssBytes, null);
    assert.equal(unavailable.processState, 'unknown');
  }
  for (const code of ['ENOENT', 'ESRCH', 'EACCES']) {
    const unavailable = await processMemory(42, {
      platform: 'linux',
      exists: () => false,
      read: async () => {
        throw missing(code);
      }
    });
    assert.equal(unavailable.processState, code === 'EACCES' ? 'unknown' : 'exited');
    assert.equal(unavailable.pssBytes, null);
  }
  for (const exists of [() => true, () => null]) {
    const unavailable = await processMemory(42, {
      platform: 'linux',
      exists,
      read: async () => {
        throw missing('ENOENT');
      }
    });
    assert.equal(unavailable.processState, 'unknown', 'missing identity is not a confirmed process exit');
    assert.equal(unavailable.pssBytes, null);
  }
  for (const failure of [
    async () => {
      throw missing('EACCES');
    },
    async () => {
      throw missing('ENOENT');
    },
    async () => 'Rss: 80 kB\n'
  ]) {
    const unavailable = await processMemory(42, {
      platform: 'linux',
      read: async file => (file.endsWith('/stat') ? stat() : failure())
    });
    assert.equal(unavailable.processState, 'present', 'missing counters do not establish process exit');
    assert.equal(unavailable.counters, 'unavailable');
    assert.equal(unavailable.pssBytes, null);
  }
  const reused = await processMemory(42, { platform: 'linux', read, expectedStartTicks: '100' });
  assert.equal(reused.processState, 'unknown');
  assert.equal(reused.pssBytes, null);
  let reads = 0;
  const changed = await processMemory(42, {
    platform: 'linux',
    read: async file => (file.endsWith('/stat') ? stat(String(++reads)) : counters)
  });
  assert.equal(changed.counters, 'unavailable');
  assert.equal(changed.pssBytes, null);
  let exists = true;
  const exited = await processMemory(42, {
    platform: 'linux',
    exists: () => exists,
    read: async file => {
      if (!exists) throw missing('ENOENT');
      if (file.endsWith('/stat')) return stat();
      exists = false;
      throw missing('ENOENT');
    }
  });
  assert.equal(exited.processState, 'exited');
  assert.equal(exited.pssBytes, null);
});

test('attribution requires one PID per unique mark but permits explicitly shared processes', async () => {
  const { markedProcesses } = await import('../lifecycle-resources.mjs');
  const events = [
    { name: 'worker', pid: 42 },
    { name: 'page', pid: 42 },
    { name: 'page', pid: 42 },
    { name: 'unrelated', pid: 99 }
  ];
  assert.deepEqual(markedProcesses(events, ['worker', 'page']), [42, 42]);
  assert.throws(() => markedProcesses(events, ['missing']), /one process/);
  assert.throws(() => markedProcesses([...events, { name: 'worker', pid: 43 }], ['worker']), /one process/);
});

test('retained control regression is rejected without inventing a heap budget', async () => {
  const { assertStableControls } = await import('../lifecycle-resources.mjs');
  const point = (cycle, nodes, jsEventListeners) => ({
    cycle,
    samples: [{ connectedElements: nodes, detachedOwnedNodes: 0, documents: 1, jsEventListeners }]
  });
  assertStableControls([point(0, 100, 20), point(6, 99, 20)]);
  assert.throws(() => assertStableControls([point(0, 100, 20), point(6, 101, 20)]), /nodes accumulated/);
  assert.throws(() => assertStableControls([point(0, 100, 20), point(6, 100, 21)]), /listeners accumulated/);
});

test('Settings CLI refuses invalid arguments and existing evidence before launching a browser', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'createratio-lifecycle-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['settings-lifecycle-profile.mjs', 'tracker-lifecycle-profile.mjs']) {
    const script = path.resolve(__dirname, '..', name);
    const invalid = spawnSync(process.execPath, [script, 'a', 'b', 'c', '--unknown'], {
      encoding: 'utf8',
      timeout: 10000
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage:/);
  }
  const output = path.join(root, 'report.json');
  await writeFile(output, 'previous evidence');
  const { profileLifecycle } = await import('../lifecycle-profile.mjs');
  const fixture = path.join(root, 'bundle');
  await mkdir(fixture);
  await writeFile(path.join(fixture, 'manifest.json'), '{}');
  await assert.rejects(profileLifecycle(fixture, fixture, output, { workload: 'settings' }), { code: 'EEXIST' });
  assert.equal(await readFile(output, 'utf8'), 'previous evidence');
  const failedOutput = path.join(root, 'failed.json');
  await assert.rejects(profileLifecycle(fixture, fixture, failedOutput, { workload: 'settings' }));
  const failed = JSON.parse(await readFile(failedOutput, 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.runs, []);
  assert.ok(failed.error.length > 0);
  const { renderLifecycleProfile } = await import('../lifecycle-profile-report.mjs');
  assert.throws(() => renderLifecycleProfile(failed), /Incomplete or failed/);
});
