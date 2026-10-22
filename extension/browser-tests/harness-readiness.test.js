'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

test('enabled-control readiness rejects absent, disabled and aria-disabled controls', async () => {
  const { launch, evaluate, waitForEnabledControl, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'enabled-control readiness', async () => {
      const page = await browser.page('about:blank');
      const ready = () => waitForEnabledControl(browser, page, '#control', 100);
      await assert.rejects(ready(), /Timed out: enabled control/);
      await evaluate(browser, page.session, 'document.body.innerHTML = \'<input id="control" disabled>\'');
      await assert.rejects(ready(), /Timed out: enabled control/);
      await evaluate(browser, page.session, 'document.querySelector("#control").disabled = false; document.querySelector("#control").setAttribute("aria-disabled", "true")');
      await assert.rejects(ready(), /Timed out: enabled control/);
      await evaluate(browser, page.session, 'document.querySelector("#control").removeAttribute("aria-disabled")');
      assert.equal(await ready(), true);
    });
  } finally { await browser.cleanup(); }
});

test('geometry diagnostic reports actual browser overflow without page content or identifiers', async () => {
  const { launch, evaluate, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'geometry-only diagnostic', async () => {
      const page = await browser.page('about:blank');
      await evaluate(browser, page.session, 'document.open(); document.write(\'<!doctype html><html><head><style>html,body{margin:0;height:100%}html{overflow:hidden}body{overflow:auto}</style></head><body><div id="SENSITIVE" style="height:20000px">SENSITIVE synthetic text</div></body></html>\'); document.close()');
      assert.equal(await evaluate(browser, page.session, 'document.compatMode'), 'CSS1Compat', 'geometry fixture must use standards mode');
      const source = readFileSync(path.resolve(__dirname, '../../bin/scroll-geometry.js'), 'utf8');
      const json = await evaluate(browser, page.session, source);
      const result = JSON.parse(json);
      assert.ok(result.nodes.some(node => node.root && node.tag === 'HTML' && node.overflowY === 'hidden'));
      assert.ok(result.nodes.some(node => node.tag === 'BODY' && node.overflowY === 'auto' && node.scrollHeight > node.clientHeight));
      assert.ok(!json.includes('SENSITIVE'));
      assert.ok(!json.includes('about:blank'));
    });
  } finally { await browser.cleanup(); }
});

test('scroll measurements reject missing targets and impossible fixture positions', async () => {
  const { launch, evaluate, withFailureArtifacts } = await import('./chromium.mjs');
  const { scrollFixture } = await import('./scrolling.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'scroll fixture reachability', async () => {
      const scroll = scrollFixture(browser);
      const page = await browser.page('about:blank');
      await evaluate(browser, page.session, 'document.body.innerHTML = \'<style>html,body{height:100%;margin:0;overflow:hidden}</style><div id="panel">Synthetic panel</div>\'');
      for (const selector of ['#missing', 'html', '#panel']) {
        await assert.rejects(scroll.distance(page, selector, 240), /fixture must reach scroll position 1000 before input/);
      }
    });
  } finally { await browser.cleanup(); }
});
