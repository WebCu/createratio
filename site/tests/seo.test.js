'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { buildSite } = require('../build.js');
const { createDevServer } = require('../dev-server.js');

const origin = 'https://createratio.com';

function attributes(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))].map(([element]) =>
    Object.fromEntries([...element.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])));
}

function metadata(html, key, value) {
  return attributes(html, 'meta').filter(meta => meta[key] === value).map(meta => meta.content);
}

function canonical(html) {
  const links = attributes(html, 'link').filter(link => link.rel === 'canonical');
  assert.equal(links.length, 1, 'exactly one canonical URL');
  return links[0].href;
}

function build(t) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-seo-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  buildSite(output);
  return output;
}

test('every published HTML page has unique metadata and an indexable production canonical', t => {
  const output = build(t);
  const titles = new Set();
  const descriptions = new Set();
  const canonicals = new Set();
  for (const filename of fs.readdirSync(output).filter(name => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(output, filename), 'utf8');
    const expected = `${origin}/${filename === 'index.html' ? '' : filename}`;
    assert.equal(canonical(html), expected, filename);
    const pageTitles = [...html.matchAll(/<title>([^<]+)<\/title>/g)].map(([, title]) => title.trim());
    assert.equal(pageTitles.length, 1, filename);
    assert.ok(pageTitles[0].length > 0, filename);
    assert.ok(!titles.has(pageTitles[0]), `unique title: ${filename}`);
    titles.add(pageTitles[0]);
    const pageDescriptions = metadata(html, 'name', 'description');
    assert.equal(pageDescriptions.length, 1, filename);
    assert.ok(pageDescriptions[0].trim().length > 0, filename);
    assert.ok(!descriptions.has(pageDescriptions[0]), `unique description: ${filename}`);
    descriptions.add(pageDescriptions[0]);
    assert.ok(!canonicals.has(expected), `unique canonical: ${filename}`);
    canonicals.add(expected);
    for (const meta of attributes(html, 'meta').filter(meta => /^(robots|googlebot|bingbot)$/i.test(meta.name))) {
      assert.doesNotMatch(meta.content || '', /\b(noindex|nofollow|none)\b/i, filename);
    }
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1, `one primary heading: ${filename}`);
    assert.match(html, /<html lang="en">/);
  }
});

test('homepage social metadata and site identity agree with its search metadata', t => {
  const output = build(t);
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  const title = html.match(/<title>([^<]+)<\/title>/)[1];
  const description = metadata(html, 'name', 'description')[0];
  assert.deepEqual(metadata(html, 'property', 'og:title'), [title]);
  assert.deepEqual(metadata(html, 'property', 'og:description'), [description]);
  assert.deepEqual(metadata(html, 'property', 'og:url'), [canonical(html)]);
  assert.deepEqual(metadata(html, 'property', 'og:type'), ['website']);
  assert.deepEqual(metadata(html, 'name', 'twitter:card'), ['summary']);
  assert.deepEqual(metadata(html, 'name', 'twitter:title'), [title]);
  assert.deepEqual(metadata(html, 'name', 'twitter:description'), [description]);
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'static structured data is available without JavaScript');
  const website = JSON.parse(scripts[0][1]);
  assert.equal(website['@context'], 'https://schema.org');
  assert.equal(website['@type'], 'WebSite');
  assert.equal(website.url, canonical(html));
  assert.deepEqual(metadata(html, 'property', 'og:site_name'), [website.name]);
  assert.ok(website.name.trim().length > 0);
});

test('source and built previews deliver crawl files covering exactly the published canonicals', async t => {
  const output = build(t);
  const expected = fs.readdirSync(output).filter(name => name.endsWith('.html'))
    .map(name => canonical(fs.readFileSync(path.join(output, name), 'utf8'))).sort();
  for (const directory of [path.resolve(__dirname, '..'), output]) {
    const server = createDevServer(directory);
    t.after(() => new Promise(resolve => server.close(resolve)));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const robots = await fetch(`${base}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain/);
    assert.equal(await robots.text(), `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
    const sitemap = await fetch(`${base}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type'), /^application\/xml/);
    const xml = await sitemap.text();
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">(?:\s*<url><loc>https:\/\/createratio\.com\/[^<]*<\/loc><\/url>)+\s*<\/urlset>\s*$/);
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url).sort();
    assert.deepEqual(urls, expected, 'every canonical is listed once, without aliases or stale pages');
    for (const url of urls) {
      const response = await fetch(`${base}${new URL(url).pathname}`);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.equal(canonical(await response.text()), url);
    }
    for (const route of ['/robots.txt', '/sitemap.xml']) {
      const head = await fetch(`${base}${route}`, { method: 'HEAD' });
      assert.equal(head.status, 200, route);
      assert.equal(await head.text(), '');
    }
  }
});
