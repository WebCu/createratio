import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, evaluate, eventually, clickByRole, withFailureArtifacts } from '../extension/browser-tests/chromium.mjs';
import marketing from './marketing.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist/marketing');
const bundle = join(root, 'dist/chrome');
const release = marketing.readRelease();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function inventory(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await inventory(join(directory, entry.name), name + '/'));
    else if (entry.isFile()) files[name] = digest(await readFile(join(directory, entry.name)));
    else throw new Error('The generated bundle must contain only regular files and directories.');
  }
  return files;
}

await mkdir(output, { recursive: true });
marketing.writeKit(output, release);
const temporary = await mkdtemp(join(output, '.screenshots-'));
const profileBundle = await mkdtemp(join(tmpdir(), 'createratio-marketing-'));
let browser;
try {
  const bundleHashes = await inventory(bundle);
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
  await cp(bundle, join(profileBundle, 'chrome'), { recursive: true });
  browser = await launch(join(profileBundle, 'chrome'));
  await browser.setTime(new Date(2026, 2, 9, 12).getTime());
  await evaluate(browser, browser.worker, `(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, trackedSites: ['x', 'linkedin', 'tiktok', 'instagram'], allowAboveGoal: false, intentionHistoryEnabled: false }, _websiteTimeEnabled: false,
      [C3.localDate()]: {
        x: { createSec: 900, consumeSec: 600, posts: 1 },
        linkedin: { createSec: 900, consumeSec: 600, comments: 1 },
        instagram: { createSec: 600, consumeSec: 480, comments: 1 },
        tiktok: { createSec: 480, consumeSec: 240, comments: 1 }
      }
    });
    await SiteAccess.reconcile();
  })()`);
  const page = await browser.page('about:blank');
  await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page.session);
  await browser.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, page.session);
  await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'Math.random = () => 0;' }, page.session);
  const inspect = source => evaluate(browser, page.session, source);
  const open = async (url, ready) => {
    await browser.cdp.send('Page.navigate', { url: browser.origin + url }, page.session);
    await eventually(() => inspect(`document.readyState === 'complete' && document.querySelector('#error')?.hidden && (${ready})`), url + ' ready for capture');
    await inspect('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
  };
  const captures = [];
  const capture = async index => {
    assert.equal(await inspect('document.documentElement.scrollWidth <= innerWidth'), true, 'Screenshot must not overflow horizontally.');
    const { data } = await browser.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page.session);
    const bytes = Buffer.from(data, 'base64');
    assert.equal(bytes.readUInt32BE(16), 1280);
    assert.equal(bytes.readUInt32BE(20), 800);
    const filename = release.screenshots[index].id + '.png';
    await writeFile(join(temporary, filename), bytes);
    captures.push({ filename, caption: release.screenshots[index].caption, sha256: digest(bytes), width: 1280, height: 800 });
  };
  await open('/settings.html', 'document.querySelectorAll("#site-settings input:checked").length === 4');
  await capture(0);
  await open('/blocked.html?site=instagram', '!document.querySelector("#begin").disabled && !document.querySelector("#request").hidden && document.title === "Instagram blocked - CreateRatio"');
  await clickByRole(browser, page, 'textbox', 'What do you need to do?');
  await browser.cdp.send('Input.insertText', { text: 'Share the photos from my latest project.' }, page.session);
  await capture(1);
  await open('/dashboard.html', 'document.querySelectorAll("#sites tr").length === 4 && document.querySelector("#create-min").textContent === "48.0m"');
  await capture(2);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(await inventory(bundle), bundleHashes, 'Bundle changed during capture.');
  assert.equal(marketing.releaseFingerprint(marketing.readRelease()), marketing.releaseFingerprint(release), 'Release copy changed during capture.');
  await writeFile(join(temporary, 'manifest.json'), JSON.stringify({
    version: manifest.version, browser: await browser.cdp.send('Browser.getVersion'),
    releaseSHA256: marketing.releaseFingerprint(release), synthetic: true,
    note: 'Actual Chrome build in a disposable offline profile. Instagram and TikTok enabled for demonstration; both start Off. Not Firefox validation.',
    bundleSHA256: bundleHashes, screenshots: captures
  }, null, 2) + '\n');
  await rm(join(output, 'screenshots'), { recursive: true, force: true });
  await rename(temporary, join(output, 'screenshots'));
  console.log(`Store screenshots: ${join(output, 'screenshots')} (1280 × 800 PNG, synthetic data, no uploads)`);
} catch (error) {
  if (browser) await withFailureArtifacts(browser, 'marketing screenshot generation', async () => { throw error; });
  throw error;
} finally {
  await browser?.cleanup();
  await rm(temporary, { recursive: true, force: true });
  await rm(profileBundle, { recursive: true, force: true });
}
