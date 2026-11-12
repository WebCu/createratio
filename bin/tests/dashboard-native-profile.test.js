'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function procFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'native-proc-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = async (pid, parent, startTicks = '100', memory = 10) => {
    const directory = path.join(root, String(pid));
    await mkdir(directory, { recursive: true });
    const fields = ['S', String(parent), ...Array(17).fill('0'), startTicks];
    await writeFile(path.join(directory, 'stat'), `${pid} (process with ) spaces) ${fields.join(' ')}`);
    await writeFile(path.join(directory, 'smaps_rollup'), `Rss: ${memory * 2} kB\nPss: ${memory} kB\nPrivate_Clean: 2 kB\nPrivate_Dirty: 3 kB\n`);
    return { pid, parent, startTicks, live: true };
  };
  return { root, entry };
}

test('native memory samples only the owned browser tree, including grandchildren and native-inclusive PSS', async t => {
  const { sampleOwnedMemory } = await import('../native-process-memory.mjs');
  const { root, entry } = await procFixture(t);
  const owner = await entry(100, 50);
  await entry(90, 101, '101', 20);
  await entry(101, 100, '102', 30);
  await entry(999, 50, '103', 9000);
  await rm(path.join(root, '999', 'smaps_rollup'));
  await entry(102, 100);
  const zombie = path.join(root, '102', 'stat');
  await writeFile(zombie, (await readFile(zombie, 'utf8')).replace(') S ', ') Z '));
  await rm(path.join(root, '102', 'smaps_rollup'));
  const result = await sampleOwnedMemory(owner, root);
  assert.deepEqual(result.processes.map(process => process.pid), [90, 100, 101]);
  assert.equal(result.pssBytes, 60 * 1024);
  assert.equal(result.rssBytes, 120 * 1024);
  assert.equal(result.privateBytes, 15 * 1024);
  assert.ok(result.elapsedMs >= 0);
});

test('browser ownership requires the fresh profile and ancestry to this profiler, not just CDP PIDs', async t => {
  const { ownedBrowserRoot } = await import('../native-process-memory.mjs');
  const { root, entry } = await procFixture(t);
  const expected = await entry(100, 75);
  await entry(75, 50);
  const browser = {
    directory: '/synthetic/unique',
    cdp: { send: async method => { assert.equal(method, 'SystemInfo.getProcessInfo'); return { processInfo: [{ type: 'browser', id: 100 }, { type: 'renderer', id: 101 }] }; } }
  };
  const cmdline = path.join(root, '100', 'cmdline');
  await writeFile(cmdline, 'chromium\0--user-data-dir=/synthetic/unique/profile\0');
  assert.deepEqual(await ownedBrowserRoot(browser, root, 50), expected);
  await assert.rejects(ownedBrowserRoot(browser, root, 76), /ENOENT/);
  await writeFile(cmdline, 'chromium\0--user-data-dir=/another/profile\0');
  await assert.rejects(ownedBrowserRoot(browser, root, 50), /ownership mismatch/);
});

test('native sampler refuses exit, PID reuse, unreadable PSS and process-tree churn instead of undercounting', async t => {
  const { sampleOwnedMemory } = await import('../native-process-memory.mjs');
  const { root, entry } = await procFixture(t);
  const owner = await entry(100, 50);
  await entry(101, 100);
  await entry(100, 50, '999');
  await assert.rejects(sampleOwnedMemory(owner, root), /identity changed/);
  await entry(100, 50);
  const memory = path.join(root, '101', 'smaps_rollup');
  await writeFile(memory, 'Rss: 10 kB\n');
  await assert.rejects(sampleOwnedMemory(owner, root), /Missing Pss/);
  await rm(memory);
  await assert.rejects(sampleOwnedMemory(owner, root), /ENOENT/);
  await entry(101, 100);
  const files = {
    readdir,
    readFile: async (file, encoding) => {
      const value = await readFile(file, encoding);
      if (file === memory) await entry(101, 100, '200');
      return value;
    }
  };
  await assert.rejects(sampleOwnedMemory(owner, root, files), /identity changed during sampling/);
  await entry(101, 100);
  let scans = 0;
  await assert.rejects(sampleOwnedMemory(owner, root, {
    readFile, readdir: async directory => {
      if (++scans === 2) await entry(102, 100);
      return readdir(directory);
    }
  }), /tree changed/);
});

test('comparison runs alternate builds, require the matching completed pilot and keep medians distinct from ranges', async () => {
  const { runPlan, requirePilot, medianRange, summarize } = await import('../dashboard-native-profile.mjs');
  const { workload, syntheticHistory, checkpointPlan } = await import('../dashboard-native-workload.mjs');
  assert.deepEqual(runPlan('comparison').map(run => `${run.variant}:${run.repetition}`), ['baseline:1', 'candidate:1', 'candidate:2', 'baseline:2', 'baseline:3', 'candidate:3']);
  const provenance = { baseline: { sha256: 'synthetic baseline' }, candidate: { sha256: 'synthetic candidate' }, workloadSha256: 'synthetic workload' };
  const environment = { node: 'synthetic runtime' };
  const pilotRuns = runPlan('pilot').map(run => ({
    ...run, bundleSha256: provenance[run.variant].sha256, browserVersion: { product: 'synthetic browser', revision: 'synthetic revision' },
    checkpoints: checkpointPlan('pilot').map(point => ({ ...point, activeIsolateHeapBytes: 100, processMemory: { pssBytes: 1000 } })),
    generations: [{ cycle: 2, changed: true }]
  }));
  const pilot = { schemaVersion: 1, mode: 'pilot', status: 'complete', provenance, environment, workload, runs: pilotRuns };
  assert.doesNotThrow(() => requirePilot(pilot, provenance, environment));
  for (const mutate of [
    value => { value.status = 'failed'; },
    value => { value.provenance.baseline = 'changed'; },
    value => { value.environment.node = 'changed'; },
    value => { value.workload.pilot.tabs++; },
    value => { value.runs.pop(); },
    value => { value.runs[0].checkpoints.pop(); },
    value => { value.runs[0].checkpoints[0].processMemory.pssBytes = null; },
    value => { value.runs[0].generations = []; },
    value => { value.runs[0].browserVersion.product = 'different'; }
  ]) {
    const changed = structuredClone(pilot); mutate(changed);
    assert.throws(() => requirePilot(changed, provenance, environment));
  }
  assert.deepEqual(medianRange([99, 1, 4]), { median: 4, minimum: 1, maximum: 99 });
  assert.throws(() => medianRange([1, NaN, 3]));
  assert.throws(() => medianRange([1, 3]));
  const runs = runPlan('comparison').map(run => ({ ...run, checkpoints: checkpointPlan('comparison').map(point => ({ ...point, activeIsolateHeapBytes: run.repetition * 10, processMemory: { pssBytes: run.repetition * 1000, privateBytes: run.repetition * 100 } })) }));
  const summary = summarize(runs);
  assert.deepEqual(summary[0].baseline.processPssBytes, { median: 2000, minimum: 1000, maximum: 3000 });
  assert.deepEqual(summary[0].candidate.activeIsolateHeapBytes, { median: 20, minimum: 10, maximum: 30 });
  assert.throws(() => summarize(runs.slice(1)), /three alternating/);
  const mixed = structuredClone(runs); mixed[1].checkpoints[0].phase = 'navigated';
  assert.throws(() => summarize(mixed), /Mixed checkpoints/);
  assert.notDeepEqual(syntheticHistory(1), syntheticHistory(2));
  assert.throws(() => syntheticHistory(0));
});

test('profile refuses raw output in checkouts or input bundles before launching a browser', async t => {
  const { profile } = await import('../dashboard-native-profile.mjs');
  const { root } = await procFixture(t);
  if (process.platform !== 'linux') {
    await assert.rejects(profile(root, root, path.join(root, '..report.json')), /require Linux/);
    return;
  }
  await assert.rejects(profile(root, root, path.join(root, '..report.json')), /must not modify an input bundle/);
  await writeFile(path.join(root, '.git'), 'gitdir: /synthetic/worktree');
  await assert.rejects(profile(root, root, path.join(root, 'report.json')), /outside a Git checkout/);
  assert.deepEqual((await readdir(root)).sort(), ['.git']);
});

test('native profile CLI fails closed on missing arguments without launching Chromium', () => {
  const command = path.resolve(__dirname, '../dashboard-native-profile.mjs');
  const result = spawnSync(process.execPath, [command], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: node bin\/dashboard-native-profile/);
});
