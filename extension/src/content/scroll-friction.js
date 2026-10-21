(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScrollFriction = factory();
})(globalThis, function () {
  'use strict';
  const SPEED = 0.5, LINE_PIXELS = 16;
  const CONTROLS = 'input,textarea,select,video,audio,[role="textbox"],[role="slider"],[role="listbox"],[role="menu"],[role="dialog"],dialog';
  function create({ document, Element, getComputedStyle }) {
    let enabled = false, remainder = 0, lastPosition = null;
    function protectedElement(node) {
      return node instanceof Element && (node.isContentEditable || node.matches(CONTROLS));
    }
    function onWheel(event) {
      if (!event.isTrusted || !event.cancelable || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (!Number.isFinite(event.deltaY) || !event.deltaY || !Number.isFinite(event.deltaX) || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (protectedElement(document.activeElement)) return;
      const root = document.scrollingElement;
      if (!root || root.scrollHeight <= root.clientHeight) return;
      if ([root, document.body].some(node => node && ['hidden', 'clip'].includes(getComputedStyle(node).overflowY))) return;
      for (const node of event.composedPath()) {
        if (protectedElement(node)) return;
        if (node === root) break;
        if (!(node instanceof Element)) continue;
        if (node.scrollHeight > node.clientHeight && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return;
        if (event.deltaX && node.scrollWidth > node.clientWidth && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowX)) return;
      }
      const unit = event.deltaMode === 0 ? 1 : event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? root.clientHeight : 0;
      if (!unit) return;
      const before = root.scrollTop, delta = event.deltaY * unit;
      if (delta < 0 && before <= 0 || delta > 0 && before >= root.scrollHeight - root.clientHeight) { remainder = 0; return; }
      if (before !== lastPosition || Math.sign(delta) !== Math.sign(remainder)) remainder = 0;
      const distance = delta * SPEED + remainder, wholePixels = Math.trunc(distance);
      event.preventDefault();
      root.scrollBy({ top: wholePixels, left: event.deltaX * unit, behavior: 'instant' });
      remainder = distance - wholePixels;
      lastPosition = root.scrollTop;
    }
    function setEnabled(value) {
      if (enabled === value) return;
      enabled = value; remainder = 0; lastPosition = null;
      if (enabled) document.addEventListener('wheel', onWheel, { passive: false });
      else document.removeEventListener('wheel', onWheel);
    }
    return { setEnabled };
  }
  return { create };
});
