'use strict';

(() => {
  const userAgent = navigator.userAgent || '';
  const clientHints = navigator.userAgentData;
  const mobile = /Android|Mobile|iPhone|iPad|iPod/i.test(userAgent) || clientHints?.mobile ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (mobile) return;

  let browser;
  if (/Firefox\/\d/.test(userAgent) && !/SeaMonkey\//.test(userAgent)) {
    browser = 'firefox';
  } else if (/Chrome\/\d/.test(userAgent) &&
    !/Edg|OPR|Opera|Vivaldi|SamsungBrowser|YaBrowser|DuckDuckGo|Chromium|Brave/i.test(userAgent) &&
    !navigator.brave && (!clientHints || clientHints.brands?.some(item => item.brand === 'Google Chrome'))) {
    browser = 'chrome';
  }
  if (!browser) return;

  for (const actions of document.querySelectorAll('[data-install-actions]')) {
    for (const link of actions.querySelectorAll('[data-browser]')) {
      link.hidden = link.dataset.browser !== browser;
    }
  }
  for (const note of document.querySelectorAll('[data-browser-note]')) {
    note.textContent = `Recommended for your browser: ${browser === 'firefox' ? 'Firefox' : 'Chrome'}.`;
    note.hidden = false;
  }
  for (const instructions of document.querySelectorAll('[data-install-browser]')) {
    instructions.open = instructions.dataset.installBrowser === browser;
  }
})();
