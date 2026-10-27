(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const notice = document.getElementById('update-notice'), button = document.getElementById('update-apply'), status = document.getElementById('update-status');
  const messages = RuntimeMessages.create(api.runtime);
  function show(version) { notice.hidden = typeof version !== 'string' || !version; }
  api.storage.local.get('_pendingUpdate').then(stored => show(stored._pendingUpdate)).catch(() => {});
  api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes._pendingUpdate) show(changes._pendingUpdate.newValue); });
  button.addEventListener('click', async () => {
    if (button.disabled || !confirm('Update CreateRatio now? Save any unsaved settings or intention drafts in all CreateRatio pages first. Website tabs will not reload.')) return;
    button.disabled = true; status.textContent = 'Saving measurements before updating…';
    try {
      const result = await messages.send({ type: 'update-apply' }, 'Unable to install the update. Please try again.');
      if (!result.applied) { status.textContent = 'A tab could not finish saving. Try again in a moment, or fully quit and reopen your browser.'; button.disabled = false; }
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  });
})();
