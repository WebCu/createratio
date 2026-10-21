import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, evaluate, eventually, withFailureArtifacts } from '../extension/browser-tests/chromium.mjs';

const [baseline, candidate, output] = process.argv.slice(2);
if (!baseline || !candidate || !output) throw new Error('Usage: node bin/scroll-friction-profile.mjs BASELINE_BUNDLE CANDIDATE_BUNDLE OUTPUT_JSON');
const fixture = '<style>body{margin:0;min-height:20000px}</style><h1>Synthetic scroll workload</h1>';
const tabCount = 8, cycles = 30, wheelEvents = 100, idleMs = 6000;

async function injectedBytes(bundle) {
  const manifest = JSON.parse(await readFile(resolve(bundle, 'manifest.json'), 'utf8'));
  const scripts = new Set(manifest.content_scripts.flatMap(entry => entry.js));
  const sizes = await Promise.all([...scripts].map(async script => (await readFile(resolve(bundle, script))).byteLength));
  return sizes.reduce((total, size) => total + size, 0);
}
async function run(bundle, variant, repetition) {
  const browser = await launch(resolve(bundle));
  try {
    return await withFailureArtifacts(browser, `${variant} scroll resource profile ${repetition}`, async () => {
      const contexts = new Map();
      browser.cdp.on('Runtime.executionContextCreated', ({ context }, session) => {
        if (context.origin === browser.origin) contexts.set(session, context.id);
      });
      await evaluate(browser, browser.worker, `(async () => {
        await chrome.storage.local.set({ settings: { ...C3.DEFAULT_SETTINGS, scrollFrictionEnabled: true }, _access: {
          x: { remainingMs: 300000, date: C3.localDate() }, linkedin: { remainingMs: 300000, date: C3.localDate() }
        } });
        await SiteAccess.reconcile();
        globalThis.profileRequests = 0;
        chrome.runtime.onMessage.addListener((message, sender) => { if (sender.tab && message.type === 'snapshot') profileRequests++; });
      })()`);
      async function prepare(url) {
        const page = await browser.page(url);
        await eventually(() => evaluate(browser, page.session, 'document.readyState === "complete"'), 'profile document ready');
        await evaluate(browser, page.session, `document.body.innerHTML = ${JSON.stringify(fixture)}; scrollTo(0, 1000)`);
        return page;
      }
      async function sample(page) {
        await browser.cdp.send('HeapProfiler.collectGarbage', {}, page.session);
        const heap = await browser.cdp.send('Runtime.getHeapUsage', {}, page.session);
        const dom = await browser.cdp.send('Memory.getDOMCounters', {}, page.session);
        return { heapBytes: heap.usedSize, ...dom };
      }
      async function wheelListeners(page) {
        const { result } = await browser.cdp.send('Runtime.evaluate', { expression: 'document', contextId: contexts.get(page.session) }, page.session);
        try {
          const { listeners } = await browser.cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }, page.session);
          return listeners.filter(listener => listener.type === 'wheel').map(listener => ({ passive: listener.passive, capture: listener.useCapture }));
        } finally { await browser.cdp.send('Runtime.releaseObject', { objectId: result.objectId }, page.session); }
      }
      const control = await prepare('about:blank');
      const controlHeap = await sample(control);
      const pages = [];
      for (let i = 0; i < tabCount; i++) pages.push(await prepare(i % 2 ? 'https://www.linkedin.com/feed/' : 'https://x.com/home'));
      const active = pages.at(-1);
      await eventually(() => contexts.has(active.session), 'creation tracker injected');
      await evaluate(browser, browser.worker, 'serialized(() => Promise.resolve())');
      const frames = () => evaluate(browser, active.session, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await frames();
      const checkpoints = [{ cycle: 0, ...await sample(active), wheelListeners: await wheelListeners(active) }];
      for (let cycle = 1; cycle <= cycles; cycle++) {
        for (const enabled of [false, true]) {
          await evaluate(browser, browser.worker, `(async () => {
            const { settings } = await chrome.storage.local.get('settings');
            await chrome.storage.local.set({ settings: { ...settings, scrollFrictionEnabled: ${enabled} } });
            const tabs = await chrome.tabs.query({});
            await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'refresh' }).catch(() => {})));
          })()`);
          await evaluate(browser, browser.worker, 'serialized(() => Promise.resolve())');
          for (const [i, page] of pages.entries()) {
            const route = enabled ? i % 2 ? '/feed/' : '/home' : i % 2 ? '/messaging/' : '/messages';
            await evaluate(browser, page.session, `history.pushState({}, '', ${JSON.stringify(route)})`);
          }
          await frames();
        }
        if (cycle === 10 || cycle === cycles) checkpoints.push({ cycle, ...await sample(active), wheelListeners: await wheelListeners(active) });
      }
      await browser.cdp.send('Performance.enable', {}, active.session);
      const metrics = async () => Object.fromEntries((await browser.cdp.send('Performance.getMetrics', {}, active.session)).metrics.map(metric => [metric.name, metric.value]));
      const before = await metrics();
      const start = performance.now();
      for (let i = 0; i < wheelEvents; i++) {
        await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: i % 2 ? -80 : 80 }, active.session);
      }
      await frames();
      const elapsedMs = performance.now() - start, after = await metrics();
      const afterWheel = await sample(active);
      await browser.cdp.send('Target.activateTarget', { targetId: control.targetId });
      await eventually(() => evaluate(browser, active.session, 'document.hidden && !document.hasFocus()'), 'profile sites hidden');
      const idle = await evaluate(browser, browser.worker, `(async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
        const before = profileRequests;
        await new Promise(resolve => setTimeout(resolve, ${idleMs}));
        return { before, after: profileRequests };
      })()`);
      const inactiveListeners = await wheelListeners(active);
      assert.equal(idle.after, idle.before, 'hidden trackers must not add periodic snapshot requests');
      assert.equal(inactiveListeners.filter(listener => !listener.passive).length, 0, 'hidden documents release scroll friction');
      const counts = checkpoints.map(checkpoint => checkpoint.wheelListeners.length);
      assert.ok(counts.every(count => count === counts[0]), 'lifecycle cycles must not accumulate wheel listeners');
      return {
        variant, repetition, browser: (await browser.cdp.send('Browser.getVersion')).product, injectedBytes: await injectedBytes(bundle),
        controlHeap, checkpoints, afterWheel, inactiveListeners, idleRequests: idle.after - idle.before,
        workload: { elapsedMs, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, taskMs: (after.TaskDuration - before.TaskDuration) * 1000, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000 }
      };
    });
  } finally { await browser.cleanup(); }
}
const report = { environment: { node: process.version, platform: process.platform, architecture: process.arch }, tabCount, cycles, wheelEvents, idleMs, runs: [] };
for (let repetition = 1; repetition <= 3; repetition++) {
  const order = repetition % 2 ? [['baseline', baseline], ['candidate', candidate]] : [['candidate', candidate], ['baseline', baseline]];
  for (const [variant, bundle] of order) {
    report.runs.push(await run(bundle, variant, repetition));
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
}
console.log(`Scroll resource measurements: ${resolve(output)}`);
