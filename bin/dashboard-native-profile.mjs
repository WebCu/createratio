import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
import { bundleFingerprint } from './scroll-profile-report.mjs';
import { launch, withFailureArtifacts } from '../extension/browser-tests/chromium.mjs';
import { ownedBrowserRoot } from './native-process-memory.mjs';
import { exerciseDashboard, workload, checkpointPlan } from './dashboard-native-workload.mjs';

export function runPlan(mode) {
  assert.ok(['pilot', 'comparison'].includes(mode), 'Unknown profile mode');
  return Array.from({ length: mode === 'pilot' ? 1 : 3 }, (_, index) =>
    (index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']).map(variant => ({ variant, repetition: index + 1 }))
  ).flat();
}

export function requirePilot(pilot, provenance, environment) {
  assert.equal(pilot.schemaVersion, 1, 'Unknown pilot schema');
  assert.equal(pilot.mode, 'pilot', 'Comparison requires a pilot');
  assert.equal(pilot.status, 'complete', 'Pilot is incomplete or failed');
  assert.deepEqual(pilot.provenance, provenance, 'Pilot inputs differ');
  assert.deepEqual(pilot.environment, environment, 'Pilot environment differs');
  assert.deepEqual(pilot.workload, workload, 'Pilot workload differs');
  assert.deepEqual(pilot.runs.map(({ variant, repetition }) => ({ variant, repetition })), runPlan('pilot'), 'Pilot runs are incomplete');
  for (const run of pilot.runs) {
    assert.equal(run.bundleSha256, provenance[run.variant].sha256, 'Pilot run bundle differs');
    assert.ok(run.browserVersion?.product && run.browserVersion?.revision, 'Pilot browser version missing');
    assert.deepEqual(run.checkpoints.map(({ phase, cycle }) => ({ phase, cycle })), checkpointPlan('pilot'), 'Pilot checkpoints incomplete');
    assert.deepEqual(run.generations, [{ cycle: 2, changed: true }], 'Pilot history reset incomplete');
    for (const point of run.checkpoints) {
      assert.ok(Number.isFinite(point.processMemory?.pssBytes) && point.processMemory.pssBytes > 0 && Number.isFinite(point.activeIsolateHeapBytes) && point.activeIsolateHeapBytes > 0, 'Pilot measurements missing');
    }
  }
  assert.deepEqual(pilot.runs[0].browserVersion, pilot.runs[1].browserVersion, 'Mixed pilot browsers');
}

export function medianRange(values) {
  assert.ok(values.length >= 3 && values.every(Number.isFinite), 'At least three finite measurements required');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, minimum: sorted[0], maximum: sorted.at(-1) };
}

export function summarize(runs) {
  assert.deepEqual(runs.map(({ variant, repetition }) => ({ variant, repetition })), runPlan('comparison'), 'Expected three alternating repetitions per build');
  const first = checkpointPlan('comparison');
  for (const run of runs) assert.deepEqual(run.checkpoints.map(({ phase, cycle }) => ({ phase, cycle })), first, 'Mixed checkpoints');
  return first.map((point, index) => ({ ...point, ...Object.fromEntries(['baseline', 'candidate'].map(variant => {
    const points = runs.filter(run => run.variant === variant).map(run => run.checkpoints[index]);
    return [variant, {
      processPssBytes: medianRange(points.map(point => point.processMemory.pssBytes)),
      processPrivateBytes: medianRange(points.map(point => point.processMemory.privateBytes)),
      activeIsolateHeapBytes: medianRange(points.map(point => point.activeIsolateHeapBytes))
    }];
  })) }));
}

async function workloadFingerprint() {
  const files = ['dashboard-native-profile.mjs', 'dashboard-native-workload.mjs', 'native-process-memory.mjs', 'scroll-profile-report.mjs', '../extension/browser-tests/chromium.mjs'];
  const sources = await Promise.all(files.map(async file => [file, await readFile(new URL(file, import.meta.url), 'utf8')]));
  return createHash('sha256').update(JSON.stringify({ workload, sources })).digest('hex');
}

async function outsideCheckout(output) {
  let directory = await realpath(dirname(resolve(output)));
  while (true) {
    try { await realpath(join(directory, '.git')); throw new Error('Raw output must be outside a Git checkout'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

export async function profile(baseline, candidate, output, pilotFile) {
  assert.equal(process.platform, 'linux', 'Native process measurements require Linux /proc');
  await outsideCheckout(output);
  output = join(await realpath(dirname(resolve(output))), basename(output));
  const bundles = { baseline: await realpath(baseline), candidate: await realpath(candidate) };
  for (const bundle of Object.values(bundles)) {
    const path = relative(bundle, output);
    assert.ok(path === '..' || path.startsWith('../'), 'Output must not modify an input bundle');
  }
  const provenance = { baseline: await bundleFingerprint(bundles.baseline), candidate: await bundleFingerprint(bundles.candidate), workloadSha256: await workloadFingerprint() };
  const environment = {
    node: process.version, platform: process.platform, architecture: process.arch, kernel: release(),
    logicalCpus: cpus().length, cpuModel: cpus()[0]?.model, totalMemoryBytes: totalmem(),
    executable: process.env.CHROMIUM_PATH || process.env.CHROMIUM || '/usr/bin/chromium',
    noSandbox: process.env.CHROMIUM_NO_SANDBOX === '1', watchdogMs: Number(process.env.BROWSER_TIMEOUT_MS || 90000), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  const mode = pilotFile ? 'comparison' : 'pilot';
  const pilotBytes = pilotFile ? await readFile(pilotFile) : undefined;
  const pilot = pilotBytes ? JSON.parse(pilotBytes.toString('utf8')) : undefined;
  if (pilot) requirePilot(pilot, provenance, environment);
  const report = {
    schemaVersion: 1, mode, status: 'running', startedAt: new Date().toISOString(), provenance, environment, workload,
    pilotSha256: pilotBytes ? createHash('sha256').update(pilotBytes).digest('hex') : null,
    limitations: [
      'Whole owned Chromium tree PSS includes JS and native allocations, browser, renderer, GPU and utility processes; it is not extension-only memory.',
      'Private bytes exclude shared mappings; summed RSS double-counts shared pages. Never subtract isolate heap from PSS to infer native bytes.',
      'Sequential /proc snapshots are not atomic. Zombies/exited processes have no live mappings and are excluded. Detected PID/tree churn discards up to two snapshots, recorded per checkpoint; persistent churn or missing PSS fails. Short-lived or reparented processes can be missed.',
      'Active-dashboard isolate heap after forced GC may include cohosted pages; it is not total browser JS heap and page heaps are not summed.',
      'CDP and fixed synthetic clock/settings perturb behavior and keep the worker attached. These measurements do not establish idle worker exit or native device/browser behavior.',
      'Profiles are cleaned up, not sampled after exit; no claim of immediate OS memory return or process-exit deadline.',
      'Pilot proves bounded execution only. Numerical tolerance and resource acceptance require maintainer approval; this tool does not grant either.'
    ], runs: []
  };
  const save = options => writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, ...options });
  await save({ flag: 'wx' });
  const artifactRoot = resolve(output + '.artifacts');
  const unchanged = async () => {
    for (const variant of ['baseline', 'candidate']) assert.deepEqual(await bundleFingerprint(bundles[variant]), provenance[variant], 'Input bundle changed');
    assert.equal(await workloadFingerprint(), provenance.workloadSha256, 'Workload changed');
  };
  try {
    await mkdir(artifactRoot, { mode: 0o700 });
    for (const entry of runPlan(mode)) {
      await unchanged();
      const executionBundle = await mkdtemp(join(tmpdir(), 'dashboard-native-bundle-'));
      let browser;
      const startedAt = new Date().toISOString();
      try {
        await cp(bundles[entry.variant], executionBundle, { recursive: true });
        assert.deepEqual(await bundleFingerprint(executionBundle), provenance[entry.variant], 'Disposable bundle differs');
        browser = await launch(executionBundle);
        const version = await browser.cdp.send('Browser.getVersion');
        const browserVersion = { product: version.product, revision: version.revision, jsVersion: version.jsVersion };
        const previous = pilot?.runs[0] || report.runs[0];
        if (previous) assert.deepEqual(browserVersion, previous.browserVersion, 'Browser changed between runs');
        const root = await ownedBrowserRoot(browser);
        const result = await withFailureArtifacts(browser, 'dashboard native profile', () => exerciseDashboard(browser, root, mode), artifactRoot);
        await unchanged();
        report.runs.push({ ...entry, startedAt, completedAt: new Date().toISOString(), bundleSha256: provenance[entry.variant].sha256, browserVersion, ...result });
      } finally {
        try { await browser?.cleanup(); }
        finally { await rm(executionBundle, { recursive: true, force: true }); }
      }
      await save();
    }
    if (mode === 'comparison') report.summary = summarize(report.runs);
    report.status = 'complete';
    report.completedAt = new Date().toISOString();
    await save();
  } catch (error) {
    report.status = 'failed';
    report.failure = error.message;
    await save();
    throw error;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baseline, candidate, output, pilot, ...extra] = process.argv.slice(2);
  assert.ok(baseline && candidate && output && !extra.length, 'Usage: node bin/dashboard-native-profile.mjs BASELINE_BUNDLE CANDIDATE_BUNDLE OUTPUT_JSON [COMPLETED_PILOT_JSON]');
  process.env.BROWSER_ARTIFACT_DIR = resolve(output + '.artifacts');
  const report = await profile(baseline, candidate, output, pilot);
  console.log(`${report.mode}: ${report.status}; measurements (bytes): ${resolve(output)}; resource acceptance NOT granted`);
}
