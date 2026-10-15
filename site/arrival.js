(() => {
  'use strict';

  const arrival = document.querySelector('.arrival');
  const stage = document.querySelector('.arrival-stage');
  const space = document.querySelector('#your-space');
  const scrollHint = document.querySelector('.scroll-hint');
  if (!arrival || !stage || !space) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mask = 'radial-gradient(circle, transparent, black)';
  const supportsMask = CSS.supports('mask-image', mask) || CSS.supports('-webkit-mask-image', mask);
  const clamp = value => Math.max(0, Math.min(1, value));
  let enabled = false;
  let start = 0;
  let distance = 1;
  let radius = 0;
  let frame = 0;
  let lastProgress = -1;

  function render() {
    frame = 0;
    if (!enabled) return;
    const progress = clamp((window.scrollY - start) / distance);
    if (progress === lastProgress) return;
    lastProgress = progress;
    const eased = progress * progress * (3 - 2 * progress);
    const style = arrival.style;
    style.setProperty('--aperture', `${radius * eased}px`);
    style.setProperty('--thought-opacity', 1 - clamp(progress / 0.45));
    style.setProperty('--thought-shift', `${progress * 180}px`);
    style.setProperty('--noise-opacity', 1 - clamp(progress / 0.7));
    style.setProperty('--noise-travel', `${eased * 240}px`);
    style.setProperty('--orbit-scale', 1 + eased * 0.8);
    arrival.classList.toggle('is-open', progress >= 0.995);
  }

  function schedule() {
    if (enabled && !frame) frame = requestAnimationFrame(render);
  }

  function measure() {
    if (!enabled) return;
    start = arrival.getBoundingClientRect().top + window.scrollY;
    distance = Math.max(1, arrival.offsetHeight - stage.offsetHeight);
    radius = Math.hypot(window.innerWidth, stage.offsetHeight) * 0.55;
    lastProgress = -1;
    schedule();
  }

  function configure() {
    enabled = !reducedMotion.matches && supportsMask;
    document.documentElement.classList.toggle('has-arrival', enabled);
    if (enabled) {
      measure();
    } else {
      cancelAnimationFrame(frame);
      frame = 0;
      arrival.classList.remove('is-open');
    }
  }

  const hintTimer = scrollHint && window.scrollY <= 0 ? setTimeout(() => {
    if (window.scrollY <= 0) scrollHint.hidden = false;
  }, 8000) : null;

  window.addEventListener('scroll', () => {
    if (scrollHint && window.scrollY > 0) {
      clearTimeout(hintTimer);
      scrollHint.hidden = true;
    }
    schedule();
  }, { passive: true });
  window.addEventListener('resize', measure);
  reducedMotion.addEventListener('change', configure);
  document.addEventListener('focusin', event => {
    if (enabled && space.contains(event.target) && window.scrollY < start + distance) {
      window.scrollTo({ top: start + distance, behavior: 'instant' });
      schedule();
    }
  });

  configure();
  const target = document.getElementById(window.location.hash.slice(1));
  if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start', behavior: 'instant' }));
})();
