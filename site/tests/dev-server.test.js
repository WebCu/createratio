'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { readFile, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createDevServer } = require('../dev-server.js');
const { buildSite } = require('../build.js');

const root = path.resolve(__dirname, '../..');

async function start(t, ...args) {
  const server = createDevServer(...args);
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (pathname, method = 'GET') => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: pathname, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

test('preview serves every public asset with its MIME type and no caching', async t => {
  const request = await start(t);
  const assets = [
    ['/', 'site/index.html', 'text/html'],
    ['/index.html?preview=1', 'site/index.html', 'text/html'],
    ['/privacy.html', 'site/privacy.html', 'text/html'],
    ['/terms.html', 'site/terms.html', 'text/html'],
    ['/llms.txt', 'site/llms.txt', 'text/plain'],
    ['/robots.txt', 'site/robots.txt', 'text/plain'],
    ['/sitemap.xml', 'site/sitemap.xml', 'application/xml'],
    ['/styles.css', 'site/styles.css', 'text/css'],
    ['/arrival.js', 'site/arrival.js', 'text/javascript'],
    ['/browser-install.js', 'site/browser-install.js', 'text/javascript'],
    ['/analytics.js', 'site/analytics.js', 'text/javascript'],
    ['/favicon.svg', 'site/favicon.svg', 'image/svg+xml'],
    ['/LICENSE', 'LICENSE', 'text/plain']
  ];
  for (const [url, file, type] of assets) {
    const response = await request(url);
    const body = await readFile(path.join(root, file), 'utf8');
    assert.equal(response.status, 200, url);
    assert.equal(response.body, body, url);
    assert.ok(response.headers['content-type'].startsWith(type), url);
    assert.equal(response.headers['content-length'], String(Buffer.byteLength(body)));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  const head = await request('/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.ok(Number(head.headers['content-length']) > 0);
});

test('built preview delivers discoverable agent and crawler assets without exposing the checkout', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'createratio-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  buildSite(directory);
  const request = await start(t, directory, path.join(directory, 'LICENSE'));
  const homepage = (await request('/')).body;
  assert.match(homepage, /<link rel="alternate" type="text\/plain" href="llms.txt"/);
  assert.match(homepage, /<a href="llms.txt">/);
  const schema = JSON.parse(homepage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(schema['@context'], 'https://schema.org');
  assert.equal(schema['@type'], 'SoftwareApplication');
  assert.equal(new URL(schema.url).protocol, 'https:');
  for (const link of schema.downloadUrl) assert.ok(homepage.includes(`href="${link}"`));
  for (const [url, type] of [['/llms.txt', 'text/plain'], ['/robots.txt', 'text/plain'], ['/sitemap.xml', 'application/xml']]) {
    const response = await request(url);
    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].startsWith(type));
    assert.equal(response.body, await readFile(path.join(root, 'site', url.slice(1)), 'utf8'));
    const head = await request(url, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], response.headers['content-length']);
  }
  const robots = (await request('/robots.txt')).body;
  const sitemapURL = new URL(robots.match(/^Sitemap: (.+)$/m)[1]);
  const sitemap = await request(sitemapURL.pathname);
  assert.equal(sitemap.status, 200);
  for (const [, loc] of sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = new URL(loc);
    assert.equal(url.origin, schema.url.replace(/\/$/, ''));
    assert.equal((await request(url.pathname)).status, 200);
  }
  const guide = (await request('/llms.txt')).body;
  for (const [, href] of guide.matchAll(/\]\((https:\/\/[^)]+)\)/g)) {
    const url = new URL(href);
    if (url.origin === new URL(schema.url).origin) assert.equal((await request(url.pathname)).status, 200);
  }
  assert.equal((await request('/README.md')).status, 404);
});

test('preview rejects non-public files, traversal, and write methods', async t => {
  const request = await start(t);
  for (const url of ['/missing', '/.env', '/.git/config', '/README.md', '/tests/',
    '/dev-server.js', '/../LICENSE', '/%2e%2e/LICENSE', '/__proto__', '/constructor']) {
    assert.equal((await request(url)).status, 404, url);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await request('/', method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD');
  }
});

test('preview reads live edits and handles missing assets without crashing', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'createratio-preview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const request = await start(t, directory, path.join(directory, 'LICENSE'));
  assert.equal((await request('/')).status, 404);
  await writeFile(path.join(directory, 'index.html'), 'first');
  assert.equal((await request('/')).body, 'first');
  await writeFile(path.join(directory, 'index.html'), 'updated');
  assert.equal((await request('/')).body, 'updated');
  await writeFile(path.join(directory, 'LICENSE'), 'notice');
  assert.equal((await request('/LICENSE')).body, 'notice');
});

test('legal pages are discoverable and their local links and anchors resolve', async t => {
  const request = await start(t);
  const homepage = (await request('/')).body;
  const origin = 'https://createratio.com';
  for (const [page, other] of [['privacy', 'terms'], ['terms', 'privacy']]) {
    assert.ok(homepage.includes(`href="${page}.html"`), `homepage links to ${page}`);
    const html = (await request(`/${page}.html`)).body;
    assert.ok(html.includes(`href="${other}.html"`), `${page} links to ${other}`);
    for (const [, href] of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
      const url = new URL(href, `${origin}/${page}.html`);
      if (url.origin !== origin) continue;
      const target = await request(url.pathname + url.search);
      assert.equal(target.status, 200, `${page}: ${href}`);
      if (url.hash) {
        assert.ok(target.body.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
          `${page}: ${href} has a target`);
      }
    }
  }
  for (const page of ['popup', 'settings', 'blocked']) {
    const html = await readFile(path.join(root, 'extension/src/pages', page, `${page}.html`), 'utf8');
    assert.ok(html.includes(`href="${origin}/privacy.html"`), `${page} links to privacy`);
  }
  const settings = await readFile(path.join(root, 'extension/src/pages/settings/settings.html'), 'utf8');
  assert.match(settings, /href="https:\/\/createratio\.com\/terms\.html" target="_blank" rel="noopener noreferrer"/);
});
