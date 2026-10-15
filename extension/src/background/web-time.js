(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WebTime = api;
})(globalThis, function () {
  'use strict';
  const PERMISSIONS = { permissions: ['tabs', 'idle'] };
  function domainForURL(raw) {
    try {
      const url = new URL(raw);
      return ['http:', 'https:'].includes(url.protocol) ? url.hostname.replace(/^www\./, '') : null;
    } catch (_) { return null; }
  }
  function summarize(days = {}, dates = null) {
    const totals = new Map();
    for (const [date, sites] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dates && !dates.includes(date)) continue;
      for (const [domain, sec] of Object.entries(sites)) {
        if (Number.isFinite(sec) && sec > 0) totals.set(domain, (totals.get(domain) || 0) + sec);
      }
    }
    return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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
  function create(api, serialize, core, history, timers = globalThis) {
    let enabled = false, previous = null, interval = null;
    async function allowed() { return !!api.permissions && await api.permissions.contains(PERMISSIONS); }
    function resetTimer() {
      if (interval !== null) timers.clearInterval(interval);
      interval = enabled ? timers.setInterval(() => schedule(tick), 5000) : null;
    }
    function schedule(task) { return serialize(task).catch(error => console.error('CreateRatio website time:', error)); }
    async function accrue(now) {
      const old = previous; previous = null;
      if (!old || now <= old.at || now - old.at > 15000) return;
      await history.recordWebsiteTime(old.domain, core.splitInterval(old.at, now));
    }
    async function sample(now) {
      const window = await api.windows.getLastFocused();
      if (!window.focused || window.type !== 'normal' || await api.idle.queryState(30) !== 'active') return;
      const [tab] = await api.tabs.query({ active: true, windowId: window.id });
      const domain = !tab?.incognito && domainForURL(tab?.url);
      if (domain) previous = { domain, at: now };
    }
    async function tick() {
      if (!enabled) return;
      if (!await allowed()) {
        previous = null; enabled = false; resetTimer();
        await api.storage.local.set({ _websiteTimeEnabled: false });
        await api.alarms.clear('website-time');
        return;
      }
      const now = Date.now();
      await accrue(now);
      await sample(now);
    }
    async function updateMonitoring() {
      resetTimer();
      if (!enabled) {
        await api.alarms.clear('website-time');
        return;
      }
      api.idle.setDetectionInterval(30);
      await api.alarms.create('website-time', { periodInMinutes: 1 });
      await sample(Date.now());
    }
    async function start() {
      previous = null;
      const stored = await api.storage.local.get('_websiteTimeEnabled');
      enabled = stored._websiteTimeEnabled === true && await allowed();
      await updateMonitoring();
    }
    async function setEnabled(value) {
      if (typeof value !== 'boolean') throw Object.assign(new Error('Invalid website tracking setting'), { expected: true });
      if (value && !await allowed()) throw Object.assign(new Error('Allow the browser permissions to track all websites.'), { expected: true });
      if (enabled) await accrue(Date.now());
      enabled = value; previous = null;
      await api.storage.local.set({ _websiteTimeEnabled: value });
      await updateMonitoring();
      return { ok: true, enabled };
    }
    api.tabs.onActivated?.addListener(() => schedule(tick));
    api.tabs.onUpdated?.addListener((_, change) => { if (change.url || change.status) void schedule(tick); });
    api.tabs.onRemoved?.addListener(() => schedule(tick));
    api.windows?.onFocusChanged.addListener(() => schedule(tick));
    api.idle?.onStateChanged.addListener(() => schedule(tick));
    api.permissions?.onRemoved.addListener(() => schedule(tick));
    return { start, tick, setEnabled, get enabled() { return enabled; } };
  }
  return { PERMISSIONS, domainForURL, summarize, duration, csv, create };
});
