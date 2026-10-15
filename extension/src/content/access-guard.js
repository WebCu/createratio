'use strict';
(() => {
  const api = globalThis.browser || globalThis.chrome;
  const messages = RuntimeMessages.create(api.runtime);
  const site = C3Sites.forAccessURL(location.href)?.id;
  if (!site) return;
  let timer, checking = false;
  function block() { location.replace(api.runtime.getURL('blocked.html') + '?site=' + site); }
  async function check() {
    clearTimeout(timer);
    if (checking) return;
    checking = true;
    try {
      const result = await messages.send({ type: 'access-status' }, 'Unable to check access.');
      const access = result.access[site];
      if (!access || access.enabled !== false && !(access.goalAllowed || access.remainingMs > 0)) { block(); return; }
      if (!document.hidden && document.hasFocus()) timer = setTimeout(check, access.enabled === false || access.goalAllowed ? 1000 : Math.min(1000, access.remainingMs));
    } catch (_) { block(); }
    finally { checking = false; }
  }
  addEventListener('pageshow', check);
  addEventListener('focus', check);
  addEventListener('blur', check);
  document.addEventListener('visibilitychange', check);
  void check();
})();
