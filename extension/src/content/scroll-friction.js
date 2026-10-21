(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScrollFriction = factory();
})(globalThis, function () {
  'use strict';
  const LINE_PIXELS = 16;
  const CONTROLS = 'input,textarea,select,video,audio,[role="textbox"],[role="slider"],[role="listbox"],[role="menu"],[role="dialog"],dialog';
  const SCROLLS = /^(auto|scroll|overlay)$/;
  const LOCKS_SCROLL = /^(hidden|clip)$/;
  const SIZE_CONTAINER = /(?:^| )(?:size|inline-size)(?: |$)/;
  function hasContainment(style) {
    return style.contain && style.contain !== 'none' || style.contentVisibility && style.contentVisibility !== 'visible' || SIZE_CONTAINER.test(style.containerType);
  }
  function bodyOverflowPropagates(rootStyle, bodyStyle) {
    return rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible' && !hasContainment(rootStyle) && !hasContainment(bodyStyle);
  }
  function create({ document, Element, getComputedStyle }) {
    let speed = 1, remainder = 0, lastPosition = null, lastTarget = null;
    function protectedElement(node) {
      return node instanceof Element && (node.isContentEditable || node.matches(CONTROLS));
    }
    function scrollable(node) {
      if (node.scrollHeight <= node.clientHeight) return false;
      const style = getComputedStyle(node);
      if (!SCROLLS.test(style.overflowY)) return false;
      if (node !== document.body) return true;
      return !bodyOverflowPropagates(getComputedStyle(document.documentElement), style);
    }
    function viewportLocked(root) {
      const rootStyle = getComputedStyle(root);
      if (LOCKS_SCROLL.test(rootStyle.overflowY)) return true;
      if (root !== document.documentElement || !document.body) return false;
      const bodyStyle = getComputedStyle(document.body);
      return bodyOverflowPropagates(rootStyle, bodyStyle) && LOCKS_SCROLL.test(bodyStyle.overflowY);
    }
    function pageSurface(node) {
      return node.clientHeight * 2 >= document.documentElement.clientHeight;
    }
    function onWheel(event) {
      if (!event.isTrusted || !event.cancelable || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (!Number.isFinite(event.deltaY) || !event.deltaY || !Number.isFinite(event.deltaX) || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (protectedElement(document.activeElement)) return;
      const root = document.scrollingElement, ancestors = [];
      for (const node of event.composedPath()) {
        if (protectedElement(node)) return;
        if (node === root || node === document.documentElement) break;
        if (!(node instanceof Element)) continue;
        if (event.deltaX && node.scrollWidth > node.clientWidth && SCROLLS.test(getComputedStyle(node).overflowX)) return;
        if (scrollable(node)) ancestors.push(node);
      }
      let target = root && root.scrollHeight > root.clientHeight ? root : null;
      if (target && viewportLocked(root)) target = null;
      if (target) {
        if (ancestors.length) return;
      } else if (ancestors.length === 1 && pageSurface(ancestors[0])) target = ancestors[0];
      if (!target) return;
      const unit = event.deltaMode === 0 ? 1 : event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? target.clientHeight : 0;
      if (!unit) return;
      const before = target.scrollTop, delta = event.deltaY * unit;
      if (delta < 0 && before <= 0 || delta > 0 && before >= target.scrollHeight - target.clientHeight) { remainder = 0; return; }
      if (target !== lastTarget || before !== lastPosition || Math.sign(delta) !== Math.sign(remainder)) remainder = 0;
      const distance = delta * speed + remainder, wholePixels = Math.trunc(distance);
      event.preventDefault();
      target.scrollBy({ top: wholePixels, left: event.deltaX * unit, behavior: 'instant' });
      remainder = distance - wholePixels;
      lastTarget = target; lastPosition = target.scrollTop;
    }
    function setSpeed(value) {
      const next = Number.isFinite(value) && value > 0 && value < 1 ? value : 1;
      if (speed === next) return;
      const wasSlowed = speed < 1;
      speed = next; remainder = 0; lastPosition = null; lastTarget = null;
      if (wasSlowed === (speed < 1)) return;
      if (speed < 1) document.addEventListener('wheel', onWheel, { passive: false });
      else document.removeEventListener('wheel', onWheel);
    }
    return { setSpeed };
  }
  return { create };
});
