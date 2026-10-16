(() => {
  'use strict';
  const extensionAPI = globalThis.browser || globalThis.chrome;
  const messages = RuntimeMessages.create(extensionAPI.runtime);
  const integration = C3Sites.forURL(location.href);
  if (!integration) return;
  const site = integration.id;
  const session = crypto.randomUUID();
  let sequence = 0, lastSample = performance.now(), lastInput = -Infinity;
  let enabled = false, mode = 'neutral';
  let wasVisible = document.visibilityState === 'visible', wasFocused = document.hasFocus();
  let segments = [], actions = [], outbox = [], sending = false, stopped = false, pageActive = true;
  let adapter = null, failed = false;
  let refreshTimer = null, generation = null, recordingPaused = false;
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
  }
  function scheduleRefresh() {
    if (refreshTimer === null) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 150);
  }
  function canRecord(event) {
    return event.isTrusted && !stopped && enabled && !recordingPaused && pageActive && document.hasFocus() && document.visibilityState === 'visible';
  }
  function markInput(event) {
    if (!canRecord(event)) return;
    settle(); lastInput = performance.now();
    wasVisible = document.visibilityState === 'visible'; wasFocused = document.hasFocus();
  }
  function pauseIntegration(error) {
    failed = true; enabled = false; adapter = null; mode = 'neutral';
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
    synchronizeTracking(nextEnabled, result.generation ?? null);
    refresh();
  }
  async function pump() {
    if (sending || stopped) return;
    sending = true;
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
      else console.warn('CreateRatio: tracking will retry.', error.message);
    } finally {
      sending = false;
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
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input']) document.addEventListener(type, markInput, { capture: true, passive: true });
  document.addEventListener('click', onInteraction, true);
  document.addEventListener('keydown', onInteraction, true);
  document.addEventListener('focusin', refresh, true);
  document.addEventListener('focusout', scheduleRefresh, true);
  document.addEventListener('visibilitychange', boundary);
  window.addEventListener('focus', boundary);
  window.addEventListener('blur', boundary);
  window.addEventListener('pagehide', () => {
    settle(); pageActive = false; lastInput = -Infinity;
    boundary();
  });
  window.addEventListener('pageshow', () => {
    lastSample = performance.now(); pageActive = true;
    boundary();
  });
  for (const type of ['c3:route-change', 'popstate', 'hashchange']) window.addEventListener(type, refresh);
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['contenteditable', 'aria-hidden', 'style', 'class', 'data-testid'] });
  const interval = setInterval(() => {
    if (outbox.length || pageActive && document.visibilityState === 'visible' && document.hasFocus()) {
      refresh(); flush();
    }
  }, 5000);
  function stop() {
    stopped = true; clearInterval(interval); clearTimeout(refreshTimer); observer.disconnect();
  }
  extensionAPI.runtime.onMessage.addListener(message => {
    if (message.type === 'refresh') { refresh(); void pump(); }
  });
  refresh(); void pump();
})();
