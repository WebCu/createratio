'use strict';
(async () => {
  const link = document.getElementById('feedback');
  const note = document.getElementById('feedback-privacy');
  if (link.dataset.store !== 'chrome') {
    note.textContent = 'Store feedback is not configured for this browser yet.';
    return;
  }
  try {
    const info = await chrome.management.getSelf();
    if (info.installType === 'development') return;
    const id = chrome.runtime.id;
    if (!/^[a-p]{32}$/.test(id)) return;
    link.href = `https://chromewebstore.google.com/detail/${id}/reviews`;
    link.removeAttribute('aria-disabled');
    link.removeAttribute('tabindex');
    note.textContent = 'Opens Chrome Web Store · feedback is public. No activity data attached.';
  } catch {
    note.textContent = 'Store feedback is unavailable right now.';
  }
})();
