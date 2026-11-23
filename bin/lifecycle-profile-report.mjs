import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = value => Number.isFinite(value) && value >= 0;
const order = ['baseline:1', 'candidate:1', 'candidate:2', 'baseline:2', 'baseline:3', 'candidate:3'];

function memory(value) {
  assert.ok(['present', 'exited', 'unknown'].includes(value.processState));
  assert.ok(['available', 'unavailable'].includes(value.counters));
  if (value.counters === 'available') {
    assert.equal(value.processState, 'present');
    for (const key of ['pssBytes', 'privateBytes', 'rssBytes']) assert.ok(finite(value[key]), 'Invalid process memory');
  } else {
    assert.ok(typeof value.reason === 'string' && value.reason.length > 0, 'Unavailable counters need a reason');
    for (const key of ['pssBytes', 'privateBytes', 'rssBytes'])
      assert.equal(value[key], null, 'Unavailable is not zero');
  }
}

export function validateLifecycleProfile(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, 'complete', 'Incomplete or failed lifecycle report');
  assert.ok(['settings', 'trackers'].includes(report.workload));
  assert.ok(hash(report.provenance.workloadSha256));
  for (const label of ['baseline', 'candidate']) {
    const bundle = report.provenance[label];
    assert.ok(hash(bundle.sha256) && Array.isArray(bundle.files) && bundle.files.length > 0);
    assert.equal(createHash('sha256').update(JSON.stringify(bundle.files)).digest('hex'), bundle.sha256);
    assert.equal(new Set(bundle.files.map(file => file.path)).size, bundle.files.length);
    assert.ok(bundle.files.some(file => file.path === 'manifest.json'));
    for (const file of bundle.files)
      assert.ok(
        typeof file.path === 'string' && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && hash(file.sha256)
      );
  }
  for (const key of ['node', 'platform', 'architecture', 'osRelease'])
    assert.ok(typeof report.environment[key] === 'string' && report.environment[key].length > 0);
  assert.ok(
    Number.isFinite(Date.parse(report.startedAt)) && Date.parse(report.completedAt) >= Date.parse(report.startedAt)
  );
  assert.deepEqual(
    report.runs.map(run => `${run.variant}:${run.repetition}`),
    order,
    'Three alternating runs per build required'
  );
  assert.equal(new Set(report.runs.map(run => run.browser)).size, 1, 'Mixed browser versions');
  for (const run of report.runs) {
    assert.equal(run.workload, report.workload);
    assert.equal(run.bundleSha256, report.provenance[run.variant].sha256);
    assert.match(run.browser, /^[A-Za-z ]+\/\d+(?:\.\d+){1,3}$/);
    assert.equal(run.cycles, report.workload === 'settings' ? 12 : 3);
    assert.equal(run.tabCount, report.workload === 'settings' ? 4 : 8);
    if (report.workload === 'settings') {
      assert.deepEqual(
        run.checkpoints.map(({ cycle, phase }) => [cycle, phase]),
        [
          [0, 'initial'],
          [6, 'before-navigation'],
          [6, 'after-navigation'],
          [12, 'before-navigation'],
          [12, 'after-navigation']
        ]
      );
    } else
      assert.deepEqual(
        run.checkpoints.map(point => point.cycle),
        [0, 1, 2, 3]
      );
    memory(run.workerMemory);
    assert.equal(run.attribution.pages.length, run.tabCount);
    for (const target of [run.attribution.worker, ...run.attribution.pages])
      assert.ok(Number.isSafeInteger(target.pid) && target.pid > 0 && typeof target.isolate === 'string');
    assert.equal(
      run.attribution.workerSharesPageProcess,
      run.attribution.pages.some(page => page.pid === run.attribution.worker.pid)
    );
    assert.equal(
      run.attribution.workerSharesPageIsolate,
      run.attribution.pages.some(page => page.isolate === run.attribution.worker.isolate)
    );
    for (const point of run.checkpoints) {
      assert.equal(point.samples.length, run.tabCount);
      for (const [index, sample] of point.samples.entries()) {
        assert.ok(typeof sample.isolate === 'string' && finite(sample.heapBytes));
        for (const key of ['nodes', 'documents', 'jsEventListeners', 'connectedElements'])
          assert.ok(Number.isSafeInteger(sample[key]) && sample[key] >= 0);
        if (report.workload === 'settings') {
          for (const key of ['ownedNodes', 'detachedOwnedNodes'])
            assert.ok(Number.isSafeInteger(sample[key]) && sample[key] >= 0);
          assert.ok(
            sample.connectedElements <= run.checkpoints[0].samples[index].connectedElements,
            'Settings DOM accumulation'
          );
          assert.ok(
            sample.detachedOwnedNodes <= run.checkpoints[0].samples[index].detachedOwnedNodes,
            'Settings detached DOM accumulation'
          );
          assert.ok(sample.documents <= run.checkpoints[0].samples[index].documents, 'Settings document accumulation');
          assert.ok(
            sample.jsEventListeners <= run.checkpoints[0].samples[index].jsEventListeners,
            'Settings listener accumulation'
          );
        }
      }
    }
    assert.ok(run.wholeBrowser.processes.length > 0);
    run.wholeBrowser.processes.forEach(memory);
    const available = run.wholeBrowser.processes.every(process => process.counters === 'available');
    assert.equal(
      run.wholeBrowser.rssBytes,
      available ? run.wholeBrowser.processes.reduce((sum, process) => sum + process.rssBytes, 0) : null
    );
    if (report.workload === 'settings') {
      assert.equal(run.closedTargets, run.tabCount - 1);
      assert.equal(run.teardown.samples.length, 1);
    } else {
      assert.equal(run.idleMs, 42000);
      assert.equal(run.expectIdle, run.variant === 'candidate' || report.baselineIdle);
      assert.ok(run.idle.observations.length >= 2);
      assert.equal(run.idle.observations[0].elapsedMs >= 0, true);
      for (const [index, observation] of run.idle.observations.entries()) {
        assert.equal(observation.attached, false);
        assert.ok(
          finite(observation.elapsedMs) &&
            (!index || observation.elapsedMs >= run.idle.observations[index - 1].elapsedMs)
        );
      }
      assert.ok(run.idle.observations.at(-1).elapsedMs >= run.idleMs);
      assert.equal(
        run.idle.absent,
        run.idle.observations.some(point => point.targetId === null)
      );
      assert.equal(run.idle.absent, run.expectIdle);
      assert.equal(
        run.idle.settled,
        run.idle.observations.slice(-5).every(point => point.targetId === null)
      );
      if (run.expectIdle) {
        assert.equal(run.idle.settled, true);
        assert.equal(run.idle.recovered, true);
      }
      assert.equal(run.idle.sameDocument, true);
      assert.deepEqual(run.idle.preferences, { trackedSites: ['x'], strength: 75 });
      memory(run.idle.idleMemory);
    }
  }
  return report;
}

export function renderLifecycleProfile(report) {
  validateLifecycleProfile(report);
  const lines = [
    `# ${report.workload === 'settings' ? 'Settings controls' : 'Tracker/worker'} lifecycle comparison`,
    '',
    `Baseline bundle SHA-256: \`${report.provenance.baseline.sha256}\``,
    `Candidate bundle SHA-256: \`${report.provenance.candidate.sha256}\``,
    `Workload SHA-256: \`${report.provenance.workloadSha256}\``,
    '',
    `Environment: ${report.environment.node}, ${report.environment.platform}/${report.environment.architecture}, OS ${report.environment.osRelease}, ${report.runs[0].browser}.`,
    `Observed: ${report.startedAt} to ${report.completedAt}. Three alternating fresh profiles per build; ${report.runs[0].tabCount} tabs, ${report.runs[0].cycles} cycles.`,
    'Values are median [minimum–maximum]. Unavailable counters remain unavailable; available subsets are not substituted for missing runs.',
    '',
    '| Measurement | Baseline | Candidate |',
    '| --- | ---: | ---: |'
  ];
  const metrics = [
    ['Worker-containing process PSS (bytes)', run => run.workerMemory.pssBytes],
    ['Worker-containing process private memory (bytes)', run => run.workerMemory.privateBytes],
    ['CDP-listed whole-browser RSS (bytes)', run => run.wholeBrowser.rssBytes],
    ...report.runs[0].checkpoints.flatMap(point => [
      [
        `Page 1 post-GC isolate heap, cycle ${point.cycle} ${point.phase || ''} (bytes)`,
        run =>
          run.checkpoints.find(sample => sample.cycle === point.cycle && sample.phase === point.phase).samples[0]
            .heapBytes
      ],
      [
        `Page 1 connected DOM elements, cycle ${point.cycle} ${point.phase || ''}`,
        run =>
          run.checkpoints.find(sample => sample.cycle === point.cycle && sample.phase === point.phase).samples[0]
            .connectedElements
      ],
      [
        `Page 1 renderer DOM nodes, cycle ${point.cycle} ${point.phase || ''}`,
        run =>
          run.checkpoints.find(sample => sample.cycle === point.cycle && sample.phase === point.phase).samples[0].nodes
      ],
      [
        `Page 1 renderer listeners, cycle ${point.cycle} ${point.phase || ''}`,
        run =>
          run.checkpoints.find(sample => sample.cycle === point.cycle && sample.phase === point.phase).samples[0]
            .jsEventListeners
      ]
    ])
  ];
  if (report.workload === 'trackers')
    metrics.push([
      'First observed worker absence (ms)',
      run => run.idle.observations.find(point => point.targetId === null)?.elapsedMs ?? null
    ]);
  for (const [label, measure] of metrics) {
    const values = variant => {
      const samples = report.runs.filter(run => run.variant === variant).map(measure);
      if (samples.some(value => value === null)) return 'Unavailable';
      samples.sort((a, b) => a - b);
      return `${samples[1].toFixed(3)} [${samples[0].toFixed(3)}–${samples[2].toFixed(3)}]`;
    };
    lines.push(`| ${label} | ${values('baseline')} | ${values('candidate')} |`);
  }
  const shared = report.runs.some(run => run.attribution.workerSharesPageProcess);
  lines.push(
    '',
    `Worker shares a measured page process in any run: **${shared ? 'yes' : 'no'}**. Process memory is not worker-isolate-only memory.`,
    'Page samples identify V8 isolates: co-resident targets may share one; do not sum target heap or DOM counts. Full per-target samples and process/counter availability reasons are in JSON.',
    'Settings connected DOM elements and retained detached current-realm Node wrappers guard control accumulation. Total wrapper counts vary with V8 wrapper caching; renderer node totals also include browser/native state. Both totals remain informational; document/listener counts guard cross-navigation accumulation.',
    'Tracing, debugger attachment and forced GC perturb the workload. Idle target inventory is observed with every debugger detached; process exit and unavailable counters are separate states.',
    'Synthetic Chromium evidence only. No optimization, accepted budget, store delivery, Firefox/Edge, physical input or sleep/wake claim is established. Maintainer resource acceptance remains separate.',
    ''
  );
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(renderLifecycleProfile(JSON.parse(await readFile(process.argv[2], 'utf8'))));
