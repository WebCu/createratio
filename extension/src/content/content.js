(() => {
  'use strict';
  const extensionAPI = globalThis.browser || globalThis.chrome;
  const messages = RuntimeMessages.create(extensionAPI.runtime);
  const integration = Sites.forURL(location.href);
  if (!integration) return;
  const site = integration.id;
  const scrollFriction = ScrollFriction.create({ document, Element, getComputedStyle });
  let scrollFrictionEnabled = false,
    scrollSpeed = 1;
  const NO_INPUT = Core.asPageTime(-Infinity);
  const INPUT_ACTIVE_DURATION = Core.asMilliseconds(30000);
  const session = crypto.randomUUID();
  let sequence = 0,
    lastSample = Core.asPageTime(performance.now()),
    lastInput = NO_INPUT;
  let pageOrigin = Core.pageOriginFromClocks(Core.asEpochTime(Date.now()), lastSample);
  let enabled = false,
    mode = 'neutral';
  let wasVisible = document.visibilityState === 'visible',
    wasFocused = document.hasFocus();
  /** @type {IngestMessage[]} */
  let outbox = [];
  /** @type {TimeSegment[]} */
  let segments = [];
  /** @type {SiteActionEntry[]} */
  let actions = [];
  let delivery = null,
    stopped = false,
    pageActive = true,
    updating = false;
  const listeners = [];
  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    listeners.push([target, type, fn, options]);
  }
  let adapter = null,
    failed = false;
  let refreshTimer = null,
    generation = null,
    recordingPaused = false,
    activeBeforeUpdate = false;
  let syncPending = true,
    syncRetryAt = Core.asPageTime(0),
    syncRetryDelay = 5000;
  const { maxPackets: MAX_PACKETS, maxItems: MAX_ITEMS, maxSeconds: MAX_SECONDS } = Core.DELIVERY_LIMITS;
  const clicks = new WeakMap();

  function resetInput() {
    lastInput = NO_INPUT;
    lastSample = Core.asPageTime(performance.now());
  }
  function queuePacket() {
    if (!segments.length && !actions.length) return;
    outbox.push({ type: 'ingest', id: `${session}:${sequence++}`, generation, site, segments, actions });
    segments = [];
    actions = [];
    if (outbox.length === MAX_PACKETS) {
      recordingPaused = true;
      mode = 'neutral';
      resetInput();
    }
  }

  /** @param {EpochTime} start
   * @param {EpochTime} end
   * @param {SegmentMode} segmentMode */
  function appendTime(start, end, segmentMode) {
    let cursor = start;
    const parts = Core.splitInterval(start, end);
    for (const [index, part] of parts.entries()) {
      if (segments.reduce((sum, segment) => sum + segment.sec, 0) + part.sec > MAX_SECONDS) queuePacket();
      if (recordingPaused) break;
      const tail = segments.at(-1);
      const partEnd = index === parts.length - 1 ? end : Core.timeAfter(cursor, Core.millisecondsFromSeconds(part.sec));
      if (tail && tail.mode === segmentMode && tail.date === part.date && tail.end === cursor) {
        tail.end = partEnd;
        tail.sec = Core.secondsFromMilliseconds(Core.millisecondsBetween(tail.start, tail.end));
      } else
        segments.push({
          ...part,
          sec: Core.secondsFromMilliseconds(Core.millisecondsBetween(cursor, partEnd)),
          mode: segmentMode,
          start: cursor,
          end: partEnd
        });
      cursor = partEnd;
      if (segments.length === MAX_ITEMS) queuePacket();
      if (recordingPaused) break;
    }
  }
  function settle() {
    const now = Core.asPageTime(performance.now());
    const epochNow = Core.asEpochTime(Date.now());
    const ms = recordingPaused
      ? 0
      : Core.activeMilliseconds({
          start: lastSample,
          end: now,
          lastInput,
          visible: pageActive && wasVisible,
          focused: wasFocused,
          mode
        });
    if (ms > 0 && (mode === 'create' || mode === 'consume')) {
      const activeStart = Core.asPageTime(Math.max(lastSample, lastInput));
      const activeEnd = Core.asPageTime(Math.min(now, Core.timeAfter(lastInput, INPUT_ACTIVE_DURATION)));
      appendTime(
        Core.epochTimeFromPageTime(activeStart, pageOrigin),
        Core.epochTimeFromPageTime(activeEnd, pageOrigin),
        mode
      );
    }
    lastSample = now;
    if (Math.abs(Core.millisecondsBetween(Core.epochTimeFromPageTime(now, pageOrigin), epochNow)) > 2)
      pageOrigin = Core.pageOriginFromClocks(epochNow, now);
  }
  function refresh() {
    if (stopped) return;
    settle();
    try {
      mode = enabled && !recordingPaused ? adapter.mode() : 'neutral';
      if (!['create', 'consume', 'neutral'].includes(mode)) throw new Error('Invalid page classification');
    } catch (error) {
      pauseIntegration(error);
      return;
    }
    wasVisible = document.visibilityState === 'visible';
    wasFocused = document.hasFocus();
    scrollFriction.setSpeed(
      scrollFrictionEnabled && mode === 'consume' && pageActive && wasVisible && wasFocused ? scrollSpeed : 1
    );
  }
  function scheduleRefresh() {
    if (refreshTimer === null)
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh();
      }, 150);
  }
  function canRecord(event) {
    return (
      event.isTrusted &&
      !stopped &&
      !updating &&
      enabled &&
      !recordingPaused &&
      pageActive &&
      document.hasFocus() &&
      document.visibilityState === 'visible'
    );
  }
  function markInput(event) {
    if (!canRecord(event)) return;
    settle();
    lastInput = lastSample;
    wasVisible = document.visibilityState === 'visible';
    wasFocused = document.hasFocus();
  }
  function pauseIntegration(error) {
    failed = true;
    enabled = false;
    adapter = null;
    mode = 'neutral';
    scrollFriction.setSpeed(1);
    segments = [];
    actions = [];
    outbox = [];
    lastInput = NO_INPUT;
    lastSample = Core.asPageTime(performance.now());
    console.warn(`CreateRatio: ${integration.name} integration paused until page reload.`, error.message);
  }
  function synchronizeTracking(nextEnabled, nextGeneration, preserveOutbox) {
    if (enabled === nextEnabled && generation === nextGeneration) return;
    if (preserveOutbox && enabled && !nextEnabled) {
      settle();
      queuePacket();
    }
    generation = nextGeneration;
    segments = [];
    actions = [];
    if (!preserveOutbox) outbox = [];
    recordingPaused = false;
    resetInput();
    enabled = nextEnabled;
    adapter = null;
    if (!enabled) return;
    try {
      const dom = PageQueries({ document, location, Element, getComputedStyle });
      adapter = integration.create({ document, location, dom });
      if (typeof adapter?.mode !== 'function' || typeof adapter?.action !== 'function')
        throw new Error('Invalid site adapter');
    } catch (error) {
      pauseIntegration(error);
    }
  }
  function acceptSnapshot(result) {
    const access = result.access[site];
    if (integration.access && !access) throw new Error('No response');
    const nextEnabled =
      !failed &&
      Core.trackingEnabled(site, result.settings) &&
      (!access || (access.enabled !== false && (access.goalAllowed || access.remainingMs > 0)));
    scrollFrictionEnabled = result.settings.scrollFrictionEnabled === true;
    scrollSpeed =
      (100 - (result.settings.scrollFrictionStrength ?? Core.DEFAULT_SETTINGS.scrollFrictionStrength)) / 100;
    const nextGeneration = result.generation ?? null;
    synchronizeTracking(
      nextEnabled,
      nextGeneration,
      generation === nextGeneration && Core.trackingEnabled(site, result.settings)
    );
    syncPending = false;
    syncRetryAt = Core.asPageTime(0);
    syncRetryDelay = 5000;
    refresh();
  }
  function pump() {
    if (stopped) return Promise.resolve();
    if (!delivery)
      delivery = deliver().finally(() => {
        delivery = null;
      });
    return delivery;
  }
  async function deliver() {
    try {
      if (!outbox.length) {
        acceptSnapshot(await messages.send({ type: 'snapshot' }, 'No response'));
      }
      while (outbox.length && !stopped) {
        const packet = outbox[0];
        let result;
        try {
          result = await messages.send(packet, 'No response');
        } catch (error) {
          if (error.retryable !== false) throw error;
          if (outbox[0] === packet) outbox.shift();
          console.warn('CreateRatio: packet rejected.', error.message);
          continue;
        }
        acceptSnapshot(result);
        if (outbox[0] === packet) outbox.shift();
      }
      if (recordingPaused && !outbox.length) {
        recordingPaused = false;
        resetInput();
        refresh();
      }
    } catch (error) {
      if (!extensionAPI.runtime?.id || /context invalidated/i.test(error.message)) {
        stop();
      } else {
        syncPending = true;
        syncRetryAt = Core.timeAfter(Core.asPageTime(performance.now()), Core.asMilliseconds(syncRetryDelay));
        syncRetryDelay = Math.min(syncRetryDelay * 2, 60000);
        console.warn('CreateRatio: tracking will retry.', error.message);
      }
    }
  }
  function flush() {
    if (stopped) return;
    settle();
    queuePacket();
    if (!syncPending || Core.asPageTime(performance.now()) >= syncRetryAt) void pump();
  }
  function counted(button) {
    const now = Core.asPageTime(performance.now());
    if (now - (clicks.get(button) ?? -Infinity) < 1000) return false;
    clicks.set(button, now);
    return true;
  }
  function recordAction(result) {
    if (!result) return;
    if (
      !integration.actions.includes(result.action) ||
      typeof result.submission !== 'boolean' ||
      !(result.button instanceof Element)
    )
      throw new Error('Invalid action recognition');
    if (!counted(result.button)) return;
    actions.push({ date: Core.localDate(), action: result.action, at: Core.asEpochTime(Date.now()) });
    flush();
  }
  function onInteraction(event) {
    if (!canRecord(event)) return;
    try {
      recordAction(adapter.action(event));
    } catch (error) {
      pauseIntegration(error);
      return;
    }
    scheduleRefresh();
  }
  function boundary() {
    refresh();
    flush();
  }
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input'])
    listen(document, type, markInput, { capture: true, passive: true });
  listen(document, 'click', onInteraction, true);
  listen(document, 'keydown', onInteraction, true);
  listen(document, 'focusin', refresh, true);
  listen(document, 'focusout', scheduleRefresh, true);
  listen(document, 'visibilitychange', boundary);
  listen(window, 'focus', boundary);
  listen(window, 'blur', boundary);
  listen(window, 'pagehide', () => {
    settle();
    pageActive = false;
    lastInput = NO_INPUT;
    boundary();
    if (outbox.length) void pump();
  });
  listen(window, 'pageshow', () => {
    lastSample = Core.asPageTime(performance.now());
    pageActive = true;
    boundary();
  });
  for (const type of ['c3:route-change', 'popstate', 'hashchange']) listen(window, type, refresh);
  const observer = new MutationObserver(() => {
    if (!pageActive || document.visibilityState !== 'visible') return;
    scheduleRefresh();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['contenteditable', 'aria-hidden', 'style', 'class', 'data-testid']
  });
  const interval = setInterval(() => {
    if (!extensionAPI.runtime?.id) {
      stop();
      return;
    }
    if (stopped || updating) return;
    if (outbox.length || (pageActive && document.visibilityState === 'visible' && document.hasFocus())) {
      refresh();
      if (
        outbox.length ||
        segments.length ||
        actions.length ||
        (syncPending && Core.asPageTime(performance.now()) >= syncRetryAt)
      )
        flush();
    }
  }, 5000);
  function stop() {
    stopped = true;
    scrollFriction.setSpeed(1);
    clearInterval(interval);
    clearTimeout(refreshTimer);
    observer.disconnect();
    for (const [target, type, fn, options] of listeners) target.removeEventListener(type, fn, options);
    listeners.length = 0;
    extensionAPI.runtime.onMessage.removeListener(receive);
  }
  function receive(message, sender, respond) {
    if (message.type === 'drain-tracker' && sender.id === extensionAPI.runtime.id && !stopped) {
      settle();
      queuePacket();
      respond({ packets: outbox });
      return;
    }
    if (message.type === 'refresh' && !stopped && !updating) {
      refresh();
      void pump();
    }
  }
  extensionAPI.runtime.onMessage.addListener(receive);
  ContentLifecycle.register('tracker', {
    async prepare(force) {
      if (
        !force &&
        enabled &&
        pageActive &&
        document.hasFocus() &&
        document.visibilityState === 'visible' &&
        Core.millisecondsBetween(lastInput, Core.asPageTime(performance.now())) < INPUT_ACTIVE_DURATION
      )
        return false;
      settle();
      resetInput();
      if (!updating) activeBeforeUpdate = pageActive;
      updating = true;
      pageActive = false;
      scrollFriction.setSpeed(1);
      await pump();
      queuePacket();
      await pump();
      return outbox.length === 0;
    },
    resume() {
      if (!stopped && updating) {
        updating = false;
        pageActive = activeBeforeUpdate;
        resetInput();
        refresh();
      }
    },
    stop
  });
  refresh();
  void pump();
})();
