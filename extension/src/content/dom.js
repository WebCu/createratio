(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.C3_DOM = factory;
})(globalThis, function (environment) {
  'use strict';
  const { document, location, Element, getComputedStyle } = environment;
  function matches(node, selectors = []) { return !!node && selectors.some(selector => node.matches(selector)); }
  function closest(node, selectors = []) {
    if (!(node instanceof Element)) return null;
    for (const selector of selectors) { const found = node.closest(selector); if (found) return found; }
    return null;
  }
  function visible(node) {
    if (!node?.isConnected || !node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none' && !node.closest('[hidden],[aria-hidden="true"]');
  }
  function enabled(node) { return visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true'; }
  function find(scope, selectors = []) {
    for (const selector of selectors) for (const node of scope.querySelectorAll(selector)) if (visible(node)) return node;
    return null;
  }
  function label(node) { return (node.getAttribute('aria-label') || node.textContent || '').trim().replace(/\s+/g, ' '); }
  function composerScope(node, editorSelectors, submitSelectors) {
    for (let scope = node.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
      if (find(scope, editorSelectors) && find(scope, submitSelectors)) return scope;
    }
    return null;
  }
  function ownProfilePath(selectors) {
    for (const selector of selectors) {
      const link = document.querySelector(selector);
      if (link) {
        try { return new URL(link.href, location.href).pathname.replace(/\/+$/, ''); }
        catch (_) { return null; }
      }
    }
    return null;
  }
  function lightAction(target, config) {
    for (const [action, selectors] of Object.entries(config.light)) {
      const button = closest(target, selectors);
      if (enabled(button)) return { button, action, submission: false };
    }
    if (config.menuItem) {
      const item = closest(target, config.menuItem);
      if (enabled(item)) for (const [action, labels] of Object.entries(config.lightLabels)) {
        if (labels.some(text => text.toLowerCase() === label(item).toLowerCase())) return { button: item, action, submission: false };
      }
    }
    return null;
  }
  function submitKey(event) {
    return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing && event.keyCode !== 229 && !event.repeat && !event.defaultPrevented;
  }
  return { matches, closest, visible, enabled, find, label, composerScope, ownProfilePath, lightAction, submitKey };
});
