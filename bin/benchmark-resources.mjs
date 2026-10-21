import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { measureResources } from '../extension/browser-tests/resources.mjs';

async function bundleHash(directory) {
  const hash = createHash('sha256');
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Benchmark bundles must not contain symbolic links');
      if (path === directory && entry.name === '_metadata' && entry.isDirectory()) continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) { hash.update(file.slice(directory.length)); hash.update(await readFile(file)); }
    }
  }
  await readFile(join(directory, 'manifest.json'));
  await visit(directory);
  return hash.digest('hex');
}

async function saveReport(path, report) {
  await writeFile(path + '.tmp', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
}

function summary(values) {
  values = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return { median: null, min: null, max: null };
  const middle = Math.floor(values.length / 2);
  return { median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2, min: values[0], max: values.at(-1) };
}

try {
  const { values } = parseArgs({ options: {
    baseline: { type: 'string' }, candidate: { type: 'string' }, output: { type: 'string' },
    runs: { type: 'string', default: '3' }, tabs: { type: 'string', default: '20' },
    cycles: { type: 'string', default: '3' }, 'idle-ms': { type: 'string', default: '45000' },
    help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log('Usage: node bin/benchmark-resources.mjs --baseline /path/to/chrome --candidate /path/to/chrome --output /tmp/resources.json [--runs 3 --tabs 20 --cycles 3 --idle-ms 45000]');
  } else {
    if (!values.baseline || !values.candidate || !values.output) throw new Error('--baseline, --candidate and --output are required');
    const runs = Number(values.runs), options = { tabs: Number(values.tabs), cycles: Number(values.cycles), idleMs: Number(values['idle-ms']) };
    if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs must be an integer from 1 to 10');
    const bundles = { baseline: resolve(values.baseline), candidate: resolve(values.candidate) };
    const fingerprints = Object.fromEntries(await Promise.all(Object.entries(bundles).map(async ([name, directory]) => [name, await bundleHash(directory)])));
    const report = { schema: 1, complete: false, generatedAt: new Date().toISOString(), bundles, fingerprints, options, repetitions: runs, runs: [] };
    await mkdir(dirname(resolve(values.output)), { recursive: true });
    await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    for (let repetition = 0; repetition < runs; repetition++) {
      const order = repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const build of order) {
        console.log(`Measuring ${build}, repetition ${repetition + 1}/${runs}`);
        const measurement = await measureResources(bundles[build], options);
        report.runs.push({ build, repetition: repetition + 1, ...measurement });
        await saveReport(values.output, report);
      }
    }
    for (const [name, directory] of Object.entries(bundles)) {
      if (await bundleHash(directory) !== fingerprints[name]) throw new Error(`${name} bundle changed during the comparison; evidence is incomplete`);
    }
    if (new Set(report.runs.map(run => run.environment.browser)).size !== 1) throw new Error('Browser version changed during the comparison; evidence is incomplete');
    const metrics = {
      workerAwakePssKiB: run => run.worker.awakeMemory.pssKiB,
      initialWorkerRendererIdlePssKiB: run => run.worker.samples.at(-1).pssKiB,
      pageTargetPostGcHeapBytes: run => summary(run.pages.at(-1).usedHeapBytes).median
    };
    report.comparison = Object.fromEntries(Object.entries(metrics).map(([name, extract]) => {
      const baseline = summary(report.runs.filter(run => run.build === 'baseline').map(extract));
      const candidate = summary(report.runs.filter(run => run.build === 'candidate').map(extract));
      return [name, { baseline, candidate, delta: baseline.median === null || candidate.median === null ? null : candidate.median - baseline.median }];
    }));
    report.candidateLifecyclePassed = report.runs.filter(run => run.build === 'candidate').every(run => run.worker.exited && run.worker.settled && run.worker.recovered && run.worker.preferencesRecovered);
    report.memoryBudgetPassed = null;
    report.complete = true;
    await saveReport(values.output, report);
    console.log(`Resource evidence: ${resolve(values.output)}; candidate lifecycle ${report.candidateLifecyclePassed ? 'passed' : 'FAILED'}. No numerical memory budget was evaluated.`);
    if (!report.candidateLifecyclePassed) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
