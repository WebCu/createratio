'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

function fixture(workload = 'settings') {
  const digest = 'a'.repeat(64), files = [{ path: 'manifest.json', bytes: 2, sha256: digest }];
  const bundle = { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
  const unavailable = { processState: 'unknown', counters: 'unavailable', reason: 'unsupported', pssBytes: null, privateBytes: null, rssBytes: null };
  const tabCount = workload === 'settings' ? 4 : 8;
  const sample = index => ({ targetId: 'page-' + index, isolate: 'shared-isolate', heapBytes: 100, nodes: 20, documents: 1, jsEventListeners: 5, ownedNodes: 10, detachedOwnedNodes: 0, connectedElements: 15 });
  return {
    schemaVersion: 1, status: 'complete', workload, baselineIdle: true,
    startedAt: '2026-11-12T12:00:00Z', completedAt: '2026-11-12T13:00:00Z',
    provenance: { baseline: bundle, candidate: structuredClone(bundle), workloadSha256: digest },
    environment: { node: 'v24.20.0', platform: 'darwin', architecture: 'arm64', osRelease: '25.1.0' },
    runs: [['baseline', 1], ['candidate', 1], ['candidate', 2], ['baseline', 2], ['baseline', 3], ['candidate', 3]].map(([variant, repetition]) => ({
      variant, repetition, workload, tabCount, cycles: workload === 'settings' ? 12 : 3, bundleSha256: bundle.sha256, browser: 'Chrome/156.0.8078.4',
      checkpoints: (workload === 'settings' ? [[0, 'initial'], [6, 'before-navigation'], [6, 'after-navigation'], [12, 'before-navigation'], [12, 'after-navigation']] : [0, 1, 2, 3].map(cycle => [cycle])).map(([cycle, phase]) => ({ cycle, ...(phase ? { phase } : {}), samples: Array.from({ length: tabCount }, (_, index) => sample(index)) })),
      attribution: { worker: { pid: 42, isolate: 'worker-isolate' }, pages: Array.from({ length: tabCount }, (_, index) => ({ targetId: 'page-' + index, pid: 43, isolate: 'shared-isolate' })), workerSharesPageProcess: false, workerSharesPageIsolate: false },
      workerMemory: structuredClone(unavailable), wholeBrowser: { rssBytes: null, processes: [structuredClone(unavailable)] },
      closedTargets: tabCount - 1, teardown: { samples: [sample(0)] },
      idleMs: 42000, expectIdle: true,
      idle: { absent: true, settled: true, recovered: true, sameDocument: true, preferences: { trackedSites: ['x'], strength: 75 }, idleMemory: structuredClone(unavailable), observations: [{ elapsedMs: 0, targetId: 'worker', attached: false }, ...[38000, 39000, 40000, 41000, 42000].map(elapsedMs => ({ elapsedMs, targetId: null, attached: false }))] }
    }))
  };
}

test('lifecycle reports require complete aligned repetitions and retain unavailable/shared-memory limitations', async () => {
  const { renderLifecycleProfile, validateLifecycleProfile } = await import('../lifecycle-profile-report.mjs');
  for (const workload of ['settings', 'trackers']) {
    const report = fixture(workload); validateLifecycleProfile(report);
    const rendered = renderLifecycleProfile(report);
    assert.match(rendered, /Unavailable/); assert.match(rendered, /do not sum/); assert.match(rendered, /acceptance remains separate/);
    for (const mutate of [
      value => { value.status = 'running'; },
      value => { value.runs.pop(); },
      value => { value.runs.reverse(); },
      value => { value.runs[1].browser = 'Chrome/155.0.0.0'; },
      value => { value.runs[1].bundleSha256 = 'b'.repeat(64); },
      value => { value.runs[0].workerMemory.pssBytes = 0; },
      value => { value.runs[0].checkpoints[1].samples[0].heapBytes = NaN; },
      value => { value.runs[0].attribution.workerSharesPageProcess = true; },
      value => { value.provenance.baseline.files[0].bytes++; }
    ]) {
      const invalid = structuredClone(report); mutate(invalid);
      assert.throws(() => renderLifecycleProfile(invalid));
    }
  }
});

test('Settings report rejects node/listener accumulation and missing teardown', async () => {
  const { validateLifecycleProfile } = await import('../lifecycle-profile-report.mjs');
  for (const mutate of [
    report => { report.runs[0].checkpoints.splice(1, 1); },
    report => { report.runs[0].checkpoints[1].phase = 'after-navigation'; },
    report => { report.runs[0].checkpoints = []; },
    report => { report.runs[0].checkpoints[1].samples[0].connectedElements++; },
    report => { report.runs[0].checkpoints[1].samples[0].jsEventListeners++; },
    report => { report.runs[0].checkpoints[1].samples[0].documents++; },
    report => { report.runs[0].checkpoints[1].samples[0].detachedOwnedNodes++; },
    report => { report.runs[0].closedTargets = 0; },
    report => { report.runs[0].teardown.samples = []; }
  ]) { const report = fixture(); mutate(report); assert.throws(() => validateLifecycleProfile(report)); }
});

test('tracker report refuses attached-debugger, short-window, missing-recovery and stale-preference evidence', async () => {
  const { validateLifecycleProfile } = await import('../lifecycle-profile-report.mjs');
  for (const mutate of [
    report => { report.runs[0].idle.observations[0].attached = true; },
    report => { report.runs[0].idle.observations.at(-1).elapsedMs = 41000; },
    report => { report.runs[0].idle.recovered = false; },
    report => { report.runs[0].idle.preferences.strength = 50; },
    report => { report.runs[0].idle.sameDocument = false; },
    report => { report.runs[0].idle.idleMemory.privateBytes = 0; }
  ]) { const report = fixture('trackers'); mutate(report); assert.throws(() => validateLifecycleProfile(report)); }
});
