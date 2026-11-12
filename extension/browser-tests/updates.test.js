'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { cp, mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');

async function waitForTracking(browser, site, scrolling) {
  const { evaluate, eventually } = await import('./chromium.mjs');
  await eventually(async () => await scrolling.isEnabled(site) && await evaluate(browser, site.session, 'document.hasFocus() && document.visibilityState === "visible"'), 'foreground creation tracker has applied its preferences');
}

test('tracking readiness rejects a guard-only client and a pending tracker snapshot before and after reinjection', async t => {
  const { launch, evaluate, eventually, seedAccess, withFailureArtifacts } = await import('./chromium.mjs');
  const { scrollFixture } = await import('./scrolling.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'createratio-tracker-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = path.join(await realpath(directory), 'chrome');
  await cp(path.resolve(__dirname, '../../dist/chrome'), bundle, { recursive: true });
  const manifestPath = path.join(bundle, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const trackerEntry = manifest.content_scripts.find(entry => entry.js.includes('content.js'));
  manifest.content_scripts = manifest.content_scripts.filter(entry => entry !== trackerEntry);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const browser = await launch(bundle);
  const scrolling = scrollFixture(browser);
  try {
    await withFailureArtifacts(browser, 'delayed creation tracker readiness', async () => {
      await seedAccess(browser, ['x']);
      const site = await browser.page('https://x.com/home');
      await eventually(() => evaluate(browser, site.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'website ready');
      for (const phase of ['initial load', 'reinjection']) {
        if (phase === 'reinjection') {
          await evaluate(browser, browser.worker, `(async () => {
            const [tab] = await chrome.tabs.query({url:'https://x.com/home'});
            await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lifecycle.js','access-guard.js']});
          })()`);
        }
        await eventually(() => evaluate(browser, browser.worker, '(async()=>{const [tab]=await chrome.tabs.query({url:"https://x.com/home"});return (await chrome.tabs.sendMessage(tab.id,{type:"prepare-update",force:true})).ready;})()'), 'guard ready');
        await evaluate(browser, browser.worker, '(async()=>{const [tab]=await chrome.tabs.query({url:"https://x.com/home"});await chrome.tabs.sendMessage(tab.id,{type:"resume-update"});})()');
        const readiness = waitForTracking(browser, site, scrolling);
        readiness.catch(() => {});
        const premature = await Promise.race([readiness.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 200))]);
        assert.equal(premature, false, `${phase}: guard readiness must not authorize tracker input`);
        await evaluate(browser, browser.worker, `(async () => {
          const [tab] = await chrome.tabs.query({url:'https://x.com/home'});
          await chrome.scripting.executeScript({target:{tabId:tab.id},func:() => {
            const send = chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.runtime.sendMessage = message => {
              if (message.type !== 'snapshot') return send(message);
              return new Promise(resolve => {
                globalThis.releaseTrackerSnapshot = () => {
                  chrome.runtime.sendMessage = send;
                  resolve(send(message));
                };
              });
            };
          }});
          await chrome.scripting.executeScript({target:{tabId:tab.id},files:${JSON.stringify(trackerEntry.js)}});
        })()`);
        const unsynchronized = await Promise.race([readiness.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 200))]);
        assert.equal(unsynchronized, false, `${phase}: tracker registration must not authorize input before synchronization`);
        await evaluate(browser, browser.worker, `(async () => {
          const [tab] = await chrome.tabs.query({url:'https://x.com/home'});
          await chrome.scripting.executeScript({target:{tabId:tab.id},func:() => globalThis.releaseTrackerSnapshot()});
        })()`);
        await readiness;
        const before = await evaluate(browser, browser.worker, '(async()=>{const data=await chrome.storage.local.get(C3.localDate());return C3.aggregate(data[C3.localDate()]).consumeSec;})()');
        await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, site.session);
        await evaluate(browser, site.session, 'new Promise(resolve => setTimeout(resolve, 200))');
        await evaluate(browser, browser.worker, '(async()=>{const [tab]=await chrome.tabs.query({url:"https://x.com/home"});return chrome.tabs.sendMessage(tab.id,{type:"prepare-update",force:true});})()');
        const after = await evaluate(browser, browser.worker, '(async()=>{const data=await chrome.storage.local.get(C3.localDate());return C3.aggregate(data[C3.localDate()]).consumeSec;})()');
        assert.ok(after > before, `${phase}: fresh trusted input reaches saved measurements`);
        await evaluate(browser, browser.worker, '(async()=>{const [tab]=await chrome.tabs.query({url:"https://x.com/home"});return chrome.tabs.sendMessage(tab.id,{type:"commit-update"});})()');
      }
    });
  } finally { await browser.cleanup(); }
});

test('a focused inactive website lets the actual worker stop with every debugger detached', async () => {
  const { launch, evaluate, eventually } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await evaluate(browser, browser.worker, 'chrome.storage.local.set({settings:{...C3.DEFAULT_SETTINGS,trackedSites:[]}})');
    const site = await browser.page('https://x.com/home');
    await eventually(() => evaluate(browser, site.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'inactive website ready');
    await browser.cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    await eventually(async () => !(await browser.cdp.send('Target.getTargets')).targetInfos.some(target => target.type === 'service_worker' && target.url.startsWith(browser.origin)), 'worker stops without empty polling', 40000);
  } finally { await browser.cleanup(); }
});

test('worker replacement after committed teardown restores the same website document without applying the update', async () => {
  const { launch, evaluate, eventually, seedAccess, withFailureArtifacts } = await import('./chromium.mjs');
  const { scrollFixture } = await import('./scrolling.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'), { developerMode: true });
  const scrolling = scrollFixture(browser);
  try {
    await withFailureArtifacts(browser, 'interrupted update recovery', async () => {
      await seedAccess(browser, ['x']);
      const settings = await browser.page(browser.origin + '/settings.html');
      await eventually(() => evaluate(browser, settings.session, '!!document.querySelector("#track-x")'), 'Settings ready');
      await evaluate(browser, browser.worker, 'updates.available({version:"0.0.5"})');
      const site = await browser.page('https://x.com/home');
      await eventually(() => evaluate(browser, site.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'website ready');
      await waitForTracking(browser, site, scrolling);
      await evaluate(browser, site.session, '(() => { globalThis.documentToken = "preserved"; const draft = document.createElement("textarea"); draft.id = "draft"; draft.value = "Unsaved synthetic draft"; document.body.append(draft); })()');
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, site.session);
      await evaluate(browser, site.session, 'new Promise(resolve => setTimeout(resolve, 200))');
      const result = await evaluate(browser, browser.worker, '(async()=>{chrome.runtime.reload=()=>{};return updates.attempt(true);})()');
      assert.equal(result.applied, true);
      assert.equal(await evaluate(browser, browser.worker, 'chrome.storage.local.get("_updateRecovery").then(data=>data._updateRecovery)'), true);
      await evaluate(browser, browser.worker, `(async()=>{
        const [tab]=await chrome.tabs.query({url:'https://x.com/home'});
        await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
          const send=chrome.runtime.sendMessage.bind(chrome.runtime);
          globalThis.recoverySnapshotAttempts=0;
          chrome.runtime.sendMessage=message=>{
            if(message.type!=='snapshot') return send(message);
            const attempt=++globalThis.recoverySnapshotAttempts;
            if(attempt===1) return Promise.reject(new Error('Synthetic transient startup failure'));
            return send(message).then(async reply=>{
              if(attempt===2) await new Promise(resolve=>setTimeout(resolve,500));
              return reply;
            });
          };
        }});
      })()`);
      const old = (await browser.cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(browser.origin));
      await browser.cdp.send('Target.detachFromTarget', { sessionId: browser.worker });
      await browser.cdp.send('ServiceWorker.enable', {}, settings.session);
      await browser.cdp.send('ServiceWorker.stopAllWorkers', {}, settings.session);
      await eventually(async () => !(await browser.cdp.send('Target.getTargets')).targetInfos.some(target => target.targetId === old.targetId), 'old worker stopped');
      const waking = evaluate(browser, settings.session, 'chrome.runtime.sendMessage({type:"snapshot"})'); waking.catch(() => {});
      const replacement = await eventually(async () => (await browser.cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === old.url && target.targetId !== old.targetId), 'replacement worker');
      const attached = await browser.cdp.send('Target.attachToTarget', { targetId: replacement.targetId, flatten: true });
      browser.worker = attached.sessionId;
      await browser.cdp.send('Runtime.enable', {}, browser.worker);
      await waking;
      await eventually(() => evaluate(browser, browser.worker, 'chrome.storage.local.get("_updateRecovery").then(data=>!data._updateRecovery)'), 'stopped clients restored before clearing recovery state');
      assert.equal(await evaluate(browser, browser.worker, 'chrome.storage.local.get("_pendingUpdate").then(data=>data._pendingUpdate)'), '0.0.5');
      await eventually(() => evaluate(browser, browser.worker, `(async()=>{
        const [tab]=await chrome.tabs.query({url:'https://x.com/home'});
        const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>globalThis.recoverySnapshotAttempts});
        return result.result>=2;
      })()`), 'transient initialization failure retried without navigation or a focus change', 15000);
      assert.deepEqual(await evaluate(browser, site.session, '({token:documentToken,draft:document.querySelector("#draft").value})'), { token: 'preserved', draft: 'Unsaved synthetic draft' });
      const before = await evaluate(browser, browser.worker, '(async()=>{const data=await chrome.storage.local.get(C3.localDate());return C3.aggregate(data[C3.localDate()]).consumeSec;})()');
      assert.ok(before > 0);
      await waitForTracking(browser, site, scrolling);
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, site.session);
      await eventually(() => evaluate(browser, browser.worker, `(async()=>{const data=await chrome.storage.local.get(C3.localDate());return C3.aggregate(data[C3.localDate()]).consumeSec > ${before};})()`), 'recovered tracker saves new measurements');
    });
  } finally { await browser.cleanup(); }
});

test('a prepared extension reload preserves website drafts and resumes tracking in the same document', async () => {
  const { launch, evaluate, eventually, click, seedAccess, withFailureArtifacts } = await import('./chromium.mjs');
  const { scrollFixture } = await import('./scrolling.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'), { developerMode: true });
  const scrolling = scrollFixture(browser);
  try {
    await withFailureArtifacts(browser, 'safe extension update', async () => {
      await seedAccess(browser, ['x']);
      const site = await browser.page('https://x.com/home');
      await eventually(() => evaluate(browser, site.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'website ready');
      await waitForTracking(browser, site, scrolling);
      await evaluate(browser, site.session, `(() => { const input = document.createElement('textarea'); input.id = 'draft'; input.value = 'Unsaved synthetic draft'; document.body.append(input); globalThis.documentToken = 'same document'; })()`);
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, site.session);
      await evaluate(browser, site.session, 'new Promise(resolve => setTimeout(resolve, 200))');
      const settings = await browser.page(browser.origin + '/settings.html');
      await eventually(() => evaluate(browser, settings.session, '!!document.querySelector("#track-x")'), 'Settings ready');
      await evaluate(browser, browser.worker, 'updates.available({version:"0.0.5"})');
      await eventually(() => evaluate(browser, settings.session, '!document.querySelector("#update-notice").hidden'), 'pending update notice');
      assert.equal(await evaluate(browser, browser.worker, 'chrome.storage.local.get("_pendingUpdate").then(value=>value._pendingUpdate)'), '0.0.5');
      if (process.env.UPDATE_SCREENSHOT_DIR) {
        const image = await browser.cdp.send('Page.captureScreenshot', { format: 'png' }, settings.session);
        await writeFile(path.join(process.env.UPDATE_SCREENSHOT_DIR, 'update-ready.png'), Buffer.from(image.data, 'base64'));
        await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 850, deviceScaleFactor: 1, mobile: false }, settings.session);
        assert.equal(await evaluate(browser, settings.session, 'document.documentElement.scrollWidth <= innerWidth'), true);
        const narrow = await browser.cdp.send('Page.captureScreenshot', { format: 'png' }, settings.session);
        await writeFile(path.join(process.env.UPDATE_SCREENSHOT_DIR, 'update-ready-narrow.png'), Buffer.from(narrow.data, 'base64'));
      }
      const old = (await browser.cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(browser.origin));
      let dialog;
      const removeDialog = browser.cdp.on('Page.javascriptDialogOpening', (event, session) => { if (session === settings.session) dialog = event; });
      try {
        const updating = click(browser, settings, '#update-apply'); updating.catch(() => {});
        await eventually(() => dialog, 'explicit update confirmation');
        assert.equal(dialog.type, 'confirm');
        await browser.cdp.send('Page.handleJavaScriptDialog', { accept: true }, settings.session);
        await updating;
      } finally { removeDialog(); }
      const replacement = await eventually(async () => (await browser.cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === old.url && target.targetId !== old.targetId), 'replacement worker');
      const attached = await browser.cdp.send('Target.attachToTarget', { targetId: replacement.targetId, flatten: true });
      browser.worker = attached.sessionId;
      await browser.cdp.send('Runtime.enable', {}, browser.worker);
      await eventually(() => evaluate(browser, browser.worker, 'chrome.storage.local.get("_pendingUpdate").then(value=>!value._pendingUpdate)'), 'installed update clears pending state');
      assert.deepEqual(await evaluate(browser, site.session, '({token:documentToken,draft:document.querySelector("#draft").value,url:location.href})'), { token: 'same document', draft: 'Unsaved synthetic draft', url: 'https://x.com/home' });
      await browser.cdp.send('Target.activateTarget', { targetId: site.targetId });
      await waitForTracking(browser, site, scrolling);
      const before = await evaluate(browser, browser.worker, '(async()=>{const data=await chrome.storage.local.get(C3.localDate());return C3.aggregate(data[C3.localDate()]).consumeSec;})()');
      assert.ok(before > 0, 'partial measurements from before the update were saved');
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, site.session);
      await eventually(() => evaluate(browser, browser.worker, `(async()=>{const data=await chrome.storage.local.get(C3.localDate());return C3.aggregate(data[C3.localDate()]).consumeSec > ${before};})()`), 'fresh trusted input saves measurements after update');
    });
  } finally { await browser.cleanup(); }
});
