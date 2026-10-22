import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function bundleFingerprint(root) {
  assert.ok((await lstat(root)).isDirectory(), 'Bundle must be a real directory');
  const files = [];
  async function visit(relative) {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const entry = await lstat(join(root, path));
      if (entry.isDirectory()) await visit(path);
      else {
        assert.ok(entry.isFile(), `Bundle entries must be regular files: ${path}`);
        const content = await readFile(join(root, path));
        files.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      }
    }
  }
  await visit('');
  assert.ok(files.some(file => file.path === 'manifest.json'), 'Bundle manifest is missing');
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = value => Number.isFinite(value) && value >= 0;
const metrics = [
  ['Injected source (bytes)', run => run.injectedBytes],
  ['Control isolate heap (bytes)', run => run.controlHeap.heapBytes],
  ['Retained isolate heap, cycle 30 (bytes)', run => run.checkpoints[2].heapBytes],
  ['Heap growth, cycles 10–30 (bytes)', run => run.checkpoints[2].heapBytes - run.checkpoints[1].heapBytes],
  ...[0, 1, 2].flatMap(index => [
    [`DOM nodes, cycle ${[0, 10, 30][index]}`, run => run.checkpoints[index].nodes],
    [`Wheel listeners, cycle ${[0, 10, 30][index]}`, run => run.checkpoints[index].wheelListeners.length]
  ]),
  ['Script time / 100 inputs (ms)', run => run.workload.scriptMs],
  ['Task time / 100 inputs (ms)', run => run.workload.taskMs],
  ['Layout time / 100 inputs (ms)', run => run.workload.layoutMs],
  ['CDP elapsed / 100 inputs (ms)', run => run.workload.elapsedMs]
];

export function validateProfile(report) {
  assert.equal(report.schemaVersion, 1, 'Unsupported profile schema');
  assert.equal(report.status, 'complete', 'Profile is incomplete or failed');
  assert.ok(['document', 'app-shell', 'body'].includes(report.layout), 'Unknown layout');
  for (const [key, value] of Object.entries({ tabCount: 8, cycles: 30, lifecycleWheelEvents: 61, wheelEvents: 100, idleMs: 6000 })) {
    assert.equal(report[key], value, `Unexpected workload ${key}`);
  }
  assert.ok(Number.isFinite(Date.parse(report.startedAt)) && Date.parse(report.completedAt) >= Date.parse(report.startedAt), 'Invalid observation timestamps');
  assert.ok(hash(report.provenance.workloadSha256), 'Missing workload fingerprint');
  for (const variant of ['baseline', 'candidate']) {
    const bundle = report.provenance[variant];
    assert.ok(hash(bundle.sha256) && Array.isArray(bundle.files) && bundle.files.length, 'Missing bundle fingerprint');
    assert.equal(createHash('sha256').update(JSON.stringify(bundle.files)).digest('hex'), bundle.sha256, 'Bundle inventory does not match its fingerprint');
    assert.equal(new Set(bundle.files.map(file => file.path)).size, bundle.files.length, 'Duplicate bundle paths');
    assert.ok(bundle.files.some(file => file.path === 'manifest.json'), 'Missing manifest in bundle inventory');
    for (const file of bundle.files) assert.ok(typeof file.path === 'string' && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && hash(file.sha256), 'Invalid bundle inventory');
  }
  assert.deepEqual(report.runs.map(run => `${run.variant}:${run.repetition}`), ['baseline:1', 'candidate:1', 'candidate:2', 'baseline:2', 'baseline:3', 'candidate:3'], 'Expected three alternating runs per build');
  for (const run of report.runs) {
    assert.equal(run.layout, report.layout, 'Mixed layouts within a profile');
    assert.equal(run.bundleSha256, report.provenance[run.variant].sha256, 'Run uses a different bundle');
    assert.ok(typeof run.browser === 'string' && /^[A-Za-z ]+\/\d+(?:\.\d+){1,3}$/.test(run.browser), 'Missing browser version');
    assert.ok([40, 80].includes(run.wheelDistance), 'Unexpected wheel distance');
    assert.deepEqual(run.checkpoints.map(point => point.cycle), [0, 10, 30], 'Missing lifecycle checkpoint');
    assert.ok(finite(run.injectedBytes) && finite(run.controlHeap.heapBytes), 'Invalid byte measurements');
    for (const point of run.checkpoints) {
      assert.ok(finite(point.heapBytes) && Number.isSafeInteger(point.nodes) && point.nodes >= 0 && Array.isArray(point.wheelListeners), 'Invalid checkpoint');
      assert.equal(point.nodes, run.checkpoints[0].nodes, 'DOM nodes accumulated');
      assert.equal(point.wheelListeners.length, run.checkpoints[0].wheelListeners.length, 'Wheel listeners accumulated');
    }
    for (const key of ['elapsedMs', 'scriptMs', 'taskMs', 'layoutMs']) assert.ok(finite(run.workload[key]), `Invalid ${key}`);
    assert.equal(run.idleRequests, 0, 'Hidden snapshot requests observed');
    assert.equal(run.inactiveListeners.filter(listener => !listener.passive).length, 0, 'Hidden non-passive listeners observed');
  }
  for (const key of ['node', 'platform', 'architecture']) assert.match(report.environment[key], /^[a-zA-Z0-9.-]+$/);
  assert.equal(new Set(report.runs.map(run => run.browser)).size, 1, 'Mixed browser versions');
  return report;
}

export function renderProfiles(reports) {
  assert.ok(reports.length > 0 && reports.length <= 3, 'Provide one to three layout reports');
  reports.forEach(validateProfile);
  assert.equal(new Set(reports.map(report => report.layout)).size, reports.length, 'Duplicate layout reports');
  const first = reports[0];
  for (const report of reports) {
    assert.deepEqual(report.provenance, first.provenance, 'Mixed bundle or workload fingerprints');
    assert.deepEqual(report.environment, first.environment, 'Mixed runtime environments');
    assert.equal(report.runs[0].browser, first.runs[0].browser, 'Mixed browser versions');
  }
  const lines = [
    '# Scroll resource comparison', '',
    `Baseline bundle SHA-256: \`${first.provenance.baseline.sha256}\``,
    `Candidate bundle SHA-256: \`${first.provenance.candidate.sha256}\``,
    `Workload SHA-256: \`${first.provenance.workloadSha256}\``, '',
    `Environment: ${first.environment.node}, ${first.environment.platform}/${first.environment.architecture}, ${first.runs[0].browser}.`,
    'Each layout: three alternating runs per build, eight tabs, 30 lifecycle cycles, 61 lifecycle wheel inputs, 100 timed inputs, six seconds hidden.',
    'Values are median [minimum–maximum].', ''
  ];
  for (const report of reports) {
    lines.push(`## ${report.layout}`, '', `Observed: ${new Date(report.startedAt).toISOString()} to ${new Date(report.completedAt).toISOString()}.`, '', '| Measurement | Baseline | Candidate |', '| --- | ---: | ---: |');
    for (const [name, measure] of metrics) {
      const values = variant => {
        const samples = report.runs.filter(run => run.variant === variant).map(measure).sort((a, b) => a - b);
        return `${samples[1].toFixed(3)} [${samples[0].toFixed(3)}–${samples[2].toFixed(3)}]`;
      };
      lines.push(`| ${name} | ${values('baseline')} | ${values('candidate')} |`);
    }
    lines.push('', 'All runs: stable DOM-node/wheel-listener counts; zero hidden snapshot requests and non-passive wheel listeners.', '');
  }
  lines.push('Synthetic Chromium evidence only. Isolate heap is not whole-browser RAM; CDP elapsed time is not physical input latency; hidden-message checks do not prove worker termination.', '', 'Resource acceptance requires maintainer review. This report does not grant acceptance or establish live-site/device/browser compatibility.', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const reports = await Promise.all(process.argv.slice(2).map(async file => JSON.parse(await readFile(file, 'utf8'))));
  console.log(renderProfiles(reports));
}
