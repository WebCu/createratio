'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');

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

test('a prepared extension reload preserves website drafts and resumes tracking in the same document', async () => {
  const { launch, evaluate, eventually, click, seedAccess, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'), { developerMode: true });
  try {
    await withFailureArtifacts(browser, 'safe extension update', async () => {
      await seedAccess(browser, ['x']);
      const site = await browser.page('https://x.com/home');
      await eventually(() => evaluate(browser, site.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'website ready');
      await eventually(() => evaluate(browser, browser.worker, '(async()=>{const [tab]=await chrome.tabs.query({url:"https://x.com/home"});return (await chrome.tabs.sendMessage(tab.id,{type:"prepare-update",force:true})).ready;})()'), 'initial tracking preferences acknowledged');
      await evaluate(browser, browser.worker, '(async()=>{const [tab]=await chrome.tabs.query({url:"https://x.com/home"});await chrome.tabs.sendMessage(tab.id,{type:"resume-update"});})()');
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
      await eventually(() => evaluate(browser, browser.worker, '(async()=>{const [tab]=await chrome.tabs.query({url:"https://x.com/home"});return (await chrome.tabs.sendMessage(tab.id,{type:"prepare-update",force:true})).ready;})()'), 'new content scripts answer in the existing tab');
      await evaluate(browser, browser.worker, '(async()=>{const [tab]=await chrome.tabs.query({url:"https://x.com/home"});await chrome.tabs.sendMessage(tab.id,{type:"resume-update"});})()');
      const before = await evaluate(browser, browser.worker, '(async()=>{const data=await chrome.storage.local.get(C3.localDate());return C3.aggregate(data[C3.localDate()]).consumeSec;})()');
      assert.ok(before > 0, 'partial measurements from before the update were saved');
      await browser.cdp.send('Target.activateTarget', { targetId: site.targetId });
      await eventually(() => evaluate(browser, site.session, 'document.hasFocus()'), 'original tab foregrounded');
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, site.session);
      await eventually(() => evaluate(browser, browser.worker, `(async()=>{const data=await chrome.storage.local.get(C3.localDate());return C3.aggregate(data[C3.localDate()]).consumeSec > ${before};})()`), 'fresh trusted input saves measurements after update');
    });
  } finally { await browser.cleanup(); }
});
