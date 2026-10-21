(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../sites/index.js') : root.C3Sites);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.C3 = api;
})(globalThis, function (integrations) {
  'use strict';
  const FIELDS = ['consumeSec', 'createSec', 'posts', 'replies', 'comments', 'likes', 'bookmarks', 'quotes', 'reposts'];
  const SITES = integrations.sites;
  const ACCESS_LIMITS = { minMinutes: 1, maxMinutes: 240 };
  const INTENTION_LIMITS = { minLength: 20, maxLength: 280 };
  const DELIVERY_LIMITS = { maxPackets: 64, maxItems: 64, maxSeconds: 3600, maxIdLength: 100, receiptLimit: 512 };
  function validIntention(value) { return typeof value === 'string' && value.length <= INTENTION_LIMITS.maxLength && value.trim().length >= INTENTION_LIMITS.minLength; }
  function validAccessMinutes(value) { return Number.isInteger(value) && value >= ACCESS_LIMITS.minMinutes && value <= ACCESS_LIMITS.maxMinutes; }
  const DEFAULT_SETTINGS = { accessMinutes: 5, dailyTarget: 1, allowAboveGoal: false, intentionHistoryEnabled: false, scrollFrictionEnabled: false, trackedSites: SITES.filter(site => site.defaultEnabled).map(site => site.id) };
  function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function trackingSelection(settings) {
    const selected = isRecord(settings) ? settings.trackedSites : undefined;
    return selected === undefined ? DEFAULT_SETTINGS.trackedSites : Array.isArray(selected) ? selected : [];
  }
  function settingsSnapshot(settings = {}) {
    if (!isRecord(settings)) settings = {};
    const resolved = { ...DEFAULT_SETTINGS, ...settings };
    resolved.dailyTarget = dailyTarget(settings);
    resolved.trackedSites = trackingSelection(settings).filter(site => typeof site === 'string');
    if (!validAccessMinutes(resolved.accessMinutes)) resolved.accessMinutes = DEFAULT_SETTINGS.accessMinutes;
    for (const key of ['allowAboveGoal', 'intentionHistoryEnabled', 'scrollFrictionEnabled']) if (typeof resolved[key] !== 'boolean') resolved[key] = DEFAULT_SETTINGS[key];
    delete resolved.nudgeEnabled; delete resolved.nudgeMinutes;
    if (Object.hasOwn(resolved, 'siteOverrides')) resolved.siteOverrides = Object.fromEntries(Object.entries(isRecord(resolved.siteOverrides) ? resolved.siteOverrides : {}).filter(([, preferences]) => isRecord(preferences)).map(([site, preferences]) => {
      const overrides = { ...preferences };
      if (!validAccessMinutes(overrides.accessMinutes)) delete overrides.accessMinutes;
      delete overrides.nudgeEnabled; delete overrides.nudgeMinutes;
      return [site, overrides];
    }).filter(([, overrides]) => Object.keys(overrides).length));
    return resolved;
  }
  function siteSettings(site, settings = {}) {
    const resolved = settingsSnapshot(settings);
    const overrides = Object.hasOwn(resolved.siteOverrides || {}, site) ? resolved.siteOverrides[site] : {};
    if (overrides?.accessMinutes !== undefined) resolved.accessMinutes = overrides.accessMinutes;
    return resolved;
  }
  function updatePreferences(settings = {}, changes, site) {
    if (!isRecord(settings)) settings = {};
    if (!isRecord(changes)) throw new Error('Choose valid preferences');
    if (site !== undefined && !SITES.some(definition => definition.id === site)) throw new Error('Choose a vetted website');
    for (const [key, value] of Object.entries(changes)) {
      if (key !== 'accessMinutes') throw new Error('Unsupported preference');
      if (value === null && site !== undefined) continue;
      if (!validAccessMinutes(value)) throw new Error(`Choose a whole number from ${ACCESS_LIMITS.minMinutes} to ${ACCESS_LIMITS.maxMinutes} minutes`);
    }
    if (site === undefined) return { ...DEFAULT_SETTINGS, ...settings, ...changes };
    const siteOverrides = { ...(isRecord(settings.siteOverrides) ? settings.siteOverrides : {}) };
    const overrides = { ...(isRecord(siteOverrides[site]) ? siteOverrides[site] : {}) };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete overrides[key]; else overrides[key] = value;
    }
    if (Object.keys(overrides).length) siteOverrides[site] = overrides; else delete siteOverrides[site];
    return { ...DEFAULT_SETTINGS, ...settings, siteOverrides };
  }
  function trackingEnabled(site, settings = {}) {
    return SITES.some(definition => definition.id === site) && trackingSelection(settings).includes(site);
  }
  function recordedSites(day = {}) { return Object.keys(isRecord(day) ? day : {}).filter(id => /^[a-z][a-z0-9_-]*$/.test(id)); }
  function emptyStats() { return Object.fromEntries(FIELDS.map(k => [k, 0])); }
  function nonnegative(n) { return Number.isFinite(n) && n >= 0 ? n : 0; }
  function statsSnapshot(stats) { return Object.fromEntries(FIELDS.map(key => [key, nonnegative(stats?.[key])])); }
  function aggregate(day = {}) {
    const total = emptyStats();
    for (const id of recordedSites(day)) for (const k of FIELDS) total[k] += nonnegative(day[id]?.[k]);
    return total;
  }
  function score(stats) {
    return (nonnegative(stats.createSec) + 120 * (nonnegative(stats.posts) + nonnegative(stats.replies) + nonnegative(stats.comments))) / Math.max(nonnegative(stats.consumeSec), 1);
  }
  function validDailyTarget(value) { return Number.isFinite(value) && value >= 0.1 && value <= 100 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9; }
  function dailyTarget(settings = {}) { return validDailyTarget(settings?.dailyTarget) ? settings.dailyTarget : DEFAULT_SETTINGS.dailyTarget; }
  function scoreColor(value) { return value >= 1 ? '#16804a' : value >= 0.5 ? '#b77900' : '#be3f43'; }
  function badgeText(value) { return value >= 100 ? '99+' : value >= 10 ? value.toFixed(0) : value.toFixed(1); }
  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function validLocalDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setHours(12, 0, 0, 0);
    date.setFullYear(year, month - 1, day);
    return value.length === 10 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }
  function recentDates(count = 7, now = new Date()) {
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(now); d.setDate(d.getDate() - (count - 1 - i)); return localDate(d);
    });
  }
  function siteForURL(raw) { return integrations.forURL(raw)?.id || null; }
  function classifyPage(state) { return integrations.forURL(state.url)?.classifyPage(state) || 'neutral'; }
  function activeMillis({ start, end, lastInput, visible, focused, mode }) {
    if (!visible || !focused || !['create', 'consume'].includes(mode) || end < start || end - start > 15000) return 0;
    return Math.max(0, Math.min(end, lastInput + 30000) - Math.max(start, lastInput));
  }
  function splitInterval(startMs, endMs) {
    const parts = [];
    for (let cursor = startMs; cursor < endMs;) {
      const date = new Date(cursor);
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      const end = Math.min(endMs, midnight);
      parts.push({ date: localDate(date), sec: (end - cursor) / 1000 }); cursor = end;
    }
    return parts;
  }
  function csv(all) {
    const columns = ['date', 'site', ...FIELDS, 'score'];
    const rows = [columns.join(',')];
    for (const date of Object.keys(all).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort()) {
      for (const site of new Set([...SITES.map(site => site.id), ...recordedSites(all[date])])) {
        const stats = { ...emptyStats(), ...all[date][site] };
        rows.push([date, site, ...FIELDS.map(k => nonnegative(stats[k]).toFixed(k.endsWith('Sec') ? 3 : 0)), score(stats).toFixed(3)].join(','));
      }
    }
    return rows.join('\r\n') + '\r\n';
  }
  return { FIELDS, SITES, ACCESS_LIMITS, INTENTION_LIMITS, DELIVERY_LIMITS, validAccessMinutes, validIntention, DEFAULT_SETTINGS, settingsSnapshot, siteSettings, updatePreferences, trackingEnabled, recordedSites, emptyStats, statsSnapshot, aggregate, score, validDailyTarget, dailyTarget, scoreColor, badgeText, localDate, validLocalDate, recentDates, siteForURL, classifyPage, activeMillis, splitInterval, csv };
});
