import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { scrollFixture } from './scrolling.mjs';

export async function platformJourney(platform) {
    const { launch, evaluate, eventually, click, clickByRole, withFailureArtifacts } = await import('./chromium.mjs');
    const browser = await launch(fileURLToPath(new URL('../../dist/chrome', import.meta.url)));
    try {
      await withFailureArtifacts(browser, `${platform.id} tracking and scroll resistance`, async () => {
        const id = JSON.stringify(platform.id);
        const metadata = await evaluate(browser, browser.worker, `C3.SITES.find(site => site.id === ${id})`);
        assert.ok(metadata, `${platform.name} must be registered in the built catalog`);
        assert.equal(metadata.defaultEnabled, false);
        assert.equal(metadata.gated, false);
        assert.deepEqual(metadata.hosts, [platform.id + '.com', 'www.' + platform.id + '.com']);
        await evaluate(browser, browser.worker, `globalThis.platformSnapshots = 0;
          chrome.runtime.onMessage.addListener((message, sender) => {
            if (message.type === 'snapshot' && sender.url?.startsWith(${JSON.stringify(new URL(platform.url).origin + '/')})) platformSnapshots++;
          });`);
        const totals = () => evaluate(browser, browser.worker, `chrome.storage.local.get(C3.localDate()).then(data => data[C3.localDate()]?.[${id}] || {})`);
        const scrolling = scrollFixture(browser);
        const settings = await browser.page(browser.origin + '/settings.html');
        const toggle = '#track-' + platform.id;
        await eventually(() => evaluate(browser, settings.session, `document.querySelector(${JSON.stringify(toggle)})?.disabled === false`), 'Settings tracking switch ready');
        assert.equal(await evaluate(browser, settings.session, `document.querySelector(${JSON.stringify(toggle)}).checked`), false);
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-enabled").checked'), true);
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-strength").value'), '50');
        const page = await browser.page(platform.url);
        await eventually(() => evaluate(browser, page.session, '!!document.querySelector("#synthetic-site") && document.readyState === "complete" && document.hasFocus()'), 'offline real-host fixture ready');
        await eventually(() => evaluate(browser, browser.worker, 'platformSnapshots > 0'), 'built tracker read default Off preferences');
        const markup = '<style>html{scroll-behavior:auto}body{margin:0;min-height:20000px}#composer{display:block;position:fixed;top:25px;left:25px;width:380px;padding:20px;background:white;border:1px solid}textarea,[contenteditable="true"]{display:block;box-sizing:border-box;width:340px;min-height:80px;border:1px solid}button{min-height:42px;margin-top:12px}</style><h1>Offline synthetic feed</h1>' + platform.markup;
        await evaluate(browser, page.session, `document.body.innerHTML = ${JSON.stringify(markup)}`);
        const listenerEnabled = () => scrolling.isEnabled(page);
        async function activatePage() {
          await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
          await eventually(() => evaluate(browser, page.session, 'document.hasFocus() && !document.hidden'), 'fixture foregrounded');
        }
        const wheel = delta => scrolling.distance(page, 'html', delta, { x: 700, y: 400 });
        assert.equal(await listenerEnabled(), false);
        assert.equal(await wheel(240), 240, 'default Off scrolls natively');
        assert.equal(await wheel(-240), -240);
        await click(browser, page, '#submit-comment');
        assert.equal((await totals()).comments || 0, 0, 'default Off cannot record a submit');
        await clickByRole(browser, settings, 'switch', 'Track creating & consuming on ' + platform.name);
        await eventually(() => evaluate(browser, settings.session, `document.querySelector(${JSON.stringify(toggle)}).checked && !document.querySelector(${JSON.stringify(toggle)}).disabled && document.querySelector('#save-status').textContent.includes('Your history is kept.')`), 'tracking enabled through Settings');
        await activatePage();
        await eventually(listenerEnabled, 'enabled consuming feed has scroll resistance');
        assert.equal(await wheel(240), 120, '50% resistance halves a 240px wheel');
        assert.equal(await wheel(-240), -120);
        await click(browser, settings, 'label[for="scroll-friction-strength"]');
        await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 }, settings.session);
        await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 }, settings.session);
        await eventually(() => evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-strength").value === "95" && document.querySelector("#save-status").textContent.includes("saved at 95%")'), '95% resistance saved through Settings');
        await activatePage();
        await eventually(listenerEnabled, '95% resistance remains active');
        assert.equal(await wheel(240), 12, '95% resistance leaves 12px of a 240px wheel');
        assert.equal(await wheel(-240), -12);
        await click(browser, page, platform.editor);
        await browser.cdp.send('Input.insertText', { text: 'Synthetic local comment; never sent to a service.' }, page.session);
        await eventually(() => evaluate(browser, page.session, `document.activeElement.matches(${JSON.stringify(platform.editor)})`), 'actual site-specific comment editor focused');
        await eventually(async () => !await listenerEnabled(), 'focused writing releases scroll resistance');
        assert.equal(await wheel(240), 240, 'writing scrolls natively');
        await eventually(async () => (await totals()).createSec > 0, 'focused editor saves creation time');
        assert.equal((await totals()).comments || 0, 0, 'opening and writing a composer earns no submit bonus');
        await click(browser, page, '#submit-comment');
        await eventually(async () => (await totals()).comments === 1, 'trusted button click records exactly one comment');
        await eventually(listenerEnabled, 'leaving the editor restores feed resistance');
        await evaluate(browser, page.session, `document.activeElement.blur(); history.pushState({}, '', ${JSON.stringify(platform.neutral)});`);
        await eventually(async () => !await listenerEnabled(), 'unsupported messaging/settings route releases resistance');
        assert.equal(await wheel(240), 240, 'unsupported route scrolls natively');
        await click(browser, page, '#submit-comment');
        await evaluate(browser, page.session, `history.pushState({}, '', ${JSON.stringify(new URL(platform.url).pathname + new URL(platform.url).search)})`);
        await eventually(listenerEnabled, 'returning to feed restores resistance');
        assert.equal((await totals()).comments, 1, 'unsupported route cannot submit comments');
        await clickByRole(browser, settings, 'switch', 'Track creating & consuming on ' + platform.name);
        await eventually(() => evaluate(browser, settings.session, `!document.querySelector(${JSON.stringify(toggle)}).checked && !document.querySelector(${JSON.stringify(toggle)}).disabled && document.querySelector('#save-status').textContent.includes('Your history is kept.')`), 'tracking disabled through Settings');
        await activatePage();
        await eventually(async () => !await listenerEnabled(), 'Off removes scroll resistance');
        const retained = await totals();
        assert.equal(retained.comments, 1, 'Off retains the submitted comment');
        assert.ok(retained.createSec > 0, 'Off retains writing time');
        assert.equal(await wheel(240), 240, 'Off restores native distance');
        assert.equal(await wheel(-240), -240);
        await click(browser, page, platform.editor);
        await browser.cdp.send('Input.insertText', { text: ' Disabled tracking stays local.' }, page.session);
        await click(browser, page, '#submit-comment');
        await browser.cdp.send('Target.activateTarget', { targetId: settings.targetId });
        await evaluate(browser, settings.session, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        assert.deepEqual(await totals(), retained, 'Off prevents new measurements without erasing history');
        assert.equal(browser.documents.every(url => metadata.hosts.includes(new URL(url).hostname)), true);
        assert.deepEqual(browser.errors, []);
      });
    } finally { await browser.cleanup(); }
}
