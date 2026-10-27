'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { access, readFile } = require('node:fs/promises');
const path = require('node:path');

test('built Chromium extension: access gates and history controls', async t => {
  const { launch, evaluate, eventually, click, withFailureArtifacts, openSettingsSection } = await import('./chromium.mjs');
  const extension = path.resolve(__dirname, '../../dist/chrome');
  await access(path.join(extension, 'manifest.json'));
  const browser = await launch(extension);
  const { cdp } = browser;
  const inspect = (page, source) => evaluate(browser, page.session, source);
  const storage = () => evaluate(browser, browser.worker, 'chrome.storage.local.get(null)');
  const navigate = (page, url) => cdp.send('Page.navigate', { url }, page.session);
  const atGate = page => eventually(() => inspect(page, `location.href === ${JSON.stringify(browser.origin + '/blocked.html?site=x')} && !document.querySelector('#begin')?.disabled`), 'actual blocked-page redirect');
  const visible = (page, selector) => inspect(page, `!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const text = (page, selector) => inspect(page, `document.querySelector(${JSON.stringify(selector)})?.textContent`);
  const expectText = (page, selector, expected) => eventually(async () => await text(page, selector) === expected, `${selector} displays ${expected}`);
  const journey = (name, run) => t.test(name, () => withFailureArtifacts(browser, name, run));
  const focused = page => inspect(page, '({ id: document.activeElement.id, tag: document.activeElement.tagName, hasFocus: document.hasFocus() })');
  const key = async (page, key, code, windowsVirtualKeyCode) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(key === 'Enter' ? { text: '\r' } : {}) }, page.session);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode }, page.session);
  };
  const tabTo = async (page, id) => {
    await cdp.send('Target.activateTarget', { targetId: page.targetId });
    await eventually(async () => (await focused(page)).hasFocus, 'keyboard page focus');
    for (let count = 0; count < 12; count++) {
      if ((await focused(page)).id === id) return;
      await key(page, 'Tab', 'Tab', 9);
    }
    assert.fail(`Keyboard could not reach ${id}: ${JSON.stringify(await focused(page))}`);
  };
  try {
    const version = await cdp.send('Browser.getVersion');
    assert.match(version.product, /Chrom(e|ium)\//);
    const midday = new Date();
    midday.setHours(12, 0, 0, 0);
    midday.setDate(midday.getDate() + 1);
    await browser.setTime(midday.getTime());
    await evaluate(browser, browser.worker, 'chrome.storage.local.set({ settings: { accessMinutes: 1, intentionHistoryEnabled: true, trackedSites: ["x", "linkedin"], allowAboveGoal: false } })');
    await journey('intention, persistent 60-second pause, explicit unlock, pause and manual end', async () => {
      const page = await browser.page('https://x.com/home');
      await atGate(page);
      assert.equal(browser.documents.length, 0, 'DNR redirects before any synthetic X document is served');
      assert.equal((await focused(page)).tag, 'BODY', 'initial loading must not steal focus');
      await tabTo(page, 'reason');
      await cdp.send('Input.insertText', { text: 'Review the synthetic launch plan, then leave.' }, page.session);
      assert.equal(await inspect(page, 'document.querySelector("#reason").value'), 'Review the synthetic launch plan, then leave.');
      await tabTo(page, 'begin'); await key(page, 'Enter', 'Enter', 13);
      await eventually(() => visible(page, '#waiting'), 'waiting UI');
      await eventually(() => inspect(page, '!document.querySelector("#cancel").disabled'), 'begin acknowledged');
      assert.deepEqual(await focused(page), { id: 'waiting-title', tag: 'H2', hasFocus: true });
      await tabTo(page, 'cancel'); await key(page, 'Enter', 'Enter', 13);
      await eventually(() => inspect(page, '!document.querySelector("#request").hidden && !document.querySelector("#reason").disabled'), 'cancel acknowledged and intention enabled');
      assert.equal((await focused(page)).id, 'reason');
      assert.equal(await inspect(page, 'document.querySelector("#reason").value'), '');
      await cdp.send('Input.insertText', { text: 'Review the synthetic launch plan, then leave.' }, page.session);
      await tabTo(page, 'begin'); await key(page, 'Enter', 'Enter', 13);
      await eventually(() => visible(page, '#waiting'), 'second waiting UI');
      await eventually(() => inspect(page, '!document.querySelector("#cancel").disabled'), 'second begin acknowledged');
      assert.equal((await focused(page)).id, 'waiting-title');
      const started = await storage();
      const request = started._access.x;
      assert.equal(started._intentions.at(-1).reason, 'Review the synthetic launch plan, then leave.');
      assert.equal(request.readyAt - started._intentions.at(-1).requestedAt, 60000, 'real access-begin creates a full 60-second wait');
      assert.equal(request.requestExpiresAt - request.readyAt, 600000);
      assert.equal(await inspect(page, 'document.querySelector("#open").disabled'), true);
      await cdp.send('Page.reload', {}, page.session);
      await eventually(() => visible(page, '#waiting'), 'waiting survives reload');
      assert.equal((await storage())._access.x.readyAt, request.readyAt);
      assert.equal((await focused(page)).tag, 'BODY', 'restoring a wait on load must not move focus');
      await tabTo(page, 'cancel');
      await browser.setTime(request.readyAt - 5000);
      await eventually(() => inspect(page, 'document.querySelector("#clock").textContent !== "1:00" && document.querySelector("#open").disabled'), 'clock advances but access is still disabled before readiness');
      assert.equal(await inspect(page, 'document.querySelector("#open").disabled'), true);
      await browser.setTime(request.readyAt + 100);
      await eventually(() => inspect(page, '!document.querySelector("#open").disabled'), 'explicit confirmation becomes available');
      assert.equal((await focused(page)).id, 'cancel', 'countdown, refresh and readiness must preserve the chosen control');
      const probe = await browser.page('https://www.twitter.com/home');
      await atGate(probe);
      assert.equal(browser.documents.length, 0, 'waiting alone still blocks X and its alias');
      await cdp.send('Target.activateTarget', { targetId: page.targetId });
      await tabTo(page, 'open'); await key(page, 'Enter', 'Enter', 13);
      await eventually(() => inspect(page, 'location.href === "https://x.com/home" && !!document.querySelector("#synthetic-site")'), 'explicit confirmation opens the intercepted real-host page');
      assert.deepEqual(browser.documents, ['https://x.com/home']);
      const running = await eventually(async () => {
        const entry = (await storage())._access.x;
        return entry?.expiresAt > 0 && entry.remainingMs > 0 && entry;
      }, 'focused site spends access budget');
      assert.ok(running.remainingMs <= 60000 && running.remainingMs > 0);
      const popup = await browser.page(browser.origin + '/popup.html');
      await expectText(popup, '.access-row button', 'End session');
      const paused = await eventually(async () => {
        const entry = (await storage())._access.x;
        return entry?.remainingMs > 0 && entry.expiresAt === 0 && entry;
      }, 'access budget pauses away from X');
      await browser.setTime(await inspect(popup, 'Date.now()') + 10000);
      await expectText(popup, '.access-row button', 'End session');
      assert.equal((await storage())._access.x.remainingMs, paused.remainingMs, 'off-site test clock advance does not spend paused access');
      await click(browser, popup, '.access-row button');
      await atGate(page);
      assert.equal((await storage())._access.x, undefined);
      const served = browser.documents.length;
      await navigate(page, 'https://x.com/home');
      await atGate(page);
      assert.equal(browser.documents.length, served, 'manual end removes DNR allow rule, not just the currently open tab');
      await expectText(popup, '.access-row button', 'Request access');
      console.log('Access tracer: DNR block → 60-second clock → explicit trusted confirm → synthetic X → paused budget → trusted manual end → DNR block');
    });
    await journey('keyboard ending an active session restores the intention without load-time focus stealing', async () => {
      const page = await browser.page(browser.origin + '/blocked.html?site=x');
      await atGate(page);
      const date = await inspect(page, 'new Date().toLocaleDateString("en-CA")');
      await evaluate(browser, browser.worker, `chrome.storage.local.set({ _access: { x: { remainingMs: 60000, expiresAt: 0, date: ${JSON.stringify(date)} } } })`);
      await eventually(() => visible(page, '#active'), 'synthetic active session appears after storage refresh');
      assert.equal((await focused(page)).tag, 'BODY', 'storage refresh must not move focus');
      await tabTo(page, 'end'); await key(page, 'Enter', 'Enter', 13);
      await eventually(() => inspect(page, '!document.querySelector("#request").hidden && !document.querySelector("#reason").disabled'), 'end acknowledged and intention enabled');
      assert.equal((await focused(page)).id, 'reason');
      assert.equal(await inspect(page, 'document.querySelector("#reason").value'), '');
      assert.equal((await storage())._access.x, undefined);
    });
    await journey('controlled active budget expiry redirects and reblocks', async () => {
      const popup = await browser.page(browser.origin + '/popup.html');
      const date = await inspect(popup, 'new Date().toLocaleDateString("en-CA")');
      await evaluate(browser, browser.worker, `chrome.storage.local.set({ _access: { x: { remainingMs: 300000, expiresAt: 0, date: ${JSON.stringify(date)} } } })`);
      await expectText(popup, '.access-row button', 'End session');
      const page = await browser.page('https://x.com/home');
      await eventually(() => visible(page, '#synthetic-site'), 'synthetic expiry fixture opens through real DNR allow');
      const running = await eventually(async () => {
        const entry = (await storage())._access.x;
        return entry?.expiresAt > 0 && entry;
      }, 'expiry fixture is actively timed');
      await browser.setTime(running.expiresAt + 100);
      await atGate(page);
      const served = browser.documents.length;
      await navigate(page, 'https://x.com/home');
      await atGate(page);
      assert.equal(browser.documents.length, served, 'expiry removes DNR allow rule');
      console.log('Expiry tracer: synthetic budget + controlled Date clock; production guard/worker revoke actual navigation');
    });
    await journey('cancel/confirm Clear history updates dashboard and actual downloaded CSV, preserving settings, access and intentions', async () => {
      const settings = await browser.page(browser.origin + '/settings.html');
      await eventually(() => visible(settings, '#accessMinutes-default'), 'Settings rendered');
      const date = await inspect(settings, 'new Date().toLocaleDateString("en-CA")');
      const preferences = { accessMinutes: 12, dailyTarget: 1.4, trackedSites: ['x', 'linkedin'], siteOverrides: { x: { accessMinutes: 7 } }, intentionHistoryEnabled: true, allowAboveGoal: false };
      const intentions = [{ site: 'x', reason: 'Synthetic intention retained after clearing activity.', requestedAt: await inspect(settings, 'Date.now()') }];
      const session = { linkedin: { remainingMs: 180000, expiresAt: 0, date } };
      const fixture = { settings: preferences, _intentions: intentions, _access: session, [date]: { x: { createSec: 60, consumeSec: 120, posts: 2, replies: 0, comments: 0, likes: 1, bookmarks: 0, quotes: 0, reposts: 0 } }, ['_websiteTime:' + date]: { 'synthetic.example': 180 } };
      await evaluate(browser, browser.worker, `chrome.storage.local.set(${JSON.stringify(fixture)})`);
      await eventually(() => inspect(settings, 'document.querySelector("#accessMinutes-default").value === "12" && document.querySelector("#accessMinutes-site-x").value === "7" && document.querySelector("#intention-history-enabled").checked'), 'fixture preferences visible');
      const dashboard = await browser.page(browser.origin + '/dashboard.html');
      const ratio = async populated => {
        await click(browser, dashboard, '#ratio-view');
        await expectText(dashboard, '#create-min', populated ? '1.0m' : '0.0m');
        await expectText(dashboard, '#consume-min', populated ? '2.0m' : '0.0m');
        await expectText(dashboard, '#posts', populated ? '2' : '0');
        await expectText(dashboard, '#score', populated ? '2.50' : '0.00');
      };
      const websites = async populated => {
        await click(browser, dashboard, '#websites-view');
        await expectText(dashboard, '#website-total', populated ? '3m 0s' : '0s');
        await expectText(dashboard, '#website-count', populated ? '1 website' : '0 websites');
        assert.equal(await visible(dashboard, '#website-empty'), !populated);
        assert.equal((await text(dashboard, '#website-sites')).includes('synthetic.example'), populated);
      };
      const keptIntentions = async () => {
        await click(browser, dashboard, '#intentions-view');
        await eventually(async () => (await text(dashboard, '#intention-list')).includes(intentions[0].reason), 'intentions remain visibly reviewable');
      };
      await ratio(true);
      await websites(true);
      await keptIntentions();
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: browser.directory, eventsEnabled: true });
      const download = async (selector, filename) => {
        await openSettingsSection(browser, settings, 'data');
        let guid, done = false;
        const removeBegin = cdp.on('Browser.downloadWillBegin', event => {
          assert.equal(event.suggestedFilename, filename);
          guid = event.guid;
        });
        const removeProgress = cdp.on('Browser.downloadProgress', event => { if (event.guid === guid && event.state === 'completed') done = true; });
        try {
          await cdp.send('Target.activateTarget', { targetId: settings.targetId });
          await click(browser, settings, selector);
          await eventually(() => done, `actual CSV download ${filename}`);
          return await readFile(path.join(browser.directory, guid), 'utf8');
        } finally { removeBegin(); removeProgress(); }
      };
      const exported = async populated => {
        const ratioCSV = await download('#export-ratio', `CreateRatio-${date}.csv`);
        const websiteCSV = await download('#export-websites', `CreateRatio-websites-${date}.csv`);
        assert.equal(ratioCSV.split('\r\n')[0], 'date,site,consumeSec,createSec,posts,replies,comments,likes,bookmarks,quotes,reposts,score');
        assert.equal(websiteCSV.split('\r\n')[0], 'date,domain,seconds');
        if (populated) {
          assert.ok(ratioCSV.includes(`${date},x,120.000,60.000,2,0,0,1,0,0,0,2.500`));
          assert.ok(websiteCSV.includes(`${date},"synthetic.example",180.000`));
        } else {
          assert.equal(ratioCSV.split('\r\n').length, 2, 'cleared activity exports header only');
          assert.equal(websiteCSV.split('\r\n').length, 2, 'cleared website time exports header only');
        }
        assert.ok(!ratioCSV.includes(intentions[0].reason) && !websiteCSV.includes(intentions[0].reason));
      };
      await exported(true);
      const clear = async accept => {
        let dialog;
        const remove = cdp.on('Page.javascriptDialogOpening', (event, sessionId) => { if (sessionId === settings.session) dialog = event; });
        try {
          await cdp.send('Target.activateTarget', { targetId: settings.targetId });
          const clicking = click(browser, settings, '#clear-history');
          clicking.catch(() => {});
          await eventually(() => dialog, 'native Clear history confirmation');
          assert.equal(dialog.type, 'confirm');
          assert.match(dialog.message, /Delete all recorded activity and website time.*cannot be undone/);
          await cdp.send('Page.handleJavaScriptDialog', { accept }, settings.session);
          await clicking;
        } finally { remove(); }
      };
      const before = await storage();
      await clear(false);
      assert.deepEqual(await storage(), before, 'native cancellation leaves all storage unchanged');
      await ratio(true);
      await websites(true);
      await keptIntentions();
      await exported(true);
      await clear(true);
      await expectText(settings, '#save-status', 'History cleared. Your settings and site access boundaries are unchanged.');
      await ratio(false);
      await websites(false);
      await keptIntentions();
      const after = await storage();
      assert.equal(after[date], undefined);
      assert.equal(after['_websiteTime:' + date], undefined);
      assert.deepEqual(after.settings, preferences);
      assert.deepEqual(after._intentions, intentions);
      assert.deepEqual(after._access, session);
      assert.notEqual(after._historyGeneration, before._historyGeneration);
      await exported(false);
      assert.equal(await inspect(settings, 'document.querySelector("#clear-history").disabled'), false);
      console.log('History tracer: visible fixture + downloaded CSV → native cancel preserves → native confirm empties dashboard/CSV, retains preferences/access/intentions');
    });
    assert.deepEqual(browser.errors, [], 'network interception and target setup must not fail silently');
  } catch (error) {
    await withFailureArtifacts(browser, 'browser journey setup or teardown', async () => { throw error; });
  } finally { await browser.cleanup(); }
});
