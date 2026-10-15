'use strict';
const SiteAccess = (() => {
  const WAIT_MS = 60000, REQUEST_MS = 600000;
  const MAX_BUDGET_MS = C3.ACCESS_LIMITS.maxMinutes * 60000;
  function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function accessState(value) { return record(value) ? value : {}; }
  function validSession(entry, now) {
    return record(entry) && (!Object.hasOwn(entry, 'date') || C3.validLocalDate(entry.date))
      && ['remainingMs', 'expiresAt', 'refilledAt'].every(field => !Object.hasOwn(entry, field) || Number.isFinite(entry[field]) && entry[field] >= 0)
      && (!Object.hasOwn(entry, 'remainingMs') || entry.remainingMs <= MAX_BUDGET_MS)
      && (Object.hasOwn(entry, 'remainingMs') || !Object.hasOwn(entry, 'expiresAt') || entry.expiresAt - now <= MAX_BUDGET_MS);
  }
  function savedIntentions(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(entry => record(entry) && typeof entry.site === 'string' && /^[a-z][a-z0-9_-]*$/.test(entry.site) && typeof entry.reason === 'string' && entry.reason.trim().length > 0 && entry.reason.length <= C3.INTENTION_LIMITS.maxLength && Number.isFinite(entry.requestedAt) && entry.requestedAt >= 0);
  }
  const SITES = Object.fromEntries(C3Sites.sites.filter(site => site.gated).map(site => [site.id, { name: site.name, ...C3Sites.get(site.id).access }]));
  const api = globalThis.browser || globalThis.chrome;
  const contracts = MessageContracts.create(C3, api.runtime, C3Sites);
  function siteForURL(raw) { return C3Sites.forAccessURL(raw)?.id || null; }
  function gateURL(site) { return api.runtime.getURL('blocked.html') + '?site=' + site; }
  function ruleIds(site) { return SITES[site].ruleIds; }
  function status(site, entry = {}, now = Date.now(), minutes = C3.DEFAULT_SETTINGS.accessMinutes, enabled = true, goalAllowed = false) {
    if (!Object.hasOwn(SITES, site)) throw new Error('Unsupported site');
    const remainingMs = Number.isFinite(entry.remainingMs) ? Math.max(0, entry.remainingMs) : 0;
    const expiresAt = remainingMs && entry.expiresAt > now ? entry.expiresAt : 0;
    const readyAt = !remainingMs && validWait(entry, now) ? entry.readyAt : 0;
    return { site, enabled, goalAllowed: enabled && goalAllowed, name: SITES[site].name, home: SITES[site].home, remainingMs, expiresAt, readyAt, requestExpiresAt: readyAt ? entry.requestExpiresAt : 0, refilledAt: entry.refilledAt || 0, waitSeconds: WAIT_MS / 1000, sessionMinutes: minutes };
  }
  function validWait(entry, now) {
    return Number.isFinite(entry.readyAt) && entry.readyAt > 0 && Number.isFinite(entry.requestExpiresAt) && entry.requestExpiresAt > entry.readyAt && entry.requestExpiresAt > now && entry.requestExpiresAt - entry.readyAt <= REQUEST_MS && entry.readyAt <= now + WAIT_MS;
  }
  async function closeTabs(site) {
    const patterns = SITES[site].domains.flatMap(domain => ['http://*.' + domain + '/*', 'https://*.' + domain + '/*']);
    const tabs = await api.tabs.query({ url: patterns });
    await Promise.all(tabs.filter(tab => siteForURL(tab.url) === site).map(tab => api.tabs.update(tab.id, { url: gateURL(site) }).catch(() => {})));
  }
  async function reconcile(closeAll = false) {
    const restart = !(await api.storage.session.get('_accessInitialized'))._accessInitialized;
    const now = Date.now(), clock = new Date(now), date = C3.localDate(clock);
    const stored = await api.storage.local.get(['_access', 'settings', date]);
    const goalAllowed = stored.settings?.allowAboveGoal === true && C3.score(C3.aggregate(stored[date])) > C3.dailyTarget(stored.settings);
    const current = await api.declarativeNetRequest.getSessionRules();
    const access = accessState(stored._access), original = JSON.stringify(stored._access === undefined ? {} : stored._access);
    const dayStart = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate()).getTime();
    const midnight = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate() + 1).getTime();
    const window = await api.windows.getLastFocused();
    const [tab] = window.focused && window.type === 'normal' ? await api.tabs.query({ active: true, windowId: window.id }) : [];
    const activeSite = siteForURL(tab?.url);
    const rules = [], expired = [];
    for (const [site, definition] of Object.entries(SITES)) {
      if (!C3.trackingEnabled(site, stored.settings)) {
        rules.push(...definition.unrestrictedRules);
        delete access[site]; await api.alarms.clear('access-' + site);
        continue;
      }
      if (Object.hasOwn(access, site) && !validSession(access[site], now)) delete access[site];
      const entry = access[site] || {}, minutes = C3.siteSettings(site, stored.settings).accessMinutes;
      const hadSession = Number.isFinite(entry.remainingMs) || Number.isFinite(entry.expiresAt);
      if (!Number.isFinite(entry.remainingMs) && Number.isFinite(entry.expiresAt)) entry.remainingMs = Math.max(0, entry.expiresAt - now);
      if (entry.date && entry.date !== date) {
        const runningAtMidnight = !restart && entry.expiresAt >= dayStart;
        entry.remainingMs = minutes * 60000;
        entry.refilledAt = dayStart;
        entry.expiresAt = runningAtMidnight ? dayStart + entry.remainingMs : 0;
      }
      if (entry.remainingMs > 0) entry.date = date;
      if (!restart && entry.expiresAt) entry.remainingMs = Math.min(entry.remainingMs, Math.max(0, entry.expiresAt - now));
      if (goalAllowed || entry.remainingMs > 0) {
        entry.expiresAt = !goalAllowed && activeSite === site ? now + entry.remainingMs : 0;
        rules.push(...definition.sessionRules);
        if (entry.expiresAt) await api.alarms.create('access-' + site, { when: entry.expiresAt });
        else await api.alarms.clear('access-' + site);
      } else {
        if (hadSession || closeAll || current.some(rule => ruleIds(site).includes(rule.id))) expired.push(site);
        delete entry.expiresAt;
        delete entry.remainingMs;
        await api.alarms.clear('access-' + site);
      }
      if (!validWait(entry, now)) { delete entry.readyAt; delete entry.requestExpiresAt; }
    }
    const keys = list => list.map(rule => JSON.stringify([rule.id, rule.priority, rule.action.type, [...rule.condition.requestDomains].sort(), [...(rule.condition.initiatorDomains || [])].sort(), [...(rule.condition.resourceTypes || [])].sort(), [...(rule.condition.excludedResourceTypes || [])].sort()])).sort();
    if (JSON.stringify(keys(current)) !== JSON.stringify(keys(rules))) await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: Object.keys(SITES).flatMap(ruleIds), addRules: rules });
    if (JSON.stringify(access) !== original) await api.storage.local.set({ _access: access });
    if (Object.keys(SITES).some(site => access[site]?.date)) await api.alarms.create('access-midnight', { when: midnight });
    else await api.alarms.clear('access-midnight');
    await Promise.all(expired.map(closeTabs));
    if (restart) await api.storage.session.set({ _accessInitialized: true });
    return Object.fromEntries(Object.keys(SITES).map(site => [site, status(site, access[site], now, C3.siteSettings(site, stored.settings).accessMinutes, C3.trackingEnabled(site, stored.settings), goalAllowed)]));
  }
  async function setGoalAccess(message, sender) {
    contracts.preferences(message, sender);
    const stored = await api.storage.local.get('settings');
    await api.storage.local.set({ settings: { ...stored.settings, allowAboveGoal: message.enabled } });
    return { ok: true, access: await reconcile() };
  }
  async function setIntentionHistory(message, sender) {
    contracts.preferences(message, sender);
    const stored = await api.storage.local.get('settings');
    await api.storage.local.set({ settings: { ...stored.settings, intentionHistoryEnabled: message.enabled } });
    return { ok: true };
  }
  async function manageIntentions(message, sender) {
    contracts.intentions(sender);
    if (message.type === 'access-history-list') {
      const stored = await api.storage.local.get('_intentions');
      return { ok: true, intentions: savedIntentions(stored._intentions) };
    }
    await api.storage.local.set({ _intentions: [] });
    return { ok: true };
  }
  async function setDuration(message, sender) {
    contracts.preferences(message, sender);
    const stored = await api.storage.local.get('settings');
    const settings = C3.updatePreferences(stored.settings, { accessMinutes: message.minutes }, message.site);
    await api.storage.local.set({ settings });
    return { ok: true, access: await reconcile() };
  }
  async function setTracking(message, sender) {
    contracts.preferences(message, sender);
    const stored = await api.storage.local.get('settings');
    const settings = { ...C3.DEFAULT_SETTINGS, ...stored.settings };
    const enabled = new Set(C3.settingsSnapshot(stored.settings).trackedSites);
    if (message.enabled) enabled.add(message.site); else enabled.delete(message.site);
    settings.trackedSites = C3.SITES.filter(site => enabled.has(site.id)).map(site => site.id);
    await api.storage.local.set({ settings });
    try { await reconcile(true); }
    catch (error) {
      await api.storage.local.set({ settings: stored.settings || C3.DEFAULT_SETTINGS });
      await reconcile().catch(() => {});
      throw error;
    }
    return { ok: true };
  }
  async function readAccessStatus() {
    const access = await reconcile();
    const stored = await api.storage.local.get('settings');
    return { ok: true, access, intentionHistoryEnabled: stored.settings?.intentionHistoryEnabled === true };
  }
  async function beginWait(message, state, stored, now) {
    if (!C3.validIntention(message.reason)) return { ok: false, error: `Write a specific intention of ${C3.INTENTION_LIMITS.minLength}–${C3.INTENTION_LIMITS.maxLength} characters.` };
    if (state.remainingMs || state.readyAt) return;
    const site = message.site, access = accessState(stored._access);
    access[site] = { readyAt: now + WAIT_MS, requestExpiresAt: now + WAIT_MS + REQUEST_MS };
    const changes = { _access: access };
    if (stored.settings?.intentionHistoryEnabled === true) changes._intentions = [...savedIntentions(stored._intentions), { site, reason: message.reason.trim(), requestedAt: now }].slice(-100);
    await api.storage.local.set(changes);
  }
  async function confirmAccess(site, state, access, now) {
    const entry = access[site] || {};
    if (!state.readyAt || now < entry.readyAt) throw MessageContracts.refuse('Finish the waiting period before opening the site.');
    access[site] = { remainingMs: state.sessionMinutes * 60000, expiresAt: 0, refilledAt: now };
    await api.storage.local.set({ _access: access });
  }
  async function cancelWait(site, state, access) {
    if (state.remainingMs) return;
    delete access[site];
    await api.storage.local.set({ _access: access });
  }
  async function endAccess(site, access) {
    delete access[site];
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds(site) });
    await api.storage.local.set({ _access: access });
    await api.alarms.clear('access-' + site);
    await closeTabs(site);
  }
  async function handleSession(message, sender) {
    const statuses = await reconcile();
    contracts.session(message, sender);
    const site = message.site, state = statuses[site];
    if (state.enabled === false && ['access-begin', 'access-open', 'access-cancel', 'access-end'].includes(message.type)) return { ok: true, access: statuses };
    if (state.goalAllowed) {
      if (message.type === 'access-end') throw MessageContracts.refuse('Turn off goal-based access in Settings to block sites above the goal.');
      if (['access-open', 'access-begin', 'access-cancel'].includes(message.type)) return { ok: true, access: statuses };
    }
    const stored = await api.storage.local.get(['_access', 'settings', '_intentions']), access = accessState(stored._access), now = Date.now();
    switch (message.type) {
      case 'access-begin': {
        const rejection = await beginWait(message, state, stored, now);
        if (rejection) return rejection;
        break;
      }
      case 'access-open':
        if (state.remainingMs) return { ok: true, access: statuses };
        await confirmAccess(site, state, access, now);
        break;
      case 'access-cancel':
        await cancelWait(site, state, access);
        break;
      case 'access-end':
        await endAccess(site, access);
        break;
      default: throw MessageContracts.refuse('Unknown access message');
    }
    return { ok: true, access: await reconcile() };
  }
  async function handle(message, sender) {
    switch (message.type) {
      case 'tracking': return setTracking(message, sender);
      case 'access-goal-setting': return setGoalAccess(message, sender);
      case 'access-history-setting': return setIntentionHistory(message, sender);
      case 'access-history-clear':
      case 'access-history-list': return manageIntentions(message, sender);
      case 'access-duration': return setDuration(message, sender);
      case 'access-status': return readAccessStatus();
      default: return handleSession(message, sender);
    }
  }
  return { handle, reconcile, siteForURL, gateURL };
})();
