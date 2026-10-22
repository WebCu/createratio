import assert from 'node:assert/strict';
import { evaluate, eventually } from './chromium.mjs';

export function scrollFixture(browser) {
  const contexts = new Map();
  browser.cdp.on('Runtime.executionContextCreated', ({ context }, session) => {
    if (context.origin === browser.origin) contexts.set(session, context.id);
  });
  async function isEnabled(page) {
    if (!contexts.has(page.session)) return false;
    const { result } = await browser.cdp.send('Runtime.evaluate', { expression: 'document', contextId: contexts.get(page.session) }, page.session);
    try {
      const { listeners } = await browser.cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }, page.session);
      return listeners.some(listener => listener.type === 'wheel' && !listener.passive);
    } finally { await browser.cdp.send('Runtime.releaseObject', { objectId: result.objectId }, page.session); }
  }
  async function setEnabled(page, enabled) {
    await evaluate(browser, browser.worker, `(async () => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, scrollFrictionEnabled: ${JSON.stringify(enabled)} } });
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'refresh' }).catch(() => {})));
    })()`);
    await eventually(async () => await isEnabled(page) === enabled, `scroll resistance ${enabled ? 'enabled' : 'disabled'}`);
  }
  async function distance(page, selector, deltaY, point = { x: 400, y: 400 }) {
    const target = `document.querySelector(${JSON.stringify(selector)})`;
    const position = await evaluate(browser, page.session, `(() => {
      const target = ${target};
      if (!target) return null;
      target.scrollTop = 1000;
      return target.scrollTop;
    })()`);
    assert.equal(position, 1000, `${selector}: fixture must reach scroll position 1000 before input`);
    if (!point) point = await evaluate(browser, page.session, `(() => {
      const rect = ${target}.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY }, page.session);
    await eventually(() => evaluate(browser, page.session, `${target}.scrollTop !== 1000`), `${selector} moves after trusted wheel input`);
    return evaluate(browser, page.session, `(async () => {
      let previous = -1, stable = 0;
      for (let frame = 0; frame < 120 && stable < 5; frame++) {
        await new Promise(requestAnimationFrame);
        const next = ${target}.scrollTop;
        stable = next === previous ? stable + 1 : 0; previous = next;
      }
      if (stable < 5) throw new Error('Scroll position did not settle');
      return ${target}.scrollTop - 1000;
    })()`);
  }
  async function verify(page, targets) {
    const selectors = [...new Set(targets.flatMap(target => [target.selector, ...(target.stationary || [])]))];
    for (const target of targets) {
      await evaluate(browser, page.session, `(async () => {
        for (const selector of ${JSON.stringify(selectors)}) document.querySelector(selector).scrollTop = 0;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      for (const sign of [1, -1]) {
        assert.equal(await distance(page, target.selector, sign * 240, target.point), sign * target.distance, `${target.selector}: trusted wheel distance`);
        for (const selector of target.stationary || []) {
          assert.equal(await evaluate(browser, page.session, `document.querySelector(${JSON.stringify(selector)}).scrollTop`), 0, `${selector} stays stationary while ${target.selector} scrolls`);
        }
      }
    }
  }
  async function assertNative(page, targets) {
    await setEnabled(page, false);
    await verify(page, targets.map(target => ({ ...target, distance: 240 })));
  }
  return { isEnabled, setEnabled, distance, verify, assertNative };
}
