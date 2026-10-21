'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('agents discover site-specific actions and complete the existing access UI through accessibility names', async () => {
  const { launch, evaluate, eventually, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const inspect = (page, source) => evaluate(browser, page.session, source);
  const nodes = async page => (await browser.cdp.send('Accessibility.getFullAXTree', {}, page.session)).nodes.filter(node => !node.ignored);
  const find = async (page, role, name) => {
    const matches = (await nodes(page)).filter(node => node.role?.value === role && node.name?.value.trim().replace(/\s+/g, ' ') === name);
    assert.equal(matches.length, 1, `one ${role} named ${name}`);
    return matches[0];
  };
  const clickNamed = async (page, name) => {
    await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
    const node = await find(page, 'button', name);
    await browser.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendDOMNodeId }, page.session);
    const { model } = await browser.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId }, page.session);
    const x = model.content.filter((_, index) => index % 2 === 0).reduce((a, b) => a + b) / 4;
    const y = model.content.filter((_, index) => index % 2 === 1).reduce((a, b) => a + b) / 4;
    await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, page.session);
    await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, page.session);
  };
  try {
    await withFailureArtifacts(browser, 'agent accessibility journey', async () => {
      const popup = await browser.page(browser.origin + '/popup.html');
      await eventually(() => inspect(popup, 'document.querySelectorAll(".access-row button").length === 2'), 'popup loaded');
      for (const site of ['X', 'LinkedIn']) {
        const button = await find(popup, 'button', `Request access to ${site}`);
        assert.equal(button.description?.value, 'Blocked');
        await find(popup, 'group', `${site} access`);
      }
      await clickNamed(popup, 'Request access to LinkedIn');
      await eventually(async () => (await browser.cdp.send('Target.getTargets')).targetInfos.some(target => target.url === browser.origin + '/blocked.html?site=linkedin'), 'named action opens the matching site gate');
      const gate = await browser.page(browser.origin + '/blocked.html?site=x');
      await eventually(() => inspect(gate, '!document.querySelector("#begin").disabled'), 'gate loaded');
      await find(gate, 'form', 'Request access to X');
      const reason = await find(gate, 'textbox', 'What do you need to do?');
      assert.match(reason.description.value, /20–280/);
      await browser.cdp.send('DOM.focus', { backendNodeId: reason.backendDOMNodeId }, gate.session);
      await browser.cdp.send('Input.insertText', { text: 'Review the synthetic launch plan, then leave.' }, gate.session);
      await clickNamed(gate, 'Start the 60-second wait');
      await eventually(() => inspect(gate, '!document.querySelector("#waiting").hidden && !document.querySelector("#cancel").disabled'), 'waiting acknowledged');
      await find(gate, 'region', 'A little breathing room.');
      const openName = 'Open X for 5 active minutes';
      const open = await find(gate, 'button', openName);
      assert.equal(open.properties.find(property => property.name === 'disabled')?.value.value, true);
      await find(gate, 'status', 'Site access status');
      const state = await evaluate(browser, browser.worker, 'chrome.storage.local.get("_access")');
      await browser.setTime(state._access.x.readyAt + 100);
      await eventually(() => inspect(gate, '!document.querySelector("#open").disabled'), 'confirmation ready');
      assert.equal(await inspect(gate, 'location.pathname'), '/blocked.html', 'waiting never navigates automatically');
      await clickNamed(gate, openName);
      await eventually(() => inspect(gate, 'location.hostname === "x.com"'), 'named confirmation opens X');
      await eventually(async () => (await find(popup, 'button', 'End session for X')).description?.value.includes('left'), 'popup reflects active session');
      await clickNamed(popup, 'End session for X');
      await eventually(() => find(popup, 'button', 'Request access to X'), 'ended session is blocked again');
      const settings = await browser.page(browser.origin + '/settings.html');
      await eventually(() => inspect(settings, '!!document.querySelector("#track-x")'), 'settings loaded');
      const tracking = await find(settings, 'switch', 'Limit & track on X');
      assert.equal(tracking.properties.find(property => property.name === 'checked').value.value, 'true');
      await find(settings, 'switch', 'Remember my intentions');
      await find(settings, 'switch', 'Allow sites while above the daily goal');
      await find(settings, 'spinbutton', 'Session time for X');
      const dashboard = await browser.page(browser.origin + '/dashboard.html');
      await eventually(() => inspect(dashboard, '!document.querySelector("#export").disabled'), 'dashboard loaded');
      await find(dashboard, 'region', 'Creation score');
      await find(dashboard, 'button', 'Export activity CSV');
      await clickNamed(dashboard, 'Website time');
      await find(dashboard, 'region', 'Website time');
      assert.equal((await nodes(dashboard)).some(node => node.role?.value === 'region' && node.name?.value === 'Creation score'), false, 'hidden view is absent from accessibility tree');
    });
    assert.deepEqual(browser.errors, []);
  } finally { await browser.cleanup(); }
});
