'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { buildSite } = require('../build.js');

const source = fs.readFileSync(path.join(__dirname, '../analytics.js'), 'utf8');

async function initialize(hostname, loadTracker) {
  return vm.runInNewContext(source.replace("import('@plausible-analytics/tracker')", 'loadTracker()'), {
    location: { hostname }, loadTracker
  });
}

test('only the two production hosts initialize the tracker for createratio.com', async () => {
  for (const hostname of ['createratio.com', 'www.createratio.com']) {
    const calls = [];
    await initialize(hostname, async () => ({ init: options => calls.push(options) }));
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { domain: 'createratio.com' });
  }
});

test('local, preview, staging and lookalike hosts never even load the tracker', async () => {
  for (const hostname of ['localhost', '127.0.0.1', '::1', 'createratio.localhost', '',
    'preview.createratio.com', 'staging.createratio.com', 'example.cloudfront.net',
    'createratio.com.example.org', 'webcu.dev']) {
    let loaded = false;
    await initialize(hostname, async () => { loaded = true; });
    assert.equal(loaded, false, hostname);
  }
});

test('blocked imports and initialization failures do not break the page', async () => {
  await initialize('createratio.com', async () => { throw Error('blocked import'); });
  await initialize('createratio.com', async () => ({ init() { throw Error('unavailable'); } }));
});

test('the website build ships only public assets and the licensed official tracker', t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-site-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  buildSite(output);
  const files = fs.readdirSync(output).sort();
  const analytics = files.find(name => /^analytics-[a-f0-9]{12}\.js$/.test(name));
  const tracker = files.find(name => /^plausible-[a-f0-9]{12}\.js$/.test(name));
  assert.ok(analytics);
  assert.ok(tracker);
  assert.deepEqual(files, ['LICENSE', analytics, 'arrival.js', 'browser-install.js', 'favicon.svg', 'index.html',
    'plausible-MIT.txt', tracker, 'privacy.html', 'robots.txt', 'sitemap.xml', 'terms.html', 'styles.css'].sort());
  for (const page of ['privacy.html', 'terms.html']) {
    const legal = fs.readFileSync(path.join(output, page), 'utf8');
    assert.equal(legal, fs.readFileSync(path.join(__dirname, '..', page), 'utf8'),
      `production ${page} matches the public source`);
    assert.doesNotMatch(legal, /<(?:script|iframe)\b/i, `${page} has no analytics bootstrap or embedded scripts`);
    assert.match(legal, /<html lang="en">/);
    assert.match(legal, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(legal, /<link rel="stylesheet" href="styles\.css">/);
    assert.match(legal, /class="skip-link" href="#main"/);
    assert.match(legal, /<main id="main" tabindex="-1">/);
  }
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.ok(html.includes(`<script type="module" src="./${analytics}"></script>`));
  const script = fs.readFileSync(path.join(output, analytics), 'utf8');
  assert.ok(script.includes(`import("./${tracker}")`));
  assert.doesNotMatch(script, /@plausible-analytics/);
  assert.deepEqual(fs.readFileSync(path.join(output, tracker)),
    fs.readFileSync(require.resolve('@plausible-analytics/tracker', { paths: [path.join(__dirname, '..')] })));
  assert.match(fs.readFileSync(path.join(output, 'plausible-MIT.txt'), 'utf8'), /MIT License/);
  buildSite(output);
  assert.deepEqual(fs.readdirSync(output).sort(), files, 'filenames are deterministic');
});
