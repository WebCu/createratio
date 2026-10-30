'use strict';
const extensionAPI = globalThis.browser || globalThis.chrome;
if (typeof importScripts === 'function') importScripts('sites.js', 'core.js', 'messages.js', 'message-contracts.js', 'blocker.js', 'history.js', 'web-time.js', 'updates.js');

let queue = Promise.resolve();
function serialized(task) {
  const next = queue.then(task); queue = next.catch(() => {}); return next;
}
const contracts = MessageContracts.create(C3, extensionAPI.runtime, C3Sites);
const history = ActivityHistory.create(extensionAPI.storage.local, C3);
const websiteTime = WebTime.create(extensionAPI, serialized, C3, history);
const updates = ExtensionUpdates.create(extensionAPI, serialized, async () => { await websiteTime.tick(); await SiteAccess.reconcile(); });
async function badge(day) {
  const value = C3.score(C3.aggregate(day));
  await Promise.all([
    extensionAPI.action.setBadgeText({ text: C3.badgeText(value) }),
    extensionAPI.action.setBadgeBackgroundColor({ color: C3.scoreColor(value) }),
    extensionAPI.action.setTitle({ title: `CreateRatio - today's score: ${value.toFixed(2)}` })
  ]);
}
async function snapshot() {
  await history.prepare();
  const date = C3.localDate();
  const stored = await extensionAPI.storage.local.get([date, 'settings', '_historyGeneration']);
  const day = history.creationDay(stored[date]);
  await badge(day);
  return { ok: true, generation: stored._historyGeneration ?? null, date, day, settings: C3.settingsSnapshot(stored.settings), access: await SiteAccess.reconcile(), websiteTimeEnabled: websiteTime.enabled };
}
async function ingest(message, sender) {
  if (!contracts.creationSender(message, sender)) return { ok: false, error: 'Unsupported sender' };
  await history.prepare();
  const preferences = await extensionAPI.storage.local.get(['settings', '_historyGeneration']);
  if ((message.generation ?? null) !== (preferences._historyGeneration ?? null)) return snapshot();
  if (!C3.trackingEnabled(message.site, preferences.settings)) return snapshot();
  contracts.packet(message);
  const access = (await SiteAccess.reconcile())[message.site];
  if (access && !(access.enabled && (access.goalAllowed || access.remainingMs > 0))) return snapshot();
  await history.recordCreation(message);
  return snapshot();
}
async function readHistory(message, sender) {
  contracts.history(message, sender);
  return { ok: true, days: await history.read(message.kind, message.range) };
}
async function clearHistory(sender) {
  contracts.preferencesSender(sender);
  try { await history.clear(crypto.randomUUID()); }
  catch (error) {
    await websiteTime.start(true).catch(() => {});
    throw error;
  }
  await websiteTime.start(true);
  return snapshot();
}
async function handle(message, sender) {
  contracts.read(message, sender);
  if (message.type.startsWith('access-')) return SiteAccess.handle(message, sender);
  switch (message.type) {
    case 'ingest': return ingest(message, sender);
    case 'snapshot': return snapshot();
    case 'history': return readHistory(message, sender);
    case 'clear-history': return clearHistory(sender);
    case 'tracking':
      await SiteAccess.handle(message, sender);
      return snapshot();
    case 'scroll-friction-setting': {
      contracts.preferences(message, sender);
      const stored = await extensionAPI.storage.local.get('settings');
      await extensionAPI.storage.local.set({ settings: { ...stored.settings, scrollFrictionEnabled: message.enabled,
        scrollFrictionStrength: message.strength ?? C3.settingsSnapshot(stored.settings).scrollFrictionStrength } });
      return snapshot();
    }
    case 'website-time-setting':
      contracts.preferences(message, sender);
      return websiteTime.setEnabled(message.enabled);
    default: throw MessageContracts.refuse('Unknown message');
  }
}
extensionAPI.runtime.onMessage.addListener((message, sender, respond) => {
  const task = message?.type === 'update-apply' ? Promise.resolve().then(async () => {
    contracts.read(message, sender); contracts.updateSender(sender);
    return { ok: true, ...await updates.attempt(true) };
  }) : serialized(() => handle(message, sender));
  task.then(respond, error => {
    if (!error.expected) console.error('CreateRatio:', error);
    respond({ ok: false, error: error.message });
  });
  return true;
});
async function initialize() {
  if (extensionAPI.storage.local.setAccessLevel) {
    await extensionAPI.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
  if (!await extensionAPI.alarms.get('daily-badge')) await extensionAPI.alarms.create('daily-badge', { periodInMinutes: 1 });
  await SiteAccess.reconcile(true);
  await websiteTime.start();
  await snapshot();
}
extensionAPI.runtime.onInstalled.addListener(details => { updates.installed(details, serialized(initialize)).catch(console.error); });
extensionAPI.runtime.onStartup.addListener(() => { serialized(initialize).catch(console.error); });
extensionAPI.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'extension-update') void updates.attempt().catch(console.error);
  if (alarm.name === 'daily-badge') serialized(snapshot).catch(console.error);
  if (alarm.name === 'website-time') serialized(() => websiteTime.tick(alarm)).catch(console.error);
  if (alarm.name.startsWith('access-')) serialized(() => SiteAccess.reconcile()).catch(console.error);
});
extensionAPI.storage.onChanged.addListener((changes, area) => {
  const relevant = Object.fromEntries(Object.entries(changes).filter(([key]) => ['settings', '_access', '_historyGeneration'].includes(key)));
  if (!RuntimeMessages.shouldRefresh(relevant, area)) return;
  const patterns = extensionAPI.runtime.getManifest().content_scripts.flatMap(entry => entry.matches);
  if (!patterns.length) return;
  void extensionAPI.tabs.query({ url: [...new Set(patterns)] }).then(tabs => Promise.all(tabs.map(tab => extensionAPI.tabs.sendMessage(tab.id, { type: 'refresh' }).catch(() => {})))).catch(console.error);
});
const refreshAccess = () => { serialized(() => SiteAccess.reconcile()).catch(console.error); };
extensionAPI.tabs.onActivated?.addListener(refreshAccess);
extensionAPI.tabs.onRemoved?.addListener(refreshAccess);
extensionAPI.tabs.onUpdated?.addListener((_, change) => { if (change.url || change.status) refreshAccess(); });
extensionAPI.windows.onFocusChanged.addListener(refreshAccess);
serialized(async () => { await history.prepare(); await SiteAccess.reconcile(true); await websiteTime.start(); }).then(() => updates.start()).catch(console.error);
