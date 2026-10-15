'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const BROWSERS = ['chrome', 'edge', 'firefox'];
const { sites, get, validRedirectRuleId } = require('./sites/index.js');
const { FIELDS } = require('./core/core.js');
const SITE_SCRIPTS = [...sites.map(site => `sites/${site.id}.js`), 'sites/index.js'];
const ASSETS = [
  'background/background.js', 'background/history.js', 'background/web-time.js', 'background/blocker.js', 'background/message-contracts.js',
  'content/access-guard.js', 'content/content.js', 'content/dom.js', 'content/route-hook.js',
  'pages/blocked/blocked.html', 'pages/blocked/blocked.css', 'pages/blocked/blocked.js',
  'pages/popup/popup.html', 'pages/popup/popup.js',
  'pages/settings/settings.html', 'pages/settings/settings.js',
  'pages/dashboard/dashboard.html', 'pages/dashboard/dashboard.js',
  'shared/refill.css', 'shared/refill.js', 'shared/feedback.js', 'shared/messages.js', 'shared/popup.css', 'shared/page.css',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'
];

function blockingRules() {
  const rules = [];
  for (const site of sites) {
    const access = get(site.id).access;
    if (access === undefined) continue;
    if (!access || !validRedirectRuleId(access.redirectRuleId)) throw new Error('Invalid blocking rule ID: ' + site.id);
    if (!Array.isArray(access.domains) || !access.domains.length) throw new Error('Invalid blocking domains: ' + site.id);
    if (rules.some(rule => rule.id === access.redirectRuleId)) throw new Error('Invalid blocking metadata: duplicate rule ID for ' + site.id);
    for (const domain of access.domains) {
      let url;
      try { url = new URL('https://' + domain); } catch (_) { throw new Error('Invalid blocking domain: ' + site.id); }
      if (typeof domain !== 'string' || url.hostname !== domain || url.pathname !== '/' || url.port || url.username || url.password || url.search || url.hash || domain.includes('*')) throw new Error('Invalid blocking domain: ' + site.id);
    }
    rules.push({ id: access.redirectRuleId, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/blocked.html?site=' + site.id } }, condition: { requestDomains: access.domains, resourceTypes: ['main_frame'] } });
  }
  if (rules.length) rules.push({ id: Math.max(...rules.map(rule => rule.id)) + 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: [...new Set(rules.flatMap(rule => rule.condition.requestDomains))], excludedResourceTypes: ['main_frame'] } });
  return rules;
}

async function build(browser, outputRoot = path.join(__dirname, '..', 'dist')) {
  if (!BROWSERS.includes(browser)) throw new Error(`Choose a browser: ${BROWSERS.join(', ')}`);
  for (const site of sites) {
    const hasUnsupportedAction = site.actions.some(action => !FIELDS.includes(action) || action.endsWith('Sec'));
    if (hasUnsupportedAction) throw new Error('Unsupported action field: ' + site.id);
  }
  const rules = blockingRules();
  const sourceDirectory = path.join(__dirname, 'src');
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDirectory, 'manifest.json'), 'utf8'));
  const plugins = sites.map(site => get(site.id));
  const domains = [...new Set(plugins.flatMap(plugin => plugin.access?.domains || []))];
  const hosts = [...new Set(plugins.flatMap(plugin => plugin.hosts))];
  const accessMatches = domains.flatMap(domain => ['http://*.' + domain + '/*', 'https://*.' + domain + '/*']);
  const trackingMatches = hosts.map(host => 'https://' + host + '/*');
  manifest.host_permissions = [...accessMatches, ...hosts.filter(host => !domains.some(domain => host === domain || host.endsWith('.' + domain))).map(host => 'https://' + host + '/*')];
  manifest.content_scripts = manifest.content_scripts.map(entry => ({ ...entry, matches: entry.js.includes('access-guard.js') ? accessMatches : trackingMatches })).filter(entry => entry.matches.length);
  manifest.web_accessible_resources = manifest.web_accessible_resources.map(entry => ({ ...entry, matches: accessMatches })).filter(entry => entry.matches.length);
  if (!rules.length) delete manifest.declarative_net_request;
  if (browser === 'firefox') {
    delete manifest.minimum_chrome_version;
    manifest.background = { scripts: ['sites.js', 'core.js', 'message-contracts.js', 'blocker.js', 'history.js', 'web-time.js', 'background.js'] };
    manifest.browser_specific_settings = {
      gecko: {
        id: 'create-greater-consume@createratio',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] }
      }
    };
  }
  const destination = path.join(outputRoot, browser);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const asset of ASSETS) {
    const target = path.join(destination, asset.startsWith('icons/') ? asset : path.basename(asset));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(sourceDirectory, asset), target);
  }
  const sources = await Promise.all(SITE_SCRIPTS.map(script => fs.readFile(path.join(__dirname, script), 'utf8')));
  await fs.writeFile(path.join(destination, 'sites.js'), sources.join('\n'));
  await fs.writeFile(path.join(destination, 'block-rules.json'), JSON.stringify(rules, null, 2) + '\n');
  const settings = await fs.readFile(path.join(destination, 'settings.html'), 'utf8');
  await fs.writeFile(path.join(destination, 'settings.html'), settings.replace('data-store="chrome"', `data-store="${browser}"`));
  await fs.copyFile(path.join(__dirname, 'core', 'core.js'), path.join(destination, 'core.js'));
  await fs.copyFile(path.join(__dirname, '..', 'LICENSE'), path.join(destination, 'LICENSE'));
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return destination;
}

if (require.main === module) {
  const targets = process.argv.slice(2);
  const browsers = targets.length ? targets : BROWSERS;
  if (browsers.some(browser => !BROWSERS.includes(browser))) {
    console.error(`Choose a browser: ${BROWSERS.join(', ')}`);
    process.exitCode = 1;
  } else {
    (async () => {
      for (const browser of browsers) console.log(`${browser}: ${await build(browser)}`);
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { BROWSERS, SITE_SCRIPTS, build };
