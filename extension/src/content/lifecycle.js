(() => {
  'use strict';
  if (globalThis.ContentLifecycle) return;
  const api = globalThis.browser || globalThis.chrome;
  const owners = new Map();
  let lease = null, generation = 0, prepared = false;
  function resume() {
    clearTimeout(lease); lease = null; generation++; prepared = false;
    for (const owner of owners.values()) owner.resume();
  }
  async function handle(message) {
    if (message.type === 'resume-update') { resume(); return { ready: true }; }
    if (message.type === 'commit-update') {
      if (!prepared) return { ready: false };
      clearTimeout(lease); lease = null; generation++; prepared = false;
      for (const owner of owners.values()) owner.stop();
      owners.clear(); api.runtime.onMessage.removeListener(receive);
      delete globalThis.ContentLifecycle;
      return { ready: true };
    }
    const current = ++generation;
    prepared = false; clearTimeout(lease); lease = setTimeout(resume, 10000);
    try {
      for (const owner of owners.values()) {
        if (current !== generation) return { ready: false };
        const ready = await owner.prepare(message.force === true);
        if (current !== generation) { owner.resume(); return { ready: false }; }
        if (!ready) { resume(); return { ready: false }; }
      }
      prepared = true; return { ready: true };
    } catch (_) { resume(); return { ready: false }; }
  }
  function receive(message, sender, respond) {
    if (sender.id !== api.runtime.id || !['prepare-update', 'resume-update', 'commit-update'].includes(message?.type)) return;
    handle(message).then(respond);
    return true;
  }
  api.runtime.onMessage.addListener(receive);
  globalThis.ContentLifecycle = { register(name, owner) {
    if (!['guard', 'tracker'].includes(name)) throw new Error('Unknown content owner');
    owners.get(name)?.stop(); owners.set(name, owner);
  } };
})();
