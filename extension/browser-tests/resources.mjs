import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluate, eventually, launch, withFailureArtifacts } from './chromium.mjs';

async function rendererIdentity(browser, pages) {
  const names = ['createratio-resource-worker', ...pages.map((_, index) => `createratio-resource-page-${index}`)];
  let complete;
  const finished = new Promise(resolve => { complete = resolve; });
  const unsubscribe = browser.cdp.on('Tracing.tracingComplete', complete);
  let handle;
  try {
    await browser.cdp.send('Tracing.start', { categories: 'blink.user_timing', transferMode: 'ReturnAsStream' });
    for (const [index, session] of [browser.worker, ...pages.map(page => page.session)].entries()) {
      await evaluate(browser, session, `performance.mark(${JSON.stringify(names[index])})`);
    }
    await browser.cdp.send('Tracing.end');
    const timer = setTimeout(() => complete({ error: 'trace completion timed out' }), 10000);
    const result = await finished;
    clearTimeout(timer);
    if (result.error) throw new Error(result.error);
    handle = result.stream;
    let data = '';
    for (;;) {
      const chunk = await browser.cdp.send('IO.read', { handle });
      data += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data;
      if (data.length > 16 * 1024 * 1024) throw new Error('Resource attribution trace exceeded 16 MiB');
      if (chunk.eof) break;
    }
    const events = JSON.parse(data).traceEvents;
    const pids = names.map(name => [...new Set(events.filter(event => event.name === name).map(event => event.pid))]);
    if (pids.some(matches => matches.length !== 1)) throw new Error('Resource marks did not identify unique renderer processes');
    if (pids.slice(1).some(matches => matches[0] === pids[0][0])) throw new Error('Worker shares a page renderer; worker-only process memory is unattributed');
    return { workerPid: pids[0][0], pagePids: pids.slice(1).map(matches => matches[0]) };
  } finally {
    unsubscribe();
    if (handle) await browser.cdp.send('IO.close', { handle });
  }
}

async function workerMemory(pid) {
  if (process.platform !== 'linux') return { pssKiB: null, privateKiB: null, processPresent: null };
  try {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    const value = field => Number(text.match(new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm'))?.[1]);
    const pssKiB = value('Pss'), privateKiB = value('Private_Clean') + value('Private_Dirty');
    if (!Number.isFinite(pssKiB + privateKiB)) throw new Error('Worker process memory is unreadable');
    return { pssKiB, privateKiB, processPresent: true };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return { pssKiB: 0, privateKiB: 0, processPresent: false };
    throw error;
  }
}

async function pageHeap(browser, pages, cycle) {
  const usedHeapBytes = [];
  for (const page of pages) {
    await browser.cdp.send('HeapProfiler.collectGarbage', {}, page.session);
    usedHeapBytes.push((await browser.cdp.send('Runtime.getHeapUsage', {}, page.session)).usedSize);
  }
  return { cycle, usedHeapBytes };
}

export async function measureResources(bundle, { tabs = 20, cycles = 3, idleMs = 45000 } = {}) {
  if (!Number.isSafeInteger(tabs) || tabs < 1 || tabs > 50) throw new Error('tabs must be an integer from 1 to 50');
  if (!Number.isSafeInteger(cycles) || cycles < 0 || cycles > 20) throw new Error('cycles must be an integer from 0 to 20');
  if (!Number.isSafeInteger(idleMs) || idleMs < 30000 || idleMs > 60000) throw new Error('idleMs must be an integer from 30000 to 60000');
  const browser = await launch(bundle);
  try {
    return await withFailureArtifacts(browser, 'detached worker resource lifecycle', async () => {
      await evaluate(browser, browser.worker, '(async () => { await chrome.storage.local.set({ settings: { ...C3.DEFAULT_SETTINGS, trackedSites: [] } }); })()');
      const pages = [];
      for (let index = 0; index < tabs; index++) {
        const page = await browser.page(`https://x.com/home?resourceTab=${index}`);
        await eventually(() => evaluate(browser, page.session, 'document.readyState === "complete" && !!document.querySelector("#synthetic-site")'), 'synthetic resource page loads');
        pages.push(page);
      }
      const heap = [await pageHeap(browser, pages, 0)];
      for (let cycle = 1; cycle <= cycles; cycle++) {
        for (const [index, page] of pages.entries()) {
          const url = `https://x.com/home?resourceTab=${index}&cycle=${cycle}`;
          await browser.cdp.send('Page.navigate', { url }, page.session);
          await eventually(() => evaluate(browser, page.session, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && !!document.querySelector('#synthetic-site')`), 'resource navigation completes');
        }
        heap.push(await pageHeap(browser, pages, cycle));
      }
      const identity = await rendererIdentity(browser, pages);
      const findWorker = async () => (await browser.cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(browser.origin + '/'));
      const initial = await findWorker();
      if (!initial) throw new Error('Worker missing before debugger detachment');
      const awakeMemory = await workerMemory(identity.workerPid);
      const alarms = await evaluate(browser, browser.worker, '(async () => { const alarms = await chrome.alarms.getAll(); await chrome.alarms.clearAll(); return alarms.map(({ name, scheduledTime }) => ({ name, scheduledTime })); })()');
      const away = await browser.page('about:blank');
      await eventually(() => evaluate(browser, away.session, 'document.hasFocus()'), 'unrelated foreground tab');
      for (const page of pages) await eventually(() => evaluate(browser, page.session, 'document.hidden && !document.hasFocus()'), 'resource page becomes inactive');
      await delay(500);
      await browser.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }, { exclude: true }] });
      if ((await findWorker())?.attached) await browser.cdp.send('Target.detachFromTarget', { sessionId: browser.worker });
      browser.worker = undefined;
      if ((await findWorker())?.attached) throw new Error('Worker still has a debugger attached during idle observation');
      const samples = [], started = performance.now();
      const sample = async () => {
        const target = await findWorker();
        const memory = target && target.targetId !== initial.targetId
          ? { pssKiB: null, privateKiB: null, processPresent: null }
          : await workerMemory(identity.workerPid);
        return { elapsedMs: Math.round(performance.now() - started), present: !!target, targetId: target?.targetId ?? null, debuggerAttached: target?.attached ?? false, ...memory };
      };
      do {
        samples.push(await sample());
        await delay(Math.min(1000, Math.max(0, idleMs - (performance.now() - started))));
      } while (performance.now() - started < idleMs);
      samples.push(await sample());
      await browser.cdp.send('Target.activateTarget', { targetId: pages[0].targetId });
      const returned = await eventually(findWorker, 'foregrounding wakes a worker');
      const settingsPage = await browser.page(browser.origin + '/settings.html');
      const snapshot = await eventually(async () => {
        try { return await evaluate(browser, settingsPage.session, 'chrome.runtime.sendMessage({ type: "snapshot" })'); }
        catch { return false; }
      }, 'new worker serves saved preferences');
      return {
        environment: { node: process.version, platform: process.platform, architecture: process.arch, browser: (await browser.cdp.send('Browser.getVersion')).product },
        workload: { tabs, cycles, idleMs, trackingEnabled: false, scheduledAlarmsCleared: alarms, pageHeapGC: true },
        attribution: { ...identity, processMemorySupported: process.platform === 'linux' },
        worker: { awakeMemory, samples, exited: samples.some(sample => !sample.present), settled: samples.slice(-5).every(sample => !sample.present), recovered: returned.targetId !== initial.targetId, preferencesRecovered: Array.isArray(snapshot?.settings?.trackedSites) && snapshot.settings.trackedSites.length === 0 },
        pages: heap,
        scope: 'Synthetic disabled trackers; worker-only Linux process PSS/private KiB. Page-target V8 heap includes fixture and co-resident contexts, is post-GC, and is not summed or extension-only RAM. Alarms are cleared only in disposable fixtures; this does not test scheduled enforcement, live sites, or sleep/wake.'
      };
    });
  } finally { await browser.cleanup(); }
}
