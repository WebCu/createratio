'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, writeFile, mkdir, symlink, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(layout = 'document') {
  const files = [{ path: 'manifest.json', bytes: 2, sha256: hash('{}') }];
  const bundle = { sha256: hash(JSON.stringify(files)), files };
  const report = { schemaVersion: 1, status: 'complete', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z', provenance: { baseline: bundle, candidate: bundle, workloadSha256: hash('workload') }, environment: { node: 'v24.22.0', platform: 'linux', architecture: 'arm64' }, layout, tabCount: 8, cycles: 30, lifecycleWheelEvents: 61, wheelEvents: 100, idleMs: 6000, runs: [] };
  for (const [variant, repetition] of [['baseline', 1], ['candidate', 1], ['candidate', 2], ['baseline', 2], ['baseline', 3], ['candidate', 3]]) {
    const heap = variant === 'baseline' ? 100 : 200;
    report.runs.push({ variant, repetition, layout, bundleSha256: bundle.sha256, browser: 'Chrome/155.0.8059.79', wheelDistance: 40, injectedBytes: 20, controlHeap: { heapBytes: 50 }, checkpoints: [0, 10, 30].map(cycle => ({ cycle, heapBytes: heap + repetition + cycle, nodes: 11, wheelListeners: [{ passive: true }, { passive: false }] })), inactiveListeners: [{ passive: true }], idleRequests: 0, workload: { elapsedMs: 1000 + repetition, scriptMs: 10 + repetition, taskMs: 20 + repetition, layoutMs: repetition } });
  }
  return structuredClone(report);
}

test('profile reports calculate medians/ranges and include fingerprints', async () => {
  const { renderProfiles } = await import('../scroll-profile-report.mjs');
  const markdown = renderProfiles([fixture(), fixture('body')]);
  assert.match(markdown, /Retained isolate heap, cycle 30 \(bytes\) \| 132\.000 \[131\.000–133\.000\] \| 232\.000 \[231\.000–233\.000\]/);
  assert.match(markdown, /Heap growth, cycles 10–30 \(bytes\) \| 20\.000 \[20\.000–20\.000\]/);
  assert.ok(markdown.includes(fixture().provenance.baseline.sha256));
  assert.match(markdown, /## body/);
});

test('profile reports reject incomplete, mixed and invalid evidence', async () => {
  const { renderProfiles } = await import('../scroll-profile-report.mjs');
  const mutations = [
    report => { report.status = 'running'; },
    report => { report.status = 'failed'; },
    report => { report.runs.pop(); },
    report => { report.runs[1] = report.runs[0]; },
    report => { report.runs[0].layout = 'body'; },
    report => { report.runs[0].bundleSha256 = hash('other bundle'); },
    report => { report.provenance.baseline.files[0].bytes++; },
    report => { report.runs[0].browser = 'Chrome/154.0.0.0'; },
    report => { report.runs[0].workload.taskMs = NaN; },
    report => { report.runs[0].checkpoints[2].nodes++; },
    report => { report.runs[0].checkpoints[1].wheelListeners.push({ passive: false }); },
    report => { report.runs[0].idleRequests = 1; },
    report => { report.runs[0].inactiveListeners.push({ passive: false }); },
    report => { report.completedAt = '2025-01-01'; },
    report => { report.wheelEvents++; }
  ];
  for (const mutate of mutations) {
    const report = fixture();
    mutate(report);
    assert.throws(() => renderProfiles([report]), undefined, mutate.toString());
  }
  assert.throws(() => renderProfiles([fixture(), fixture()]), /Duplicate layout/);
  for (const mutate of [report => { report.provenance.workloadSha256 = hash('different workload'); }, report => { report.environment.node = 'v24.21.0'; }]) {
    const other = fixture('body'); mutate(other);
    assert.throws(() => renderProfiles([fixture(), other]), /Mixed/);
  }
});

test('profile reports reject changing scroll behavior across repetitions', async () => {
  const { renderProfiles } = await import('../scroll-profile-report.mjs');
  for (const variant of ['baseline', 'candidate']) {
    const report = fixture();
    report.runs.find(run => run.variant === variant && run.repetition === 2).wheelDistance = 80;
    assert.throws(() => renderProfiles([report]), /Inconsistent wheel distance/);
  }
});

test('identical bundles cannot report different scroll behavior under different labels', async () => {
  const { renderProfiles } = await import('../scroll-profile-report.mjs');
  const report = fixture();
  for (const run of report.runs) if (run.variant === 'candidate') run.wheelDistance = 80;
  assert.throws(() => renderProfiles([report]), /Inconsistent wheel distance/);
});

test('distinct bundles and layouts can intentionally produce different stable scroll distances', async () => {
  const { renderProfiles } = await import('../scroll-profile-report.mjs');
  const document = fixture();
  const files = [{ path: 'manifest.json', bytes: 3, sha256: hash('{}\n') }];
  document.provenance.baseline = { files, sha256: hash(JSON.stringify(files)) };
  for (const run of document.runs) if (run.variant === 'baseline') run.bundleSha256 = document.provenance.baseline.sha256;
  const body = structuredClone(document);
  body.layout = 'body';
  for (const run of body.runs) {
    run.layout = 'body';
    if (run.variant === 'baseline') run.wheelDistance = 80;
  }
  assert.match(renderProfiles([document, body]), /## body/);
});

test('bundle fingerprints cover all files and paths, ignoring only filesystem timestamps', async t => {
  const { bundleFingerprint } = await import('../scroll-profile-report.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'scroll-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'manifest.json'), '{}');
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts/content.js'), '123');
  const first = await bundleFingerprint(directory);
  assert.deepEqual(await bundleFingerprint(directory), first);
  await writeFile(path.join(directory, 'scripts/content.js'), '456');
  assert.notEqual((await bundleFingerprint(directory)).sha256, first.sha256);
  await symlink(path.join(directory, 'manifest.json'), path.join(directory, 'linked.json'));
  await assert.rejects(bundleFingerprint(directory), /regular files/);
});

test('report CLI renders complete JSON and exits nonzero without evidence', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scroll-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'report.json');
  await writeFile(report, JSON.stringify(fixture()));
  const command = path.resolve(__dirname, '../scroll-profile-report.mjs');
  const result = spawnSync(process.execPath, [command, report], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Scroll resource comparison/);
  assert.notEqual(spawnSync(process.execPath, [command], { encoding: 'utf8' }).status, 0);
});
