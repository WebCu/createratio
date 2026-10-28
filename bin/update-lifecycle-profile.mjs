import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, evaluate, eventually } from '../extension/browser-tests/chromium.mjs';

async function fingerprint(directory) {
  const files = (await readdir(directory, { recursive: true })).sort();
  const hash = createHash('sha256');
  for (const file of files) if ((await stat(join(directory, file))).isFile()) hash.update(file).update(await readFile(join(directory, file)));
  return hash.digest('hex');
}

async function resources(browser) {
  const { processInfo } = await browser.cdp.send('SystemInfo.getProcessInfo');
  let rssKiB = 0;
  for (const process of processInfo) {
    const status = await readFile('/proc/' + process.id + '/status', 'utf8').catch(() => '');
    rssKiB += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0);
  }
  return { rssKiB };
}

async function observe(directory, label, repetition) {
  const browser = await launch(directory);
  try {
    await evaluate(browser, browser.worker, '(async()=>{await chrome.storage.local.set({settings:{...C3.DEFAULT_SETTINGS,trackedSites:[]},_websiteTimeEnabled:true});await websiteTime.start();})()');
    for (let n = 0; n < 8; n++) {
      const page = await browser.page('https://x.com/home');
      await eventually(() => evaluate(browser, page.session, '!!document.querySelector("#synthetic-site")'), 'synthetic tab ready');
    }
    await browser.page('about:blank');
    await browser.cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    const started = Date.now(); let idleAtMs = null;
    while (Date.now() - started < 42000) {
      const { targetInfos } = await browser.cdp.send('Target.getTargets');
      if (!targetInfos.some(target => target.type === 'service_worker' && target.url.startsWith(browser.origin)) && idleAtMs === null) idleAtMs = Date.now() - started;
      await delay(250);
    }
    const after = await resources(browser), observationMs = Date.now() - started;
    return { label, repetition, idleAtMs, observationMs, browserRssKiB: after.rssKiB };
  } finally { await browser.cleanup(); }
}

const [baseline, candidate, output, ...extra] = process.argv.slice(2);
const baselineIdle = extra.length === 1 && extra[0] === '--baseline-idle';
if (!baseline || !candidate || !output || extra.length && !baselineIdle) throw new Error('Usage: node bin/update-lifecycle-profile.mjs BASELINE_CHROME CANDIDATE_CHROME NEW_REPORT_JSON [--baseline-idle]');
try { await stat(output); throw new Error('Report already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const directory = await mkdtemp(join(tmpdir(), 'createratio-update-profile-'));
try {
  const sources = { baseline: resolve(baseline), candidate: resolve(candidate) }, hashes = {}, fixtures = {};
  for (const [label, source] of Object.entries(sources)) {
    hashes[label] = await fingerprint(source);
    const fixture = join(directory, label); fixtures[label] = fixture;
    await cp(source, fixture, { recursive: true });
    const manifest = JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8'));
    manifest.permissions = [...new Set([...manifest.permissions, 'tabs', 'idle'])];
    manifest.optional_permissions = manifest.optional_permissions.filter(permission => !['tabs', 'idle'].includes(permission));
    await writeFile(join(fixture, 'manifest.json'), JSON.stringify(manifest));
  }
  const records = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const label of repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const record = await observe(fixtures[label], label, repetition + 1); records.push(record); console.log(JSON.stringify(record));
    }
  }
  for (const [label, source] of Object.entries(sources)) if (hashes[label] !== await fingerprint(source)) throw new Error('Bundle changed during measurement: ' + label);
  const report = { node: process.version, platform: process.platform, architecture: process.arch, hashes, baselineIdle, fixture: 'Eight synthetic website tabs, Website time enabled; optional tabs/idle permissions granted in disposable manifests only. All debugger sessions detached during observation. Target inventory and process metrics are browser-level, not worker probes.', limitations: 'Summed process RSS is not private heap or shared-memory-adjusted browser memory. Worker shutdown is not zero extension memory. Store delivery, Firefox, sleep/wake and resource acceptance are not established.', records };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
  if (records.some(record => {
    const expectIdle = record.label === 'candidate' || baselineIdle;
    return expectIdle ? record.idleAtMs === null : record.idleAtMs !== null;
  })) throw new Error('Worker shutdown comparison failed; inspect report');
} finally { await rm(directory, { recursive: true, force: true }); }
