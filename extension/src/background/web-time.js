(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WebTime = api;
})(globalThis, function () {
  'use strict';
  /** @type {chrome.permissions.Permissions} */
  const PERMISSIONS = { permissions: ['tabs', 'idle'] };
  function domainForURL(raw) {
    try {
      const url = new URL(raw);
      return ['http:', 'https:'].includes(url.protocol) ? url.hostname.replace(/^www\./, '') : null;
    } catch (_) {
      return null;
    }
  }
  function summarize(days = {}, dates = null) {
    const totals = new Map();
    for (const [date, sites] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (dates && !dates.includes(date))) continue;
      for (const [domain, sec] of Object.entries(sites)) {
        if (Number.isFinite(sec) && sec > 0) totals.set(domain, (totals.get(domain) || 0) + sec);
      }
    }
    return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  function shares(rows) {
    const total = rows.reduce((sum, [, sec]) => sum + sec, 0);
    const exact = rows.map(([, sec]) => (total > 0 ? (sec / total) * 100 : 0));
    const percents = exact.map(Math.floor);
    const missing = total > 0 ? 100 - percents.reduce((sum, value) => sum + value, 0) : 0;
    const byRemainder = exact
      .map((value, index) => index)
      .sort((a, b) => exact[b] - percents[b] - (exact[a] - percents[a]) || a - b);
    for (const index of byRemainder.slice(0, missing)) percents[index] += 1;
    return percents;
  }
  function duration(sec) {
    const seconds = Math.floor(sec);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  function csv(days = {}) {
    const rows = ['date,domain,seconds'];
    for (const date of Object.keys(days).sort()) {
      for (const [domain, sec] of summarize({ [date]: days[date] })) {
        const text = /^[=+\-@\t\r\n]/.test(domain) ? "'" + domain : domain;
        rows.push(`${date},"${text.replace(/"/g, '""')}",${sec.toFixed(3)}`);
      }
    }
    return rows.join('\r\n') + '\r\n';
  }
  function create(api, serialize, core, history) {
    const pendingLimit = Math.min(100, Math.floor(core.DELIVERY_LIMITS.receiptLimit / 4) - 1);
    let enabled = false,
      previous = null,
      pending = [],
      checkpointFailed = false,
      epoch = false;
    async function allowed() {
      return !!api.permissions && (await api.permissions.contains(PERMISSIONS));
    }
    async function checkpoint() {
      try {
        await api.storage.session?.set({
          _websiteTimeSample: previous,
          _websiteTimePending: pending,
          _websiteTimeEpoch: epoch
        });
        checkpointFailed = false;
      } catch (error) {
        checkpointFailed = true;
        throw error;
      }
    }
    function schedule(task) {
      return serialize(task).catch(error => console.error('CreateRatio website time:', error));
    }
    async function accrue(now) {
      const hadPending = pending.length > 0;
      const old = previous;
      previous = null;
      if (
        old &&
        typeof old.id === 'string' &&
        typeof old.domain === 'string' &&
        Number.isFinite(old.at) &&
        now > old.at &&
        now - old.at <= 75000 &&
        pending.length < pendingLimit
      ) {
        pending.push({ id: old.id, domain: old.domain, segments: core.splitInterval(old.at, now) });
      }
      try {
        while (pending.length) {
          const entry = pending[0];
          if (typeof entry.id === 'string') await history.recordWebsiteTime(entry.domain, entry.segments, entry.id);
          pending.shift();
        }
      } finally {
        if (hadPending || pending.length) await checkpoint();
      }
    }
    async function sample(now) {
      if (checkpointFailed || pending.length >= pendingLimit) return;
      const window = await api.windows.getLastFocused();
      if (!window.focused || window.type !== 'normal' || (await api.idle.queryState(30)) !== 'active') return;
      const [tab] = await api.tabs.query({ active: true, windowId: window.id });
      const domain = !tab?.incognito && domainForURL(tab?.url);
      if (domain) previous = { id: 'website:' + crypto.randomUUID(), domain, at: now };
    }
    async function tick(alarm = {}) {
      if (!enabled) return;
      if (!(await allowed())) {
        previous = null;
        enabled = false;
        await checkpoint();
        await api.storage.local.set({ _websiteTimeEnabled: false });
        await api.alarms.clear('website-time');
        return;
      }
      const now = Date.now();
      if (Number.isFinite(alarm.scheduledTime) && now - alarm.scheduledTime > 15000) previous = null;
      try {
        await accrue(now);
      } finally {
        try {
          await sample(now);
        } finally {
          await checkpoint();
        }
      }
    }
    async function updateMonitoring() {
      if (!enabled) {
        await api.alarms.clear('website-time');
        await checkpoint();
        return;
      }
      api.idle.setDetectionInterval(30);
      if (!(await api.alarms.get?.('website-time'))) await api.alarms.create('website-time', { periodInMinutes: 1 });
      if (!previous) await sample(Date.now());
      await checkpoint();
    }
    async function start(reset = false) {
      if (reset) {
        previous = null;
        pending = [];
      }
      const stored = await api.storage.local.get('_websiteTimeEnabled');
      epoch = (await api.storage.local.get('_historyReset'))._historyReset === true;
      const savedEpoch = (await api.storage.session?.get('_websiteTimeEpoch'))?._websiteTimeEpoch === true;
      previous =
        reset || savedEpoch !== epoch
          ? null
          : (await api.storage.session?.get('_websiteTimeSample'))?._websiteTimeSample || null;
      pending =
        reset || savedEpoch !== epoch
          ? []
          : (await api.storage.session?.get('_websiteTimePending'))?._websiteTimePending || [];
      enabled = stored._websiteTimeEnabled === true && (await allowed());
      if (!enabled) previous = null;
      await updateMonitoring();
    }
    async function setEnabled(value) {
      if (typeof value !== 'boolean')
        throw Object.assign(new Error('Invalid website tracking setting'), { expected: true });
      if (value && !(await allowed()))
        throw Object.assign(new Error('Allow the browser permissions to track all websites.'), { expected: true });
      if (enabled) await accrue(Date.now());
      try {
        await api.storage.local.set({ _websiteTimeEnabled: value });
      } catch (error) {
        if (enabled) await updateMonitoring().catch(error => console.error('CreateRatio website time:', error));
        throw error;
      }
      enabled = value;
      previous = null;
      await updateMonitoring();
      return { ok: true, enabled };
    }
    api.tabs.onActivated?.addListener(() => schedule(tick));
    api.tabs.onUpdated?.addListener((_, change) => {
      if (change.url || change.status) void schedule(tick);
    });
    api.tabs.onRemoved?.addListener(() => schedule(tick));
    api.windows?.onFocusChanged.addListener(() => schedule(tick));
    api.idle?.onStateChanged.addListener(() => schedule(tick));
    api.permissions?.onRemoved.addListener(() => schedule(tick));
    return {
      start,
      tick,
      setEnabled,
      get enabled() {
        return enabled;
      }
    };
  }
  return { PERMISSIONS, domainForURL, summarize, shares, duration, csv, create };
});
