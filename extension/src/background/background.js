'use strict';
const extensionAPI = globalThis.browser || globalThis.chrome;
if (typeof importScripts === 'function') importScripts('sites.js', 'core.js', 'message-contracts.js', 'blocker.js', 'history.js', 'web-time.js');

let queue = Promise.resolve();
function serialized(task) {
  const next = queue.then(task); queue = next.catch(() => {}); return next;
}
const contracts = MessageContracts.create(C3, extensionAPI.runtime, C3Sites);
const history = ActivityHistory.create(extensionAPI.storage.local, C3);
const websiteTime = WebTime.create(extensionAPI, serialized, C3, history);
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
  await websiteTime.tick();
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
  await websiteTime.tick();
  return { ok: true, days: await history.read(message.kind, message.range) };
}
async function clearHistory(sender) {
  contracts.preferencesSender(sender);
  try { await history.clear(crypto.randomUUID()); }
  catch (error) {
    await websiteTime.start().catch(() => {});
    throw error;
  }
  await websiteTime.start();
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
        ...(message.strength === undefined ? {} : { scrollFrictionStrength: message.strength }) } });
      return snapshot();
    }
    case 'website-time-setting':
      contracts.preferences(message, sender);
      return websiteTime.setEnabled(message.enabled);
    default: throw MessageContracts.refuse('Unknown message');
  }
}
extensionAPI.runtime.onMessage.addListener((message, sender, respond) => {
  serialized(() => handle(message, sender)).then(respond, error => {
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
extensionAPI.runtime.onInstalled.addListener(() => { serialized(initialize).catch(console.error); });
extensionAPI.runtime.onStartup.addListener(() => { serialized(initialize).catch(console.error); });
extensionAPI.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'daily-badge') serialized(snapshot).catch(console.error);
  if (alarm.name === 'website-time') serialized(() => websiteTime.tick()).catch(console.error);
  if (alarm.name.startsWith('access-')) serialized(() => SiteAccess.reconcile()).catch(console.error);
});
const refreshAccess = () => { serialized(() => SiteAccess.reconcile()).catch(console.error); };
extensionAPI.tabs.onActivated?.addListener(refreshAccess);
extensionAPI.tabs.onRemoved?.addListener(refreshAccess);
extensionAPI.tabs.onUpdated?.addListener((_, change) => { if (change.url || change.status) refreshAccess(); });
extensionAPI.windows.onFocusChanged.addListener(refreshAccess);
serialized(async () => { await history.prepare(); await SiteAccess.reconcile(true); await websiteTime.start(); }).catch(console.error);
