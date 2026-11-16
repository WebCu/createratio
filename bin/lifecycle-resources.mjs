import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { evaluate } from '../extension/browser-tests/chromium.mjs';

export function markedProcesses(events, names) {
  return names.map(name => {
    const pids = [...new Set(events.filter(event => event.name === name && Number.isSafeInteger(event.pid) && event.pid > 0).map(event => event.pid))];
    assert.equal(pids.length, 1, `Attribution mark must identify one process: ${name}`);
    return pids[0];
  });
}

export async function attributeTargets(browser, pages) {
  const sessions = [browser.worker, ...pages.map(page => page.session)];
  const names = sessions.map(() => 'createratio-profile-' + randomUUID());
  let finish, timer, handle, tracing = false;
  const completed = new Promise(resolve => { finish = resolve; });
  const unsubscribe = browser.cdp.on('Tracing.tracingComplete', finish);
  try {
    await browser.cdp.send('Tracing.start', { categories: 'blink.user_timing', transferMode: 'ReturnAsStream' }); tracing = true;
    for (const [index, session] of sessions.entries()) await evaluate(browser, session, `performance.mark(${JSON.stringify(names[index])})`);
    await browser.cdp.send('Tracing.end'); tracing = false;
    timer = setTimeout(() => finish({ error: 'Attribution trace timed out' }), 10000);
    const result = await completed;
    assert.ok(!result.error, result.error);
    handle = result.stream;
    let data = '';
    for (;;) {
      const chunk = await browser.cdp.send('IO.read', { handle });
      data += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data;
      assert.ok(Buffer.byteLength(data) <= 16 * 1024 * 1024, 'Attribution trace exceeded 16 MiB');
      if (chunk.eof) break;
    }
    const pids = markedProcesses(JSON.parse(data).traceEvents, names);
    const isolates = [];
    for (const session of sessions) isolates.push((await browser.cdp.send('Runtime.getIsolateId', {}, session)).id);
    return {
      worker: { pid: pids[0], isolate: isolates[0] },
      pages: pages.map((page, index) => ({ targetId: page.targetId, pid: pids[index + 1], isolate: isolates[index + 1] })),
      workerSharesPageProcess: pids.slice(1).includes(pids[0]),
      workerSharesPageIsolate: isolates.slice(1).includes(isolates[0])
    };
  } finally {
    clearTimeout(timer); unsubscribe();
    if (tracing) await browser.cdp.send('Tracing.end').catch(() => {});
    if (handle) await browser.cdp.send('IO.close', { handle });
  }
}

function processIdentity(text) {
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  assert.ok(fields.length >= 20 && /^\d+$/.test(fields[19]), 'Invalid process identity');
  return { startTicks: fields[19], live: !['Z', 'X', 'x'].includes(fields[0]) };
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

export async function processMemory(pid, { platform = process.platform, read = readFile, exists = processExists, expectedStartTicks } = {}) {
  const unavailable = reason => ({ processState: 'unknown', counters: 'unavailable', reason, pssBytes: null, privateBytes: null, rssBytes: null });
  if (platform !== 'linux') return unavailable('Linux /proc counters are unsupported on ' + platform);
  let before;
  try { before = processIdentity(await read(`/proc/${pid}/stat`, 'utf8')); }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code) && exists(pid) === false) return { ...unavailable('Attributed process exited'), processState: 'exited' };
    return unavailable('Process identity unavailable: ' + (error.code || error.message));
  }
  if (!before.live) return { ...unavailable('Attributed process exited'), processState: 'exited' };
  if (expectedStartTicks !== undefined && before.startTicks !== expectedStartTicks) return unavailable('Attributed PID was reused');
  try {
    const text = await read(`/proc/${pid}/smaps_rollup`, 'utf8');
    const after = processIdentity(await read(`/proc/${pid}/stat`, 'utf8'));
    if (before.startTicks !== after.startTicks || !after.live) return unavailable('Process identity changed during sampling');
    const bytes = field => {
      const match = text.match(new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm'));
      assert.ok(match, 'Missing ' + field);
      const value = Number(match[1]) * 1024;
      assert.ok(Number.isSafeInteger(value), 'Invalid ' + field);
      return value;
    };
    return { processState: 'present', startTicks: before.startTicks, counters: 'available', pssBytes: bytes('Pss'), privateBytes: bytes('Private_Clean') + bytes('Private_Dirty'), rssBytes: bytes('Rss') };
  } catch (error) {
    try {
      const after = processIdentity(await read(`/proc/${pid}/stat`, 'utf8'));
      if (after.startTicks !== before.startTicks) return unavailable('PID reused during sampling');
      if (!after.live) return { ...unavailable('Attributed process exited'), processState: 'exited' };
      return { ...unavailable('Memory counters unavailable: ' + (error.code || error.message)), processState: 'present', startTicks: before.startTicks };
    } catch (failure) {
      return { ...unavailable('Process identity unavailable after sampling: ' + (failure.code || failure.message)), processState: ['ENOENT', 'ESRCH'].includes(failure.code) && exists(pid) === false ? 'exited' : 'unknown' };
    }
  }
}

export async function browserMemory(browser) {
  const { processInfo } = await browser.cdp.send('SystemInfo.getProcessInfo');
  const processes = [];
  for (const process of processInfo) processes.push({ pid: process.id, type: process.type, ...await processMemory(process.id) });
  return {
    scope: 'CDP-listed browser processes, not extension-only memory; non-atomic process inventory',
    rssBytes: processes.every(process => process.counters === 'available') ? processes.reduce((sum, process) => sum + process.rssBytes, 0) : null,
    processes
  };
}

async function ownedNodes(browser, session) {
  const { result: prototype } = await browser.cdp.send('Runtime.evaluate', { expression: 'Node.prototype' }, session);
  const { result: document } = await browser.cdp.send('Runtime.evaluate', { expression: 'document' }, session);
  let objects;
  try {
    ({ objects } = await browser.cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId }, session));
    const result = await browser.cdp.send('Runtime.callFunctionOn', {
      objectId: objects.objectId, returnByValue: true, arguments: [{ objectId: document.objectId }],
      functionDeclaration: 'function(document) { const nodes = this.filter(node => { try { return node.ownerDocument === document; } catch (_) { return false; } }); return { ownedNodes: nodes.length, detachedOwnedNodes: nodes.filter(node => !node.isConnected).length }; }'
    }, session);
    assert.ok(!result.exceptionDetails, 'Unable to inspect owned DOM wrappers: ' + result.exceptionDetails?.exception?.description);
    return result.result.value;
  } finally {
    if (objects) await browser.cdp.send('Runtime.releaseObject', { objectId: objects.objectId }, session);
    await browser.cdp.send('Runtime.releaseObject', { objectId: document.objectId }, session);
    await browser.cdp.send('Runtime.releaseObject', { objectId: prototype.objectId }, session);
  }
}

export async function samplePages(browser, pages, cycle, { controls = false } = {}) {
  const samples = [];
  for (const page of pages) {
    await browser.cdp.send('HeapProfiler.collectGarbage', {}, page.session);
    const { id: isolate } = await browser.cdp.send('Runtime.getIsolateId', {}, page.session);
    const heap = await browser.cdp.send('Runtime.getHeapUsage', {}, page.session);
    const dom = await browser.cdp.send('Memory.getDOMCounters', {}, page.session);
    const connectedElements = await evaluate(browser, page.session, 'document.querySelectorAll("*").length');
    samples.push({ targetId: page.targetId, isolate, heapBytes: heap.usedSize, ...dom, connectedElements, ...(controls ? await ownedNodes(browser, page.session) : {}) });
  }
  return { cycle, samples };
}

export function assertStableControls(checkpoints) {
  const first = checkpoints[0].samples;
  for (const point of checkpoints) {
    assert.equal(point.samples.length, first.length, 'Settings page count changed before teardown');
    for (const [index, sample] of point.samples.entries()) {
      assert.ok(sample.connectedElements <= first[index].connectedElements, `Settings DOM nodes accumulated at cycle ${point.cycle}, page ${index}: ${sample.connectedElements} > ${first[index].connectedElements}`);
      assert.ok(sample.detachedOwnedNodes <= first[index].detachedOwnedNodes, `Settings detached DOM nodes accumulated at cycle ${point.cycle}, page ${index}`);
      assert.ok(sample.documents <= first[index].documents, `Settings documents accumulated at cycle ${point.cycle}, page ${index}`);
      assert.ok(sample.jsEventListeners <= first[index].jsEventListeners, `Settings listeners accumulated at cycle ${point.cycle}, page ${index}: ${sample.jsEventListeners} > ${first[index].jsEventListeners}`);
    }
  }
}
