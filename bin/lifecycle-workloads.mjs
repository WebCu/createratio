import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluate, eventually, click, seedAccess } from '../extension/browser-tests/chromium.mjs';
import { scrollFixture } from '../extension/browser-tests/scrolling.mjs';
import { attributeTargets, processMemory, browserMemory, samplePages, assertStableControls } from './lifecycle-resources.mjs';

export async function blockedReturnReady(browser, session, completed) {
  return evaluate(browser, session, `blockedProfile.completed > ${completed} && !refreshing`);
}

export async function blockedWorkload(browser) {
  const idleMs = 60000;
  await seedAccess(browser, [], { trackedSites: ['x'], allowAboveGoal: false });
  await evaluate(browser, browser.worker, 'chrome.storage.local.set({_websiteTimeEnabled:false})');
  const gate = await browser.page(browser.origin + '/blocked.html?site=x');
  const ready = session => evaluate(browser, session, '!document.hidden && !document.querySelector("#request").hidden && !document.querySelector("#begin").disabled && document.querySelector("#error").hidden && document.querySelector("#state-text").textContent === "Blocked by default"');
  await eventually(() => ready(gate.session), 'blocked X gate ready');
  await evaluate(browser, gate.session, `(() => {
    globalThis.blockedProfile = { sends: 0, completed: 0, alarms: [], token: crypto.randomUUID() };
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'access-status') blockedProfile.sends++;
      const reply = await send(message);
      if (message.type === 'access-status') blockedProfile.completed++;
      return reply;
    };
    chrome.alarms.onAlarm.addListener(alarm => blockedProfile.alarms.push({ name: alarm.name, scheduledTime: alarm.scheduledTime, observedAt: Date.now() }));
  })()`);
  const scheduledAlarms = await evaluate(browser, gate.session, 'chrome.alarms.getAll()');
  const control = await browser.page('about:blank');
  await browser.cdp.send('Target.activateTarget', { targetId: control.targetId });
  await eventually(() => evaluate(browser, gate.session, 'document.hidden && !document.hasFocus()'), 'gate hidden');
  const before = await evaluate(browser, gate.session, 'structuredClone(blockedProfile)');
  await browser.cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  browser.worker = undefined;
  const started = performance.now(), observationStartedAt = Date.now(), observations = [];
  async function sample() {
    const { targetInfos } = await browser.cdp.send('Target.getTargets');
    assert.ok(targetInfos.every(target => !target.attached), 'All debugger sessions must be detached');
    const target = targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(browser.origin + '/'));
    observations.push({ elapsedMs: performance.now() - started, targetId: target?.targetId ?? null, attached: target?.attached ?? false });
  }
  do {
    await sample();
    await delay(Math.min(250, Math.max(0, idleMs - (performance.now() - started))));
  } while (performance.now() - started < idleMs);
  await sample();
  const observationEndedAt = Date.now();
  const attachment = await browser.cdp.send('Target.attachToTarget', { targetId: gate.targetId, flatten: true });
  const hidden = await evaluate(browser, attachment.sessionId, '({hidden:document.hidden,...structuredClone(blockedProfile)})');
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.token, before.token);
  const returnStarted = performance.now();
  await browser.cdp.send('Target.activateTarget', { targetId: gate.targetId });
  await eventually(async () => await blockedReturnReady(browser, attachment.sessionId, hidden.completed) && await ready(attachment.sessionId), 'gate synchronizes on return');
  const returnSyncMs = performance.now() - returnStarted;
  assert.ok(returnSyncMs < 1500, 'Foreground synchronization must be immediate');
  const returned = await evaluate(browser, attachment.sessionId, 'structuredClone(blockedProfile)');
  const firstAbsent = observations.find(point => point.targetId === null);
  return {
    workload: 'blocked', idleMs, observationStartedAt, observationEndedAt, observations,
    continuousLifetimeMs: firstAbsent?.elapsedMs ?? null,
    aliveSamplesFraction: observations.filter(point => point.targetId !== null).length / observations.length,
    hiddenSends: hidden.sends - before.sends, returnSends: returned.sends - hidden.sends,
    returnSyncMs, synced: true, sameDocument: returned.token === before.token,
    scheduledAlarms, alarmWakes: hidden.alarms, alarmsAfter: await evaluate(browser, attachment.sessionId, 'chrome.alarms.getAll()'),
    fixture: 'One blocked X gate, no wait/session, Website time off, neutral foreground tab. Page-local send counter and alarm listener; all debugger sessions detached for 60 seconds. Alarms remain enabled. Target samples identify presence, not exact termination times or memory.'
  };
}

export async function settingsWorkload(browser, { cycles = 12, tabCount = 4, afterCycle = async () => {} } = {}) {
  assert.ok(Number.isSafeInteger(cycles) && cycles >= 1 && cycles <= 12);
  assert.ok(Number.isSafeInteger(tabCount) && tabCount >= 1 && tabCount <= 4);
  await seedAccess(browser, [], { trackedSites: ['x'], accessMinutes: 5, siteOverrides: {} });
  const pages = [];
  const ready = page => eventually(() => evaluate(browser, page.session, '!!document.querySelector("#accessMinutes-site-x") && !document.querySelector("#accessMinutes-site-x").disabled && document.querySelector("#error").hidden'), 'Settings controls ready');
  for (let index = 0; index < tabCount; index++) { const page = await browser.page(browser.origin + '/settings.html'); await ready(page); pages.push(page); }
  async function choose(page, value) {
    await evaluate(browser, page.session, `(() => { const select = document.querySelector('#accessMinutes-site-x'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    if (value === 'custom') await eventually(() => evaluate(browser, page.session, '!document.querySelector("#custom-duration-site-x").hidden'), 'Custom editor opened');
    else await eventually(() => evaluate(browser, page.session, `!document.querySelector('#accessMinutes-site-x').disabled && document.querySelector('#accessMinutes-site-x').value === ${JSON.stringify(value)}`), 'duration saved');
  }
  async function exercise(page) {
    await choose(page, '10');
    await choose(page, 'custom');
    await evaluate(browser, page.session, 'document.querySelector("#customMinutes-site-x").value = "17"');
    await click(browser, page, '#custom-save-site-x');
    await eventually(() => evaluate(browser, page.session, 'document.querySelector("#custom-duration-site-x").hidden && document.querySelector("#accessMinutes-site-x").value === "17" && !document.querySelector("#accessMinutes-site-x").disabled'), 'Custom value saved');
    await choose(page, 'custom');
    await evaluate(browser, page.session, 'document.querySelector("#customMinutes-site-x").value = "23"');
    await click(browser, page, '#custom-cancel-site-x');
    assert.equal(await evaluate(browser, page.session, 'document.querySelector("#custom-duration-site-x").hidden && document.querySelector("#accessMinutes-site-x").value === "17"'), true, 'Cancel keeps the confirmed value');
    await choose(page, 'default');
    await evaluate(browser, page.session, '(async()=>{await refresh();clearSaved();document.activeElement.blur();})()');
  }
  for (const page of pages) await exercise(page);
  const checkpoint = async (cycle, phase) => ({ ...await samplePages(browser, pages, cycle, { controls: true }), phase });
  const checkpoints = [await checkpoint(0, 'initial')];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const measured = cycle === Math.ceil(cycles / 2) || cycle === cycles;
    for (const page of pages) {
      await evaluate(browser, page.session, '(async()=>{await refresh();await refresh();})()');
      await exercise(page);
      await afterCycle(browser, page, cycle);
    }
    if (measured) checkpoints.push(await checkpoint(cycle, 'before-navigation'));
    for (const page of pages) {
      if (cycle % 3 === 0) {
        const previousDocument = await evaluate(browser, page.session, 'performance.timeOrigin');
        await browser.cdp.send('Page.reload', {}, page.session);
        await eventually(() => evaluate(browser, page.session, `performance.timeOrigin !== ${previousDocument}`), 'new Settings document after reload');
        await ready(page);
        assert.equal(await evaluate(browser, page.session, 'document.querySelector("#accessMinutes-site-x").value'), 'default', 'inherited duration survives reload');
        await exercise(page);
      }
    }
    if (measured) checkpoints.push(await checkpoint(cycle, 'after-navigation'));
  }
  try { assertStableControls(checkpoints); }
  catch (error) { error.resourceCheckpoints = checkpoints; throw error; }
  const attribution = await attributeTargets(browser, pages);
  const workerMemory = await processMemory(attribution.worker.pid), wholeBrowser = await browserMemory(browser);
  for (const page of pages.slice(1)) await browser.cdp.send('Target.closeTarget', { targetId: page.targetId });
  await eventually(async () => {
    const { targetInfos } = await browser.cdp.send('Target.getTargets');
    return pages.slice(1).every(page => !targetInfos.some(target => target.targetId === page.targetId));
  }, 'extra Settings targets released');
  const teardown = await samplePages(browser, pages.slice(0, 1), cycles + 1, { controls: true });
  return { workload: 'settings', cycles, tabCount, checkpoints, attribution, workerMemory, wholeBrowser, teardown, closedTargets: pages.length - 1 };
}

export async function trackerWorkload(browser, { cycles = 3, tabCount = 8, idleMs = 42000, expectIdle = true } = {}) {
  assert.ok(Number.isSafeInteger(cycles) && cycles >= 1 && cycles <= 3);
  assert.ok(Number.isSafeInteger(tabCount) && tabCount >= 1 && tabCount <= 8);
  assert.ok(Number.isSafeInteger(idleMs) && idleMs >= 35000 && idleMs <= 60000);
  const scrolling = scrollFixture(browser);
  await seedAccess(browser, ['x'], { trackedSites: ['x'], scrollFrictionEnabled: true, scrollFrictionStrength: 75 });
  const pages = [];
  async function ready(page, url) {
    await eventually(() => evaluate(browser, page.session, `location.href === ${JSON.stringify(url)} && !!document.querySelector('#synthetic-site') && document.hasFocus()`), 'current tracker document ready');
    await evaluate(browser, page.session, 'document.body.style.minHeight = "20000px"');
    await eventually(() => scrolling.isEnabled(page), 'current tracker applied its initial saved preferences');
  }
  for (let index = 0; index < tabCount; index++) {
    const url = `https://x.com/home?resourceTab=${index}`;
    const page = await browser.page(url); await ready(page, url); pages.push(page);
  }
  const control = await browser.page('about:blank'), controlHeap = await samplePages(browser, [control], 0);
  const checkpoints = [await samplePages(browser, pages, 0)];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (const [index, page] of pages.entries()) {
      const url = `https://x.com/home?resourceTab=${index}&cycle=${cycle}`;
      await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
      await browser.cdp.send('Page.navigate', { url }, page.session);
      await ready(page, url);
    }
    checkpoints.push(await samplePages(browser, pages, cycle));
  }
  await evaluate(browser, pages[0].session, 'globalThis.resourceDocumentToken = "same synthetic document"');
  const attribution = await attributeTargets(browser, pages);
  const workerMemory = await processMemory(attribution.worker.pid), wholeBrowser = await browserMemory(browser);
  await browser.cdp.send('Target.activateTarget', { targetId: control.targetId });
  for (const page of pages) await eventually(() => evaluate(browser, page.session, 'document.hidden && !document.hasFocus()'), 'tracker inactive');
  await delay(500);
  const alarms = await evaluate(browser, browser.worker, '(async()=>{const alarms=await chrome.alarms.getAll();await chrome.alarms.clearAll();return alarms;})()');
  const findWorker = async () => (await browser.cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(browser.origin + '/'));
  const initial = await findWorker(); assert.ok(initial, 'worker present before detachment');
  await browser.cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  browser.worker = undefined;
  const started = performance.now(), observations = [];
  do {
    const target = await findWorker();
    assert.ok(!target?.attached, 'idle observation cannot keep a worker debugger attached');
    observations.push({ elapsedMs: performance.now() - started, targetId: target?.targetId ?? null, attached: target?.attached ?? false });
    await delay(Math.min(250, Math.max(0, idleMs - (performance.now() - started))));
  } while (performance.now() - started < idleMs);
  const final = await findWorker();
  observations.push({ elapsedMs: performance.now() - started, targetId: final?.targetId ?? null, attached: final?.attached ?? false });
  const absent = observations.some(point => point.targetId === null), settled = observations.slice(-5).every(point => point.targetId === null);
  assert.equal(absent, expectIdle, 'natural worker shutdown must match the selected baseline/candidate expectation');
  if (expectIdle) assert.equal(settled, true, 'worker stays absent at the end of the idle window');
  const idleMemory = await processMemory(attribution.worker.pid, { expectedStartTicks: workerMemory.startTicks });
  await browser.cdp.send('Target.activateTarget', { targetId: pages[0].targetId });
  const returned = await eventually(findWorker, 'foregrounding the website naturally wakes a worker');
  if (expectIdle) assert.notEqual(returned.targetId, initial.targetId, 'foregrounding must start a replacement worker');
  const attachment = await browser.cdp.send('Target.attachToTarget', { targetId: returned.targetId, flatten: true });
  browser.worker = attachment.sessionId;
  await browser.cdp.send('Runtime.enable', {}, browser.worker);
  const pageAttachment = await browser.cdp.send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
  pages[0].session = pageAttachment.sessionId;
  await browser.cdp.send('Runtime.enable', {}, pages[0].session);
  const preferences = await evaluate(browser, browser.worker, 'chrome.storage.local.get("settings").then(data=>({trackedSites:data.settings.trackedSites,strength:data.settings.scrollFrictionStrength}))');
  assert.deepEqual(preferences, { trackedSites: ['x'], strength: 75 });
  assert.equal(await evaluate(browser, pages[0].session, 'resourceDocumentToken'), 'same synthetic document');
  await eventually(() => scrolling.isEnabled(pages[0]), 'foreground tracker recovered saved preferences');
  assert.equal(await scrolling.distance(pages[0], 'html', 80), 20, 'saved 75% resistance governs real foreground input after wake');
  for (const alarm of alarms) await evaluate(browser, browser.worker, `chrome.alarms.create(${JSON.stringify(alarm.name)},${JSON.stringify({ when: Math.max(Date.now() + 60000, alarm.scheduledTime), ...(alarm.periodInMinutes ? { periodInMinutes: alarm.periodInMinutes } : {}) })})`);
  return {
    workload: 'trackers', cycles, tabCount, idleMs, expectIdle, checkpoints, controlHeap, attribution, workerMemory, wholeBrowser,
    idle: { observations, idleMemory, absent, settled, observationMs: observations.at(-1).elapsedMs, recovered: returned.targetId !== initial.targetId, preferences, sameDocument: true },
    fixtureAlarms: alarms, fixtureChanges: 'Scheduled alarms cleared only for the detached observation and restored after wake with at least one minute remaining. No Website time opt-in; synthetic X trackers with saved 75% resistance and a seeded access session.'
  };
}
