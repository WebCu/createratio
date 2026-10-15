'use strict';
const RefillAnimation = (() => {
  const views = new WeakMap();
  function render(target, access) {
    const previous = views.get(target);
    const refilledAt = access.refilledAt || 0;
    if (previous?.refilledAt === refilledAt && access.remainingMs > 0) return;
    if (previous?.notice) {
      clearTimeout(previous.timeout);
      previous.notice.remove();
    }
    const view = { refilledAt };
    views.set(target, view);
    const age = Date.now() - refilledAt;
    if (!Number.isFinite(refilledAt) || refilledAt <= 0 || age < 0 || (age > 60000 && !previous) || !(access.remainingMs > 0)) return;
    const notice = document.createElement('span');
    notice.className = 'refill-notice'; notice.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.className = 'refill-label'; label.textContent = 'Time refilled';
    const track = document.createElement('span'), fill = document.createElement('span');
    track.className = 'refill-track'; track.setAttribute('aria-hidden', 'true');
    fill.className = 'refill-fill'; track.append(fill); notice.append(label, track);
    target.append(notice); view.notice = notice; view.fill = fill;
    view.timeout = setTimeout(() => { notice.remove(); view.notice = null; }, 2800);
  }
  function waitForFill(target) {
    const animation = views.get(target)?.fill?.getAnimations()[0];
    return animation?.finished.catch(() => {});
  }
  return { render, waitForFill };
})();
