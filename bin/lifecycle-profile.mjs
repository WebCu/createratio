import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, withFailureArtifacts } from '../extension/browser-tests/chromium.mjs';
import { bundleFingerprint } from './scroll-profile-report.mjs';
import { settingsWorkload, trackerWorkload, blockedWorkload } from './lifecycle-workloads.mjs';
import { validateLifecycleProfile } from './lifecycle-profile-report.mjs';

async function workloadFingerprint() {
  const paths = [
    './lifecycle-profile.mjs',
    './lifecycle-workloads.mjs',
    './lifecycle-resources.mjs',
    './lifecycle-profile-report.mjs',
    './scroll-profile-report.mjs',
    '../extension/browser-tests/chromium.mjs',
    '../extension/browser-tests/scrolling.mjs'
  ];
  const sources = await Promise.all(
    paths.map(async path => ({ path, content: await readFile(new URL(path, import.meta.url), 'utf8') }))
  );
  return createHash('sha256').update(JSON.stringify(sources)).digest('hex');
}

export async function profileLifecycle(baseline, candidate, output, { workload, baselineIdle = false }) {
  assert.ok(['settings', 'trackers', 'blocked'].includes(workload));
  for (const bundle of [baseline, candidate]) await readFile(resolve(bundle, 'manifest.json'), 'utf8');
  const provenance = {
    baseline: await bundleFingerprint(baseline),
    candidate: await bundleFingerprint(candidate),
    workloadSha256: await workloadFingerprint()
  };
  const report = {
    schemaVersion: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    workload,
    baselineIdle,
    provenance,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: release()
    },
    runs: []
  };
  const save = async () => {
    const temporary = resolve(output) + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, output);
  };
  const unchanged = async () => {
    for (const [label, bundle] of [
      ['baseline', baseline],
      ['candidate', candidate]
    ])
      assert.equal(
        (await bundleFingerprint(bundle)).sha256,
        provenance[label].sha256,
        label + ' bundle changed during profiling'
      );
    assert.equal(await workloadFingerprint(), provenance.workloadSha256, 'Workload changed during profiling');
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    for (let repetition = 1; repetition <= 3; repetition++) {
      const order =
        repetition % 2
          ? [
              ['baseline', baseline],
              ['candidate', candidate]
            ]
          : [
              ['candidate', candidate],
              ['baseline', baseline]
            ];
      for (const [variant, bundle] of order) {
        await unchanged();
        const executionBundle = await realpath(await mkdtemp(join(tmpdir(), 'createratio-lifecycle-bundle-')));
        let browser;
        try {
          await cp(resolve(bundle), executionBundle, { recursive: true });
          assert.equal(
            (await bundleFingerprint(executionBundle)).sha256,
            provenance[variant].sha256,
            'Disposable bundle must match the input'
          );
          browser = await launch(executionBundle);
          const result = await withFailureArtifacts(browser, `${workload} lifecycle ${variant} ${repetition}`, () =>
            workload === 'blocked'
              ? blockedWorkload(browser)
              : workload === 'settings'
                ? settingsWorkload(browser)
                : trackerWorkload(browser, { expectIdle: variant === 'candidate' || baselineIdle })
          );
          await unchanged();
          report.runs.push({
            ...result,
            variant,
            repetition,
            bundleSha256: provenance[variant].sha256,
            browser: (await browser.cdp.send('Browser.getVersion')).product
          });
          await save();
          console.log(`${workload}: ${variant} repetition ${repetition} saved`);
        } finally {
          try {
            await browser?.cleanup();
          } finally {
            await rm(executionBundle, { recursive: true, force: true });
          }
        }
      }
    }
    await unchanged();
    report.status = 'complete';
    report.completedAt = new Date().toISOString();
    validateLifecycleProfile(report);
    await save();
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    if (error.resourceCheckpoints) report.failedCheckpoints = error.resourceCheckpoints;
    await save();
    throw error;
  }
  console.log(`Lifecycle measurements: ${resolve(output)}`);
  return report;
}
