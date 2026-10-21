'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function buildSite(output = path.resolve(__dirname, '../dist/site')) {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  function writeHashedScript(name, bytes) {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const filename = `${name}-${hash}.js`;
    fs.writeFileSync(path.join(output, filename), bytes);
    return `./${filename}`;
  }

  const trackerSource = require.resolve('@plausible-analytics/tracker');
  const tracker = writeHashedScript('plausible', fs.readFileSync(trackerSource));
  const analyticsSource = fs.readFileSync(path.join(__dirname, 'analytics.js'), 'utf8')
    .replace("'@plausible-analytics/tracker'", JSON.stringify(tracker));
  const analytics = writeHashedScript('analytics', analyticsSource);
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .replace('src="analytics.js"', `src="${analytics}"`);
  fs.writeFileSync(path.join(output, 'index.html'), html);
  for (const name of ['privacy.html', 'terms.html', 'llms.txt', 'robots.txt', 'sitemap.xml', 'styles.css', 'arrival.js', 'browser-install.js', 'favicon.svg']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
  }
  fs.copyFileSync(path.join(__dirname, '../LICENSE'), path.join(output, 'LICENSE'));
  fs.copyFileSync(path.join(path.dirname(trackerSource), 'LICENSE.md'),
    path.join(output, 'plausible-MIT.txt'));
}

if (require.main === module) buildSite();
module.exports = { buildSite };
