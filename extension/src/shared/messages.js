(function (root, factory) {
  const commonJS = typeof module === 'object' && module.exports;
  const api = factory(() => commonJS ? require('../../core/core.js') : root.C3, commonJS ? require('../../sites/index.js') : root.C3Sites);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RuntimeMessages = api;
})(globalThis, function (core, sites) {
  'use strict';
  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function nonnegative(value) { return Number.isFinite(value) && value >= 0; }
  function home(site, value) {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        && sites.forAccessURL(url.href)?.id === site && url.href === sites.get(site)?.access?.home;
    } catch (_) { return false; }
  }
  function access(states) {
    return object(states) && Object.entries(states).every(([site, state]) => object(state)
      && typeof state.enabled === 'boolean' && (state.goalAllowed === undefined || typeof state.goalAllowed === 'boolean')
      && typeof state.name === 'string' && home(site, state.home)
      && ['remainingMs', 'expiresAt', 'readyAt', 'requestExpiresAt'].every(key => nonnegative(state[key]))
      && Number.isInteger(state.sessionMinutes) && state.sessionMinutes > 0);
  }
  function history(days, kind) {
    return object(days) && Object.values(days).every(day => object(day) && Object.values(day).every(value => kind === 'websites' ? nonnegative(value) : object(value)));
  }
  function intentions(entries) {
    return Array.isArray(entries) && entries.every(entry => object(entry) && typeof entry.site === 'string' && typeof entry.reason === 'string' && nonnegative(entry.requestedAt));
  }
  function snapshot(reply) {
    return core()?.validLocalDate(reply.date) === true && object(reply.day) && object(reply.settings)
      && (reply.settings.trackedSites === undefined || Array.isArray(reply.settings.trackedSites) && reply.settings.trackedSites.every(site => typeof site === 'string'))
      && (reply.settings.scrollFrictionEnabled === undefined || typeof reply.settings.scrollFrictionEnabled === 'boolean')
      && access(reply.access) && typeof reply.websiteTimeEnabled === 'boolean'
      && (reply.generation == null || typeof reply.generation === 'string');
  }
  function accessPhase(value) {
    if (!object(value)) return value;
    return Object.keys(value).sort().map(site => {
      const entry = value[site];
      return [site, object(entry) ? Object.keys(entry).sort().map(key => [key,
        ['remainingMs', 'expiresAt'].includes(key) && nonnegative(entry[key]) ? entry[key] > 0 : entry[key]
      ]) : entry];
    });
  }
  function shouldRefresh(changes, area) {
    return area === 'local' && Object.entries(changes).some(([key, change]) => !key.startsWith('_websiteTime:') && (key !== '_access'
      || JSON.stringify(accessPhase(change.oldValue)) !== JSON.stringify(accessPhase(change.newValue))));
  }
  function create(runtime) {
    return { async send(message, fallbackMessage) {
      let reply;
      try { reply = await runtime.sendMessage(message); }
      catch (error) { throw new Error(typeof error?.message === 'string' && error.message ? error.message : typeof error === 'string' && error ? error : fallbackMessage); }
      if (!object(reply) || reply.ok !== true && reply.ok !== false) throw new Error(fallbackMessage);
      if (reply.ok === false) throw new Error(typeof reply.error === 'string' && reply.error ? reply.error : fallbackMessage);
      if (['snapshot', 'ingest', 'tracking', 'clear-history', 'scroll-friction-setting'].includes(message.type) && !snapshot(reply)) throw new Error(fallbackMessage);
      if (['access-status', 'access-begin', 'access-open', 'access-cancel', 'access-end', 'access-duration', 'access-goal-setting'].includes(message.type) && !access(reply.access)) throw new Error(fallbackMessage);
      if (message.type === 'scroll-friction-setting' && typeof reply.settings.scrollFrictionEnabled !== 'boolean') throw new Error(fallbackMessage);
      if (message.type === 'website-time-setting' && typeof reply.enabled !== 'boolean') throw new Error(fallbackMessage);
      if (message.type === 'history' && !history(reply.days, message.kind)) throw new Error(fallbackMessage);
      if (message.type === 'access-history-list' && !intentions(reply.intentions)) throw new Error(fallbackMessage);
      return reply;
    } };
  }
  return { create, shouldRefresh };
});
