'use strict';
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const site = __dirname;
const assets = {
  '/': { filename: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { filename: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/privacy.html': { filename: 'privacy.html', contentType: 'text/html; charset=utf-8' },
  '/terms.html': { filename: 'terms.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { filename: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/arrival.js': { filename: 'arrival.js', contentType: 'text/javascript; charset=utf-8' },
  '/browser-install.js': { filename: 'browser-install.js', contentType: 'text/javascript; charset=utf-8' },
  '/analytics.js': { filename: 'analytics.js', contentType: 'text/javascript; charset=utf-8' },
  '/favicon.svg': { filename: 'favicon.svg', contentType: 'image/svg+xml' },
  '/LICENSE': { filename: 'LICENSE', contentType: 'text/plain; charset=utf-8' }
};

function createDevServer(directory = site, license = path.resolve(__dirname, '../LICENSE')) {
  return http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const pathname = request.url.split('?')[0];
    const asset = Object.hasOwn(assets, pathname) ? assets[pathname] : null;
    if (!asset) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const file = asset.filename === 'LICENSE' ? license : path.join(directory, asset.filename);
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end();
    }
  });
}

if (require.main === module) {
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : site;
  const license = process.argv[2] ? path.join(directory, 'LICENSE') : path.resolve(__dirname, '../LICENSE');
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.WEB_PORT || 4173);
  const server = createDevServer(directory, license);
  server.on('error', error => {
    console.error(`Preview failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Preview: http://${host}:${server.address().port}`);
  });
}

module.exports = { createDevServer };
