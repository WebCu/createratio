(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MessageContracts = factory();
})(globalThis, function () {
  'use strict';
  function refuse(message) { return Object.assign(new Error(message), { expected: true }); }
  function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function create(core, runtime, integrations) {
    const pages = Object.fromEntries(['popup', 'settings', 'dashboard', 'blocked'].map(page => [page, runtime.getURL(page + '.html')]));
    const gate = new URL(pages.blocked);
    const gated = new Set(integrations.sites.filter(site => site.gated).map(site => site.id));
    function topPage(sender, names) {
      return record(sender) && (sender.frameId === undefined || sender.frameId === 0) && names.some(name => sender.url === pages[name]);
    }
    function read(message, sender) {
      if (!record(sender) || sender.id !== runtime.id) throw refuse('Unsupported sender');
      if (!record(message) || typeof message.type !== 'string' || !message.type) throw refuse('Invalid message');
      return message;
    }
    function creationSender(message, sender) {
      return record(sender?.tab) && sender.frameId === 0 && core.siteForURL(sender.url) === message.site && core.SITES.some(site => site.id === message.site);
    }
    function packet(message) {
      const limits = core.DELIVERY_LIMITS;
      const site = core.SITES.find(site => site.id === message.site);
      if (!site || typeof message.id !== 'string' || message.id.length > limits.maxIdLength || !Array.isArray(message.segments) || message.segments.length > limits.maxItems || !Array.isArray(message.actions) || message.actions.length > limits.maxItems) throw refuse('Invalid packet');
      let totalSec = 0;
      for (const segment of message.segments) {
        if (!record(segment) || !core.validLocalDate(segment.date) || !['create', 'consume'].includes(segment.mode) || !Number.isFinite(segment.sec) || segment.sec <= 0 || segment.sec > limits.maxSeconds) throw refuse('Invalid time segment');
        totalSec += segment.sec;
      }
      if (totalSec > limits.maxSeconds) throw refuse('Time packet too large');
      for (const action of message.actions) {
        if (!record(action) || !core.validLocalDate(action.date) || !site.actions.includes(action.action)) throw refuse('Action not supported on this site');
      }
    }
    function preferencesSender(sender) {
      if (!topPage(sender, ['popup', 'settings'])) throw refuse('Preferences must come from the extension settings page');
    }
    function preferences(message, sender) {
      preferencesSender(sender);
      switch (message.type) {
        case 'tracking':
          if (!core.SITES.some(site => site.id === message.site) || typeof message.enabled !== 'boolean') throw refuse('Choose a vetted website and enable or disable tracking');
          break;
        case 'access-duration':
          if (message.site !== undefined && !gated.has(message.site)) throw refuse('Unsupported site');
          if (!(message.site !== undefined && message.minutes === null) && !core.validAccessMinutes(message.minutes)) throw refuse(`Choose a whole number from ${core.ACCESS_LIMITS.minMinutes} to ${core.ACCESS_LIMITS.maxMinutes} minutes`);
          break;
        case 'access-goal-setting':
          if (typeof message.enabled !== 'boolean') throw refuse('Choose whether to allow sites above the daily goal');
          break;
        case 'access-history-setting':
          if (typeof message.enabled !== 'boolean') throw refuse('Enable or disable intention history');
          break;
        case 'scroll-friction-setting':
          if (typeof message.enabled !== 'boolean') throw refuse('Enable or disable scroll friction');
          if (message.strength !== undefined && !core.validScrollFrictionStrength(message.strength)) throw refuse(`Choose scroll resistance from ${core.SCROLL_FRICTION_LIMITS.minStrength}–${core.SCROLL_FRICTION_LIMITS.maxStrength}% in steps of ${core.SCROLL_FRICTION_LIMITS.step}`);
          break;
        case 'website-time-setting':
          if (typeof message.enabled !== 'boolean') throw refuse('Invalid website tracking setting');
          break;
        default: throw refuse('Unknown preference command');
      }
    }
    function history(message, sender) {
      if (!topPage(sender, ['dashboard', 'settings'])) throw refuse('History must come from an extension page');
      if (!['ratio', 'websites'].includes(message.kind) || !['today', 'week', 'month'].includes(message.range)) throw refuse('Invalid history range');
    }
    function intentions(sender) {
      if (!topPage(sender, ['dashboard'])) throw refuse('Manage intention history from the dashboard');
    }
    function blocked(sender, site) {
      let url;
      if (record(sender) && typeof sender.url === 'string') {
        try { url = new URL(sender.url); } catch (_) {}
      }
      if (!gated.has(site) || sender?.frameId !== 0 || !url || url.protocol !== gate.protocol || url.host !== gate.host || url.pathname !== gate.pathname || url.searchParams.get('site') !== site) throw refuse('Access requests must come from the blocked page');
    }
    function session(message, sender) {
      if (message.type === 'access-end') {
        const popup = sender?.url === pages.popup;
        const guard = sender?.frameId === 0 && integrations.forAccessURL(sender.url)?.id === message.site;
        if (!popup && !guard) blocked(sender, message.site);
      } else blocked(sender, message.site);
      if (!gated.has(message.site)) throw refuse('Unsupported site');
    }
    return { read, creationSender, packet, preferencesSender, preferences, history, intentions, blocked, session };
  }
  return { create, refuse };
});
