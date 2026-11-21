import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { launch, evaluate, eventually, seedAccess, withFailureArtifacts } from '../extension/browser-tests/chromium.mjs';
import { bundleFingerprint } from './scroll-profile-report.mjs';

export function mutationMetrics(coverage, profile, origin) {
  const modes = coverage.filter(script => script.url === origin + '/sites.js').flatMap(script => script.functions
    .filter(fn => fn.functionName === 'mode').map(fn => ({ offset: fn.ranges[0].startOffset, calls: fn.ranges[0].count })));
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  let contentCpuUs = 0;
  for (const [index, id] of (profile.samples || []).entries()) {
    const url = nodes.get(id)?.callFrame.url || '';
    if (url.startsWith(origin + '/') && /\/(content|sites|dom|scroll-friction|messages)\.js$/.test(url)) {
      assert.ok(Number.isFinite(profile.timeDeltas?.[index]), 'Missing CPU sample duration');
      contentCpuUs += profile.timeDeltas[index];
    }
  }
  return { calls: modes.reduce((sum, fn) => sum + fn.calls, 0), modes, contentCpuMs: contentCpuUs / 1000 };
}

export function validateMutationRun(run) {
  const hidden = run.phases.find(phase => phase.phase === 'hidden');
  const returning = run.phases.find(phase => phase.phase === 'return');
  const visible = run.phases.find(phase => phase.phase === 'visible');
  if (run.variant === 'candidate') assert.equal(hidden.calls, 0, 'Candidate hidden mutations must not classify');
  assert.ok(returning.calls > 0, 'return must classify');
  assert.ok(visible.batches > 0 && visible.calls >= Math.ceil(visible.batches / 2), 'Visible mutations must classify at least half the batches');
}

async function workload(browser) {
  await seedAccess(browser, ['x'], { trackedSites: ['x'], scrollFrictionEnabled: false });
  const page = await browser.page('https://x.com/home');
  const send = (method, params = {}) => browser.cdp.send(method, params, page.session);
  await eventually(() => evaluate(browser, page.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'X fixture ready');
  await send('Profiler.enable');
  await send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  await send('Performance.enable');
  const away = await browser.page('about:blank');
  await eventually(() => evaluate(browser, page.session, 'document.visibilityState === "hidden" && !document.hasFocus()'), 'X genuinely hidden');
  await delay(1200);
  const phases = [];
  for (const phase of ['hidden', 'return', 'visible']) {
    await send('Profiler.takePreciseCoverage');
    await send('Profiler.setSamplingInterval', { interval: 100 });
    await send('Profiler.start');
    const scriptTime = async () => (await send('Performance.getMetrics')).metrics.find(metric => metric.name === 'ScriptDuration').value;
    const before = await scriptTime(), start = performance.now();
    if (phase === 'return') {
      await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
      await eventually(() => evaluate(browser, page.session, 'document.visibilityState === "visible" && document.hasFocus()'), 'X returned to foreground');
      await delay(400);
    } else {
      if (phase === 'visible') await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      for (let batch = 0; batch < 100; batch++) {
        await evaluate(browser, page.session, `document.querySelector('#synthetic-site').setAttribute('class', 'batch-${batch}')`);
        await delay(220);
      }
      await delay(1100);
    }
    const after = await scriptTime();
    const { profile } = await send('Profiler.stop');
    const { result } = await send('Profiler.takePreciseCoverage');
    const visibility = await evaluate(browser, page.session, 'document.visibilityState');
    assert.equal(visibility, phase === 'hidden' ? 'hidden' : 'visible');
    phases.push({ phase, batches: phase === 'return' ? 0 : 100, visibility, elapsedMs: performance.now() - start,
      ...mutationMetrics(result, profile, browser.origin), tabScriptMs: (after - before) * 1000 });
  }
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await browser.cdp.send('Target.activateTarget', { targetId: away.targetId });
  await eventually(() => evaluate(browser, page.session, 'document.hidden'), 'tracking settled on departure');
  await eventually(async () => (await evaluate(browser, browser.worker, 'chrome.storage.local.get(null).then(data => data[C3.localDate()]?.x?.consumeSec || 0)')) > 22, 'visible time saved');
  const consumeSec = await evaluate(browser, browser.worker, 'chrome.storage.local.get(null).then(data => data[C3.localDate()].x.consumeSec)');
  return { phases, consumeSec };
}

export async function profileHiddenMutations(baseline, candidate, output) {
  const provenance = { baseline: await bundleFingerprint(baseline), candidate: await bundleFingerprint(candidate),
    instrumentSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') };
  const report = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), provenance,
    environment: { node: process.version, platform: process.platform, architecture: process.arch, osRelease: release() }, runs: [] };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
  try {
    for (let repetition = 1; repetition <= 3; repetition++) {
      for (const variant of repetition % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
        const bundle = variant === 'baseline' ? baseline : candidate;
        assert.equal((await bundleFingerprint(bundle)).sha256, provenance[variant].sha256, 'Bundle changed during profiling');
        const executionBundle = await realpath(await mkdtemp(join(tmpdir(), 'createratio-mutation-bundle-')));
        let browser;
        try {
          await cp(bundle, executionBundle, { recursive: true });
          assert.equal((await bundleFingerprint(executionBundle)).sha256, provenance[variant].sha256, 'Disposable bundle must match the input');
          browser = await launch(executionBundle);
          const result = await withFailureArtifacts(browser, `hidden mutations ${variant} ${repetition}`, () => workload(browser));
          const run = { repetition, variant, ...result, browser: (await browser.cdp.send('Browser.getVersion')).product };
          report.runs.push(run);
          await save();
          validateMutationRun(run);
          assert.equal((await bundleFingerprint(bundle)).sha256, provenance[variant].sha256, 'Bundle changed during profiling');
          console.log(JSON.stringify(run));
        } finally {
          try { await browser?.cleanup(); }
          finally { await rm(executionBundle, { recursive: true, force: true }); }
        }
      }
    }
    report.status = 'complete'; report.completedAt = new Date().toISOString();
    await save();
  } catch (error) {
    report.status = 'failed'; report.error = error.message;
    await save(); throw error;
  }
  console.log(`Hidden mutation measurements: ${resolve(output)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baseline, candidate, output, ...extra] = process.argv.slice(2);
  if (!baseline || !candidate || !output || extra.length) throw new Error('Usage: node bin/hidden-mutation-profile.mjs BASELINE_CHROME CANDIDATE_CHROME NEW_REPORT_JSON');
  await profileHiddenMutations(resolve(baseline), resolve(candidate), resolve(output));
}
