(() => {
  'use strict';
  if (globalThis.__createRatioRouteHook) return;
  globalThis.__createRatioRouteHook = true;
  const notify = () => window.dispatchEvent(new Event('c3:route-change'));
  for (const key of ['pushState', 'replaceState']) {
    const original = history[key];
    history[key] = function (...args) {
      const result = Reflect.apply(original, this, args); notify(); return result;
    };
  }
  window.addEventListener('popstate', notify);
})();
