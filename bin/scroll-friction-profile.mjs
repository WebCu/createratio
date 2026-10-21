import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, evaluate, eventually, withFailureArtifacts } from '../extension/browser-tests/chromium.mjs';

const workloads = {
  document: {
    fixture: '<style>body{margin:0;min-height:20000px}</style><h1>Synthetic scroll workload</h1>',
    surface: 'document.scrollingElement'
  },
  'app-shell': {
    fixture: '<style>html,body{margin:0;height:100%;overflow:hidden}body{min-height:20000px}main{position:fixed;inset:0;overflow:auto}</style><main id="profile-surface"><h1>Synthetic app shell</h1><div style="height:20000px">Synthetic feed</div></main>',
    surface: 'document.querySelector("#profile-surface")'
  },
  body: {
    fixture: '<style>html,body{margin:0;height:100%}html{overflow:hidden}body{overflow:auto}</style><h1>Synthetic body scroll</h1><div style="height:20000px">Synthetic feed</div>',
    surface: 'document.body'
  }
};
const [baseline, candidate, output, layout = 'document'] = process.argv.slice(2);
if (!baseline || !candidate || !output || !Object.hasOwn(workloads, layout)) throw new Error('Usage: node bin/scroll-friction-profile.mjs BASELINE_BUNDLE CANDIDATE_BUNDLE OUTPUT_JSON [document|app-shell|body]');
const { fixture, surface } = workloads[layout];
const tabCount = 8, cycles = 30, wheelEvents = 100, idleMs = 6000;

async function injectedBytes(bundle) {
  const manifest = JSON.parse(await readFile(resolve(bundle, 'manifest.json'), 'utf8'));
  const scripts = new Set(manifest.content_scripts.flatMap(entry => entry.js));
  const sizes = await Promise.all([...scripts].map(async script => (await readFile(resolve(bundle, script))).byteLength));
  return sizes.reduce((total, size) => total + size, 0);
}
async function run(bundle, variant, repetition) {
  const manifest = JSON.parse(await readFile(resolve(bundle, 'manifest.json'), 'utf8'));
  const hasFriction = manifest.content_scripts.some(entry => entry.js.includes('scroll-friction.js'));
  const browser = await launch(resolve(bundle));
  try {
    return await withFailureArtifacts(browser, `${variant} ${layout} scroll resource profile ${repetition}`, async () => {
      const contexts = new Map();
      browser.cdp.on('Runtime.executionContextCreated', ({ context }, session) => {
        if (context.origin === browser.origin) contexts.set(session, context.id);
      });
      await evaluate(browser, browser.worker, `(async () => {
        await chrome.storage.local.set({ settings: { ...C3.DEFAULT_SETTINGS, scrollFrictionEnabled: true, scrollFrictionStrength: 50 }, _access: {
          x: { remainingMs: 300000, date: C3.localDate() }, linkedin: { remainingMs: 300000, date: C3.localDate() }
        } });
        await SiteAccess.reconcile();
        globalThis.profileRequests = 0;
        chrome.runtime.onMessage.addListener((message, sender) => { if (sender.tab && message.type === 'snapshot') profileRequests++; });
      })()`);
      async function replaceSurface(page) {
        const replace = layout === 'body'
          ? `const body = document.createElement('body'); body.innerHTML = ${JSON.stringify(fixture)}; document.body.replaceWith(body)`
          : `document.body.innerHTML = ${JSON.stringify(fixture)}`;
        await evaluate(browser, page.session, `(() => { ${replace}; ${surface}.scrollTop = 1000; })()`);
      }
      async function prepare(url) {
        const page = await browser.page(url);
        await eventually(() => evaluate(browser, page.session, 'document.readyState === "complete"'), 'profile document ready');
        await replaceSurface(page);
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
      const settled = enabled => eventually(async () => (await wheelListeners(active)).filter(listener => !listener.passive).length === Number(hasFriction && enabled), 'active tracker applies the scrolling preference');
      await frames(); await settled(true);
      async function handledWheel() {
        const before = await evaluate(browser, active.session, `${surface}.scrollTop`);
        await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 80 }, active.session);
        await eventually(() => evaluate(browser, active.session, `${surface}.scrollTop !== ${before}`), 'profile surface moves');
        return evaluate(browser, active.session, `(async () => {
          let previous = -1, stable = 0;
          for (let frame = 0; frame < 120 && stable < 5; frame++) {
            await new Promise(requestAnimationFrame);
            const next = ${surface}.scrollTop;
            stable = next === previous ? stable + 1 : 0; previous = next;
          }
          return ${surface}.scrollTop - ${before};
        })()`);
      }
      const wheelDistance = await handledWheel();
      assert.ok([40, 80].includes(wheelDistance), 'profile input must move half or the full native distance');
      if (variant === 'candidate' && hasFriction) assert.equal(wheelDistance, 40, 'candidate slows the measured surface at 50%');
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
          await frames(); await settled(enabled);
        }
        assert.equal(await handledWheel(), wheelDistance, 'resistance survives preference and route cycles');
        await replaceSurface(active);
        await frames();
        assert.equal(await handledWheel(), wheelDistance, 'resistance follows a replacement surface');
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
      assert.ok(counts.every(count => count === counts[0]), `lifecycle cycles must not accumulate wheel listeners: ${counts.join(', ')}`);
      const nodeCounts = checkpoints.map(checkpoint => checkpoint.nodes);
      assert.ok(nodeCounts.every(count => count === nodeCounts[0]), `surface replacements must not accumulate DOM nodes: ${nodeCounts.join(', ')}`);
      return {
        variant, repetition, layout, wheelDistance, browser: (await browser.cdp.send('Browser.getVersion')).product, injectedBytes: await injectedBytes(bundle),
        controlHeap, checkpoints, afterWheel, inactiveListeners, idleRequests: idle.after - idle.before,
        workload: { elapsedMs, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, taskMs: (after.TaskDuration - before.TaskDuration) * 1000, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000 }
      };
    });
  } finally { await browser.cleanup(); }
}
const report = { environment: { node: process.version, platform: process.platform, architecture: process.arch }, layout, tabCount, cycles, lifecycleWheelEvents: cycles * 2 + 1, wheelEvents, idleMs, runs: [] };
for (let repetition = 1; repetition <= 3; repetition++) {
  const order = repetition % 2 ? [['baseline', baseline], ['candidate', candidate]] : [['candidate', candidate], ['baseline', baseline]];
  for (const [variant, bundle] of order) {
    report.runs.push(await run(bundle, variant, repetition));
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
}
console.log(`Scroll resource measurements: ${resolve(output)}`);
