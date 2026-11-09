(() => {
  'use strict';
  const extensionAPI = globalThis.browser || globalThis.chrome;
  const messages = RuntimeMessages.create(extensionAPI.runtime);
  const integration = C3Sites.forURL(location.href);
  if (!integration) return;
  const site = integration.id;
  const scrollFriction = ScrollFriction.create({ document, Element, getComputedStyle });
  let scrollFrictionEnabled = false, scrollSpeed = 1;
  const session = crypto.randomUUID();
  let sequence = 0, lastSample = performance.now(), lastInput = -Infinity;
  let enabled = false, mode = 'neutral';
  let wasVisible = document.visibilityState === 'visible', wasFocused = document.hasFocus();
  let segments = [], actions = [], outbox = [], delivery = null, stopped = false, pageActive = true, updating = false;
  const listeners = [];
  function listen(target, type, fn, options) { target.addEventListener(type, fn, options); listeners.push([target, type, fn, options]); }
  let adapter = null, failed = false;
  let refreshTimer = null, generation = null, recordingPaused = false, activeBeforeUpdate = false;
  let syncPending = true, syncRetryAt = 0, syncRetryDelay = 5000;
  const { maxPackets: MAX_PACKETS, maxItems: MAX_ITEMS, maxSeconds: MAX_SECONDS } = C3.DELIVERY_LIMITS;
  const clicks = new WeakMap();

  function resetInput() {
    lastInput = -Infinity; lastSample = performance.now();
  }
  function queuePacket() {
    if (!segments.length && !actions.length) return;
    outbox.push({ type: 'ingest', id: `${session}:${sequence++}`, generation, site, segments, actions });
    segments = []; actions = [];
    if (outbox.length === MAX_PACKETS) {
      recordingPaused = true; mode = 'neutral'; resetInput();
    }
  }

  function appendTime(start, end) {
    for (const part of C3.splitInterval(start, end)) {
      if (segments.reduce((sum, segment) => sum + segment.sec, 0) + part.sec > MAX_SECONDS) queuePacket();
      if (recordingPaused) break;
      const tail = segments.at(-1);
      if (tail && tail.mode === mode && tail.date === part.date) tail.sec += part.sec;
      else segments.push({ ...part, mode });
      if (segments.length === MAX_ITEMS) queuePacket();
      if (recordingPaused) break;
    }
  }
  function settle() {
    const now = performance.now();
    const ms = recordingPaused ? 0 : C3.activeMillis({ start: lastSample, end: now, lastInput, visible: pageActive && wasVisible, focused: wasFocused, mode });
    if (ms > 0) {
      const activeEnd = Math.min(now, lastInput + 30000);
      const endWall = Date.now() - (now - activeEnd);
      appendTime(endWall - ms, endWall);
    }
    lastSample = now;
  }
  function refresh() {
    if (stopped) return;
    settle();
    try {
      mode = enabled && !recordingPaused ? adapter.mode() : 'neutral';
      if (!['create', 'consume', 'neutral'].includes(mode)) throw new Error('Invalid page classification');
    } catch (error) { pauseIntegration(error); return; }
    wasVisible = document.visibilityState === 'visible'; wasFocused = document.hasFocus();
    scrollFriction.setSpeed(scrollFrictionEnabled && mode === 'consume' && pageActive && wasVisible && wasFocused ? scrollSpeed : 1);
  }
  function scheduleRefresh() {
    if (refreshTimer === null) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 150);
  }
  function canRecord(event) {
    return event.isTrusted && !stopped && !updating && enabled && !recordingPaused && pageActive && document.hasFocus() && document.visibilityState === 'visible';
  }
  function markInput(event) {
    if (!canRecord(event)) return;
    settle(); lastInput = performance.now();
    wasVisible = document.visibilityState === 'visible'; wasFocused = document.hasFocus();
  }
  function pauseIntegration(error) {
    failed = true; enabled = false; adapter = null; mode = 'neutral';
    scrollFriction.setSpeed(1);
    segments = []; actions = []; outbox = [];
    lastInput = -Infinity; lastSample = performance.now();
    console.warn(`CreateRatio: ${integration.name} integration paused until page reload.`, error.message);
  }
  function synchronizeTracking(nextEnabled, nextGeneration) {
    if (enabled === nextEnabled && generation === nextGeneration) return;
    generation = nextGeneration;
    segments = []; actions = []; outbox = [];
    recordingPaused = false; resetInput();
    enabled = nextEnabled; adapter = null;
    if (!enabled) return;
    try {
      const dom = C3_DOM({ document, location, Element, getComputedStyle });
      adapter = integration.create({ document, location, dom });
      if (typeof adapter?.mode !== 'function' || typeof adapter?.action !== 'function') throw new Error('Invalid site adapter');
    } catch (error) { pauseIntegration(error); }
  }
  function acceptSnapshot(result) {
    const access = result.access[site];
    if (integration.access && !access) throw new Error('No response');
    const nextEnabled = !failed && C3.trackingEnabled(site, result.settings) && (!access || access.enabled !== false && (access.goalAllowed || access.remainingMs > 0));
    scrollFrictionEnabled = result.settings.scrollFrictionEnabled === true;
    scrollSpeed = (100 - (result.settings.scrollFrictionStrength ?? C3.DEFAULT_SETTINGS.scrollFrictionStrength)) / 100;
    synchronizeTracking(nextEnabled, result.generation ?? null);
    syncPending = false; syncRetryAt = 0; syncRetryDelay = 5000;
    refresh();
  }
  function pump() {
    if (stopped) return Promise.resolve();
    if (!delivery) delivery = deliver().finally(() => { delivery = null; });
    return delivery;
  }
  async function deliver() {
    try {
      if (!outbox.length) {
        acceptSnapshot(await messages.send({ type: 'snapshot' }, 'No response'));
      }
      while (outbox.length && !stopped) {
        const packet = outbox[0];
        acceptSnapshot(await messages.send(packet, 'No response'));
        if (outbox[0] === packet) outbox.shift();
      }
      if (recordingPaused && !outbox.length) {
        recordingPaused = false; resetInput(); refresh();
      }
    } catch (error) {
      if (!extensionAPI.runtime?.id || /context invalidated/i.test(error.message)) { stop(); }
      else {
        syncPending = true; syncRetryAt = performance.now() + syncRetryDelay;
        syncRetryDelay = Math.min(syncRetryDelay * 2, 60000);
        console.warn('CreateRatio: tracking will retry.', error.message);
      }
    }
  }
  function flush() {
    if (stopped) return;
    settle();
    queuePacket();
    void pump();
  }
  function counted(button) {
    const now = performance.now();
    if (now - (clicks.get(button) ?? -Infinity) < 1000) return false;
    clicks.set(button, now); return true;
  }
  function recordAction(result) {
    if (!result) return;
    if (!integration.actions.includes(result.action) || typeof result.submission !== 'boolean' || !(result.button instanceof Element)) throw new Error('Invalid action recognition');
    if (!counted(result.button)) return;
    actions.push({ date: C3.localDate(), action: result.action });
    flush();
  }
  function onInteraction(event) {
    if (!canRecord(event)) return;
    try { recordAction(adapter.action(event)); }
    catch (error) { pauseIntegration(error); return; }
    scheduleRefresh();
  }
  function boundary() { refresh(); flush(); }
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input']) listen(document, type, markInput, { capture: true, passive: true });
  listen(document, 'click', onInteraction, true);
  listen(document, 'keydown', onInteraction, true);
  listen(document, 'focusin', refresh, true);
  listen(document, 'focusout', scheduleRefresh, true);
  listen(document, 'visibilitychange', boundary);
  listen(window, 'focus', boundary);
  listen(window, 'blur', boundary);
  listen(window, 'pagehide', () => {
    settle(); pageActive = false; lastInput = -Infinity;
    boundary();
  });
  listen(window, 'pageshow', () => {
    lastSample = performance.now(); pageActive = true;
    boundary();
  });
  for (const type of ['c3:route-change', 'popstate', 'hashchange']) listen(window, type, refresh);
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['contenteditable', 'aria-hidden', 'style', 'class', 'data-testid'] });
  const interval = setInterval(() => {
    if (!extensionAPI.runtime?.id) { stop(); return; }
    if (stopped || updating) return;
    if (outbox.length || pageActive && document.visibilityState === 'visible' && document.hasFocus()) {
      refresh();
      if (outbox.length || segments.length || actions.length || syncPending && performance.now() >= syncRetryAt) flush();
    }
  }, 5000);
  function stop() {
    stopped = true; scrollFriction.setSpeed(1); clearInterval(interval); clearTimeout(refreshTimer); observer.disconnect();
    for (const [target, type, fn, options] of listeners) target.removeEventListener(type, fn, options);
    listeners.length = 0;
    extensionAPI.runtime.onMessage.removeListener(receive);
  }
  function receive(message) {
    if (message.type === 'refresh' && !stopped && !updating) { refresh(); void pump(); }
  }
  extensionAPI.runtime.onMessage.addListener(receive);
  ContentLifecycle.register('tracker', {
    async prepare(force) {
      if (!force && enabled && pageActive && document.hasFocus() && document.visibilityState === 'visible' && performance.now() - lastInput < 30000) return false;
      settle(); resetInput();
      if (!updating) activeBeforeUpdate = pageActive;
      updating = true; pageActive = false; scrollFriction.setSpeed(1);
      await pump(); queuePacket(); await pump();
      return outbox.length === 0;
    },
    resume() { if (!stopped && updating) { updating = false; pageActive = activeBeforeUpdate; resetInput(); refresh(); } },
    stop
  });
  refresh(); void pump();
})();
