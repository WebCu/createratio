'use strict';
(() => {
  const api = globalThis.browser || globalThis.chrome;
  const messages = RuntimeMessages.create(api.runtime);
  const site = C3Sites.forAccessURL(location.href)?.id;
  if (!site) return;
  let timer, checking = false, paused = false, stopped = false;
  const listeners = [];
  function listen(target, type, fn) { target.addEventListener(type, fn); listeners.push([target, type, fn]); }
  function block() { if (!stopped && !paused) location.replace(api.runtime.getURL('blocked.html') + '?site=' + site); }
  async function check() {
    clearTimeout(timer);
    if (!api.runtime?.id) { stop(); return; }
    if (checking || paused || stopped) return;
    checking = true;
    try {
      const result = await messages.send({ type: 'access-status' }, 'Unable to check access.');
      if (paused || stopped) return;
      const access = result.access[site];
      if (!access || access.enabled !== false && !(access.goalAllowed || access.remainingMs > 0)) { block(); return; }
      if (!document.hidden && document.hasFocus() && access.enabled !== false && !access.goalAllowed) {
        timer = setTimeout(check, Math.max(1, access.remainingMs));
      }
    } catch (_) { block(); }
    finally { checking = false; }
  }
  function receive(message) { if (message.type === 'refresh') void check(); }
  for (const type of ['pageshow', 'focus', 'blur']) listen(globalThis, type, check);
  listen(document, 'visibilitychange', check);
  api.runtime.onMessage.addListener(receive);
  function stop() {
    stopped = true; clearTimeout(timer);
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners.length = 0; api.runtime.onMessage.removeListener(receive);
  }
  ContentLifecycle.register('guard', {
    async prepare() { paused = true; clearTimeout(timer); return true; },
    resume() { paused = false; void check(); },
    stop
  });
  void check();
})();
