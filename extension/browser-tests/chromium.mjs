import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import integrations from '../sites/index.js';

const syntheticHosts = new Set([...integrations.sites.flatMap(site => site.hosts), 'twitter.com', 'www.twitter.com']);

export async function eventually(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error.fatal) throw error;
      last = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}

const artifactRoot = () => process.env.BROWSER_ARTIFACT_DIR || join(process.cwd(), 'dist/browser-artifacts');

export async function withFailureArtifacts(browser, name, run, root = artifactRoot()) {
  try { return await run(); }
  catch (error) {
    try {
      await mkdir(root, { recursive: true });
      const directory = await mkdtemp(join(root, 'failure-'));
      const report = {
        name, error: { name: error.name, message: error.message, stack: error.stack },
        environment: { node: process.version, platform: process.platform, architecture: process.arch, executable: browser.executable },
        stderr: browser.stderr, events: browser.events || [], errors: (browser.errors || []).map(value => value.stack || String(value)),
        diagnosticErrors: [], pages: []
      };
      const collect = async (label, operation) => {
        let timer;
        try {
          return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic deadline exceeded')), 1500); })]);
        } catch (failure) { report.diagnosticErrors.push(`${label}: ${failure.message}`); }
        finally { clearTimeout(timer); }
      };
      if (browser.cdp) {
        report.version = await collect('browser version', () => browser.cdp.send('Browser.getVersion'));
        report.targets = await collect('targets', () => browser.cdp.send('Target.getTargets'));
        if (browser.worker) report.state = await collect('extension state', () => evaluate(browser, browser.worker, '(async () => ({ now: Date.now(), offset: globalThis.__browserSmokeOffset, storage: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null), sessionRules: await chrome.declarativeNetRequest.getSessionRules(), alarms: await chrome.alarms.getAll(), tabs: await chrome.tabs.query({}) }))()'));
        for (const [index, page] of (browser.pages || []).entries()) {
          const prefix = `page-${index + 1}`;
          const document = await collect(`${prefix} document`, () => evaluate(browser, page.session, `({
            url: location.href, title: document.title, now: Date.now(), offset: globalThis.__browserSmokeOffset, readyState: document.readyState, visibility: document.visibilityState, focused: document.hasFocus(),
            html: document.documentElement.outerHTML, text: document.body?.innerText,
            controls: [...document.querySelectorAll('button, input, textarea')].map(element => ({ id: element.id, text: element.textContent, disabled: element.disabled, rect: element.getBoundingClientRect().toJSON() }))
          })`));
          const { html, ...details } = document || {};
          report.pages.push({ targetId: page.targetId, ...details });
          if (html) await collect(`${prefix} HTML`, () => writeFile(join(directory, `${prefix}.html`), html));
          const screenshot = await collect(`${prefix} screenshot`, () => browser.cdp.send('Page.captureScreenshot', { format: 'png' }, page.session));
          if (screenshot) await collect(`${prefix} PNG`, () => writeFile(join(directory, `${prefix}.png`), Buffer.from(screenshot.data, 'base64')));
        }
      }
      await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
      console.error(`Browser failure evidence: ${directory}`);
    } catch (failure) { console.error(`Browser failure evidence could not be saved: ${failure.message}`); }
    throw error;
  }
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
        else request.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params, message.sessionId);
      }
    });
    socket.addEventListener('close', () => this.close());
  }
  on(method, listener) {
    const listeners = this.listeners.get(method) || new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Chromium CDP connection closed'));
    }
    this.pending.clear();
    this.socket.close();
  }
}

const clockSource = offset => `(() => {
  globalThis.__browserSmokeOffset = ${offset};
  if (globalThis.__browserSmokeNativeDate) return;
  const NativeDate = globalThis.Date;
  globalThis.__browserSmokeNativeDate = NativeDate;
  globalThis.Date = new Proxy(NativeDate, {
    apply: () => new NativeDate(NativeDate.now() + globalThis.__browserSmokeOffset).toString(),
    construct: (target, args) => Reflect.construct(target, args.length ? args : [NativeDate.now() + globalThis.__browserSmokeOffset]),
    get: (target, key) => key === 'now' ? () => NativeDate.now() + globalThis.__browserSmokeOffset : Reflect.get(target, key)
  });
})()`;

const inputTraceSource = `document.addEventListener('click', event => {
  const target = event.target?.closest?.('button, input, textarea, a') || event.target;
  console.debug('browser-test-input', JSON.stringify({
    id: target?.id, tag: target?.tagName, trusted: event.isTrusted, x: event.clientX, y: event.clientY,
    rect: target?.getBoundingClientRect?.().toJSON(), scrollX, scrollY, width: innerWidth, height: innerHeight
  }));
}, true);`;

export function extensionWorkerURL(extensionPath, manifest) {
  const identity = manifest.key ? Buffer.from(manifest.key, 'base64') : Buffer.from(resolve(extensionPath));
  const id = createHash('sha256').update(identity).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
  return `chrome-extension://${id}/${manifest.background.service_worker}`;
}

export function workerTarget(targets, url) {
  const matches = targets.filter(target => target.type === 'service_worker' && target.url === url);
  if (matches.length > 1) throw Object.assign(new Error('Multiple extension workers match the generated manifest'), { fatal: true });
  return matches[0];
}

export function devToolsEndpoint(contents) {
  const [port, path] = contents.trim().split(/\r?\n/);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  if (!/^\/devtools\/browser\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(path ?? '')) return null;
  return `ws://127.0.0.1:${port}${path}`;
}

export async function launch(extensionPath) {
  extensionPath = resolve(extensionPath);
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  const workerURL = extensionWorkerURL(extensionPath, manifest);
  const directory = await mkdtemp(join(tmpdir(), 'createratio-browser-'));
  const executable = process.env.CHROMIUM_PATH || process.env.CHROMIUM || '/usr/bin/chromium';
  const args = [
    `--user-data-dir=${join(directory, 'profile')}`, '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', '--headless=new',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-breakpad', '--metrics-recording-only',
    '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1280,900',
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, 'about:blank'
  ];
  if (process.env.CHROMIUM_NO_SANDBOX === '1') args.push('--no-sandbox');
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let diagnostics = '', spawnError, closed = false, cdp, socket, watchdog, browser;
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-5000); });
  child.on('error', error => { spawnError = error; });
  const kill = signal => {
    if (child.pid) {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (cdp) cdp.close();
    else socket?.close();
    kill('SIGTERM');
    await delay(200);
    kill('SIGKILL');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    clearTimeout(watchdog);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  };
  const stop = (message, code) => {
    console.error(message);
    try {
      mkdirSync(artifactRoot(), { recursive: true });
      writeFileSync(join(artifactRoot(), 'termination.json'), JSON.stringify({ message, executable, architecture: process.arch, node: process.version, stderr: diagnostics, events: browser?.events }, null, 2));
    } catch (error) { console.error(`Browser termination evidence could not be saved: ${error.message}`); }
    kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.exit(code);
  };
  const interrupt = () => void stop('Browser smoke interrupted', 130);
  const terminate = () => void stop('Browser smoke terminated', 143);
  const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 90000);
  if (!Number.isSafeInteger(timeout) || timeout < 1000) {
    await cleanup();
    throw new Error('BROWSER_TIMEOUT_MS must be an integer of at least 1000');
  }
  watchdog = setTimeout(() => void stop(`Browser smoke exceeded ${timeout}ms`, 1), timeout);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const endpoint = await eventually(async () => {
      if (spawnError) throw Object.assign(spawnError, { fatal: true });
      if (child.exitCode !== null) throw Object.assign(new Error(`Chromium exited ${child.exitCode}: ${diagnostics}`), { fatal: true });
      return devToolsEndpoint(await readFile(join(directory, 'profile', 'DevToolsActivePort'), 'utf8'));
    }, `Chromium startup (${executable})`);
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chromium WebSocket handshake timed out')), 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chromium WebSocket handshake failed')); }, { once: true });
    });
    cdp = new CDP(socket);
    browser = { cdp, directory, cleanup, executable, get stderr() { return diagnostics; }, offset: 0, pages: [], documents: [], errors: [], events: [] };
    const record = (type, details, session) => {
      browser.events.push({ type, details, session, at: Date.now() });
      if (browser.events.length > 200) browser.events.shift();
    };
    cdp.on('Runtime.consoleAPICalled', (event, session) => record('console', { type: event.type, arguments: event.args.map(value => value.value ?? value.description) }, session));
    cdp.on('Runtime.exceptionThrown', (event, session) => record('exception', event.exceptionDetails, session));
    cdp.on('Page.frameNavigated', (event, session) => record('navigation', { url: event.frame.url }, session));
    cdp.on('Fetch.requestPaused', (event, session) => {
      const url = new URL(event.request.url);
      const synthetic = event.resourceType === 'Document' && syntheticHosts.has(url.hostname);
      const operation = synthetic
        ? cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from('<!doctype html><html><head><title>Synthetic offline site</title></head><body><h1 id="synthetic-site">Offline synthetic site</h1><p>No login, posting, or remote requests.</p></body></html>').toString('base64') }, session)
        : cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, session);
      if (synthetic) browser.documents.push(event.request.url);
      operation.catch(error => browser.errors.push(error));
    });
    const sessions = new Map();
    cdp.on('Target.attachedToTarget', (event) => {
      const { sessionId, targetInfo } = event;
      const initialize = async () => {
        if (targetInfo.type === 'page' || targetInfo.type === 'service_worker') {
          await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] }, sessionId);
        }
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      };
      const ready = initialize();
      sessions.set(targetInfo.targetId, { sessionId, ready });
      ready.catch(error => browser.errors.push(error));
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const worker = await eventually(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return workerTarget(targetInfos, workerURL);
    }, 'built CreateRatio service worker (extension loading is required)');
    browser.origin = `chrome-extension://${new URL(worker.url).host}`;
    const workerSession = await eventually(() => sessions.get(worker.targetId), 'autoattached worker');
    await workerSession.ready;
    browser.worker = workerSession.sessionId;
    await cdp.send('Runtime.enable', {}, browser.worker);
    await eventually(() => evaluate(browser, browser.worker, '!!globalThis.chrome?.storage?.local && !!globalThis.chrome?.runtime?.id'), 'extension worker API readiness');
    await eventually(() => evaluate(browser, browser.worker, 'chrome.storage.session.get("_accessInitialized").then(value => value._accessInitialized === true)'), 'initial access reconciliation');
    await evaluate(browser, browser.worker, clockSource(0));
    browser.page = async url => {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const attached = await eventually(() => sessions.get(targetId), 'autoattached page');
      await attached.ready;
      const session = attached.sessionId;
      const page = { targetId, session };
      browser.pages.push(page);
      await cdp.send('Page.enable', {}, session);
      await cdp.send('Runtime.enable', {}, session);
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] }, session);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: clockSource(browser.offset) + ';' + inputTraceSource }, session);
      await cdp.send('Target.activateTarget', { targetId });
      await cdp.send('Page.navigate', { url }, session);
      return page;
    };
    browser.setTime = async now => {
      browser.offset = now - Date.now();
      await evaluate(browser, browser.worker, clockSource(browser.offset));
      for (const page of browser.pages) {
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: clockSource(browser.offset) }, page.session);
        await eventually(async () => {
          try {
            await evaluate(browser, page.session, clockSource(browser.offset));
            return true;
          } catch (error) {
            if (/Execution context was destroyed|Cannot find (?:default execution context|context with specified id)|Inspected target navigated/.test(error.message)) return false;
            throw Object.assign(error, { fatal: true });
          }
        }, 'apply test clock across page navigation');
      }
    };
    console.log(`Chromium: ${(await cdp.send('Browser.getVersion')).product}`);
    return browser;
  } catch (error) {
    try { await withFailureArtifacts(browser || { cdp, executable, stderr: diagnostics }, 'Chromium startup', async () => { throw error; }); }
    catch (_) {}
    await cleanup();
    throw new Error(`${error.message}\n${diagnostics}`, { cause: error });
  }
}

export async function evaluate(browser, session, expression) {
  const result = await browser.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

export async function seedAccess(browser, sites, settings) {
  await evaluate(browser, browser.worker, `(async () => {
    const seed = { _access: Object.fromEntries(${JSON.stringify(sites)}.map(site => [site, { remainingMs: 300000, date: C3.localDate() }])) };
    const preferences = ${JSON.stringify(settings ?? null)};
    if (preferences) {
      const { settings = {} } = await chrome.storage.local.get('settings');
      seed.settings = { ...settings, ...preferences };
    }
    await chrome.storage.local.set(seed);
    await SiteAccess.reconcile();
  })()`);
}

export async function openSettingsSection(browser, page, name) {
  const selector = '#' + name + '-settings';
  await eventually(() => evaluate(browser, page.session, `!!document.querySelector(${JSON.stringify(selector)})`), name + ' settings section exists');
  if (!await evaluate(browser, page.session, `document.querySelector(${JSON.stringify(selector)}).open`)) await click(browser, page, selector + ' > summary');
  await eventually(() => evaluate(browser, page.session, `document.querySelector(${JSON.stringify(selector)}).open`), name + ' settings section open');
}

export async function waitForEnabledControl(browser, page, selector, timeout) {
  return eventually(() => evaluate(browser, page.session, `(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    return control?.disabled === false && control.getAttribute('aria-disabled') !== 'true';
  })()`), `enabled control ${selector}`, timeout);
}

export async function accessibilityNodes(browser, page) {
  const { nodes } = await browser.cdp.send('Accessibility.getFullAXTree', {}, page.session);
  return nodes.filter(node => !node.ignored);
}

export async function findByRole(browser, page, role, name) {
  const normalize = value => (value || '').trim().replace(/\s+/g, ' ');
  const matches = (await accessibilityNodes(browser, page)).filter(node => node.role?.value === role && normalize(node.name?.value) === normalize(name));
  if (matches.length !== 1) throw Object.assign(new Error(`Expected one ${role} named ${name}; found ${matches.length}`), { fatal: matches.length > 1 });
  return matches[0];
}

export async function click(browser, page, selector) {
  return clickElement(browser, page, async () => {
    const { result } = await browser.cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` }, page.session);
    return result;
  }, selector);
}

export async function clickByRole(browser, page, role, name) {
  return clickElement(browser, page, async () => {
    const node = await findByRole(browser, page, role, name);
    const { object } = await browser.cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }, page.session);
    return object;
  }, `${role} named ${name}`);
}

async function clickElement(browser, page, locate, description) {
  await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
  const point = await eventually(async () => {
    const { objectId } = await locate();
    if (!objectId) return false;
    try {
      const result = await browser.cdp.send('Runtime.callFunctionOn', { objectId, awaitPromise: true, returnByValue: true, functionDeclaration: `async function() {
        const element = this;
        if (element.disabled || element.getAttribute('aria-disabled') === 'true' || !element.getClientRects().length) return false;
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        const before = element.getBoundingClientRect();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const rect = element.getBoundingClientRect();
        if (!element.isConnected || element.disabled || element.getAttribute('aria-disabled') === 'true' || !rect.width || !rect.height) return false;
        if (['x', 'y', 'width', 'height'].some(key => before[key] !== rect[key])) return false;
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const hit = document.elementFromPoint(point.x, point.y);
        return hit === element || element.contains(hit) ? point : false;
      }` }, page.session);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    } finally { await browser.cdp.send('Runtime.releaseObject', { objectId }, page.session).catch(() => {}); }
  }, `stable clickable ${description}`);
  browser.events?.push({ type: 'input-request', details: { selector: description, point }, session: page.session, at: Date.now() });
  await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, page.session);
  await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, page.session);
  await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, page.session);
}
