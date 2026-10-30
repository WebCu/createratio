'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { BROWSERS, SITE_SCRIPTS, build } = require('../../build.js');

async function temporaryOutput(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'c3-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('all browser bundles include the exact shared core and every referenced asset', async t => {
  const root = await temporaryOutput(t);
  const core = await fs.readFile(path.join(__dirname, '../../core/core.js'), 'utf8');
  const license = await fs.readFile(path.join(__dirname, '../../../LICENSE'), 'utf8');
  for (const browser of BROWSERS) {
    const output = await build(browser, root);
    const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.description.length > 0 && manifest.description.length <= 132, 'store description limit');
    for (const [size, file] of Object.entries(manifest.icons)) {
      const png = await fs.readFile(path.join(output, file));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), Number(size), `${browser}: icon width`);
      assert.equal(png.readUInt32BE(20), Number(size), `${browser}: icon height`);
    }
    const scripts = manifest.content_scripts.flatMap(entry => entry.js);
    const backgrounds = manifest.background.scripts || [manifest.background.service_worker];
    const popup = await fs.readFile(path.join(output, manifest.action.default_popup), 'utf8');
    const popupScripts = [...popup.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    assert.ok(!popupScripts.includes('feedback.js'));
    assert.deepEqual(manifest.options_ui, { page: 'settings.html', open_in_tab: true });
    const settings = await fs.readFile(path.join(output, manifest.options_ui.page), 'utf8');
    assert.match(settings, new RegExp(`data-store="${browser}"`));
    const dashboard = await fs.readFile(path.join(output, 'dashboard.html'), 'utf8');
    const blocked = await fs.readFile(path.join(output, 'blocked.html'), 'utf8');
    const pageAssets = [settings, dashboard, popup, blocked].flatMap(html => [...html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|html))"/g)].map(match => match[1]));
    const assets = [manifest.options_ui.page, 'dashboard.html', ...pageAssets, ...scripts, ...backgrounds, ...Object.values(manifest.icons), manifest.action.default_popup, 'popup.css', 'popup.js', ...popupScripts, 'blocker.js', 'blocked.css', 'blocked.js', ...manifest.web_accessible_resources.flatMap(entry => entry.resources), ...manifest.declarative_net_request.rule_resources.map(entry => entry.path)];
    for (const asset of assets) assert.ok((await fs.stat(path.join(output, asset))).isFile(), `${browser}: ${asset}`);
    assert.equal(await fs.readFile(path.join(output, 'core.js'), 'utf8'), core);
    assert.equal(await fs.readFile(path.join(output, 'LICENSE'), 'utf8'), license);
    assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'declarativeNetRequestWithHostAccess', 'scripting']);
    assert.deepEqual(manifest.optional_permissions, ['tabs', 'idle']);
    assert.ok((await fs.stat(path.join(output, 'web-time.js'))).isFile());
    const trackingHosts = require('../../sites/index.js').sites.filter(site => !site.gated).flatMap(site => site.hosts);
    assert.deepEqual(manifest.host_permissions, ['x.com', 'twitter.com', 'linkedin.com', 'tiktok.com', 'instagram.com'].flatMap(domain => ['http://*.' + domain + '/*', 'https://*.' + domain + '/*']).concat(trackingHosts.map(host => 'https://' + host + '/*')));
    for (const entry of manifest.content_scripts.slice(1)) for (const host of trackingHosts) assert.ok(entry.matches.includes('https://' + host + '/*'));
    for (const host of trackingHosts) assert.ok(!manifest.content_scripts[0].matches.includes('https://' + host + '/*'), 'tracking-only hosts do not get access guards');
    assert.deepEqual(manifest.declarative_net_request.rule_resources, [{ id: 'site-blocking', enabled: true, path: 'block-rules.json' }]);
    const rules = JSON.parse(await fs.readFile(path.join(output, 'block-rules.json'), 'utf8'));
    assert.equal(rules.length, 5);
    assert.deepEqual(rules.slice(0, 4).map(rule => rule.action.redirect.extensionPath), ['x', 'linkedin', 'tiktok', 'instagram'].map(site => '/blocked.html?site=' + site));
    assert.ok(rules.every(rule => rule.priority === 1));
    assert.equal(rules[4].action.type, 'block');
    assert.deepEqual(rules[4].condition.excludedResourceTypes, ['main_frame']);
    assert.deepEqual(rules[4].condition.requestDomains, ['x.com', 'twitter.com', 'linkedin.com', 'tiktok.com', 'instagram.com']);
    assert.equal(rules[4].condition.resourceTypes, undefined, 'block all non-navigation requests, not just frames');
    assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
    assert.equal(manifest.content_scripts[0].run_at, 'document_start');
    assert.deepEqual(manifest.content_scripts[0].js, ['sites.js', 'messages.js', 'lifecycle.js', 'access-guard.js']);
    assert.equal(manifest.content_scripts[1].world, 'MAIN');
    assert.equal(manifest.content_scripts[2].js.indexOf('sites.js') < manifest.content_scripts[2].js.indexOf('core.js'), true);
    assert.equal(manifest.content_scripts[2].js.indexOf('core.js') < manifest.content_scripts[2].js.indexOf('messages.js'), true);
    assert.equal(manifest.content_scripts[2].js.indexOf('messages.js') < manifest.content_scripts[2].js.indexOf('content.js'), true);
    assert.ok(manifest.content_scripts[2].js.includes('scroll-friction.js'));
    assert.ok(manifest.content_scripts[2].js.indexOf('scroll-friction.js') < manifest.content_scripts[2].js.indexOf('content.js'));
    for (const html of [settings, dashboard, popup, blocked]) {
      const pageScripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
      assert.ok(pageScripts.includes('messages.js'));
      assert.ok(pageScripts.indexOf('messages.js') < pageScripts.length - 1);
    }
    if (browser === 'firefox') assert.ok(backgrounds.indexOf('message-contracts.js') < backgrounds.indexOf('blocker.js'));
    const plugins = await fs.readFile(path.join(output, 'sites.js'), 'utf8');
    for (const script of SITE_SCRIPTS) assert.ok(plugins.includes(await fs.readFile(path.join(__dirname, '../..', script), 'utf8')), `${browser}: ${script}`);
    assert.ok(popupScripts.indexOf('sites.js') < popupScripts.indexOf('core.js'));
    for (const excluded of ['tests', 'package.json', 'build.js', 'README.md']) {
      await assert.rejects(fs.access(path.join(output, excluded)), { code: 'ENOENT' });
    }
  }
});

test('organized runtime sources ship unchanged at flat bundle paths with icons preserved', async t => {
  const root = await temporaryOutput(t);
  const directories = ['background', 'content', 'shared', 'pages/popup', 'pages/settings', 'pages/dashboard', 'pages/blocked', 'icons'];
  for (const browser of BROWSERS) {
    const output = await build(browser, root);
    const expectedFiles = ['manifest.json', 'sites.js', 'core.js', 'LICENSE', 'block-rules.json'];
    for (const directory of directories) {
      const source = path.join(__dirname, '..', directory);
      for (const file of await fs.readdir(source)) {
        if (file.endsWith('.test.js')) {
          await assert.rejects(fs.access(path.join(output, file)), { code: 'ENOENT' });
          continue;
        }
        const target = directory === 'icons' ? `icons/${file}` : file;
        expectedFiles.push(target);
        const original = await fs.readFile(path.join(source, file));
        const expected = file === 'settings.html' ? Buffer.from(original.toString().replace('data-store="chrome"', `data-store="${browser}"`)) : original;
        assert.deepEqual(await fs.readFile(path.join(output, target)), expected, `${browser}: ${directory}/${file} → ${target}`);
      }
    }
    assert.deepEqual((await fs.readdir(output, { recursive: true })).sort(), [...expectedFiles, 'icons'].sort(), browser);
  }
});

test('every bundle links to the hosted privacy policy in a separate tab and removes old offline copies', async t => {
  const root = await temporaryOutput(t);
  for (const browser of BROWSERS) {
    const destination = path.join(root, browser);
    await fs.mkdir(destination, { recursive: true });
    for (const file of ['privacy.html', 'privacy.css']) await fs.writeFile(path.join(destination, file), 'Obsolete offline policy');
    const output = await build(browser, root);
    for (const file of ['privacy.html', 'privacy.css']) await assert.rejects(fs.access(path.join(output, file)), { code: 'ENOENT' });
    for (const page of ['popup.html', 'settings.html', 'blocked.html']) {
      const html = await fs.readFile(path.join(output, page), 'utf8');
      const links = [...html.matchAll(/<a\b([^>]+)>Privacy policy<\/a>/g)];
      assert.equal(links.length, 1, `${browser}: ${page} privacy link`);
      const attributes = links[0][1];
      assert.match(attributes, /href="https:\/\/createratio\.com\/privacy\.html"/);
      assert.match(attributes, /target="_blank"/);
      assert.match(attributes, /rel="noopener noreferrer"/);
      assert.doesNotMatch(html, /href="privacy\.html"/);
    }
  }
});

test('all distributions share the source version and use Create > Consume as the supporting tagline', async t => {
  const root = await temporaryOutput(t);
  const version = JSON.parse(await fs.readFile(path.join(__dirname, '../manifest.json'), 'utf8')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const packagePath of ['../../../package.json', '../../package.json']) {
    const metadata = JSON.parse(await fs.readFile(path.join(__dirname, packagePath), 'utf8'));
    assert.equal(metadata.name, 'createratio');
    assert.equal(metadata.version, version);
    assert.equal(metadata.license, 'MIT');
  }
  for (const browser of BROWSERS) {
    const output = await build(browser, root);
    const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.name, 'CreateRatio');
    assert.equal(manifest.version, version);
    assert.equal(manifest.action.default_title, 'CreateRatio');
    assert.match(manifest.description, /^Create > Consume\./);
    const popup = await fs.readFile(path.join(output, 'popup.html'), 'utf8');
    assert.match(popup, /<title>CreateRatio<\/title>/);
    assert.doesNotMatch(popup, /LOCAL ONLY/);
    assert.match(popup, /<h1>CreateRatio<\/h1><p class="eyebrow">Create &gt; Consume<\/p>/);
    const dashboardScript = await fs.readFile(path.join(output, 'dashboard.js'), 'utf8');
    const filenames = [...dashboardScript.matchAll(/link\.download = (`[^`]+`);/g)].flatMap(([, expression]) =>
      [false, true].map(websites => vm.runInNewContext(expression, {
        websites, C3: { localDate: () => '2026-01-02' }
      })));
    assert.deepEqual([...new Set(filenames)].sort(), [
      'CreateRatio-2026-01-02.csv', 'CreateRatio-websites-2026-01-02.csv'
    ]);
    const background = await fs.readFile(path.join(output, 'background.js'), 'utf8');
    assert.match(background, /CreateRatio - today's score:/);
    const content = await fs.readFile(path.join(output, 'content.js'), 'utf8');
    assert.match(content, /console\.warn\(`CreateRatio: /);
    assert.match(content, /console\.warn\('CreateRatio: tracking will retry\.'/);
    assert.doesNotMatch(content, /c3-nudge|Write one reply before|Dismiss reminder/);
  }
});

test('browser manifests differ only in Firefox platform settings and background loading', async t => {
  const root = await temporaryOutput(t);
  const manifests = {};
  for (const browser of BROWSERS) {
    const output = await build(browser, root);
    manifests[browser] = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  }
  assert.deepEqual(manifests.chrome, manifests.edge);
  assert.deepEqual(manifests.chrome.background, { service_worker: 'background.js' });
  const firefox = manifests.firefox;
  assert.deepEqual(firefox.background, { scripts: ['sites.js', 'core.js', 'messages.js', 'message-contracts.js', 'blocker.js', 'history.js', 'web-time.js', 'updates.js', 'background.js'] });
  assert.equal(firefox.minimum_chrome_version, undefined);
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '140.0');
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, ['none']);
  delete firefox.browser_specific_settings;
  firefox.background = manifests.chrome.background;
  firefox.minimum_chrome_version = manifests.chrome.minimum_chrome_version;
  assert.deepEqual(firefox, manifests.chrome);
});

test('built plugin catalog and core execute in browser worlds and rebuilt bundles discard obsolete plugin assets', async t => {
  const root = await temporaryOutput(t);
  const output = await build('chrome', root);
  const originalBundle = await fs.readFile(path.join(output, 'sites.js'), 'utf8');
  const context = vm.createContext({ URL });
  for (const file of ['sites.js', 'core.js']) vm.runInContext(await fs.readFile(path.join(output, file), 'utf8'), context);
  assert.equal(context.C3.siteForURL('https://x.com/home'), 'x');
  assert.equal(context.C3.classifyPage({ url: 'https://www.linkedin.com/feed/' }), 'consume');
  assert.equal(typeof context.C3Sites.get('x').create, 'function');
  await fs.mkdir(path.join(output, 'sites'));
  await fs.writeFile(path.join(output, 'sites', 'obsolete.js'), 'throw new Error("Do not ship");');
  await fs.writeFile(path.join(output, 'selectors.js'), 'obsolete selectors');
  await fs.writeFile(path.join(output, '.env'), 'STALE_BUILD_FIXTURE=must-not-ship');
  await fs.writeFile(path.join(output, 'unused.js'), 'obsolete runtime file');
  await fs.writeFile(path.join(output, 'icons', 'obsolete.png'), 'obsolete icon');
  await fs.mkdir(path.join(output, '_metadata', 'generated_indexed_rulesets'), { recursive: true });
  await fs.writeFile(path.join(output, '_metadata', 'generated_indexed_rulesets', '_ruleset1'), 'browser-generated ruleset');
  await build('chrome', root);
  await assert.rejects(fs.access(path.join(output, 'sites')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(output, 'selectors.js')), { code: 'ENOENT' });
  for (const stale of ['.env', 'unused.js', 'icons/obsolete.png', '_metadata']) {
    await assert.rejects(fs.access(path.join(output, stale)), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(path.join(output, 'sites.js'), 'utf8'), originalBundle);
});

test('blocking rules are generated from registered site modules without shipping unconfigured gates', async t => {
  const root = await temporaryOutput(t);
  const x = require('../../sites/x.js');
  const linkedin = require('../../sites/linkedin.js');
  const originalX = x.access, originalLinkedin = linkedin.access;
  const others = ['tiktok', 'instagram'].map(id => require('../../sites/' + id + '.js'));
  const originalOthers = others.map(plugin => plugin.access);
  try {
    for (const plugin of others) delete plugin.access;
    x.access = { ...originalX, redirectRuleId: 7, domains: ['example.test', 'alias.test'] };
    delete linkedin.access;
    const output = await build('chrome', root);
    const rules = JSON.parse(await fs.readFile(path.join(output, 'block-rules.json'), 'utf8'));
    assert.deepEqual(rules, [
      { id: 7, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/blocked.html?site=x' } }, condition: { requestDomains: ['example.test', 'alias.test'], resourceTypes: ['main_frame'] } },
      { id: 8, priority: 1, action: { type: 'block' }, condition: { requestDomains: ['example.test', 'alias.test'], excludedResourceTypes: ['main_frame'] } }
    ]);
    delete x.access;
    await build('chrome', root);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'block-rules.json'), 'utf8')), []);
  } finally {
    x.access = originalX;
    linkedin.access = originalLinkedin;
    others.forEach((plugin, index) => { plugin.access = originalOthers[index]; });
  }
});

test('new gated and tracking-only modules need only site files and catalog registration', async t => {
  const root = await temporaryOutput(t);
  const project = path.join(root, 'project'), extension = path.join(project, 'extension');
  await fs.cp(path.join(__dirname, '../..'), extension, { recursive: true });
  await fs.copyFile(path.join(__dirname, '../../../LICENSE'), path.join(project, 'LICENSE'));
  await fs.writeFile(path.join(extension, 'sites/example.js'), `(function (root) {
    const domains = ['example.test', 'alias.test'];
    const access = {
      domains, home: 'https://example.test/write', redirectRuleId: 6, ruleIds: [201, 202],
      unrestrictedRules: [
        { id: 201, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, resourceTypes: ['main_frame'] } },
        { id: 202, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['main_frame'] } }
      ],
      sessionRules: [{ id: 201, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['sub_frame'] } }]
    };
    const plugin = { id: 'example', name: 'Example', hosts: ['example.test'], actions: ['posts'], access,
      classifyPage() { return 'neutral'; }, create() { return { mode() { return 'neutral'; }, action() { return null; } }; }
    };
    if (typeof module === 'object' && module.exports) module.exports = plugin;
    else (root.C3_SITE_MODULES ||= {}).example = plugin;
  })(globalThis);`);
  await fs.writeFile(path.join(extension, 'sites/reading.js'), `(function (root) {
    const plugin = { id: 'reading', name: 'Reading', hosts: ['reading.test'], actions: ['posts'],
      classifyPage() { return 'neutral'; }, create() { return { mode() { return 'neutral'; }, action() { return null; } }; }
    };
    if (typeof module === 'object' && module.exports) module.exports = plugin;
    else (root.C3_SITE_MODULES ||= {}).reading = plugin;
  })(globalThis);`);
  const catalogPath = path.join(extension, 'sites/index.js');
  const catalog = await fs.readFile(catalogPath, 'utf8');
  await fs.writeFile(catalogPath, catalog.replace(/const catalog = (\[[^\n]+\]);/, (_, entries) => "const catalog = " + entries.slice(0, -1) + ", { id: 'example' }, { id: 'reading' }];"));
  const { build: fixtureBuild } = require(path.join(extension, 'build.js'));
  for (const browser of BROWSERS) {
    const output = await fixtureBuild(browser, path.join(root, 'output'));
    const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
    const permissions = manifest.host_permissions;
    for (const domain of ['example.test', 'alias.test']) {
      assert.ok(permissions.includes('http://*.' + domain + '/*'));
      assert.ok(permissions.includes('https://*.' + domain + '/*'));
    }
    assert.ok(permissions.includes('https://reading.test/*'));
    assert.ok(!permissions.includes('http://*.reading.test/*'));
    assert.ok(manifest.content_scripts[0].matches.includes('http://*.alias.test/*'));
    assert.ok(!manifest.content_scripts[0].matches.includes('https://reading.test/*'));
    assert.deepEqual(manifest.web_accessible_resources[0].matches, manifest.content_scripts[0].matches);
    for (const entry of manifest.content_scripts.slice(1)) {
      assert.ok(entry.matches.includes('https://example.test/*'));
      assert.ok(entry.matches.includes('https://reading.test/*'));
      assert.ok(!entry.matches.includes('https://alias.test/*'));
    }
    const rules = JSON.parse(await fs.readFile(path.join(output, 'block-rules.json'), 'utf8'));
    assert.equal(rules.find(rule => rule.id === 6).action.redirect.extensionPath, '/blocked.html?site=example');
    assert.deepEqual(rules.at(-1).condition.requestDomains, ['x.com', 'twitter.com', 'linkedin.com', 'tiktok.com', 'instagram.com', 'example.test', 'alias.test']);
    const context = vm.createContext({ URL });
    for (const file of ['sites.js', 'core.js']) vm.runInContext(await fs.readFile(path.join(output, file), 'utf8'), context);
    assert.equal(context.C3Sites.forAccessURL('http://mobile.alias.test/').id, 'example');
    assert.equal(context.C3Sites.forAccessURL('https://reading.test/'), null);
    assert.equal(context.C3.siteForURL('https://reading.test/'), 'reading');
    assert.equal(context.C3.SITES.find(site => site.id === 'example').gated, true);
    assert.equal(context.C3.SITES.find(site => site.id === 'reading').gated, false);
    assert.deepEqual(Array.from(context.C3.DEFAULT_SETTINGS.trackedSites), ['x', 'linkedin']);
  }
});

test('highest redirect ID leaves a valid browser ID for the shared blocking rule', async t => {
  const root = await temporaryOutput(t);
  const x = require('../../sites/x.js'), original = x.access;
  const maximumRuleId = 2 ** 31 - 1;
  try {
    x.access = { ...original, redirectRuleId: maximumRuleId - 1 };
    const output = await build('chrome', root);
    const rules = JSON.parse(await fs.readFile(path.join(output, 'block-rules.json'), 'utf8'));
    assert.equal(rules[0].id, maximumRuleId - 1);
    assert.equal(rules.at(-1).id, maximumRuleId);
  } finally { x.access = original; }
});

test('invalid blocking metadata fails before writing a browser bundle', async t => {
  const root = await temporaryOutput(t);
  const x = require('../../sites/x.js');
  const original = x.access;
  try {
    for (const access of [
      { redirectRuleId: 2, domains: ['x.com'] },
      { redirectRuleId: 0, domains: ['x.com'] },
      { redirectRuleId: 1.5, domains: ['x.com'] },
      { redirectRuleId: -1, domains: ['x.com'] },
      { redirectRuleId: '1', domains: ['x.com'] },
      { redirectRuleId: 2 ** 31 - 1, domains: ['x.com'] },
      { redirectRuleId: 2 ** 31, domains: ['x.com'] },
      { redirectRuleId: 1, domains: [] },
      { redirectRuleId: 1, domains: ['*.x.com'] },
      { redirectRuleId: 1, domains: ['x.com/path'] },
      { redirectRuleId: 1, domains: ['https://x.com'] }
    ]) {
      x.access = { ...original, ...access };
      await assert.rejects(build('chrome', root), /Invalid blocking/);
      assert.deepEqual(await fs.readdir(root), []);
    }
  } finally { x.access = original; }
});

test('unsupported plugin action fields fail before writing a browser bundle', async t => {
  const root = await temporaryOutput(t);
  const actions = require('../../sites/index.js').sites[0].actions;
  actions.push('unsupported');
  try {
    await assert.rejects(build('chrome', root), /Unsupported action field/);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { actions.pop(); }
});

test('unknown browser targets fail without creating output', async t => {
  const root = await temporaryOutput(t);
  await assert.rejects(build('../unknown', root), /Choose a browser/);
  assert.deepEqual(await fs.readdir(root), []);
});
