'use strict';
/** @type {SiteAccessApi} */
const SiteAccess = (() => {
  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function accessState(value) {
    return record(value) ? value : {};
  }
  function savedIntentions(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(
      entry =>
        record(entry) &&
        typeof entry.site === 'string' &&
        /^[a-z][a-z0-9_-]*$/.test(entry.site) &&
        typeof entry.reason === 'string' &&
        entry.reason.trim().length > 0 &&
        entry.reason.length <= Core.INTENTION_LIMITS.maxLength &&
        Number.isFinite(entry.requestedAt) &&
        entry.requestedAt >= 0
    );
  }
  const SITES = Object.fromEntries(
    Sites.sites.filter(site => site.gated).map(site => [site.id, { name: site.name, ...Sites.get(site.id).access }])
  );
  const api = globalThis.browser || globalThis.chrome;
  /** @type {(tab: chrome.tabs.Tab) => Promise<void>} */
  let beforeNavigate = async () => {};
  function setBeforeNavigate(handler) {
    beforeNavigate = handler;
  }
  const contracts = MessageContracts.create(Core, api.runtime, Sites);
  function siteForURL(raw) {
    return Sites.forAccessURL(raw)?.id || null;
  }
  function gateURL(site) {
    return api.runtime.getURL('blocked.html') + '?site=' + site;
  }
  function updateWindows(windows, site, now, end) {
    const entries = Array.isArray(windows[site])
      ? windows[site].filter(
          item =>
            record(item) &&
            Number.isFinite(item.start) &&
            Number.isFinite(item.end) &&
            item.start >= 0 &&
            item.end > item.start
        )
      : [];
    const last = entries.at(-1);
    if (last && last.start <= now && last.end >= now) {
      for (const entry of entries) if (entry.start <= now && entry.end >= now) entry.end = Math.min(entry.end, end);
      last.end = end;
    } else if (end > now) entries.push({ start: now, end });
    const retained = entries.filter(entry => entry.end > entry.start);
    if (retained.length) windows[site] = retained.slice(-Core.DELIVERY_LIMITS.receiptLimit);
    else delete windows[site];
  }
  async function creationPacket(packet, access) {
    if (!access[packet.site]) return packet;
    const stored = await api.storage.local.get('_accessWindows');
    const windows = stored._accessWindows?.[packet.site] || [];
    const legacyAllowed =
      access[packet.site].enabled && (access[packet.site].goalAllowed || access[packet.site].remainingMs > 0);
    if (!windows.length && legacyAllowed)
      windows.push({
        start: 0,
        end: access[packet.site].goalAllowed
          ? Number.MAX_SAFE_INTEGER
          : access[packet.site].expiresAt || Date.now() + access[packet.site].remainingMs
      });
    const coverage = [];
    for (const window of windows.slice().sort((a, b) => a.start - b.start)) {
      const last = coverage.at(-1);
      if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
      else coverage.push({ ...window });
    }
    const segments = packet.segments.flatMap(segment => {
      if (segment.start === undefined) return legacyAllowed ? [segment] : [];
      return coverage.flatMap(window => {
        const start = Math.max(segment.start, window.start),
          end = Math.min(segment.end, window.end);
        return end > start ? [{ ...segment, start, end, sec: (end - start) / 1000 }] : [];
      });
    });
    const actions = packet.actions.filter(action =>
      action.at === undefined
        ? legacyAllowed
        : windows.some(window => action.at >= window.start && action.at < window.end)
    );
    return { ...packet, segments, actions };
  }
  function ruleIds(site) {
    return SITES[site].ruleIds;
  }
  /**
   * @param {string} site
   * @param {ReturnType<typeof SiteAccessModel.siteAccessFromStored>} state
   */
  function status(
    site,
    state = null,
    now = Date.now(),
    minutes = Core.DEFAULT_SETTINGS.accessMinutes,
    enabled = true,
    goalAllowed = false,
    waitMinutes = Core.DEFAULT_SETTINGS.waitMinutes
  ) {
    if (!Object.hasOwn(SITES, site)) throw new Error('Unsupported site');
    const session = state?.phase === 'session' ? state : null,
      request = state?.phase === 'request' ? state : null;
    const remainingMs = Core.asMilliseconds(session?.remainingMs ?? 0);
    const expiresAt = remainingMs && session.expiresAt > now ? session.expiresAt : 0;
    const readyAt = request ? request.readyAt : 0;
    const waitSeconds = request
      ? Core.secondsFromMilliseconds(SiteAccessModel.waitDuration(request))
      : Core.secondsFromMinutes(waitMinutes);
    return {
      site,
      enabled,
      goalAllowed: enabled && goalAllowed,
      name: SITES[site].name,
      home: SITES[site].home,
      remainingMs,
      expiresAt,
      readyAt,
      refilledAt: session?.refilledAt || 0,
      waitSeconds,
      sessionMinutes: minutes
    };
  }
  async function closeTabs(site) {
    const patterns = SITES[site].domains.flatMap(domain => ['http://*.' + domain + '/*', 'https://*.' + domain + '/*']);
    const tabs = await api.tabs.query({ url: patterns });
    const navigated = await Promise.all(
      tabs
        .filter(tab => siteForURL(tab.url) === site)
        .map(async tab => {
          try {
            await beforeNavigate(tab);
          } catch (error) {
            console.warn('CreateRatio: unable to drain tracker.', error.message);
          }
          try {
            await api.tabs.update(tab.id, { url: gateURL(site) });
            return tab.id;
          } catch (_) {
            return null;
          }
        })
    );
    return navigated.filter(id => id !== null);
  }
  async function reconcile(closeAll = false) {
    const restart = !(await api.storage.session.get('_accessInitialized'))._accessInitialized;
    const now = Date.now(),
      clock = new Date(now),
      date = Core.localDate(clock);
    const stored = /** @type {StoredData} */ (
      await api.storage.local.get(['_access', '_accessWindows', 'settings', date])
    );
    const windows = accessState(stored._accessWindows),
      originalWindows = JSON.stringify(windows);
    const goalAllowed =
      stored.settings?.allowAboveGoal === true &&
      Core.score(Core.aggregate(stored[date])) > Core.dailyTarget(stored.settings);
    const current = await api.declarativeNetRequest.getSessionRules();
    const access = accessState(stored._access);
    const dayStart = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate()).getTime();
    const midnight = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate() + 1).getTime();
    const window = await api.windows.getLastFocused();
    const [tab] =
      window.focused && (window.type === 'normal' || window.type === 'popup')
        ? await api.tabs.query({ active: true, windowId: window.id })
        : [];
    const activeSite = siteForURL(tab?.url);
    const rules = [],
      expired = [],
      states = {};
    let accessChanged = stored._access !== undefined && !record(stored._access);
    for (const [site, definition] of Object.entries(SITES)) {
      const settings = Core.siteSettings(site, stored.settings);
      const decision = SiteAccessModel.reconcileSiteAccess(SiteAccessModel.siteAccessFromStored(access[site], now), {
        now,
        date,
        dayStart,
        midnight,
        restart,
        enabled: Core.trackingEnabled(site, stored.settings),
        goalAllowed,
        focused: activeSite === site,
        accessMinutes: settings.accessMinutes,
        hasRules: current.some(rule => ruleIds(site).includes(rule.id)),
        hasWindows: Boolean(windows[site]),
        closeAll
      });
      if (decision.rules === 'unrestricted') rules.push(...definition.unrestrictedRules);
      else if (decision.rules === 'session') rules.push(...definition.sessionRules);
      if (decision.alarmAt) await api.alarms.create('access-' + site, { when: decision.alarmAt });
      else await api.alarms.clear('access-' + site);
      if (decision.expire) expired.push(site);
      if (decision.clearWindows) delete windows[site];
      else if (decision.window) updateWindows(windows, site, decision.window.start, decision.window.end);
      const before = access[site],
        after = SiteAccessModel.storedFromSiteAccess(decision.state);
      if (!SiteAccessModel.sameStoredEntry(before, after)) accessChanged = true;
      if (after === undefined) delete access[site];
      else access[site] = after;
      states[site] = decision.state;
    }
    const keys = list =>
      list
        .map(rule =>
          JSON.stringify([
            rule.id,
            rule.priority,
            rule.action.type,
            [...rule.condition.requestDomains].sort(),
            [...(rule.condition.initiatorDomains || [])].sort(),
            [...(rule.condition.resourceTypes || [])].sort(),
            [...(rule.condition.excludedResourceTypes || [])].sort()
          ])
        )
        .sort();
    if (JSON.stringify(keys(current)) !== JSON.stringify(keys(rules)))
      await api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: Object.keys(SITES).flatMap(ruleIds),
        addRules: rules
      });
    const changes = {
      ...(accessChanged ? { _access: access } : {}),
      ...(JSON.stringify(windows) !== originalWindows ? { _accessWindows: windows } : {})
    };
    if (Object.keys(changes).length) await api.storage.local.set(changes);
    if (Object.keys(SITES).some(site => access[site]?.date))
      await api.alarms.create('access-midnight', { when: midnight });
    else await api.alarms.clear('access-midnight');
    await Promise.all(expired.map(closeTabs));
    if (restart) await api.storage.session.set({ _accessInitialized: true });
    return Object.fromEntries(
      Object.keys(SITES).map(site => [
        site,
        status(
          site,
          states[site],
          now,
          Core.siteSettings(site, stored.settings).accessMinutes,
          Core.trackingEnabled(site, stored.settings),
          goalAllowed,
          Core.siteSettings(site, stored.settings).waitMinutes
        )
      ])
    );
  }
  async function setGoalAccess(message, sender) {
    contracts.preferences(message, sender);
    const stored = /** @type {StoredData} */ (await api.storage.local.get('settings'));
    await api.storage.local.set({ settings: { ...stored.settings, allowAboveGoal: message.enabled } });
    return { ok: true, access: await reconcile() };
  }
  async function setIntentionHistory(message, sender) {
    contracts.preferences(message, sender);
    const stored = /** @type {StoredData} */ (await api.storage.local.get('settings'));
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
    const stored = /** @type {StoredData} */ (await api.storage.local.get('settings'));
    const settings = Core.updatePreferences(
      stored.settings,
      { [message.preference || 'accessMinutes']: message.minutes },
      message.site
    );
    await api.storage.local.set({ settings });
    return { ok: true, access: await reconcile() };
  }
  async function setTracking(message, sender) {
    contracts.preferences(message, sender);
    const stored = /** @type {StoredData} */ (await api.storage.local.get('settings'));
    const settings = { ...Core.DEFAULT_SETTINGS, ...stored.settings };
    const enabled = new Set(Core.settingsSnapshot(stored.settings).trackedSites);
    if (message.enabled) enabled.add(message.site);
    else enabled.delete(message.site);
    settings.trackedSites = Core.SITES.filter(site => enabled.has(site.id)).map(site => site.id);
    await api.storage.local.set({ settings });
    try {
      await reconcile(true);
    } catch (error) {
      await api.storage.local.set({ settings: stored.settings || Core.DEFAULT_SETTINGS });
      await reconcile().catch(() => {});
      throw error;
    }
    return { ok: true };
  }
  async function readAccessStatus(sender) {
    const access = await reconcile();
    const site = sender?.frameId === 0 && sender?.tab && siteForURL(sender.url);
    const navigated =
      site && access[site].enabled && !access[site].goalAllowed && !access[site].remainingMs
        ? await closeTabs(site)
        : [];
    const stored = /** @type {StoredData} */ (await api.storage.local.get('settings'));
    return {
      ok: true,
      access,
      intentionHistoryEnabled: stored.settings?.intentionHistoryEnabled === true,
      navigationHandled: navigated.includes(sender?.tab?.id)
    };
  }
  async function beginWait(message, stored, now) {
    if (!Core.validIntention(message.reason))
      return {
        ok: false,
        error: `Write a specific intention of ${Core.INTENTION_LIMITS.minLength}–${Core.INTENTION_LIMITS.maxLength} characters.`
      };
    const site = message.site,
      access = accessState(stored._access);
    const current = SiteAccessModel.siteAccessFromStored(access[site], now);
    const waitMs = Core.millisecondsFromMinutes(Core.siteSettings(site, stored.settings).waitMinutes);
    const next = SiteAccessModel.requestAccess(current, waitMs, now);
    if (next === current) return;
    access[site] = SiteAccessModel.storedFromSiteAccess(next);
    const changes = { _access: access };
    if (stored.settings?.intentionHistoryEnabled === true)
      changes._intentions = [
        ...savedIntentions(stored._intentions),
        { site, reason: message.reason.trim(), requestedAt: now }
      ].slice(-100);
    await api.storage.local.set(changes);
  }
  async function confirmAccess(site, state, access, now) {
    const confirmed = SiteAccessModel.confirmRequest(
      SiteAccessModel.siteAccessFromStored(access[site], now),
      state.sessionMinutes,
      now
    );
    if (!confirmed.ready) throw MessageContracts.refuse('Finish the waiting period before opening the site.');
    access[site] = SiteAccessModel.storedFromSiteAccess(confirmed.state);
    await api.storage.local.set({ _access: access });
  }
  async function cancelWait(site, access, now) {
    const current = SiteAccessModel.siteAccessFromStored(access[site], now);
    if (SiteAccessModel.cancelRequest(current) === current) return;
    delete access[site];
    await api.storage.local.set({ _access: access });
  }
  async function endAccess(site, access) {
    const stored = await api.storage.local.get('_accessWindows');
    const windows = accessState(stored._accessWindows);
    updateWindows(windows, site, Date.now(), Date.now());
    delete access[site];
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds(site) });
    await api.storage.local.set({ _access: access, _accessWindows: windows });
    await api.alarms.clear('access-' + site);
    await closeTabs(site);
  }
  async function handleSession(message, sender) {
    const statuses = await reconcile();
    contracts.session(message, sender);
    const site = message.site,
      state = statuses[site];
    if (
      state.enabled === false &&
      ['access-begin', 'access-open', 'access-cancel', 'access-end'].includes(message.type)
    )
      return { ok: true, access: statuses };
    if (state.goalAllowed) {
      if (message.type === 'access-end')
        throw MessageContracts.refuse('Turn off goal-based access in Settings to block sites above the goal.');
      if (['access-open', 'access-begin'].includes(message.type)) return { ok: true, access: statuses };
    }
    const stored = /** @type {StoredData} */ (await api.storage.local.get(['_access', 'settings', '_intentions'])),
      access = accessState(stored._access),
      now = Date.now();
    switch (message.type) {
      case 'access-begin': {
        const rejection = await beginWait(message, stored, now);
        if (rejection) return rejection;
        break;
      }
      case 'access-open':
        if (state.remainingMs) return { ok: true, access: statuses };
        await confirmAccess(site, state, access, now);
        break;
      case 'access-cancel':
        await cancelWait(site, access, now);
        break;
      case 'access-end':
        await endAccess(site, access);
        break;
      default:
        throw MessageContracts.refuse('Unknown access message');
    }
    return { ok: true, access: await reconcile() };
  }
  async function handle(message, sender) {
    switch (message.type) {
      case 'tracking':
        return setTracking(message, sender);
      case 'access-goal-setting':
        return setGoalAccess(message, sender);
      case 'access-history-setting':
        return setIntentionHistory(message, sender);
      case 'access-history-clear':
      case 'access-history-list':
        return manageIntentions(message, sender);
      case 'access-duration':
        return setDuration(message, sender);
      case 'access-status':
        return readAccessStatus(sender);
      default:
        return handleSession(message, sender);
    }
  }
  return { handle, reconcile, siteForURL, gateURL, creationPacket, setBeforeNavigate };
})();
