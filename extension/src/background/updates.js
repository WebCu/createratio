(function (root, factory) {
  const updates = factory();
  if (typeof module === 'object' && module.exports) module.exports = updates;
  else root.ExtensionUpdates = updates;
})(globalThis, function () {
  'use strict';
  function matches(raw, patterns) {
    let url;
    try { url = new URL(raw); } catch (_) { return false; }
    return patterns.some(pattern => {
      const [scheme, address] = pattern.split('://'), host = address.split('/')[0];
      return url.protocol === scheme + ':' && (host.startsWith('*.') ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.hostname === host);
    });
  }
  function create(api, serialize, flush, environment = globalThis) {
    let pending = null, applying = null, installedHere = false;
    const entries = () => api.runtime.getManifest().content_scripts || [];
    async function tabs() {
      const patterns = [...new Set(entries().flatMap(entry => entry.matches))];
      return patterns.length ? (await api.tabs.query({ url: patterns })).filter(tab => Number.isInteger(tab.id) && matches(tab.url, patterns)) : [];
    }
    async function openPages() {
      if (api.runtime.getContexts) return (await api.runtime.getContexts({})).filter(context => context.contextType !== 'BACKGROUND');
      if (api.extension?.getViews) return api.extension.getViews().filter(view => view.location.pathname !== '/_generated_background_page.html');
      if (environment.clients) return environment.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      throw new Error('Unable to check open extension pages');
    }
    async function send(tab, message) {
      let timer;
      try {
        return await Promise.race([
          api.tabs.sendMessage(tab.id, message, { frameId: 0 }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Update preparation timed out')), 5000); })
        ]);
      } finally { clearTimeout(timer); }
    }
    async function restore() {
      for (const tab of await tabs()) {
        if (tab.status === 'loading') continue;
        try {
          const reply = await send(tab, { type: 'prepare-update', force: false });
          if (reply?.ready === false) continue;
          if (reply?.ready === true && (await send(tab, { type: 'commit-update' }))?.ready !== true) continue;
        } catch (error) {
          if (!/receiving end|establish connection|message port closed|context invalidated/i.test(error.message)) {
            console.error('CreateRatio: unable to prepare a website tab for recovery.', error); continue;
          }
        }
        for (const entry of entries().filter(entry => matches(tab.url, entry.matches))) {
          await api.scripting.executeScript({ target: { tabId: tab.id }, files: entry.js, world: entry.world || 'ISOLATED' }).catch(error => console.error('CreateRatio: unable to restore an updated website tab.', error));
        }
      }
    }
    async function apply(force) {
      if (!pending || !force && (await openPages()).length) return { applied: false };
      const clients = await tabs();
      let committed = false, reloaded = false;
      try {
        if (clients.some(tab => tab.status === 'loading')) return { applied: false };
        const replies = await Promise.all(clients.map(tab => send(tab, { type: 'prepare-update', force })));
        if (replies.some(reply => reply?.ready !== true)) return { applied: false };
        if (!force && (await openPages()).length) return { applied: false };
        await serialize(flush);
        const current = await tabs();
        if (JSON.stringify(current.map(tab => [tab.id, tab.url]).sort()) !== JSON.stringify(clients.map(tab => [tab.id, tab.url]).sort())) return { applied: false };
        committed = true;
        const stopped = await Promise.all(clients.map(tab => send(tab, { type: 'commit-update' })));
        if (stopped.some(reply => reply?.ready !== true)) return { applied: false };
        if (!force && (await openPages()).length) return { applied: false };
        await serialize(flush);
        api.runtime.reload(); reloaded = true;
        return { applied: true };
      } catch (_) { return { applied: false }; }
      finally {
        if (!reloaded) {
          if (committed) await restore();
          await Promise.all(clients.map(tab => send(tab, { type: 'resume-update' }).catch(() => {})));
        }
      }
    }
    function attempt(force = false) {
      if (!applying) applying = apply(force).finally(() => { applying = null; });
      return applying;
    }
    async function start() {
      const stored = await api.storage.local.get('_pendingUpdate');
      if (installedHere) return;
      pending = stored._pendingUpdate;
      if (pending) { await api.alarms.create('extension-update', { periodInMinutes: 1 }); await attempt(); }
    }
    async function available(details) {
      if (typeof details?.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(details.version)) return;
      pending = details.version;
      await api.storage.local.set({ _pendingUpdate: pending });
      await api.alarms.create('extension-update', { periodInMinutes: 1 });
      return attempt();
    }
    async function installed(details, initialized = Promise.resolve()) {
      if (details?.reason !== 'update') return initialized;
      installedHere = true; pending = null;
      await api.storage.local.remove('_pendingUpdate');
      await api.alarms.clear('extension-update');
      await initialized;
      await restore();
    }
    api.runtime.onUpdateAvailable?.addListener(details => { available(details).catch(console.error); });
    return { start, available, attempt, installed };
  }
  return { create };
});
