(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(id => require('./' + id + '.js'));
  else root.C3Sites = factory(id => root.C3_SITE_MODULES?.[id]);
})(globalThis, function (load) {
  'use strict';
  const MIN_RULE_ID = 1;
  const MAX_RULE_ID = 2 ** 31 - 1;
  const MAX_REDIRECT_RULE_ID = MAX_RULE_ID - 1;
  function nonemptyArray(value) { return Array.isArray(value) && value.length > 0; }
  function validRuleId(value) {
    return Number.isInteger(value) && value >= MIN_RULE_ID && value <= MAX_RULE_ID;
  }
  function validRedirectRuleId(value) {
    return validRuleId(value) && value <= MAX_REDIRECT_RULE_ID;
  }
  function validateAccessRules(id, rules, ruleIds) {
    if (!nonemptyArray(rules)) throw new Error('Invalid access rules: ' + id);
    if (rules.some(rule => !rule || !ruleIds.includes(rule.id))) throw new Error('Unknown access rule ID: ' + id);
    if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('Duplicate access rule IDs: ' + id);
  }
  function validateAccessHome(id, access) {
    const home = new URL(access.home);
    if (home.protocol !== 'https:' || home.username || home.password) throw new Error('Invalid access home: ' + id);
    if (!access.domains.some(domain => home.hostname === domain || home.hostname.endsWith('.' + domain))) throw new Error('Invalid access home: ' + id);
  }
  function validateAccess(id, access) {
    if (access === undefined) return;
    if (!access || !nonemptyArray(access.domains)) throw new Error('Invalid access domains: ' + id);
    if (!validRedirectRuleId(access.redirectRuleId)) throw new Error('Invalid access redirect rule ID: ' + id);
    if (!nonemptyArray(access.ruleIds) || !access.ruleIds.every(validRuleId)) throw new Error('Invalid access rule IDs: ' + id);
    validateAccessRules(id, access.unrestrictedRules, access.ruleIds);
    validateAccessRules(id, access.sessionRules, access.ruleIds);
    validateAccessHome(id, access);
  }
  const catalog = [{ id: 'x' }, { id: 'linkedin' }, { id: 'youtube' }];
  const plugins = catalog.map(({ id }) => {
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error('Invalid integration ID: ' + id);
    const plugin = load(id);
    if (!plugin || plugin.id !== id || !plugin.name || typeof plugin.name !== 'string' || typeof plugin.create !== 'function' || typeof plugin.classifyPage !== 'function' || !Array.isArray(plugin.hosts) || !plugin.hosts.length || !Array.isArray(plugin.actions) || plugin.actions.some(action => typeof action !== 'string')) throw new Error('Invalid site integration: ' + id);
    if (plugin.defaultEnabled !== undefined && typeof plugin.defaultEnabled !== 'boolean') throw new Error('Invalid default activation: ' + id);
    const access = plugin.access;
    validateAccess(id, access);
    for (const host of [...plugin.hosts, ...(access?.domains || [])]) {
      const url = new URL('https://' + host);
      if (typeof host !== 'string' || url.hostname !== host || url.pathname !== '/' || url.port || url.username || url.password || url.search || url.hash || host.includes('*')) throw new Error('Use exact hosts: ' + id);
    }
    return plugin;
  });
  const sites = plugins.map(({ id, name, hosts, actions, defaultEnabled, access }) => ({ id, name, hosts, actions, defaultEnabled: defaultEnabled === true, gated: !!access }));
  if (new Set(sites.map(site => site.id)).size !== sites.length) throw new Error('Duplicate site integration');
  const hosts = sites.flatMap(site => site.hosts);
  if (new Set(hosts).size !== hosts.length) throw new Error('Overlapping site hosts');
  const gated = plugins.filter(plugin => plugin.access);
  const ruleIds = gated.flatMap(plugin => plugin.access.ruleIds);
  const redirectRuleIds = gated.map(plugin => plugin.access.redirectRuleId);
  if (new Set(ruleIds).size !== ruleIds.length || new Set(redirectRuleIds).size !== redirectRuleIds.length) throw new Error('Overlapping access rule IDs');
  for (const plugin of gated) {
    if (gated.some(other => other !== plugin && plugin.access.domains.some(domain => other.access.domains.some(root => domain === root || domain.endsWith('.' + root) || root.endsWith('.' + domain))))) throw new Error('Overlapping access domains');
  }
  function get(id) { return plugins.find(plugin => plugin.id === id) || null; }
  function forURL(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' ? plugins.find(plugin => plugin.hosts.includes(url.hostname)) || null : null;
    } catch (_) { return null; }
  }
  function forAccessURL(raw) {
    try {
      const url = new URL(raw);
      return ['http:', 'https:'].includes(url.protocol) ? plugins.find(plugin => plugin.access?.domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) || null : null;
    } catch (_) { return null; }
  }
  return { sites, get, forURL, forAccessURL, validRedirectRuleId };
});
