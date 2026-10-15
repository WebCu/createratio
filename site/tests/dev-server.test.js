'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { readFile, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createDevServer } = require('../dev-server.js');

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
    ['/styles.css', 'site/styles.css', 'text/css'],
    ['/arrival.js', 'site/arrival.js', 'text/javascript'],
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
